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
import { withStorefrontAcceptance, storefrontAcceptanceId } from '../src/storefront-quality.js';
import { applyWorkerChanges, sandboxChecks } from '../scripts/file-worker.js';
import { planningHandler } from '../scripts/planning-service.js';
import { createExecutionService } from '../scripts/execution-service.js';
import { deriveProjectName } from '../apps/web/src/create-project.js';
import { createExecutionClient, serializeWorkspaceState } from '../apps/web/src/execution.js';
import { saveProjectDraft, restoreProjectDraft } from '../apps/web/src/project-draft.js';
import { redactSecrets } from '../src/providers.js';
import { createProjectPreview } from '../scripts/project-preview.js';
import { localTestRuntime } from '../scripts/project-test-runtime.js';
import { createHostVerifier } from '../scripts/host-verifier.js';
import { seed } from '../apps/web/src/state.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

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

test('storefront-quality prevents DAG cycles and caps the plan at 30 tasks', () => {
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

test('non-isolated execution, selected project folders, NTFS tricky segments and nested .git are strictly confined', async t => {
  const dir = await tempDir(t, 'confinement-');
  const allowedRoot = join(dir, 'managed');
  const chosenDir = join(dir, 'user-disk', 'Selected - 12345678');
  const siblingDir = join(dir, 'user-disk', 'OtherFolder');
  const serviceDir = join(dir, 'ui-state');
  await mkdir(allowedRoot, { recursive: true });
  await mkdir(chosenDir, { recursive: true });
  await mkdir(siblingDir, { recursive: true });
  await mkdir(serviceDir, { recursive: true });

  const locations = new Map([['ui-proj-1', chosenDir]]);
  const manager = new WorkspaceManager(join(dir, 'worktrees'), {
    allowedRoot,
    projectLocation: id => locations.get(id) ?? null,
    forbiddenRoots: [serviceDir]
  });
  let observedCwd;
  const engine = new Engine(new Store(serviceDir), async (_agent, ctx) => {
    observedCwd = ctx.cwd;
    return { text: 'ok' };
  }, { workspaces: manager });

  // 1. Omitted workspaceMode & workspace never falls back to process.cwd(); uses allowedRoot
  const pDefault = engine.createProject({
    name: 'DefaultManaged',
    agents: [{ id: 'a', provider: 'codex', model: 'm', skills: [] }],
    tasks: [{ id: 't1', title: 't1', prompt: 'run', agentIds: ['a'] }]
  });
  const rDefault = engine.start(pDefault.id);
  await settled(rDefault);
  assert.equal(rDefault.status, 'completed');
  assert.ok(observedCwd.toLowerCase().startsWith(allowedRoot.toLowerCase()));

  // 2. Shared mode pointing outside allowedRoot fails confinement
  const pEscape = engine.createProject({
    name: 'EscapeAttempt',
    workspace: siblingDir,
    workspaceMode: 'shared',
    agents: [{ id: 'a', provider: 'codex', model: 'm', skills: [] }],
    tasks: [{ id: 't1', title: 't1', prompt: 'run', agentIds: ['a'] }]
  });
  const rEscape = engine.start(pEscape.id);
  await settled(rEscape);
  assert.equal(rEscape.status, 'failed');
  assert.match(rEscape.tasks[0].error, /виходить за межі/i);

  // 3. Project with chosen folder allows ONLY that exact folder, rejecting sibling and serviceDir
  await assert.rejects(manager.assertBase(siblingDir, 'ui-proj-1'), /переміщено або замінено/);
  await assert.rejects(manager.assertBase(serviceDir, 'other'), /службовий каталог/);
  assert.equal((await manager.assertBase(chosenDir, 'ui-proj-1')).toLowerCase(), chosenDir.toLowerCase());

  // 4. NTFS trailing dots/spaces, 8.3 ~, reserved device names, and read-only sandboxChecks
  const workDir = await tempDir(t, 'ntfs-fw-');
  for (const tricky of ['.env ', '.git.', 'secret.pem ', 'GIT~1/config', 'CON.txt', 'sub/nul.mjs']) {
    await assert.rejects(applyWorkerChanges(workDir, [{ path: tricky, baseHash: null, content: 'x' }]));
  }
  await writeFile(join(workDir, 'ok.test.ts'), '');
  let sandboxArgs;
  await sandboxChecks(workDir, ['ok.test.ts'], {
    signal: AbortSignal.timeout(2000),
    command: 'trusted-sandbox',
    run: async (_cmd, args) => { sandboxArgs = args; return '# tests 1\n# pass 1\n# fail 0\n'; }
  });
  assert.ok(sandboxArgs.some(a => a.includes('"."="read"')));
  assert.ok(!sandboxArgs.some(a => a === `--allow-fs-write=${workDir}`));

  // 5. Nested .git directory inside candidate worktree is rejected
  const nestedTarget = join(allowedRoot, 'nested-check');
  await mkdir(nestedTarget, { recursive: true });
  const lease = await manager.prepare({ id: 'run-nested', project: { workspace: nestedTarget } }, { id: 'task-n' });
  await mkdir(join(lease.cwd, 'subrepo', '.git'), { recursive: true });
  await assert.rejects(manager.stageCandidate(lease), /\.git/);
});

test('dynamic preview requires Docker bridge and container exit code != 1 remains repairable test failure', async t => {
  const dir = await tempDir(t, 'preview-docker-');
  const ws = join(dir, 'app');
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'server.mjs'), `
    import { createServer } from 'node:http';
    const srv = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
      res.end('<h1>Container Preview ' + req.url + '</h1>');
    });
    srv.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ mode: 'TEST_ONLY', externalCalls: false, url: 'http://127.0.0.1:' + srv.address().port + '/start' }));
    });
  `);
  await writeFile(join(dir, 'preview-commands.json'), JSON.stringify({ projects: { p1: { script: 'server.mjs' } } }));

  // Without Docker previewRuntime, configured preview fails closed without running host code
  const noDockerPreview = createProjectPreview(dir);
  t.after(() => noDockerPreview.close());
  await assert.rejects(noDockerPreview.open('p1', ws, 'http://127.0.0.1:4311'), /Docker-контейнері/);

  // Test the container bridge protocol (project-preview-container.mjs) over stdio
  const bridgePreview = createProjectPreview(dir, {
    previewRuntime: async (_cwd, { script, demo }) => {
      // Simulate container root mapping by running container script with custom cwd stub in test
      const child = spawn(process.execPath, [
        '--input-type=module',
        '-e',
        `import { spawn } from 'node:child_process';
         import { request as httpRequest } from 'node:http';
         import { createInterface } from 'node:readline';
         import { join } from 'node:path';
         const child = spawn(process.execPath, [join(${JSON.stringify(ws)}, ${JSON.stringify(script)})], { stdio: ['ignore', 'pipe', 'ignore'] });
         process.stdin.on('end', () => { try { child.kill(); } catch {} process.exit(0); });
         process.on('SIGTERM', () => { try { child.kill(); } catch {} process.exit(0); });
         const lines = createInterface({ input: child.stdout });
         let target;
         lines.on('line', line => {
           const d = JSON.parse(line);
           if (d.mode === 'TEST_ONLY') {
             target = new URL(d.url);
             process.stdout.write(JSON.stringify({ type: 'ready', pathname: target.pathname, demo: ${Boolean(demo)} }) + '\\n');
           }
         });
         createInterface({ input: process.stdin }).on('line', line => {
           const msg = JSON.parse(line);
           const req = httpRequest(new URL(msg.path, target.origin), { method: msg.method, headers: { ...msg.headers, host: target.host } }, res => {
             const chunks = [];
             res.on('data', c => chunks.push(c));
             res.on('end', () => process.stdout.write(JSON.stringify({ id: msg.id, statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('base64') }) + '\\n'));
           });
           req.end();
         });`
      ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const out = createInterface({ input: child.stdout });
      const pending = new Map();
      let seq = 0;
      const ready = await new Promise(res => out.on('line', line => {
        const msg = JSON.parse(line);
        if (msg.type === 'ready') res(msg);
        else if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }));
      return {
        pathname: ready.pathname,
        request: payload => new Promise(res => { const id = ++seq; pending.set(id, res); child.stdin.write(JSON.stringify({ id, ...payload }) + '\n'); }),
        close: () => { out.close(); try { child.stdin.end(); } catch {} child.kill(); }
      };
    }
  });
  t.after(() => bridgePreview.close());
  const session = await bridgePreview.open('p1', ws, 'http://127.0.0.1:4311');
  assert.match(session.url, /\/start$/);
  const crossSite = await fetch(session.url, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const okPage = await fetch(session.url);
  assert.equal(okPage.status, 200);
  assert.equal(okPage.headers.get('x-frame-options'), null);
  assert.match(okPage.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors http:\/\/127\.0\.0\.1:4311/);
  assert.match(await okPage.text(), /Container Preview \/start/);

  // Verify exit code 2 in isolated script check is recorded as failed + repairable (not Docker unavailable)
  const cmd = 'npm run test:storefront-postgres';
  const verifier = createHostVerifier('nonexistent-policy.json', {
    testNode: Object.assign(async () => ({ exitCode: 0, output: 'ok' }), {
      script: async () => ({ exitCode: 2, output: 'Тестовий сервер не відкрив /healthz.' }),
      version: 'v1'
    })
  });
  await writeFile(join(ws, 'package.json'), JSON.stringify({ scripts: { 'test:storefront-postgres': 'node scripts/test-storefront-postgres.mjs' } }));
  await mkdir(join(ws, 'scripts'), { recursive: true });
  await writeFile(join(ws, 'scripts', 'test-storefront-postgres.mjs'), '');
  const task = {
    status: 'blocked',
    workspace: { path: ws },
    failure: { code: 'AGENT_BLOCKED' },
    blockedReport: { checks: [{ command: cmd, required: true, status: 'not_run', details: 'needs postgres' }] }
  };
  const plan = verifier.plan({ project: { uiProjectId: 'p1' } }, task, { partial: true });
  const [checkResult] = await verifier.verify(plan, task.blockedReport, ws, new AbortController().signal, { continueOnFailure: true });
  assert.equal(checkResult.status, 'failed');
  assert.equal(checkResult.actualExitCode, 2);
  assert.equal(checkResult.environmentUnavailable, undefined);
  assert.equal(checkResult.repairable, true);
});

test('free_tier is preserved in chat, recovery and final review, requiring explicit user approval for subscription switch', async t => {
  const dir = await tempDir(t, 'free-tier-guard-');
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const freeWorker = {
    id: 'opencode:opencode/free-a', connectionId: 'opencode', backend: 'opencode', model: 'opencode/free-a', name: 'Free A',
    checkedAt: now, expiresAt, availability: 'ready', billing: 'free_tier', freeConfirmed: true,
    billingBoundary: 'included_only', runtimeSupported: true,
    capabilities: { workspaceWrite: true, structuredOutput: false, jsonOutput: 'prompt_validated', tools: false },
    decision: { allowed: true, reason: 'Free' }
  };
  const subModel = {
    id: 'codex:gpt-5-sub', connectionId: 'codex', backend: 'codex', model: 'gpt-5-sub', name: 'GPT-5 Sub',
    checkedAt: now, expiresAt, availability: 'ready', billing: 'subscription_included',
    subscriptionConfirmed: true, includedAccessConfirmed: true, freeConfirmed: false,
    billingBoundary: 'included_only', runtimeSupported: true, isDefault: true,
    capabilities: { workspaceWrite: true, structuredOutput: true, tools: true },
    decision: { allowed: true, reason: 'Sub' }
  };
  const routes = [subModel, freeWorker];
  const invokedModels = [];
  const registry = {
    snapshot: () => ({ routes, connections: [] }),
    scan: async () => registry.snapshot(),
    requireRoute: async id => {
      const r = routes.find(x => x.id === id);
      if (!r || !r.decision.allowed) throw Object.assign(new Error('Unavailable'), { code: 'MODEL_ACCESS_BLOCKED' });
      return { ...r, command: 'trusted-cli' };
    }
  };
  const service = createExecutionService({
    directory: join(dir, 'ui'),
    workspaces: join(dir, 'workspaces'),
    registry,
    reviewRuns: true,
    provider: async (agent, ctx) => {
      invokedModels.push({ model: agent.model, billing: agent.billing, review: ctx.review });
      if (ctx.review) return { text: '{"approved":true,"feedback":"Схвалено рецензентом"}' };
      await writeFile(join(ctx.cwd, 'index.html'), '<h1>Free Tier</h1>');
      return { text: 'Готово' };
    }
  });
  const server = http.createServer(service.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { service.close(); await new Promise(r => server.close(r)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${baseUrl}/api/execution/status`)).json();
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'X-Execution-Token': token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, value: await res.json() };
  };

  const ws = seed();
  const p = ws.projects[0];
  ws.projects = [p];
  p.tasks = [{ id: 't1', title: 'Зробити сторінку', prompt: 'Створи index.html', agentIds: ['backend'], dependsOn: [], acceptanceCriteria: ['Є index.html'] }];
  p.planning = { freeWorkers: true };
  assert.equal((await call('/api/workspace', 'PUT', { revision: 0, workspace: ws })).status, 200);

  // Launch with free worker while subscription model is also in catalog: final review MUST wait instead of using subModel!
  const started = await call('/api/execution/runs', 'POST', {
    projectId: p.id, revision: p.revision, bindings: { backend: `${freeWorker.id}#write` }, maxCalls: 6
  });
  assert.equal(started.status, 202);
  const run = service.engine.run(started.value.id);
  for (let i = 0; i < 500 && !run.events.some(e => e.type === 'run.drained'); i++) await delay(10);

  assert.equal(run.status, 'blocked');
  assert.equal(run.tasks[0].status, 'completed');
  assert.ok(invokedModels.every(m => m.model === 'opencode/free-a'), 'subscription model must never be called automatically');
  const presented = (await call(`/api/execution/runs/${run.id}`)).value;
  assert.equal(presented.projectReviewAwaitingFreeModel, true);
  assert.deepEqual(presented.subscriptionReviewRoutes.map(r => r.id), ['codex:gpt-5-sub']);

  // Attempting to switch final review to subscription WITHOUT allowSubscription: true is rejected
  const deniedSwitch = await call(`/api/execution/runs/${run.id}/retry-project-review`, 'POST', { routeId: 'codex:gpt-5-sub' });
  assert.equal(deniedSwitch.status, 400);
  assert.match(deniedSwitch.value.error, /явного вибору користувача/);

  // Explicit user opt-in (allowSubscription: true) allows final review to run on the chosen subscription model
  const approvedSwitch = await call(`/api/execution/runs/${run.id}/retry-project-review`, 'POST', {
    routeId: 'codex:gpt-5-sub', allowSubscription: true
  });
  assert.equal(approvedSwitch.status, 202);
  await settled(run);
  assert.equal(run.status, 'completed');
  assert.equal(invokedModels.at(-1).model, 'gpt-5-sub');

  // Project chat on free_tier project must NOT fall back to subModel when freeWorker becomes unavailable
  freeWorker.decision = { allowed: false, reason: 'Offline' };
  freeWorker.availability = 'unavailable';
  const msgId = randomUUID();
  await call(`/api/execution/project-chat?projectId=${encodeURIComponent(p.id)}`, 'POST', { id: msgId, text: 'Додай футер' });
  let chatHistory;
  for (let i = 0; i < 300; i++) {
    chatHistory = (await call(`/api/execution/project-chat?projectId=${encodeURIComponent(p.id)}`)).value.messages;
    if (chatHistory[0]?.status === 'start_failed') break;
    await delay(10);
  }
  assert.equal(chatHistory[0].status, 'start_failed');
  assert.equal(chatHistory[0].decisionCode, 'free_chat_unavailable');

  // Explicit retry with allowSubscription: true runs chat message
  await call(`/api/execution/project-chat?projectId=${encodeURIComponent(p.id)}`, 'POST', { id: msgId, retry: true, allowSubscription: true });
  for (let i = 0; i < 400; i++) {
    chatHistory = (await call(`/api/execution/project-chat?projectId=${encodeURIComponent(p.id)}`)).value.messages;
    if (chatHistory[0]?.status === 'completed') break;
    await delay(10);
  }
  assert.equal(chatHistory[0].status, 'completed');
});

test('queued persist() serializes fresh state after createPlannedProject and redactSecrets masks JSON/URL secrets', async () => {
  let serverRev = 1;
  let savedWorkspaces = [];
  let state = { version: 1, activeId: 'p1', agents: [{ id: 'a1', name: 'A' }], projects: [{ id: 'p1', name: 'Old', revision: 1, tasks: [], events: [], artifacts: [] }] };
  let releaseCreate;
  const createGate = new Promise(r => { releaseCreate = r; });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/execution/status')) return new Response(JSON.stringify({ token: 't', runtimes: [], capabilities: {} }), { status: 200 });
    if (u.endsWith('/api/workspace') && (!opts.method || opts.method === 'GET')) return new Response(JSON.stringify({ revision: serverRev, workspace: state }), { status: 200 });
    if (u.endsWith('/api/connections')) return new Response(JSON.stringify({ checkedAt: new Date().toISOString(), routes: [], connections: [] }), { status: 200 });
    if (u.endsWith('/api/execution/notifications')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (u.endsWith('/api/execution/runs')) return new Response(JSON.stringify([]), { status: 200 });
    if (u.includes('/api/routing')) return new Response(JSON.stringify({ proposal: null, stale: false }), { status: 200 });
    if (u.endsWith('/api/workspace') && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      if (body.workspace.projects.length === 2) await createGate;
      assert.equal(body.revision, serverRev);
      serverRev++;
      savedWorkspaces.push(body.workspace.projects.map(p => p.id));
      return new Response(JSON.stringify({ revision: serverRev, workspace: body.workspace }), { status: 200 });
    }
    throw new Error('Unexpected URL: ' + u);
  };
  try {
    const client = createExecutionClient({
      getState: () => state,
      setState: v => { state = v; },
      render: () => {},
      saveLocal: () => {},
      notify: () => {},
      modal: () => {},
      h: String,
      button: () => '',
      download: () => {}
    });
    await client.init();
    const createPromise = client.createPlannedProject({
      project: { id: 'p2', name: 'New', revision: 1, tasks: [], events: [], artifacts: [] },
      profiles: []
    });
    // Trigger flush() WHILE createPlannedProject is still in flight!
    const flushPromise = client.flush();
    releaseCreate();
    await Promise.all([createPromise, flushPromise]);
    assert.deepEqual(savedWorkspaces.at(-1), ['p1', 'p2']);
    client.close();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const redacted = redactSecrets('{"password": "my-secret-value"} postgres://admin:topsecret@localhost:5432/shop AIzaSyB12345678901234567890', 500);
  assert.doesNotMatch(redacted, /my-secret-value|topsecret|AIzaSyB/);
});
