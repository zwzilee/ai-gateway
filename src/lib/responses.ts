/**
 * OpenAI Responses 协议（`POST /v1/responses`）适配层。
 *
 * 上游有两种能力，本文件因此做两件事：
 *
 *   1. 原生路径：渠道声明支持 `/responses` 时，请求体原样转发、响应原样回传
 *      （端点覆盖在 upstream.ts）。本文件只负责读出用量、把 model 改回下游名。
 *   2. 翻译路径：渠道只支持 `/chat/completions` 时，把 Responses 请求降级成
 *      Chat Completions，再把整包响应 / SSE 流反向合成为 Responses 对象与事件。
 *      翻译只抹平「协议差异」，不改语义：tools、tool_choice、结构化输出、
 *      用量、finish_reason 都对齐；平台内建工具（web_search 等）在 chat 协议
 *      没有对应物，只能丢弃 —— 保留会让多数上游直接 400。
 *
 * 为什么不要求调用方自己改协议：下游 SDK 一选 Responses 就只认这套结构。
 * 网关能翻译，聚合才有价值，否则接在后面的 chat-only 上游全部变成
 * 「该模型不支持 Responses」。
 *
 * 计费仍走 Chat Completions 那条结算通路：两种 usage 结构都归一到 TokenUsage，
 * 下游看到的依旧是标准 Responses usage（input_tokens / output_tokens / 两个 details）。
 */

import { estimateTokens, extractUsage, newTally, tallyChars, tokensOfTally, type TokenUsage } from './billing.js';
import { badRequest } from './errors.js';

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** 生成 Responses 风格 id（resp_ / msg_ / fc_ / rs_ / call_），22 位 base64url */
export function responsesId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${prefix}_${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** 输出文本的 token 估算（CJK 1 token，其余 4 字符 1 token；不外推，短回答全量数） */
function estimateOut(text: string): number {
  if (text === '') return 0;
  return tokensOfTally(tallyChars(text, newTally()));
}

function estimatedUsage(request: Json, outText: string): TokenUsage {
  const prompt = estimateTokens(stringify(request));
  const completion = estimateOut(outText);
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cachedTokens: 0, estimated: true };
}

// ================================================================ 请求：Responses → Chat

function convertTools(tools: unknown): Json[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Json[] = [];
  for (const tool of tools) {
    if (!isObject(tool) || str(tool.type) !== 'function') continue;
    const name = str(tool.name);
    if (name === '') continue;
    const fn: Json = { name, parameters: isObject(tool.parameters) ? tool.parameters : { type: 'object', properties: {} } };
    if (typeof tool.description === 'string' && tool.description !== '') fn.description = tool.description;
    if (tool.strict === true) fn.strict = true;
    out.push({ type: 'function', function: fn });
  }
  return out.length > 0 ? out : undefined;
}

function convertToolChoice(choice: unknown): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (isObject(choice) && str(choice.type) === 'function' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

function convertResponseFormat(text: unknown): unknown {
  if (!isObject(text) || !isObject(text.format)) return undefined;
  const format = text.format;
  const type = str(format.type);
  if (type === 'json_object') return { type: 'json_object' };
  if (type === 'json_schema') {
    const inner: Json = { name: str(format.name) || 'output', schema: format.schema ?? {} };
    if (typeof format.description === 'string' && format.description !== '') inner.description = format.description;
    if (format.strict === true) inner.strict = true;
    return { type: 'json_schema', json_schema: inner };
  }
  return undefined;
}

/** input 内容块 → chat content：纯文本压成字符串，含图片才保留数组 */
function convertContent(content: unknown): { text: string; parts: Json[] } {
  if (typeof content === 'string') return { text: content, parts: [{ type: 'text', text: content }] };
  const parts: Json[] = [];
  let text = '';
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isObject(part)) continue;
      const type = str(part.type);
      if (type === 'input_text' || type === 'output_text' || type === 'text') {
        const t = str(part.text);
        text += t;
        parts.push({ type: 'text', text: t });
      } else if (type === 'input_image') {
        const url = str(part.image_url) || str(part.file_id);
        if (url === '') continue;
        const detail = str(part.detail);
        const image: Json = { url };
        if (detail === 'low' || detail === 'high' || detail === 'auto') image.detail = detail;
        parts.push({ type: 'image_url', image_url: image });
      }
      // input_file / input_audio 在 chat 协议里没有通用结构，跳过
    }
  }
  return { text, parts };
}

function toolOutputMessage(item: Json): Json | null {
  const callId = str(item.call_id);
  if (callId === '') return null;
  let output: string;
  if (typeof item.output === 'string') output = item.output;
  else if (Array.isArray(item.output)) {
    let text = '';
    for (const part of item.output) if (isObject(part) && typeof part.text === 'string') text += part.text;
    output = text;
  } else output = item.output == null ? '' : stringify(item.output);
  return { role: 'tool', tool_call_id: callId, content: output };
}

/**
 * Responses 请求 → Chat Completions 请求。
 *
 *   instructions          → 第一条 system 消息
 *   input: string         → 一条 user 消息
 *   input: message[]      → role 直接对应（developer 并成 system）
 *   function_call / output→ assistant.tool_calls 与 role:'tool'
 *   reasoning 项          → 丢弃（模型自产的推理不能回灌给多数上游）
 *   max_output_tokens     → max_tokens；text.format → response_format
 */
export function buildChatRequest(body: Json, upstreamModel: string, stream: boolean): Json {
  const messages: Json[] = [];

  const instructions = body.instructions;
  if (typeof instructions === 'string') {
    if (instructions.trim() !== '') messages.push({ role: 'system', content: instructions });
  } else if (Array.isArray(instructions)) {
    const parts: Json[] = [];
    for (const part of instructions) if (isObject(part) && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
    if (parts.length > 0) messages.push({ role: 'system', content: parts });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    // 同一轮里的多个 function_call 必须并进同一条 assistant 消息的 tool_calls
    let pendingCalls: Json[] | null = null;
    const flush = (): void => {
      if (pendingCalls) {
        messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
        pendingCalls = null;
      }
    };

    for (const raw of input) {
      if (typeof raw === 'string') {
        flush();
        messages.push({ role: 'user', content: raw });
        continue;
      }
      if (!isObject(raw)) continue;
      const type = str(raw.type) || (typeof raw.role === 'string' ? 'message' : '');

      if (type === 'function_call_output') {
        flush();
        const msg = toolOutputMessage(raw);
        if (msg) messages.push(msg);
        continue;
      }
      if (type === 'function_call') {
        const call: Json = {
          id: str(raw.call_id) || str(raw.id) || responsesId('call'),
          type: 'function',
          function: { name: str(raw.name), arguments: typeof raw.arguments === 'string' ? raw.arguments : stringify(raw.arguments ?? {}) },
        };
        if (pendingCalls) pendingCalls.push(call);
        else pendingCalls = [call];
        continue;
      }
      if (type !== 'message') continue;

      flush();
      const rawRole = str(raw.role) || 'user';
      const role = rawRole === 'developer' ? 'system' : rawRole;
      const { text, parts } = convertContent(raw.content);
      messages.push({ role, content: parts.some((p) => p.type === 'image_url') ? parts : text });
    }
    flush();
  }

  // 空 input 在 Responses 里合法，但绝大多数 chat 上游会因空 messages 返回 400。
  // 补一条空 user 消息，语义上最接近「无输入」且结构合法。
  if (messages.length === 0) messages.push({ role: 'user', content: '' });

  const chat: Json = { model: upstreamModel, messages };

  const maxTokens = num(body.max_output_tokens) ?? num(body.max_tokens) ?? num(body.max_completion_tokens);
  if (maxTokens !== undefined) chat.max_tokens = maxTokens;
  if (num(body.temperature) !== undefined) chat.temperature = body.temperature;
  if (num(body.top_p) !== undefined) chat.top_p = body.top_p;
  if (typeof body.user === 'string' && body.user !== '') chat.user = body.user;

  const tools = convertTools(body.tools);
  if (tools) chat.tools = tools;
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  const responseFormat = convertResponseFormat(body.text);
  if (responseFormat !== undefined) chat.response_format = responseFormat;
  if (body.parallel_tool_calls === false && tools) chat.parallel_tool_calls = false;

  if (stream) chat.stream = true;
  return chat;
}

// ================================================================ 响应骨架

export function toResponseUsage(usage: TokenUsage | null): Json | null {
  if (!usage) return null;
  return {
    input_tokens: usage.promptTokens,
    input_tokens_details: { cached_tokens: usage.cachedTokens, cache_write_tokens: 0 },
    output_tokens: usage.completionTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.totalTokens !== 0 ? usage.totalTokens : usage.promptTokens + usage.completionTokens,
  };
}

/** 原生 `/responses` 响应的 usage → TokenUsage（字段兼容交给 extractUsage） */
export function extractResponsesUsage(usage: unknown): TokenUsage | null {
  if (!isObject(usage)) return null;
  return extractUsage({
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    input_tokens_details: usage.input_tokens_details,
  });
}

function responseSkeleton(id: string, model: string, createdAt: number, request: Json, status: string): Json {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: num(request.max_output_tokens) ?? null,
    model,
    output: [],
    parallel_tool_calls: request.parallel_tool_calls !== false,
    previous_response_id: typeof request.previous_response_id === 'string' ? request.previous_response_id : null,
    reasoning: isObject(request.reasoning) ? request.reasoning : { effort: null, summary: null },
    store: request.store === true,
    temperature: num(request.temperature) ?? null,
    text: isObject(request.text) ? request.text : { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: num(request.top_p) ?? null,
    truncation: typeof request.truncation === 'string' ? request.truncation : 'disabled',
    usage: null,
    metadata: isObject(request.metadata) ? request.metadata : {},
  };
}

function outputMessageItem(id: string, text: string, refusal: string): Json {
  const content: Json[] = [];
  if (text !== '') content.push({ type: 'output_text', text, annotations: [], logprobs: [] });
  if (refusal !== '') content.push({ type: 'refusal', refusal });
  if (content.length === 0) content.push({ type: 'output_text', text: '', annotations: [], logprobs: [] });
  return { type: 'message', id, role: 'assistant', status: 'completed', content };
}

function functionCallItem(id: string, call: ChatToolCall): Json {
  return { type: 'function_call', id, call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' };
}

// ================================================================ 非流式：Chat → Responses

interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ChatTurn {
  text: string;
  reasoning: string;
  refusal: string;
  calls: ChatToolCall[];
}

function readChatTurn(message: unknown): ChatTurn {
  const turn: ChatTurn = { text: '', reasoning: '', refusal: '', calls: [] };
  if (!isObject(message)) return turn;
  if (typeof message.content === 'string') turn.text = message.content;
  else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isObject(part)) continue;
      if (typeof part.text === 'string') turn.text += part.text;
      if (typeof part.refusal === 'string') turn.refusal += part.refusal;
    }
  }
  if (typeof message.reasoning_content === 'string') turn.reasoning = message.reasoning_content;
  else if (typeof message.reasoning === 'string') turn.reasoning = message.reasoning;
  if (typeof message.refusal === 'string') turn.refusal += message.refusal;
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isObject(raw)) continue;
      const fn = isObject(raw.function) ? raw.function : {};
      turn.calls.push({
        id: str(raw.id) || responsesId('call'),
        name: str(fn.name),
        arguments: typeof fn.arguments === 'string' ? fn.arguments : stringify(fn.arguments ?? {}),
      });
    }
  }
  return turn;
}

export function chatToResponse(chat: Json, request: Json, model: string, responseId: string): Json {
  const response = responseSkeleton(responseId, model, Math.floor(Date.now() / 1000), request, 'completed');
  const output: Json[] = [];
  const choice = Array.isArray(chat.choices) ? chat.choices[0] : undefined;
  const turn = readChatTurn(isObject(choice) ? choice.message : undefined);

  if (turn.reasoning !== '') {
    output.push({
      type: 'reasoning',
      id: responsesId('rs'),
      status: 'completed',
      summary: [{ type: 'summary_text', text: turn.reasoning }],
    });
  }
  if (turn.text !== '' || turn.refusal !== '' || turn.calls.length === 0) {
    output.push(outputMessageItem(responsesId('msg'), turn.text, turn.refusal));
  }
  for (const call of turn.calls) output.push(functionCallItem(responsesId('fc'), call));

  response.output = output;
  response.usage = toResponseUsage(extractUsage(chat.usage) ?? estimatedUsage(request, turn.text + turn.reasoning));
  if (isObject(choice) && str(choice.finish_reason) === 'length') {
    response.status = 'incomplete';
    response.incomplete_details = { reason: 'max_output_tokens' };
  }
  return response;
}

// ================================================================ 流式：Chat SSE → Responses SSE

export interface ResponsesStreamOptions {
  request: Json;
  model: string;
  responseId: string;
  /** 下游要事件流还是整包 JSON（翻译层两种都支持） */
  stream: boolean;
  /** 上游 SSE 空闲上限，沿用渠道 timeout_ms 的「数据间隔」语义 */
  idleMs: number;
  signal?: AbortSignal;
}

export interface ResponsesStreamResult {
  response: Response;
  usage: Promise<{ usage: TokenUsage; error: string | null }>;
  /**
   * 折叠后的完整 Response 对象。
   *
   * 非流式下游直接用它给出 JSON；流式下游在流结束后 resolve（拿不到时为 null），
   * 供 store / previous_response_id 留档。流式也保留：客户端可能开着 stream 却
   * 想把这次结果连下去。
   */
  payload: Promise<Json | null>;
}

interface CallState {
  itemId: string;
  callId: string;
  name: string;
  args: string;
  index: number;
  added: boolean;
}

/**
 * 单一状态机：吃 chat SSE 分片，吐出 Responses 事件。
 *
 * 事件顺序照官方：
 *   response.created → response.in_progress →
 *   (output_item.added → content_part.added → output_text.delta* →
 *    output_text.done → content_part.done → output_item.done)* →
 *   (function_call_arguments.delta* → .done → output_item.done)* →
 *   response.completed | response.incomplete | response.failed
 *
 * 流式下游直接转发事件；非流式下游把同一批事件折叠成一个完整 Response 对象。
 */
export function chatStreamToResponses(upstream: Response, opts: ResponsesStreamOptions): ResponsesStreamResult {
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  let settled = false;
  let resolveUsage!: (v: { usage: TokenUsage; error: string | null }) => void;
  const usage = new Promise<{ usage: TokenUsage; error: string | null }>((resolve) => {
    resolveUsage = resolve;
  });

  let resolvePayload!: (v: Json | null) => void;
  const payload = new Promise<Json | null>((resolve) => {
    resolvePayload = resolve;
  });

  const encoder = new TextEncoder();
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const ac = new AbortController();

  const msg = { itemId: responsesId('msg'), index: -1, open: false, text: '' };
  const calls = new Map<number, CallState>();
  const usedSlots = new Set<number>();
  let nextSlot = 0;
  let finalUsage: TokenUsage | null = null;
  let finishReason: string | null = null;
  let streamError: string | null = null;

  const takeSlot = (): number => {
    while (usedSlots.has(nextSlot)) nextSlot++;
    usedSlots.add(nextSlot);
    return nextSlot;
  };

  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const send = (event: Json): void => {
    if (sink == null) return;
    const frame = { type: event.type, ...event, sequence_number: sequence++ };
    sink.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(frame)}\n\n`));
  };

  const itemDone = (item: Json, index: number): void =>
    send({ type: 'response.output_item.done', output_index: index, item });

  const openMessage = (): void => {
    if (msg.open) return;
    msg.open = true;
    msg.index = takeSlot();
    send({
      type: 'response.output_item.added',
      output_index: msg.index,
      item: { type: 'message', id: msg.itemId, role: 'assistant', status: 'in_progress', content: [] },
    });
    send({
      type: 'response.content_part.added',
      item_id: msg.itemId,
      output_index: msg.index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    });
  };

  const closeMessage = (): void => {
    if (!msg.open) return;
    msg.open = false;
    const part = { type: 'output_text', text: msg.text, annotations: [], logprobs: [] };
    send({ type: 'response.output_text.done', item_id: msg.itemId, output_index: msg.index, content_index: 0, text: msg.text, logprobs: [] });
    send({ type: 'response.content_part.done', item_id: msg.itemId, output_index: msg.index, content_index: 0, part });
    itemDone({ type: 'message', id: msg.itemId, role: 'assistant', status: 'completed', content: [part] }, msg.index);
  };

  const openCall = (index: number, delta: Json): CallState => {
    const existing = calls.get(index);
    if (existing) return existing;
    const call: CallState = {
      itemId: responsesId('fc'),
      callId: str(delta.id) || responsesId('call'),
      name: '',
      args: '',
      index: takeSlot(),
      added: true,
    };
    calls.set(index, call);
    send({
      type: 'response.output_item.added',
      output_index: call.index,
      item: { type: 'function_call', id: call.itemId, call_id: call.callId, name: '', arguments: '', status: 'in_progress' },
    });
    return call;
  };

  const readChunk = (chunk: Json): void => {
    if (isObject(chunk.error)) {
      streamError = str(chunk.error.message) || '上游在流中返回错误';
      return;
    }

    const choices = chunk.choices;
    const choice = Array.isArray(choices) && choices.length > 0 && isObject(choices[0]) ? choices[0] : null;
    if (choice) {
      const delta = isObject(choice.delta) ? choice.delta : {};
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (reasoning !== '') {
        send({
          type: 'response.reasoning_summary_text.delta',
          item_id: responsesId('rs'),
          output_index: 0,
          summary_index: 0,
          delta: reasoning,
        });
      }
      const content = typeof delta.content === 'string' ? delta.content : '';
      if (content !== '') {
        openMessage();
        msg.text += content;
        send({
          type: 'response.output_text.delta',
          item_id: msg.itemId,
          output_index: msg.index,
          content_index: 0,
          delta: content,
          logprobs: [],
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          if (!isObject(raw)) continue;
          // chat 协议里工具调用总在文本之后：先收尾消息，才让工具项占位
          closeMessage();
          const call = openCall(num(raw.index) ?? 0, raw);
          const fn = isObject(raw.function) ? raw.function : {};
          if (typeof fn.name === 'string') call.name += fn.name;
          const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
          if (argsDelta !== '') {
            call.args += argsDelta;
            send({
              type: 'response.function_call_arguments.delta',
              item_id: call.itemId,
              output_index: call.index,
              delta: argsDelta,
            });
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finishReason = choice.finish_reason;
    }

    const chunkUsage = extractUsage(chunk.usage);
    if (chunkUsage) finalUsage = chunkUsage;
  };

  const buildResponse = (): Json => {
    const failed = streamError !== null;
    const incomplete = finishReason === 'length';
    const status = failed ? 'failed' : incomplete ? 'incomplete' : 'completed';
    const response = responseSkeleton(opts.responseId, opts.model, createdAt, opts.request, status);
    const output: Json[] = [];
    if (msg.text !== '' || calls.size === 0) output.push(outputMessageItem(msg.itemId, msg.text, ''));
    for (const call of [...calls.values()].sort((a, b) => a.index - b.index)) {
      output.push({ type: 'function_call', id: call.itemId, call_id: call.callId, name: call.name, arguments: call.args, status: 'completed' });
    }
    response.output = output;
    response.usage = toResponseUsage(finalUsage ?? estimatedUsage(opts.request, msg.text));
    if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };
    if (failed) response.error = { code: 'upstream_error', message: streamError };
    return response;
  };

  const settle = (error: string | null): void => {
    if (settled) return;
    settled = true;
    clearIdle();
    resolveUsage({ usage: finalUsage ?? estimatedUsage(opts.request, msg.text), error: error ?? streamError });
    resolvePayload(error == null ? buildResponse() : null);
  };

  /** 正常收尾：关掉开着的项，发终态事件 */
  const finish = (): void => {
    closeMessage();
    for (const call of [...calls.values()].sort((a, b) => a.index - b.index)) {
      send({ type: 'response.function_call_arguments.done', item_id: call.itemId, output_index: call.index, name: call.name, arguments: call.args });
      itemDone(
        { type: 'function_call', id: call.itemId, call_id: call.callId, name: call.name, arguments: call.args, status: 'completed' },
        call.index,
      );
    }
    const response = buildResponse();
    const status = str(response.status);
    send({
      type: status === 'failed' ? 'response.failed' : status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response,
    });
    settle(null);
    try {
      sink?.close();
    } catch {
      /* 已关闭 */
    }
  };

  /** 故障收尾：先给 error 事件，再给 response.failed */
  const abortWith = (reason: string): void => {
    if (settled) return;
    streamError = reason;
    send({ type: 'error', code: 'upstream_error', message: reason, param: null });
    closeMessage();
    send({ type: 'response.failed', response: buildResponse() });
    settle(reason);
    try {
      sink?.close();
    } catch {
      /* 已关闭 */
    }
  };

  const body = upstream.body;
  if (!body) {
    settle('上游返回了空响应体');
    const empty = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    return { response: new Response(empty, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }), usage, payload };
  }
  // 非流式下游 + 上游回的是整包 JSON（chat.completion）：上游没有 SSE 可解，
  // 直接按整包转换。少了这一支，下游要非流式时会拿到空 output、用量全靠估算。
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!opts.stream && !contentType.includes('event-stream')) {
    const pending = (async (): Promise<Json> => {
      let chat: Json = {};
      try {
        chat = JSON.parse(await upstream.text()) as Json;
      } catch {
        chat = {};
      }
      const responseObject = chatToResponse(chat, opts.request, opts.model, opts.responseId);
      const used = extractUsage(isObject(chat.usage) ? chat.usage : null) ?? estimatedUsage(opts.request, '');
      resolveUsage({ usage: used, error: null });
      resolvePayload(responseObject);
      return responseObject;
    })();
    const plain = new Response(
      new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            c.enqueue(encoder.encode(JSON.stringify(await pending)));
            c.close();
          } catch (err) {
            c.error(err);
          }
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
    return { response: plain, usage, payload };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** 读一批上游数据；返回 false 表示上游结束 */
  const pump = async (): Promise<boolean> => {
    const { done: eof, value } = await reader.read();
    if (eof) return false;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      try {
        readChunk(JSON.parse(payload) as Json);
      } catch {
        /* 非 JSON 行（注释、心跳）直接跳过 */
      }
    }
    return true;
  };

  if (!opts.stream) {
    // 下游要整包：读完上游 SSE，折叠成一个 Response 对象
    const aggregate = async (): Promise<Json> => {
      for (;;) {
        if (!(await pump())) break;
      }
      return buildResponse();
    };
    const pending = aggregate().finally(() => settle(null));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            c.enqueue(encoder.encode(JSON.stringify(await pending)));
            c.close();
          } catch (err) {
            c.error(err);
          }
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
    return { response, usage, payload };
  }

  const streamBody = new ReadableStream<Uint8Array>({
    start(c) {
      sink = c;
      const created = responseSkeleton(opts.responseId, opts.model, createdAt, opts.request, 'in_progress');
      send({ type: 'response.created', response: created });
      send({ type: 'response.in_progress', response: created });
    },
    async pull(c) {
      for (;;) {
        if (settled) return;
        clearIdle();
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          abortWith(`上游 ${opts.idleMs}ms 无数据，网关已中断本次流式响应`);
          void reader.cancel().catch(() => undefined);
        }, opts.idleMs);
        let more: boolean;
        try {
          more = await pump();
        } catch (err) {
          clearIdle();
          abortWith(`上游流式响应中断: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        clearIdle();
        if (settled) return;
        if (!more) {
          finish();
          return;
        }
        // 有数据就交还控制权，让 sink 把已 enqueue 的帧冲刷出去
        if (sequence > 0) {
          void c;
          return;
        }
      }
    },
    cancel(reason) {
      clearIdle();
      ac.abort();
      settle(`客户端提前断开: ${reason instanceof Error ? reason.message : String(reason ?? '')}`);
      void reader.cancel(reason).catch(() => undefined);
    },
  });

  const headers = new Headers({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return { response: new Response(streamBody, { status: 200, headers }), usage, payload };
}

// ================================================================ Responses → Chat（反向降级）

/**
 * 原生 Responses 响应（整包）→ Chat Completions 响应。
 *
 * 用来满足「下游用 chat 协议，但同一模型只挂在只吃 /responses 的上游」。方向与
 * chatToResponse 相反，信息按协议能表达的尽量保留：reasoning → reasoning_content、
 * refusal → content 文本、function_call → tool_calls、incomplete → finish_reason=length。
 * 拿不到 usage 时保留 null，由结算层按估算兜底（与原生透传一致）。
 */
export function responsesToChat(response: Json, model: string): Json {
  const output = Array.isArray(response.output) ? response.output : [];
  let text = '';
  let reasoning = '';
  const toolCalls: Json[] = [];

  for (const raw of output) {
    if (!isObject(raw)) continue;
    const type = str(raw.type);
    if (type === 'reasoning') {
      const summary = Array.isArray(raw.summary) ? raw.summary : [];
      for (const part of summary) if (isObject(part) && typeof part.text === 'string') reasoning += part.text;
      continue;
    }
    if (type === 'message') {
      const content = Array.isArray(raw.content) ? raw.content : [];
      for (const part of content) {
        if (!isObject(part)) continue;
        if (str(part.type) === 'refusal') text += str(part.refusal);
        else text += str(part.text);
      }
      continue;
    }
    if (type === 'function_call') {
      toolCalls.push({
        id: str(raw.call_id) || str(raw.id) || responsesId('call'),
        type: 'function',
        function: {
          name: str(raw.name),
          arguments:
            typeof raw.arguments === 'string' ? raw.arguments : stringify(raw.arguments ?? {}),
        },
      });
    }
  }

  const message: Json = { role: 'assistant', content: toolCalls.length > 0 && text === '' ? null : text };
  if (reasoning !== '') message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const status = str(response.status);
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : status === 'incomplete' ? 'length' : 'stop';
  const usage = isObject(response.usage)
    ? {
        prompt_tokens: num(response.usage.input_tokens) ?? 0,
        completion_tokens: num(response.usage.output_tokens) ?? 0,
        total_tokens:
          num(response.usage.total_tokens) ??
          (num(response.usage.input_tokens) ?? 0) + (num(response.usage.output_tokens) ?? 0),
      }
    : null;

  return {
    id: str(response.id).startsWith('chatcmpl') ? str(response.id) : `chatcmpl-${str(response.id) || responsesId('chat')}`,
    object: 'chat.completion',
    created: num(response.created_at) ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage,
  };
}

/** SSE 帧 → 事件对象；不是 data 行就返回 null */
function readSseFrame(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data === '' || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data) as Json;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 原生 Responses 流 → Chat Completions 流（SSE）。
 *
 * 事件都是「增量」的：output_text.delta → content、reasoning_summary_text.delta /
 * reasoning_text.delta → reasoning_content、function_call_arguments.delta → tool_calls
 * 的 arguments 分片。收尾时把 terminal 事件里的 response 对象补成最后一条 useage 帧
 * 与 [DONE]。
 *
 * 与 chatStreamToResponses 一样按单一状态机写，非流式下游也用它：读完折叠成一包。
 */
export interface ResponsesToChatOptions {
  model: string;
  /** 下游要 SSE 还是整包 JSON */
  stream: boolean;
  /** 上游 SSE 空闲上限，沿用渠道 timeout_ms 的「数据间隔」语义 */
  idleMs: number;
  signal?: AbortSignal;
}

/**
 * Chat Completions 请求 → Responses 请求（反向降级：下游 chat、上游只有 /responses）。
 *
 * 只搬协议能一一对应的字段：messages 里的 assistant tool_calls → function_call 项、
 * tool 消息 → function_call_output 项、system/developer → instructions、max_tokens →
 * max_output_tokens、stop → 不传（Responses 没有等价的通用停止序列）、tools 走同一套
 * function 结构。多模态图片沿用 Responses 的 input_image 结构。
 */
export function chatToResponsesRequest(body: Json, upstreamModel: string): Json {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts: string[] = [];
  const input: Json[] = [];

  for (const raw of messages) {
    if (!isObject(raw)) continue;
    const role = str(raw.role) || 'user';
    if (role === 'system' || role === 'developer') {
      const text = contentToText(raw.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (role === 'tool') {
      const output = contentToText(raw.content);
      input.push({
        type: 'function_call_output',
        call_id: str(raw.tool_call_id) || responsesId('call'),
        output,
      });
      continue;
    }
    if (role === 'assistant') {
      const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      const text = contentToText(raw.content);
      if (text !== '' || toolCalls.length === 0) {
        input.push({ type: 'message', role: 'assistant', content: responseContent(raw.content) });
      }
      for (const call of toolCalls) {
        if (!isObject(call)) continue;
        const fn = isObject(call.function) ? call.function : {};
        input.push({
          type: 'function_call',
          call_id: str(call.id) || responsesId('call'),
          name: str(fn.name),
          arguments: typeof fn.arguments === 'string' ? fn.arguments : stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }
    input.push({ type: 'message', role, content: responseContent(raw.content) });
  }

  const out: Json = { model: upstreamModel, input };
  if (systemParts.length > 0) out.instructions = systemParts.join('\n\n');

  const maxTokens = num(body.max_tokens) ?? num(body.max_completion_tokens);
  if (maxTokens !== undefined && maxTokens > 0) out.max_output_tokens = maxTokens;
  const temperature = num(body.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = num(body.top_p);
  if (topP !== undefined) out.top_p = topP;
  if (typeof body.user === 'string' && body.user !== '') out.user = body.user;

  const tools = body.tools;
  if (Array.isArray(tools)) {
    const converted = tools
      .filter((t): t is Json => isObject(t) && str(t.type) === 'function')
      .map((t) => {
        const fn = isObject(t.function) ? t.function : {};
        const tool: Json = { type: 'function', name: str(fn.name) };
        if (str(fn.description) !== '') tool.description = str(fn.description);
        if (isObject(fn.parameters)) tool.parameters = fn.parameters;
        return tool;
      });
    if (converted.length > 0) {
      out.tools = converted;
      const choice = body.tool_choice;
      if (typeof choice === 'string') out.tool_choice = choice;
      else if (isObject(choice) && isObject(choice.function)) {
        out.tool_choice = { type: 'function', name: str(choice.function.name) };
      }
    }
  }
  if (body.parallel_tool_calls === false && Array.isArray(out.tools)) {
    out.parallel_tool_calls = false;
  }

  const format = isObject(body.response_format) ? body.response_format : null;
  if (format) {
    const type = str(format.type);
    if (type === 'json_object') out.text = { format: { type: 'json_object' } };
    else if (type === 'json_schema' && isObject(format.json_schema)) {
      out.text = { format: { type: 'json_schema', ...format.json_schema } };
    }
  }

  return out;
}

/** chat 的 content（字符串或分块数组）→ 纯文本 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (isObject(part) && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/** chat 的 content → Responses 的 input 内容（纯文本压成字符串，含图片才保留数组） */
function responseContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return contentToText(content);
  const out: Json[] = [];
  let onlyText = true;
  for (const part of content) {
    if (typeof part === 'string') {
      out.push({ type: 'input_text', text: part });
      continue;
    }
    if (!isObject(part)) continue;
    if (str(part.type) === 'text') out.push({ type: 'input_text', text: str(part.text) });
    else if (str(part.type) === 'image_url') {
      onlyText = false;
      const image = isObject(part.image_url) ? part.image_url : {};
      out.push({ type: 'input_image', image_url: str(image.url) });
    } else out.push(part);
  }
  if (out.length === 0) return '';
  return onlyText ? contentToText(content) : out;
}

/** responsesStreamToChat 的产出：响应本身 + 异步结算的用量 */
export interface ResponsesToChatResult {
  response: Response;
  usage: Promise<{ usage: TokenUsage | null; error: string | null }>;
}

/** 一个正在累积的 Chat delta */
interface ChatDelta {
  content?: string;
  reasoning?: string;
  tool?: { index: number; id: string; name: string; args: string };
  error?: string;
  /** 事件流里明确报错 = 上游已经把这次生成结束掉了，不必再等收尾事件 */
  isError?: boolean;
  /** terminal 事件里的整包 response（取 status/usage/error） */
  final?: Json;
}

/**
 * 原生 Responses 流 → 逐条 Chat delta。
 *
 * 用 async generator 读：流式时边读边发（下游不必等整包），非流式时读完再折叠。
 * 生成器结束时必定调用一次 onEnd —— 正常收尾传 null，异常/看门狗/客户端断开传原因。
 *
 * 两种上游都吃：真 SSE（含 event: 行）与整包 JSON（某些代理层会把流压成 JSON）。
 */
async function* responsesReader(
  upstream: Response,
  opts: { idleMs: number; signal?: AbortSignal },
  onEnd: (error: string | null) => void,
): AsyncGenerator<ChatDelta, void, undefined> {
  let finished = false;
  const done = (error: string | null): void => {
    if (finished) return;
    finished = true;
    onEnd(error);
  };

  const body = upstream.body;
  if (!body) {
    done('上游返回了空响应体');
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let buffer = '';
  let whole = '';
  let sawSse = false;

  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      idleTimer = setTimeout(onAbort, opts.idleMs);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        done(`上游流式响应中断: ${err instanceof Error ? err.message : String(err)}`);
        return;
      } finally {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      }
      if (chunk.done) break;
      const piece = decoder.decode(chunk.value, { stream: true });
      whole += piece;
      buffer += piece.replace(/\r\n/g, '\n');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        sawSse = true;
        const event = readSseFrame(line);
        if (!event) continue;
        for (const d of mapResponseEvent(event)) {
          yield d;
          if (d.isError) {
            done(null);
            return;
          }
        }
      }
    }

    // 整包 JSON（没有 SSE 行）：按 response 对象处理
    if (!sawSse && whole.trim().startsWith('{')) {
      let parsed: Json = {};
      try {
        parsed = JSON.parse(whole.trim()) as Json;
      } catch {
        parsed = {};
      }
      /*
       * 整包也要先拆成增量（文本/思考/工具），不能只 yield 一个 final ——
       * 那样下游只会收到一个空的 finish_reason 帧，正文全丢。
       */
      for (const d of wholeResponse(parsed)) {
        yield d;
        if (d.isError) {
          done(null);
          return;
        }
      }
      done(null);
      return;
    }
    if (buffer.startsWith('data:')) {
      const event = readSseFrame(buffer);
      if (event) for (const d of mapResponseEvent(event)) yield d;
    }
    done(null);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    void reader.cancel().catch(() => undefined);
  }
}

/** Responses 的 message.content（output_text / refusal 块）→ 纯文本 */
function outputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (!isObject(part)) continue;
    const kind = str(part.type);
    if (kind === 'output_text' || kind === 'text' || kind === 'refusal') text += str(part.text);
  }
  return text;
}

/**
 * 整包 Response 对象 → 一串增量（文本 / 思考 / 工具 + 收尾）。
 *
 * 非流式降级时上游会直接回一个完整的 Response；此时没有 delta 可转发，
 * 但下游可能开着 stream，所以仍然拆成增量喂给同一个吸收器。
 */
function wholeResponse(response: Json): ChatDelta[] {
  const out: ChatDelta[] = [];
  let index = 0;
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!isObject(item)) continue;
    const kind = str(item.type);
    if (kind === 'reasoning') {
      const text = (Array.isArray(item.summary) ? item.summary : [])
        .map((part) => (isObject(part) ? str(part.text) : ''))
        .join('');
      if (text !== '') out.push({ reasoning: text });
    } else if (kind === 'message') {
      const text = outputText(item.content);
      if (text !== '') out.push({ content: text });
    } else if (kind === 'function_call') {
      out.push({
        tool: {
          index: index++,
          id: str(item.call_id) || str(item.id),
          name: str(item.name),
          args: typeof item.arguments === 'string' ? item.arguments : stringify(item.arguments ?? {}),
        },
      });
    }
  }
  out.push({ final: response });
  return out;
}

export function mapResponseEvent(event: Json): ChatDelta[] {
  const type = str(event.type);
  /*
   * 两种现实存在的形状：正版平铺（{type, delta, output_index…}），以及被某些
   * 中间层包了一层的 {response: {...}}（连 type 都没有，只能从 response.status 认结尾）。
   * 不认第二种，非 OpenAI 上游的整包结尾会全部丢掉、用量退回估算。
   */
  if (type === '' && isObject(event.response)) {
    const response = event.response;
    const status = str(response.status);
    if (status === 'completed' || status === 'incomplete' || status === 'failed') {
      return [{ final: response }];
    }
    return [];
  }
  if (type === '' && isObject(event.object) && str(event.object) === 'response') {
    return wholeResponse(event);
  }
  /*
   * 整包 Response 对象（非流式、或被中间层压成一条 JSON）。没有 type、也可能没有
   * object 字段 —— 这时只能靠「有 output 数组或 status 字段」来认。
   */
  if (type === '' && (Array.isArray(event.output) || str(event.status) !== '')) {
    return wholeResponse(event);
  }
  if (type === 'response.output_text.delta') {
    const piece = str(event.delta);
    return piece === '' ? [] : [{ content: piece }];
  }
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    const piece = str(event.delta);
    return piece === '' ? [] : [{ reasoning: piece }];
  }
  if (type === 'response.output_item.added' && isObject(event.item)) {
    const item = event.item;
    if (str(item.type) === 'function_call') {
      const index = num(event.output_index) ?? 0;
      return [
        {
          tool: {
            index,
            id: str(item.call_id) || str(item.id),
            name: str(item.name),
            args: typeof item.arguments === 'string' ? item.arguments : '',
          },
        },
      ];
    }
    return [];
  }
  if (type === 'response.function_call_arguments.delta') {
    const piece = str(event.delta);
    if (piece === '') return [];
    const index = num(event.output_index) ?? 0;
    return [{ tool: { index, id: str(event.item_id), name: '', args: piece } }];
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    const response = isObject(event.response) ? event.response : {};
    return [{ final: response }];
  }
  if (type === 'error') {
    return [{ error: str(event.message) || '上游在流中返回错误', isError: true }];
  }
  return [];
}

export function responsesStreamToChat(
  upstream: Response,
  opts: ResponsesToChatOptions,
): ResponsesToChatResult {
  let settled = false;
  let resolveUsage!: (v: { usage: TokenUsage | null; error: string | null }) => void;
  const usage = new Promise<{ usage: TokenUsage | null; error: string | null }>((resolve) => {
    resolveUsage = resolve;
  });

  const encoder = new TextEncoder();
  const chunkId = `chatcmpl-${responsesId('chat')}`;
  const created = Math.floor(Date.now() / 1000);
  const slots = new Map<number, number>();
  // 上游给的工具调用 id（Responses 的 call_id / item id），没有就自己编一个
  const names = new Map<number, string>();
  const calls = new Map<number, { id: string; args: string }>();
  const callId = (d: ChatDelta): string =>
    d.tool && d.tool.id !== '' ? d.tool.id : `${chunkId}-call-${d.tool?.index ?? 0}`;
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let finalUsage: TokenUsage | null = null;
  let streamError: string | null = null;

  const settle = (error: string | null): void => {
    if (settled) return;
    settled = true;
    resolveUsage({ usage: finalUsage, error: error ?? streamError });
  };

  const chatUsage = (): Json | null =>
    finalUsage
      ? {
          prompt_tokens: finalUsage.promptTokens,
          completion_tokens: finalUsage.completionTokens,
          total_tokens: finalUsage.totalTokens,
        }
      : null;

  const message = (): Json => {
    const msg: Json = { role: 'assistant', content: slots.size > 0 && content === '' ? null : content };
    if (reasoning !== '') msg.reasoning_content = reasoning;
    if (slots.size > 0) {
      msg.tool_calls = [...slots.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([outputIndex]) => {
          const entry = calls.get(outputIndex);
          return {
            id: entry?.id ?? `${chunkId}-call-${outputIndex}`,
            type: 'function',
            function: { name: names.get(outputIndex) ?? '', arguments: entry?.args ?? '' },
          };
        });
    }
    return msg;
  };

  const chatBody = (): Json => ({
    id: chunkId,
    object: 'chat.completion',
    created,
    model: opts.model,
    choices: [{ index: 0, message: message(), finish_reason: streamError ? 'stop' : finishReason, logprobs: null }],
    usage: chatUsage(),
  });

  const applyFinal = (response: Json): void => {
    const status = str(response.status);
    if (status === 'incomplete') finishReason = 'length';
    if (slots.size > 0) finishReason = 'tool_calls';
    if (isObject(response.error)) streamError = str((response.error as Json).message) || streamError;
    finalUsage = extractResponsesUsage(response.usage) ?? finalUsage;
  };

  /** 吃一条 delta：累积状态，同时（流式时）发帧 */
  const absorb = (d: ChatDelta, emitFrame: boolean): void => {
    if (d.error) {
      streamError = d.error;
      return;
    }
    if (d.content) {
      content += d.content;
      if (emitFrame) emit({ delta: { content: d.content }, finish_reason: null });
    }
    if (d.reasoning) {
      reasoning += d.reasoning;
      if (emitFrame) emit({ delta: { reasoning_content: d.reasoning }, finish_reason: null });
    }
    if (d.tool) {
      finishReason = 'tool_calls';
      if (d.tool.name !== '') names.set(d.tool.index, d.tool.name);
      let slot = slots.get(d.tool.index);
      if (slot === undefined) {
        slot = slots.size;
        slots.set(d.tool.index, slot);
        calls.set(d.tool.index, { id: callId(d), args: d.tool.args });
        if (emitFrame) {
          emit({
            delta: {
              tool_calls: [
                {
                  index: slot,
                  id: callId(d),
                  type: 'function',
                  function: { name: d.tool.name, arguments: d.tool.args },
                },
              ],
            },
            finish_reason: null,
          });
        }
        // 整包路径一次就把参数带全了，别重复发
        if (d.tool.args === '') return;
      } else {
        const entry = calls.get(d.tool.index);
        if (entry) entry.args += d.tool.args;
      }
      if (emitFrame && d.tool.args !== '') {
        emit({ delta: { tool_calls: [{ index: slot, function: { arguments: d.tool.args } }] }, finish_reason: null });
      }
    }
    if (d.final) applyFinal(d.final);
  };

  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  const emit = (choice: Json, extra: Json = {}): void => {
    if (sink == null) return;
    sink.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ id: chunkId, object: 'chat.completion.chunk', created, model: opts.model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`,
      ),
    );
  };

  /** 收尾：结算用量，流式时补 finish_reason 帧与 [DONE] */
  const close = (error: string | null): void => {
    settle(error);
    if (sink == null) return;
    emit(
      { delta: {}, finish_reason: streamError ? 'stop' : finishReason },
      chatUsage() ? { usage: chatUsage() } : {},
    );
    sink.enqueue(encoder.encode('data: [DONE]\n\n'));
    try {
      sink.close();
    } catch {
      /* 已关闭 */
    }
  };

  if (!opts.stream) {
    // 非流式：读完折叠成一包。读失败不抛给调用方 —— 已经拿到上游 200 的前提下，
    // 给一个空内容 + finish_reason=stop 比 500 更不伤调用方（用量按估算结算并记 error）
    const pump = (async (): Promise<Json> => {
      try {
        for await (const d of responsesReader(upstream, opts, () => undefined)) absorb(d, false);
      } catch (err) {
        streamError = `上游流式响应中断: ${err instanceof Error ? err.message : String(err)}`;
      }
      settle(streamError);
      return chatBody();
    })();
    return {
      response: new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(encoder.encode(JSON.stringify(await pump)));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
      ),
      usage,
    };
  }

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      sink = c;
      emit({ delta: { role: 'assistant', content: '' }, finish_reason: null });
      void (async () => {
        try {
          for await (const d of responsesReader(upstream, opts, () => undefined)) absorb(d, true);
          close(null);
        } catch (err) {
          close(`上游流式响应中断: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    cancel(reason) {
      settle(`客户端提前断开: ${reason instanceof Error ? reason.message : String(reason ?? '')}`);
    },
  });

  return {
    response: new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      },
    }),
    usage,
  };
}

// ================================================================ 入口校验

/** Responses 的必填项：model（在 handleProxy 里查）+ input 或 previous_response_id */
export function validateResponsesBody(body: Json): void {
  if (body.input === undefined && body.previous_response_id === undefined) {
    throw badRequest('缺少必填参数 input（或 previous_response_id）', 'input');
  }
  if (Array.isArray(body.input) && body.input.length > 10_000) {
    throw badRequest('input 项数超过上限（10000）', 'input');
  }
}
