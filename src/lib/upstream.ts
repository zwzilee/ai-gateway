/**
 * 上游适配与渠道调度。
 *
 * 只实现 OpenAI 兼容协议（/chat/completions、/embeddings、/models）：绝大多数
 * 平台（OpenAI、DeepSeek、Groq、OpenRouter、硅基流动、Together、Moonshot 等）
 * 都提供该协议，因此一个适配器即可覆盖。
 *
 * 调度规则：
 *   * 候选 = 有该模型映射的渠道 ∪ 开启 allow_all_models 的渠道
 *   * 按 priority 降序分组，组内按 weight 加权随机
 *   * 命中 4xx 客户端错误直接回传；网络错误与 429/5xx/404 换下一个渠道重试
 *   * 连续失败 3 次进入指数退避熔断，避免持续打挂掉的渠道
 *
 * 超时语义：渠道的 timeout_ms 是「等待响应头」的上限，以及流式响应中「两次数据之间」
 * 的空闲上限，**不是**请求总时长 —— 上限卡总时长会把长流式输出拦腰截断（断流）。
 */

import {
  emptyUsage,
  estimateTokens,
  extractTextFromCompletion,
  extractUsage,
  newTally,
  tallyChars,
  tokensOfTally,
  type TokenUsage,
} from './billing.js';
import { encryptionKey } from './bootstrap.js';
import { decryptSecret } from './crypto.js';
import { all } from './db.js';
import { ApiError, clientClosed, upstreamError } from './errors.js';
import type { ChannelRow, Env } from '../types.js';

/**
 * 计费旁路保留的 SSE 文本上限（字符）。
 *
 * 只用于「上游没返回 usage」时的兜底估算，而 usage 块永远在流的末尾，因此超出后
 * 保留末尾即可。上限取 100 万字符 —— 单次回答的 token 上限换算过来也到不了这个量级。
 */
const MAX_RETAIN_CHARS = 1_000_000;

/** 从原始 SSE 文本里提取 content / reasoning_content 的值（估算兜底用） */
const CONTENT_RE = /"(?:reasoning_)?content":"((?:[^"\\]|\\.)*)"/g;

/**
 * 取出包含指定下标的 SSE 行负载（`data: ` 之后的部分）。
 *
 * 保留文本可能从中间截断，此时行首不再以 `data:` 开头，返回 null 由调用方兜底。
 */
function linePayloadAt(text: string, at: number): string | null {
  const start = text.lastIndexOf('\n', at) + 1;
  let end = text.indexOf('\n', at);
  if (end === -1) end = text.length;
  const line = text.slice(start, end).trim();
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  return payload === '' || payload === '[DONE]' ? null : payload;
}

/** 触发熔断所需连续失败次数 */
const BREAKER_THRESHOLD = 3;
const BREAKER_BASE_MS = 60_000;
const BREAKER_MAX_MS = 10 * 60_000;

export interface ChannelCandidate {
  channel: ChannelRow;
  upstreamModel: string;
}

// ---------------------------------------------------------------- 渠道选择

export async function selectChannels(env: Env, model: string): Promise<ChannelCandidate[]> {
  const now = Date.now();
  // 候选渠道在 SQL 里就筛掉：渠道多时（几十个上游）只有真正支持该模型的那几个会被读出来，
  // 而不是把整张 channels 表（含加密后的密钥串）全量取回 Worker 再过滤。
  const channels = await all<ChannelRow>(
    env.DB.prepare(
      `SELECT * FROM channels
        WHERE status = 'enabled'
          AND (cooldown_until = 0 OR cooldown_until <= ?)
          AND (allow_all_models = 1
               OR EXISTS (SELECT 1 FROM channel_models m
                           WHERE m.channel_id = channels.id AND m.model = ?))
        ORDER BY priority DESC, id ASC`,
    ).bind(now, model),
  );
  if (channels.length === 0) return [];

  const mappings = await all<{ channel_id: number; upstream_model: string }>(
    env.DB.prepare('SELECT channel_id, upstream_model FROM channel_models WHERE model = ?').bind(
      model,
    ),
  );
  const mapping = new Map<number, string>();
  for (const m of mappings) mapping.set(m.channel_id, m.upstream_model);

  const candidates: ChannelCandidate[] = [];
  for (const channel of channels) {
    const mapped = mapping.get(channel.id);
    if (mapped) {
      candidates.push({ channel, upstreamModel: mapped });
    } else if (channel.allow_all_models === 1) {
      // 未登记的模型名原样透传，便于临时接入新模型
      candidates.push({ channel, upstreamModel: model });
    }
  }

  const byPriority = new Map<number, ChannelCandidate[]>();
  for (const c of candidates) {
    const list = byPriority.get(c.channel.priority);
    if (list) list.push(c);
    else byPriority.set(c.channel.priority, [c]);
  }

  const ordered: ChannelCandidate[] = [];
  for (const priority of [...byPriority.keys()].sort((a, b) => b - a)) {
    ordered.push(...weightedShuffle(byPriority.get(priority) as ChannelCandidate[]));
  }
  return ordered;
}

/** 加权随机排序（不放回抽样），weight 越大越靠前 */
function weightedShuffle(items: ChannelCandidate[]): ChannelCandidate[] {
  const pool = items.map((c) => ({ c, w: Math.max(1, c.channel.weight) }));
  const out: ChannelCandidate[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((sum, p) => sum + p.w, 0);
    let pick = Math.random() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      pick -= (pool[i] as { w: number }).w;
      if (pick <= 0) {
        index = i;
        break;
      }
    }
    out.push((pool[index] as { c: ChannelCandidate }).c);
    pool.splice(index, 1);
  }
  return out;
}

// ---------------------------------------------------------------- URL 与请求构造

/**
 * 拼接上游 URL。
 *
 * base_url 若只填了主机（无路径），自动补 `/v1`——OpenAI、DeepSeek、硅基流动等
 * 均接受该形式；若已包含路径前缀（如 `https://api.groq.com/openai/v1`）则原样使用。
 */
export function buildUpstreamUrl(baseUrl: string, endpoint: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw upstreamError(`渠道 base_url 不是合法 URL: ${baseUrl}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path === '' ? `/v1${endpoint}` : `${path}${endpoint}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseExtraHeaders(raw: string): Record<string, string> {
  if (!raw || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 不应由用户配置转发的逐跳请求头。
 *
 * 这些头描述的是「这一段连接」而非请求本身，透传会破坏 fetch 自身构造的请求
 * （例如 content-length 与实际 body 不符、transfer-encoding 冲突）。
 */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** 由网关自行决定、不允许渠道配置覆盖的头 */
const RESERVED_HEADERS = new Set(['content-type', 'accept']);

/** 过滤渠道附加头：去掉逐跳头与网关保留头 */
function sanitizeExtraHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || RESERVED_HEADERS.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

async function buildUpstreamHeaders(
  channel: ChannelRow,
  env: Env,
): Promise<Record<string, string>> {
  let apiKey: string;
  try {
    apiKey = await decryptSecret(channel.api_key_enc, encryptionKey(env));
  } catch {
    throw upstreamError(`渠道「${channel.name}」的密钥无法解密，请重新保存该渠道的 API Key`);
  }

  // 附加头放在前面，因此无法覆盖 authorization —— 认证方式由渠道密钥决定。
  // 需要非 Bearer 认证的平台上，可通过附加头额外补充（如 Azure 的 api-key）。
  return {
    ...sanitizeExtraHeaders(parseExtraHeaders(channel.extra_headers)),
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

// ---------------------------------------------------------------- 渠道探测

export type ProbeReason =
  | 'ok'
  | 'no_models_endpoint'
  | 'auth_failed'
  | 'forbidden'
  | 'bad_status'
  | 'network_error';

export interface ProbeResult {
  ok: boolean;
  status: number;
  latency_ms: number;
  models: string[];
  /** 模型数超过上限被截断 */
  truncated: boolean;
  reason: ProbeReason;
  message: string;
  /** 针对常见 CDN / 网关错误码的排查提示（仅失败时给出） */
  hint?: string;
}

/**
 * 把 CDN / 网关的错误码翻译成人能看懂的排查方向。
 *
 * 525/526 这类错误**不是本网关的问题**：它们是上游 CDN 与上游源站之间的 TLS 握手失败，
 * 常见于国内中转站的「海外线路」——从国内直连正常，但从 Cloudflare（本网关所在网络）
 * 访问就会失败。把它讲清楚，省得用户反复怀疑自己的 Key 或地址填写。
 */
export function upstreamErrorHint(status: number): string | undefined {
  switch (status) {
    case 525:
    case 526:
      return '这是上游 CDN 与它自己源站之间的 TLS 握手失败，问题在上游侧，与本网关和你的 Key 无关。国内中转站常见于「海外线路未配好」：从国内直连正常、从 Cloudflare 访问就报 525。请联系上游修复回源证书，或换一个能直连的地址。';
    case 521:
    case 522:
    case 523:
    case 524:
      return '上游 CDN 连不上自己的源站或源站超时（52x），问题在上游侧，稍后重试或联系上游。';
    case 520:
      return '上游返回了未知错误（520），通常是其源站异常或返回了非标准响应。';
    case 502:
    case 503:
    case 504:
      return '上游暂时不可用，稍后重试；若持续失败请确认该平台是否在维护。';
    default:
      return undefined;
  }
}

/** 探测结果里最多返回的模型数，避免超大列表拖垮界面 */
const PROBE_MODEL_LIMIT = 1000;

/**
 * 探测上游：调用 /models 验证地址与密钥，并返回可用模型名。
 *
 * 用于「新增渠道」时的即时校验——地址或密钥写错会立刻反馈，
 * 而不是等到真正转发请求时才失败。
 */
export async function probeModels(
  baseUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  const started = Date.now();
  const base = { status: 0, latency_ms: 0, models: [] as string[], truncated: false };

  let url: string;
  try {
    url = buildUpstreamUrl(baseUrl, '/models');
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        ...sanitizeExtraHeaders(extraHeaders),
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'TimeoutError';
    return {
      ...base,
      latency_ms: Date.now() - started,
      ok: false,
      reason: 'network_error',
      message: aborted
        ? `连接超时（${timeoutMs}ms），请检查地址是否可达`
        : `网络错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const latency = Date.now() - started;
  const text = await res.text().catch(() => '');

  if (res.status === 401) {
    return {
      ...base,
      status: res.status,
      latency_ms: latency,
      ok: false,
      reason: 'auth_failed',
      message: '密钥被拒绝（401）：请确认 API Key 是否正确，以及与所选地域是否匹配',
    };
  }
  if (res.status === 403) {
    return {
      ...base,
      status: res.status,
      latency_ms: latency,
      ok: false,
      reason: 'forbidden',
      message: `访问被拒绝（403）：${text.slice(0, 200)}`,
    };
  }
  if (res.status === 404 || res.status === 405) {
    return {
      ...base,
      status: res.status,
      latency_ms: latency,
      ok: false,
      reason: 'no_models_endpoint',
      message: `该上游未提供 /v1/models 接口（HTTP ${res.status}）。地址与密钥可能正确，请手动填写模型映射。`,
    };
  }
  if (!res.ok) {
    return {
      ...base,
      status: res.status,
      latency_ms: latency,
      ok: false,
      reason: 'bad_status',
      message: `HTTP ${res.status}：${text.slice(0, 300)}`,
      hint: upstreamErrorHint(res.status),
    };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      ...base,
      status: res.status,
      latency_ms: latency,
      ok: false,
      reason: 'bad_status',
      message: '返回内容不是合法 JSON，请确认 Base URL 指向的是 OpenAI 兼容接口',
    };
  }

  // 兼容两种常见结构：{data:[{id}]} 与 {models:[{name}]}
  const rawList = Array.isArray(parsed.data)
    ? parsed.data
    : Array.isArray(parsed.models)
      ? parsed.models
      : [];

  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of rawList) {
    let id: unknown;
    if (typeof item === 'string') id = item;
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      id = o.id ?? o.name ?? o.model;
    }
    if (typeof id !== 'string') continue;
    const name = id.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    models.push(name);
  }
  models.sort((a, b) => a.localeCompare(b));
  const truncated = models.length > PROBE_MODEL_LIMIT;

  return {
    ok: true,
    status: res.status,
    latency_ms: latency,
    models: truncated ? models.slice(0, PROBE_MODEL_LIMIT) : models,
    truncated,
    reason: 'ok',
    message: models.length === 0 ? '连接正常，但上游未返回任何模型' : `连接正常，可用模型 ${models.length} 个`,
  };
}

// ---------------------------------------------------------------- 熔断与健康

function cooldownFor(failCount: number): number {
  const exponent = Math.max(0, failCount - BREAKER_THRESHOLD);
  return Math.min(BREAKER_BASE_MS * 2 ** exponent, BREAKER_MAX_MS);
}

/** 鉴权失效 / 欠费 / 账号被停用：换渠道，并冷却较长时间 */
export const AUTH_COOLDOWN_MS = 6 * 3600_000;
/** 按天配额耗尽：当天基本不会恢复，冷却同样要长，否则会反复撞墙 */
export const DAILY_QUOTA_COOLDOWN_MS = 6 * 3600_000;
/** 普通限流：冷却几分钟即可 */
export const RATE_LIMIT_COOLDOWN_MS = 2 * 60_000;

/** 渠道级故障的特征文案（跨平台，含中文平台） */
const AUTH_FAIL_RE =
  /api[_ -]?key.*(not valid|invalid)|invalid.*api[_ -]?key|unauthor|permission denied|authentication|arrearage|overdue|insufficient.*(balance|credit|fund|quota)|exceeded your current quota|account.*(suspend|disabled|not in good standing)|欠费|余额不足|已欠费|账户.*(停用|冻结|禁用|异常)|密钥.*(无效|错误|失效)/i;
/** 限流 / 配额类文案 */
const QUOTA_RE = /quota|rate.?limit|too many requests|resource.?exhausted|throttl|限流|频率|请求过快/i;
/** 按天（而非按分钟）的配额 */
const DAILY_QUOTA_RE = /per[\s-]?day|daily|\bRPD\b|requests? per day|每天|每日|按天|当天/i;

export type UpstreamVerdict =
  /** 渠道自身的问题：换下一个渠道，并按 cooldownMs 冷却 */
  | { action: 'failover'; cooldownMs: number; kind: string }
  /** 调用方的问题（参数错误等）：原样回传，换渠道也会失败 */
  | { action: 'return'; kind: string };

/**
 * 判定上游错误该「换渠道」还是「回传给调用方」。
 *
 * 关键区别：`400 参数非法`是调用方的问题，换渠道必然重复失败；而
 * `401/403/402、欠费、账号停用`是**渠道**的问题 —— 以前这类错误被原样回传给客户端，
 * 客户端看到自己网关返回 401，会以为是自己的下游 Key 错了，实际上那个渠道的上游 Key
 * 已经失效；多渠道路由时还会让一部分请求白白打在一个死渠道上。
 *
 * 响应体比状态码更权威：不少平台（DeepSeek、智谱等）用 400/402 表示「余额不足」。
 */
export function classifyUpstreamError(status: number, body: string): UpstreamVerdict {
  const text = (body || '').slice(0, 2000);

  if (AUTH_FAIL_RE.test(text)) {
    return { action: 'failover', cooldownMs: AUTH_COOLDOWN_MS, kind: 'channel_auth' };
  }
  if (status === 401 || status === 403 || status === 402) {
    return { action: 'failover', cooldownMs: AUTH_COOLDOWN_MS, kind: 'channel_auth' };
  }
  if (status === 429 || QUOTA_RE.test(text)) {
    const daily = DAILY_QUOTA_RE.test(text);
    return {
      action: 'failover',
      cooldownMs: daily ? DAILY_QUOTA_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS,
      kind: daily ? 'daily_quota' : 'rate_limit',
    };
  }
  // 模型不存在 / 超时 / 上游故障：换渠道，冷却交给指数退避
  if (status === 404 || status === 408 || status >= 500) {
    return { action: 'failover', cooldownMs: 0, kind: 'upstream' };
  }
  return { action: 'return', kind: 'caller' };
}

/**
 * 记一次渠道失败。
 *
 * `minCooldownMs` 用于「确定性的渠道故障」（鉴权失效、欠费、限流）：
 * 这类问题第一次出现就该把渠道临时摘掉，不能等连续失败 3 次。
 */
async function markChannelFailure(
  env: Env,
  channel: ChannelRow,
  error: string,
  minCooldownMs = 0,
): Promise<void> {
  const failCount = channel.fail_count + 1;
  const backoff = failCount >= BREAKER_THRESHOLD ? cooldownFor(failCount) : 0;
  const cooldownMs = Math.max(backoff, minCooldownMs);
  const cooldown = cooldownMs > 0 ? Date.now() + cooldownMs : 0;
  // 必须用 SQL 自增：并发失败时各自写回「读到的值 + 1」会互相覆盖，计数到不了熔断阈值。
  // 退避档位仍按读到的次数估算，并发下最多偏一档
  await env.DB.prepare(
    `UPDATE channels SET fail_count = fail_count + 1, cooldown_until = ?, last_error = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(cooldown, error.slice(0, 500), Date.now(), channel.id)
    .run()
    .catch(() => undefined);
}

async function markChannelSuccess(env: Env, channel: ChannelRow): Promise<void> {
  if (channel.fail_count === 0 && channel.cooldown_until === 0) return;
  await env.DB.prepare(
    `UPDATE channels SET fail_count = 0, cooldown_until = 0, last_ok_at = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(Date.now(), Date.now(), channel.id)
    .run()
    .catch(() => undefined);
}

// ---------------------------------------------------------------- 代理

export interface ProxyOptions {
  /** 已解析的请求体，model 字段会被改写为上游模型名 */
  body: Record<string, unknown>;
  /** 下游请求的模型名 */
  model: string;
  endpoint: string;
  stream: boolean;
  signal?: AbortSignal;
  /**
   * 上游端点解析器：返回实际要打的路径与对应的请求体。
   *
   * 用于「同一协议有两种打法的上游」（例如 /v1/responses 原生透传，或降级成
   * /chat/completions 再翻译）。返回 null 表示该渠道用不了这次请求 —— 常见的
   * 是上游没有 responses 端点（404），此时直接换下一个渠道，不被计成渠道故障。
   */
  route?: (ctx: RouteContext) => RouteTarget | null;
}

export interface RouteContext {
  channel: ChannelRow;
  /** 下游请求的模型名 */
  model: string;
  /** 该渠道映射到的上游模型名 */
  upstreamModel: string;
  endpoint: string;
  stream: boolean;
  body: Record<string, unknown>;
}

export interface RouteTarget {
  endpoint: string;
  body: Record<string, unknown>;
  /** 是否要求上游在流式响应里带 usage（chat 协议需要显式 stream_options） */
  injectUsage?: boolean;
  /** 上游没有该端点（404/405）时静默换渠道，不记渠道故障 */
  fallbackOnMissingEndpoint?: boolean;
}

export interface ProxyOutcome {
  response: Response;
  /** 响应体读取完毕后 resolve 的用量信息 */
  usage: Promise<{ usage: TokenUsage; error: string | null }>;
  channel: ChannelRow;
  upstreamModel: string;
  attempts: number;
  /** 实际打到的上游端点（翻译层据此判断要不要反向转换） */
  endpoint: string;
}

export async function proxyRequest(env: Env, opts: ProxyOptions): Promise<ProxyOutcome> {
  const candidates = await selectChannels(env, opts.model);
  if (candidates.length === 0) {
    throw upstreamError(`没有可用渠道支持模型「${opts.model}」，请检查渠道配置与模型映射`);
  }

  const errors: string[] = [];
  let attempts = 0;
  // 失败切换时同一份请求体不必反复序列化。键只取「端点 + 上游模型名 + 是否注入 usage」，
  // 其余字段都来自不可变的 opts.body
  const bodyCache = new Map<string, string>();

  for (const { channel, upstreamModel } of candidates) {
    // 客户端已经走了，没必要再试其他渠道
    if (opts.signal?.aborted) throw clientClosed();

    attempts++;
    try {
      const result = await attemptChannel(env, channel, upstreamModel, opts, bodyCache);
      if (result) {
        await markChannelSuccess(env, channel);
        return { ...result, channel, upstreamModel, attempts };
      }
      errors.push(`${channel.name}: 上游返回可重试错误`);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${channel.name}: ${message}`);
      await markChannelFailure(env, channel, message);
    }
  }

  throw upstreamError(
    `所有渠道均请求失败（尝试 ${attempts} 个渠道）：${errors.join('; ') || '未知错误'}`,
    502,
  );
}

async function attemptChannel(
  env: Env,
  channel: ChannelRow,
  upstreamModel: string,
  opts: ProxyOptions,
  bodyCache: Map<string, string>,
): Promise<Omit<ProxyOutcome, 'channel' | 'upstreamModel' | 'attempts'> | null> {
  // 端点与请求体由调用方（或路由解析器）决定：/v1/responses 在支持它的渠道上原样转发，
  // 在不支持的渠道上降级成 /v1/chat/completions 的请求体，响应由调用方再翻译回去。
  const target: RouteTarget | null = opts.route
    ? opts.route({
        channel,
        model: opts.model,
        upstreamModel,
        endpoint: opts.endpoint,
        stream: opts.stream,
        body: opts.body,
      })
    : { endpoint: opts.endpoint, body: opts.body };
  if (!target) return null;

  const url = buildUpstreamUrl(channel.base_url, target.endpoint);
  const headers = await buildUpstreamHeaders(channel, env);

  const injectUsage = (target.injectUsage ?? true) && opts.stream && channel.inject_usage === 1;
  const cacheKey = `${target.endpoint}\u0000${upstreamModel}\u0000${injectUsage ? 1 : 0}`;
  let payload = bodyCache.get(cacheKey);
  if (payload === undefined) {
    const body: Record<string, unknown> = { ...target.body, model: upstreamModel };
    if (injectUsage) {
      // OpenAI 系接口默认不在流式响应里返回 usage，需显式开启才能精确计费
      const existing = body.stream_options;
      body.stream_options =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { include_usage: true, ...(existing as Record<string, unknown>) }
          : { include_usage: true };
    }
    payload = JSON.stringify(body);
    // 只留少量条目：几个大请求体同时驻留就是十几 MB
    if (bodyCache.size >= 4) bodyCache.clear();
    bodyCache.set(cacheKey, payload);
  }

  // 超时只用于「等待响应头」。
  //
  // 这里以前直接用 AbortSignal.timeout(channel.timeout_ms) 绑在 fetch 上，而该信号
  // 覆盖整条响应体：流式输出只要总时长超过 timeout_ms 就会被拦腰截断。此时 HTTP 200
  // 早已发给客户端，客户端只看到半截 SSE（表现为「断流」），且不会留下任何记录。
  // 改成响应头到达即解除计时，长生成由流内的空闲看门狗判断（见 streamResponse）。
  const deadline = new AbortController();
  let timedOut = false;
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, channel.timeout_ms);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal,
    });
  } catch (err) {
    clearTimeout(deadlineTimer);
    // 客户端断开或上游超时，两者的处理完全不同
    if (opts.signal?.aborted) throw clientClosed();
    const message = err instanceof Error ? err.message : String(err);
    const reason = timedOut
      ? `等待响应头超时（${channel.timeout_ms}ms）`
      : `网络错误: ${message}`;
    await markChannelFailure(env, channel, reason);
    return null;
  }
  clearTimeout(deadlineTimer);

  /**
   * 非流式路径的兜底：响应头已经拿到，但读响应体同样可能挂死。
   *
   * 流式路径不能用它 —— 那里由 streamResponse 的空闲看门狗负责，
   * 限制总时长会把长生成拦腰截断。
   */
  async function withBodyDeadline<T>(fn: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => deadline.abort(), channel.timeout_ms);
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
    }
  }

  if (!upstream.ok) {
    const detail = await withBodyDeadline(() => safeText(upstream));
    const message = `HTTP ${upstream.status}: ${detail.slice(0, 300)}`;
    const verdict = classifyUpstreamError(upstream.status, detail);

    // 路由降级：上游根本没有这个端点（404/405）时，换下一个渠道，而不是把渠道
    // 判成故障冷却掉 —— 渠道本身没坏，只是不认这个协议。
    if (target.fallbackOnMissingEndpoint && (upstream.status === 404 || upstream.status === 405)) {
      return null;
    }

    if (verdict.action === 'failover') {
      // 渠道级故障（鉴权失效、欠费、限流、模型缺失、上游故障）：冷却并按需换下一个渠道
      await markChannelFailure(env, channel, message, verdict.cooldownMs);
      return null;
    }

    // 调用方的问题（参数非法等）直接回传，避免在多个渠道上重复触发同样的失败
    throw new ApiError(
      upstream.status,
      `上游渠道「${channel.name}」返回错误：${detail.slice(0, 500)}`,
      'invalid_request_error',
      'upstream_rejected',
    );
  }

  if (opts.stream) {
    // 空闲看门狗沿用渠道的 timeout_ms：含义从「总时长」变成「多久没有数据」
    return streamResponse(upstream, channel.timeout_ms, target.endpoint);
  }
  return withBodyDeadline(() => jsonResponse(upstream, opts.model, target.endpoint));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** 非流式：整体读入后提取 usage，并把 model 改回下游模型名 */
async function jsonResponse(
  upstream: Response,
  downstreamModel: string,
  endpoint: string,
): Promise<Omit<ProxyOutcome, 'channel' | 'upstreamModel' | 'attempts'>> {
  let raw: string;
  try {
    raw = await upstream.text();
  } catch (err) {
    throw upstreamError(`读取上游响应失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    // 上游返回了非 JSON（常见于网关错误页），原样透传并标记错误
    return {
      response: new Response(raw, {
        status: 200,
        headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' },
      }),
      usage: Promise.resolve({
        usage: emptyUsage(true),
        error: '上游返回非 JSON 响应',
      }),
      endpoint,
    };
  }

  const usage =
    extractUsage(parsed.usage) ??
    (() => {
      const text = extractTextFromCompletion(parsed);
      const completion = estimateTokens(text);
      return {
        promptTokens: 0,
        completionTokens: completion,
        totalTokens: completion,
        cachedTokens: 0,
        estimated: true,
      } satisfies TokenUsage;
    })();

  if ('model' in parsed) parsed.model = downstreamModel;

  return {
    response: Response.json(parsed, { status: 200 }),
    usage: Promise.resolve({ usage, error: null }),
    endpoint,
  };
}

/**
 * 流式：原样透传 SSE，同时旁路解析 usage / 累计文本用于计费。
 *
 * 三条出口都必须结算用量，否则会出现「流量确实发生了、后台却什么都没有」的黑洞：
 *   1. 上游正常读完        done   —— 结算后关闭
 *   2. 客户端中途断开      cancel —— 用已收到的内容结算
 *   3. 上游中断 / 空闲超时 error  —— 结算并把原因写进 usage_logs.error
 *
 * 第 3 条以前是漏洞：写端被 abort 时 TransformStream 既不调用 flush 也不调用 cancel，
 * usage 永不 resolve，于是断流在后台完全不可见、也不计费 —— 而那正是最需要排查的故障。
 *
 * idleMs 是「多久收不到任何数据就放弃」，不是流的总时长。Cloudflare 对 HTTP 请求的
 * 时长没有上限，1M 上下文的长生成可以跑几十分钟；但上游挂死时必须能回收连接，
 * 否则客户端会一直干等。计时只在真正等待上游数据（有未完成的 read）时进行，
 * 客户端读得慢造成的背压不会误判为上游无数据。
 */
function streamResponse(
  upstream: Response,
  idleMs: number,
  endpoint: string,
): Omit<ProxyOutcome, 'channel' | 'upstreamModel' | 'attempts'> {
  const collector = new SSEUsageCollector();
  let settled = false;
  let resolveUsage!: (v: { usage: TokenUsage; error: string | null }) => void;
  const usage = new Promise<{ usage: TokenUsage; error: string | null }>((resolve) => {
    resolveUsage = resolve;
  });

  /** 结算一次用量。三条出口都会调用，重复调用无副作用 */
  const settle = (reason: string | null): void => {
    if (settled) return;
    settled = true;
    // finalize() 会填充 collector.error，因此必须先取值再读 error
    const usage = collector.finalize();
    resolveUsage({ usage, error: reason ?? collector.error });
  };

  const body = upstream.body;
  if (!body) {
    settle('上游返回空响应体');
    return { response: new Response(null, { status: 200 }), usage, endpoint };
  }

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const armIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const reason = `上游 ${idleMs}ms 无数据，网关已中断本次流式响应`;
      settle(reason);
      const err = new Error(reason);
      try {
        controller?.error(err);
      } catch {
        /* 流已关闭或已出错，忽略 */
      }
      void reader.cancel(err).catch(() => undefined);
    }, idleMs);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },

    async pull(c) {
      armIdle();
      try {
        const { done, value } = await reader.read();
        clearIdle();
        // 空闲看门狗或客户端断开已经收尾：此时流已 error / cancel，不能再 close 或 enqueue
        if (settled) return;

        if (done) {
          try {
            collector.push(decoder.decode());
          } catch {
            /* 计费解析失败不应影响收尾 */
          }
          settle(null);
          c.close();
          return;
        }

        c.enqueue(value);
        try {
          collector.push(decoder.decode(value, { stream: true }));
        } catch {
          // 计费解析失败不应影响数据透传
        }
      } catch (err) {
        clearIdle();
        if (settled) return;
        settle(`上游流式响应中断: ${err instanceof Error ? err.message : String(err)}`);
        c.error(err);
      }
    },

    cancel(reason) {
      clearIdle();
      // 客户端中途断开：用已收到的内容结算，否则本次用量会完全丢失
      settle(
        `客户端提前断开（已收到 ${collector.receivedChars} 字符）: ${
          reason instanceof Error ? reason.message : String(reason ?? '')
        }`,
      );
      void reader.cancel(reason).catch(() => undefined);
    },
  });

  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') ?? 'text/event-stream');
  headers.set('cache-control', 'no-cache');
  // 阻止中间层缓冲，保证 SSE 实时性
  headers.set('x-accel-buffering', 'no');

  return { response: new Response(stream, { status: 200, headers }), usage, endpoint };
}

/**
 * 计费旁路。
 *
 * 以前是「每条 SSE 行都 JSON.parse」：实测 8000 个片段（约 1.5MB）要 6.2ms CPU，
 * 而 Workers 免费版每次调用只有 10ms —— 长回答会直接把预算吃光。现在只把解码后的
 * 文本留着，收尾时做「定位 + 解析一行」：usage 永远在流的末尾，只需要最后一次解析。
 * 同一负载实测降到 1.4ms（无 usage 的兜底路径 3.1ms）。
 *
 * 保留文本有上限：超出后只留末尾（usage 在末尾，丢前面是安全的），因此内存与 CPU
 * 都不随回答长度无界增长。
 */
class SSEUsageCollector {
  private text = '';
  error: string | null = null;
  /** 已接收字符数，用于客户端断开时记录进度 */
  receivedChars = 0;

  push(chunk: string): void {
    if (chunk === '') return;
    this.receivedChars += chunk.length;
    this.text += chunk;
    // 超长响应只保留末尾；这里按 2 倍阈值触发，摊还到每个字符仍是 O(1)
    if (this.text.length > MAX_RETAIN_CHARS * 2) {
      this.text = this.text.slice(-MAX_RETAIN_CHARS);
    }
  }

  /**
   * 收尾结算：优先取上游 usage（精确），取不到再按保留下来的文本估算。
   *
   * 注意顺序 —— 兜底估算与错误提取都在这里做，调用方读到 this.error 前必须先调它。
   */
  finalize(): TokenUsage {
    this.error = this.errorFromText();
    const usage = this.usageFromText();
    if (usage) return usage;
    return this.estimateFromText();
  }

  private usageFromText(): TokenUsage | null {
    const at = this.text.lastIndexOf('"usage"');
    if (at === -1) return null;
    const payload = linePayloadAt(this.text, at);
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      return extractUsage(parsed.usage);
    } catch {
      return null;
    }
  }

  private errorFromText(): string | null {
    const at = this.text.lastIndexOf('"error"');
    if (at === -1) return null;
    const payload = linePayloadAt(this.text, at);
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const err = parsed.error;
      if (typeof err !== 'object' || err === null) return null;
      const msg = (err as Record<string, unknown>).message;
      return typeof msg === 'string' ? msg : '上游返回错误对象';
    } catch {
      return null;
    }
  }

  /**
   * 兜底估算：统计 content / reasoning_content 里的字符。
   *
   * 用正则从原始 SSE 文本里抠值，而不是逐行 JSON.parse —— 转义序列按原样计长
   * （如 `\n` 记 2 个字符），对估算路径是完全可以接受的偏差，且这条路径本身只在
   * 上游不返回 usage 时才会走到。
   */
  private estimateFromText(): TokenUsage {
    const tally = newTally();
    CONTENT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CONTENT_RE.exec(this.text)) !== null) {
      tallyChars(match[1] as string, tally);
    }
    const completion = tokensOfTally(tally);
    return {
      promptTokens: 0,
      completionTokens: completion,
      totalTokens: completion,
      cachedTokens: 0,
      estimated: true,
    };
  }
}
