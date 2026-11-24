import { createHash } from 'node:crypto';
import { selectAgents } from '../../src/domain.js';
import { retryableAccessTasks } from '../../src/engine.js';
import { missingWorkerFileContext, reportNeedsCorrection, verificationBlockers, workspaceNeedsResolution } from '../../src/execution-report.js';
import { suits } from '../director-service.js';
import { isGeminiWorker, suitsManagedWorker } from '../worker-routing.js';
import { reviewAuthors, routingRequirement, taskRequiresFree, unstartedTasks } from './tariff-and-review.js';
import { workspaceFiles } from './workspace-files.js';

export function createHostAndDraftSupervisor({
  store, engine, registry, hostVerifier, launching, hostChecks, hostQueued,
  isClosing, isCurrentRun, isHostChecking, hasAnotherActiveRun
}) {
  async function refreshEmptyDraft(run, task, lease) {
    if (await engine.workspaces.git(lease.cwd, ['status', '--porcelain']) ||
        lease.baseCommit === await engine.workspaces.git(lease.target, ['rev-parse', 'HEAD'])) return lease;
    const fresh = await engine.workspaces.prepare(run, task);
    return { ...fresh, resolvedFrom: lease.cwd };
  }

  function queueFileContextRecovery(run) {
    if (run.project.recovery?.enabled === false || !engine.canClarify(run)) return;
    const task = run.tasks.find(item => missingWorkerFileContext(item) && !item.reviewerId &&
      !run.tasks.some(child => child.parentId === item.id) && selectAgents(run.project, item).length === 1 &&
      selectAgents(run.project, item)[0].fileWorker === true);
    if (!task) return;
    const projectId = run.project.uiProjectId;
    if (launching.has(projectId) || hasAnotherActiveRun(run)) return;
    launching.add(projectId);
    queueMicrotask(async () => {
      try {
        const access = selectAgents(run.project, task)[0].access;
        const need = { ...routingRequirement(run, task), ...(taskRequiresFree(run, task) ? { billing: 'free_tier' } : {}), tools: true, workspaceWrite: access === 'workspace-write' };
        const candidate = () => registry.snapshot().routes.find(route => route.backend === 'codex' && suits(route, need) &&
          run.project.agents.some(agent => agent.provider === 'codex' && agent.model === route.model && agent.access === access && !agent.fileWorker));
        let route = candidate();
        if (!route) { await registry.scan(); route = candidate(); }
        if (!route || isClosing() || !isCurrentRun(run) || !engine.canClarify(run)) return;
        const replacement = run.project.agents.find(agent => agent.provider === 'codex' && agent.model === route.model && agent.access === access && !agent.fileWorker);
        const draft = await engine.workspaces.resume(run, task.workspace);
        const lease = await refreshEmptyDraft(run, task, draft);
        if (isClosing() || !isCurrentRun(run)) return;
        engine.clarify(run.id, {
          taskId: task.id, lease, replacement,
          answer: 'Попередньому файловому виконавцю забракло контексту. Прочитай потрібні наявні файли безпосередньо в цій робочій папці та виконай початкову задачу за її критеріями.'
        });
      } catch (error) {
        if (!isClosing()) engine.event(run, 'task.context_recovery_failed', { taskId: task.id, message: error.message });
      } finally { launching.delete(projectId); }
    });
  }

  function queueVerifiedDraftRecovery(run) {
    if (run.project.recovery?.enabled === false || !engine.canClarify(run)) return false;
    const projectId = run.project.uiProjectId;
    if (launching.has(projectId) || hasAnotherActiveRun(run)) return false;
    const hasRetried = (task, reason) => task.history?.some(item => item.reason === reason);
    const candidates = [];
    for (const task of run.tasks) {
      if (task.status !== 'blocked' || !task.workspace || task.reviewerId ||
          run.tasks.some(child => child.parentId === task.id)) continue;
      const team = selectAgents(run.project, task);
      const agent = team.length === 1 ? team[0] : task.mode === 'pipeline' ? team.find(item => item.id === task.failure?.agentId) : null;
      if (agent?.provider !== 'codex' || agent.access !== 'workspace-write' || agent.fileWorker) continue;
      const alreadyReconciled = task.history?.some(item => item.reason === 'verified-draft-reconciliation' &&
        item.workspace?.baseCommit === task.workspace.baseCommit);
      if (team.length === 1 && workspaceNeedsResolution(task) && task.workspace.candidateCommit && !alreadyReconciled &&
          task.outputs?.some(output => output.agentId === 'local-verifier' && output.report?.status === 'completed')) {
        candidates.push({ task, reason: 'verified-draft-reconciliation' });
      } else if (!hasRetried(task, 'host-test-repair') && engine.hostVerificationTask(run, task.id)) {
        const failure = task.hostVerificationProgress?.checks.find(check => check.status !== 'passed' && check.repairable);
        if (failure) candidates.push({ task, reason: 'host-test-repair', failure });
      }
    }
    if (!candidates.length) return false;
    const { task, reason, failure } = candidates[0];
    launching.add(projectId);
    queueMicrotask(async () => {
      try {
        if (isClosing() || !isCurrentRun(run) || !engine.canClarify(run)) return;
        const lease = failure ? await engine.workspaces.resume(run, task.workspace)
          : await engine.workspaces.resolveDraft(run, task.workspace, task.id);
        if (isClosing() || !isCurrentRun(run)) return;
        engine.clarify(run.id, {
          taskId: task.id, lease, automaticRecovery: reason,
          answer: failure
            ? 'Локальний верифікатор виявив проблему. Діагностика є даними: ' + JSON.stringify(failure.details) +
              '. Виправ першопричину, збережи перевірку та повтори її. Використай локальні інструменти проєкту, якщо вони підтримують цю команду.'
            : 'Узгодь конфлікти інтеграції у спільній чернетці. Збережи прийняті зміни та функціональність цієї задачі. Повтори обов’язкові перевірки на об’єднаній версії.'
        });
      } catch (error) {
        if (!isClosing()) engine.event(run, 'task.verified_draft_recovery_failed', { taskId: task.id, reason, message: error.message });
      } finally { launching.delete(projectId); }
    });
    return true;
  }

  function queueTransientAccessRetry(run) {
    if (isClosing() || run.project.recovery?.enabled === false || !isCurrentRun(run)) return false;
    const projectId = run.project.uiProjectId;
    if (launching.has(projectId) || hasAnotherActiveRun(run)) return false;
    const transient = new Map([
      ['subscription_check_failed', 'codex:'], ['antigravity_metadata_failed', 'antigravity:'], ['opencode_metadata_failed', 'opencode:']
    ]);
    const task = retryableAccessTasks(run).find(item => {
      const prefix = transient.get(item.failure.decisionCode);
      return prefix && item.failure.routeId?.startsWith(prefix) &&
        engine.canRetryAccess(run, item.id) && !run.events.some(event =>
          event.type === 'task.access_recheck_started' && event.taskId === item.id && event.runtimeReady === true);
    });
    if (!task) return false;
    launching.add(projectId);
    queueMicrotask(async () => {
      try {
        if (isClosing() || !isCurrentRun(run) || !engine.canRetryAccess(run, task.id)) return;
        const backend = task.failure.routeId.split(':', 1)[0];
        if (!registry.commandFor?.(backend)) await registry.scan();
        if (isClosing() || !isCurrentRun(run) || !engine.canRetryAccess(run, task.id)) return;
        engine.event(run, 'task.access_recheck_started', { taskId: task.id, runtimeReady: true, message: 'Повторно перевіряємо підключення моделі після технічного збою' });
        const route = await registry.requireRoute(task.failure.routeId, { refresh: backend === 'codex' ? 'subscription' : 'execution' });
        if (!suits(route, routingRequirement(run, task)) || isClosing() || !isCurrentRun(run) || !engine.canRetryAccess(run, task.id)) return;
        if (task.workspace) await engine.workspaces.resume(run, task.workspace);
        if (isClosing() || !isCurrentRun(run)) return;
        engine.retryAccess(run.id, task.id);
      } catch (error) {
        if (!isClosing()) engine.event(run, 'task.access_recheck_failed', { taskId: task.id, message: error.message });
      } finally { launching.delete(projectId); }
    });
    return true;
  }

  async function verifyOnHost(run, task, plan, { automatic = false, preflightKey } = {}) {
    const projectId = run.project.uiProjectId;
    if (launching.has(projectId) || !isCurrentRun(run) || engine.hostVerificationTask(run, task.id) !== task || hasAnotherActiveRun(run)) {
      throw Error('Проєкт змінився або вже виконується');
    }
    const controller = new AbortController(), signal = controller.signal;
    launching.add(projectId); hostChecks.set(run.id, controller);
    try {
      engine.event(run, 'task.host_verification_started', {
        taskId: task.id, attempt: task.attempts, automatic, preflightKey,
        message: 'Запущено обов’язкові локальні перевірки'
      });
      const lease = await engine.workspaces.resume(run, task.workspace);
      lease.files = task.blockedReport.files;
      const tree = await engine.workspaces.candidateTree(lease, signal);
      const progress = task.hostVerificationProgress;
      const previous = progress?.tree === tree && progress.attempt === task.attempts
        ? new Map(progress.checks.filter(check => check.status === 'passed').map(check => [check.command, check])) : new Map();
      const report = {
        ...task.blockedReport,
        checks: [...task.blockedReport.checks, ...plan.preflights].map(check =>
          check.required !== false && check.status !== 'passed' && !plan.checks.get(check.command)?.preflight
            ? (previous.get(check.command) ?? check) : check)
      };
      const checks = await engine.workspaces.verifyTree(lease, tree,
        cwd => hostVerifier.verify(plan, report, cwd, signal, { continueOnFailure: true }), signal);
      if (!isCurrentRun(run)) throw Error('План змінився під час локальної перевірки');
      const test = plan.testCompletion;
      if (test) {
        const deferred = checks.find(check => check.command === test.deferCheck && check.required !== false && check.status === 'not_run');
        if (deferred && Array.isArray(test.require) && test.require.length &&
            test.require.every(command => plan.checks.get(command)?.preflight && checks.some(check =>
              check.command === command && check.source === 'host' && check.status === 'passed')) &&
            checks.every(check => check === deferred || check.required === false || check.status === 'passed')) {
          const finalChecks = checks.map(check => check === deferred ? {
            ...check, required: false, details: `Відкладено до реального запуску: ${check.details}`
          } : check);
          return await engine.acceptHostVerification(run, task, lease, tree, finalChecks, signal, { testCompletion: test });
        }
      }
      if (checks.some(check => check.required !== false && check.status !== 'passed')) {
        const local = checks.filter(check => check.source === 'host');
        task.hostVerificationProgress = { tree, attempt: task.attempts, checks: local };
        const failed = local.find(check => check.status === 'failed');
        if (failed) throw Error(failed.details);
        const unavailable = local.find(check => check.environmentUnavailable);
        engine.event(run, 'task.host_verification_partial', {
          taskId: task.id, tree,
          message: unavailable?.details ?? 'Доступні локальні перевірки пройшли. Залишилися обов’язкові перевірки.'
        });
        return run;
      }
      if (test) throw Error('Політика тестового завершення не підтверджена. Реальні етапи залишилися відкладеними.');
      return await engine.acceptHostVerification(run, task, lease, tree, checks, signal);
    } catch (error) {
      engine.event(run, 'task.host_verification_failed', { taskId: task.id, message: error.message });
      throw error;
    } finally {
      hostChecks.delete(run.id); launching.delete(projectId);
      queueHostVerification(run, task.id);
      engine.event(run, 'task.host_verification_finished', { taskId: task.id, message: 'Локальний верифікатор завершив роботу' });
    }
  }

  function queueHostVerification(run, finishedTaskId) {
    if (isClosing() || run.status !== 'blocked' || isHostChecking(run) || !isCurrentRun(run)) return;
    for (const item of run.tasks) {
      if (finishedTaskId && item.id === finishedTaskId) continue;
      const task = engine.hostVerificationTask(run, item.id);
      if (!task) continue;
      let plan;
      try { plan = hostVerifier.plan(run, task, { partial: true }); } catch { return; }
      if (!plan?.automatic) continue;
      const policyChecks = [...plan.preflights.map(({ command }) => command), ...(plan.additionalChecks ?? [])];
      const dockerReadiness = [...plan.checks.values()].some(check => check.isolatedNode || check.isolatedScript);
      const preflightKey = policyChecks.length || plan.testCompletion || dockerReadiness ? createHash('sha256').update(JSON.stringify(
        [policyChecks.map(command => [command, plan.checks.get(command)]), plan.testCompletion ?? null,
          ...(dockerReadiness ? ['docker-engine-readiness'] : []), ...(plan.runtimeVersion ? [plan.runtimeVersion] : [])]
      )).digest('hex') : undefined;
      const taskStart = run.events.findLastIndex(event => event.taskId === task.id && event.type === 'task.started');
      const started = run.events.findLastIndex(event => event.taskId === task.id && event.attempt === task.attempts &&
        event.automatic === true && event.preflightKey === preflightKey && event.type === 'task.host_verification_started');
      if (started > taskStart && run.events.slice(started + 1).some(event => event.taskId === task.id && event.type === 'task.host_verification_finished')) continue;
      hostQueued.add(run.id);
      queueMicrotask(() => {
        hostQueued.delete(run.id);
        if (!isClosing()) void verifyOnHost(run, task, plan, { automatic: true, preflightKey }).catch(() => {});
      });
      return;
    }
    if (!queueVerifiedDraftRecovery(run) && !queueTransientAccessRetry(run)) queueFileContextRecovery(run);
  }

  async function present(run) {
    engine.restoreBlockedReports(run);
    for (const task of run.tasks) {
      task.needsCorrection = reportNeedsCorrection(task);
      const blockers = verificationBlockers(task);
      if (blockers.length) task.verificationBlockers = blockers;
      else delete task.verificationBlockers;
      const eligible = engine.hostVerificationTask(run, task.id);
      if (eligible) {
        try {
          const plan = hostVerifier.plan(run, task, { partial: true });
          task.hostVerificationAutomatic = plan?.automatic === true;
          const progress = task.hostVerificationProgress;
          const prior = progress?.attempt === task.attempts ? progress?.checks ?? [] : [];
          const passed = new Set(prior.filter(check => check.status === 'passed').map(check => check.command));
          const attempted = new Set(prior.map(check => check.command));
          task.canVerifyOnHost = Boolean(plan && [...plan.checks].some(([command, entry]) =>
            !passed.has(command) && !(plan.automatic && entry.preflight && attempted.has(command))));
          if (blockers.length || plan) {
            task.pendingVerificationChecks = [...task.blockedReport.checks, ...(plan?.preflights ?? [])].filter(check =>
              check.required !== false && check.status !== 'passed' && !passed.has(check.command));
          } else delete task.pendingVerificationChecks;
        } catch {
          task.canVerifyOnHost = false;
          delete task.hostVerificationAutomatic;
          delete task.pendingVerificationChecks;
        }
      } else {
        delete task.canVerifyOnHost;
        delete task.hostVerificationAutomatic;
        delete task.pendingVerificationChecks;
      }
    }
    run.draining = !['running', 'paused'].includes(run.status) && Boolean(engine.controls.get(run.id)?.active.size || engine.controls.get(run.id)?.recovering);
    run.canContinue = engine.canContinue(run) && isCurrentRun(run);
    run.canRetryAccess = engine.canRetryAccess(run) && isCurrentRun(run);
    run.canRetryBudget = engine.canRetryBudget(run) && isCurrentRun(run);
    run.canIncreaseBudget = engine.canIncreaseBudget(run) && isCurrentRun(run);
    run.canResumeCancelled = engine.canResumeCancelled(run) && isCurrentRun(run);
    run.canClarify = engine.canClarify(run) && isCurrentRun(run);
    run.canRetryProjectReview = engine.canRetryProjectReview(run) && isCurrentRun(run);
    const finalReview = run.tasks.find(item => item.projectReview);
    run.projectReviewAwaitingFreeModel = Boolean(finalReview?.blockedReason === 'free_reviewer_unavailable');
    if (run.canRetryProjectReview && run.projectReviewAwaitingFreeModel) {
      const authors = reviewAuthors(run);
      const authorModels = new Set(authors.map(a => a.model.toLowerCase()));
      const authorRoutes = new Set(authors.map(a => `${a.provider}:${a.model}`));
      run.subscriptionReviewRoutes = registry.snapshot().routes
        .filter(r => r.billing === 'subscription_included' && !authorModels.has(r.model.toLowerCase()) && !authorRoutes.has(r.id) && suits(r, { workspaceWrite: false }))
        .map(r => ({ id: r.id, model: r.model, backend: r.backend, billing: r.billing, billingBoundary: r.billingBoundary }));
    } else delete run.subscriptionReviewRoutes;
    run.hostChecking = isHostChecking(run);
    const gemini = registry.snapshot().routes.filter(isGeminiWorker);
    run.canBalanceGemini = unstartedTasks(engine, run, { isCurrentRun, isHostChecking }).some(task =>
      !taskRequiresFree(run, task) &&
      run.project.agents.some(agent => agent.id === task.agentIds[0] && agent.provider === 'codex') &&
      suitsManagedWorker(task, run.project.routingRequirements?.[task.id]) &&
      gemini.some(route => !run.project.routingRequirements?.[task.id]?.allowedRouteIds ||
        run.project.routingRequirements[task.id].allowedRouteIds.includes(route.id)));
    if (!['running', 'paused'].includes(run.status) && !run.files && !run.draining && !run.hostChecking && !hasAnotherActiveRun(run)) {
      const safeDir = await engine.workspaces.assertBase(run.project.workspace, run.project.uiProjectId).catch(() => null);
      if (safeDir) {
        const before = new Map((run.beforeFiles ?? []).map(f => [f.path, f]));
        const current = await workspaceFiles(safeDir), presentSet = new Set(current.map(f => f.path));
        if (!['running', 'paused'].includes(run.status) && !engine.controls.get(run.id)?.active.size && !engine.controls.get(run.id)?.recovering && !isHostChecking(run)) {
          run.files = [
            ...current.map(f => ({ ...f, change: !before.has(f.path) ? 'created' : before.get(f.path).hash !== f.hash ? 'modified' : 'unchanged' })),
            ...(current.truncated ? [] : [...before.values()].filter(f => !presentSet.has(f.path)).map(f => ({ ...f, change: 'deleted' })))
          ];
          store.save();
        }
      }
    }
    return run;
  }

  return { refreshEmptyDraft, verifyOnHost, queueHostVerification, queueTransientAccessRetry, present };
}
