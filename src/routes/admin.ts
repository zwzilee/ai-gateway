/**
 * 管理 API。
 *
 * 全部挂在 /admin/api 下，除 /auth/login 与 /auth/me 外都要求有效管理会话。
 * 上游渠道的 API Key 只写不读：保存后接口仅返回掩码，明文永不回传。
 */

import { Hono } from 'hono';
import {
  clearLoginFailures,
  createSession,
  destroySession,
  isLoginBlocked,
  pruneLoginAttempts,
  pruneSessions,
  recordLoginFailure,
  requireAdmin,
  verifyAdminToken,
} from '../lib/adminAuth.js';
import {
  DEFAULT_SITE_NAME,
  assertEncryptionKeyUsable,
  checkSecrets,
  encryptionKey,
  getAdminTokenRotatedAt,
  markAdminTokenRotatedAt,
  reencryptChannels,
} from '../lib/bootstrap.js';
import { decryptSecret, encryptSecret, generateApiKey, sha256Hex } from '../lib/crypto.js';
import { all, first, getSetting, paginate, run, setSetting } from '../lib/db.js';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { DAY_MS } from '../lib/maintenance.js';
import { parseAllowedModels, validateAllowedModels } from '../lib/modelAccess.js';
import { probeModels } from '../lib/upstream.js';
import {
  fetchChannelBalance,
  refreshStaleBalances,
  saveChannelBalance,
} from '../lib/upstreamBalance.js';
import {
  asBool,
  asEnum,
  asId,
  asJsonObjectString,
  asModelMapping,
  asNumber,
  asOptionalString,
  asString,
} from '../lib/validate.js';
import type { ApiKeyRow, ChannelRow, Env, ModelRow, UserRow } from '../types.js';

export const adminApi = new Hono<{ Bindings: Env }>();

/** 与 index.ts 同源的构建期常量（wrangler define 注入），仅用于界面展示 */
const TEST_ENDPOINTS = ((): boolean => __TEST_ENDPOINTS__)();
/** 线上运行的版本指纹（deploy.mjs 注入 commit SHA，本地 dev 为 "dev"），用于确认线上是否最新 */
const BUILD_VERSION = ((): string => __BUILD_VERSION__)();

// 错误统一由 index.ts 的 app.onError 处理，这里不再重复注册

/**
 * usage_logs 的全部聚合口径。
 *
 * 合并维护会把多行明细折成一行汇总，那时「一行 = 一次请求」不再成立，条数改从 meta 还原。
 * 任何新写的用量统计都必须复用这两段，不要再写 COUNT(*)。
 * 带 p 的版本用于 JOIN 里的列别名；request_id IS NULL 那个分支是给 LEFT JOIN 补出的空行计 0。
 */
export const REQ_COUNT = (p = '') =>
  `SUM(CASE WHEN ${p}request_id IS NULL THEN 0
            WHEN ${p}meta IS NULL THEN 1
            ELSE json_extract(${p}meta, '$.requests') END)`;

export const ERR_COUNT = (p = '') =>
  `SUM(CASE WHEN ${p}meta IS NULL
            THEN (CASE WHEN ${p}status_code >= 400 OR ${p}error IS NOT NULL THEN 1 ELSE 0 END)
            ELSE json_extract(${p}meta, '$.errors') END)`;

/**
 * 管理界面的「天」一律按北京时间（UTC+8）分桶。
 *
 * 直接写 date(ts/1000,'unixepoch') 是 UTC 日，会让本地凌晨的流量落到前一天的柱子里，
 * 看起来像"今天的量没算进来"。存储层仍然是 UTC 毫秒时间戳（见下），只有取整口径偏移。
 */
export const TZ_OFFSET_MS = 8 * 3600_000;

/** 取 usage_logs.ts 所属的北京自然日。带 p 前缀以便 join 时区分表 */
export const DAY_EXPR = (p = '') => `date((${p}ts + ${TZ_OFFSET_MS}) / 1000, 'unixepoch')`;

// ---------------------------------------------------------------- 认证

/**
 * 站点名称。
 *
 * 不再有 SITE_NAME 变量：{@link DEFAULT_SITE_NAME} 是唯一的默认值，
 * 部署者在「设置」页改一次就存在 D1 的 settings 表里，跟着这个实例走。
 */
async function getSiteName(env: Env): Promise<string> {
  return (await getSetting(env.DB, 'site_name')) ?? DEFAULT_SITE_NAME;
}

adminApi.post('/auth/login', async (c) => {
  const env = c.env;
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';

  // 缺 Secret 时先给提示：这种情况下去比对令牌没有意义，也不该计入失败次数
  if (!env.ADMIN_TOKEN) {
    const status = await checkSecrets(env);
    throw new ApiError(
      status.state === 'no-db' ? 503 : 503,
      status.state === 'no-db'
        ? '数据库尚未初始化：请先执行 `wrangler d1 migrations apply DB --remote`'
        : 'ADMIN_TOKEN 未配置：请在 Cloudflare 控制台 Worker → Settings → Variables and Secrets 添加（类型选 Secret），保存后即可登录',
      'api_error',
      status.state === 'no-db' ? 'not_migrated' : 'secret_missing',
    );
  }

  if (await isLoginBlocked(env, ip)) {
    throw new ApiError(
      429,
      '登录失败次数过多，请 15 分钟后再试',
      'rate_limit_exceeded',
      'too_many_attempts',
    );
  }

  let token = '';
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    token = typeof body.token === 'string' ? body.token.trim() : '';
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
  if (token === '') throw badRequest('请输入管理令牌', 'token');

  if (!(await verifyAdminToken(env, token))) {
    await recordLoginFailure(env, ip);
    throw unauthorized('管理令牌不正确');
  }

  await clearLoginFailures(env, ip);
  const { cookie, expiresAt } = await createSession(env, c.req.raw);
  await Promise.all([pruneSessions(env), pruneLoginAttempts(env)]);

  c.header('set-cookie', cookie);
  return c.json({ ok: true, expires_at: expiresAt });
});

adminApi.post('/auth/logout', async (c) => {
  const cookie = await destroySession(c.env, c.req.raw);
  c.header('set-cookie', cookie);
  return c.json({ ok: true });
});

adminApi.get('/auth/me', async (c) => {
  await requireAdmin(c.req.raw, c.env);
  const secrets = await checkSecrets(c.env);
  return c.json({ ok: true, site_name: await getSiteName(c.env), secrets_state: secrets.state });
});

// 以下所有端点均需登录
adminApi.use('*', async (c, next) => {
  await requireAdmin(c.req.raw, c.env);
  await next();
});

// ---------------------------------------------------------------- 总览

/**
 * 总览页（原来「概览」+「用量」两个页签合并）的唯一数据源。
 *
 * 所有数字都由同一个 days 区间驱动，不再像过去那样页面上一半是 24 小时、
 * 一半是 7 天、图表又跟着自己的下拉框走。
 *
 * 区间合计不单独查一次：日汇总本身就是区间的分组，累加即可，少一次全表扫描。
 * 渠道的「健康状态」和「用量」也并成一次 LEFT JOIN —— 没流量的渠道照样带出来，
 * 否则刚熔断、刚加上的渠道会因为查不到用量而从列表里消失。
 *
 * 失败数的口径与 /usage/logs 的 status=error 保持一致：除 4xx/5xx 外，
 * 流式响应中途被截断（状态码 200 但写入了 error）也算失败。否则指标条显示
 * 「无失败」、切到「仅错误」却列出一堆，同一页自相矛盾。
 */
adminApi.get('/dashboard', async (c) => {
  const env = c.env;
  const now = Date.now();
  const days = asNumber(c.req.query('days'), 'days', { min: 1, max: 90, fallback: 7 });

  // 日期口径统一为北京时间（UTC+8）的自然日，与 DAY_EXPR 一致。
  // 「近 N 天」严格等于 N 个自然日：从今天（北京 0 点）往前推 N-1 天作为查询起点，
  // 这样 SQL 查询、趋势图补齐、以及 totals 的区间口径三者完全对齐，不会多出或少出一天。
  const beijingDay = (ts: number): string => {
    const d = new Date(ts + TZ_OFFSET_MS);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  };
  // 北京某一天的 00:00 对应的 UTC 毫秒时间戳
  const dayStart = (day: string): number => {
    const [y, m, dd] = day.split('-').map(Number);
    return Date.UTC(y as number, (m as number) - 1, dd as number) - TZ_OFFSET_MS;
  };
  const since = dayStart(beijingDay(now)) - (days - 1) * DAY_MS;

  // 概览只碰数据库两次：一次扫用量（按 天 × 模型 × 渠道 × 用户 分组），一次读配置（4 个计数 + 渠道列表）。
  // 四张卡片的分解全在下面用 JS 卷出来，不再各查一遍 —— 原先「按渠道」那条还额外把整个区间扫了一遍。
  const [usageRows, config] = await Promise.all([
    all<{
      day: string;
      model: string;
      channel_id: number | null;
      user_id: number | null;
      user_name: string | null;
      requests: number;
      errors: number;
      tokens: number;
      cost: number;
      prompt_tokens: number;
      cached_tokens: number;
    }>(
      env.DB.prepare(
        `SELECT ${DAY_EXPR('l.')} AS day,
                COALESCE(l.model, '-') AS model,
                l.channel_id AS channel_id, u.name AS user_name,
                ${REQ_COUNT('l.')} AS requests,
                ${ERR_COUNT('l.')} AS errors,
                COALESCE(SUM(l.total_tokens), 0) AS tokens,
                COALESCE(SUM(l.cost_usd), 0) AS cost,
                COALESCE(SUM(l.prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(l.cached_tokens), 0) AS cached_tokens
           FROM usage_logs l
           LEFT JOIN users u ON u.id = l.user_id
          WHERE l.ts >= ?
          GROUP BY day, model, l.channel_id, l.user_id, u.name
          ORDER BY day ASC`,
      ).bind(since),
    ),
    // 计数用标量子查询、渠道列表用 json_group_array：这条永远返回 1 行，
    // 哪怕库里一条渠道都没有，也不用处理「没有行 → 计数丢掉」的边界
    first<{ users: number; keys: number; channels: number; models: number; channel_list: string | null }>(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM api_keys) AS keys,
           (SELECT COUNT(*) FROM channels) AS channels,
           (SELECT COUNT(*) FROM models) AS models,
           (SELECT json_group_array(json_object(
                     'id', id, 'name', name, 'status', status,
                     'cooldown_until', cooldown_until, 'fail_count', fail_count,
                     'priority', priority))
              FROM channels) AS channel_list`,
      ),
    ),
  ]);

  interface Agg {
    requests: number;
    errors: number;
    tokens: number;
    cost: number;
    prompt_tokens: number;
    cached_tokens: number;
  }
  const zero = (): Agg => ({ requests: 0, errors: 0, tokens: 0, cost: 0, prompt_tokens: 0, cached_tokens: 0 });
  const add = (a: Agg, r: Agg): void => {
    a.requests += r.requests;
    a.errors += r.errors;
    a.tokens += r.tokens;
    a.cost += r.cost;
    a.prompt_tokens += r.prompt_tokens;
    a.cached_tokens += r.cached_tokens;
  };

  const dayMap = new Map<string, Agg & { day: string; models: Record<string, number>; modelTokens: Record<string, number> }>();
  const modelMap = new Map<string, Agg & { model: string }>();
  const channelMap = new Map<number, Agg>();
  const userMap = new Map<string, Agg & { user: string }>();

  for (const r of usageRows) {
    let d = dayMap.get(r.day);
    if (!d) {
      d = { day: r.day, models: {}, modelTokens: {}, ...zero() };
      dayMap.set(r.day, d);
    }
    add(d, r);
    // 两张趋势图都要按模型分段堆叠：一张用请求数、一张用 token 数，所以每天各带一份
    d.models[r.model] = (d.models[r.model] ?? 0) + r.requests;
    d.modelTokens[r.model] = (d.modelTokens[r.model] ?? 0) + r.tokens;

    let m = modelMap.get(r.model);
    if (!m) {
      m = { model: r.model, ...zero() };
      modelMap.set(r.model, m);
    }
    add(m, r);

    if (r.channel_id != null) {
      let c = channelMap.get(r.channel_id);
      if (!c) {
        c = zero();
        channelMap.set(r.channel_id, c);
      }
      add(c, r);
    }

    const userName = r.user_name ?? '未知';
    let u = userMap.get(userName);
    if (!u) {
      u = { user: userName, ...zero() };
      userMap.set(userName, u);
    }
    add(u, r);
  }

  const daily = [...dayMap.values()];

  // 补齐区间内的每一天：趋势图要铺满整个查询区间，没流量的那天也要显示出来（值为 0），
  // 否则只看得到「有数据的那几天」，中间的空白日会凭空消失。
  // 遍历范围与 since 对齐（beijingDay(since) → beijingDay(now)），正好 days 个自然日。
  const seenDays = new Set(daily.map((d) => d.day));
  for (let ts = dayStart(beijingDay(since)); ts <= dayStart(beijingDay(now)); ts += DAY_MS) {
    const day = beijingDay(ts);
    if (!seenDays.has(day)) {
      daily.push({ day, models: {}, modelTokens: {}, ...zero() });
    }
  }
  daily.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const byModel = [...modelMap.values()].sort((a, b) => b.requests - a.requests).slice(0, 10);
  const byUser = [...userMap.values()].sort((a, b) => b.requests - a.requests).slice(0, 10);

  interface ChannelInfo {
    id: number;
    name: string;
    status: string;
    cooldown_until: number;
    fail_count: number;
    priority: number;
  }
  let channelList: ChannelInfo[] = [];
  try {
    channelList = JSON.parse(config?.channel_list ?? '[]') as ChannelInfo[];
  } catch {
    channelList = [];
  }
  // 没流量的渠道也要留在列表里：否则刚加上的、刚熔断的渠道会从分布里凭空消失
  const byChannel = channelList
    .map((ch) => ({ ...ch, ...(channelMap.get(ch.id) ?? zero()) }))
    .sort((a, b) => b.requests - a.requests || b.priority - a.priority || a.id - b.id);

  const totals = {
    users: config?.users ?? 0,
    keys: config?.keys ?? 0,
    channels: config?.channels ?? 0,
    models: config?.models ?? 0,
  };

  // 区间合计 = 日汇总的累加
  const range = daily.reduce(
    (s, d) => ({
      requests: s.requests + d.requests,
      errors: s.errors + d.errors,
      tokens: s.tokens + d.tokens,
      cost: s.cost + d.cost,
      prompt_tokens: s.prompt_tokens + d.prompt_tokens,
      cached_tokens: s.cached_tokens + d.cached_tokens,
    }),
    { requests: 0, errors: 0, tokens: 0, cost: 0, prompt_tokens: 0, cached_tokens: 0 },
  );

  // 缓存命中率：命中输入 token / 全部输入 token
  const withRate = <T extends { prompt_tokens: number; cached_tokens: number }>(rows: T[]) =>
    rows.map((r) => ({ ...r, cache_hit_rate: r.prompt_tokens > 0 ? r.cached_tokens / r.prompt_tokens : 0 }));

  // 渠道健康度直接在这里算好：前端只负责展示，不用再各自判断一遍熔断条件
  const health = { ok: 0, cooling: 0, disabled: 0 };
  for (const ch of byChannel) {
    if (ch.status !== 'enabled') health.disabled++;
    else if (ch.cooldown_until > now) health.cooling++;
    else health.ok++;
  }

  return c.json({
    days,
    totals: totals ?? { users: 0, keys: 0, channels: 0, models: 0 },
    range: {
      ...range,
      error_rate: range.requests > 0 ? range.errors / range.requests : 0,
      cache_hit_rate: range.prompt_tokens > 0 ? range.cached_tokens / range.prompt_tokens : 0,
    },
    health,
    daily: withRate(daily),
    by_model: withRate(byModel),
    by_channel: withRate(byChannel),
    by_user: withRate(byUser),
  });
});

// ---------------------------------------------------------------- 渠道

interface ChannelInput {
  name: string;
  base_url: string;
  api_key: string | null;
  status: 'enabled' | 'disabled';
  priority: number;
  weight: number;
  allow_all_models: number;
  /** 1 = 放行指向公网地址的明文 http（自建上游拿不到证书时使用） */
  allow_insecure_http: number;
  timeout_ms: number;
  extra_headers: string;
  inject_usage: number;
  models: Record<string, string>;
  /** 保存时把映射里尚未登记的下游模型自动写入 models 表（单价先为 0） */
  register_models: number;
}

/**
 * 校验上游地址。
 *
 * 远端必须使用 https，否则上游 API Key 会以明文经过公网。
 * 两类例外：
 *   * 回环与私有网段允许 http，用于自建上游（Ollama、one-api、局域网网关）；
 *   * 渠道显式勾选「允许明文 HTTP」后，公网 http 也放行 —— 自建上游拿不到
 *     证书时（域名未备案、只能走公网 IP）只能这么接，风险由操作者确认。
 */
function assertUpstreamUrl(baseUrl: string, allowInsecure = false): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw badRequest('base_url 不是合法 URL', 'base_url');
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && (isPrivateHost(parsed.hostname) || allowInsecure)) return;
  throw badRequest(
    'base_url 必须使用 https；仅回环与私有网段（localhost、127.0.0.1、10.x、192.168.x、172.16-31.x）允许使用 http。' +
      '若要连接公网 http 地址，请勾选「允许明文 HTTP」',
    'base_url',
  );
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

async function parseChannelInput(body: Record<string, unknown>): Promise<ChannelInput> {
  const baseUrl = asString(body.base_url, 'base_url', { max: 500 });
  const allowInsecureHttp = asBool(body.allow_insecure_http, false);
  assertUpstreamUrl(baseUrl, allowInsecureHttp);

  return {
    name: asString(body.name, 'name', { max: 100 }),
    base_url: baseUrl,
    api_key: asOptionalString(body.api_key, 'api_key', 500),
    status: asEnum(body.status, 'status', ['enabled', 'disabled'] as const, 'enabled'),
    priority: asNumber(body.priority, 'priority', { min: -1000, max: 1000, fallback: 0 }),
    weight: asNumber(body.weight, 'weight', { min: 1, max: 1000, fallback: 1 }),
    allow_all_models: asBool(body.allow_all_models, false) ? 1 : 0,
    allow_insecure_http: allowInsecureHttp ? 1 : 0,
    timeout_ms: asNumber(body.timeout_ms, 'timeout_ms', { min: 1000, max: 600_000, fallback: 120_000 }),
    extra_headers: asJsonObjectString(body.extra_headers, 'extra_headers'),
    inject_usage: asBool(body.inject_usage, true) ? 1 : 0,
    models: asModelMapping(body.models),
    register_models: asBool(body.register_models, false) ? 1 : 0,
  };
}

/**
 * 自动登记下游模型。
 *
 * 新增渠道时通常一次选中多个模型，逐个去「模型与定价」页手工登记很繁琐。
 * 这里把映射里尚不存在的下游模型名补进 models 表，单价留 0（不产生费用），
 * 之后可在模型页调整。返回实际新建的模型名。
 */
async function registerMissingModels(
  env: Env,
  mapping: Record<string, string>,
): Promise<string[]> {
  const names = Object.keys(mapping);
  if (names.length === 0) return [];

  const placeholders = names.map(() => '?').join(',');
  const existing = await all<{ id: string }>(
    env.DB.prepare(`SELECT id FROM models WHERE id IN (${placeholders})`).bind(...names),
  );
  const known = new Set(existing.map((r) => r.id));
  const missing = names.filter((n) => !known.has(n));
  if (missing.length === 0) return [];

  const now = Date.now();
  const stmts = missing.map((id) =>
    env.DB.prepare(
      `INSERT INTO models (id, display_name, description, enabled, prompt_price, completion_price, created_at, updated_at)
       VALUES (?,?,'',1,0,0,?,?)`,
    ).bind(id, id, now, now),
  );
  await env.DB.batch(stmts);
  return missing;
}

// ---------------------------------------------------------------- 渠道探测

/**
 * 保存前探测上游。
 *
 * 让「新增渠道」能在填完地址与密钥后立刻校验：地址写错、密钥无效、
 * 或该平台不提供 /models 都会得到明确反馈，而不是等真实转发时才暴露。
 */
adminApi.post('/channels/probe', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const baseUrl = asString(body.base_url, 'base_url', { max: 500 });
  assertUpstreamUrl(baseUrl, asBool(body.allow_insecure_http, false));

  const apiKey = asString(body.api_key, 'api_key', { max: 500 });
  const extraRaw = asJsonObjectString(body.extra_headers, 'extra_headers');
  const extra = JSON.parse(extraRaw) as Record<string, string>;

  const result = await probeModels(baseUrl, apiKey, extra);
  return c.json(result);
});

adminApi.get('/channels', async (c) => {
  const rows = await all<ChannelRow>(
    c.env.DB.prepare('SELECT * FROM channels ORDER BY priority DESC, id ASC'),
  );
  const mappings = await all<{ channel_id: number; model: string; upstream_model: string }>(
    c.env.DB.prepare('SELECT channel_id, model, upstream_model FROM channel_models'),
  );
  const byChannel = new Map<number, Record<string, string>>();
  for (const m of mappings) {
    const map = byChannel.get(m.channel_id) ?? {};
    map[m.model] = m.upstream_model;
    byChannel.set(m.channel_id, map);
  }

  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      base_url: row.base_url,
      // 只回传掩码，明文不可读
      api_key_masked: maskKey(row.api_key_enc),
      status: row.status,
      priority: row.priority,
      weight: row.weight,
      allow_all_models: row.allow_all_models === 1,
      allow_insecure_http: row.allow_insecure_http === 1,
      timeout_ms: row.timeout_ms,
      extra_headers: row.extra_headers,
      inject_usage: row.inject_usage === 1,
      cooldown_until: row.cooldown_until,
      fail_count: row.fail_count,
      last_error: row.last_error,
      last_ok_at: row.last_ok_at,
      balance_amount: row.balance_amount ?? null,
      balance_currency: row.balance_currency ?? null,
      balance_checked_at: row.balance_checked_at ?? null,
      balance_error: row.balance_error ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      models: byChannel.get(row.id) ?? {},
    })),
  });
});

/** 上游密钥密文不便于展示，这里统一返回固定掩码 */
function maskKey(_encrypted: string): string {
  return '••••••••（已加密保存）';
}

adminApi.post('/channels', async (c) => {
  const env = c.env;
  const body = (await c.req.json()) as Record<string, unknown>;
  const input = await parseChannelInput(body);
  if (!input.api_key) throw badRequest('新建渠道时必须提供 api_key', 'api_key');

  const now = Date.now();
  const enc = await encryptSecret(input.api_key, encryptionKey(env));

  const result = await env.DB.prepare(
    `INSERT INTO channels
       (name, base_url, api_key_enc, status, priority, weight, allow_all_models, allow_insecure_http,
        timeout_ms, extra_headers, inject_usage, cooldown_until, fail_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`,
  )
    .bind(
      input.name,
      input.base_url,
      enc,
      input.status,
      input.priority,
      input.weight,
      input.allow_all_models,
      input.allow_insecure_http,
      input.timeout_ms,
      input.extra_headers,
      input.inject_usage,
      now,
      now,
    )
    .run();

  const channelId = Number(result.meta.last_row_id);
  await replaceChannelModels(env, channelId, input.models);
  const registered =
    input.register_models === 1 ? await registerMissingModels(env, input.models) : [];
  return c.json({ ok: true, id: channelId, registered_models: registered }, 201);
});

adminApi.put('/channels/:id', async (c) => {
  const env = c.env;
  const id = asId(c.req.param('id'));
  const existing = await first<ChannelRow>(env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id));
  if (!existing) throw notFound('渠道不存在');

  const body = (await c.req.json()) as Record<string, unknown>;
  const input = await parseChannelInput(body);

  // api_key 留空表示沿用原值，避免编辑时必须重新粘贴密钥
  const enc = input.api_key
    ? await encryptSecret(input.api_key, encryptionKey(env))
    : existing.api_key_enc;

  await env.DB.prepare(
    `UPDATE channels SET name = ?, base_url = ?, api_key_enc = ?, status = ?, priority = ?,
            weight = ?, allow_all_models = ?, allow_insecure_http = ?, timeout_ms = ?, extra_headers = ?, inject_usage = ?,
            fail_count = 0, cooldown_until = 0, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      input.name,
      input.base_url,
      enc,
      input.status,
      input.priority,
      input.weight,
      input.allow_all_models,
      input.allow_insecure_http,
      input.timeout_ms,
      input.extra_headers,
      input.inject_usage,
      Date.now(),
      id,
    )
    .run();

  await replaceChannelModels(env, id, input.models);
  const registered =
    input.register_models === 1 ? await registerMissingModels(env, input.models) : [];
  return c.json({ ok: true, registered_models: registered });
});

adminApi.post('/channels/:id/status', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const status = asEnum(body.status, 'status', ['enabled', 'disabled'] as const);
  await run(
    c.env.DB.prepare('UPDATE channels SET status = ?, updated_at = ? WHERE id = ?').bind(
      status,
      Date.now(),
      asId(c.req.param('id')),
    ),
  );
  return c.json({ ok: true, status });
});

adminApi.delete('/channels/:id', async (c) => {
  const env = c.env;
  const id = asId(c.req.param('id'));
  const existing = await first<{ id: number }>(
    env.DB.prepare('SELECT id FROM channels WHERE id = ?').bind(id),
  );
  if (!existing) throw notFound('渠道不存在');

  await env.DB.batch([
    env.DB.prepare('DELETE FROM channel_models WHERE channel_id = ?').bind(id),
    env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

/** 手动解除熔断，便于运维在渠道恢复后立即启用 */
adminApi.post('/channels/:id/reset', async (c) => {
  const id = asId(c.req.param('id'));
  await run(
    c.env.DB.prepare(
      'UPDATE channels SET fail_count = 0, cooldown_until = 0, last_error = NULL, updated_at = ? WHERE id = ?',
    ).bind(Date.now(), id),
  );
  return c.json({ ok: true });
});

/**
 * 批量刷新渠道余额。
 *
 * 按「最久未查」轮转，单次有上限：每个渠道最多试 3 个候选地址，而免费版每次调用的
 * 子请求上限是 50，渠道多时必须分批，不能一次全刷。
 */
adminApi.post('/channels/balances/refresh', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const limit = asNumber(body.limit, 'limit', { min: 1, max: 10, fallback: 5 });
  const results = await refreshStaleBalances(c.env, limit, 0, true);
  return c.json({ ok: true, checked: results.length, results });
});

/** 查询并保存单个渠道的余额（仅用于展示，不参与路由） */
adminApi.post('/channels/:id/balance', async (c) => {
  const env = c.env;
  const id = asId(c.req.param('id'));
  const channel = await first<ChannelRow>(env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id));
  if (!channel) throw notFound('渠道不存在');

  const result = await fetchChannelBalance(channel, env);
  await saveChannelBalance(env, id, result);
  return c.json(result);
});

/** 真实调用上游 /models 验证连通性，结果不落库（复用保存前的探测逻辑） */
adminApi.post('/channels/:id/test', async (c) => {
  const env = c.env;
  const id = asId(c.req.param('id'));
  const channel = await first<ChannelRow>(env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id));
  if (!channel) throw notFound('渠道不存在');

  let apiKey: string;
  try {
    apiKey = await decryptSecret(channel.api_key_enc, encryptionKey(env));
  } catch {
    return c.json({
      ok: false,
      status: 0,
      latency_ms: 0,
      models: [],
      truncated: false,
      reason: 'network_error',
      message: '渠道密钥无法解密，请重新保存该渠道的 API Key',
    });
  }

  let extra: Record<string, string> = {};
  try {
    extra = JSON.parse(channel.extra_headers) as Record<string, string>;
  } catch {
    extra = {};
  }

  const result = await probeModels(
    channel.base_url,
    apiKey,
    extra,
    Math.min(channel.timeout_ms, 30_000),
  );
  return c.json(result);
});

async function replaceChannelModels(env: Env, channelId: number, models: Record<string, string>): Promise<void> {
  const stmts = [env.DB.prepare('DELETE FROM channel_models WHERE channel_id = ?').bind(channelId)];
  for (const [model, upstream] of Object.entries(models)) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO channel_models (channel_id, model, upstream_model) VALUES (?,?,?)',
      ).bind(channelId, model, upstream),
    );
  }
  await env.DB.batch(stmts);
}

// ---------------------------------------------------------------- 模型

/**
 * 解析「可空数字」字段。
 *
 * 用于 cache_hit_price 这类语义上允许「未设置」的字段：
 * undefined / null / 空串 → null（表示不区分缓存），其余走正常数字校验。
 */
function asNullableNumber(value: unknown, field: string, max = 100_000): number | null {
  if (value === undefined || value === null || value === '') return null;
  return asNumber(value, field, { min: 0, max });
}

adminApi.get('/models', async (c) => {
  const rows = await all<ModelRow>(c.env.DB.prepare('SELECT * FROM models ORDER BY id ASC'));
  const stats = await all<{
    model: string;
    requests: number;
    prompt_tokens: number;
    cached_tokens: number;
  }>(
    c.env.DB.prepare(
      `SELECT model, ${REQ_COUNT()} AS requests,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(cached_tokens), 0) AS cached_tokens
         FROM usage_logs WHERE ts >= ? GROUP BY model`,
    ).bind(Date.now() - 7 * 24 * 3600_000),
  );
  const statMap = new Map(stats.map((s) => [s.model, s]));

  return c.json({
    items: rows.map((r) => {
      const s = statMap.get(r.id);
      const promptTokens = s?.prompt_tokens ?? 0;
      const cachedTokens = s?.cached_tokens ?? 0;
      return {
        id: r.id,
        display_name: r.display_name,
        description: r.description,
        enabled: r.enabled === 1,
        prompt_price: r.prompt_price,
        completion_price: r.completion_price,
        // null 表示未单独设置缓存价，命中部分按 prompt_price 计
        cache_hit_price: r.cache_hit_price ?? null,
        requests_7d: s?.requests ?? 0,
        prompt_tokens_7d: promptTokens,
        cached_tokens_7d: cachedTokens,
        cache_hit_rate_7d: promptTokens > 0 ? cachedTokens / promptTokens : 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    }),
  });
});

adminApi.post('/models', async (c) => {
  const env = c.env;
  const body = (await c.req.json()) as Record<string, unknown>;
  const id = asString(body.id, 'id', { max: 200 });
  const now = Date.now();

  const exists = await first<{ id: string }>(env.DB.prepare('SELECT id FROM models WHERE id = ?').bind(id));
  if (exists) throw conflict(`模型「${id}」已存在`);

  await env.DB.prepare(
    `INSERT INTO models
       (id, display_name, description, enabled, prompt_price, completion_price, cache_hit_price, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      asOptionalString(body.display_name, 'display_name', 200) ?? id,
      asOptionalString(body.description, 'description', 1000) ?? '',
      asBool(body.enabled, true) ? 1 : 0,
      asNumber(body.prompt_price, 'prompt_price', { min: 0, max: 100_000, fallback: 0 }),
      asNumber(body.completion_price, 'completion_price', { min: 0, max: 100_000, fallback: 0 }),
      asNullableNumber(body.cache_hit_price, 'cache_hit_price'),
      now,
      now,
    )
    .run();

  return c.json({ ok: true, id }, 201);
});

adminApi.put('/models/:id', async (c) => {
  const env = c.env;
  const id = c.req.param('id');
  const existing = await first<ModelRow>(env.DB.prepare('SELECT * FROM models WHERE id = ?').bind(id));
  if (!existing) throw notFound('模型不存在');

  const body = (await c.req.json()) as Record<string, unknown>;
  await env.DB.prepare(
    `UPDATE models SET display_name = ?, description = ?, enabled = ?,
            prompt_price = ?, completion_price = ?, cache_hit_price = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      asOptionalString(body.display_name, 'display_name', 200) ?? existing.display_name,
      asOptionalString(body.description, 'description', 1000) ?? existing.description,
      body.enabled === undefined ? existing.enabled : asBool(body.enabled, true) ? 1 : 0,
      asNumber(body.prompt_price, 'prompt_price', { min: 0, max: 100_000, fallback: existing.prompt_price }),
      asNumber(body.completion_price, 'completion_price', {
        min: 0,
        max: 100_000,
        fallback: existing.completion_price,
      }),
      // 显式传 null / '' 表示清除缓存价，回到「不区分缓存」
      body.cache_hit_price === undefined
        ? (existing.cache_hit_price ?? null)
        : asNullableNumber(body.cache_hit_price, 'cache_hit_price'),
      Date.now(),
      id,
    )
    .run();

  return c.json({ ok: true });
});

adminApi.post('/models/status', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  // 全表级操作，必须显式给布尔值：asBool 在拿到垃圾值时按 fallback 返回 true，
  // 一个手滑的空 body 就会把全部模型启用
  if (typeof body.enabled !== 'boolean') throw badRequest('字段 enabled 必须是布尔值', 'enabled');
  const enabled = body.enabled ? 1 : 0;
  const res = await run(
    c.env.DB.prepare('UPDATE models SET enabled = ?, updated_at = ?').bind(enabled, Date.now()),
  );
  return c.json({ ok: true, enabled, count: res.meta?.changes ?? 0 });
});

adminApi.post('/models/:id/status', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') throw badRequest('字段 enabled 必须是布尔值', 'enabled');
  const enabled = body.enabled ? 1 : 0;
  await run(
    c.env.DB.prepare('UPDATE models SET enabled = ?, updated_at = ? WHERE id = ?').bind(
      enabled,
      Date.now(),
      c.req.param('id'),
    ),
  );
  return c.json({ ok: true, enabled });
});

adminApi.delete('/models/:id', async (c) => {
  const env = c.env;
  const id = c.req.param('id');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM channel_models WHERE model = ?').bind(id),
    env.DB.prepare('DELETE FROM models WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- 用户

adminApi.get('/users', async (c) => {
  const limit = asNumber(c.req.query('limit'), 'limit', { min: 1, max: 200, fallback: 50 });
  const offset = asNumber(c.req.query('offset'), 'offset', { min: 0, fallback: 0 });
  const q = asOptionalString(c.req.query('q'), 'q', 100);

  const where = q ? '(name LIKE ? OR email LIKE ?)' : undefined;
  const params = q ? [`%${q}%`, `%${q}%`] : [];

  const { items, total } = await paginate<UserRow>(c.env.DB, {
    select: '*',
    from: 'users',
    where,
    params,
    orderBy: 'id DESC',
    limit,
    offset,
  });

  const counts = await all<{ user_id: number; n: number }>(
    c.env.DB.prepare('SELECT user_id, COUNT(*) AS n FROM api_keys GROUP BY user_id'),
  );
  const keyCount = new Map(counts.map((x) => [x.user_id, x.n]));

  return c.json({
    items: items.map((u) => ({ ...u, key_count: keyCount.get(u.id) ?? 0 })),
    total,
  });
});

adminApi.post('/users', async (c) => {
  const env = c.env;
  const body = (await c.req.json()) as Record<string, unknown>;
  const now = Date.now();

  const result = await env.DB.prepare(
    `INSERT INTO users (name, email, note, status, quota_usd, used_usd, rpm_limit, created_at, updated_at)
     VALUES (?,?,?,?,?,0,?,?,?)`,
  )
    .bind(
      asString(body.name, 'name', { max: 100 }),
      asOptionalString(body.email, 'email', 200),
      asOptionalString(body.note, 'note', 1000),
      asEnum(body.status, 'status', ['active', 'disabled'] as const, 'active'),
      asNumber(body.quota_usd, 'quota_usd', { min: 0, max: 1e7, fallback: 0 }),
      asNumber(body.rpm_limit, 'rpm_limit', { min: 0, max: 100_000, fallback: 0 }),
      now,
      now,
    )
    .run();

  return c.json({ ok: true, id: Number(result.meta.last_row_id) }, 201);
});

adminApi.put('/users/:id', async (c) => {
  const env = c.env;
  const id = asId(c.req.param('id'));
  const existing = await first<UserRow>(env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id));
  if (!existing) throw notFound('用户不存在');

  const body = (await c.req.json()) as Record<string, unknown>;
  await env.DB.prepare(
    `UPDATE users SET name = ?, email = ?, note = ?, status = ?, quota_usd = ?,
            rpm_limit = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      asOptionalString(body.name, 'name', 100) ?? existing.name,
      body.email === undefined ? existing.email : asOptionalString(body.email, 'email', 200),
      body.note === undefined ? existing.note : asOptionalString(body.note, 'note', 1000),
      body.status === undefined
        ? existing.status
        : asEnum(body.status, 'status', ['active', 'disabled'] as const, 'active'),
      asNumber(body.quota_usd, 'quota_usd', { min: 0, max: 1e7, fallback: existing.quota_usd }),
      asNumber(body.rpm_limit, 'rpm_limit', { min: 0, max: 100_000, fallback: existing.rpm_limit }),
      Date.now(),
      id,
    )
    .run();

  return c.json({ ok: true });
});

/** 将已用额度归零，用于新账期开始 */
adminApi.post('/users/:id/reset-usage', async (c) => {
  const env = c.env;
  const id = asId(c.req.param('id'));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET used_usd = 0, updated_at = ? WHERE id = ?').bind(Date.now(), id),
    env.DB.prepare('UPDATE api_keys SET used_usd = 0 WHERE user_id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

adminApi.post('/users/:id/status', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const status = asEnum(body.status, 'status', ['active', 'disabled'] as const);
  await run(
    c.env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').bind(
      status,
      Date.now(),
      asId(c.req.param('id')),
    ),
  );
  return c.json({ ok: true, status });
});

adminApi.delete('/users/:id', async (c) => {
  const env = c.env;
  const id = asId(c.req.param('id'));
  const existing = await first<{ id: number }>(
    env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id),
  );
  if (!existing) throw notFound('用户不存在');

  // 用量明细保留（历史审计需要），仅解除对用户的引用
  await env.DB.batch([
    env.DB.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- 下游 Key

adminApi.get('/keys', async (c) => {
  const env = c.env;
  const userId = c.req.query('user_id') ? asId(c.req.query('user_id'), 'user_id') : null;
  const limit = asNumber(c.req.query('limit'), 'limit', { min: 1, max: 200, fallback: 100 });
  const offset = asNumber(c.req.query('offset'), 'offset', { min: 0, fallback: 0 });

  const { items, total } = await paginate<ApiKeyRow & { user_name: string }>(env.DB, {
    select: 'k.*, u.name AS user_name',
    from: 'api_keys k LEFT JOIN users u ON u.id = k.user_id',
    where: userId ? 'k.user_id = ?' : undefined,
    params: userId ? [userId] : [],
    orderBy: 'k.id DESC',
    limit,
    offset,
  });

  return c.json({
    items: items.map((k) => ({
      id: k.id,
      user_id: k.user_id,
      user_name: k.user_name,
      name: k.name,
      // 明文不入库，列表只展示前缀与尾号
      key_display: `${k.key_prefix}...${k.key_last4}`,
      allowed_models: parseAllowedModels(k.allowed_models),
      status: k.status,
      quota_usd: k.quota_usd,
      used_usd: k.used_usd,
      rpm_limit: k.rpm_limit,
      expires_at: k.expires_at,
      last_used_at: k.last_used_at,
      created_at: k.created_at,
    })),
    total,
  });
});

adminApi.post('/keys', async (c) => {
  const env = c.env;
  const body = (await c.req.json()) as Record<string, unknown>;
  const userId = asId(body.user_id, 'user_id');

  const user = await first<{ id: number }>(env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId));
  if (!user) throw badRequest('指定的用户不存在', 'user_id');

  const plaintext = generateApiKey();
  const hash = await sha256Hex(plaintext);
  const expiresAt = body.expires_at
    ? asNumber(body.expires_at, 'expires_at', { min: 0 })
    : null;

  const result = await env.DB.prepare(
    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_last4, status, quota_usd,
                           used_usd, rpm_limit, expires_at, created_at, allowed_models)
     VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`,
  )
    .bind(
      userId,
      asOptionalString(body.name, 'name', 100) ?? '',
      hash,
      plaintext.slice(0, 7),
      plaintext.slice(-4),
      asEnum(body.status, 'status', ['active', 'disabled'] as const, 'active'),
      asNumber(body.quota_usd, 'quota_usd', { min: 0, max: 1e7, fallback: 0 }),
      asNumber(body.rpm_limit, 'rpm_limit', { min: 0, max: 100_000, fallback: 0 }),
      expiresAt,
      Date.now(),
      body.allowed_models === undefined || body.allowed_models === null
        ? null
        : JSON.stringify(validateAllowedModels(body.allowed_models)),
    )
    .run();

  // 明文只在此处返回一次
  return c.json({ ok: true, id: Number(result.meta.last_row_id), key: plaintext }, 201);
});

adminApi.put('/keys/:id', async (c) => {
  const env = c.env;
  const id = asId(c.req.param('id'));
  const existing = await first<ApiKeyRow>(env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id));
  if (!existing) throw notFound('API Key 不存在');

  const body = (await c.req.json()) as Record<string, unknown>;
  await env.DB.prepare(
    `UPDATE api_keys SET name = ?, status = ?, quota_usd = ?, rpm_limit = ?, expires_at = ?,
                         allowed_models = ? WHERE id = ?`,
  )
    .bind(
      body.name === undefined ? existing.name : asOptionalString(body.name, 'name', 100) ?? '',
      body.status === undefined
        ? existing.status
        : asEnum(body.status, 'status', ['active', 'disabled'] as const, 'active'),
      asNumber(body.quota_usd, 'quota_usd', { min: 0, max: 1e7, fallback: existing.quota_usd }),
      asNumber(body.rpm_limit, 'rpm_limit', { min: 0, max: 100_000, fallback: existing.rpm_limit }),
      body.expires_at === undefined || body.expires_at === null || body.expires_at === ''
        ? null
        : asNumber(body.expires_at, 'expires_at', { min: 0 }),
      body.allowed_models === undefined
        ? existing.allowed_models
        : body.allowed_models === null
          ? null
          : JSON.stringify(validateAllowedModels(body.allowed_models)),
      id,
    )
    .run();

  return c.json({ ok: true });
});

adminApi.post('/keys/:id/reset-usage', async (c) => {
  await run(
    c.env.DB.prepare('UPDATE api_keys SET used_usd = 0 WHERE id = ?').bind(asId(c.req.param('id'))),
  );
  return c.json({ ok: true });
});

adminApi.post('/keys/:id/status', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const status = asEnum(body.status, 'status', ['active', 'disabled'] as const);
  await run(
    c.env.DB.prepare('UPDATE api_keys SET status = ? WHERE id = ?').bind(
      status,
      asId(c.req.param('id')),
    ),
  );
  return c.json({ ok: true, status });
});

adminApi.delete('/keys/:id', async (c) => {
  await run(c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(asId(c.req.param('id'))));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- 用量

adminApi.get('/usage/logs', async (c) => {
  const env = c.env;
  const limit = asNumber(c.req.query('limit'), 'limit', { min: 1, max: 200, fallback: 50 });
  const offset = asNumber(c.req.query('offset'), 'offset', { min: 0, fallback: 0 });

  const clauses: string[] = [];
  const params: unknown[] = [];

  const userId = c.req.query('user_id');
  if (userId) {
    clauses.push('user_id = ?');
    params.push(asId(userId, 'user_id'));
  }
  const keyId = c.req.query('key_id');
  if (keyId) {
    clauses.push('key_id = ?');
    params.push(asId(keyId, 'key_id'));
  }
  const model = c.req.query('model');
  if (model) {
    clauses.push('model = ?');
    params.push(model);
  }
  const channelId = c.req.query('channel_id');
  if (channelId) {
    clauses.push('channel_id = ?');
    params.push(asId(channelId, 'channel_id'));
  }
  const status = c.req.query('status');
  // 流式响应中途被截断时状态码仍是 200（响应头早已发出），但写入了 error —— 对下游来说
  // 这就是一次失败，因此「只看错误」必须把它一起捞出来，否则断流在后台不可见。
  // 汇总行同样要一并考虑：它的 status_code 只是占位，真实失败数在 meta.errors 里，
  // 只看 status_code 会把「含失败的汇总行」误判成成功。
  if (status === 'error') {
    clauses.push(
      `(status_code >= 400 OR error IS NOT NULL` +
        ` OR (meta IS NOT NULL AND json_extract(meta, '$.errors') > 0))`,
    );
  }
  if (status === 'ok') {
    clauses.push(
      `(status_code < 400 AND error IS NULL` +
        ` AND (meta IS NULL OR json_extract(meta, '$.errors') = 0))`,
    );
  }
  const since = c.req.query('since');
  if (since) {
    clauses.push('ts >= ?');
    params.push(asNumber(since, 'since', { min: 0 }));
  }

  // 精确总数要 COUNT(*) 扫描整个结果集：明细表按保留期滚动累积，页面又只展示前 100 条，
  // 因此界面调用时不统计总数（count=0），避免每打开一次用量页就扫一遍全表。
  const withCount = c.req.query('count') !== '0';

  const { items, total } = await paginate<Record<string, unknown>>(env.DB, {
    select: `l.request_id, l.ts, l.user_id, l.key_id, l.channel_id, l.model, l.upstream_model,
             l.prompt_tokens, l.completion_tokens, l.total_tokens, l.cached_tokens,
             l.cost_usd, l.estimated, l.meta,
             l.latency_ms, l.status_code, l.stream, l.error, l.ip,
             u.name AS user_name, c.name AS channel_name`,
    from: 'usage_logs l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN channels c ON c.id = l.channel_id',
    where: clauses.length > 0 ? clauses.join(' AND ') : undefined,
    params,
    orderBy: 'l.ts DESC',
    limit,
    offset,
    withCount,
  });

  return c.json({ items, total });
});

// ---------------------------------------------------------------- 设置

adminApi.get('/settings', async (c) => {
  const env = c.env;
  const siteName = await getSiteName(env);
  const channelCount = await first<{ n: number }>(
    env.DB.prepare('SELECT COUNT(*) AS n FROM channels'),
  );
  const modelCount = await first<{ n: number }>(env.DB.prepare('SELECT COUNT(*) AS n FROM models'));
  const secrets = await checkSecrets(env);

  return c.json({
    site_name: siteName,
    /** 两个 Secret 的状态：ok / missing / mismatch / no-db（见 lib/bootstrap.ts） */
    secrets_state: secrets.state,
    secrets_missing: secrets.missing,
    admin_token_set: Boolean(env.ADMIN_TOKEN),
    admin_token_rotated_at: await getAdminTokenRotatedAt(env),
    encryption_key_set: Boolean(env.ENCRYPTION_KEY),
    channel_count: channelCount?.n ?? 0,
    model_count: modelCount?.n ?? 0,
    /** 测试辅助端点是否打包进本次构建（只看构建方式，不受任何运行时变量控制） */
    test_endpoints: TEST_ENDPOINTS,
    /** 线上版本指纹（commit SHA 或 dev），用于确认线上是不是最新代码 */
    build_version: BUILD_VERSION,
  });
});

/**
 * 密钥体检：登录页与首页在缺配置时据此显示「还差哪两个 Secret」。
 *
 * 不要求登录 —— 缺 ADMIN_TOKEN 时本来就无法登录，而这恰恰是最需要提示的场景。
 * 因此只返回「缺哪些名字」与状态，不返回任何密钥值。
 */
adminApi.get('/setup-status', async (c) => {
  const status = await checkSecrets(c.env);
  return c.json({
    state: status.state,
    missing: status.missing,
    db_ready: status.dbReady,
    site_name: status.dbReady ? await getSiteName(c.env).catch(() => DEFAULT_SITE_NAME) : DEFAULT_SITE_NAME,
  });
});

/**
 * 准备更换登录令牌。
 *
 * 令牌是 Secret，Worker 改不了平台上的值 —— 所以这里不「替用户换」，而是做两件事：
 * 1. 先确认 ENCRYPTION_KEY 仍能解开库里的数据，避免换了密码才发现渠道 Key 全废；
 * 2. 生成一个足够随机的候选令牌（用 Web Crypto，不落库、不写日志），
 *    连同操作步骤一起返回，用户在控制台粘一下就能换。
 *
 * 返回值里的 token 只在这一次响应里出现，后台也没有任何地方记录它。
 */
adminApi.post('/settings/rotate-token', async (c) => {
  await assertEncryptionKeyUsable(c.env);
  const ts = Date.now();
  await markAdminTokenRotatedAt(c.env, ts);

  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  return c.json({
    ok: true,
    /** 候选新令牌：由 Worker 现场生成，仅此一次返回 */
    token,
    admin_token_rotated_at: ts,
    /** 操作步骤：界面按顺序展示 */
    steps: [
      '复制下面生成的随机串（也可以自己另想一个 16 位以上的）。',
      '打开 Cloudflare 控制台 → 该 Worker → Settings → Variables and Secrets。',
      '编辑 ADMIN_TOKEN，把值换成新的，类型保持 Secret。',
      '保存后立即生效：当前会话会失效，用新令牌重新登录即可。',
    ],
  });
});

adminApi.put('/settings', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const siteName = asOptionalString(body.site_name, 'site_name', 100);
  if (siteName) await setSetting(c.env.DB, 'site_name', siteName);
  return c.json({ ok: true, site_name: siteName ?? (await getSiteName(c.env)) });
});

/**
 * 用旧 ENCRYPTION_KEY 恢复 AI 配置：把库里已加密的渠道 API Key 解密后，
 * 再用当前环境变量里的 ENCRYPTION_KEY 重新加密写回。
 *
 * 场景：部署者换了 ENCRYPTION_KEY 但还记得旧值（此时站点处于 mismatch 状态）。
 * 提交旧值即可就地恢复，不必逐个渠道重填 Key，也不必把新密钥改回旧值。
 * 旧值只在本次请求里使用，不落库、不写日志。
 */
adminApi.post('/settings/reencrypt', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const oldKey = asOptionalString(body.old_key, 'old_key', 500);
  if (!oldKey) throw badRequest('请填写原来的 ENCRYPTION_KEY', 'old_key');

  const { reencrypted, total } = await reencryptChannels(c.env, oldKey);

  // 一条都没解开：旧密钥不对。此时函数没有改任何数据（含校验值），mismatch 状态原样保留。
  if (reencrypted === 0 && total > 0) {
    throw new ApiError(
      409,
      '用这个旧密钥没能解开任何渠道的 API Key：它多半不是最初那个值。请确认后重试，或改回原值、或逐个渠道重新保存。',
      'api_error',
      'encryption_key_mismatch',
    );
  }

  const skipped = total - reencrypted;
  const message =
    total === 0
      ? '没有需要重新加密的渠道，主密钥校验值已用当前 ENCRYPTION_KEY 重置。'
      : skipped > 0
        ? `已用旧密钥恢复 ${reencrypted} 个渠道，另有 ${skipped} 个渠道用这个旧密钥解不开（可能已是新密钥或数据损坏），请逐个重新保存。`
        : `已用旧密钥恢复全部 ${reencrypted} 个渠道的 API Key，并用当前 ENCRYPTION_KEY 重新加密。`;

  return c.json({ ok: true, reencrypted, total, message });
});

// ---------------------------------------------------------------- 数据维护

/** 取某个时刻所在的北京自然日零点。usage_logs 的日期口径同为北京时间（见 DAY_EXPR） */
function startOfDay(ms: number): number {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
}

/**
 * 合并时保持不变的列。id 之外的全部数据列，顺序与建表一致（meta 在最后，见迁移 0011）。
 * 重排要按这份清单把数据搬到新表，漏一列就是静默丢数据，所以集中定义、只此一处。
 */
const USAGE_LOG_COLUMNS = [
  'ts',
  'request_id',
  'user_id',
  'key_id',
  'channel_id',
  'model',
  'upstream_model',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cost_usd',
  'estimated',
  'latency_ms',
  'status_code',
  'stream',
  'error',
  'ip',
  'ua',
  'cached_tokens',
  'meta',
];

/**
 * 重排时重建的索引，与迁移 0010 保持一致。
 *
 * 重排会把整张表换掉，索引随之消失——必须原样重建，否则查询会退化成全表扫描而没有任何报错。
 * 那条带 WHERE 的部分索引同样不能漏。
 */
const USAGE_LOG_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_usage_logs_ts ON usage_logs(ts)',
  'CREATE INDEX IF NOT EXISTS idx_usage_logs_user_ts ON usage_logs(user_id, ts)',
  'CREATE INDEX IF NOT EXISTS idx_usage_logs_key_ts ON usage_logs(key_id, ts)',
  'CREATE INDEX IF NOT EXISTS idx_usage_logs_model_ts ON usage_logs(model, ts)',
  'CREATE INDEX IF NOT EXISTS idx_usage_logs_channel_ts ON usage_logs(channel_id, ts)',
  'CREATE INDEX IF NOT EXISTS idx_usage_logs_model_ts_cached ON usage_logs(model, ts, cached_tokens)',
  'CREATE INDEX IF NOT EXISTS idx_usage_logs_errors ON usage_logs(ts) WHERE status_code >= 400 OR error IS NOT NULL',
];

/** 备份表名形如 usage_logs_backup_<毫秒时间戳>；下载接口只认这个形状，不接受任意表名 */
const BACKUP_TABLE_RE = /^usage_logs_backup_\d{13}$/;

/** 汇总行在这些维度上写死的标记：它是「系统的合并动作」，不属于任何用户、渠道或模型 */
const SYSTEM = 'system';

/**
 * 无损合并历史明细：把 cutoff 之前的**全部未合并明细**折成一条汇总行，计数记进 meta。
 *
 * 「压成一条」是刻意的选择，代价要先认下来：
 *   * 日趋势会失真 —— 全部历史堆在同一天（汇总行的 ts 取组内最后一次请求的时间）
 *   * 按模型 / 渠道 / 用户的分组统计对旧数据失效，这些维度一律写成 system
 * 请求数、失败数、token、费用这些总量不变。
 *
 * 三条不能改的地方：
 *   * DELETE 必须排在 INSERT 之前（同一 batch 顺序执行）。反过来会把刚插入的汇总行一起删掉。
 *   * 聚合与删除都要带 `meta IS NULL`：汇总行不参与后续合并，也就不会被后来的合并覆盖。
 *     代价是合并几次就会留下几条汇总行，而它们各自带着自己那批 ip / ua。
 *   * 计数从 meta 还原（dashboard 的 REQ_COUNT / ERR_COUNT 都读它），meta 少了 requests / errors 就会漏算。
 */
adminApi.post('/maintenance/merge', async (c) => {
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const days = asNumber(body.days, 'days', { min: 0, max: 7, fallback: 7 });
  // N 天 = 保留今天在内的最近 N 个北京自然日：N=1 就是「除今天以外全折」，
  // N=0 是「立即合并」—— 把此刻之前的全部明细都折掉，不留明细
  const cutoff = days === 0 ? Date.now() : startOfDay(Date.now() - (days - 1) * DAY_MS);

  const folded = await first<{
    rows_n: number;
    last_ts: number | null;
    requests: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens: number;
    cost_usd: number;
    estimated: number;
    latency_ms: number;
    /** json_group_array 的结果：折了几行就有几个元素 */
    ips: string | null;
    uas: string | null;
  }>(
    db
      .prepare(
        `SELECT COUNT(*) AS rows_n,
                MAX(ts) AS last_ts,
                ${REQ_COUNT()} AS requests,
                ${ERR_COUNT()} AS errors,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COALESCE(MAX(estimated), 0) AS estimated,
                COALESCE(SUM(latency_ms), 0) AS latency_ms,
                json_group_array(ip) AS ips,
                json_group_array(ua) AS uas
           FROM usage_logs
          WHERE ts < ? AND meta IS NULL`,
      )
      .bind(cutoff),
  );

  const cutoffDay = new Date(cutoff + TZ_OFFSET_MS).toISOString().slice(0, 10);

  if (!folded || folded.rows_n === 0) {
    return c.json({
      ok: true,
      days,
      cutoff,
      cutoff_day: cutoffDay,
      groups: 0,
      deleted_rows: 0,
      requests: 0,
      message: `没有早于 ${cutoffDay} 的数据需要合并`,
    });
  }

  const cached = Math.max(0, Math.min(folded.cached_tokens, folded.prompt_tokens));
  const arr = (json: string | null): unknown[] => {
    try {
      return (JSON.parse(json ?? '[]') as unknown[]).filter((v) => v !== null && v !== undefined);
    } catch {
      return [];
    }
  };
  // meta 里只留两类东西：还原计数用的 requests / errors，以及逐条的 ip、ua。
  // token 拆分不重复放 —— 它已经在行自己的 prompt_tokens / cached_tokens / completion_tokens 列上了
  const meta = JSON.stringify({
    merged: true,
    requests: folded.requests,
    errors: folded.errors,
    ips: arr(folded.ips),
    uas: arr(folded.uas),
  });

  const results = await db.batch([
    // meta IS NULL：已经折过的汇总行不再参与合并，也不会被后来的合并覆盖掉
    db.prepare('DELETE FROM usage_logs WHERE ts < ? AND meta IS NULL').bind(cutoff),
    db.prepare(
      `INSERT INTO usage_logs (
         ts, request_id, user_id, key_id, channel_id, model, upstream_model,
         prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost_usd, estimated,
         latency_ms, status_code, stream, error, ip, ua, meta
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,?)`,
    ).bind(
      folded.last_ts ?? cutoff - 1,
      // 汇总行也是"一次请求"，所以给标准 UUID；它是汇总这件事由 meta.merged 标记
      crypto.randomUUID(),
      SYSTEM,
      SYSTEM,
      SYSTEM,
      SYSTEM,
      SYSTEM,
      folded.prompt_tokens,
      folded.completion_tokens,
      folded.total_tokens,
      cached,
      folded.cost_usd,
      folded.estimated,
      folded.latency_ms,
      folded.errors > 0 ? 500 : 200,
      SYSTEM,
      SYSTEM,
      meta,
    ),
  ]);

  const deletedRows = results[0]?.meta?.changes ?? 0;

  return c.json({
    ok: true,
    days,
    cutoff,
    cutoff_day: cutoffDay,
    groups: 1,
    deleted_rows: deletedRows,
    requests: folded.requests,
    message: `已将 ${cutoffDay} 之前的 ${deletedRows} 条明细合并为 1 条汇总记录（累计 ${folded.requests} 次请求）`,
  });
});

/**
 * 重排 usage_logs：先留一份完整备份，再重建表让 id 从 1 起按时间连续编号。
 *
 * 全部语句放进一个 batch（单事务）。分步执行的话，备份与换表之间进来的请求会随旧表一起丢掉。
 * 新表不带 AUTOINCREMENT，与迁移 0010 一致——代价是每次 INSERT 读写一次 sqlite_sequence，
 * 而「id 绝不复用」对本表没有意义。
 *
 * 提交后重新核对行数与 token 总数，对不上就在返回里如实报出来，不假装成功。
 */
adminApi.post('/maintenance/reindex', async (c) => {
  const db = c.env.DB;
  const before = await first<{ n: number; tokens: number }>(
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens), 0) AS tokens FROM usage_logs'),
  );

  if (!before || before.n === 0) {
    return c.json({ ok: true, count: 0, backup_table: null, message: 'usage_logs 为空，无需重排' });
  }

  const backupTable = 'usage_logs_backup_' + Date.now();
  const tempTable = 'usage_logs_new_reindex';

  const columnDefs = [
    'id INTEGER PRIMARY KEY',
    'ts INTEGER NOT NULL',
    'request_id TEXT NOT NULL',
    'user_id INTEGER',
    'key_id INTEGER',
    'channel_id INTEGER',
    'model TEXT',
    'upstream_model TEXT',
    'prompt_tokens INTEGER NOT NULL DEFAULT 0',
    'completion_tokens INTEGER NOT NULL DEFAULT 0',
    'total_tokens INTEGER NOT NULL DEFAULT 0',
    'cost_usd REAL NOT NULL DEFAULT 0',
    'estimated INTEGER NOT NULL DEFAULT 0',
    'latency_ms INTEGER NOT NULL DEFAULT 0',
    'status_code INTEGER NOT NULL DEFAULT 200',
    'stream INTEGER NOT NULL DEFAULT 0',
    'error TEXT',
    'ip TEXT',
    'ua TEXT',
    'cached_tokens INTEGER NOT NULL DEFAULT 0',
    'meta TEXT',
  ].join(', ');

  const cols = USAGE_LOG_COLUMNS.join(', ');

  const results = await db.batch([
    // 先备份：即便后面出了意外，原始数据仍在库里
    db.prepare(`CREATE TABLE ${backupTable} AS SELECT * FROM usage_logs`),
    db.prepare(`DROP TABLE IF EXISTS ${tempTable}`),
    db.prepare(`CREATE TABLE ${tempTable} (${columnDefs})`),
    // id 不参与搬运，由新表按插入顺序从 1 重新分配
    db.prepare(
      `INSERT INTO ${tempTable} (${cols}) SELECT ${cols} FROM usage_logs ORDER BY ts ASC, id ASC`,
    ),
    db.prepare('DROP TABLE usage_logs'),
    db.prepare(`ALTER TABLE ${tempTable} RENAME TO usage_logs`),
    ...USAGE_LOG_INDEXES.map((sql) => db.prepare(sql)),
  ]);

  const inserted = results[3]?.meta?.changes ?? 0;

  const after = await first<{ n: number; tokens: number }>(
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens), 0) AS tokens FROM usage_logs'),
  );

  const lostRows = before.n - (after?.n ?? 0);

  return c.json({
    ok: true,
    count: after?.n ?? 0,
    inserted,
    backup_table: backupTable,
    rows_before: before.n,
    // 正常情况下是 0。不为 0 说明换表期间有请求落在旧表上，必须让调用方看见
    lost_rows: lostRows > 0 ? lostRows : 0,
    tokens_before: before.tokens,
    tokens_after: after?.tokens ?? 0,
    tokens_ok: before.tokens === (after?.tokens ?? 0),
  });
});

/** 列出 usage_logs 的备份表。只回表名、创建时间与行数，不回备份内容 */
adminApi.get('/maintenance/backups', async (c) => {
  const tables = await all<{ name: string }>(
    c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'usage_logs_backup_%' ORDER BY name DESC",
    ),
  );

  const backups: { table: string; created_at: number; rows: number }[] = [];
  for (const t of tables) {
    if (!BACKUP_TABLE_RE.test(t.name)) continue;
    // 表名来自 sqlite_master，且已通过上面那条白名单正则，拼接是安全的
    const row = await first<{ n: number }>(
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`),
    );
    backups.push({
      table: t.name,
      created_at: Number(t.name.slice('usage_logs_backup_'.length)),
      rows: row?.n ?? 0,
    });
  }

  return c.json({ ok: true, backups });
});

/**
 * 导出备份表为 CSV。刻意不打码：打码后的 ID 与 IP 无法还原，那它就不算备份。
 * 代价是含 ip / ua 原值，因此只允许管理员下载，表名走白名单。
 */
adminApi.get('/maintenance/backups/download', async (c) => {
  const table = c.req.query('table') ?? '';
  if (!BACKUP_TABLE_RE.test(table)) throw badRequest('table', '非法的备份表名');

  const exists = await first<{ name: string }>(
    c.env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table),
  );
  if (!exists) throw notFound('备份表不存在');

  const cols = await all<{ name: string }>(
    c.env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`),
  );
  const names = cols.map((x) => x.name);
  if (names.length === 0) throw notFound('备份表没有可导出的列');

  const rows = await all<Record<string, unknown>>(
    c.env.DB.prepare(`SELECT * FROM "${table}" ORDER BY id ASC`),
  );

  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const lines = [names.join(',')];
  for (const r of rows) lines.push(names.map((n) => cell(r[n])).join(','));

  // 带 UTF-8 BOM：错误信息里有中文，不带的话 Excel / WPS 打开是乱码
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${table}.csv"`,
    },
  });
});


export { forbidden };
