import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';

const agents = [
  { id: 'dev', provider: 'demo', skills: ['code'] },
  { id: 'qa', provider: 'demo', skills: ['code', 'test'] }
];
const task = (id, more = {}) => ({ id, title: id, prompt: `Do ${id}`, skills: ['code'], ...more });
function fixture(t, provider) {
  const root = resolve('.orchestrator', 'tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'engine-'));
  t.after(() => {
    const rel = relative(root, resolve(dir));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(dir, { recursive: true, force: true });
  });
  return new Engine(new Store(dir), provider);
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  throw new Error('Timed out waiting for test condition');
}
const finished = run => !['running', 'paused'].includes(run.status);

test('parallel teams obey concurrency, dependencies and persist results', async t => {
  let active = 0, peak = 0;
  const engine = fixture(t, async (agent, { prompt }) => {
    peak = Math.max(peak, ++active); await delay(15); active--;
    return { text: `${agent.id}: ${prompt}`, usage: { total_tokens: 10 } };
  });
  const project = engine.createProject({ name: 'Parallel', agents, limits: { concurrency: 2 }, tasks: [task('a', { teamSize: 2 }), task('b'), task('c', { dependsOn: ['a', 'b'] })] });
  const run = engine.start(project.id);
  await until(() => finished(run));
  assert.equal(run.status, 'completed'); assert.equal(peak, 2); assert.equal(run.calls, 4);
  assert.equal(run.tasks[0].outputs.length, 2);
  const events = run.events.map(e => `${e.type}:${e.taskId}`);
  assert.ok(events.indexOf('task.started:c') > events.indexOf('task.completed:a'));
  assert.equal(new Store(engine.store.directory).data.runs[run.id].status, 'completed');
});

test('cycles, missing dependencies and duplicate IDs fail before execution', t => {
  const engine = fixture(t);
  assert.throws(() => engine.createProject({ name: 'x', agents, tasks: [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })] }), /cycle/);
  assert.throws(() => engine.createProject({ name: 'x', agents, tasks: [task('a', { dependsOn: ['missing'] })] }), /Unknown task/);
  assert.throws(() => engine.createProject({ name: 'x', agents, tasks: [task('a'), task('a')] }), /unique/);
});

test('edits create revisions without changing a running snapshot', async t => {
  const engine = fixture(t);
  const project = engine.createProject({ name: 'Before', agents, tasks: [task('a')] });
  const run = engine.start(project.id);
  const revised = engine.updateProject(project.id, { revision: 1, name: 'After' });
  assert.equal(revised.revision, 2); assert.equal(run.project.name, 'Before');
  assert.throws(() => engine.updateProject(project.id, { revision: 1 }), /conflict/);
  await until(() => finished(run));
});

test('failure blocks transitive dependants even with reverse ordering', async t => {
  const engine = fixture(t, async () => { throw new Error('offline'); });
  const project = engine.createProject({ name: 'x', agents, tasks: [task('c', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] }), task('a')] });
  const run = engine.start(project.id); await until(() => finished(run));
  assert.equal(run.status, 'failed'); assert.deepEqual(run.tasks.map(t => t.status), ['blocked', 'blocked', 'failed']);
});

test('call budget includes parallel agents and retries', async t => {
  const engine = fixture(t, async () => { throw new Error('offline'); });
  const project = engine.createProject({ name: 'x', agents, limits: { maxCalls: 2 }, tasks: [task('a', { teamSize: 2, retries: 2 })] });
  const run = engine.start(project.id); await until(() => finished(run));
  assert.equal(run.calls, 2); assert.equal(run.status, 'failed'); assert.match(run.tasks[0].error, /budget/);
});

test('pause drains active calls, resume starts queued calls', async t => {
  let count = 0;
  const engine = fixture(t, async () => { count++; await delay(30); return { text: 'ok' }; });
  const project = engine.createProject({ name: 'x', agents, limits: { concurrency: 1 }, tasks: [task('a'), task('b')] });
  const run = engine.start(project.id); await until(() => count === 1);
  engine.pause(run.id); await delay(60); assert.equal(count, 1);
  engine.resume(run.id); await until(() => finished(run)); assert.equal(count, 2);
});

test('cancel stops running and queued work', async t => {
  const engine = fixture(t, async (_, { signal }) => { await delay(1000, undefined, { signal }); return { text: 'late' }; });
  const project = engine.createProject({ name: 'x', agents, limits: { concurrency: 1 }, tasks: [task('a'), task('b')] });
  const run = engine.start(project.id); await until(() => run.calls === 1);
  engine.cancel(run.id); await until(() => engine.controls.get(run.id).active.size === 0);
  assert.equal(run.status, 'cancelled'); assert.ok(run.tasks.every(t => t.status === 'cancelled'));
});

test('individual task cancellation leaves independent work running', async t => {
  const engine = fixture(t, async (_, { signal }) => { await delay(40, undefined, { signal }); return { text: 'ok' }; });
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a'), task('b'), task('c', { dependsOn: ['a'] })] });
  const run = engine.start(project.id); await until(() => run.calls === 2);
  engine.cancelTask(run.id, 'a'); await until(() => finished(run));
  assert.deepEqual(run.tasks.map(t => t.status), ['cancelled', 'completed', 'blocked']);
});

test('approval gate prevents invocation until approved', async t => {
  const engine = fixture(t);
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a', { requiresApproval: true })] });
  const run = engine.start(project.id); assert.equal(run.calls, 0);
  engine.approve(run.id, 'a'); await until(() => finished(run)); assert.equal(run.status, 'completed');
});

test('pipeline passes previous results to the next agent', async t => {
  const prompts = [];
  const engine = fixture(t, async (_, { prompt }) => { prompts.push(prompt); return { text: `answer-${prompts.length}` }; });
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a', { agentIds: ['dev', 'qa'], mode: 'pipeline' })] });
  const run = engine.start(project.id); await until(() => finished(run)); assert.match(prompts[1], /answer-1/);
});

test('review rejects, retries with feedback, then accepts', async t => {
  let reviews = 0; const prompts = [];
  const engine = fixture(t, async (agent, { prompt }) => {
    prompts.push(prompt);
    return { text: agent.id === 'qa' ? JSON.stringify({ approved: ++reviews > 1, feedback: 'add tests' }) : 'implementation' };
  });
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a', { agentIds: ['dev'], reviewerId: 'qa', retries: 1 })] });
  const run = engine.start(project.id); await until(() => finished(run));
  assert.equal(run.status, 'completed'); assert.equal(run.calls, 4); assert.match(prompts[2], /add tests/);
});

test('delegated children finish before parent synthesis and downstream tasks', async t => {
  let calls = 0;
  const engine = fixture(t, async () => ({ text: ++calls === 1 ? JSON.stringify({ subtasks: [{ title: 'Child', prompt: 'Research', skills: ['test'] }] }) : `result-${calls}` }));
  const project = engine.createProject({ name: 'x', agents, tasks: [task('parent', { allowDelegation: true }), task('next', { dependsOn: ['parent'] })] });
  const run = engine.start(project.id); await until(() => finished(run));
  assert.equal(run.status, 'completed'); assert.equal(run.tasks.length, 3); assert.equal(run.calls, 4);
  assert.equal(run.tasks[2].parentId, 'parent'); assert.equal(run.tasks[2].depth, 1);
});

test('invalid delegation does not insert partial children', async t => {
  const engine = fixture(t, async () => ({ text: JSON.stringify({ subtasks: [{ title: 'valid', prompt: 'ok' }, { title: 'bad' }] }) }));
  const project = engine.createProject({ name: 'x', agents, tasks: [task('parent', { allowDelegation: true })] });
  const run = engine.start(project.id); await until(() => finished(run)); assert.equal(run.status, 'failed'); assert.equal(run.tasks.length, 1);
});

test('workspace CLI jobs serialize across runs', async t => {
  let active = 0, peak = 0;
  const engine = fixture(t, async () => { peak = Math.max(peak, ++active); await delay(20); active--; return { text: 'ok' }; });
  const project = engine.createProject({ name: 'x', agents: [{ id: 'dev', provider: 'codex', skills: ['code'] }], tasks: [task('a'), task('b')] });
  const one = engine.start(project.id), two = engine.start(project.id);
  await until(() => finished(one) && finished(two)); assert.equal(peak, 1);
});

test('restart marks unfinished work interrupted instead of replaying edits', t => {
  const engine = fixture(t);
  const project = engine.createProject({ name: 'x', agents, tasks: [task('a', { requiresApproval: true })] });
  const run = engine.start(project.id);
  const recovered = new Store(engine.store.directory).data.runs[run.id];
  assert.equal(recovered.status, 'interrupted');
});
