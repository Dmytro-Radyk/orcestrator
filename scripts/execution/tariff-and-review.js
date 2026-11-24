import { planFingerprint, suits } from '../director-service.js';
import { executionAgent } from '../execution-agent.js';
import { geminiByHeadroom, isGeminiWorker, quotaUse, suitsManagedWorker } from '../worker-routing.js';

export const routingPlan = p => ({
  summary: p.description || p.name,
  assumptions: [],
  risks: [],
  tasks: p.tasks.filter(t => !t.parentId).map(t => ({
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    skills: t.skills ?? [],
    dependsOn: t.dependsOn,
    acceptanceCriteria: t.acceptanceCriteria?.length ? t.acceptanceCriteria : ['Виконати інструкцію задачі та перевірити результат']
  }))
});

export function currentPlanError(store, run) {
  const p = store.data.ui?.workspace.projects.find(item => item.id === run.project.uiProjectId);
  if (!p) return 'План змінився під час відновлення: проєкт видалено з робочого простору';
  if (p.revision !== run.project.uiRevision) return `План змінився під час відновлення: ревізія ${run.project.uiRevision} → ${p.revision}`;
  if ((p.executionBrief ?? '') !== (run.project.executionBrief ?? '')) return 'План змінився під час відновлення: змінено уточнення вимог';
  if (planFingerprint(routingPlan(p)) === run.project.uiPlanFingerprint) return null;
  if ((p.description || p.name) !== run.project.goal) return 'План змінився під час відновлення: змінено опис проєкту';
  const tasks = p.tasks.filter(t => !t.parentId), originalTasks = run.project.tasks.filter(task => !task.projectReview);
  if (tasks.length !== originalTasks.length || tasks.some((t, i) => t.id !== originalTasks[i]?.id)) {
    return 'План змінився під час відновлення: змінено список або порядок задач';
  }
  const labels = { title: 'назва', prompt: 'інструкція', skills: 'навички', dependsOn: 'залежності', acceptanceCriteria: 'критерії готовності' };
  for (const task of tasks) {
    const original = run.project.tasks.find(t => t.id === task.id);
    for (const [key, label] of Object.entries(labels)) {
      if (JSON.stringify(task[key] ?? []) !== JSON.stringify(original[key] ?? [])) {
        return `План змінився під час відновлення: задача «${task.title}», ${label}`;
      }
    }
  }
  return 'План змінився під час відновлення: вміст плану не відповідає знімку запуску';
}

export function routingRequirement(run, task) {
  const requirements = run.project.routingRequirements ?? {};
  for (let current = task; current; current = run.tasks.find(parent => parent.id === current.parentId)) {
    if (Object.hasOwn(requirements, current.id)) return requirements[current.id];
  }
  return {};
}

export function taskRequiresFree(run, task) {
  const req = routingRequirement(run, task);
  if (req.billing) return req.billing === 'free_tier';
  if (run.project.planning?.freeWorkers === true) return true;
  const assigned = (task.assignedAgentIds ?? task.agentIds ?? []).map(id => run.project.agents.find(a => a.id === id)).filter(Boolean);
  return assigned.length > 0 && assigned.every(a => a.billing === 'free_tier');
}

export function isFreeTierRun(run) {
  if (run.project.planning?.freeWorkers === true) return true;
  const roots = run.tasks.filter(t => !t.projectReview && !t.parentId);
  return roots.length > 0 && roots.every(t => taskRequiresFree(run, t));
}

export function isFreeTierProject(store, storedRouting, projectId) {
  const routing = storedRouting(projectId);
  const reqValues = Object.values(routing?.requirements ?? {});
  if (reqValues.length) return reqValues.every(need => need?.billing === 'free_tier');
  const p = store.data.ui?.workspace.projects.find(item => item.id === projectId);
  if (p?.planning?.freeWorkers === true) return true;
  const latest = Object.values(store.data.runs)
    .filter(r => r.project.uiProjectId === projectId && !r.project.projectChatId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest ? isFreeTierRun(latest) : false;
}

export function reviewAuthors(run) {
  const authorIds = new Set(run.tasks.filter(item => !item.projectReview).flatMap(item => item.assignedAgentIds ?? item.agentIds));
  for (const event of run.events) if (event.type === 'agent.started' && !event.review) authorIds.add(event.agentId);
  return run.project.agents.filter(agent => authorIds.has(agent.id));
}

export function selectReviewRoute(registry, authors, need) {
  const models = new Set(authors.map(agent => agent.model.toLowerCase()));
  const authorRoutes = new Set(authors.map(agent => `${agent.provider}:${agent.model}`));
  return registry.snapshot().routes.filter(route => ['codex', 'opencode', 'antigravity'].includes(route.backend) &&
    !models.has(route.model.toLowerCase()) && !authorRoutes.has(route.id) && suits(route, need))
    .sort((a, b) => Number(Boolean(b.capabilities?.tools)) - Number(Boolean(a.capabilities?.tools)) ||
      Number(b.billing === 'free_tier') - Number(a.billing === 'free_tier') || quotaUse(a) - quotaUse(b) ||
      Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))[0];
}

export function createProjectReviewerTools({ registry, config }) {
  const projectReviewer = route => executionAgent(route, { access: 'read-only', role: 'Незалежний рецензент проєкту', config });
  const reviewRoute = (authors, need) => selectReviewRoute(registry, authors, need);
  async function selectProjectReviewer(run, task) {
    const authors = reviewAuthors(run);
    const models = new Set(authors.map(agent => agent.model.toLowerCase()));
    const authorRoutes = new Set(authors.map(agent => `${agent.provider}:${agent.model}`));
    const need = run.project.routingRequirements?.[task.id] ?? { workspaceWrite: false, ...(isFreeTierRun(run) ? { billing: 'free_tier' } : { tools: true }) };
    if (task.explicitReviewerRouteId) {
      let explicit = registry.snapshot().routes.find(r => r.id === task.explicitReviewerRouteId);
      if (!explicit || !suits(explicit, { workspaceWrite: false })) {
        await registry.scan();
        explicit = registry.snapshot().routes.find(r => r.id === task.explicitReviewerRouteId);
      }
      if (!explicit || models.has(explicit.model.toLowerCase()) || authorRoutes.has(explicit.id) || !suits(explicit, { workspaceWrite: false })) {
        throw Object.assign(Error('Обрана модель для фінального рев’ю недоступна або вже була виконавцем проєкту.'), { code: 'AGENT_BLOCKED', decisionCode: 'reviewer_unavailable' });
      }
      const reviewer = projectReviewer(explicit);
      if (!run.project.agents.some(agent => agent.id === reviewer.id)) run.project.agents.push(reviewer);
      return reviewer;
    }
    let route = reviewRoute(authors, need);
    if (!route) { await registry.scan(); route = reviewRoute(authors, need); }
    if (!route) {
      if (need.billing === 'free_tier') {
        throw Object.assign(
          Error('Очікує другу сумісну безкоштовну модель для незалежного фінального рев’ю. Перехід на підписку потребує явного вибору користувача.'),
          { code: 'AGENT_BLOCKED', decisionCode: 'free_reviewer_unavailable' }
        );
      }
      throw Object.assign(Error('Для фінального рев’ю потрібна доступна модель, відмінна від моделей-виконавців.'), { code: 'AGENT_BLOCKED', decisionCode: 'reviewer_unavailable' });
    }
    const reviewer = projectReviewer(route);
    if (!run.project.agents.some(agent => agent.id === reviewer.id)) run.project.agents.push(reviewer);
    return reviewer;
  }
  return { projectReviewer, reviewRoute, selectProjectReviewer };
}

export function unstartedTasks(engine, run, { isCurrentRun, isHostChecking }) {
  const control = engine.controls.get(run.id);
  if (!['failed', 'blocked'].includes(run.status) || run.project.workspaceMode !== 'isolated' || !isCurrentRun(run) ||
      control?.recovering || control?.active.size || isHostChecking(run)) return [];
  return run.tasks.filter(task => ['pending', 'blocked'].includes(task.status) && !task.attempts && !task.workspace &&
    !task.resumeWorkspace && !task.failure && !task.error && task.agentIds.length === 1 && !task.parentId && !task.reviewerId);
}

export function geminiAssignments(engine, run, routes, helpers) {
  const tasks = unstartedTasks(engine, run, helpers);
  const agents = new Map(run.project.agents.map(agent => [agent.id, agent]));
  const eligible = tasks.filter(task => !taskRequiresFree(run, task) && agents.get(task.agentIds[0])?.provider === 'codex' &&
    suitsManagedWorker(task, run.project.routingRequirements?.[task.id]));
  const existing = tasks.filter(task => {
    const agent = agents.get(task.agentIds[0]);
    return agent && isGeminiWorker({ backend: agent.provider, model: agent.model });
  }).length;
  const limit = Math.max(0, Math.ceil(tasks.length / 2) - existing);
  const gemini = geminiByHeadroom(routes);
  const assignments = [];
  for (const task of eligible.sort((a, b) => a.dependsOn.length - b.dependsOn.length)) {
    if (assignments.length >= limit) break;
    const original = agents.get(task.agentIds[0]);
    const need = { workspaceWrite: original.access !== 'read-only', ...run.project.routingRequirements?.[task.id] };
    const route = gemini.find(candidate => suits(candidate, need));
    if (route) assignments.push({ task, original, route });
  }
  return assignments;
}
