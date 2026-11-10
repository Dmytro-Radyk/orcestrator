import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { id, assert, makeProject, selectAgents, taskDefaults, validateProject } from './domain.js';
import { execute } from './providers.js';

const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled', 'interrupted']);
export class Engine {
  constructor(store, provider = execute) {
    this.store = store;
    this.provider = provider;
    this.controls = new Map();
    this.workspaceLocks = new Set();
  }
  createProject(input) {
    const project = makeProject(input);
    this.store.data.projects[project.id] = project;
    this.store.save();
    return project;
  }
  updateProject(key, input) {
    const old = this.project(key);
    assert(input.revision === old.revision, 'Revision conflict; reload the project');
    const project = makeProject({ ...old, ...input }, old);
    this.store.data.projects[key] = project;
    this.store.save();
    return project;
  }
  project(key) { const p = this.store.data.projects[key]; assert(p, 'Project not found'); return p; }
  run(key) { const r = this.store.data.runs[key]; assert(r, 'Run not found'); return r; }
  event(run, type, details = {}) {
    run.events.push({ at: new Date().toISOString(), type, ...details });
    this.store.save();
  }
  start(projectId) {
    const project = structuredClone(this.project(projectId));
    const run = { id: id(), projectId, revision: project.revision, project, status: 'running',
      createdAt: new Date().toISOString(), calls: 0, events: [], tasks: project.tasks.map(t => ({ ...t, status: 'pending', depth: 0, outputs: [], attempts: 0 })) };
    this.store.data.runs[run.id] = run;
    this.controls.set(run.id, { controller: new AbortController(), taskControllers: new Map(), active: new Map(), callsActive: 0, waiters: [] });
    this.event(run, 'run.started');
    this.pump(run);
    return run;
  }
  pause(key) {
    const run = this.run(key);
    assert(run.status === 'running', 'Only a running run can pause');
    run.status = 'paused'; this.event(run, 'run.paused'); return run;
  }
  resume(key) {
    const run = this.run(key);
    assert(run.status === 'paused', 'Only a paused run can resume');
    run.status = 'running'; this.event(run, 'run.resumed');
    this.wake(run); this.pump(run); return run;
  }
  cancel(key) {
    const run = this.run(key);
    assert(['running', 'paused'].includes(run.status), 'Run is already terminal');
    run.status = 'cancelled';
    for (const task of run.tasks) if (!terminal.has(task.status)) task.status = 'cancelled';
    this.controls.get(key).controller.abort(new Error('Run cancelled'));
    this.wake(run); this.event(run, 'run.cancelled'); return run;
  }
  approve(key, taskId) {
    const run = this.run(key), task = run.tasks.find(t => t.id === taskId);
    assert(['running', 'paused'].includes(run.status), 'Run is not active');
    assert(task?.status === 'awaiting_approval', 'Task is not awaiting approval');
    task.approved = true; task.status = 'pending'; this.event(run, 'task.approved', { taskId }); this.pump(run); return run;
  }
  cancelTask(key, taskId) {
    const run = this.run(key), task = run.tasks.find(t => t.id === taskId);
    assert(['running', 'paused'].includes(run.status), 'Run is not active');
    assert(task && !terminal.has(task.status), 'Task is missing or terminal');
    const cancel = t => {
      if (!terminal.has(t.status)) {
        t.status = 'cancelled';
        this.controls.get(key).taskControllers.get(t.id)?.abort(new Error('Task cancelled'));
      }
      for (const child of run.tasks.filter(child => child.parentId === t.id)) cancel(child);
    };
    cancel(task); this.wake(run); this.event(run, 'task.cancelled', { taskId }); this.pump(run); return run;
  }
  wake(run) {
    for (const resolve of this.controls.get(run.id)?.waiters.splice(0) ?? []) resolve();
  }
  async slot(run, task, agent) {
    const control = this.controls.get(run.id);
    // CLI jobs serialize within the same real workspace, including readers: no partial-write races.
    let lock;
    if (['cli', 'codex', 'claude'].includes(agent.provider)) {
      lock = realpathSync(resolve(run.project.workspace ?? process.cwd()));
      if (process.platform === 'win32') lock = lock.toLowerCase();
    }
    while (true) {
      control.controller.signal.throwIfAborted();
      control.taskControllers.get(task.id).signal.throwIfAborted();
      if (run.status === 'running' && control.callsActive < run.project.limits.concurrency && (!lock || !this.workspaceLocks.has(lock))) break;
      await new Promise(resolve => control.waiters.push(resolve));
    }
    assert(run.calls < run.project.limits.maxCalls, 'Run call budget exhausted');
    run.calls++; control.callsActive++;
    if (lock) this.workspaceLocks.add(lock);
    return () => {
      control.callsActive--;
      if (lock) this.workspaceLocks.delete(lock);
      for (const r of Object.values(this.store.data.runs)) this.wake(r);
    };
  }
  async invoke(run, task, agent, prompt) {
    const release = await this.slot(run, task, agent);
    const control = this.controls.get(run.id);
    const signal = AbortSignal.any([control.controller.signal, control.taskControllers.get(task.id).signal, AbortSignal.timeout(run.project.limits.timeoutMs)]);
    this.event(run, 'agent.started', { taskId: task.id, agentId: agent.id });
    try {
      const output = await this.provider(agent, {
        prompt: `Role: ${agent.role ?? agent.id}\nInstructions: ${agent.instructions ?? ''}\n\n${prompt}`,
        cwd: resolve(run.project.workspace ?? process.cwd()), signal, maxOutputTokens: run.project.limits.maxOutputTokens
      });
      signal.throwIfAborted();
      assert(typeof output.text === 'string' && output.text.length > 0, 'Empty agent result');
      const result = { agentId: agent.id, ...output, at: new Date().toISOString() };
      task.outputs.push(result);
      this.event(run, 'agent.completed', { taskId: task.id, agentId: agent.id, usage: output.usage });
      return result;
    } catch (error) {
      this.event(run, 'agent.failed', { taskId: task.id, agentId: agent.id, message: error.message });
      throw error;
    } finally { release(); }
  }
  addChildren(run, parent, requests) {
    assert(Array.isArray(requests) && requests.length <= 10, 'Invalid subtask list (maximum 10)');
    assert(parent.depth < run.project.limits.maxDepth, 'Subagent depth exceeded');
    assert(run.tasks.length + requests.length <= run.project.limits.maxTasks, 'Task limit exceeded');
    const children = requests.map(request => taskDefaults({ id: id(), title: request.title, prompt: request.prompt,
      skills: request.skills ?? parent.skills, agentIds: request.agentIds ?? [], teamSize: request.teamSize ?? 1,
      parentId: parent.id, depth: parent.depth + 1, status: 'pending', outputs: [], attempts: 0,
      allowDelegation: parent.allowDelegation === true }));
    // Validate the entire addition before mutating persisted run state.
    validateProject({ ...run.project, tasks: [...run.tasks, ...children] });
    run.tasks.push(...children);
    parent.status = 'waiting_children';
    this.event(run, 'task.delegated', { taskId: parent.id, childIds: children.map(t => t.id) });
  }
  async work(run, task) {
    task.attempts++;
    const team = selectAgents(run.project, task);
    task.assignedAgentIds = team.map(a => a.id);
    const dependencies = run.tasks.filter(t => task.dependsOn.includes(t.id)).map(t => ({ title: t.title, result: t.result }));
    const children = run.tasks.filter(t => t.parentId === task.id);
    const prompt = `Project: ${run.project.name}\nGoal: ${run.project.goal ?? ''}\nTask: ${task.title}\n${task.prompt}\nDependency results:\n${JSON.stringify(dependencies)}\n${task.review ? `Previous review feedback: ${JSON.stringify(task.review)}\n` : ''}`;
    if (children.length) {
      const output = await this.invoke(run, task, team[0], `${prompt}\nCombine child results into a final answer:\n${JSON.stringify(children.map(t => ({ title: t.title, result: t.result })))}`);
      task.result = output.text;
    } else {
      const canDelegate = task.allowDelegation === true && team.length === 1 && task.depth < run.project.limits.maxDepth;
      const delegation = canDelegate ? '\nIf splitting is needed, return ONLY JSON: {"subtasks":[{"title":"...","prompt":"...","skills":["..."]}]}. Use only available skills: ' + JSON.stringify([...new Set(run.project.agents.flatMap(a => a.skills))]) : '';
      let outputs = [];
      if (task.mode === 'pipeline') {
        for (const agent of team) outputs.push(await this.invoke(run, task, agent, `${prompt}${delegation}\nPrevious team results:\n${JSON.stringify(outputs)}`));
      } else {
        const results = await Promise.allSettled(team.map(agent => this.invoke(run, task, agent, prompt + delegation)));
        const failure = results.find(r => r.status === 'rejected');
        if (failure) throw failure.reason;
        outputs = results.map(r => r.value);
      }
      if (canDelegate) {
        let parsed;
        try { parsed = JSON.parse(outputs[0].text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* ordinary answer */ }
        if (parsed?.subtasks?.length) { this.addChildren(run, task, parsed.subtasks); return; }
      }
      task.result = outputs.map(o => `[${o.agentId}]\n${o.text}`).join('\n\n');
    }
    if (task.reviewerId) {
      const reviewer = run.project.agents.find(a => a.id === task.reviewerId && a.enabled !== false);
      assert(reviewer, 'Reviewer unavailable');
      const review = await this.invoke(run, task, reviewer, `${prompt}\nReview the candidate result. Return ONLY JSON {"approved":true|false,"feedback":"..."}.\nCandidate:\n${task.result}`);
      const verdict = JSON.parse(review.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      task.review = verdict;
      assert(verdict.approved === true, `Review rejected: ${verdict.feedback ?? ''}`);
    }
    if (run.status !== 'cancelled') {
      task.status = 'completed'; this.event(run, 'task.completed', { taskId: task.id });
    }
  }
  pump(run) {
    if (run.status !== 'running') return;
    const control = this.controls.get(run.id);
    for (const task of run.tasks) {
      if (task.status === 'waiting_children') {
        const children = run.tasks.filter(t => t.parentId === task.id);
        if (children.some(t => ['failed', 'blocked', 'cancelled'].includes(t.status))) task.status = 'blocked';
        else if (children.every(t => t.status === 'completed')) task.status = 'pending';
      }
      if (task.status !== 'pending' || control.active.has(task.id)) continue;
      const dependencies = task.dependsOn.map(key => run.tasks.find(t => t.id === key));
      if (dependencies.some(t => ['failed', 'blocked', 'cancelled'].includes(t.status))) { task.status = 'blocked'; continue; }
      if (!dependencies.every(t => t.status === 'completed')) continue;
      if (task.requiresApproval && !task.approved) {
        task.status = 'awaiting_approval'; this.event(run, 'task.awaiting_approval', { taskId: task.id }); continue;
      }
      task.status = 'running'; this.event(run, 'task.started', { taskId: task.id });
      control.taskControllers.set(task.id, new AbortController());
      const work = this.work(run, task).catch(error => {
        if (run.status === 'cancelled' || task.status === 'cancelled') return;
        task.error = error.message;
        task.status = task.attempts <= task.retries ? 'pending' : 'failed';
        this.event(run, task.status === 'pending' ? 'task.retrying' : 'task.failed', { taskId: task.id, message: error.message });
      }).finally(() => { control.active.delete(task.id); control.taskControllers.delete(task.id); this.pump(run); });
      control.active.set(task.id, work);
    }
    // Propagate blocked dependencies regardless of ordering in the input list.
    let changed;
    do {
      changed = false;
      for (const t of run.tasks) if (t.status === 'pending' && t.dependsOn.some(key => ['failed', 'blocked', 'cancelled'].includes(run.tasks.find(d => d.id === key)?.status))) {
        t.status = 'blocked'; changed = true;
      }
    } while (changed);
    if (!control.active.size && run.tasks.every(t => terminal.has(t.status))) {
      run.status = run.tasks.every(t => t.status === 'completed') ? 'completed' : 'failed';
      run.finishedAt = new Date().toISOString(); this.event(run, `run.${run.status}`);
    }
    this.store.save();
  }
}
