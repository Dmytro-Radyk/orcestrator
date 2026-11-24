import { fileURLToPath } from 'node:url';
import { assert, id, taskDefaults, validateProject } from '../domain.js';
import { workerHandoff } from '../execution-context.js';

export const reviewSchema = fileURLToPath(new URL('../../scripts/schemas/review.json', import.meta.url));

export async function runReviewVerdict(engine, run, task, agent, prompt, kind, lease, signal) {
  const reviewer = {
    ...agent,
    access: 'read-only',
    executionReport: false,
    instructions: 'Працюй лише на читання. Відкрий фактичні файли й перевір їх. Не змінюй проєкт, не виконуй зовнішніх дій і не вигадуй доказів.',
    outputSchema: agent.provider === 'codex' ? reviewSchema : undefined
  };
  const output = await engine.invoke(run, task, reviewer,
    `${prompt}\nПоверни лише JSON {"approved":true|false,"feedback":"висновок українською з конкретними файлами і причинами"}.`,
    { canDelegate: false, leaseOverride: lease, signal, review: kind });
  let verdict;
  try { verdict = JSON.parse(output.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch {}
  assert(typeof verdict?.approved === 'boolean' && typeof verdict.feedback === 'string' && verdict.feedback.trim(),
    'Модель не повернула коректний висновок рев’ю');
  const result = { approved: verdict.approved, feedback: verdict.feedback.trim(), agentId: agent.id };
  if (kind === 'self') {
    task.selfReviews ??= [];
    task.selfReviews.push(result);
  } else {
    task.review = result;
    task.result = result.feedback;
  }
  engine.event(run, kind === 'self' ? 'task.self_reviewed' : 'task.project_reviewed', {
    taskId: task.id, agentId: agent.id, ...result, message: result.feedback
  });
  return result;
}

export async function invokeWithSelfReview(engine, run, task, agent, prompt, options = {}) {
  if (!task.selfReview) return engine.invoke(run, task, agent, prompt, options);
  const control = engine.controls.get(run.id), parent = control.taskWorkspaces.get(task.id);
  const lease = options.fork && parent ? await engine.workspaces.fork(parent, agent.id) : parent;
  const signal = AbortSignal.any([control.controller.signal, control.taskControllers.get(task.id).signal, ...(options.signal ? [options.signal] : [])]);
  delete task.selfReviewedTree;
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let output, blocker;
    try {
      output = await engine.invoke(run, task, agent, prompt + feedback, { ...options, fork: false, leaseOverride: lease });
    } catch (error) {
      if (error.report?.status !== 'blocked' || !(error.report.files?.length || error.report.checks?.length)) throw error;
      blocker = error;
    }
    if (output && options.canDelegate) {
      let requests = output.delegation;
      if (!requests) {
        try { requests = JSON.parse(output.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')).subtasks; } catch {}
      }
      if (requests?.length) return output;
    }
    const candidate = workerHandoff(output ?? { agentId: agent.id, report: blocker.report });
    const verdict = await runReviewVerdict(engine, run, task, agent,
      `Самоперевірка власної роботи. Перевір поточну чернетку, критерії задачі й можливі регресії. Підтверджуй лише перевірене. Якщо в чернетці бракує лише обов’язкового тесту, недоступного в середовищі, зазнач його для локальної перевірки.\n\n${prompt}\n\nЗвіт виконавця: ${JSON.stringify(candidate).slice(0, 9000)}`,
      'self', lease, signal);
    if (verdict.approved) {
      if (!options.fork && lease && blocker) {
        lease.files = [...new Set([...(lease.files ?? []), ...(blocker.report.files ?? [])])];
        task.selfReviewedTree = await engine.workspaces.candidateTree(lease, signal);
      }
      if (blocker) throw blocker;
      if (options.fork && lease) Object.defineProperty(output, '_forkLease', { value: lease, enumerable: false });
      return output;
    }
    if (output) task.outputs.splice(task.outputs.indexOf(output), 1);
    if (attempt || run.calls + 2 > run.project.limits.maxCalls) {
      throw Object.assign(Error(`Самоперевірка виявила проблему: ${verdict.feedback}`), { code: 'AGENT_BLOCKED' });
    }
    feedback = `\n\nВиправ зауваження самоперевірки в наявній чернетці й повтори відповідні тести:\n${verdict.feedback}`;
  }
}

export async function runFinalProjectReview(engine, run, task) {
  const agent = await engine.selectProjectReviewer?.(run, task);
  assert(agent, 'Немає доступної окремої моделі для фінального рев’ю');
  task.assignedAgentIds = task.agentIds = [agent.id];
  const scope = run.tasks.filter(item => !item.projectReview && !item.parentId).map(item => ({
    title: item.title, status: item.status, criteria: item.acceptanceCriteria, summary: item.result?.slice(0, 480)
  }));
  const discovery = run.project.planning?.interview;
  const brief = discovery?.length ? `\nПогоджені відповіді користувача: ${JSON.stringify(discovery)}` : '';
  const verdict = await runReviewVerdict(engine, run, task, agent,
    `Незалежне фінальне рев’ю всього проєкту «${run.project.name}».\nМета: ${run.project.goal}${brief}\nПереглянь актуальні файли та звір із вимогами. Перевір суттєві ризики, якість коду, UX для користувацьких інтерфейсів і що підтверджують тести. Окремо вкажи явно відкладені етапи й те, що залишилося неперевіреним. Схвали лише за відсутності суттєвих блокерів у межах цього запуску.\nЕтапи запуску: ${JSON.stringify(scope)}`,
    'project');
  if (!verdict.approved) throw Object.assign(Error(`Фінальне рев’ю виявило блокери: ${verdict.feedback}`), { code: 'AGENT_BLOCKED' });
}

export async function runTaskReviewer(engine, run, task, team, prompt) {
  const reviewer = run.project.agents.find(a => a.id === task.reviewerId && a.enabled !== false);
  assert(reviewer, 'Reviewer unavailable');
  const taskFree = (run.project.routingRequirements?.[task.id]?.billing === 'free_tier' ||
    (team.length > 0 && team.every(a => a.billing === 'free_tier'))) &&
    !run.project.routingRequirements?.[task.id]?.explicitSubscriptionApproval;
  if (taskFree && reviewer.billing && reviewer.billing !== 'free_tier') {
    throw Object.assign(
      new Error('Безкоштовна задача не може використовувати підписного рецензента без явного вибору користувача'),
      { code: 'AGENT_BLOCKED', decisionCode: 'free_reviewer_unavailable' }
    );
  }
  const reviewAgent = {
    ...reviewer,
    access: 'read-only',
    executionReport: false,
    outputSchema: reviewer.provider === 'codex' ? reviewSchema : undefined
  };
  const review = await engine.invoke(run, task, reviewAgent,
    `${prompt}\nReview the candidate result. Return ONLY JSON {"approved":true|false,"feedback":"..."}.\nCandidate:\n${task.result}`,
    { canDelegate: false, review: 'task' });
  let verdict;
  try { verdict = JSON.parse(review.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch {}
  assert(typeof verdict?.approved === 'boolean', 'Reviewer returned invalid JSON verdict');
  task.review = verdict;
  assert(verdict.approved === true, `Review rejected: ${verdict.feedback ?? ''}`);
}

export function appendDelegatedChildren(engine, run, parent, requests) {
  assert(Array.isArray(requests) && requests.length <= 10, 'Invalid subtask list (maximum 10)');
  assert(parent.depth < run.project.limits.maxDepth, 'Subagent depth exceeded');
  assert(run.tasks.length + requests.length <= run.project.limits.maxTasks, 'Task limit exceeded');
  const parentAgents = (parent.assignedAgentIds ?? parent.agentIds).map(key => run.project.agents.find(a => a.id === key)).filter(Boolean);
  const parentCanWrite = parentAgents.some(a => a.access === 'workspace-write' || a.access === undefined);
  const parentFreeOnly = parentAgents.length > 0 && parentAgents.every(a => a.billing === 'free_tier');
  const children = requests.map(request => {
    const chosenIds = Array.isArray(request.agentIds) && request.agentIds.length ? request.agentIds.slice(0, 1) : parent.assignedAgentIds?.slice(0, 1) ?? [];
    for (const aid of chosenIds) {
      const target = run.project.agents.find(a => a.id === aid);
      assert(target, `Unknown agent: ${aid}`);
      assert(!run.tasks.some(task => task.projectReview && task.agentIds.includes(aid)), 'Фінальний рецензент має залишатися незалежним від виконання задач');
      if (!parentCanWrite && target.access === 'workspace-write') throw new Error('Read-only задача не може делегувати запис файлів');
      if (parentFreeOnly && target.billing && target.billing !== 'free_tier') throw new Error('Безкоштовна задача не може делегувати підписному виконавцю');
    }
    return taskDefaults({
      id: id(), title: request.title, prompt: request.prompt,
      skills: request.skills ?? parent.skills, agentIds: chosenIds, teamSize: 1,
      parentId: parent.id, depth: parent.depth + 1, status: 'pending', outputs: [], attempts: 0,
      allowDelegation: parent.allowDelegation === true, ...(parent.selfReview ? { selfReview: true } : {})
    });
  });
  validateProject({ ...run.project, tasks: [...run.tasks, ...children] });
  run.tasks.push(...children);
  parent.status = 'waiting_children';
  engine.event(run, 'task.delegated', { taskId: parent.id, childIds: children.map(t => t.id) });
}

export async function runDomainAcceptanceAudit(engine, run, task, profile, lease, tree, signal) {
  const verifier = Object.hasOwn(engine.acceptanceVerifiers, profile.id) ? engine.acceptanceVerifiers[profile.id] : undefined;
  const audit = verifier
    ? await engine.workspaces.verifyTree(lease, tree, cwd => verifier(run, cwd, signal), signal)
    : { status: 'unavailable', issues: ['Незалежний браузерний верифікатор не налаштовано.'] };
  const summary = profile.formatAuditSummary?.(audit);
  engine.event(run, profile.auditEventType ?? 'task.domain_audit', {
    taskId: task.id, status: audit.status, surfaces: audit.surfaces,
    message: [...audit.issues, summary].filter(Boolean).join('\n') || 'Незалежна браузерна перевірка пройшла.'
  });
  return audit;
}
