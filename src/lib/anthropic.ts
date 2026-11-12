/**
 * Anthropic Messages 协议（`POST /v1/messages`）适配层。
 *
 * 与 responses.ts 同一套思路：
 *
 *   1. 原生路径：渠道声明 `anthropic` 能力时，请求体原样转发到上游 `/messages`
 *      （认证改成 `x-api-key` + `anthropic-version`，见 upstream.ts 的 RouteTarget），
 *      响应原样回传。本文件只负责旁路读用量。
 *   2. 翻译路径：渠道只有 chat 能力时，把 Messages 请求降级成 Chat Completions，
 *      再把整包响应 / SSE 流合成为 Anthropic 的 message 对象与事件流。
 *
 * 为什么值得翻译：Claude Code / Cline / Anthropic SDK 只会说 Messages 协议，
 * 而后面的聚合上游大多只认 /chat/completions。网关不翻译，这些客户端就接不进来。
 *
 * 计费仍归一到 TokenUsage，下游看到的是标准 Anthropic usage
 * （input_tokens / output_tokens / cache_read_input_tokens）。
 */

import {
  emptyUsage,
  estimateTokens,
  estimateTokensFromBody,
  extractUsage,
  type TokenUsage,
} from './billing.js';
import { ApiError, badRequest } from './errors.js';

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

/** 生成 Anthropic 风格 id（msg_ / toolu_ …），22 位 base64url */
export function anthropicId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${prefix}_${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Messages 的 max_tokens 是必填项；下游漏填时用的兜底值 */
const DEFAULT_MESSAGES_MAX_TOKENS = 4096;

// ================================================================ 请求：Messages → Chat

/** system 可以是字符串，也可以是 text 块数组 */
function blocksText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => (isObject(b) && str(b.type) === 'text' ? str(b.text) : ''))
    .join('');
}

/** tool_result 的 content 可以是字符串，也可以是块数组 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!isObject(p)) continue;
    if (str(p.type) === 'text') parts.push(str(p.text));
    else parts.push(`[${str(p.type)}]`);
  }
  return parts.join('\n');
}

/** Anthropic 图片块 → chat 的 image_url 块 */
function imagePart(block: Json): Json | null {
  const source = isObject(block.source) ? block.source : null;
  if (!source) return null;
  const type = str(source.type);
  if (type === 'base64') {
    const media = str(source.media_type) || 'image/png';
    const data = str(source.data);
    if (data === '') return null;
    return { type: 'image_url', image_url: { url: `data:${media};base64,${data}` } };
  }
  if (type === 'url') {
    const url = str(source.url);
    if (url === '') return null;
    return { type: 'image_url', image_url: { url } };
  }
  return null;
}

/** 一条 Anthropic 消息可能拆成多条 chat 消息（tool_result → role=tool） */
function convertAnthropicMessage(raw: Json): Json[] {
  const role = str(raw.role) === 'assistant' ? 'assistant' : 'user';
  const content = raw.content;
  if (typeof content === 'string') return [{ role, content }];
  if (!Array.isArray(content)) return [{ role, content: '' }];

  const texts: string[] = [];
  const parts: Json[] = [];
  const toolCalls: Json[] = [];
  const toolResults: Json[] = [];
  let hasImage = false;

  for (const block of content) {
    if (!isObject(block)) continue;
    const type = str(block.type);
    if (type === 'text') {
      const t = str(block.text);
      if (t !== '') {
        texts.push(t);
        parts.push({ type: 'text', text: t });
      }
    } else if (type === 'image') {
      const p = imagePart(block);
      if (p) {
        hasImage = true;
        parts.push(p);
      }
    } else if (type === 'tool_use') {
      toolCalls.push({
        id: str(block.id) || anthropicId('call'),
        type: 'function',
        function: { name: str(block.name), arguments: stringify(block.input ?? {}) },
      });
    } else if (type === 'tool_result') {
      toolResults.push({
        role: 'tool',
        tool_call_id: str(block.tool_use_id),
        content: toolResultText(block.content),
      });
    }
  }

  // tool_result 在 chat 里必须是独立的 role=tool 消息；一条 Anthropic 消息可带多个，
  // 逐个拆开，剩余文本作为普通 user 消息跟在后面
  if (toolResults.length > 0) {
    const out = [...toolResults];
    const rest = texts.join('');
    if (rest !== '') out.push({ role: 'user', content: rest });
    return out;
  }

  if (role === 'assistant' && toolCalls.length > 0) {
    const text = texts.join('');
    return [{ role: 'assistant', content: text === '' ? null : text, tool_calls: toolCalls }];
  }

  if (hasImage) return [{ role, content: parts }];
  return [{ role, content: texts.join('') }];
}

/** Anthropic 自定义工具（带 input_schema）→ chat 的 function 工具；内建工具丢弃 */
function convertAnthropicTools(raw: unknown): Json[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tools: Json[] = [];
  for (const t of raw) {
    if (!isObject(t)) continue;
    const name = str(t.name);
    if (name === '') continue;
    if (!isObject(t.input_schema)) continue; // computer_20241022 之类没有等价物
    tools.push({
      type: 'function',
      function: {
        name,
        description: str(t.description),
        parameters: t.input_schema,
      },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function convertAnthropicToolChoice(raw: unknown): unknown {
  if (!isObject(raw)) return undefined;
  const type = str(raw.type);
  if (type === 'auto') return 'auto';
  if (type === 'any') return 'required';
  if (type === 'none') return 'none';
  if (type === 'tool' && str(raw.name) !== '') {
    return { type: 'function', function: { name: str(raw.name) } };
  }
  return undefined;
}

export function buildChatRequestFromAnthropic(body: Json, upstreamModel: string, stream: boolean): Json {
  const messages: Json[] = [];

  const systemText = blocksText(body.system);
  if (systemText !== '') messages.push({ role: 'system', content: systemText });

  const list = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    messages.push(...convertAnthropicMessage(raw));
  }

  const out: Json = { model: upstreamModel, messages };

  const maxTokens = num(body.max_tokens);
  out.max_tokens = maxTokens !== undefined && maxTokens > 0 ? maxTokens : DEFAULT_MESSAGES_MAX_TOKENS;

  const temperature = num(body.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = num(body.top_p);
  if (topP !== undefined) out.top_p = topP;

  if (Array.isArray(body.stop_sequences)) {
    const stop = body.stop_sequences.filter((s): s is string => typeof s === 'string');
    if (stop.length > 0) out.stop = stop;
  }

  const metadata = isObject(body.metadata) ? body.metadata : null;
  if (metadata && typeof metadata.user_id === 'string') out.user = metadata.user_id;

  const tools = convertAnthropicTools(body.tools);
  if (tools) {
    out.tools = tools;
    const choice = convertAnthropicToolChoice(body.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
  }

  if (stream) out.stream = true;
  return out;
}

// ================================================================ 响应：Chat → Messages

/** Anthropic 的 usage 与 OpenAI 的计费口径不同：缓存读写要分别算进输入 */
export function extractAnthropicUsage(raw: unknown): TokenUsage | null {
  if (!isObject(raw)) return null;
  const input = num(raw.input_tokens) ?? 0;
  const output = num(raw.output_tokens) ?? 0;
  const cacheRead = num(raw.cache_read_input_tokens) ?? 0;
  const cacheCreate = num(raw.cache_creation_input_tokens) ?? 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreate === 0) return null;
  const prompt = input + cacheRead + cacheCreate;
  return {
    promptTokens: prompt,
    completionTokens: output,
    totalTokens: prompt + output,
    cachedTokens: cacheRead,
    estimated: false,
  };
}

export function toAnthropicUsage(usage: TokenUsage | null): Json {
  const u =
    usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, estimated: true };
  const out: Json = { input_tokens: u.promptTokens, output_tokens: u.completionTokens };
  if (u.cachedTokens > 0) out.cache_read_input_tokens = u.cachedTokens;
  return out;
}

function estimateUsageFromRequest(request: Json, outText: string): TokenUsage {
  const prompt = estimateTokensFromBody(request);
  const completion = estimateTokens(outText);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cachedTokens: 0,
    estimated: true,
  };
}

function mapStopReason(finish: string, hasTools: boolean): string {
  if (hasTools) return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  return 'end_turn';
}

function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function contentTextFromMessage(message: Json): string {
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (isObject(p) && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

export function chatToAnthropicMessage(chat: Json, request: Json, model: string, messageId: string): Json {
  const first = Array.isArray(chat.choices) ? chat.choices[0] : undefined;
  const choice = isObject(first) ? first : {};
  const message = isObject(choice.message) ? choice.message : {};

  const content: Json[] = [];
  const text = contentTextFromMessage(message);
  if (text !== '') content.push({ type: 'text', text });

  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    if (!isObject(raw)) continue;
    const fn = isObject(raw.function) ? raw.function : {};
    content.push({
      type: 'tool_use',
      id: str(raw.id) || anthropicId('toolu'),
      name: str(fn.name),
      input: parseArguments(str(fn.arguments)),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const usage = extractUsage(chat.usage) ?? estimateUsageFromRequest(request, text);

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(str(choice.finish_reason), calls.length > 0),
    stop_sequence: null,
    usage: toAnthropicUsage(usage),
  };
}

// ================================================================ 流式翻译

export interface AnthropicStreamOptions {
  request: Json;
  model: string;
  messageId: string;
  /** 下游要事件流还是整包 JSON */
  stream: boolean;
  /** 上游 SSE 空闲上限，沿用渠道 timeout_ms 的「数据间隔」语义 */
  idleMs: number;
  signal?: AbortSignal;
}

export interface AnthropicStreamResult {
  response: Response;
  usage: Promise<{ usage: TokenUsage; error: string | null }>;
  /** 折叠后的完整 message 对象（流式下游在收尾时 resolve，供留档） */
  payload: Promise<Json | null>;
}

interface ContentBlock {
  index: number;
  kind: 'text' | 'tool_use';
  text: string;
  id: string;
  name: string;
  args: string;
  open: boolean;
}

/**
 * 单一状态机：吃 chat SSE 分片，吐出 Anthropic 事件。
 *
 * 事件顺序照官方：
 *   message_start → (content_block_start → content_block_delta* → content_block_stop)*
 *   → message_delta → message_stop
 */
export function chatStreamToAnthropic(
  upstream: Response,
  opts: AnthropicStreamOptions,
): AnthropicStreamResult {
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

  const blocks: ContentBlock[] = [];
  const toolByIndex = new Map<number, ContentBlock>();
  let textBlock: ContentBlock | null = null;
  let finalUsage: TokenUsage | null = null;
  let finishReason = '';
  let streamError: string | null = null;

  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const send = (event: Json): void => {
    if (sink == null) return;
    sink.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
  };

  const openText = (): ContentBlock => {
    if (textBlock && textBlock.open) return textBlock;
    const block: ContentBlock = {
      index: blocks.length,
      kind: 'text',
      text: '',
      id: '',
      name: '',
      args: '',
      open: true,
    };
    blocks.push(block);
    textBlock = block;
    send({ type: 'content_block_start', index: block.index, content_block: { type: 'text', text: '' } });
    return block;
  };

  const closeBlock = (block: ContentBlock): void => {
    if (!block.open) return;
    block.open = false;
    send({ type: 'content_block_stop', index: block.index });
  };

  const closeText = (): void => {
    if (textBlock) closeBlock(textBlock);
  };

  const openTool = (callIndex: number, delta: Json): ContentBlock => {
    const existing = toolByIndex.get(callIndex);
    if (existing) return existing;
    // chat 的工具调用总在文本之后：先收尾正文块，再开工具块
    closeText();
    const fn = isObject(delta.function) ? delta.function : {};
    const block: ContentBlock = {
      index: blocks.length,
      kind: 'tool_use',
      text: '',
      id: str(delta.id) || anthropicId('toolu'),
      name: str(fn.name),
      args: '',
      open: true,
    };
    blocks.push(block);
    toolByIndex.set(callIndex, block);
    send({
      type: 'content_block_start',
      index: block.index,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    return block;
  };

  const readChunk = (chunk: Json): void => {
    if (isObject(chunk.error)) {
      streamError = str(chunk.error.message) || '上游在流中返回错误';
      return;
    }

    const choices = chunk.choices;
    const choice =
      Array.isArray(choices) && choices.length > 0 && isObject(choices[0]) ? choices[0] : null;
    if (choice) {
      const delta = isObject(choice.delta) ? choice.delta : {};
      const content = typeof delta.content === 'string' ? delta.content : '';
      if (content !== '') {
        const block = openText();
        block.text += content;
        send({ type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text: content } });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          if (!isObject(raw)) continue;
          const block = openTool(num(raw.index) ?? 0, raw);
          const fn = isObject(raw.function) ? raw.function : {};
          // 分片里 name 通常只在第一片出现；已发过 content_block_start 就补不回去了
          if (block.name === '' && typeof fn.name === 'string') block.name = fn.name;
          const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
          if (argsDelta !== '') {
            block.args += argsDelta;
            send({
              type: 'content_block_delta',
              index: block.index,
              delta: { type: 'input_json_delta', partial_json: argsDelta },
            });
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        finishReason = choice.finish_reason;
      }
    }

    const chunkUsage = extractUsage(chunk.usage);
    if (chunkUsage) finalUsage = chunkUsage;
  };

  const buildMessage = (): Json => {
    const content: Json[] = blocks.map((b) =>
      b.kind === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'tool_use', id: b.id, name: b.name, input: parseArguments(b.args) },
    );
    if (content.length === 0) content.push({ type: 'text', text: '' });
    const hasTools = blocks.some((b) => b.kind === 'tool_use');
    const text = blocks.map((b) => b.text).join('');
    return {
      id: opts.messageId,
      type: 'message',
      role: 'assistant',
      model: opts.model,
      content,
      stop_reason: streamError ? 'end_turn' : mapStopReason(finishReason, hasTools),
      stop_sequence: null,
      usage: toAnthropicUsage(finalUsage ?? estimateUsageFromRequest(opts.request, text)),
    };
  };

  const settle = (error: string | null): void => {
    if (settled) return;
    settled = true;
    clearIdle();
    const text = blocks.map((b) => b.text).join('');
    resolveUsage({ usage: finalUsage ?? estimateUsageFromRequest(opts.request, text), error: error ?? streamError });
    resolvePayload(error == null ? buildMessage() : null);
  };

  const finish = (): void => {
    for (const block of blocks) closeBlock(block);
    const message = buildMessage();
    send({
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: num((message.usage as Json).output_tokens) ?? 0 },
    });
    send({ type: 'message_stop' });
    settle(null);
    try {
      sink?.close();
    } catch {
      /* 已关闭 */
    }
  };

  const abortWith = (reason: string): void => {
    if (settled) return;
    streamError = reason;
    send({ type: 'error', error: { type: 'api_error', message: reason } });
    for (const block of blocks) closeBlock(block);
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
    return {
      response: new Response(empty, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
      usage,
      payload,
    };
  }

  // 非流式下游 + 上游回的是整包 JSON（chat.completion）：上游没有 SSE 可解，
  // 直接按整包转换。少了这一支，下游要非流式时会拿到空内容、用量全靠估算。
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!opts.stream && !contentType.includes('event-stream')) {
    const pending = (async (): Promise<Json> => {
      let chat: Json = {};
      try {
        chat = JSON.parse(await upstream.text()) as Json;
      } catch {
        chat = {};
      }
      const message = chatToAnthropicMessage(chat, opts.request, opts.model, opts.messageId);
      const used =
        extractUsage(isObject(chat.usage) ? chat.usage : null) ?? estimateUsageFromRequest(opts.request, '');
      resolveUsage({ usage: used, error: null });
      resolvePayload(message);
      return message;
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

  const pump = async (): Promise<boolean> => {
    const { done: eof, value } = await reader.read();
    if (eof) return false;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '' || data === '[DONE]') continue;
      try {
        readChunk(JSON.parse(data) as Json);
      } catch {
        /* 非 JSON 行（注释、心跳）直接跳过 */
      }
    }
    return true;
  };

  if (!opts.stream) {
    const aggregate = async (): Promise<Json> => {
      for (;;) {
        if (!(await pump())) break;
      }
      return buildMessage();
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
      send({
        type: 'message_start',
        message: {
          id: opts.messageId,
          type: 'message',
          role: 'assistant',
          model: opts.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimateTokensFromBody(opts.request), output_tokens: 0 },
        },
      });
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
        if (blocks.length > 0) {
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

// ================================================================ 原生透传：只旁路读用量

/**
 * 原生 Anthropic 流：原样透传，只旁路累计 usage。
 *
 * 用量分散在两处：message_start.message.usage 给输入侧（含缓存读写），
 * message_delta.usage 给输出侧。流末端一定出现，所以只保留尾部窗口，收尾时解析一次。
 */
export function anthropicPassthroughUsage(
  upstream: Response,
  idleMs: number,
): { stream: ReadableStream<Uint8Array>; usage: Promise<{ usage: TokenUsage; error: string | null }> } {
  let settled = false;
  let resolveUsage!: (v: { usage: TokenUsage; error: string | null }) => void;
  const usage = new Promise<{ usage: TokenUsage; error: string | null }>((resolve) => {
    resolveUsage = resolve;
  });

  const body = upstream.body;
  if (!body) {
    settled = true;
    resolveUsage({ usage: emptyUsage(true), error: '上游返回空响应体' });
    return {
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      usage,
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const settle = (error: string | null): void => {
    if (settled) return;
    settled = true;
    clearIdle();
    resolveUsage(parseAnthropicUsageText(text, error));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    async pull(c) {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        settle(`上游 ${idleMs}ms 无数据，网关已中断本次流式响应`);
        const err = new Error('上游空闲超时');
        try {
          controller?.error(err);
        } catch {
          /* 已关闭 */
        }
        void reader.cancel(err).catch(() => undefined);
      }, idleMs);
      try {
        const { done: eof, value } = await reader.read();
        clearIdle();
        if (settled) return;
        if (eof) {
          settle(null);
          c.close();
          return;
        }
        text += decoder.decode(value, { stream: true });
        if (text.length > 400_000) text = text.slice(-400_000);
        c.enqueue(value);
      } catch (err) {
        settle(`上游流式响应中断: ${err instanceof Error ? err.message : String(err)}`);
        if (settled) c.error(err);
      }
    },
    cancel(reason) {
      settle(
        `客户端提前断开（已收到 ${text.length} 字符）: ${
          reason instanceof Error ? reason.message : String(reason ?? '')
        }`,
      );
      void reader.cancel(reason).catch(() => undefined);
    },
  });

  return { stream, usage };
}

function parseAnthropicUsageText(
  text: string,
  error: string | null,
): { usage: TokenUsage; error: string | null } {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let seen = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data === '' || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as Json;
      const type = str(parsed.type);
      if (type === 'message_start' && isObject(parsed.message)) {
        const u = isObject((parsed.message as Json).usage) ? ((parsed.message as Json).usage as Json) : null;
        if (u) {
          input = Math.max(input, num(u.input_tokens) ?? 0);
          cacheRead = Math.max(cacheRead, num(u.cache_read_input_tokens) ?? 0);
          cacheCreate = Math.max(cacheCreate, num(u.cache_creation_input_tokens) ?? 0);
          output = Math.max(output, num(u.output_tokens) ?? 0);
          seen = true;
        }
      } else if (type === 'message_delta' && isObject(parsed.usage)) {
        output = Math.max(output, num((parsed.usage as Json).output_tokens) ?? 0);
        seen = true;
      }
    } catch {
      /* 忽略无法解析的行 */
    }
  }
  if (!seen) return { usage: emptyUsage(true), error };
  const prompt = input + cacheRead + cacheCreate;
  return {
    usage: {
      promptTokens: prompt,
      completionTokens: output,
      totalTokens: prompt + output,
      cachedTokens: cacheRead,
      estimated: false,
    },
    error,
  };
}

// ================================================================ 入口校验

/** Messages 的必填项：messages 非空；max_tokens 缺省时补默认值 */
export function validateMessagesBody(body: Json): void {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw badRequest('缺少必填参数 messages（不能为空数组）', 'messages');
  }
  if (body.messages.length > 10_000) {
    throw badRequest('messages 条数超过上限（10000）', 'messages');
  }
  if (body.max_tokens !== undefined && num(body.max_tokens) === undefined) {
    throw badRequest('max_tokens 必须是数字', 'max_tokens');
  }
  if (num(body.max_tokens) === undefined) body.max_tokens = DEFAULT_MESSAGES_MAX_TOKENS;
}

// ================================================================ 错误形状

/**
 * 把网关内部的错误翻成 Anthropic 的 `{"type":"error","error":{...}}`。
 *
 * Anthropic SDK 只认这一种形状，回 OpenAI 的 `{"error":{...}}` 会让客户端
 * 报「unexpected response」，错误信息全被吞掉。
 */
export function anthropicErrorResponse(err: unknown): Response {
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 404
          ? 'not_found_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'api_error'
              : 'invalid_request_error';
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
