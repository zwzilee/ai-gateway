import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHarness, legacyKey } from './workerHarness';

// Run: bun test ./tests --timeout 60000
// Uses real local workerd/D1, production routes and login, and an in-process upstream.
// No deployment, Cloudflare account, external network, or package.json changes required.
describe('model access through the production Worker', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeAll(async () => { h = await createHarness(); }, 60_000);
  afterAll(async () => { await h?.close(); }, 30_000);

  async function key(policy?: unknown) {
    return h.json(await h.admin('/keys', 'POST', { user_id: h.userId, quota_usd: 100,
      ...(policy === undefined ? {} : { allowed_models: policy }) }), 201);
  }
  async function listed(id: number) {
    const result = await h.json(await h.admin('/keys'));
    return result.items.find((item: any) => item.id === id);
  }
  async function models(token: string, path = '/v1/models') {
    const result = await h.json(await h.request(path, { headers: { authorization: `Bearer ${token}` } }));
    expect(result.object).toBe('list');
    return result.data.map((model: any) => model.id);
  }
  async function proxy(token: string, model: string, path = '/v1/chat/completions', stream = false) {
    const response = await h.request(path, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], input: 'hello',
      prompt: 'hello', max_tokens: 5, stream }) });
    const text = await response.text(); // Finish streams before inspecting asynchronous settlement.
    return { status: response.status, text, body: stream && response.status === 200 ? null : JSON.parse(text) };
  }
  async function balance(id: number) {
    return h.db.prepare(`SELECT k.used_usd AS key_used, u.used_usd AS user_used FROM api_keys k
      JOIN users u ON u.id=k.user_id WHERE k.id=?`).bind(id).first();
  }
  async function waitForLog(id: number, previousCount: number) {
    // Poll a concrete completion condition, rather than assume waitUntil finished on response.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await h.db.prepare('SELECT * FROM usage_logs WHERE key_id=? ORDER BY id').bind(id).all();
      if (rows.results.length > previousCount) return rows.results.at(-1) as any;
      await Bun.sleep(10);
    }
    throw new Error(`Usage settlement did not finish for key ${id}`);
  }

  test('migration retains every legacy field and defaults old and new inserts to unrestricted', async () => {
    const after = await h.db.prepare('SELECT * FROM api_keys WHERE id=1').first();
    expect(after).toEqual({ ...h.legacyBefore, allowed_models: null });
    const columns = await h.db.prepare('PRAGMA table_info(api_keys)').all();
    expect(columns.results.find((c: any) => c.name === 'allowed_models')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect((await listed(1)).allowed_models).toBeNull();
    for (const invalid of ['{broken', 'null', '{}', '"allowed"']) {
      await expect(h.db.prepare('UPDATE api_keys SET allowed_models=? WHERE id=1').bind(invalid).run())
        .rejects.toThrow('CHECK constraint failed');
    }
    expect((await listed(1)).allowed_models).toBeNull();
    const created = await key();
    expect((await listed(created.id)).allowed_models).toBeNull();
    expect(await models(legacyKey)).toEqual(['allowed', 'blocked']);
    expect((await proxy(legacyKey, 'allowed')).status).toBe(200);
    await waitForLog(1, 0);
  });

  test('admin create/read/update/delete preserves null, empty, deduplication and omitted PUT', async () => {
    const created = await key(['blocked', 'allowed', 'blocked']);
    expect((await listed(created.id)).allowed_models).toEqual(['blocked', 'allowed']);
    const stored = await h.db.prepare('SELECT allowed_models FROM api_keys WHERE id=?').bind(created.id).first();
    expect(JSON.parse(stored!.allowed_models as string)).toEqual(['blocked', 'allowed']);
    expect(await listed(created.id)).not.toHaveProperty('key_hash');
    expect(await listed(created.id)).not.toHaveProperty('key');
    await h.json(await h.admin(`/keys/${created.id}`, 'PUT', { name: 'renamed' }));
    expect((await listed(created.id)).allowed_models).toEqual(['blocked', 'allowed']);
    for (const policy of [[], null, ['allowed']]) {
      await h.json(await h.admin(`/keys/${created.id}`, 'PUT', { allowed_models: policy }));
      expect((await listed(created.id)).allowed_models).toEqual(policy);
    }
    await h.json(await h.admin(`/keys/${created.id}`, 'DELETE'));
    expect(await listed(created.id)).toBeUndefined();
    expect((await proxy(created.key, 'allowed')).status).toBe(401);
  });

  test('admin rejects invalid policies on both POST and PUT without mutating a valid key', async () => {
    const created = await key(['allowed']);
    const invalid = ['allowed', {}, true, [''], [' allowed'], ['allowed '], [null], ['allowed', 1],
      ['x'.repeat(201)], Array(1001).fill('allowed')];
    const before = await h.db.prepare('SELECT COUNT(*) AS n FROM api_keys').first();
    for (const allowed_models of invalid) {
      for (const [path, method, body] of [
        ['/keys', 'POST', { user_id: h.userId, allowed_models }],
        [`/keys/${created.id}`, 'PUT', { name: 'must-not-save', allowed_models }],
      ] as const) {
        const result = await h.json(await h.admin(path, method, body), 400);
        expect(result.error.param).toBe('allowed_models');
      }
    }
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM api_keys').first()).toEqual(before);
    expect(await listed(created.id)).toMatchObject({ name: '', allowed_models: ['allowed'] });
  });

  test('model list intersects the key policy with enabled and servable models on every list alias', async () => {
    for (const [policy, expected] of [[null, ['allowed', 'blocked']], [[], []],
      [['allowed', 'disabled', 'unserved', 'future-model'], ['allowed']]] as const) {
      const created = await key(policy);
      for (const path of ['/v1/models', '/v1/models/', '/v1/v1/models']) {
        expect(await models(created.key, path)).toEqual(expected);
      }
    }
    const created = await key(['unserved']);
    await h.db.prepare('UPDATE channels SET allow_all_models=1').run();
    try { expect(await models(created.key)).toEqual(['unserved']); }
    finally { await h.db.prepare('UPDATE channels SET allow_all_models=0').run(); }
  });

  for (const endpoint of ['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/moderations']) {
    test(`${endpoint} denies before reservation/upstream and still serves allowed models`, async () => {
      const created = await key(['allowed']);
      const before = await balance(created.id);
      const calls = h.upstreamCalls.length;
      const denied = await proxy(created.key, 'blocked', endpoint);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({ code: 'model_not_allowed', param: 'model' });
      const deniedLog = await waitForLog(created.id, 0);
      expect(deniedLog).toMatchObject({ status_code: 403, cost_usd: 0, total_tokens: 0, channel_id: null });
      expect(await balance(created.id)).toEqual(before);
      expect(h.upstreamCalls).toHaveLength(calls);
      const allowed = await proxy(created.key, 'allowed', endpoint);
      expect(allowed.status).toBe(200);
      expect(h.upstreamCalls.at(-1)).toMatchObject({ path: endpoint, body: { model: 'upstream-allowed' } });
      const log = await waitForLog(created.id, 1);
      expect(log).toMatchObject({ status_code: 200, model: 'allowed', upstream_model: 'upstream-allowed', total_tokens: 15 });
      expect(log.cost_usd).toBeCloseTo(0.002, 8);
      expect((await balance(created.id))!.key_used).toBeCloseTo(0.002, 8);
    });
  }

  test('empty and corrupt policies deny all without calls or debits', async () => {
    const created = await key([]);
    let count = 0;
    const before = await balance(created.id);
    const calls = h.upstreamCalls.length;
    for (const raw of ['[]', '["allowed",123]', '[" allowed"]', '[null]']) {
      await h.db.prepare('UPDATE api_keys SET allowed_models=? WHERE id=?').bind(raw, created.id).run();
      expect(await models(created.key)).toEqual([]);
      const denied = await proxy(created.key, 'allowed');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('model_not_allowed');
      await waitForLog(created.id, count++);
    }
    expect(await balance(created.id)).toEqual(before);
    expect(h.upstreamCalls).toHaveLength(calls);
  });

  test('authorization runs before quota reservation and uses downstream IDs before mapping', async () => {
    const created = await key(['upstream-allowed']);
    // Not exhausted at authentication, but far too small for reservation. A denied model must yield 403.
    await h.db.prepare('UPDATE api_keys SET quota_usd=0.000000001 WHERE id=?').bind(created.id).run();
    const denied = await proxy(created.key, 'allowed');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('model_not_allowed');
    await waitForLog(created.id, 0);
    expect((await balance(created.id))!.key_used).toBe(0);
  });

  test('streaming and normalized duplicate-prefix routes enforce the same policy', async () => {
    const created = await key(['allowed']);
    const calls = h.upstreamCalls.length;
    const denied = await proxy(created.key, 'blocked', '/v1/v1/chat/completions/', true);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('model_not_allowed');
    await waitForLog(created.id, 0);
    expect(h.upstreamCalls).toHaveLength(calls);
    const allowed = await proxy(created.key, 'allowed', '/v1/v1/chat/completions/', true);
    expect(allowed.status).toBe(200);
    expect(allowed.text).toContain('[DONE]');
    await waitForLog(created.id, 1);
  });

  test('model policy never bypasses admin or downstream authentication', async () => {
    expect((await h.request('/admin/api/keys')).status).toBe(401);
    expect((await h.request('/v1/models')).status).toBe(401);
    expect((await proxy('sk-nonexistent-key-123456789', 'allowed')).status).toBe(401);
  });
});
