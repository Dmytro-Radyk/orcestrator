import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { plannedCalls } from '../../apps/web/src/call-budget.js';
import { validateTasks } from '../../apps/web/src/state.js';
import { safeKey, selectAgents, validateProject } from '../../src/domain.js';
import { findAcceptanceProfile } from '../../src/domain-profiles.js';
import { budgetBlocked, retryableAccessTasks } from '../../src/engine.js';
import { reportNeedsCorrection, waitsForVerification, workspaceNeedsResolution } from '../../src/execution-report.js';
import { streamRun } from '../../src/run-stream.js';
import { planFingerprint, routingCandidates, suits, validateRouteAssignments } from '../director-service.js';
import { executionAgent } from '../execution-agent.js';
import { quotaUse } from '../worker-routing.js';
import {
  geminiAssignments, isFreeTierProject, isFreeTierRun, reviewAuthors,
  routingPlan, routingRequirement, taskRequiresFree, unstartedTasks
} from './tariff-and-review.js';
import { inside, localDirectory, readRunArtifactFile, samePath, workspaceFiles } from './workspace-files.js';

export function createWorkspaceAndLaunchOps({
  store, engine, registry, config, directory, repoRoot, domainProfiles, reviewRuns,
  draftProposals, hostQueued, hostChecks, launching,
  uiProject, projectLocation, storedRouting, workspace, hasActiveRun, runtimes,
  reviewRoute, projectReviewer, getProjectChat
}) {
  async function saveWorkspace(input) {
    if (input.revision !== (store.data.ui?.revision ?? 0)) throw new Error('Конфлікт збереження: оновіть сторінку, щоб отримати актуальні дані');
    const value = input.workspace;
    if (value?.version !== 1 || !Array.isArray(value.projects) || !value.projects.length ||
        !Array.isArray(value.agents) || !value.agents.length || value.projects.length > 100 || value.agents.length > 100) {
      throw new Error('Некоректний робочий простір');
    }
    const ids = new Set();
    for (const p of value.projects) {
      if (!safeKey(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.tasks) || p.tasks.length > 100) {
        throw new Error('Некоректний проєкт');
      }
      if (p.revision !== undefined && (!Number.isSafeInteger(p.revision) || p.revision < 1)) throw new Error('Некоректна ревізія проєкту');
      if (p.executionBrief !== undefined && (typeof p.executionBrief !== 'string' || p.executionBrief.length > 12000)) throw Error('Некоректне уточнення вимог');
      ids.add(p.id);
      validateTasks(p.tasks);
    }
    let adopted;
    if (input.routingDraftId !== undefined) {
      const draft = draftProposals.get(input.routingDraftId), p = value.projects.find(item => item.id === input.routingProjectId);
      if (!draft || draft.expiresAt <= Date.now()) throw Error('Підбір команди застарів: повторіть його в майстрі');
      if (!p || store.data.ui?.workspace.projects.some(old => old.id === p.id) || p.revision !== 1 || draft.proposal.planFingerprint !== planFingerprint(routingPlan(p))) {
        throw Error('План змінився після підбору команди');
      }
      await registry.scan();
      validateRouteAssignments(
        draft.proposal,
        routingPlan(p),
        routingCandidates(routingPlan(p), registry.snapshot().routes, draft.proposal.requirements, { domainProfiles }),
        { maxAgentsPerTask: draft.proposal.maxAgentsPerTask, domainProfiles }
      );
      if (input.revision !== (store.data.ui?.revision ?? 0)) throw Error('Конфлікт збереження: оновіть сторінку, щоб отримати актуальні дані');
      if (draftProposals.get(input.routingDraftId) !== draft || draft.expiresAt <= Date.now()) throw Error('Підбір команди застарів: повторіть його в майстрі');
      adopted = { ...draft.proposal, projectId: p.id, revision: p.revision };
    }
    for (const key of new Set([...hostQueued, ...hostChecks.keys()])) {
      const run = engine.run(key), previous = uiProject(run.project.uiProjectId), next = value.projects.find(p => p.id === previous.id);
      if (!next || next.revision !== previous.revision || (next.executionBrief ?? '') !== (previous.executionBrief ?? '') ||
          planFingerprint(routingPlan(next)) !== planFingerprint(routingPlan(previous))) {
        throw Error('Дочекайтеся завершення локальної перевірки перед зміною плану');
      }
    }
    for (const previous of store.data.ui?.workspace.projects ?? []) {
      if (launching.has(previous.id)) {
        const next = value.projects.find(p => p.id === previous.id);
        if (!next || next.revision !== previous.revision || (next.executionBrief ?? '') !== (previous.executionBrief ?? '') ||
            planFingerprint(routingPlan(next)) !== planFingerprint(routingPlan(previous))) {
          throw Error('Дочекайтеся завершення поточної операції перед зміною плану');
        }
      }
    }
    for (const run of Object.values(store.data.runs)) {
      if (run.project.projectChatId && (['running', 'paused'].includes(run.status) || engine.controls.get(run.id)?.active.size) &&
          !value.projects.some(p => p.id === run.project.uiProjectId)) {
        throw Error('Дочекайтеся завершення правок із чату перед видаленням проєкту');
      }
    }
    if (input.projectLocation !== undefined) {
      const { projectId, parent } = input.projectLocation ?? {};
      const pending = value.projects.find(project => project.id === projectId);
      if (!pending || projectLocation(projectId) || store.data.ui?.workspace.projects.some(old => old.id === projectId)) {
        throw Error('Папку можна вибрати лише для нового проєкту');
      }
      const base = await localDirectory(parent);
      const storeReal = await realpath(directory).catch(() => resolve(directory));
      const repoReal = await realpath(repoRoot).catch(() => resolve(repoRoot));
      if (samePath(base, storeReal) || inside(storeReal, base) || samePath(base, repoReal)) {
        throw Error('Оберіть окрему папку поза службовим каталогом і коренем оркестратора');
      }
      if (input.revision !== (store.data.ui?.revision ?? 0)) throw Error('Конфлікт збереження: оновіть сторінку');
      const name = pending.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim().slice(0, 64) || 'Проєкт';
      const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 8);
      const destination = join(base, `${name} - ${hash}`);
      await mkdir(destination);
      const actual = await realpath(destination);
      if (!inside(base, actual) || samePath(actual, storeReal) || inside(storeReal, actual) || input.revision !== (store.data.ui?.revision ?? 0)) {
        throw Error('Папку або робочий простір змінено. Повторіть створення.');
      }
      store.data.projectLocations ??= {};
      store.data.projectLocations[projectId] = actual;
    }
    if (adopted) { store.data.routing ??= {}; store.data.routing[adopted.projectId] = adopted; }
    const projectChat = getProjectChat();
    for (const oldId of Object.keys(store.data.projectChats ?? {})) if (!ids.has(oldId)) { delete store.data.projectChats[oldId]; projectChat?.remove?.(oldId); }
    for (const oldId of Object.keys(store.data.routing ?? {})) if (!ids.has(oldId)) delete store.data.routing[oldId];
    store.data.ui = { revision: input.revision + 1, workspace: structuredClone(value) };
    store.save();
    if (adopted) draftProposals.delete(input.routingDraftId);
    return store.data.ui;
  }

  async function launchReady(input) {
    let p = uiProject(input.projectId);
    if (p.revision !== input.revision) throw new Error('План змінився: відкрийте налаштування запуску знову');
    if (hasActiveRun(p.id)) throw new Error('Цей проєкт уже виконується або завершує скасування');
    const initialFingerprint = planFingerprint(routingPlan(p));
    await registry.scan();
    p = uiProject(input.projectId);
    if (p.revision !== input.revision || planFingerprint(routingPlan(p)) !== initialFingerprint) {
      throw new Error('План змінився: відкрийте налаштування запуску знову');
    }
    if (hasActiveRun(p.id)) throw new Error('Цей проєкт уже виконується або завершує скасування');
    const proposal = input.proposalId ? storedRouting(p.id) : null;
    if (input.proposalId && (!proposal || proposal.id !== input.proposalId || proposal.revision !== p.revision || proposal.planFingerprint !== planFingerprint(routingPlan(p)))) {
      throw new Error('Пропозиція AI застаріла або не знайдена');
    }
    if (proposal) {
      validateRouteAssignments(
        proposal,
        routingPlan(p),
        routingCandidates(routingPlan(p), registry.snapshot().routes, proposal.requirements, { domainProfiles }),
        { maxAgentsPerTask: proposal.maxAgentsPerTask, domainProfiles }
      );
    }
    const agents = [], tasks = [], seen = new Map();
    function bind(a, runtime) {
      if (!runtime) throw new Error(`Оберіть реального виконавця для ${a.name}`);
      if (!runtime.allowed) throw new Error(runtime.reason);
      const id = proposal ? `route-${createHash('sha256').update(runtime.id).digest('hex').slice(0, 16)}` : a.id;
      if (seen.has(id)) return id;
      seen.set(id, true);
      agents.push(executionAgent(registry.snapshot().routes.find(r => r.id === runtime.routeId), {
        id, name: proposal ? runtime.model : a.name, role: a.role, skills: a.skills ?? [], access: runtime.access, config,
        ...(runtime.provider === 'codex' && a.reasoningEffort !== undefined ? { reasoningEffort: a.reasoningEffort } : {})
      }));
      return id;
    }
    for (const t of p.tasks.filter(item => !item.parentId)) {
      let ids;
      if (proposal) {
        const assignment = proposal.assignments.find(a => a.taskId === t.id);
        if (!assignment?.routeIds?.length) throw Error('Неповне AI-призначення');
        ids = assignment.routeIds.map(routeId => bind(
          { role: t.title, skills: t.skills },
          runtimes().find(r => r.routeId === routeId && r.access === (proposal.requirements[t.id]?.workspaceWrite === false ? 'read-only' : 'workspace-write'))
        ));
      } else {
        ids = t.agentIds.map(id => {
          const a = store.data.ui.workspace.agents.find(item => item.id === id);
          if (!a) throw Error('Профіль виконавця не знайдено');
          const selected = input.bindings?.[id];
          const alias = selected === 'codex-write' ? `codex:${config.model}#write` : selected === 'codex-read' ? `codex:${config.model}#read` : selected;
          return bind(a, runtimes().find(r => r.id === alias));
        });
      }
      if (!ids.length) throw Error('Призначте виконавців задач');
      const acceptanceProfile = findAcceptanceProfile(t.id, domainProfiles);
      if (acceptanceProfile && (ids.length !== 1 || !agents.some(agent => agent.id === ids[0] && agent.access === 'workspace-write' && !agent.fileWorker))) {
        throw Error(acceptanceProfile.launchRuntimeError ?? 'Для браузерного приймання потрібен один виконавець із інструментами й доступом до запису');
      }
      tasks.push({
        id: t.id, title: t.title, prompt: t.prompt, skills: t.skills ?? [], agentIds: ids, dependsOn: t.dependsOn,
        ...(reviewRuns ? { selfReview: true } : {}),
        acceptanceCriteria: t.acceptanceCriteria ?? [], mode: t.mode ?? 'pipeline',
        allowDelegation: !acceptanceProfile && p.allowDelegation !== false && t.allowDelegation !== false
      });
    }
    const requirements = structuredClone(proposal?.requirements ?? {});
    const allFree = Boolean(p.planning?.freeWorkers) || (tasks.length > 0 && tasks.every(task =>
      requirements[task.id]?.billing === 'free_tier' || task.agentIds.every(id => agents.find(a => a.id === id)?.billing === 'free_tier')));
    if (allFree) {
      for (const task of tasks) requirements[task.id] = { workspaceWrite: true, ...requirements[task.id], billing: 'free_tier' };
    }
    if (reviewRuns) {
      const finalId = `project-review-${randomUUID()}`;
      const need = { workspaceWrite: false, ...(allFree ? { billing: 'free_tier' } : { tools: true }) };
      const route = reviewRoute(agents, need);
      const reviewer = route ? projectReviewer(route) : null;
      if (reviewer) agents.push(reviewer);
      requirements[finalId] = need;
      tasks.push({
        id: finalId, title: 'Незалежне фінальне рев’ю проєкту', prompt: 'Перевірити інтегрований проєкт і надати незалежний висновок.',
        agentIds: reviewer ? [reviewer.id] : [], dependsOn: tasks.map(task => task.id), projectReview: true, allowDelegation: false
      });
    }
    const dir = await workspace(p.id);
    const maxCalls = input.maxCalls ?? p.maxCalls;
    if ((reviewRuns || input.maxCalls !== undefined) && (!Number.isSafeInteger(maxCalls) || maxCalls < plannedCalls(tasks) || maxCalls > 10000)) {
      throw Error(`Для призначеної команди потрібно щонайменше ${plannedCalls(tasks)} викликів (максимум 10\u00a0000)`);
    }
    const recoveryManager = p.recovery?.managerRouteId ?? proposal?.managerRouteId;
    const inputProject = {
      name: p.name, goal: p.description, executionBrief: p.executionBrief ?? '', uiProjectId: p.id, uiRevision: p.revision, planning: p.planning,
      uiPlanFingerprint: planFingerprint(routingPlan(p)), routingRequirements: requirements,
      recovery: { enabled: p.recovery?.enabled ?? true, maxAttempts: p.recovery?.maxAttempts ?? 2, ...(recoveryManager ? { managerRouteId: recoveryManager } : {}) },
      workspace: dir, workspaceMode: 'isolated', agents, tasks, ...(proposal ? { routingProposalId: proposal.id } : {}),
      limits: { concurrency: p.concurrency, maxCalls, timeoutMs: config.timeoutMs ?? null, maxOutputTokens: 12000, maxDepth: p.allowDelegation === false ? 0 : p.maxDepth ?? 2, maxTasks: Math.min(1000, (p.maxTasks ?? 100) + Number(reviewRuns)) }
    };
    const previous = Object.values(store.data.projects).find(v => v.uiProjectId === p.id && !v.projectChatId);
    const project = previous ? engine.updateProject(previous.id, { ...inputProject, revision: previous.revision }) : engine.createProject(inputProject);
    const beforeFiles = await workspaceFiles(dir);
    return engine.start(project.id, { beforeFiles });
  }

  async function launch(input) {
    if (launching.has(input.projectId)) throw new Error('Запуск цього проєкту вже готується');
    launching.add(input.projectId);
    try { return await launchReady(input); } finally { launching.delete(input.projectId); }
  }

  async function launchChatEdit(projectId, message, earlier, shouldWait) {
    const dir = await workspace(uiProject(projectId).id);
    const beforeFiles = await workspaceFiles(dir);
    const freeOnly = isFreeTierProject(store, storedRouting, projectId) && message.allowSubscription !== true;
    const requirements = () => {
      const explicit = Object.values(storedRouting(projectId)?.requirements ?? {}).filter(need => need.workspaceWrite !== false);
      const allowed = !message.allowSubscription && explicit.length && explicit.every(need => need.allowedRouteIds)
        ? [...new Set(explicit.flatMap(need => need.allowedRouteIds))] : null;
      const billing = freeOnly ? 'free_tier'
        : (!message.allowSubscription && explicit[0]?.billing && explicit.every(need => need.billing === explicit[0].billing) ? explicit[0].billing : undefined);
      return { workspaceWrite: true, ...(allowed ? { allowedRouteIds: allowed } : {}), ...(billing ? { billing } : {}) };
    };
    const candidates = need => registry.snapshot().routes.filter(route =>
      ['codex', 'opencode', 'antigravity'].includes(route.backend) && suits(route, need));
    if (!candidates(requirements()).length) await registry.scan();
    if (shouldWait()) return;
    const p = uiProject(projectId);
    const maxCalls = Math.min(p.maxCalls ?? 4, reviewRuns ? 4 : 3);
    if (reviewRuns && maxCalls < 2) throw Error('Для правки з самоперевіркою потрібно щонайменше два виклики.');
    const need = requirements();
    let route;
    if (message.routeId) {
      route = await registry.requireRoute(message.routeId, { refresh: false });
      if (isFreeTierProject(store, storedRouting, projectId) && route.billing !== 'free_tier' && message.allowSubscription !== true) {
        throw Object.assign(Error('Чат проєкту зберігає безкоштовний режим (free_tier). Перехід на підписку потребує явного підтвердження користувача.'),
          { decisionCode: 'free_chat_subscription_required' });
      }
      if (!suits(route, { workspaceWrite: true, ...(freeOnly ? { billing: 'free_tier' } : {}) })) {
        throw Error('Обрана модель для чату недоступна або не має права запису файлів.');
      }
    } else {
      route = candidates(need).sort((a, b) => Number(Boolean(b.capabilities?.tools)) - Number(Boolean(a.capabilities?.tools)) ||
        quotaUse(a) - quotaUse(b) || Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))[0];
    }
    if (!route) {
      if (freeOnly) {
        throw Object.assign(
          Error('Проєкт працює в безкоштовному режимі (free_tier), а зараз немає доступної безкоштовної моделі з правом запису. Перехід на підписку потребує явного вибору користувача.'),
          { decisionCode: 'free_chat_unavailable' }
        );
      }
      throw Error('Немає доступної моделі з правом запису й підтвердженим тарифом. Перевірте підключення та повторіть запуск.');
    }
    const agent = executionAgent(route, { role: 'Розробник', config });
    const taskId = `chat-${message.id}`;
    const prior = Object.values(store.data.projects).find(project => project.projectChatId === message.id);
    const input = {
      name: p.name, goal: p.description, executionBrief: p.executionBrief ?? '', uiProjectId: p.id, uiRevision: p.revision,
      ...(freeOnly ? { planning: { ...p.planning, freeWorkers: true } } : p.planning ? { planning: p.planning } : {}),
      projectChatId: message.id, uiPlanFingerprint: planFingerprint(routingPlan(p)), routingRequirements: { [taskId]: need },
      recovery: { enabled: p.recovery?.enabled ?? true, maxAttempts: 1, ...(p.recovery?.managerRouteId ? { managerRouteId: p.recovery.managerRouteId } : {}) },
      workspace: dir, workspaceMode: 'isolated', agents: [agent],
      tasks: [{
        id: taskId, title: 'Правки з чату проєкту',
        prompt: `Внеси зміни з повідомлення нижче в поточну версію проєкту. Переглянь наявну реалізацію, збережи роботу поза межами запиту, виконай відповідні тести й опиши зміни українською.\n\n${earlier.length ? `Попередні виконані запити для контексту (не повторюй їх):\n${JSON.stringify(earlier)}\n\n` : ''}Поточний запит користувача:\n${message.text}`,
        agentIds: [agent.id], allowDelegation: false, ...(reviewRuns ? { selfReview: true } : {})
      }],
      limits: { concurrency: 1, maxCalls, maxDepth: 0, maxTasks: 1, timeoutMs: config.timeoutMs ?? null, maxOutputTokens: 12000 }
    };
    const project = prior ? engine.updateProject(prior.id, { ...input, revision: prior.revision }) : engine.createProject(input);
    engine.start(project.id, { beforeFiles });
  }

  return { saveWorkspace, launch, launchChatEdit };
}

export async function handleRunActionRoute({
  req, res, url, send, readBody, run, action,
  store, engine, registry, hostVerifier, config,
  streams, launching, hostQueued, hostChecks,
  isCurrentRun, isHostChecking, hasActiveRun, uiProject,
  present, verifyOnHost, refreshEmptyDraft, projectReviewer
}) {
  if (req.method === 'GET' && action === 'events') {
    let close;
    close = streamRun(engine, run, req, res, { present, hostChecking: () => isHostChecking(run), onClose: () => streams.delete(close) });
    if (!res.writableEnded) streams.add(close);
    return true;
  }
  if (req.method === 'POST' && ['pause', 'resume', 'cancel'].includes(action)) {
    if (action === 'cancel' && isHostChecking(run) && !['running', 'paused'].includes(run.status)) {
      hostQueued.delete(run.id);
      hostChecks.get(run.id)?.abort(new Error('Локальну перевірку скасовано користувачем'));
      send(200, await present(run));
      return true;
    }
    if (action === 'cancel') {
      hostQueued.delete(run.id);
      hostChecks.get(run.id)?.abort(new Error('Run cancelled'));
    }
    send(200, await present(engine[action](run.id)));
    return true;
  }
  if (req.method === 'POST' && action === 'retry-project-review') {
    const projectId = run.project.uiProjectId;
    if (!isCurrentRun(run) || launching.has(projectId) || isHostChecking(run) || hasActiveRun(projectId, run.id)) {
      throw Error('План змінився або проєкт уже виконується');
    }
    const body = await readBody(req).catch(() => ({})) ?? {};
    const finalTask = run.tasks.find(item => item.projectReview);
    if (!finalTask) throw Error('Фінальне рев’ю для цього запуску не налаштоване');
    if (body.routeId !== undefined) {
      if (typeof body.routeId !== 'string' || !body.routeId.trim()) throw Error('Вкажіть коректний маршрут моделі для рев’ю');
      const need = run.project.routingRequirements?.[finalTask.id] ?? { workspaceWrite: false };
      const freeReview = need.billing === 'free_tier' || isFreeTierRun(run);
      await registry.scan();
      const chosen = await registry.requireRoute(body.routeId, { refresh: false });
      if (freeReview && chosen.billing !== 'free_tier' && body.allowSubscription !== true) {
        throw Error('Перехід фінального рев’ю з безкоштовного режиму на підписку потребує явного вибору користувача');
      }
      const authors = reviewAuthors(run);
      if (authors.some(a => a.model.toLowerCase() === chosen.model.toLowerCase() || `${a.provider}:${a.model}` === chosen.id)) {
        throw Error('Фінальний рецензент має відрізнятися від моделей-виконавців проєкту');
      }
      if (!suits(chosen, { workspaceWrite: false })) throw Error('Обрана модель не підходить для режиму рецензування');
      const reviewer = projectReviewer(chosen);
      if (!run.project.agents.some(a => a.id === reviewer.id)) run.project.agents.push(reviewer);
      finalTask.explicitReviewerRouteId = chosen.id;
      finalTask.agentIds = [reviewer.id];
      if (chosen.billing !== 'free_tier') {
        run.project.routingRequirements[finalTask.id] = { ...need, billing: chosen.billing, allowedRouteIds: [chosen.id], explicitSubscriptionApproval: true };
        engine.event(run, 'task.project_review_subscription_selected', {
          taskId: finalTask.id, routeId: chosen.id, model: chosen.model,
          message: `Користувач явно обрав модель підписки для фінального рев’ю: ${chosen.model}`
        });
      }
    }
    send(202, await present(engine.retryProjectReview(run)));
    return true;
  }
  if (req.method === 'POST' && action === 'budget') {
    const input = await readBody(req), projectId = run.project.uiProjectId;
    if (!isCurrentRun(run)) throw Error('План змінився: ліміт старого запуску не можна редагувати');
    if (launching.has(projectId) || isHostChecking(run)) throw Error('Дочекайтеся завершення поточної операції із запуском');
    send(200, await present(engine.increaseBudget(run.id, input)));
    return true;
  }
  if (req.method === 'POST' && action === 'verify-host') {
    const input = await readBody(req), task = engine.hostVerificationTask(run, input.taskId);
    const plan = task && hostVerifier.plan(run, task, { partial: true });
    if (!plan) throw Error('Для цієї чернетки потрібні дозволені локальні перевірки');
    send(200, await present(await verifyOnHost(run, task, plan)));
    return true;
  }
  if (req.method === 'POST' && action === 'balance-gemini') {
    const projectId = run.project.uiProjectId;
    if (launching.has(projectId) || isHostChecking(run) || !unstartedTasks(engine, run, { isCurrentRun, isHostChecking }).length) {
      throw Error('Запуск активний або немає нерозпочатих задач');
    }
    launching.add(projectId);
    try {
      await registry.scan();
      const assignments = geminiAssignments(engine, run, registry.snapshot().routes, { isCurrentRun, isHostChecking });
      if (!assignments.length) throw Error('Немає сумісних нерозпочатих задач або доступної квоти Gemini');
      const agents = new Map(run.project.agents.map(agent => [agent.id, agent])), byTask = new Map();
      for (const { task, original, route } of assignments) {
        const agent = executionAgent(route, { access: original.access, role: task.title, skills: task.skills, config });
        if (!agents.has(agent.id)) agents.set(agent.id, agent);
        byTask.set(task.id, agent.id);
      }
      const nextTasks = run.tasks.map(task => byTask.has(task.id) ? { ...task, agentIds: [byTask.get(task.id)] } : task);
      validateProject({ ...run.project, agents: [...agents.values()], tasks: nextTasks });
      run.project.agents = [...agents.values()];
      run.tasks = nextTasks;
      engine.event(run, 'run.gemini_balanced', {
        assignments: assignments.map(({ task, original, route }) => ({ taskId: task.id, from: original.model, to: route.id })),
        message: `Нерозпочаті задачі передано Gemini: ${assignments.map(({ task }) => task.title).join(', ')}`
      });
      send(200, await present(run));
      return true;
    } finally { launching.delete(projectId); }
  }
  if (req.method === 'POST' && action === 'clarify') {
    engine.restoreBlockedReports(run);
    const input = await readBody(req), projectId = run.project.uiProjectId;
    if (typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 6000 || !['task', 'project', undefined].includes(input.scope)) {
      throw Error('Потрібне уточнення до 6000 символів і допустима область застосування');
    }
    if (!isCurrentRun(run)) throw Error('План змінився: уточнювати старий запуск не можна');
    if (!engine.canClarify(run)) throw Error('Запуск не очікує уточнення або бюджет вичерпано');
    if (launching.has(projectId) || isHostChecking(run) || hasActiveRun(projectId, run.id)) {
      throw Error('Інший запуск або локальна перевірка цього проєкту вже активні');
    }
    const task = run.tasks.find(t => t.id === input.taskId && ((t.failure?.code === 'AGENT_BLOCKED' && t.status === 'blocked') || reportNeedsCorrection(t) || workspaceNeedsResolution(t) || waitsForVerification(t)));
    if (!task?.workspace) throw Error('Не знайдено чернетку задачі, яка очікує уточнення');
    launching.add(projectId);
    try {
      let lease = workspaceNeedsResolution(task) ? await engine.workspaces.resolveDraft(run, task.workspace, task.id) : await engine.workspaces.resume(run, task.workspace);
      let replacement;
      if (input.routeId !== undefined) {
        const team = selectAgents(run.project, task);
        if (typeof input.routeId !== 'string' || input.scope === 'project' || team.length !== 1 || !team[0].fileWorker || task.failure?.code !== 'AGENT_BLOCKED') {
          throw Error('Заміна доступна для заблокованої чернетки одного файлового виконавця');
        }
        const route = await registry.requireRoute(input.routeId);
        if (taskRequiresFree(run, task) && route.billing !== 'free_tier' && input.allowSubscription !== true) {
          throw Error('Задача працює в безкоштовному режимі (free_tier). Перехід на підписку потребує явного вибору користувача.');
        }
        const access = team[0].access;
        const baseNeed = { ...routingRequirement(run, task), tools: true, workspaceWrite: access === 'workspace-write' };
        if (input.allowSubscription === true && baseNeed.billing === 'free_tier') delete baseNeed.billing;
        if (route.backend !== 'codex' || !suits(route, baseNeed)) {
          throw Error('Маршрут не має підтвердженого доступу до потрібних інструментів');
        }
        replacement = executionAgent(route, { access, role: task.title, skills: task.skills, config });
        lease = await refreshEmptyDraft(run, task, lease);
      }
      if (!isCurrentRun(run)) throw Error('План змінився під час перевірки чернетки');
      const updated = engine.clarify(run.id, { taskId: task.id, answer: input.answer, projectScope: input.scope === 'project', lease, replacement });
      if (input.scope === 'project') uiProject(projectId).executionBrief = updated.project.executionBrief;
      store.save();
      send(202, await present(updated));
      return true;
    } finally { launching.delete(projectId); }
  }
  if (req.method === 'POST' && ['continue', 'retry-access', 'retry-budget', 'resume-cancelled'].includes(action)) {
    const accessRetry = action === 'retry-access';
    const { taskId, routeId, allowSubscription } = accessRetry ? (await readBody(req) ?? {}) : {};
    if (routeId !== undefined && (typeof routeId !== 'string' || typeof taskId !== 'string')) {
      throw Error('Потрібні точні ідентифікатори задачі та моделі');
    }
    const budgetRetry = action === 'retry-budget';
    const cancelledResume = action === 'resume-cancelled';
    const projectId = run.project.uiProjectId;
    if (!isCurrentRun(run)) throw Error('План змінився: продовжувати старий запуск не можна');
    if (launching.has(projectId) || isHostChecking(run) || hasActiveRun(projectId, run.id)) {
      throw Error('Інший запуск або локальна перевірка цього проєкту вже активні');
    }
    const eligible = cancelledResume ? engine.canResumeCancelled(run) : budgetRetry ? engine.canRetryBudget(run)
      : accessRetry ? engine.canRetryAccess(run, taskId) : engine.canContinue(run);
    if (!eligible) throw Error('Немає відповідних задач, які можна продовжити в межах бюджету');
    launching.add(projectId);
    try {
      const dir = await engine.workspaces.assertBase(run.project.workspace, projectId);
      const uninitialized = cancelledResume && run.calls === 0 && !run.tasks.some(task => task.workspace || task.resumeWorkspace) &&
        !(await lstat(join(dir, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }));
      if (!uninitialized && (!samePath(resolve(await engine.workspaces.git(dir, ['rev-parse', '--show-toplevel'])), resolve(dir)) || await engine.workspaces.git(dir, ['status', '--porcelain']))) {
        throw Error('Прийнята робоча папка змінилася; перевірте зміни перед продовженням');
      }
      let replacement, replacementWorkspace;
      if (cancelledResume || accessRetry || budgetRetry) {
        const candidates = cancelledResume ? engine.cancelledRunTasks(run)
          : (accessRetry ? retryableAccessTasks(run, taskId) : run.tasks.filter(budgetBlocked)).map(task => ({ task, draft: task.workspace }));
        const routes = new Set();
        await registry.scan();
        for (const { task, draft } of candidates) {
          let agents = selectAgents(run.project, task);
          if (routeId !== undefined) {
            if (agents.length !== 1 || !agents[0].fileWorker) throw Error('Заміна доступна для одного файлового виконавця');
            const route = await registry.requireRoute(routeId, { refresh: false }), access = agents[0].access;
            if (taskRequiresFree(run, task) && route.billing !== 'free_tier' && allowSubscription !== true) {
              throw Error('Задача працює в безкоштовному режимі (free_tier). Перехід на підписку потребує явного вибору користувача.');
            }
            const baseNeed = { ...routingRequirement(run, task), tools: true, workspaceWrite: access === 'workspace-write' };
            if (allowSubscription === true && baseNeed.billing === 'free_tier') delete baseNeed.billing;
            if (route.backend !== 'codex' || !suits(route, baseNeed)) {
              throw Error('Маршрут не має підтвердженого доступу до потрібних інструментів');
            }
            replacement = executionAgent(route, { access, role: task.title, skills: task.skills, config });
            agents = [replacement];
          }
          if (task.reviewerId) {
            const reviewer = run.project.agents.find(agent => agent.id === task.reviewerId && agent.enabled !== false);
            if (!reviewer) throw Error('Рецензент недоступний');
            agents.push(reviewer);
          }
          for (const agent of agents) routes.add(`${agent.provider}:${agent.model}`);
          if (draft) {
            const verified = await engine.workspaces.resume(run, draft);
            if (replacement) {
              const fresh = await refreshEmptyDraft(run, task, verified);
              if (fresh !== verified) replacementWorkspace = { path: fresh.cwd, branch: fresh.branch, baseCommit: fresh.baseCommit };
            }
          }
        }
        for (const route of routes) await registry.requireRoute(route, { refresh: false });
      }
      if (!isCurrentRun(run)) throw Error('План змінився під час підготовки продовження');
      if (cancelledResume) { send(202, await present(engine.resumeCancelled(run.id))); return true; }
      if (budgetRetry) { send(202, await present(engine.retryBudget(run.id))); return true; }
      send(202, await present(accessRetry ? engine.retryAccess(run.id, taskId, replacement, replacementWorkspace) : engine.continueTimedOut(run.id, { timeoutMs: config.timeoutMs ?? null })));
      return true;
    } finally { launching.delete(projectId); }
  }
  if (req.method === 'POST' && action === 'recover') {
    if (!isCurrentRun(run)) throw Error('План змінився: відновлювати старий запуск не можна');
    if (launching.has(run.project.uiProjectId) || isHostChecking(run) || hasActiveRun(run.project.uiProjectId, run.id)) {
      throw Error('Інший запуск або локальна перевірка цього проєкту вже активні');
    }
    send(202, engine.requestRecovery(run.id));
    return true;
  }
  if (req.method === 'POST' && action === 'cancel-task') {
    send(200, engine.cancelTask(run.id, (await readBody(req)).taskId));
    return true;
  }
  if (req.method === 'GET' && action === 'file') {
    send(200, await readRunArtifactFile(engine.workspaces, run, url.searchParams.get('path')));
    return true;
  }
  if (req.method === 'GET' && !action) {
    send(200, await present(run));
    return true;
  }
  return false;
}
