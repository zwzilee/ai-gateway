import { expect } from 'bun:test';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as miniflare from 'miniflare';

const root = resolve(import.meta.dir, '..');
const ADMIN_TOKEN = 'test-admin-token-local-only';
export const legacyKey = 'sk-legacy-key-created-before-migration';

export async function createHarness() {
  const build = await Bun.build({
    entrypoints: [join(root, 'src/index.ts')], target: 'browser', format: 'esm',
    define: { __TEST_ENDPOINTS__: 'false', __BUILD_VERSION__: JSON.stringify('test') },
    plugins: [{ name: 'inline-html', setup(builder) {
      builder.onLoad({ filter: /\.html$/ }, async ({ path }) => ({
        contents: await readFile(path, 'utf8'), loader: 'text',
      }));
    } }],
  });
  if (!build.success) throw new AggregateError(build.logs, 'Worker test bundle failed');
  const directory = await mkdtemp(join(tmpdir(), 'gateway-model-access-'));
  const upstreamCalls: { path: string; body: any }[] = [];
  // Intercept every outbound request, including unexpected hosts. No public network is used.
  const options = {
    name: 'gateway', modules: true, script: await build.outputs[0]!.text(),
    compatibilityDate: '2025-09-23', d1Databases: ['DB'],
    bindings: { ADMIN_TOKEN, ENCRYPTION_KEY: 'test-encryption-key-local-only' },
    d1Persist: join(directory, 'd1'),
    outboundService: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      upstreamCalls.push({ path, body });
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if ((body as any).stream) {
        return new Response(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return Response.json({ id: 'test-response', object: 'chat.completion', model: (body as any).model,
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage });
    },
  };
  // Miniflare 5 alpha changed its constructor. Keep compatibility with stable v4 too.
  const adapter = (miniflare as any).convertV4MiniflareOptions;
  const mf = new miniflare.Miniflare(adapter ? adapter(options) : options as any);
  try {
    const db = await mf.getD1Database('DB', 'gateway');
    const files = (await readdir(join(root, 'migrations'))).filter(f => f.endsWith('.sql')).sort();
    const migration = '0013_api_key_allowed_models.sql';
    if (!files.includes(migration)) throw new Error(`Required migration missing: migrations/${migration}`);
    async function migrate(file: string) {
      // Strip SQL comments before splitting; these repository migrations contain no triggers.
      const sql = (await readFile(join(root, 'migrations', file), 'utf8')).replace(/--[^\n]*/g, '');
      const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
      await db.batch(statements.map(s => db.prepare(s)));
    }
    for (const file of files.filter(f => f < migration)) await migrate(file);
    await db.prepare("INSERT INTO users (id,name,quota_usd,created_at,updated_at) VALUES (1,'legacy user',100,1,1)").run();
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacyKey));
    const hex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    await db.prepare(`INSERT INTO api_keys (id,user_id,name,key_hash,key_prefix,key_last4,quota_usd,created_at)
      VALUES (1,1,'legacy key',?,'sk-lega','tion',100,1)`).bind(hex).run();
    const legacyBefore = await db.prepare('SELECT * FROM api_keys WHERE id=1').first();
    for (const file of files.filter(f => f >= migration)) await migrate(file);
    async function request(path: string, init: RequestInit = {}) {
      return mf.dispatchFetch(`https://gateway.test${path}`, init as any);
    }
    const login = await request('/admin/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^ag_session=/);
    async function admin(path: string, method = 'GET', body?: unknown) {
      return request(`/admin/api${path}`, { method, headers: {
        cookie: cookie!, 'content-type': 'application/json',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    async function json(response: any, status = 200): Promise<any> {
      const text = await response.text();
      expect({ status: response.status, ...(response.status !== status ? { body: text } : {}) }).toEqual({ status });
      return JSON.parse(text);
    }
    const user = await json(await admin('/users', 'POST', { name: 'test user', quota_usd: 100 }), 201);
    for (const id of ['allowed', 'blocked', 'disabled', 'unserved']) {
      await json(await admin('/models', 'POST', { id, enabled: id !== 'disabled', prompt_price: 100, completion_price: 200 }), 201);
    }
    await json(await admin('/channels', 'POST', { name: 'local mock', base_url: 'https://upstream.test',
      api_key: 'sk-test-upstream', models: { allowed: 'upstream-allowed', blocked: 'upstream-blocked', disabled: 'upstream-disabled' } }), 201);
    return { mf, db, directory, request, admin, json, userId: user.id as number, legacyBefore,
      upstreamCalls, async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
