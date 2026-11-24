import { assert, selectAgents, validateProject } from '../domain.js';
import { codexUsageLimitMessage } from '../providers.js';
import { reportNeedsCorrection, workspaceNeedsResolution, waitsForVerification } from '../execution-report.js';

export const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled', 'interrupted', 'deferred']);

export const makeRunControl = () => ({
  controller: new AbortController(),
  taskControllers: new Map(),
  taskWorkspaces: new Map(),
  active: new Map(),
  callsActive: 0,
  waiters: []
});

export const timedOut = task => ['failed', 'blocked'].includes(task.status) &&
  (task.failure?.code === 'AGENT_TIMEOUT' || (task.failure?.code === 23 && /aborted due to timeout/i.test(task.failure.message)));

export const accessBlocked = task => ['failed', 'blocked'].includes(task.status) &&
  (task.failure?.code === 'MODEL_ACCESS_BLOCKED' || (task.failure?.code === 'AGENT_FAILED' &&
    task.failure.routeId?.startsWith('codex:') && codexUsageLimitMessage(task.failure.message)));

export const retryableAccessTasks = (run, taskId) => run.tasks.filter(task => (taskId === undefined || task.id === taskId) && accessBlocked(task));

export const budgetBlocked = task => ['failed', 'blocked'].includes(task.status) &&
  (task.failure?.code === 'RUN_CALL_BUDGET' || (task.failure?.code === 'AGENT_FAILED' && task.error === 'Run call budget exhausted'));

export const needsClarification = task => task.status === 'blocked' && task.failure?.code === 'AGENT_BLOCKED';

export const canReply = task => !task.projectReview &&
  (needsClarification(task) || reportNeedsCorrection(task) || workspaceNeedsResolution(task) || waitsForVerification(task));

export function unblockTasks(tasks, reset) {
  let changed;
  do {
    changed = false;
    for (const task of tasks) {
      if (task.status !== 'blocked' || task.error || task.failure) continue;
      const children = tasks.filter(t => t.parentId === task.id);
      const deps = task.dependsOn.map(id => tasks.find(t => t.id === id));
      if (children.some(t => reset.has(t.id)) && children.every(t => t.status === 'completed' || reset.has(t.id))) {
        task.status = 'waiting_children';
        reset.add(task.id);
        changed = true;
      } else if (deps.some(t => reset.has(t.id)) && deps.every(t => t.status === 'completed' || (task.projectReview && t.status === 'deferred') || reset.has(t.id))) {
        task.status = 'pending';
        reset.add(task.id);
        changed = true;
      }
    }
  } while (changed);
}

export function propagateBlockedTasks(tasks) {
  let changed;
  do {
    changed = false;
    for (const t of tasks) {
      if (t.status === 'pending' && t.dependsOn.some(key => ['failed', 'blocked', 'cancelled'].includes(tasks.find(d => d.id === key)?.status))) {
        t.status = 'blocked';
        changed = true;
      } else if (t.status === 'waiting_children') {
        const children = tasks.filter(c => c.parentId === t.id);
        if (children.some(c => ['failed', 'blocked', 'cancelled'].includes(c.status))) {
          t.status = 'blocked';
          changed = true;
        }
      }
    }
  } while (changed);
}

export function cancelledRunTasks(run) {
  if (run.status !== 'cancelled') return [];
  const cancellation = run.events.findLast(event => event.type === 'run.cancelled');
  if (!cancellation) return [];
  const individuallyCancelled = new Set(run.events.filter(event => event.type === 'task.cancelled').map(event => event.taskId));
  const byId = new Map(run.tasks.map(task => [task.id, task]));
  const wasIndividuallyCancelled = task => task && (individuallyCancelled.has(task.id) ||
    (task.parentId && wasIndividuallyCancelled(byId.get(task.parentId))));
  return run.tasks.filter(task => task.status === 'cancelled' && (cancellation.taskStates
    ? Object.hasOwn(cancellation.taskStates, task.id)
    : !wasIndividuallyCancelled(task))).map(task => {
    const previous = cancellation.taskStates?.[task.id];
    const lastStartOrDelegation = previous === undefined && run.events.findLast(event =>
      event.taskId === task.id && ['task.started', 'task.delegated'].includes(event.type));
    const waitingForChildren = previous === 'waiting_children' || lastStartOrDelegation?.type === 'task.delegated';
    const draft = task.resumeWorkspace ?? (waitingForChildren ? undefined : task.workspace);
    return { task, draft, status: waitingForChildren ? 'waiting_children' : 'pending' };
  });
}

export function canResumeCancelledRun(engine, run) {
  const control = engine.controls.get(run.id);
  if (run.status !== 'cancelled' || run.project.workspaceMode !== 'isolated' || !engine.workspaces ||
      control?.active.size || control?.recovering || run.calls >= run.project.limits.maxCalls) return false;
  const candidates = cancelledRunTasks(run);
  if (!candidates.length) return false;
  if (control) return true;
  const lastCancellationOrDrain = run.events.findLast(event => ['run.cancelled', 'run.drained'].includes(event.type));
  return lastCancellationOrDrain.type === 'run.drained' ||
    !(lastCancellationOrDrain.draining ?? candidates.some(({ draft }) => draft));
}

export function applyCancelledResume(engine, key) {
  const run = engine.run(key);
  assert(canResumeCancelledRun(engine, run), 'Немає скасованих задач, які можна продовжити в межах бюджету');
  const resumed = cancelledRunTasks(run);
  const at = new Date().toISOString();
  for (const { task, draft, status } of resumed) {
    task.history ??= [];
    task.history.push({
      reason: 'manual-cancelled-resume', at, status: task.status, workspace: task.workspace,
      outputs: task.outputs, result: task.result, review: task.review, attempts: task.attempts
    });
    if (draft) {
      task.resumeWorkspace = draft;
      task.resumeFiles = [...new Set([...(task.resumeFiles ?? []), ...task.outputs.flatMap(output => output.report?.files ?? [])])];
    }
    task.status = status;
    task.outputs = [];
    for (const field of ['workspace', 'result', 'review', 'assignedAgentIds']) delete task[field];
  }
  unblockTasks(run.tasks, new Set(resumed.map(({ task }) => task.id)));
  run.status = 'running';
  run.canResumeCancelled = false;
  delete run.finishedAt;
  delete run.files;
  if (run.recovery) {
    run.recovery.status = 'idle';
    delete run.recovery.reason;
  }
  engine.controls.set(key, makeRunControl());
  engine.event(run, 'run.cancelled_resumed', {
    taskIds: resumed.map(({ task }) => task.id),
    message: 'Продовжено скасований запуск. Готові результати, чернетки та витрачені виклики збережено.'
  });
  engine.pump(run);
  return run;
}

export function restoreBlockedReports(engine, run) {
  if (!['failed', 'blocked'].includes(run.status) || engine.controls.get(run.id)?.active.size || engine.controls.get(run.id)?.recovering) return;
  let restored = false;
  for (const task of run.tasks) {
    if (!['failed', 'blocked'].includes(task.status) || task.failure?.code !== 'AGENT_FAILED' || !task.error?.startsWith('Codex blocked: ')) continue;
    let report;
    for (const event of run.events.filter(e => e.taskId === task.id && e.type === 'agent.progress' && e.kind === 'agent_message').reverse()) {
      try {
        const candidate = JSON.parse(event.message);
        if (candidate.status === 'blocked' && typeof candidate.summary === 'string' &&
            task.error.startsWith(`Codex blocked: ${candidate.summary}`) &&
            Array.isArray(candidate.files) && candidate.files.every(p => typeof p === 'string') &&
            Array.isArray(candidate.checks)) {
          report = candidate;
          break;
        }
      } catch { /* A truncated progress frame cannot reconstruct a report. */ }
    }
    task.blockedReport = report ?? { status: 'blocked', summary: task.error.slice('Codex blocked: '.length).split('\n')[0], files: [], checks: [] };
    task.failure.code = 'AGENT_BLOCKED';
    task.status = 'blocked';
    restored = true;
  }
  if (restored) {
    run.status = 'blocked';
    engine.event(run, 'run.blocked', { message: 'Очікуємо уточнення користувача; підготовлені матеріали збережено в ізольованій папці' });
  }
}

export function applyClarification(engine, key, { taskId, answer, projectScope = false, lease, replacement, automaticRecovery } = {}) {
  const run = engine.run(key);
  assert(engine.canClarify(run), 'Run is not waiting for clarification or its call budget is exhausted');
  assert(typeof answer === 'string' && answer.trim() && answer.length <= 6000, 'Потрібне уточнення до 6000 символів');
  const task = run.tasks.find(t => t.id === taskId);
  assert(task && canReply(task), 'Задача не очікує уточнення');
  const brief = projectScope ? [run.project.executionBrief, answer.trim()].filter(Boolean).join('\n\n') : run.project.executionBrief;
  assert((brief?.length ?? 0) <= 12000, 'Загальне уточнення перевищує 12000 символів');
  assert(lease && (lease.cwd === task.workspace?.path || ((workspaceNeedsResolution(task) || replacement) && lease.resolvedFrom === task.workspace?.path)), 'Потрібна перевірена папка чернетки');
  const previousAgentIds = task.agentIds;
  if (replacement) {
    const agents = run.project.agents.some(agent => agent.id === replacement.id) ? run.project.agents : [...run.project.agents, replacement];
    validateProject({ ...run.project, agents, tasks: run.tasks.map(item => item === task ? { ...item, agentIds: [replacement.id] } : item) });
    run.project.agents = agents;
    task.agentIds = [replacement.id];
  }
  const reason = automaticRecovery ?? (replacement ? 'resume-with-tools' : 'user-clarification');
  task.history ??= [];
  task.history.push({
    reason, at: new Date().toISOString(), status: task.status, error: task.error, failure: task.failure,
    report: task.blockedReport, workspace: task.workspace, outputs: task.outputs, agentIds: previousAgentIds, attempts: task.attempts
  });
  task.clarifications ??= [];
  task.clarifications.push({
    at: new Date().toISOString(), answer: answer.trim(), projectScope,
    ...(automaticRecovery ? { source: 'orchestrator' } : {})
  });
  task.resumeWorkspace = { path: lease.cwd, branch: lease.branch, baseCommit: lease.baseCommit, conflicts: lease.conflicts };
  task.resumeFiles = task.blockedReport?.files ?? task.outputs.flatMap(o => o.report?.files ?? []);
  if (lease.conflicts?.length) task.clarifications.at(-1).integrationConflicts = lease.conflicts;
  if (replacement) delete task.pipelineContinuation;
  else if (automaticRecovery === 'host-test-repair' && task.mode === 'pipeline') {
    const step = selectAgents(run.project, task).findIndex(agent => agent.id === task.failure?.agentId);
    if (step >= 0) task.pipelineContinuation = step;
  }
  task.status = 'pending';
  task.attempts = 0;
  task.outputs = task.outputs.slice(0, task.pipelineContinuation ?? 0);
  for (const field of ['error', 'failure', 'blockedReport', 'blockedReason', 'blockedRouteId', 'result', 'review', 'assignedAgentIds', 'hostVerificationProgress', 'verificationBlockers', 'integrationContext', 'recoveryContext']) {
    delete task[field];
  }
  unblockTasks(run.tasks, new Set([task.id]));
  if (projectScope) run.project.executionBrief = brief;
  run.status = 'running';
  run.canClarify = false;
  delete run.finishedAt;
  delete run.files;
  if (run.recovery) {
    run.recovery.status = 'idle';
    delete run.recovery.reason;
  }
  engine.controls.set(key, makeRunControl());
  const message = automaticRecovery === 'verified-draft-reconciliation' ? 'Оркестратор відновив перевірену чернетку для узгодження конфлікту'
    : automaticRecovery === 'host-test-repair' ? 'Оркестратор передав діагностику невдалого тесту виконавцю'
    : replacement ? `Чернетку передано виконавцю з доступом до робочої папки (${replacement.model})`
    : 'Уточнення користувача збережено; продовжуємо з підготовленої чернетки';
  engine.event(run, automaticRecovery ? 'run.draft_recovery_started' : 'run.clarified', { taskId, message, projectScope });
  engine.pump(run);
  return run;
}

export function applyTimedOutContinuation(engine, key, { timeoutMs = null, accessRetry = false, budgetRetry = false, taskId, replacement, replacementWorkspace } = {}) {
  const run = engine.run(key);
  assert(engine.canContinue(run, { accessRetry, budgetRetry, taskId }), 'Only a drained retryable run with remaining call budget can continue');
  const next = structuredClone(run.tasks), reset = new Set();
  const candidates = accessRetry ? retryableAccessTasks({ tasks: next }, taskId) : next.filter(budgetRetry ? budgetBlocked : timedOut);
  assert(!replacement || (accessRetry && taskId && candidates.length === 1), 'A replacement requires one access-blocked task');
  for (const task of candidates) {
    if ((accessRetry || budgetRetry) && task.workspace) {
      task.resumeWorkspace = task.workspace;
      task.resumeFiles = [...new Set([
        ...(task.resumeFiles ?? []),
        ...(task.blockedReport?.files ?? []),
        ...task.outputs.flatMap(o => o.report?.files ?? []),
        ...(task.history?.findLast(h => h.report?.files)?.report.files ?? [])
      ])];
    }
    if (replacementWorkspace) task.resumeWorkspace = replacementWorkspace;
    task.history ??= [];
    task.history.push({
      reason: budgetRetry ? 'manual-budget-retry' : accessRetry ? 'manual-access-retry' : 'manual-timeout-continuation',
      at: new Date().toISOString(), status: task.status, error: task.error, failure: task.failure,
      report: task.blockedReport, workspace: task.workspace, outputs: task.outputs, agentIds: task.agentIds, attempts: task.attempts
    });
    if (replacement) task.agentIds = [replacement.id];
    if (replacement || !task.resumeWorkspace) delete task.pipelineContinuation;
    task.status = 'pending';
    task.attempts = 0;
    task.outputs = task.outputs.slice(0, task.pipelineContinuation ?? 0);
    for (const field of ['error', 'failure', 'blockedReport', 'blockedReason', 'blockedRouteId', 'workspace', 'result', 'review', 'assignedAgentIds', 'hostVerificationProgress', 'verificationBlockers', 'integrationContext', 'recoveryContext']) {
      delete task[field];
    }
    reset.add(task.id);
  }
  unblockTasks(next, reset);
  const agents = replacement && !run.project.agents.some(agent => agent.id === replacement.id) ? [...run.project.agents, replacement] : run.project.agents;
  const limits = { ...run.project.limits, timeoutMs };
  validateProject({ ...run.project, agents, limits, tasks: next });
  const previousTimeoutMs = run.project.limits.timeoutMs;
  run.project.agents = agents;
  run.project.limits = limits;
  run.tasks = next;
  run.status = 'running';
  run.canContinue = false;
  run.canRetryAccess = false;
  run.canRetryBudget = false;
  delete run.finishedAt;
  delete run.files;
  if (run.recovery) {
    run.recovery.status = 'idle';
    delete run.recovery.reason;
  }
  engine.controls.set(key, makeRunControl());
  engine.event(run, budgetRetry ? 'run.budget_retried' : accessRetry ? 'run.access_retried' : 'run.continued', {
    taskIds: [...reset], previousTimeoutMs, timeoutMs, replacementModel: replacement?.model,
    message: budgetRetry ? 'Продовжено задачі в межах збільшеного бюджету'
      : accessRetry ? 'Доступ перевірено; продовжено заблоковані виклики зі збереженої чернетки'
      : 'Продовжено задачі після таймауту; готові результати та витрачені виклики збережено'
  });
  engine.pump(run);
  return run;
}

export function applyRecoveryAssignments(engine, run, { agents, assignments, round }) {
  const control = engine.controls.get(run.id);
  assert(control?.recovering && !control.active.size && ['running', 'paused'].includes(run.status), 'Recovery is no longer active');
  const allAgents = [...run.project.agents];
  for (const a of agents) if (!allAgents.some(old => old.id === a.id)) allAgents.push(a);
  const next = structuredClone(run.tasks), reset = new Set();
  for (const assignment of assignments) {
    const task = next.find(t => t.id === assignment.taskId);
    assert(task && ['failed', 'blocked'].includes(task.status) && !reset.has(task.id), 'Invalid recovery assignment');
    assert(Array.isArray(assignment.agentIds) && assignment.agentIds.length, 'Recovery requires assigned agents');
    task.history ??= [];
    task.history.push({
      round, at: new Date().toISOString(), status: task.status, error: task.error, failure: task.failure,
      workspace: task.workspace, outputs: task.outputs, agentIds: task.agentIds, attempts: task.attempts
    });
    task.recoveryContext = { round, previousFailure: task.failure, reason: assignment.reason };
    task.agentIds = assignment.agentIds;
    task.status = 'pending';
    task.recoveryAttempts = (task.recoveryAttempts ?? 0) + 1;
    task.attempts = 0;
    task.outputs = [];
    for (const key of ['error', 'failure', 'blockedReport', 'blockedReason', 'blockedRouteId', 'workspace', 'result', 'review', 'assignedAgentIds', 'hostVerificationProgress', 'verificationBlockers', 'integrationContext', 'pipelineContinuation']) {
      delete task[key];
    }
    reset.add(task.id);
  }
  unblockTasks(next, reset);
  validateProject({ ...run.project, agents: allAgents, tasks: next });
  run.project.agents = allAgents;
  run.tasks = next;
  delete run.files;
  delete run.finishedAt;
  engine.event(run, 'recovery.applied', {
    round, taskIds: assignments.map(a => a.taskId), resetTaskIds: [...reset],
    message: 'Нові призначення застосовано; готові результати збережені'
  });
  return [...reset];
}
