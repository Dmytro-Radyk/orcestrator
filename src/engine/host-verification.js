import { assert, selectAgents } from '../domain.js';
import { verificationBlockers } from '../execution-report.js';
import { findAcceptanceProfile } from '../domain-profiles.js';
import { makeRunControl, unblockTasks } from './run-state.js';

export function findHostVerificationTask(engine, run, key) {
  const control = engine.controls.get(run.id);
  if (!['blocked', 'failed'].includes(run.status) || run.project.workspaceMode !== 'isolated' || !engine.workspaces ||
      control?.active.size || control?.recovering) return;
  const task = run.tasks.find(item => item.id === key);
  const team = task ? selectAgents(run.project, task) : [];
  const pipelineStep = team.findIndex(agent => agent.id === task?.failure?.agentId);
  const sharedPipeline = task?.mode === 'pipeline' && pipelineStep >= 0 &&
    team.slice(0, pipelineStep).every((agent, index) => task.outputs[index]?.agentId === agent.id);
  if (task && task.workspace && (verificationBlockers(task).length ||
      (task.status === 'blocked' && task.failure?.code === 'AGENT_BLOCKED' && task.blockedReport?.checks?.length)) &&
      !task.reviewerId && (!task.selfReview || task.selfReviewedTree) && (team.length === 1 || sharedPipeline) &&
      !run.tasks.some(item => item.parentId === task.id)) {
    return task;
  }
}

export async function acceptHostVerifiedDraft(engine, run, task, lease, verifiedTree, checks, signal, { testCompletion } = {}) {
  assert(findHostVerificationTask(engine, run, task.id) === task, 'Чернетка більше не очікує перевірки');
  assert(!task.selfReview || task.selfReviewedTree === verifiedTree, 'Чернетку змінено після самоперевірки');
  const deferred = [];
  if (testCompletion) {
    const ids = testCompletion.deferTasks;
    assert(Array.isArray(ids) && ids.length && new Set(ids).size === ids.length, 'Некоректний перелік етапів запуску');
    const remaining = new Set(ids), dependencies = new Set([task.id]);
    assert(run.tasks.every(item => item === task || item.projectReview || item.status === 'completed' || remaining.has(item.id)),
      'Є незавершені задачі тестового запуску');
    while (remaining.size) {
      const item = run.tasks.find(candidate => remaining.has(candidate.id) && candidate.dependsOn.some(id => dependencies.has(id)));
      assert(item && ['blocked', 'pending'].includes(item.status) && !item.attempts && !item.workspace && !item.failure && !item.error,
        'Етап для відкладення має бути нерозпочатою залежною задачею');
      deferred.push(item);
      remaining.delete(item.id);
      dependencies.add(item.id);
    }
  }
  const summary = testCompletion ? 'Чернетку прийнято для тестового запуску. Перевірки реального запуску відкладено.' : task.blockedReport.summary;
  const report = { ...task.blockedReport, status: 'completed', summary, checks };
  const acceptanceProfile = findAcceptanceProfile(task.id, engine.domainProfiles);
  if (acceptanceProfile) {
    const audit = await engine.verifyDomainAcceptance(run, task, acceptanceProfile, lease, verifiedTree, signal);
    if (audit.status !== 'passed') throw Error(audit.issues.join(' '));
    assert(findHostVerificationTask(engine, run, task.id) === task, 'Чернетка більше не очікує перевірки');
  }
  const existingControl = engine.controls.get(run.id);
  assert(!existingControl?.active.size && !existingControl?.recovering, 'Запуск уже виконує іншу дію');
  const team = selectAgents(run.project, task);
  const verifiedStep = task.mode === 'pipeline' ? team.findIndex(agent => agent.id === task.failure?.agentId) : -1;
  if (verifiedStep >= 0 && verifiedStep < team.length - 1) {
    const at = new Date().toISOString();
    task.history ??= [];
    task.history.push({ reason: 'host-verification', at, status: task.status, error: task.error, failure: task.failure, report: task.blockedReport });
    task.outputs = task.outputs.slice(0, verifiedStep);
    task.outputs.push({ agentId: team[verifiedStep].id, text: report.summary, report, at, source: 'local-verifier' });
    task.pipelineContinuation = verifiedStep + 1;
    task.resumeWorkspace = task.workspace;
    task.resumeFiles = [...new Set(task.outputs.flatMap(output => output.report?.files ?? []))];
    task.status = 'pending';
    for (const field of ['error', 'failure', 'blockedReason', 'blockedRouteId', 'blockedReport', 'verificationBlockers', 'hostVerificationProgress']) {
      delete task[field];
    }
    run.status = 'running';
    delete run.finishedAt;
    delete run.files;
    engine.controls.set(run.id, makeRunControl());
    engine.event(run, 'task.pipeline_step_verified', {
      taskId: task.id, agentId: team[verifiedStep].id, tree: verifiedTree,
      message: 'Локальні перевірки етапу пройшли. Чернетку передано наступному виконавцю.'
    });
    engine.pump(run);
    return run;
  }
  try {
    const integrated = await engine.workspaces.publish(lease, signal, { verifiedTree });
    const afterPublishControl = engine.controls.get(run.id);
    assert(!afterPublishControl?.active.size && !afterPublishControl?.recovering, 'Стан запуску змінився під час інтеграції');
    task.workspace = { ...task.workspace, commit: integrated.commit };
  } catch (error) {
    if (error.candidateCommit) {
      task.workspace.candidateCommit = error.candidateCommit;
      task.status = 'blocked';
      task.error = error.message;
      task.failure = { code: 'WORKSPACE_CONFLICT', message: error.message };
      task.result = report.summary;
      task.outputs.push({ agentId: 'local-verifier', text: report.summary, report, at: new Date().toISOString() });
      engine.event(run, 'workspace.verification_conflict', { taskId: task.id, message: error.message });
    }
    throw error;
  }
  const at = new Date().toISOString();
  task.history ??= [];
  task.history.push({ reason: 'host-verification', at, status: task.status, error: task.error, failure: task.failure, report: task.blockedReport });
  task.outputs.push({ agentId: 'local-verifier', text: report.summary, report, at });
  task.result = `${report.summary}\n\nЛокальний верифікатор: ${checks.filter(check => check.source === 'host').map(check => check.command).join(', ')} — пройдено.`;
  task.status = 'completed';
  for (const field of ['error', 'failure', 'blockedReason', 'blockedRouteId', 'blockedReport', 'verificationBlockers', 'hostVerificationProgress', 'pipelineContinuation']) {
    delete task[field];
  }
  if (testCompletion) {
    for (const item of deferred) {
      item.status = 'deferred';
      item.result = 'Відкладено до окремого рішення про реальний запуск.';
    }
    run.testCompletion = { taskIds: deferred.map(item => item.id), deferredCheck: testCompletion.deferCheck };
    const finalReview = run.tasks.find(item => item.projectReview);
    if (!finalReview) {
      run.status = 'completed';
      run.finishedAt = at;
      delete run.files;
      engine.event(run, 'run.completed', {
        taskId: task.id, tree: verifiedTree, commit: task.workspace.commit, testCompletion: run.testCompletion,
        message: 'Тестовий запуск завершено. Реальний пілот і продажі відкладено.'
      });
      return run;
    }
    finalReview.status = 'pending';
  }
  unblockTasks(run.tasks, new Set([task.id]));
  run.status = 'running';
  delete run.finishedAt;
  delete run.files;
  engine.controls.set(run.id, makeRunControl());
  engine.event(run, 'task.host_verified', {
    taskId: task.id, tree: verifiedTree, commit: task.workspace.commit,
    message: 'Обов’язкові локальні перевірки пройшли. Чернетку прийнято без виклику моделі.'
  });
  engine.pump(run);
  return run;
}
