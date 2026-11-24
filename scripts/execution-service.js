import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan } from '../apps/web/src/planning.js';
import { applyAcceptanceRoutingNeed, defaultDomainProfiles } from '../src/domain-profiles.js';
import { Engine } from '../src/engine.js';
import { readJsonBody } from '../src/http-body.js';
import { recentRunNotifications } from '../src/run-notifications.js';
import { Store } from '../src/store.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { createConnectionRecovery } from './connection-recovery.js';
import { createDirector, planFingerprint } from './director-service.js';
import { createHostAndDraftSupervisor } from './execution/auto-recovery-and-host.js';
import { createWorkspaceAndLaunchOps, handleRunActionRoute } from './execution/run-actions.js';
import { createProjectReviewerTools, currentPlanError, routingPlan } from './execution/tariff-and-review.js';
import { executorConfig, listFolders, resolveProjectWorkspacePath, workspaceFiles } from './execution/workspace-files.js';
import { createHostVerifier } from './host-verifier.js';
import { createModelRegistry, withModelPolicy } from './model-registry.js';
import { createStorefrontVerifier } from './profiles/storefront/browser-audit.js';
import { createProjectChat } from './project-chat.js';
import { createProjectComputer } from './project-computer.js';
import { createProjectPreview, localPreviewUrl } from './project-preview.js';
import { localTestRuntime } from './project-test-runtime.js';
import { createRecoveryHandler } from './recovery-service.js';
import { createTaskExtensions } from './task-extensions.js';

export { executorConfig, workspaceFiles };

const root = fileURLToPath(new URL('../.orchestrator/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function createExecutionService({
  directory = join(root, 'ui'),
  workspaces = join(root, 'workspaces'),
  config = executorConfig(),
  provider,
  registry: injectedRegistry,
  origin,
  reviewRuns = true,
  domainProfiles = defaultDomainProfiles,
  testNode = origin ? localTestRuntime() : null,
  hostVerifier = createHostVerifier(join(directory, 'host-verification.json'), { testNode })
} = {}) {
  const store = new Store(directory);
  const projectPreview = createProjectPreview(directory, { previewRuntime: testNode?.preview });
  const projectComputer = createProjectComputer({ origin, preview: projectPreview, testNode });
  const registry = injectedRegistry ?? createModelRegistry({ store, env: { ...process.env, ORCHESTRATOR_EXECUTOR_COMMAND: config.command } });
  const director = createDirector({ registry, provider, domainProfiles });
  const connectionRecovery = origin ? createConnectionRecovery() : undefined;
  const { projectReviewer, reviewRoute, selectProjectReviewer } = createProjectReviewerTools({ registry, config });
  const projectLocation = id => store.data.projectLocations && Object.hasOwn(store.data.projectLocations, id) ? store.data.projectLocations[id] : null;
  const acceptanceVerifiers = Object.fromEntries(
    domainProfiles
      .filter(profile => profile.id === 'storefront')
      .map(profile => [profile.id, createStorefrontVerifier({ projectPreview, outputRoot: join(directory, 'storefront-audits') })])
  );

  const engine = new Engine(store, withModelPolicy(registry, provider), {
    workspaces: new WorkspaceManager(join(workspaces, '.runs'), {
      allowedRoot: workspaces, projectLocation, forbiddenRoots: [directory]
    }),
    maxIntegrationRetries: 1,
    domainProfiles,
    acceptanceVerifiers,
    taskExtensions: createTaskExtensions(join(directory, 'task-extensions.json'), { ensureConnection: connectionRecovery }),
    projectComputer,
    selectProjectReviewer
  });

  const token = randomBytes(32).toString('hex');
  const launching = new Set();
  const hostChecks = new Map();
  const hostQueued = new Set();
  const routingControls = new Map();
  const draftProposals = new Map(), draftRoutingKey = Symbol('draft-routing');
  const streams = new Set();
  let closing = false;

  const isHostChecking = run => hostQueued.has(run.id) || hostChecks.has(run.id);
  const hasAnotherActiveRun = run => Object.values(store.data.runs).some(other =>
    other.id !== run.id && other.project.uiProjectId === run.project.uiProjectId &&
    (['running', 'paused'].includes(other.status) || engine.controls.get(other.id)?.active.size || engine.controls.get(other.id)?.recovering || isHostChecking(other)));
  const hasActiveRun = (projectId, ignoreRunId) => Object.values(store.data.runs).some(other =>
    other.id !== ignoreRunId && other.project.uiProjectId === projectId &&
    (['running', 'paused'].includes(other.status) || engine.controls.get(other.id)?.active.size || engine.controls.get(other.id)?.recovering || isHostChecking(other)));
  const planErrorFor = run => currentPlanError(store, run);
  const isCurrentRun = run => planErrorFor(run) === null;

  engine.recover = createRecoveryHandler({ engine, registry, director, config, isCurrent: isCurrentRun, currentPlanError: planErrorFor });

  const { refreshEmptyDraft, verifyOnHost, queueHostVerification, queueTransientAccessRetry, present } = createHostAndDraftSupervisor({
    store, engine, registry, hostVerifier, launching, hostChecks, hostQueued,
    isClosing: () => closing, isCurrentRun, isHostChecking, hasAnotherActiveRun
  });

  engine.subscribe((run, event) => {
    if (event.type === 'run.blocked') queueHostVerification(run);
    if (event.type === 'run.drained' && run.status === 'failed') queueTransientAccessRetry(run);
  });

  const latestRuns = new Map();
  for (const run of Object.values(store.data.runs)) {
    const projectId = run.project.uiProjectId;
    if (!latestRuns.has(projectId) || run.createdAt > latestRuns.get(projectId).createdAt) latestRuns.set(projectId, run);
  }
  for (const run of latestRuns.values()) {
    if (run.events.some(event => event.type === 'run.drained')) {
      if (run.status === 'failed') queueTransientAccessRetry(run);
      else queueHostVerification(run);
    }
  }

  const runtimes = () => registry.snapshot().routes.filter(r => ['codex', 'opencode', 'antigravity'].includes(r.backend)).flatMap(r => [
    ...(r.capabilities?.workspaceWrite ? [{ id: `${r.id}#write`, name: `${r.backend} · розробка`, provider: r.backend, model: r.model, routeId: r.id, billing: r.billing, billingBoundary: r.billingBoundary, access: 'workspace-write', allowed: r.decision.allowed, reason: r.decision.reason }] : []),
    { id: `${r.id}#read`, name: `${r.backend} · перевірка`, provider: r.backend, model: r.model, routeId: r.id, billing: r.billing, billingBoundary: r.billingBoundary, access: 'read-only', allowed: r.decision.allowed, reason: r.decision.reason }
  ]);
  const uiProject = key => {
    const p = store.data.ui?.workspace.projects.find(item => item.id === key);
    if (!p) throw new Error('Проєкт не збережений на сервері');
    return p;
  };
  const storedRouting = projectId => store.data.routing && Object.hasOwn(store.data.routing, projectId) ? store.data.routing[projectId] : null;
  const workspace = key => resolveProjectWorkspacePath({ key, projectLocation, workspaces, workspaceManager: engine.workspaces });
  const summary = run => ({
    id: run.id, projectId: run.projectId, uiProjectId: run.project.uiProjectId, uiRevision: run.project.uiRevision,
    name: run.project.name, status: run.status, calls: run.calls, createdAt: run.createdAt, finishedAt: run.finishedAt,
    kind: run.project.projectChatId ? 'project-chat' : undefined
  });
  const readBody = req => readJsonBody(req, { maxBytes: 5 * 1024 * 1024, limitMessage: 'Завеликий запит' });

  let projectChat;
  const { saveWorkspace, launch, launchChatEdit } = createWorkspaceAndLaunchOps({
    store, engine, registry, config, directory, repoRoot, domainProfiles, reviewRuns,
    draftProposals, hostQueued, hostChecks, launching,
    uiProject, projectLocation, storedRouting, workspace, hasActiveRun, runtimes,
    reviewRoute, projectReviewer, getProjectChat: () => projectChat
  });

  projectChat = createProjectChat({
    store, engine, launching,
    isBusy: projectId => hasActiveRun(projectId) || [...hostQueued, ...hostChecks.keys()].some(id => engine.run(id).project.uiProjectId === projectId),
    launch: launchChatEdit
  });

  for (const run of latestRuns.values()) {
    const projectId = run.project.uiProjectId;
    if (run.status === 'interrupted' && !hasActiveRun(projectId) && isCurrentRun(run)) engine.resumeCheckpoint(run);
  }

  const handler = async (req, res) => {
    const send = (status, data) => {
      if (res.headersSent || res.destroyed || res.writableEnded) return;
      const payload = JSON.stringify(data);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin'
      });
      res.end(payload);
    };
    try {
      const host = req.headers.host;
      const fetchSite = req.headers['sec-fetch-site'];
      if (!host || !/^127\.0\.0\.1:\d+$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
        return send(403, { error: 'Лише локальний same-origin доступ' });
      }
      const url = new URL(req.url, 'http://localhost');
      if (await projectComputer.handle(req, res, url.pathname)) return;
      if (req.method === 'GET' && url.pathname === '/api/execution/status') {
        return send(200, {
          token, runtimes: runtimes(), reasoningEffort: config.reasoningEffort,
          timeouts: { task: config.timeoutMs ?? null, recovery: config.recoveryTimeoutMs ?? null },
          capabilities: { reviews: reviewRuns, recovery: { automatic: true, defaultAttempts: 2, maxAttempts: 3 } }
        });
      }
      const supplied = Buffer.from(req.headers['x-execution-token'] ?? ''), expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return send(403, { error: 'Оновіть сторінку для доступу до виконання' });
      }
      if (req.method === 'GET' && url.pathname === '/api/execution/notifications') {
        return send(200, { items: recentRunNotifications(Object.values(store.data.runs)) });
      }
      if (['POST', 'PUT'].includes(req.method) && !req.headers['content-type']?.startsWith('application/json')) {
        return send(415, { error: 'Потрібен JSON' });
      }
      if (url.pathname === '/api/execution/project-chat' && ['GET', 'POST'].includes(req.method)) {
        const projectId = uiProject(url.searchParams.get('projectId')).id;
        if (req.method === 'GET') return send(200, { messages: projectChat.history(projectId) });
        return send(202, { messages: projectChat.send(projectId, await readBody(req)) });
      }
      if (req.method === 'GET' && url.pathname === '/api/connections') return send(200, registry.snapshot());
      if (req.method === 'POST' && url.pathname === '/api/connections/scan') return send(200, await registry.scan());
      if (req.method === 'POST' && url.pathname === '/api/routing/draft') {
        const input = await readBody(req);
        validatePlan(input.plan);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 12000) {
          throw Error('Потрібні назва та опис проєкту');
        }
        if (input.requirements !== undefined && (!input.requirements || typeof input.requirements !== 'object' || Array.isArray(input.requirements) || Object.keys(input.requirements).some(id => !input.plan.tasks.some(t => t.id === id)))) {
          throw Error('Некоректні вимоги задач');
        }
        if (routingControls.has(draftRoutingKey)) throw Error('Підбір команди в майстрі вже триває');
        const plan = routingPlan({ name: input.name, description: input.description, tasks: input.plan.tasks });
        const requirements = Object.fromEntries(plan.tasks.map(t => [t.id, applyAcceptanceRoutingNeed(t.id, { workspaceWrite: true, ...input.requirements?.[t.id] }, domainProfiles)]));
        const controller = new AbortController();
        routingControls.set(draftRoutingKey, controller);
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const proposal = await director.propose({
            plan, requirements, managerRouteId: input.managerRouteId, priority: input.priority,
            maxAgentsPerTask: input.maxAgentsPerTask, repairInvalid: true, allowManagerFallback: input.allowManagerFallback === true
          }, controller.signal);
          controller.signal.throwIfAborted();
          for (const [id, draft] of draftProposals) if (draft.expiresAt <= Date.now()) draftProposals.delete(id);
          while (draftProposals.size >= 20) draftProposals.delete(draftProposals.keys().next().value);
          const expiresAt = Date.now() + 30 * 60 * 1000;
          draftProposals.set(proposal.id, { proposal, expiresAt });
          return send(200, { ...proposal, expiresAt: new Date(expiresAt).toISOString() });
        } finally { routingControls.delete(draftRoutingKey); }
      }
      if (url.pathname === '/api/routing') {
        if (req.method === 'GET') {
          const p = uiProject(url.searchParams.get('projectId')), proposal = storedRouting(p.id);
          return send(200, { proposal, stale: proposal ? proposal.revision !== p.revision || proposal.planFingerprint !== planFingerprint(routingPlan(p)) : false });
        }
        if (req.method === 'POST') {
          const input = await readBody(req), p = structuredClone(uiProject(input.projectId));
          if (input.revision !== p.revision) throw new Error('План змінився: оновіть проєкт');
          if (routingControls.has(p.id)) throw new Error('Підбір моделей цього проєкту вже триває');
          const plan = routingPlan(p), fingerprint = planFingerprint(plan);
          if (input.requirements !== undefined && (!input.requirements || typeof input.requirements !== 'object' || Array.isArray(input.requirements) ||
              Object.keys(input.requirements).some(id => !plan.tasks.some(t => t.id === id)))) {
            throw new Error('Некоректні вимоги задач');
          }
          const requirements = Object.fromEntries(plan.tasks.map(t => [t.id, applyAcceptanceRoutingNeed(t.id, { workspaceWrite: true, ...input.requirements?.[t.id] }, domainProfiles)]));
          const controller = new AbortController();
          routingControls.set(p.id, controller);
          res.on('close', () => { if (!res.writableEnded) controller.abort(); });
          try {
            const proposal = await director.propose({
              plan, requirements, managerRouteId: input.managerRouteId, priority: input.priority,
              maxAgentsPerTask: input.maxAgentsPerTask, repairInvalid: true
            }, controller.signal);
            const current = uiProject(p.id);
            if (current.revision !== p.revision || planFingerprint(routingPlan(current)) !== fingerprint) {
              throw new Error('План змінився під час підбору: рішення не збережено');
            }
            store.data.routing ??= {};
            store.data.routing[p.id] = { ...proposal, projectId: p.id, revision: p.revision };
            store.save();
            return send(200, store.data.routing[p.id]);
          } finally { routingControls.delete(p.id); }
        }
      }
      if (url.pathname === '/api/workspace') {
        if (req.method === 'GET') return send(200, store.data.ui ?? { revision: 0, workspace: null });
        if (req.method === 'PUT') return send(200, await saveWorkspace(await readBody(req)));
      }
      if (url.pathname === '/api/project-folders' && req.method === 'GET') {
        return send(200, await listFolders(url.searchParams.get('path')));
      }
      if (url.pathname === '/api/project-preview' && req.method === 'POST') {
        const input = await readBody(req), project = uiProject(input.projectId);
        const appOrigin = `http://${req.headers.host}`;
        if (input.url) return send(200, { url: localPreviewUrl(input.url, appOrigin).href });
        const dir = await workspace(project.id);
        const revision = await engine.workspaces.git(dir, ['rev-parse', 'HEAD']).catch(() => undefined);
        const result = await projectPreview.open(project.id, dir, appOrigin, { revision });
        return send(200, { url: result.url, ...(result.demo ? { demo: true } : {}) });
      }
      if (url.pathname === '/api/execution/preview' && req.method === 'POST') {
        await registry.scan();
        const { projectId } = await readBody(req);
        const p = uiProject(projectId), proposal = storedRouting(projectId);
        return send(200, {
          workspace: await workspace(projectId), runtimes: runtimes(), reasoningEffort: config.reasoningEffort,
          proposal: proposal && proposal.revision === p.revision && proposal.planFingerprint === planFingerprint(routingPlan(p)) ? proposal : null
        });
      }
      if (url.pathname === '/api/execution/runs') {
        if (req.method === 'GET') return send(200, Object.values(store.data.runs).map(summary));
        if (req.method === 'POST') return send(202, await launch(await readBody(req)));
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api' && parts[1] === 'execution' && parts[2] === 'runs' && parts[3]) {
        const run = engine.run(parts[3]), action = parts[4];
        const handled = await handleRunActionRoute({
          req, res, url, send, readBody, run, action,
          store, engine, registry, hostVerifier, config,
          streams, launching, hostQueued, hostChecks,
          isCurrentRun, isHostChecking, hasActiveRun, uiProject,
          present, verifyOnHost, refreshEmptyDraft, projectReviewer
        });
        if (handled) return;
      }
      send(404, { error: 'Route not found' });
    } catch (error) {
      if (res.headersSent || res.destroyed || res.writableEnded) { res.end(); return; }
      send(error.statusCode ?? 400, { error: error.message });
    }
  };

  return {
    handler,
    engine,
    store,
    registry,
    director,
    close() {
      closing = true;
      projectChat.close();
      projectComputer.close();
      projectPreview.close();
      connectionRecovery?.close?.();
      for (const stream of streams) stream();
      for (const controller of routingControls.values()) controller.abort();
      for (const controller of hostChecks.values()) controller.abort();
      for (const run of Object.values(store.data.runs)) if (['running', 'paused'].includes(run.status)) engine.cancel(run.id);
      store.flush?.();
    }
  };
}
