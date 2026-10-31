/** Worker 绑定与数据行类型 */

/**
 * 运行时绑定。
 *
 * 两个 Secret 是必需的，部署后在 Cloudflare 控制台
 * （Worker → Settings → Variables and Secrets → Add，类型选 Secret）添加：
 *   ADMIN_TOKEN     管理后台登录令牌
 *   ENCRYPTION_KEY  上游渠道密钥的 AES-256-GCM 主密钥
 * 未配置时项目不会回落到任何默认值，而是明确提示缺哪一个（见 lib/bootstrap.ts）。
 * `wrangler.jsonc` 的 `secrets.required` 里也声明了这两个名字，`wrangler types` 会据此生成类型。
 */
export interface Env {
  /** D1 数据库 */
  DB: D1Database;
  /** 管理后台登录令牌（Secret） */
  ADMIN_TOKEN?: string;
  /** 上游渠道密钥的加密主密钥（Secret） */
  ENCRYPTION_KEY?: string;
}

export interface UserRow {
  id: number;
  name: string;
  email: string | null;
  note: string | null;
  status: string;
  quota_usd: number;
  used_usd: number;
  rpm_limit: number;
  created_at: number;
  updated_at: number;
}

export interface ApiKeyRow {
  id: number;
  user_id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  key_last4: string;
  /** null = 全部模型；JSON 数组 = 仅指定模型（空数组禁止全部）。 */
  allowed_models: string | null;
  status: string;
  quota_usd: number;
  used_usd: number;
  rpm_limit: number;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export interface ChannelRow {
  id: number;
  name: string;
  base_url: string;
  api_key_enc: string;
  status: string;
  priority: number;
  weight: number;
  allow_all_models: number;
  /** 1 = 允许以明文 http 连接公网地址（自建上游未备案、只能走公网 IP 时） */
  allow_insecure_http: number;
  timeout_ms: number;
  extra_headers: string;
  inject_usage: number;
  cooldown_until: number;
  fail_count: number;
  last_error: string | null;
  last_ok_at: number | null;
  /** 最近一次查询到的上游余额（保留上游币种，仅用于展示） */
  balance_amount: number | null;
  balance_currency: string | null;
  balance_checked_at: number | null;
  /** 最近一次余额查询失败的原因 */
  balance_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ModelRow {
  id: string;
  display_name: string;
  description: string;
  enabled: number;
  prompt_price: number;
  completion_price: number;
  /** 缓存命中的输入单价（美元 / 1M token）。null = 不区分缓存，按 prompt_price 计 */
  cache_hit_price: number | null;
  created_at: number;
  updated_at: number;
}

export interface AuthContext {
  key: ApiKeyRow;
  user: UserRow;
}

/** 一次请求的用量结算信息 */
export interface UsageEntry {
  requestId: string;
  userId: number | null;
  keyId: number | null;
  channelId: number | null;
  model: string | null;
  upstreamModel: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 输入 token 中命中上游前缀缓存的部分 */
  cachedTokens: number;
  costUsd: number;
  estimated: number;
  latencyMs: number;
  statusCode: number;
  stream: number;
  error: string | null;
  ip: string;
  ua: string;
  /**
   * 是否顺带更新密钥的「最后使用时间」。
   *
   * 该字段只用于界面展示，高频调用时每个请求写一行它并不划算，因此调用方会在
   * 距上次写入不足一分钟时传 false；省略视为 true（保持默认行为）。
   */
  touchKey?: boolean;
  /** 已预扣的额度（美元）。结算只补「实际花费 − 该值」的差额，须与 reserveQuota 返回值一致 */
  reservedUsd?: number;
}
