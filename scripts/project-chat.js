import { redactSecrets } from '../src/providers.js';

const messageId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createProjectChat({store, engine, launching, isBusy, launch}) {
  let closed = false;
  const threads = new Map(Object.entries(store.data.projectChats ?? {}));
  const runs = new Map();
  const rememberRun = run => {
    if (run.project.projectChatId) runs.set(run.project.projectChatId, run);
  };
  Object.values(store.data.runs).forEach(rememberRun);

  function history(projectId) {
    return (threads.get(projectId) ?? []).map(message => {
      const run = runs.get(message.id);
      const task = run?.tasks[0];
      const author = task?.outputs.at(-1)?.agentId;
      const prefix = `[${author}]\n`;
      const result = task?.result?.startsWith(prefix) ? task.result.slice(prefix.length) : task?.result;
      return {
        ...message, status: run?.status ?? (message.error ? 'start_failed' : 'queued'),
        runId: run?.id, finishedAt: run?.finishedAt,
        model: (run?.project.agents.find(agent => agent.id === author) ?? run?.project.agents[0])?.model,
        result: run?.status === 'completed' ? result : undefined,
        selfReview: task?.selfReviews?.at(-1),
        problem: ['failed', 'blocked'].includes(run?.status) ? task?.error ?? task?.blockedReport?.summary : undefined
      };
    });
  }

  async function processNext(projectId, messages) {
    if (closed || launching.has(projectId) || isBusy(projectId)) return;
    const message = messages.find(item => !item.error && !runs.has(item.id));
    if (!message) return;
    const earlier = messages.slice(0, messages.indexOf(message)).filter(item => runs.get(item.id)?.status === 'completed').slice(-2)
      .map(item => ({request: item.text.slice(0,1200), result: runs.get(item.id).tasks[0].result?.slice(0,1200)}));
    launching.add(projectId);
    try {
      await launch(projectId, message, earlier, () => closed || isBusy(projectId));
    } catch (error) {
      if (!closed && !runs.has(message.id)) {
        message.error = redactSecrets(error.message, 600);
        if (error.decisionCode) message.decisionCode = error.decisionCode;
        store.save();
      }
    } finally {
      launching.delete(projectId);
    }
  }

  function pump() {
    for (const [projectId, messages] of threads) {
      void processNext(projectId, messages).catch(error => console.error('Project chat queue:', error.message));
    }
  }
  const unsubscribe = engine.subscribe((run, event) => {
    if (event.type === 'run.started') rememberRun(run);
    if (['run.drained', 'task.host_verification_finished'].includes(event.type)) queueMicrotask(pump);
  });
  // Also pick up saved messages on startup and after other project operations release their lock.
  const timer = setInterval(pump, 2000);
  timer.unref?.();

  return {
    history,
    send(projectId, input) {
      const id = typeof input?.id === 'string' && input.id.toLowerCase();
      const current = threads.get(projectId) ?? [];
      if (!messageId.test(id || '')) throw Error('Некоректний ідентифікатор повідомлення');
      const existing = current.find(item => item.id === id);
      if (input.retry === true) {
        if (!existing?.error || runs.has(id)) throw Error('Цей запит уже взято в роботу або його немає в чаті');
        const previous = existing.error, prevDecision = existing.decisionCode, prevSub = existing.allowSubscription, prevRoute = existing.routeId;
        delete existing.error; delete existing.decisionCode;
        if (input.allowSubscription === true) existing.allowSubscription = true;
        if (typeof input.routeId === 'string' && input.routeId) existing.routeId = input.routeId;
        try { store.save(); } catch (error) { existing.error = previous; if (prevDecision) existing.decisionCode = prevDecision; if (prevSub === undefined) delete existing.allowSubscription; if (prevRoute === undefined) delete existing.routeId; throw error; }
      } else {
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (!text || text.length > 6000) throw Error('Напишіть запит довжиною до 6000 символів');
        if (existing?.text === text) return history(projectId);
        if (existing || [...threads.values()].some(items => items.some(item => item.id === id)))
          throw Error('Ідентифікатор повідомлення вже використано');
        const next = [...current, {id, text, createdAt: new Date().toISOString(),
          ...(input.allowSubscription === true ? {allowSubscription: true} : {}),
          ...(typeof input.routeId === 'string' && input.routeId ? {routeId: input.routeId} : {})}];
        const previous = store.data.projectChats;
        store.data.projectChats = {...previous, [projectId]: next};
        try { store.save(); } catch (error) { store.data.projectChats = previous; throw error; }
        threads.set(projectId, next);
      }
      queueMicrotask(pump);
      return history(projectId);
    },
    remove(projectId) { threads.delete(projectId); },
    close() { closed = true; clearInterval(timer); unsubscribe(); }
  };
}
