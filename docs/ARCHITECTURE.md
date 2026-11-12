# 架构文档

本文是项目的技术参考：运行时结构、请求链路、数据模型、计费与调度规则、部署契约、容量与运维。
面向「要读/改这份代码的人」；只是想把站跑起来，看 [README](../README.md) 即可。

- [1. 总览](#1-总览)
- [2. 运行时与部署拓扑](#2-运行时与部署拓扑)
- [3. 代码结构与模块职责](#3-代码结构与模块职责)
- [4. 请求链路](#4-请求链路)
- [5. 路由表](#5-路由表)
- [6. 鉴权与会话](#6-鉴权与会话)
- [7. 渠道调度与故障转移](#7-渠道调度与故障转移)
- [8. 计费与额度](#8-计费与额度)
- [9. 数据模型](#9-数据模型)
- [10. 配置与密钥自举](#10-配置与密钥自举)
- [11. 构建契约（dev / build / deploy）](#11-构建契约dev--build--deploy)
- [12. 管理界面](#12-管理界面)
- [13. 容量、成本与性能](#13-容量成本与性能)
- [14. 测试体系](#14-测试体系)
- [15. 运维](#15-运维)
- [16. 设计取舍与已知限制](#16-设计取舍与已知限制)

---

## 1. 总览

AI 中转站是一个**单 Worker + 单 D1** 的聚合网关：

- 上游：任意 OpenAI 兼容平台（OpenAI、DeepSeek、Groq、OpenRouter、硅基流动、自建 vLLM…），
  统一用一个适配器覆盖，差异通过「渠道」配置表达（Base URL、密钥、附加头、模型映射、超时）
- 下游：标准 OpenAI 协议 + 自己签发的 `sk-` 密钥；可选 `/user/balance` 查询余额
- 管理面：内联在 Worker 里的单页应用，做渠道 / 模型 / 用户 / 密钥 / 用量五个维度的增删改查与观测

设计原则：

1. **配置最少** — 只有两个必需的 Secret（`ADMIN_TOKEN` / `ENCRYPTION_KEY`），没有写死的域名；
   D1 在部署时自动查找/创建，其余配置都存在数据库里
2. **精确优先、估算兜底** — 能拿到上游 `usage` 就按它计费；拿不到才估算，并在数据里标记出来
3. **失败要可区分** — 上游故障、调用方错误、客户端断开三类严格分开：只有前者换渠道、计熔断
4. **写入要省** — D1 是单写者，每个请求的写入量被压到「2~3 行」

## 2. 运行时与部署拓扑

```
                        ┌──────────────────────── Cloudflare 边缘 ────────────────────────┐
  下游客户端  ──Bearer──▶│  Worker「ai-gateway」                                          │
                        │    ├─ /v1/*        鉴权 → 白名单 → 选路 → 转发 → 结算             │
  管理员浏览器 ─Cookie─▶│    ├─ /admin/api/* 管理 JSON API                                │
                        │    ├─ /admin*      内联 HTML 单页                                │
                        │    └─ /            公开首页（站点名称来自 D1）                    │
                        └──────────────┬──────────────────────────────┬──────────────────┘
                                       │ D1 绑定 env.DB                │ fetch (https)
                                       ▼                               ▼
                             D1「ai-gateway」                 上游平台 A / B / C …
                        settings / users / api_keys /        
                        channels / channel_models /          
                        models / usage_logs / admin_sessions  
```

- 只有 **一个绑定**：`DB`（D1）。没有 KV / R2 / Queues / Durable Objects / 定时任务
- Worker 对所有 `*.workers.dev` 与（可选的）自定义域名开放；自定义域名在控制台里后加
- 无状态：所有状态都在 D1。Worker 实例可以随时被回收，唯一的内存态是 RPM 计数（见 8.3）

## 3. 代码结构与模块职责

```
src/
  index.ts          路由挂载、重复 /v1 前缀折叠、CORS、未匹配路径的 404、测试端点（构建期决定）
  types.ts          Env 绑定与行类型（UserRow / ApiKeyRow / ChannelRow / ModelRow / UsageEntry）
  modules.d.ts      *.html 模块与 __TEST_ENDPOINTS__ 的类型声明
  home/index.html   公开首页（品牌名、示例用 __ORIGIN__ / __SITE_NAME__ 占位符，请求时替换）
  admin/index.html  管理界面（单页 + 内联脚本，约 3000 行，全部内联，零外部依赖）
  lib/
    bootstrap.ts    密钥状态检查（checkSecrets）：缺哪个 Secret、主密钥是否与库中数据匹配
    crypto.ts       randomToken / sha256Hex / timingSafeEqual / AES-256-GCM encrypt·decrypt
    db.ts           all / first / run / batch / paginate / recordUsage / getSetting / setSetting
    auth.ts         下游 Key 解析与校验、额度检查、原子预扣 reserveQuota
    adminAuth.ts    管理会话签发与校验、登录失败计数与回收
    upstream.ts     渠道选择、URL 拼接、请求构造、SSE 转发与空闲看门狗、用量解析、渠道探测
    upstreamBalance.ts  上游余额查询（DeepSeek / OpenRouter / Moonshot / 硅基流动 / 通用约定）
    billing.ts      usage 提取、字符估算、缓存命中识别、computeCost
    ratelimit.ts    RPM 内存限流、登录失败窗口常量
    maintenance.ts  时间常量 DAY_MS
    errors.ts       ApiError 与 OpenAI 风格错误构造器
    validate.ts     入参校验（字符串、数字、枚举、JSON 对象…）
  routes/
    openai.ts       /v1/models、/v1/* 代理、/v1/responses 选路、结算
    responses.ts    Responses ⇄ Chat 协议互转（请求翻译、响应合成、SSE 状态机）
    admin.ts        /admin/api/*（认证、总览、渠道、模型、用户、密钥、用量、设置、数据维护）
    balance.ts      /user/balance
    test.ts         /admin/api/__test__/*（仅开发构建）
migrations/         0001…0014，只增不改
scripts/            部署：deploy.mjs（npm run deploy）、lib/cf.mjs（wrangler 封装 / D1 查找创建 / 生成部署配置）
wrangler.jsonc      Worker 配置（不含 D1 库 ID）
dev-scripts/        本地开发与测试脚本（已 gitignore，不进仓库；见第 14 节）
```

模块依赖是单向的：`routes/* → lib/* → types.ts`；`lib/bootstrap.ts` 被 `adminAuth`、`upstream`、
`upstreamBalance`、`admin` 复用，是密钥的唯一来源。

## 4. 请求链路

### 4.1 `/v1/chat/completions`（成功路径）

```
client ──▶ index.ts (折叠 /v1 前缀)
        ──▶ routes/openai.handleProxy
              1. authenticate()        解析 Key（三种写法）→ sha256 → 查 api_keys + users
                                       → 状态 / 过期 / 额度 / RPM
              2. 白名单                 仅 chat/completions、completions、embeddings、moderations
              3. 解析 body              必须 application/json、必须有 model
              4. 模型启用校验           models.enabled = 1，否则 404 model_not_found
              5. reserveQuota()        按「输入估算 + 输出上限」原子预扣（仅有限额度时）
        ──▶ lib/upstream.proxyRequest
              6. selectChannels()      有映射的渠道 ∪ allow_all_models 渠道；priority 分组 + 加权随机
              7. buildUpstreamUrl()    base_url 无路径补 /v1；有路径原样拼接
              8. fetch 上游            timeout_ms = 等响应头的上限；失败按分类换渠道
              9. 流式：边读边下发 + 空闲看门狗；顺带解析 usage 与估算字符数
        ──▶ 回给客户端（带 x-request-id / x-gateway-channel / x-gateway-attempts）
        ──▶ ctx.waitUntil(settleUsage)
             10. 取 usage（真实或估算）→ computeCost → recordUsage()
                 batch: INSERT usage_logs + UPDATE users.used_usd + UPDATE api_keys（合并 last_used_at）
```

失败路径同样写 `usage_logs`（`status_code` 为真实 HTTP 状态、`error` 为原因），便于事后排查；
只有连鉴权都没通过的请求（没有 userId / keyId / model）不入库，避免匿名探测刷表。

### 4.2 `/v1/responses`（原生优先 + 自动降级）

Responses 是 OpenAI 新协议，上游支持程度差别很大，因此走「能原生就原生，不能就翻译」：

```
                   channels.capabilities 含 responses ?
                    ├─ 是 ──▶ POST {base}/responses      请求体原样透传，SSE 原样回传
                    │         └ 旁路只读 usage（尾部窗口），不发 / 不改任何事件
                    └─ 否 ──▶ POST {base}/chat/completions
                              ├ 请求：instructions→system、input→messages、
                              │        tools/tool_choice/text.format 逐个映射
                              └ 响应：整包 → Response 对象；SSE → Responses 事件流
```

要点：

* **端点覆盖**由 `proxyRequest` 的 `route` 钩子完成（`lib/upstream.ts` 的 `RouteContext` /
  `RouteTarget`），渠道级决策，不改调度与熔断逻辑。
* 原生渠道若返回 **404 / 405**（根本没有该端点），`fallbackOnMissingEndpoint` 让调度器
  静默换下一个渠道，**不记为渠道故障** —— 渠道没坏，只是不认这个协议。
* 翻译路径的计费口径不变：上游 chat 响应里的 `usage` 经 `extractUsage` 归一，流式照样
  注入 `stream_options.include_usage`；原始请求的 token 数按字符估算兜底。
* `stream: true` 时事件序列为 `response.created → response.in_progress →
  output_item.added → content_part.added → output_text.delta* → output_text.done →
  content_part.done → output_item.done → (function_call_arguments.delta* → .done →
  output_item.done)* → response.completed | incomplete | failed`，每帧带单调递增的
  `sequence_number`，`event:` 行与 `data.type` 一致。
* `GET /v1/responses/:id` 与 `previous_response_id` 只覆盖**当前实例内存**里的最近 32 条
  响应（按用户隔离）。取不到即 404 + `response_not_found` / `previous_response_not_found`，
  不做跨用户可读的长期存储 —— 那需要 KV 或 D1，而这个项目承诺零额外依赖。

### 4.3 `/v1/models`

鉴权后列出 `models.enabled = 1` 的模型，并再过滤掉「当前没有任何启用渠道能服务」的模型
（存在 `allow_all_models` 的启用渠道时不过滤）。响应里附带非标准的 `pricing` 字段。

### 4.4 `/user/balance`

四种路径写法（`/user/balance`、尾斜杠、`/v1/user/balance`、尾斜杠）都指向同一处理函数。
口径与鉴权、扣费完全一致：Key 额度优先，未设置时跟随用户额度，都取更紧的那个；
不限额度时 `unlimited: true` 且 `balance` 给一个大数。同时给出 DeepSeek 风格的
`balance_infos`，兼容按该口径解析的工具。

## 5. 路由表

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | — | 公开首页，注入站点名称与实际 origin |
| GET | `/healthz` | — | `{ ok: true, ts }` |
| GET | `/admin`, `/admin/*` | 会话 | 未登录 302 回 `/`；已登录返回内联 HTML（`no-store`） |
| POST | `/admin/api/auth/login` | 令牌 | 常量时间比较，失败按 IP 限流 |
| POST | `/admin/api/auth/logout` | 会话 | 删除会话并清 Cookie |
| GET | `/admin/api/auth/me` | 会话 | 返回 `site_name`，供界面渲染品牌 |
| GET | `/admin/api/dashboard` | 会话 | 总览：区间汇总、日趋势、渠道 / 用户分布、最近明细 |
| POST | `/admin/api/channels/probe` | 会话 | 用填入的地址与密钥探测上游 `/models` |
| GET/POST/PUT/DELETE | `/admin/api/channels[/:id]` | 会话 | 渠道 CRUD |
| POST | `/admin/api/channels/:id/{status,reset,balance,test}` | 会话 | 启停 / 解除熔断 / 查余额 / 连通性测试 |
| POST | `/admin/api/channels/balances/refresh` | 会话 | 批量刷新最久未查询的余额 |
| GET/POST/PUT/DELETE | `/admin/api/models[/:id]` | 会话 | 对外模型与定价 |
| POST | `/admin/api/models/status`, `/models/:id/status` | 会话 | 单个 / 批量启停 |
| GET/POST/PUT/DELETE | `/admin/api/users[/:id]` | 会话 | 下游用户 |
| POST | `/admin/api/users/:id/{reset-usage,status}` | 会话 | 额度归零 / 启停 |
| GET/POST/PUT/DELETE | `/admin/api/keys[/:id]` | 会话 | 下游密钥（明文只在创建时返回一次） |
| POST | `/admin/api/keys/:id/{reset-usage,status}` | 会话 | 额度归零 / 启停 |
| GET | `/admin/api/usage/logs` | 会话 | 用量明细（`count=0` 关闭总数统计） |
| GET | `/admin/api/settings` | 会话 | 站点名称、管理令牌、轮换时间、渠道 / 模型数、是否带测试端点 |
| PUT | `/admin/api/settings` | 会话 | 修改站点名称 |
| POST | `/admin/api/settings/rotate-token` | 会话 | 自检主密钥 + 现场生成候选令牌（只返回一次，不落库） |
| POST | `/admin/api/maintenance/{merge,reindex}` | 会话 | 合并历史明细 / 重排编号（详见 9.3） |
| GET | `/admin/api/maintenance/backups[/download]` | 会话 | 列出 / 下载备份表 |
| GET | `/v1/models` | Key | 模型清单 |
| POST | `/v1/{chat/completions,completions,embeddings,moderations}` | Key | 转发 |
| POST | `/v1/responses` | Key | Responses API：渠道原生则透传，否则翻译成 chat 协议 |
| GET | `/v1/responses/:id` | Key | 取回本实例内存中缓存的响应（供 store / previous_response_id） |
| GET | `/user/balance`, `/v1/user/balance` | Key | 查额度 |
| * | `/admin/api/__test__/*` | 会话 | **只在开发构建**存在；正式构建返回 404 |

## 6. 鉴权与会话

### 6.1 下游 Key

- 格式 `sk-` + 32 字节随机 base64url；库里只存 `sha256(key)`，明文只在签发时显示一次
- 解析顺序：`Authorization: Bearer <k>` → `Authorization: <k>`（不含空格时）→ `x-api-key` → `api-key`
- 校验顺序：格式 → 是否存在 → 是否启用 → 是否过期 → 用户是否存在 / 启用 → 额度 → RPM
- 错误语义：401（Key 无效 / 过期）、403（Key 或用户被禁用）、
  429（额度用尽 `insufficient_quota`，或 RPM 超限 `rate_limit_exceeded`）

### 6.2 管理会话

- 登录：`POST /admin/api/auth/login { token }`，与 Secret `ADMIN_TOKEN` 做常量时间比较；未配置时返回 503
  （`secret_missing`）并说明缺什么，不回落任何默认值
- 成功：生成 32 字节随机会话令牌，库里只存 SHA-256；Cookie `ag_session`，
  `HttpOnly; Secure; SameSite=Lax`，12 小时 TTL
- 每次登录顺带回收过期会话与过期登录失败计数（没有 cron）
- 失败计数：同一 IP 15 分钟内 10 次失败即拒绝（`login_attempts` 表）

## 7. 渠道调度与故障转移

### 7.1 候选与排序

1. 候选 = `status='enabled'` 且未熔断（`cooldown_until <= now`）且
   （有该模型映射 ∨ `allow_all_models = 1`）的渠道 —— **在 SQL 里完成过滤**，
   渠道多时也只读回真正相关的几行（不把含密文的整张表读进 Worker）
2. 按 `priority` 降序分组，组内按 `weight` 加权随机（不放回抽样）
3. 依次尝试，直到成功或候选耗尽

### 7.2 错误分类（决定是否换渠道）

| 上游表现 | 归类 | 处理 |
|---|---|---|
| 401 / 403 / 402，或响应体命中「密钥无效 / 欠费 / 余额不足 / 已停用」 | 渠道故障 | 冷却 6 小时，换下一个 |
| 429 或限流文案 | 渠道故障 | 冷却 2 分钟；文案含「每天 / 每日 / RPD」时冷却 6 小时 |
| 404 / 408 / 5xx / 网络错误 | 渠道故障 | 换下一个，冷却交给指数退避 |
| 其他 4xx（参数错、上下文超长等） | 调用方问题 | 原样回传，不再重试 |

> 401/403/欠费被视为**渠道**故障而不是调用方错误，因为出问题的是渠道自己的密钥/余额。
> 原样回传会误导下游以为自己的 Key 错了，并让后续请求继续打在这个死渠道上。

### 7.3 熔断

连续失败 3 次 → 熔断，冷却 60 秒起、逐次翻倍、上限 10 分钟；任意一次成功即清零。
渠道页可「解除熔断」（`POST /channels/:id/reset`）。

### 7.4 超时语义

渠道的 `timeout_ms` 是**两个**上限，都不是请求总时长：

- 等待响应头：超过即放弃并换渠道
- 流式响应中两次数据之间：超过即中断（空闲看门狗），错误写入 `usage_logs.error`

HTTP 触发的 Worker 本身没有墙钟上限，因此长回答不会被截断。

### 7.5 请求构造

- URL：`base_url` 无路径 → 补 `/v1` + endpoint；有路径 → 原样拼接（兼容 Groq `/openai/v1`、
  DeepInfra `/v1/openai` 等非标准路径）
- 头：逐跳头与 `content-type`/`accept`/`authorization` 由网关决定；渠道的
  「附加请求头」不能覆盖它们；`authorization` 永远是 `Bearer <渠道密钥>`
- 流式：渠道开启 `inject_usage` 时自动注入 `stream_options.include_usage`，以拿到上游 usage

## 8. 计费与额度

### 8.1 用量来源优先级

1. 上游返回的 `usage`（非流式在响应体里，流式在最后一个 `data:` 块里）
2. 都没有时按字符估算：CJK 近似 1 token/字，其余 4 字符 1 token；
   超过 25 万字符改为前 6.4 万字符抽样外推（控制 CPU）
3. 估算结果在 `usage_logs.estimated = 1` 标记，界面显示「估算」

### 8.2 金额

```
cost = (prompt − cached) × prompt_price + cached × (cache_hit_price ?? prompt_price)
     + completion × completion_price            （单价均为 美元 / 1M token）
```

缓存命中量取自 `prompt_cache_hit_tokens`（DeepSeek）、`prompt_tokens_details.cached_tokens`（OpenAI）、
`cache_read_input_tokens`（Anthropic 风格），超过输入总量时截断。

### 8.3 额度与限流

| 机制 | 位置 | 性质 |
|---|---|---|
| 额度（美元） | D1 `users.used_usd` / `api_keys.used_usd` | **硬闸门**：条件 UPDATE 原子预扣，扣不下立刻 429 |
| 预扣金额 | `estimateRequestCost` = 输入估算 + `max_tokens`（缺省 4096） | 结算时按「实际 − 预扣」补差额，多扣退回 |
| RPM | 每个 isolate 的内存 Map | **软限**：实际放行 ≈ 配置值 × isolate 数，用于防打爆上游 |

额度两级：Key 有额度时以 Key 为准，否则跟随用户；都为 0 表示不限，此时不做预扣、不加写入。

## 9. 数据模型

### 9.1 表

| 表 | 关键列 | 说明 |
|---|---|---|
| `settings` | `key`, `value` | 键值配置：`site_name`、`__key_check`（主密钥校验值）、`admin_token_rotated_at` |
| `users` | `quota_usd`, `used_usd`, `rpm_limit`, `status` | 下游用户；额度 0 = 不限 |
| `api_keys` | `key_hash`(UNIQUE), `user_id`, `quota_usd`, `used_usd`, `rpm_limit`, `expires_at`, `last_used_at` | 下游密钥 |
| `channels` | `base_url`, `api_key_enc`, `priority`, `weight`, `allow_all_models`, `cooldown_until`, `fail_count`, `timeout_ms`, `extra_headers`, `inject_usage`, `balance_*` | 上游渠道 |
| `channel_models` | `channel_id`, `model`, `upstream_model` | 下游模型名 → 上游模型名 |
| `models` | `id`, `enabled`, `prompt_price`, `completion_price`, `cache_hit_price` | 对外模型与定价 |
| `usage_logs` | `ts`, `request_id`, `user_id`, `key_id`, `channel_id`, `model`, `*_tokens`, `cached_tokens`, `cost_usd`, `estimated`, `status_code`, `error`, `ip`, `ua`, `meta` | 用量明细与汇总行 |
| `admin_sessions` | `id`(sha256), `expires_at`, `last_seen_at` | 管理会话 |
| `login_attempts` | `ip`, `window`, `count` | 登录失败计数 |

约定：时间戳一律 Unix 毫秒；金额单位为美元；不使用外键级联，级联删除在应用层显式处理；
界面的「天」按北京时间（UTC+8）分桶，存储仍是 UTC 毫秒。

### 9.2 每次代理请求的写入

```
INSERT usage_logs                    1 行
UPDATE users   SET used_usd += delta 1 行（delta = 实际 − 预扣，为 0 时跳过）
UPDATE api_keys SET used_usd += delta, last_used_at = ?   1 行（两者合并）
```

`last_used_at` 在零费用的请求里也会节流（距上次不足 60 秒不写）。

### 9.3 无损合并（`meta` 列）

`usage_logs.meta` 为 `NULL` 表示普通明细；非 `NULL` 表示汇总行：
`{"merged":true,"requests":N,"errors":M,"ips":[…],"uas":[…]}`。

- 请求数 / 失败数一律从 `meta` 还原（`REQ_COUNT` / `ERR_COUNT`），不再用 `COUNT(*)`
- 合并把截止点以前的全部未合并明细折成 **1 条**：总量不变，但日趋势与该行的用户 / 渠道 / 模型维度
  变为 `system`
- 合并与删除都限定 `meta IS NULL`，因此已折过的汇总行不会被二次合并覆盖

## 10. 配置与密钥

**部署契约：一个 D1 绑定 + 两个必需的 Secret。**

| 名称 | 类型 | 用途 | 换值的代价 |
|---|---|---|---|
| `ADMIN_TOKEN` | Secret | 管理后台登录令牌 | 无（改了就用新值登录） |
| `ENCRYPTION_KEY` | Secret | 渠道 API Key 的 AES-256-GCM 主密钥 | 已保存的渠道密钥无法解密，需重新填写 |

**刻意不写** `wrangler.jsonc` 的 `secrets.required`：wrangler 会把它当成部署门槛 —— Secret 没加到 Worker 上
就直接拒绝部署，而 Secret 只能加到已存在的 Worker 上，首次部署会死锁。缺配置改由代码检查
（`lib/setup.ts` 返回说明页），这样部署永远能成功，用户看到的是「还差哪几步」而不是一条 wrangler 报错。

**Secret 不会被 `wrangler deploy` 删除**（官方文档的 source-of-truth 一节
明确说明只有 `wrangler secret delete` 才会删），所以重新部署不会让密钥失效。

### 10.1 缺配置时的行为

`lib/bootstrap.ts` 的 `checkSecrets(env)` 把当前状态归为四类，各入口据此给出可执行的提示，
**绝不回落到随机生成的默认值**（否则用户永远不知道自己有两个密钥，也没法在重建 Worker 时恢复）：

| 状态 | 判定 | 表现 |
|---|---|---|
| `no-db` | 连不上 `settings` 表 | 页面 → 「数据库尚未初始化」说明页（含建表命令）；API → 503 `not_migrated` |
| `missing` | 控制台里没配 Secret | 页面 → 「尚未完成配置」说明页（逐项列出已配 / 未配、控制台路径、随机串命令）；API → 503 `secret_missing` |
| `mismatch` | 主密钥解不开 `settings.__key_check` | 「设置」页标红，提示改回原值或重新保存各渠道 Key；转发时渠道报「密钥无法解密」 |
| `ok` | 齐全且可用 | 正常 |

拦截点在 `src/index.ts` 的全局中间件里：`/healthz` 与 `/favicon.ico` 放行，其余按「页面 / API」二选一。
说明页是纯静态 HTML（`lib/setup.ts`），不读数据库、不依赖任何配置，所以库还没建表时也能正常显示。
页面返回 200（内容本身就是状态说明），API 返回 503 + OpenAI 风格 JSON，客户端不会收到一坨 HTML。
说明页与 `GET /admin/api/setup-status` 都不需要登录，且只输出「缺哪些名字」，不返回任何密钥值。

### 10.2 首次使用时写入什么

主密钥可用时，第一次 `checkSecrets` 会往 `settings` 写一条 `__key_check`（明文校验标记），
之后每次检查都试着用它解密：解不开就说明 `ENCRYPTION_KEY` 被换过。这条记录很小，且 `ON CONFLICT DO NOTHING`，
并发初始化安全。

### 10.3 本地开发

`npm run dev` 通过 `--var INITIAL_ADMIN_TOKEN / INITIAL_ENCRYPTION_KEY` 提供固定值，让本地与 E2E 用确定的令牌；
正式构建会忽略它们（`__TEST_ENDPOINTS__` 为 false 时代码路径被摇掉）。用 `.dev.vars` 也可以，但它在 wrangler
眼里是 secret，需要在 `secrets.required` 里声明才会注入 —— 所以本地推荐用 `--var`。

站点名称没有变量：默认值 `DEFAULT_SITE_NAME`，存在 `settings.site_name`，首页与侧边栏都读它。

## 11. 构建与部署契约（dev / build / deploy）

| 命令 | define | 测试端点 | 用途 |
|---|---|---|---|
| `npm run dev` | `__TEST_ENDPOINTS__:true` | 打包并挂载 | 本地开发；另外注入 `INITIAL_*` 固定令牌 |
| （无 build 脚本） | — | — | 项目没有构建步骤；Workers Builds 的 Build command 留空，依赖安装后直接跑 Deploy command |
| `npm run deploy` | `__TEST_ENDPOINTS__:false` | 不打包 | `scripts/deploy.mjs`：找/建 D1 → 生成部署配置 → 远端迁移 → 部署（Deploy command） |
| `npx wrangler deploy` | 取 `wrangler.jsonc` 默认值 `false` | 不打包 | **不要用**：会清掉 D1 绑定 |

`__TEST_ENDPOINTS__` 的声明在 `src/modules.d.ts`，取值处写成 `((): boolean => __TEST_ENDPOINTS__)()`
并用动态 `import('./routes/test.js')`，让 esbuild 能把取值当常量内联、整块摇掉。
验证方式：`dist/index.js` 里搜不到 `/admin/api/__test__` 路由注册。

### 11.1 D1 绑定为什么不在仓库里

`wrangler deploy` 会按配置文件**整体覆盖** Worker 的绑定：配置里没声明的绑定会被清掉。
而 `database_id` 是每个账号独有的，写进仓库等于把别人的库 ID 发给所有 fork 者。

所以：

1. `wrangler.jsonc` 只有 `name / main / compatibility_date / rules / define / workers_dev`，**没有 D1 段**
2. `scripts/deploy.mjs` 依次：读缓存 `.wrangler/d1.json` → 查账号里的同名库 → 都没有就
   `wrangler d1 create ai-gateway` → 把结果写回缓存
3. `scripts/lib/cf.mjs` 的 `buildDeployConfig()` 以 `wrangler.jsonc` 为模板，生成
   `.wrangler/deploy.jsonc`（多一个 `d1_databases` 段），迁移与部署都用 `--config` 指向它

缓存优先，是为了保证同一个 Worker 永远绑同一个库；若缓存里的库已不在账号里（删库 / 换了账号），
会重新查找或创建。库名固定为 `ai-gateway`，同名库会被复用，因此重复部署幂等。

## 12. 管理界面

单文件 SPA（`src/admin/index.html`），服务端只负责鉴权与下发，页签切换走 History API。

- 视图：概览 / 上游渠道 / 模型与定价 / 用户 / API 密钥 / 设置
- 四张资源表：编辑、额度归零、解除熔断、删除都**只替换受影响的行**（`channelRow` / `modelRow` /
  `userRow` / `keyRow`），不整表重渲染；新增走整页 `render()`
- 状态列是开关，走 `POST /<资源>/:id/status`，不经过整对象 PUT（渠道 PUT 会重写映射）
- 主题：浅色 / 深色 / 跟随系统，`localStorage['ag-theme']`，`<head>` 里的引导脚本在首帧前应用
- 时间一律按北京时间显示；窄屏侧栏收成抽屉（`100dvh`，保证底部「退出登录」可点）
- 内联脚本不在 TS 检查范围内，改完界面后本地跑 `npm run check:inline`

## 13. 容量、成本与性能

- **瓶颈是 D1，不是 CPU**：D1 单库单线程。单请求约 5 行读 + 3 行写
- 免费版硬上限（2026-09-01 起强制执行）：10 万写/天、500 万读/天、单库 500 MB
- 读配额大头是**管理页聚合查询**（概览一次加载扫 7 天明细），不是代理路径；
  因此「合并历史数据」默认折 2 天前的明细
- CPU：等上游是 wall time 不计 CPU；真正的 CPU 成本在鉴权、改写请求体、读流计费。
  12 MB 请求体约 146 ms CPU，1M 上下文（约 4 MB）约 50 ms
- 优化点：候选渠道在 SQL 侧过滤、`last_used_at` 节流、零费用请求不写额度、
  明细列表用 `count=0` 关闭精确总数、字符估算用 `charCodeAt` 扫描、超大文本抽样外推

## 14. 测试体系（本地专用）

测试脚本放在 `dev-scripts/`，**已 gitignore、不进仓库**：仓库只保留运行必需的东西。
新环境要跑测试时，从原开发目录把 `dev-scripts/` 拷回来即可。

```bash
npm run dev               # 终端 A
npm run test              # 终端 B：失败即停
npm run check:inline      # 只检查两个 HTML 的内联脚本
```

| 脚本（`dev-scripts/`） | 作用 |
|---|---|
| `test.mjs` | 总入口，按顺序跑下表全部环节 |
| `inline-check.mjs` | 两个 HTML 的内联脚本语法、视图定义与功能锚点 |
| `check-deploy-config.mjs` | 用模拟库 ID 验证 `buildDeployConfig()` 生成的配置（不联网） |
| `e2e.mjs` | 鉴权、路径兼容、CORS、余额、调度、计费、流式语义、并发预扣、设置与令牌轮换 |
| `e2e-channels.mjs` | 优先级、故障转移、熔断恢复、透传、请求头过滤 |
| `e2e-maintenance.mjs` | 合并 / 重排 / 备份 / 会话清理 |
| `e2e-ui.mjs` | 无头浏览器驱动真实界面（需本机有 Chrome / Edge） |
| `e2e-security.mjs` | 分别用 `__TEST_ENDPOINTS__:false/true` 启动，验证测试端点的存在性 |
| `smoke-remote.mjs` | 对线上实例做冒烟（可达性、登录、正式构建的安全策略） |
| `seed-dev.mjs` | 往本地 D1 灌演示数据 |
| `local-relay.mjs` / `fake-upstream.mjs` | 本地中转与测试用假上游 |

TypeScript 检查直接用 `npm run typecheck`。`tsconfig.json` 的 `include` 里包含 `scripts/**/*.mjs`。

E2E 共用同一个本地 D1；`e2e.mjs` 会轮换一次管理令牌并继续使用新令牌，所以单独重跑其余套件前
需要重置本地库（删 `.wrangler/state` 后重新迁移）。

## 15. 运维

```bash
wrangler tail                                        # 实时日志
wrangler d1 execute DB --remote --command "…"         # 查库（取管理令牌等）
wrangler d1 migrations apply DB --remote             # 升级表结构
```

- 日志关键字：`[404] <method> <path> ua=…`（客户端路径写错）、`[v1] … -> 401`（鉴权失败）
- 渠道排障：总览页看状态 / 连续失败 / 熔断截止 / 最近错误；「测试」给出上游连通性
- 备份：数据维护页「重排编号」会自动留一张 `usage_logs_backup_*` 表，可下载
- 数据增长：`usage_logs` 不会自动收缩，定期在「数据维护」合并

## 16. 设计取舍与已知限制

- **通用透传**：只实现 OpenAI 兼容协议；Anthropic 的 `/v1/messages` 等一律 404
- **Responses 的服务端对话很弱**：`store` / `previous_response_id` 只覆盖当前 isolate 内存里
  最近 32 条响应，实例换了就失效（返回 `previous_response_not_found`）。真正的服务端对话
  需要 KV / D1 持久化，与本项目「零额外依赖」的取舍冲突；客户端带完整上下文即可无限多轮
- **RPM 是软限**：内存计数，多 isolate 下会放大；要精确限流需引入 Durable Objects（本项目刻意不引入）
- **预扣可能残留**：Worker 在预扣与结算之间被回收时，预扣金额会留在账上（由估算上限兜住）
- **合并会损失维度**：折成一行后，旧数据在日期 / 模型 / 渠道 / 用户维度上不可再分
- **令牌存库**：管理令牌与主密钥都在 D1，D1 的访问权限等于服务器权限；需要更强隔离时在
  Worker 前挂 Cloudflare Access
- **`wrangler dev --local` 按 `database_id` 隔离**：该 ID 变化相当于换了一个空库
- **禁用 HTTP 明文上游**：默认只允许 https（回环 / 私有网段除外），`allow_insecure_http`
  仅能通过管理 API 打开，界面上已下线
