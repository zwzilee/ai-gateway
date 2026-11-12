/**
 * 下游 OpenAI 兼容 API。
 *
 * 两种端点：
 *
 *   * 通用透传：POST /v1/<path> 转发到上游同名端点，/chat/completions、/completions、
 *     /embeddings、/moderations 都是这样走的，无需逐个实现。
 *   * 协议适配：/v1/responses 允许「原生优先、自动降级」—— 渠道支持上游 /responses
 *     就原样转发，不支持就在网关内翻译成 /chat/completions 再翻回来（见 lib/responses.ts）。
 *
 * 转发前统一做三件事：鉴权、模型白名单校验、用量结算。
 */

import { authenticate, reserveQuota } from '../lib/auth.js';
import {
  anthropicErrorResponse,
  anthropicId,
  anthropicPassthroughUsage,
  buildChatRequestFromAnthropic,
  chatStreamToAnthropic,
  validateMessagesBody,
} from '../lib/anthropic.js';
import {
  computeCost,
  emptyUsage,
  estimateRequestCost,
  estimateTokensFromBody,
  type TokenUsage,
} from '../lib/billing.js';
import { all, first, getModel, recordUsage } from '../lib/db.js';
import { ApiError, badRequest, errorResponse, notFound } from '../lib/errors.js';
import { canUseModel, parseAllowedModels } from '../lib/modelAccess.js';
import {
  buildChatRequest,
  chatStreamToResponses,
  extractResponsesUsage,
  responsesId,
  validateResponsesBody,
} from '../lib/responses.js';
import {
  proxyRequest,
  type ProxyOutcome,
  type RouteContext,
  type RouteTarget,
} from '../lib/upstream.js';
import type { ChannelRow, Env, ModelRow, UsageEntry } from '../types.js';

/** 下游 API 的版本前缀。转发前需要剥掉，由 buildUpstreamUrl 按上游 base_url 决定是否补回 */
const DOWNSTREAM_PREFIX = '/v1';

/** 允许透传的端点白名单，避免把 /v1/files 之类意外代理出去 */
const ALLOWED_ENDPOINTS = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/moderations',
  '/v1/responses',
  '/v1/messages',
]);

/** 上游原生 Responses 端点（与下游同名，剥掉前缀后就是 '/responses'） */
const RESPONSES_ENDPOINT = '/responses';
const CHAT_ENDPOINT = '/chat/completions';
/** 上游原生 Anthropic Messages 端点 */
const ANTHROPIC_ENDPOINT = '/messages';

/**
 * 渠道声明支持哪些协议（channels.capabilities，空格分隔）。
 *
 * 缺省（空串 / NULL）表示「只有 chat」。历史上所有渠道都是这一档，
 * 因此老数据不需要迁移语义，行为与升级前一致。
 */
export function channelProtocols(channel: ChannelRow): Set<string> {
  const raw = (channel.capabilities ?? '').trim().toLowerCase();
  if (raw === '') return new Set(['chat']);
  const out = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    if (token === '') continue;
    if (token === 'openai-chat') out.add('chat');
    else if (token === 'openai-responses') out.add('responses');
    else out.add(token);
  }
  if (out.size === 0) out.add('chat');
  return out;
}

export async function handleModels(request: Request, env: Env): Promise<Response> {
  const { ctx: auth } = await authenticate(request, env);

  const models = await all<ModelRow>(
    env.DB.prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY id ASC'),
  );

  /*
   * 只列出「当前至少有一个启用渠道能服务」的模型。
   *
   * 否则调用方会在列表里看到一个没有任何渠道映射的模型，选中后才收到
   * 「没有可用渠道支持模型」——列表结构与真实可调用能力不一致。
   * 只要存在 allow_all_models 的启用渠道，就等于全部模型都能透传。
   */
  const servable = await servableModels(env);
  const allowed = parseAllowedModels(auth.key.allowed_models);
  const allowedSet = allowed === null ? null : new Set(allowed);
  const visible = models.filter(
    (m) => (!servable || servable.has(m.id)) && (!allowedSet || allowedSet.has(m.id)),
  );

  return Response.json({
    object: 'list',
    data: visible.map((m) => ({
      id: m.id,
      object: 'model',
      created: Math.floor(m.created_at / 1000),
      owned_by: 'ai-gateway',
      permission: [],
      root: m.id,
      parent: null,
      // 以下字段非 OpenAI 标准，便于调用方了解计费口径
      display_name: m.display_name || m.id,
      pricing: {
        prompt_usd_per_1m: m.prompt_price,
        completion_usd_per_1m: m.completion_price,
        // 缓存命中部分的单价；null 表示未单独设置，命中部分仍按 prompt_usd_per_1m 计
        cache_hit_usd_per_1m: m.cache_hit_price ?? null,
      },
    })),
  });
}

/**
 * `POST /v1/messages/count_tokens`
 *
 * Anthropic SDK / Claude Code 在发送长上下文前会先探一次 token 数。这里不做
 * 真实分词（没有 tokenizer），按与计费预扣同一套估算（billing.estimateTokens）
 * 给个数 —— 客户端只用它来决定是否压缩上下文，误差不影响正确性。
 */
export async function handleCountTokens(request: Request, env: Env): Promise<Response> {
  try {
    await authenticate(request, env);
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw badRequest('请求体必须是 application/json');
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest('请求体不是合法 JSON');
    }
    const inputTokens = estimateTokensFromBody(body);
    return Response.json({ input_tokens: inputTokens });
  } catch (err) {
    return anthropicErrorResponse(err);
  }
}

/**
 * 当前可服务的模型集合。
 *
 * 返回 null 表示「全部模型都可服务」（存在 allow_all_models 的启用渠道）。
 */
async function servableModels(env: Env): Promise<Set<string> | null> {
  const anyAll = await first<{ n: number }>(
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM channels WHERE status = 'enabled' AND allow_all_models = 1",
    ),
  );
  if ((anyAll?.n ?? 0) > 0) return null;

  const rows = await all<{ model: string }>(
    env.DB.prepare(
      `SELECT DISTINCT cm.model AS model
         FROM channel_models cm
         JOIN channels c ON c.id = cm.channel_id
        WHERE c.status = 'enabled'`,
    ),
  );
  return new Set(rows.map((r) => r.model));
}

/**
 * 只依赖 waitUntil 的最小接口，避免与 workers-types 各版本的
 * ExecutionContext 泛型签名耦合。
 */
export interface BackgroundTasks {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Responses 的 `store` / `previous_response_id` 支撑。
 *
 * Workers 的 isolate 生命周期很短，这里不承诺长期存储：只在当前实例里缓存最近
 * 若干条响应，供 store=true 的客户端随后 GET /v1/responses/:id 取回，或把
 * previous_response_id 串起来做多轮。缓存满了按插入顺序淘汰最旧的。
 *
 * 命中不到（实例换了 / 已淘汰）时返回 404 + 明确的 not_found 错误，让客户端
 * 自己决定重发全量上下文 —— 这比假装存在、返回空对话安全得多。
 */
const RESPONSE_CACHE_LIMIT = 32;
const responseCache = new Map<string, { userId: number; payload: Record<string, unknown> }>();

function cacheResponse(userId: number, responseId: string, payload: Record<string, unknown>): void {
  if (!responseId) return;
  responseCache.delete(responseId);
  responseCache.set(responseId, { userId, payload });
  while (responseCache.size > RESPONSE_CACHE_LIMIT) {
    const oldest = responseCache.keys().next();
    if (oldest.done) break;
    responseCache.delete(oldest.value);
  }
}

/**
 * GET /v1/responses/:id
 *
 * 只回本实例缓存过的响应，且只回给同一个用户 —— 响应里含完整对话内容，
 * 跨用户可读就是泄露。拿不到一律 404，不区分「不存在」与「不属于你」，
 * 避免用 id 探测别人的请求。
 */
export async function handleGetResponse(request: Request, env: Env): Promise<Response> {
  const { ctx: auth } = await authenticate(request, env);
  const url = new URL(request.url);
  const id = decodeURIComponent(url.pathname.replace(/\/+$/, '').split('/').pop() ?? '');
  const hit = id ? responseCache.get(id) : undefined;
  if (!hit || hit.userId !== auth.user.id) {
    throw new ApiError(
      404,
      `响应「${id}」不存在：网关只在当前实例内保留最近的响应，请带上完整上下文重新请求`,
      'invalid_request_error',
      'response_not_found',
      'response_id',
    );
  }
  return Response.json({ ...hit.payload }, { headers: { 'x-request-id': crypto.randomUUID() } });
}

/**
 * 把 input 归一成数组，便于和历史消息拼接。
 *
 * 原样保留每一项的形状 —— 消息、function_call、function_call_output 都由
 * buildChatRequest 负责翻译，这里不做解释。
 */
function asInputArray(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }];
  return [];
}

/**
 * 把已有响应折回 chat 消息，供 previous_response_id 续写。
 *
 * 取不回来就当作没有历史（返回 null）：客户端明确给了 previous_response_id
 * 却又拿不到时，直接报错比静默丢历史更安全，见 handleProxy 的调用点。
 */
function historyToMessages(payload: Record<string, unknown>): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  const output = payload.output;
  if (!Array.isArray(output)) return messages;
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it.type === 'message') {
      const content = Array.isArray(it.content) ? it.content : [];
      const text = content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (typeof p.refusal === 'string') return p.refusal;
          return '';
        })
        .join('');
      if (text) messages.push({ role: 'assistant', content: text });
    } else if (it.type === 'function_call') {
      // 同一轮可能有多条 function_call，合并进同一条 assistant 消息的 tool_calls，
      // 否则上游会看到「一条消息带一个调用」的碎历史
      const call = {
        id: typeof it.call_id === 'string' ? it.call_id : String(it.id ?? ''),
        type: 'function',
        function: {
          name: typeof it.name === 'string' ? it.name : '',
          arguments: typeof it.arguments === 'string' ? it.arguments : '{}',
        },
      };
      const last = messages[messages.length - 1];
      if (last && Array.isArray(last.tool_calls) && last.role === 'assistant') {
        (last.tool_calls as unknown[]).push(call);
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      }
    }
  }
  return messages;
}

/** 密钥「最后使用时间」的写入间隔：距上次写入不足这个时长就不再写，省一次 D1 写入 */
const KEY_TOUCH_INTERVAL_MS = 60_000;

export async function handleProxy(
  request: Request,
  env: Env,
  ctx: BackgroundTasks,
): Promise<Response> {
  const started = Date.now();
  let userId: number | null = null;
  let keyId: number | null = null;
  let touchKey = true;
  let model: string | null = null;
  let channelId: number | null = null;
  let upstreamModel: string | null = null;
  let stream = 0;
  let reservedUsd = 0;
  /** 本次请求是否是 Anthropic Messages —— 出错时要按 Anthropic 的格式回 */
  let isMessagesRequest = false;

  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const ua = request.headers.get('user-agent') ?? '';

  try {
    const { ctx: auth } = await authenticate(request, env);
    userId = auth.user.id;
    keyId = auth.key.id;
    // 鉴权时已经读到该密钥，顺带判断「最后使用时间」是否值得再写一次
    touchKey =
      auth.key.last_used_at == null || Date.now() - auth.key.last_used_at >= KEY_TOUCH_INTERVAL_MS;

    // 下游路径形如 /v1/chat/completions。上游拼接时 buildUpstreamUrl 会自行补版本前缀
    // （裸域名补 /v1，已带路径的原样拼接），因此这里必须先剥掉 /v1，
    // 否则会拼成 /v1/v1/chat/completions 并收到 404。
    const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
    if (!ALLOWED_ENDPOINTS.has(pathname)) {
      throw notFound(`不支持的端点 ${pathname}`);
    }
    const endpoint = pathname.slice(DOWNSTREAM_PREFIX.length) || '/';
    const isResponses = endpoint === RESPONSES_ENDPOINT;
    const isMessages = endpoint === ANTHROPIC_ENDPOINT;
    isMessagesRequest = isMessages;

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw badRequest('请求体必须是 application/json');
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw badRequest('请求体不是合法 JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('请求体必须是 JSON 对象');
    }

    const rawModel = body.model;
    if (typeof rawModel !== 'string' || rawModel.trim() === '') {
      throw badRequest('缺少必填参数 model', 'model');
    }
    model = rawModel.trim();
    // Responses 的流式请求同样是 stream: true；缺省时是「一次返回整包」，与非流式一致
    stream = body.stream === true ? 1 : 0;

    /*
     * previous_response_id：先把它折回 messages 拼进本次 input，再走正常链路。
     *
     * 拿不到历史就直接报错 —— 静默丢掉上下文会让模型答非所问，比失败更难排查。
     */
    if (isResponses && typeof body.previous_response_id === 'string' && body.previous_response_id) {
      const prevId = body.previous_response_id;
      const cached = responseCache.get(prevId);
      if (!cached || cached.userId !== auth.user.id) {
        throw new ApiError(
          404,
          `previous_response_id「${prevId}」已失效：网关只在当前实例内保留最近的响应，请把完整上下文放进 input`,
          'invalid_request_error',
          'previous_response_not_found',
          'previous_response_id',
        );
      }
      body = { ...body, input: [...historyToMessages(cached.payload), ...asInputArray(body.input)] };
      delete body.previous_response_id;
      // 历史折进来之后 input 一定非空，校验放在拼接之后才有意义
      if (body.input === undefined) body.input = [];
    }

    if (isResponses) validateResponsesBody(body);
    if (isMessages) validateMessagesBody(body);

    if (!canUseModel(auth.key.allowed_models, model)) {
      throw new ApiError(
        403,
        `此 API Key 无权使用模型「${model}」`,
        'permission_error',
        'model_not_allowed',
        'model',
      );
    }

    const modelRow = await getModel(env.DB, model);
    if (!modelRow || modelRow.enabled !== 1) {
      throw new ApiError(
        404,
        `模型「${model}」不存在或未启用，可用模型请查询 GET /v1/models`,
        'invalid_request_error',
        'model_not_found',
        'model',
      );
    }

    // 用返回值而不是估算值：结算按「实际扣了多少」回补，见 recordUsage 的 delta
    reservedUsd = await reserveQuota(env, auth.key, auth.user, estimateRequestCost(modelRow, body));

    /*
     * 上游拿到的是「历史 + 本次 input」拼好的消息。为了把响应缓存起来供
     * previous_response_id 续写，这里留一份原始请求的副本，不能直接用拼过的 body。
     */
    const requestForResponse = isResponses ? { ...body } : null;

    const responseId = isResponses ? responsesId('resp') : '';
    const anthropicVersion = request.headers.get('anthropic-version') || '2023-06-01';
    const route: (ctx: RouteContext) => RouteTarget | null = isResponses
      ? responsesRoute(body, stream === 1)
      : isMessages
        ? messagesRoute(body, stream === 1, anthropicVersion)
        : chatRoute(endpoint);

    const modelName = model;
    const runProxy = (routeFn?: typeof route): Promise<ProxyOutcome> =>
      proxyRequest(env, {
        body,
        model: modelName,
        endpoint,
        stream: stream === 1,
        signal: request.signal,
        ...(routeFn ? { route: routeFn } : {}),
      });

    /*
     * 兜底自愈：渠道没标对应协议能力时默认翻译成 chat 协议，但有些上游模型
     * 只认自己的原生端点（会明确回「请改用 /v1/responses」或 /v1/messages）。
     * 碰到这种提示，用同一份原始请求再走一次原生透传 —— 上游真没有该端点时会被
     * fallbackOnMissingEndpoint 静默换渠道，不会误伤；第一次是 4xx，不产生计费。
     */
    let outcome: ProxyOutcome;
    try {
      outcome = await runProxy(route);
    } catch (err) {
      const rejected =
        err instanceof ApiError && err.code === 'upstream_rejected' ? err.message : '';
      const retryResponses = isResponses && /\/v1\/responses/i.test(rejected);
      const retryMessages = isMessages && /\/v1\/messages/i.test(rejected);
      if (!retryResponses && !retryMessages) throw err;

      const passthrough: Record<string, unknown> = { ...body };
      if (stream === 1) passthrough.stream = true;
      outcome = await runProxy(() =>
        retryMessages
          ? {
              endpoint: ANTHROPIC_ENDPOINT,
              body: passthrough,
              injectUsage: false,
              fallbackOnMissingEndpoint: true,
              auth: 'x-api-key',
              headers: { 'anthropic-version': anthropicVersion },
            }
          : {
              endpoint: RESPONSES_ENDPOINT,
              body: passthrough,
              injectUsage: false,
              fallbackOnMissingEndpoint: true,
            },
      );
    }

    channelId = outcome.channel.id;
    upstreamModel = outcome.upstreamModel;

    // 上游打的是 chat 端点 → 需要把结果翻译成下游协议；打的是原生端点 → 原样透传
    const needsTranslation = (isResponses || isMessages) && outcome.endpoint === CHAT_ENDPOINT;
    let responseBody: BodyInit | null = outcome.response.body;
    let usagePromise = outcome.usage;
    let responseStatus = outcome.response.status;

    if (needsTranslation && isResponses) {
      const translated = chatStreamToResponses(outcome.response, {
        request: requestForResponse ?? body,
        model,
        responseId,
        stream: stream === 1,
        idleMs: outcome.channel.timeout_ms,
        signal: request.signal,
      });
      responseBody = translated.response.body;
      responseStatus = translated.response.status;
      usagePromise = translated.usage;
      // 非流式翻译已经把整包 Responses 对象攒好了；store 时直接留档供后续取回
      if (stream === 0) {
        void translated.payload.then((payload) => {
          if (payload) cacheResponse(auth.user.id, responseId, payload);
        });
      }
    } else if (needsTranslation) {
      const translated = chatStreamToAnthropic(outcome.response, {
        request: requestForResponse ?? body,
        model,
        messageId: anthropicId('msg'),
        stream: stream === 1,
        idleMs: outcome.channel.timeout_ms,
        signal: request.signal,
      });
      responseBody = translated.response.body;
      responseStatus = translated.response.status;
      usagePromise = translated.usage;
    } else if (isResponses && stream === 1) {
      // 原生透传：只旁路读 usage，不改事件流
      const native = nativeResponsesUsage(outcome.response, outcome.channel.timeout_ms);
      usagePromise = native.usage;
      responseBody = native.stream;
    } else if (isMessages && stream === 1) {
      // 原生 Anthropic 流：原样透传（含 event: 行），只在末尾旁路解析 usage
      const native = anthropicPassthroughUsage(outcome.response, outcome.channel.timeout_ms);
      usagePromise = native.usage;
      responseBody = native.stream;
    } else if (isResponses) {
      // 原生非流式：原样透传，但顺带克隆一份解析出来缓存（clone 不消耗原 body）
      const clone = outcome.response.clone();
      void clone
        .json()
        .then((payload) => {
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            cacheResponse(auth.user.id, responseId, payload as Record<string, unknown>);
          }
        })
        .catch(() => undefined);
    }

    const requestId = crypto.randomUUID();
    const headers = new Headers(outcome.response.headers);
    headers.set('x-request-id', requestId);
    headers.set('x-gateway-channel', String(outcome.channel.id));
    if (outcome.attempts > 1) headers.set('x-gateway-attempts', String(outcome.attempts));

    if (isResponses) {
      headers.set('openai-processing-ms', String(Date.now() - started));
    }
    if (needsTranslation) {
      headers.set('content-type', stream === 1 ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
      headers.set('cache-control', 'no-cache');
    }

    // 用量在响应体读完后才能确定，因此放进 waitUntil，不阻塞响应返回
    ctx.waitUntil(
      settleUsage(env, usagePromise, {
        requestId,
        userId,
        keyId,
        channelId,
        model,
        upstreamModel,
        latencyMs: Date.now() - started,
        statusCode: responseStatus,
        stream,
        ip,
        ua,
        touchKey,
        modelRow,
        body,
        reservedUsd,
      }),
    );

    return new Response(responseBody, {
      status: responseStatus,
      headers,
    });
  } catch (err) {
    const response = isMessagesRequest ? anthropicErrorResponse(err) : errorResponse(err);
    const status = response.status;

    if (userId != null || keyId != null || model != null) {
      ctx.waitUntil(
        recordUsage(env.DB, {
          requestId: crypto.randomUUID(),
          userId,
          keyId,
          channelId,
          model,
          upstreamModel,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          estimated: 0,
          latencyMs: Date.now() - started,
          statusCode: status,
          stream,
          touchKey,
          reservedUsd,
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          ip,
          ua,
        }).catch(() => undefined),
      );
    }
    return response;
  }
}

/**
 * /v1/responses 的渠道路由。
 *
 *   * 渠道声明 responses 原生能力 → 打上游 /responses，请求体原样透传
 *     （只把 stream 补上：Responses 的流式必须显式声明）
 *   * 其余渠道 → 打 /chat/completions，请求体在 buildChatRequest 里翻译
 *
 * 上游若返回 404/405（没有这个端点），fallbackOnMissingEndpoint 会让调度器
 * 静默换下一个渠道，而不是把渠道判成故障冷却 —— 渠道没坏，只是不认这个协议。
 */
function responsesRoute(
  body: Record<string, unknown>,
  stream: boolean,
): (ctx: { channel: ChannelRow; upstreamModel: string }) => RouteTarget | null {
  return (ctx) => {
    if (channelProtocols(ctx.channel).has('responses')) {
      const passthrough: Record<string, unknown> = { ...body };
      if (stream) passthrough.stream = true;
      return {
        endpoint: RESPONSES_ENDPOINT,
        body: passthrough,
        injectUsage: false,
        fallbackOnMissingEndpoint: true,
      };
    }
    return {
      endpoint: CHAT_ENDPOINT,
      body: buildChatRequest(body, ctx.upstreamModel, stream),
      injectUsage: true,
    };
  };
}

/**
 * /v1/messages 的渠道路由。
 *
 *   * 渠道声明 anthropic 能力 → 打上游 /messages，请求体原样透传，改用 x-api-key 认证
 *   * 其余渠道 → 打 /chat/completions，请求体在 buildChatRequestFromAnthropic 里翻译
 */
function messagesRoute(
  body: Record<string, unknown>,
  stream: boolean,
  anthropicVersion: string,
): (ctx: { channel: ChannelRow; upstreamModel: string }) => RouteTarget | null {
  return (ctx) => {
    if (channelProtocols(ctx.channel).has('anthropic')) {
      const passthrough: Record<string, unknown> = { ...body };
      if (stream) passthrough.stream = true;
      return {
        endpoint: ANTHROPIC_ENDPOINT,
        body: passthrough,
        injectUsage: false,
        fallbackOnMissingEndpoint: true,
        auth: 'x-api-key',
        headers: { 'anthropic-version': anthropicVersion },
      };
    }
    return {
      endpoint: CHAT_ENDPOINT,
      body: buildChatRequestFromAnthropic(body, ctx.upstreamModel, stream),
      injectUsage: true,
    };
  };
}

/** 其余端点（chat/completions、embeddings…）一律原样透传，按 Bearer 认证 */
function chatRoute(endpoint: string): (ctx: RouteContext) => RouteTarget {
  return (ctx) => ({ endpoint, body: ctx.body, injectUsage: true });
}

/**
 * 原生 Responses 流：原样透传，只旁路累计 usage。
 *
 * Responses 的流里 usage 出现在 response.completed / response.incomplete 事件的
 * response.usage 上，个别上游还会单独发一条 usage 事件。这里不逐行解析，只保留
 * 尾部文本（同 streamResponse 的做法），收尾时找一次 —— usage 永远在流末尾。
 * 旁路解析失败不影响透传：resolve 的是估算值，只是标了 estimated。
 */
function nativeResponsesUsage(
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
    return { stream: new Response(null).body ?? emptyStream(), usage };
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
    resolveUsage(parseNativeUsage(text, error));
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
        // 只保留尾部窗口：usage 永远在流末尾，长回答全量保留会白吃内存
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

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
}

function parseNativeUsage(text: string, error: string | null): { usage: TokenUsage; error: string | null } {
  let found: TokenUsage | null = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const usage = parsed.usage ?? (parsed.response as Record<string, unknown> | undefined)?.usage;
      const normalized = extractResponsesUsage(usage);
      if (normalized) {
        found = normalized;
        break;
      }
    } catch {
      /* 忽略无法解析的行 */
    }
  }
  return { usage: found ?? emptyUsage(true), error };
}

interface SettleContext {
  requestId: string;
  userId: number | null;
  keyId: number | null;
  channelId: number | null;
  model: string;
  upstreamModel: string;
  latencyMs: number;
  statusCode: number;
  stream: number;
  ip: string;
  ua: string;
  touchKey: boolean;
  modelRow: ModelRow;
  body: Record<string, unknown>;
  /** 转发前预扣的额度，结算时按差额多退少补 */
  reservedUsd: number;
}

async function settleUsage(
  env: Env,
  usagePromise: Promise<{ usage: TokenUsage; error: string | null }>,
  c: SettleContext,
): Promise<void> {
  let usage: TokenUsage;
  let error: string | null = null;
  try {
    const settled = await usagePromise;
    usage = settled.usage;
    error = settled.error;
  } catch (err) {
    usage = emptyUsage(true);
    error = err instanceof Error ? err.message : String(err);
  }

  // 上游未给出 prompt token（估算路径）时，用请求体粗估输入量，避免完全不计费。
  // 估算路径下缓存命中量恒为 0 —— 没有上游 usage 就无从得知命中情况。
  if (usage.estimated && usage.promptTokens === 0) {
    const promptTokens = estimateTokensFromBody(c.body);
    usage = {
      ...usage,
      promptTokens,
      totalTokens: usage.completionTokens + promptTokens,
      cachedTokens: 0,
    };
  }

  const cost = computeCost(c.modelRow, usage);

  const entry: UsageEntry = {
    requestId: c.requestId,
    userId: c.userId,
    keyId: c.keyId,
    channelId: c.channelId,
    model: c.model,
    upstreamModel: c.upstreamModel,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: cost,
    estimated: usage.estimated ? 1 : 0,
    latencyMs: c.latencyMs,
    statusCode: c.statusCode,
    stream: c.stream,
    error,
    ip: c.ip,
    ua: c.ua,
    touchKey: c.touchKey,
    reservedUsd: c.reservedUsd,
  };

  await recordUsage(env.DB, entry).catch(() => undefined);
}
