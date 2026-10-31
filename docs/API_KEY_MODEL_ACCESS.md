# API Key 模型授权与部署

本项目基于 https://github.com/zwzilee/ai-gateway ，修改基线为 `80aa6ff`。

## 使用方式

1. 先在后台「模型与定价」配置对外模型，并配置能提供这些模型的上游渠道。
2. 给不同用户分别创建 API Key，在「模型权限」中选择全部模型或指定模型。
3. 可以编辑现有 Key 的权限，无需更换 Key。用户通过自己的 Key 查询 `/v1/models` 时，只会看到已授权且启用、存在可服务渠道的模型。
4. 调用未授权模型返回 HTTP 403，错误码为 `model_not_allowed`，不转发上游，也不扣模型用量额度。鉴权阶段原有 RPM 限制仍生效，失败请求仍可能留下审计记录。

权限属于 Key。同一用户持有多个 Key 时，各 Key 独立授权；如果用户仍持有“全部模型”的旧 Key，该 Key 依然可以调用所有全局可用模型。升级后请检查现有 Key 并收紧权限。

“全部模型”自动包含未来添加的模型；“指定模型”不会因新增其他模型而扩大授权。选择指定模式但不勾选任何模型表示禁止全部模型。模型 ID 区分大小写，按网关对外 ID 精确匹配，渠道上游模型映射不影响授权。

删除模型不会删除 Key 中保存的授权 ID；以后重新添加同名 ID 会恢复该 ID 的可调用性。授权不会绕过模型停用、渠道可用性、用户状态、额度、到期时间等原有检查。

## 管理 API

`POST /admin/api/keys` 和 `PUT /admin/api/keys/:id` 支持字段：

```json
{ "allowed_models": ["gpt-4o-mini", "your-public-model-id"] }
```

- `null`：全部模型。
- `[]`：禁止所有模型。
- 字符串数组：仅指定模型；最多 1000 个 ID，每个 ID 最多 200 字符，不允许空字符串或首尾空格，重复 ID 自动合并。
- 创建时省略字段：默认全部模型，兼容原有调用方式。
- 编辑时省略字段：保持原权限。

接口允许预先授权尚未配置的模型 ID，它们在全局模型和渠道配置完成前无法调用。`GET /admin/api/keys` 返回解析后的 `allowed_models`。

## Cloudflare 部署 / 升级

本次交付为本地源码，尚未上传 GitHub，也未部署到 Cloudflare。

### 已有站点升级

将本项目的修改推送到你用于 Cloudflare 构建的仓库，部署命令保持 `npm run deploy`。该脚本会自动应用新增迁移 `0013_api_key_allowed_models.sql`，然后部署 Worker。迁移只向 `api_keys` 增加一个可空字段，不删除现有数据；旧 Key 默认全部模型。

本项目没有改变 Worker 名称、D1 库名和密钥设置。请核对部署目标是你需要升级的站点。

### 新建站点

按根目录 README 连接 Git 仓库，Build command 留空，Deploy command 设为 `npm run deploy`；首次部署后添加 Secret 类型的 `ADMIN_TOKEN` 和 `ENCRYPTION_KEY`。

如使用本地命令部署，在项目目录安装依赖、登录 Cloudflare 后执行：

```sh
bun install
bun x wrangler login
bun run deploy
```

`npm run deploy` 也是上游原有的受支持入口。不要改成直接 `wrangler deploy`，否则可能覆盖 D1 绑定。

## 本地验证

```sh
bun run typecheck
bun test ./tests --timeout 60000
bun x wrangler deploy --dry-run --outdir .wrangler/model-access-build
```

本次验证结果：45 项测试通过、0 失败，共 305 次断言；TypeScript 检查和 Wrangler 生产打包通过。测试使用本地 workerd / D1，覆盖旧 Key 迁移、管理 API 创建与编辑、模型列表过滤、四类代理端点、流式请求和越权请求不转发、不扣费。上游响应为模拟数据，未连接真实模型供应商；管理界面内联脚本语法检查通过，未做浏览器端人工交互测试。

## 数据结构

`api_keys.allowed_models` 使用可空 JSON 数组文本，一次 SQL 更新即可原子修改整份授权，Key 或用户删除时无需清理关联权限表。数据库检查 JSON 数组格式，应用层严格验证内容；遇到损坏的授权数据时按禁止全部模型处理。
