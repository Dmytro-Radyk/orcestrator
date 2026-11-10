import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { createApi } from '../src/server.js';

test('HTTP API authenticates, creates, edits, approves and completes a project run', async t => {
  const engine = new Engine({ data: { projects: {}, runs: {} }, save() {} }, async () => ({ text: 'done' }));
  const { server, token } = createApi(engine);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', data, headers = {}) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(data ? { body: JSON.stringify(data) } : {})
  });
  assert.equal((await fetch(base + '/health')).status, 401);
  assert.equal((await call('/health', 'GET', undefined, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await call('/health')).status, 200);
  const created = await call('/projects', 'POST', { name: 'HTTP', agents: [{ id: 'dev', provider: 'demo', skills: ['code'] }], tasks: [{ id: 'a', title: 'A', prompt: 'Build', skills: ['code'], requiresApproval: true }] });
  assert.equal(created.status, 201); const project = await created.json();
  const revised = await (await call(`/projects/${project.id}`, 'PUT', { revision: 1, name: 'Updated' })).json();
  assert.equal(revised.revision, 2);
  assert.equal((await call(`/projects/${project.id}`, 'PUT', { revision: 1 })).status, 400);
  const launched = await call(`/projects/${project.id}/runs`, 'POST'); assert.equal(launched.status, 202);
  const run = await launched.json(); assert.equal(run.tasks[0].status, 'awaiting_approval');
  await call(`/runs/${run.id}/approve/a`, 'POST');
  let current;
  for (let i = 0; i < 100; i++) {
    current = await (await call(`/runs/${run.id}`)).json();
    if (current.status === 'completed') break;
    await delay(10);
  }
  assert.equal(current.status, 'completed'); assert.equal(current.revision, 2);
  const events = await (await call(`/runs/${run.id}/events`)).json();
  assert.ok(events.some(e => e.type === 'task.approved'));
  assert.equal((await call('/missing')).status, 404);
});
