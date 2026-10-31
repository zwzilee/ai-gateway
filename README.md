# AI Gateway

跑在 Cloudflare Workers 上的 AI 聚合网关：把多个 OpenAI 兼容上游聚合成一个入口，对外提供标准 OpenAI 协议，自带多用户密钥、精确计费、额度控制和可视化管理后台。

## API Key 模型限制（本地修改版）

创建或编辑 API Key 时可选择“全部模型”或“指定模型”。模型列表按 Key 过滤，越权调用返回 403。现有 Key 默认保留全部模型权限；升级后可逐个修改。

使用规则、管理 API 和 Cloudflare 升级步骤见 [API Key 模型授权与部署](docs/API_KEY_MODEL_ACCESS.md)。

## 🚀 部署

全程**不需要填任何 ID**：D1 库会自动查找，没有就创建。

### 1. 连接 GitHub

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Create Worker** → **Connect Git repository**
2. 授权 GitHub，选这个仓库（或先 fork 一份到自己账号），点 **Begin setup**
3. **Build command 留空**，**把部署命令改成 `npm run deploy`**（默认的 `npx wrangler deploy` 会丢 D1 绑定）
4. 点 **Deploy**

部署完成会自动：建/找 D1 库 → 执行建表迁移 → 部署 Worker。之后站点会显示「尚未完成配置」页。

### 2. 补两个密钥

[Cloudflare 控制台](https://dash.cloudflare.com/) → 本 Worker → Settings → **Variables and Secrets** → Add，**类型选 Secret**，加这两个：

- `ADMIN_TOKEN` —— 后台登录密码，16 位以上随机串
- `ENCRYPTION_KEY` —— 加密主密钥，16 位以上随机串，加完不要改

加完点 **Deploy** 生效。

### 3. 登录后台

1. 数据表由部署命令自动建好（迁移是增量的，重复执行没有副作用）
2. 打开 `/admin`，用 `ADMIN_TOKEN` 登录
3. 按「上游渠道 → 模型与定价 → 用户 → API 密钥」的顺序把站点配起来

---

## 🔄 更新

同步上游最新代码：GitHub 上打开你的 fork → **Sync fork** → 合并上游，Cloudflare 会自动重新构建部署。

- 密钥、渠道配置、用户与用量记录都**不会丢**
- 每次部署都会重新写入 D1 绑定，不会出现「更新一次代码，数据库连接就没了」
- 若没 fork，直接 `git pull` 上游后 `npm run deploy` 即可

---

## ✨ 特性

- **OpenAI 兼容**：`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/moderations`、`/v1/models`，客户端只需改 `base_url`
- **多上游 + 25 家预设**：一个适配器覆盖所有 OpenAI 兼容平台，填地址和 Key 就能用
- **调度与容灾**：优先级 + 加权随机；失败自动换渠道；上游鉴权失效 / 欠费 / 限流按响应体识别并冷却；连续失败熔断
- **精确计费**：优先用上游 `usage`，流式自动注入 `include_usage`；缺失时按字符估算并标记；缓存命中单独计价
- **多用户**：用户 → 密钥两级，各自独立的额度 / RPM / 有效期；额度原子预扣，并发也扣不穿
- **密钥加密**：渠道 API Key 以 AES-256-GCM 加密后入库，后台不回显明文
- **零额外依赖**：只用一个 D1，不使用 KV / R2 / Durable Objects

---

## ❓ 常见问题

**为什么必须用 `npm run deploy`？**

`wrangler deploy` 会按配置文件**整体覆盖** Worker 的绑定，配置里没声明的绑定会被清掉——这就是「更新一次代码，数据库连接就没了」的根因。

但 `database_id` 每个账号不同，不能写死进仓库。所以仓库里的 `wrangler.jsonc` 故意不带 `database_id`，由 `npm run deploy` 在部署时自动生成一份带绑定的配置再部署。

| 命令 | D1 绑定 |
|---|---|
| `npm run deploy` | ✅ 自动处理 |
| `npx wrangler deploy` | ❌ 被清掉 |

**密钥必须存成 Secret 吗？**

必须。Cloudflare 把「环境变量」和「Secret」分开处理：

- **普通变量（Text）**：每次 `wrangler deploy` 都会按配置整体覆盖，控制台手动加的会被清空（官方「source of truth」机制）
- **Secret（加密变量）**：deploy 不会删，除非手动 `wrangler secret delete <key>`

`ADMIN_TOKEN`、`ENCRYPTION_KEY` 必须存成 Secret，否则每次重新部署都会消失，站点回到「尚未完成配置」页。

**站点一直显示「尚未完成配置」**

两个 Secret 还没加，或加的时候类型选成了 Text。到控制台 Variables and Secrets 补上即可。「尚未完成配置」页会逐项列出还差哪几个，以及生成随机串的命令。

**部署报错 `10021 binding DB must have a valid database_id`**

部署命令被改回了 `npx wrangler deploy`。改回 `npm run deploy` 即可。

**更新代码后后台显示「数据库尚未初始化」**

同上，D1 绑定被清掉了。用 `npm run deploy` 重新部署，数据仍在。

**「获取模型」报 525 / 526**

上游 CDN 回源 TLS 失败（常见于国内中转站海外线路），与本站无关。

**渠道提示「密钥无法解密」**

`ENCRYPTION_KEY` 被换过了。改回最初的值即可；实在找不回，就逐个渠道重新保存一次 API Key。

---

## 🔧 本地 / 命令行部署

```bash
npm install
npx wrangler login    # 首次：浏览器授权
npm run deploy        # 自动建库 + 建表 + 部署
```

首次运行会看到：

```
=== [1/4] 部署目标 ===
  Worker : ai-gateway
  D1     : ai-gateway（自动查找，没有就创建）
=== [2/4] 准备 D1 数据库并生成部署配置 ===
=== [3/4] 应用 D1 迁移 ===
=== [4/4] 部署 Worker ===
```

库 ID 缓存在 `.wrangler/d1.json`（已 gitignore）。以后重新部署会复用同一个库，数据不受影响。

> Workers Builds 检测到仓库里有 `pnpm-lock.yaml` 就会用 pnpm 装依赖（`pnpm install --frozen-lockfile`）。
> npm 与 pnpm 都能跑，命令都是 `npm run deploy`。

## 环境变量

### 运行时：只认这两个 Secret

必须从 Cloudflare 控制台添加（Settings → Variables and Secrets，类型选 **Secret**）：

| 名称 | 用途 | 备注 |
|---|---|---|
| `ADMIN_TOKEN` | 后台登录密码 | 忘了直接改成新值即可 |
| `ENCRYPTION_KEY` | 渠道密钥的加密主密钥 | 不要更换，换了已保存的渠道 Key 解不开 |

生成随机串：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

没有 `.env` 文件，密钥也不会出现在仓库或命令行里。重新部署不影响这两个值。命令行添加：

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ENCRYPTION_KEY
```

配置里**故意没写** `secrets.required`：wrangler 会把它当部署门槛，Secret 没加就拒绝部署，而 Secret 只能加到已存在的 Worker 上，首次部署会死锁。缺配置由代码检查，部署永远能成功，页面会说明还差哪几步。

### 部署期：不用配任何东西

D1 库由 `npm run deploy` 自动查找/创建，库 ID 缓存在 `.wrangler/d1.json`。其余配置（渠道、模型定价、用户、密钥、站点名称等）都从后台改，存在 D1 里。

## 目录

```
src/             Worker 源码（入口、路由、lib、两个内联 HTML 页面）
migrations/      D1 表结构迁移（只增不改）
scripts/         部署脚本（npm run deploy 的入口）
docs/            架构文档
wrangler.jsonc   Worker 配置（不含 D1 库 ID）
```

架构、调度规则、计费口径、容量上限、数据维护、安全建议见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
