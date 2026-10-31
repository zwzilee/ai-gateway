/**
 * 下游 OpenAI 兼容 API。
 *
 * 采用「通用透传」策略：任意 POST /v1/<path> 都转发到上游同名端点，因此
 * /chat/completions、/completions、/embeddings、/audio/* 等无需逐个实现。
 * 仅在转发前做三件事：鉴权、模型白名单校验、用量结算。
 */

import { authenticate, reserveQuota } from '../lib/auth.js';
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
import { proxyRequest } from '../lib/upstream.js';
import type { Env, ModelRow, UsageEntry } from '../types.js';

/** 下游 API 的版本前缀。转发前需要剥掉，由 buildUpstreamUrl 按上游 base_url 决定是否补回 */
const DOWNSTREAM_PREFIX = '/v1';

/** 允许透传的端点白名单，避免把 /v1/files 之类意外代理出去 */
const ALLOWED_ENDPOINTS = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/moderations',
]);

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
    stream = body.stream === true ? 1 : 0;

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

    const outcome = await proxyRequest(env, {
      body,
      model,
      endpoint,
      stream: stream === 1,
      signal: request.signal,
    });

    channelId = outcome.channel.id;
    upstreamModel = outcome.upstreamModel;

    const requestId = crypto.randomUUID();
    const headers = new Headers(outcome.response.headers);
    headers.set('x-request-id', requestId);
    headers.set('x-gateway-channel', String(outcome.channel.id));
    if (outcome.attempts > 1) headers.set('x-gateway-attempts', String(outcome.attempts));

    // 用量在响应体读完后才能确定，因此放进 waitUntil，不阻塞响应返回
    ctx.waitUntil(
      settleUsage(env, outcome.usage, {
        requestId,
        userId,
        keyId,
        channelId,
        model,
        upstreamModel,
        latencyMs: Date.now() - started,
        statusCode: 200,
        stream,
        ip,
        ua,
        touchKey,
        modelRow,
        body,
        reservedUsd,
      }),
    );

    return new Response(outcome.response.body, {
      status: outcome.response.status,
      headers,
    });
  } catch (err) {
    const response = errorResponse(err);
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
