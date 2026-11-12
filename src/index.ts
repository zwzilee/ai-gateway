/**
 * AI 中转站入口。
 *
 * 路由划分：
 *   /admin, /admin/*     管理后台（HTML 单页 + 子路由，未登录跳回首页）
 *   /admin/api/*         管理 JSON API
 *   /                     公开首页（登录入口，不再自动跳转管理后台）
 *   /v1/models            模型列表（下游鉴权）
 *   /v1/responses         Responses API 入口（下游鉴权；原生透传或网关内翻译）
 *   /v1/responses/:id     按 id 取回响应（当前实例内存中缓存的最近 32 条）
 *   /v1/*                 上游代理（下游鉴权）
 *
 * 不注册定时任务：用量明细的清理、会话回收、余额刷新都有对应的管理端入口，
 * 由管理员按需触发（见 admin.ts 的 POST /maintenance/prune）。
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import adminHtml from './admin/index.html';
import homeHtml from './home/index.html';
import { requireAdmin } from './lib/adminAuth.js';
import { DEFAULT_SITE_NAME, checkSecrets } from './lib/bootstrap.js';
import { getSetting } from './lib/db.js';
import { apiErrorPayload, renderSetupPage } from './lib/setup.js';
import { errorResponse } from './lib/errors.js';
import { adminApi } from './routes/admin.js';
import { handleUserBalance } from './routes/balance.js';
import {
  handleCountTokens,
  handleGetResponse,
  handleModels,
  handleProxy,
} from './routes/openai.js';
import type { Env } from './types.js';

/**
 * 测试辅助端点是否打包进本次构建。
 *
 * 由 wrangler.jsonc 的 define 注入：`npm run dev` 为 true，`npm run build` / 正式部署为
 * false。闭包里的值在打包时就被替换成字面量，正式构建里依赖它的整段代码连同一个
 * 动态 import 都会被摇掉 —— 部署产物里根本没有这个路由，也不存在「变量没配对就漏出来」。
 */
const TEST_ENDPOINTS = ((): boolean => __TEST_ENDPOINTS__)();

const app = new Hono<{ Bindings: Env }>();

/**
 * 折叠重复的 /v1 前缀。
 *
 * 不少客户端把「API 域名」和「API 路径」拼起来用（ChatBox 就是其中之一）。
 * 若用户把域名填成 https://host/v1（因为通用文档都这么写），客户端再拼自带的
 * /v1/chat/completions，实际请求就会变成 /v1/v1/...，表现为 404「未知端点」——
 * 用户看到的却是「无法获取模型」。这里静默折叠掉重复的一段，两种填法都能用。
 */
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  // 一次折叠掉全部重复前缀：逐层剥离会随 URL 长度递归，几 KB 就能打爆调用栈，
  // 且发生在鉴权之前
  const collapsed = url.pathname.replace(/^(\/v1)+(?=\/)/, '/v1');
  if (collapsed !== url.pathname) {
    url.pathname = collapsed;
    return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx);
  }
  await next();
});

app.onError((err, c) => {
  const res = errorResponse(err);
  // 鉴权/路径类失败往往是客户端配置问题，带上路径与 UA 记录一次，
  // 便于配合 wrangler tail 直接看出「是哪个软件、请求了什么」。
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/v1')) {
      console.warn(
        `[v1] ${c.req.method} ${path} -> ${res.status} ua="${c.req.header('user-agent') ?? ''}"`,
      );
    }
  }
  return res;
});

/**
 * 未完成配置时的统一拦截。
 *
 * 与 qq-bot-cf 一致：缺 Secret（或库还没建表）不让部署失败，而是在代码里拦下来，
 * 给部署者一个「还差哪几步」的说明页。规则：
 *   * 页面请求 → 说明页（任何路径都显示，因为这时什么都用不了）
 *   * API 请求 → 503 + OpenAI 风格 JSON（客户端能解析，不会收到一坨 HTML）
 *   * 健康检查 / 静态站点图标 → 放行，不参与拦截
 */
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/healthz' || path === '/favicon.ico') {
    return next();
  }

  const status = await checkSecrets(c.env);
  if (status.state === 'ok') {
    return next();
  }

  // mismatch：主密钥与库中密文对不上（换了 ENCRYPTION_KEY）。这与「还没配好」不同——
  // 站点其实已经部署过、有数据，只是密钥对不上。此时：
  //   * 页面请求（/、/admin 等 GET）放行，让管理员正常登录后台，在设置页用旧密钥恢复；
  //   * /admin/api/auth 与 /admin/api/settings 放行（ADMIN_TOKEN 独立于 ENCRYPTION_KEY，
  //     管理员仍可登录、调用 POST /settings/reencrypt 就地恢复；这些端点内部有 requireAdmin 兜底）；
  //   * 其余 API（/v1、其他 /admin/api）照常拦成 503（渠道密钥解不开，代理必然失败）。
  if (status.state === 'mismatch') {
    const isApi =
      path.startsWith('/v1') ||
      path.startsWith('/user') ||
      path.startsWith('/admin/api') ||
      c.req.method !== 'GET';
    if (!isApi) return next();
    if (path.startsWith('/admin/api/auth') || path.startsWith('/admin/api/settings')) {
      return next();
    }
    const { status: code, body } = apiErrorPayload(status);
    return c.json(body, code as 503);
  }

  const isApi =
    path.startsWith('/v1') ||
    path.startsWith('/user') ||
    path.startsWith('/admin/api') ||
    c.req.method !== 'GET';
  if (isApi) {
    const { status: code, body } = apiErrorPayload(status);
    return c.json(body, code as 503);
  }

  // 用 200 而不是 503：浏览器与监控不会把它当成故障，页面本身已说明「尚未完成配置」
  return c.html(renderSetupPage(status, DEFAULT_SITE_NAME), 200, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
});

/**
 * 下游 API 的 CORS。
 *
 * 浏览器上下文的客户端（ChatBox 桌面的渲染进程、各类 Web 版客户端、移动端 WebView）
 * 在发送带 Authorization 的跨域请求前会先发 OPTIONS 预检。此前网关没有 CORS：
 * 预检直接落到 404「未知端点」，真正的请求根本发不出去 —— 表现为客户端「获取不到模型」，
 * 而且日志里查不到任何记录（请求从未到达 Worker）。
 *
 * 下游 API 用 Bearer Key 鉴权、不依赖 Cookie，因此放开为 `*` 是安全的；
 * 管理 API（/admin/api/*）用会话 Cookie，刻意不在此列，避免扩大攻击面。
 */
const corsOptions = {
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: [
    'authorization',
    'content-type',
    'accept',
    'x-api-key',
    'api-key',
    'anthropic-version',
    'x-requested-with',
  ],
  // 让浏览器端能读到网关注入的排查用响应头
  exposeHeaders: ['x-request-id', 'x-gateway-channel', 'x-gateway-attempts'],
  maxAge: 86_400,
};

// /v1/* 覆盖转发与 /v1/user/balance；/user/* 覆盖裸路径的余额查询，
// 两条路径都要带 CORS，否则浏览器端只有带 /v1 的那种写法能用
app.use('/v1/*', cors(corsOptions));
app.use('/user/*', cors(corsOptions));

// ---------------------------------------------------------------- 管理后台

/**
 * 测试辅助端点。
 *
 * 会直接改写用量数据，只存在于本地开发 / 测试构建（见上面的 TEST_ENDPOINTS）。
 * 部署代码里没有这个路由，也不受任何运行时变量控制；即便在本地，也要求有效管理会话。
 */
if (TEST_ENDPOINTS) {
  const { testApi } = await import('./routes/test.js');
  app.use('/admin/api/__test__/*', async (c, next) => {
    await requireAdmin(c.req.raw, c.env);
    await next();
  });
  app.route('/admin/api/__test__', testApi);
}

app.route('/admin/api', adminApi);

app.get('/admin', async (c) => {
  // 未登录访问管理后台一律回到首页：只有登录成功后才能进入 /admin
  try {
    await requireAdmin(c.req.raw, c.env);
  } catch {
    return c.redirect('/', 302);
  }
  return c.html(adminHtml, 200, {
    // 管理界面始终从服务器取最新版本，避免缓存导致前后端不一致
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
});

// 管理后台子路由（/admin/overview、/admin/channels、/admin/models …）：
// 服务端只做「未登录 302 回首页 / 已登录返回 SPA」两件事；页签切换由前端
// History API 在客户端完成，正常点击导航不会产生额外 HTTP / Worker 请求。
app.get('/admin/*', async (c) => {
  try {
    await requireAdmin(c.req.raw, c.env);
  } catch {
    return c.redirect('/', 302);
  }
  return c.html(adminHtml, 200, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
});

// 公开首页：不再自动跳转管理后台
// 示例里的域名按请求实际域名渲染：同一份代码部署在多个账号，写死会把别人的实例指向我们
const HOME_ORIGIN_PLACEHOLDER = '__ORIGIN__';
const SITE_NAME_PLACEHOLDER = '__SITE_NAME__';
const renderHome = (origin: string) => homeHtml.replaceAll(HOME_ORIGIN_PLACEHOLDER, origin);

/** 站点名称要原样插进 HTML，先转义 */
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * 首页同时告诉访客「这是谁的站」：站点名称存在 D1 的 settings 表里（默认 AI 中转站）。
 * 库还没迁移时照样能打开首页 —— 只显示默认名，不让登录入口跟着挂掉。
 */
app.get('/', async (c) => {
  let siteName: string | null = null;
  try {
    siteName = await getSetting(c.env.DB, 'site_name');
  } catch {
    siteName = null;
  }

  const html = renderHome(new URL(c.req.url).origin).replaceAll(
    SITE_NAME_PLACEHOLDER,
    escapeHtml(siteName || DEFAULT_SITE_NAME),
  );
  return c.html(html, 200, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
});

app.get('/healthz', (c) => c.json({ ok: true, ts: Date.now() }));

// ---------------------------------------------------------------- OpenAI 兼容

// 下游查余额：cc-switch「用量查询 → 通用模板」打的就是这个路径，
// 两种前缀与尾斜杠都接受，省得用户为了一个斜杠排查半天
app.get('/user/balance', (c) => handleUserBalance(c.req.raw, c.env));
app.get('/user/balance/', (c) => handleUserBalance(c.req.raw, c.env));
app.get('/v1/user/balance', (c) => handleUserBalance(c.req.raw, c.env));
app.get('/v1/user/balance/', (c) => handleUserBalance(c.req.raw, c.env));

app.get('/v1/models', (c) => handleModels(c.req.raw, c.env));

// 容忍尾斜杠：部分客户端会拼出 /v1/models/
app.get('/v1/models/', (c) => handleModels(c.req.raw, c.env));

/*
 * 取回单条响应（Responses 的 store / previous_response_id 支撑）。
 *
 * 必须放在 app.post('/v1/*') 之前声明：Hono 先按路径模式匹配，再按方法分发，
 * 通配的 POST 捕获器不会吞掉这里的 GET。
 */
app.get('/v1/responses/:id', (c) => handleGetResponse(c.req.raw, c.env));

// Anthropic 的 token 计数探针：Claude Code 等客户端发长上下文前会先调它。
// 必须在 app.post('/v1/*') 之前，否则会被当成普通 Messages 请求转发出去。
app.post('/v1/messages/count_tokens', (c) => handleCountTokens(c.req.raw, c.env));

app.post('/v1/*', (c) => handleProxy(c.req.raw, c.env, c.executionCtx));

// 未匹配的路径给出与 OpenAI 风格一致的错误，而不是 Hono 默认的 404 文本
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  // 打错的路径（漏写 /v1、多写尾斜杠、Anthropic 的 /v1/messages 等）在这里留痕
  console.warn(`[404] ${c.req.method} ${path} ua="${c.req.header('user-agent') ?? ''}"`);
  return c.json(
    {
      error: {
        message: `未知端点 ${c.req.method} ${path}`,
        type: 'invalid_request_error',
        param: null,
        code: 'not_found',
      },
    },
    404,
  );
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
