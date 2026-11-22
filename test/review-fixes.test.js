import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { normalizeReportChecks } from '../src/execution-report.js';
import { metadataRpc } from '../src/metadata-rpc.js';
import { withStorefrontAcceptance, verifyStorefrontEvidence, storefrontAcceptanceId } from '../src/storefront-quality.js';
import { applyWorkerChanges, sandboxChecks } from '../scripts/file-worker.js';
import { planningHandler } from '../scripts/planning-service.js';
import { createExecutionService } from '../scripts/execution-service.js';
import { deriveProjectName } from '../apps/web/src/create-project.js';
import { serializeWorkspaceState } from '../apps/web/src/execution.js';
import { saveProjectDraft, restoreProjectDraft } from '../apps/web/src/project-draft.js';

async function tempDir(t, prefix) {
  const root = resolve('.orchestrator/tests');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, prefix));
  t.after(async () => {
    const rel = relative(root, dir);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function settled(run) {
  for (let n = 0; n < 1500; n++) {
    if (!['running', 'paused'].includes(run.status)) return;
    await delay(10);
  }
  throw Error('Run timed out');
}

test('WorkspaceManager rejects secret symlinks, directory force-adds, glob pathspecs and rogue self-commits', async t => {
  const dir = await tempDir(t, 'ws-hardening-');
  const workspace = join(dir, 'projects', 'app');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'readme.txt'), 'init');
  const manager = new WorkspaceManager(join(dir, 'jobs'), { allowedRoot: join(dir, 'projects') });
  const lease = await manager.prepare({ id: 'run-1', project: { workspace } }, { id: 'task-1' });

  // 1. Directory force-add containing .env
  await mkdir(join(lease.cwd, 'sub'), { recursive: true });
  await writeFile(join(lease.cwd, 'sub', '.env'), 'SECRET=1');
  await assert.rejects(manager.stageCandidate({ ...lease, files: ['sub'] }), /звичайні файли|заборонений/i);
  await rm(join(lease.cwd, 'sub'), { recursive: true, force: true });

  // 2. Glob pathspec targeting .env (literalPathspecs prevents matching .env)
  await writeFile(join(lease.cwd, '.env'), 'SECRET=1');
  await assert.rejects(manager.stageCandidate({ ...lease, files: ['.en[v]'] }));

  // 3. Symlink to .env
  let createdSymlink = true;
  try {
    await symlink(join(lease.cwd, '.env'), join(lease.cwd, '.env_bypass'));
  } catch {
    createdSymlink = false;
  }
  if (createdSymlink) {
    await assert.rejects(manager.stageCandidate({ ...lease, files: ['.env_bypass'] }), /Symlink|Символічн/i);
    await rm(join(lease.cwd, '.env_bypass'), { force: true });
  }
  await rm(join(lease.cwd, '.env'), { force: true });

  // 4. Rogue self-commit advancing HEAD inside worktree
  await writeFile(join(lease.cwd, 'ok.txt'), 'ok');
  await manager.git(lease.cwd, ['add', '--', 'ok.txt']);
  await manager.git(lease.cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'rogue']);
  await assert.rejects(manager.stageCandidate({ ...lease, files: ['ok.txt'] }), /commit/i);
});

test('file-worker rejects leading-dash filenames, non-boolean delete, adds -- separator and fails zero-test TAP output', async t => {
  const cwd = await tempDir(t, 'fw-hardening-');
  await assert.rejects(applyWorkerChanges(cwd, [{ path: '--test-name-pattern=x.mjs', baseHash: null, content: 'x' }]));
  await assert.rejects(applyWorkerChanges(cwd, [{ path: 'sub/-flag.mjs', baseHash: null, content: 'x' }]));
  await assert.rejects(applyWorkerChanges(cwd, [{ path: 'safe.mjs', baseHash: null, delete: 'false' }]));

  await writeFile(join(cwd, 'a.test.mjs'), '');
  let capturedArgs;
  const zeroTap = await sandboxChecks(cwd, ['a.test.mjs'], {
    signal: AbortSignal.timeout(2000),
    command: 'trusted-sandbox',
    run: async (_cmd, args) => {
      capturedArgs = args;
      return 'TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n';
    }
  });
  assert.ok(capturedArgs.includes('--'));
  assert.ok(capturedArgs.indexOf('--') < capturedArgs.indexOf('a.test.mjs'));
  assert.equal(zeroTap.status, 'failed');

  const okTap = await sandboxChecks(cwd, ['a.test.mjs'], {
    signal: AbortSignal.timeout(2000),
    command: 'trusted-sandbox',
    run: async () => 'TAP version 13\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n'
  });
  assert.equal(okTap.status, 'passed');
});

test('metadata-rpc ignores null and array JSON stdout lines without crashing', async () => {
  const script = `
    process.stdout.write('null\\n[]\\n');
    process.stdin.once('data', () => {
      process.stdout.write(JSON.stringify({ id: 1, result: { ok: true } }) + '\\n');
    });
  `;
  const rpc = metadataRpc(process.execPath, ['-e', script]);
  try {
    const value = await rpc.request('initialize', {});
    assert.deepEqual(value, { ok: true });
  } finally {
    await rpc.close();
  }
});

test('engine settles depth-2 delegated grandchild failure without deadlock and blocks read-only write escalation', async t => {
  const dir = await tempDir(t, 'engine-hardening-');
  const engine = new Engine(new Store(join(dir, 'data')), async (agent, ctx) => {
    if (ctx.prompt.includes('Task: root')) {
      return { text: 'split', delegation: [{ title: 'child', prompt: 'run child', skills: ['code'] }] };
    }
    if (ctx.prompt.includes('Task: child')) {
      return { text: 'split2', delegation: [{ title: 'grandchild', prompt: 'fail grandchild', skills: ['code'] }] };
    }
    throw new Error('grandchild failed');
  });
  const project = engine.createProject({
    name: 'Depth-2',
    agents: [
      { id: 'ro', provider: 'codex', model: 'm', skills: ['code'], access: 'read-only' },
      { id: 'rw', provider: 'codex', model: 'm', skills: ['code'], access: 'workspace-write' }
    ],
    tasks: [{ id: 'root', title: 'root', prompt: 'start', agentIds: ['ro'], skills: ['code'], allowDelegation: true }],
    limits: { maxDepth: 2, maxCalls: 10, maxTasks: 20 }
  });
  const run = engine.start(project.id);
  await settled(run);
  assert.equal(run.status, 'failed');
  assert.equal(run.tasks.find(item => item.id === 'root').status, 'blocked');

  // Verify read-only cannot delegate to workspace-write agent
  const escalationEngine = new Engine(new Store(join(dir, 'data2')), async () => ({
    text: 'escalate',
    delegation: [{ title: 'write-child', prompt: 'mutate files', agentIds: ['rw'] }]
  }));
  const p2 = escalationEngine.createProject({
    name: 'Escalation',
    agents: [
      { id: 'ro', provider: 'codex', model: 'm', skills: ['code'], access: 'read-only' },
      { id: 'rw', provider: 'codex', model: 'm', skills: ['code'], access: 'workspace-write' }
    ],
    tasks: [{ id: 't1', title: 't1', prompt: 'read', agentIds: ['ro'], allowDelegation: true }],
    limits: { maxDepth: 2, maxCalls: 5 }
  });
  const run2 = escalationEngine.start(p2.id);
  await settled(run2);
  assert.equal(run2.status, 'failed');
  assert.match(run2.tasks[0].error, /Read-only/i);
});

test('normalizeReportChecks allows actualExitCode null when exit_code check is not_run', () => {
  const checks = normalizeReportChecks([
    { command: 'node test.mjs', kind: 'exit_code', status: 'not_run', required: true, expectedExitCode: 0, actualExitCode: null, details: 'pending' }
  ]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].actualExitCode, null);
  assert.equal(checks[0].status, 'not_run');
});

test('planning & execution HTTP services reject cross-site fetches, skip scan on GET status, and block NTFS ::$DATA', async t => {
  const dir = await tempDir(t, 'http-hardening-');
  let scanCalls = 0;
  const fakeRegistry = {
    snapshot: () => ({ checkedAt: new Date().toISOString(), backends: {}, routes: [] }),
    scan: async () => { scanCalls++; return { checkedAt: new Date().toISOString(), backends: {}, routes: [] }; },
    requireRoute: async () => { throw new Error('no route'); }
  };
  const execution = createExecutionService({ directory: join(dir, 'ui'), workspaces: join(dir, 'workspaces'), registry: fakeRegistry });
  t.after(async () => { await execution.close?.(); });
  const planning = planningHandler({
    resolve: options => execution.director.plannerConfig(options),
    managerCatalog: () => execution.registry.snapshot().routes
  }, execution.director.invoke);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/planning')) { await planning(req, res); return; }
    await execution.handler(req, res);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const port = server.address().port;

  // Cross-site request blocked on planning and execution
  const crossPlan = await fetch(`http://127.0.0.1:${port}/api/planning/status`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' }
  });
  assert.equal(crossPlan.status, 403);
  const crossExec = await fetch(`http://127.0.0.1:${port}/api/execution/status`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' }
  });
  assert.equal(crossExec.status, 403);

  // GET /api/planning/status?managerRouteId=invalid must NOT trigger registry.scan()
  const statusRes = await fetch(`http://127.0.0.1:${port}/api/planning/status?managerRouteId=nonexistent`);
  assert.equal(statusRes.status, 200);
  assert.equal(scanCalls, 0);

  // NTFS ::$DATA blocked on /api/execution/runs/:id/file
  const execStatus = await (await fetch(`http://127.0.0.1:${port}/api/execution/status`)).json();
  const wsDir = join(dir, 'workspaces', 'ws-ntfs');
  await mkdir(wsDir, { recursive: true });
  await writeFile(join(wsDir, '.env'), 'SECRET=1');
  execution.store.data.runs['run-ntfs'] = {
    id: 'run-ntfs',
    status: 'completed',
    project: { workspace: wsDir },
    tasks: [],
    events: []
  };
  const ntfsRes = await fetch(`http://127.0.0.1:${port}/api/execution/runs/run-ntfs/file?path=.env::$DATA`, {
    headers: { 'X-Execution-Token': execStatus.token }
  });
  assert.equal(ntfsRes.status, 400);
});

test('storefront-quality prevents DAG cycles, caps 30 tasks, normalizes Windows paths and validates audit.json', async t => {
  const existingPlan = {
    summary: 'Store',
    assumptions: [],
    risks: [],
    tasks: [
      { id: storefrontAcceptanceId, title: 'Old', prompt: 'Old prompt', skills: ['frontend'], dependsOn: [], acceptanceCriteria: ['ok'] },
      { id: 't2', title: 'After', prompt: 'Uses acceptance', skills: ['frontend'], dependsOn: [storefrontAcceptanceId], acceptanceCriteria: ['ok'] }
    ]
  };
  const normalized = withStorefrontAcceptance(existingPlan, { name: 'Магазин смартфонів', description: 'Онлайн магазин телефонів' });
  const gate = normalized.tasks.find(item => item.id === storefrontAcceptanceId);
  const t2 = normalized.tasks.find(item => item.id === 't2');
  assert.ok(gate);
  assert.ok(t2);
  assert.ok(!(gate.dependsOn.includes('t2') && t2.dependsOn.includes(storefrontAcceptanceId)), 'must not form a DAG cycle');
  assert.ok(!t2.dependsOn.includes(storefrontAcceptanceId), 'gate should run after implementation without cycle');

  const largePlan = {
    summary: 'Big',
    assumptions: [],
    risks: [],
    tasks: Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`, title: `T${i}`, prompt: 'p', skills: ['code'], dependsOn: [], acceptanceCriteria: ['c']
    }))
  };
  const capped = withStorefrontAcceptance(largePlan, { name: 'Shop', description: 'Магазин смартфонів' });
  assert.ok(capped.tasks.length <= 30);

  const cwd = await tempDir(t, 'storefront-audit-');
  const dir = 'artifacts/storefront-acceptance';
  await mkdir(join(cwd, dir), { recursive: true });
  const pngHeader = (width, seedByte) => {
    const data = Buffer.alloc(64, seedByte);
    data.set(Buffer.from('89504e470d0a1a0a', 'hex'));
    data.write('IHDR', 12);
    data.writeUInt32BE(width, 16);
    data.writeUInt32BE(720, 20);
    return data;
  };
  await writeFile(join(cwd, dir, 'desktop.png'), pngHeader(1280, 1));
  await writeFile(join(cwd, dir, 'mobile.png'), pngHeader(390, 2));
  const check = {
    command: 'node scripts/check-storefront-browser.mjs',
    kind: 'exit_code',
    status: 'passed',
    required: true,
    expectedExitCode: 0,
    actualExitCode: 0
  };
  // Windows backslash paths accepted
  const winReport = { files: [`${dir.replaceAll('/', '\\')}\\desktop.png`, `${dir.replaceAll('/', '\\')}\\mobile.png`], checks: [check] };
  assert.equal(await verifyStorefrontEvidence(winReport, cwd), true);

  // Bad audit.json fails verification
  await writeFile(join(cwd, dir, 'audit.json'), JSON.stringify({
    modelsCount: 3, uniqueProductImages: 1, brokenImages: 2, mobileHorizontalOverflow: true, checkoutFlowPassed: false
  }));
  assert.equal(await verifyStorefrontEvidence(winReport, cwd), false);

  // Rich audit.json passes verification
  await writeFile(join(cwd, dir, 'audit.json'), JSON.stringify({
    modelsCount: 12, uniqueProductImages: 12, brokenImages: 0, mobileHorizontalOverflow: false, checkoutFlowPassed: true
  }));
  assert.equal(await verifyStorefrontEvidence(winReport, cwd), true);
});

test('autopilot wizard helpers derive project names, serialize lean workspace state and preserve auto draft mode', () => {
  assert.equal(deriveProjectName('Створити сучасний інтернет-магазин смартфонів. Із кошиком.'), 'сучасний інтернет-магазин смартфонів');
  assert.equal(deriveProjectName(''), 'Новий проєкт');

  const memory = (() => {
    const map = new Map();
    return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
  })();
  assert.equal(saveProjectDraft(memory, { name: 'Store', description: 'Phone store', mode: 'auto' }), true);
  const restored = restoreProjectDraft(memory);
  assert.equal(restored.draft.mode, 'auto');
  assert.equal(restored.step, 1);

  const rawState = {
    version: 1,
    activeId: 'p1',
    agents: [],
    projects: [{
      id: 'p1',
      name: 'Live',
      status: 'running',
      tasks: [{ id: 't1', title: 'Task', prompt: 'p', agentIds: ['a1'], dependsOn: [], status: 'done', result: 'HUGE OUTPUT '.repeat(500), outputs: [{ text: 'huge' }], children: [{ id: 'c1' }] }],
      events: Array.from({ length: 100 }, (_, i) => ({ at: i, text: `ev ${i}`, real: true })),
      artifacts: [{ id: 'art1', name: 'big.md', text: 'x'.repeat(10000), real: true }],
      execution: { id: 'run-1', mode: 'real', status: 'running', tasks: [{ id: 't1', outputs: ['huge'] }], files: ['a.js'] }
    }]
  };
  const lean = serializeWorkspaceState(rawState);
  assert.equal(lean.projects[0].execution.id, 'run-1');
  assert.equal(lean.projects[0].execution.tasks, undefined);
  assert.equal(lean.projects[0].tasks[0].result, undefined);
  assert.equal(lean.projects[0].tasks[0].outputs, undefined);
  assert.equal(lean.projects[0].artifacts.length, 0);
  assert.equal(lean.projects[0].events.length, 0);
});
