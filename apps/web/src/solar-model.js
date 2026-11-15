import { formatBillingBadge } from './routing-ui.js';

const PLANET_PALETTES = {
  orange: { core: '#ffb86c', mid: '#e07a3c', dark: '#5e2812', glow: 'rgba(255, 166, 84, 0.45)', ring: true },
  blue: { core: '#7ad7ff', mid: '#2f7ed8', dark: '#0e2d5c', glow: 'rgba(102, 204, 255, 0.45)', ring: false },
  purple: { core: '#d4b3ff', mid: '#7d56d9', dark: '#291859', glow: 'rgba(184, 151, 255, 0.45)', ring: false },
  green: { core: '#7ef0c8', mid: '#26997b', dark: '#0d3b32', glow: 'rgba(110, 232, 188, 0.45)', ring: false }
};

const PALETTE_LIST = [PLANET_PALETTES.orange, PLANET_PALETTES.blue, PLANET_PALETTES.purple, PLANET_PALETTES.green];
const CANCELLABLE_TASK_STATUSES = new Set(['pending', 'running', 'waiting_children', 'awaiting_approval']);

function resolveTasksStatus(tasks) {
  if (!tasks.length) return 'idle';
  if (tasks.some(t => t.status === 'running')) return 'running';
  if (tasks.some(t => t.status === 'failed')) return 'failed';
  if (tasks.some(t => t.status === 'awaiting_approval' || t.status === 'waiting_children')) return 'running';
  if (tasks.some(t => t.status === 'pending')) return 'pending';
  if (tasks.every(t => t.status === 'done' || t.status === 'completed')) return 'done';
  if (tasks.some(t => t.status === 'cancelled')) return 'cancelled';
  if (tasks.some(t => t.status === 'blocked')) return 'blocked';
  return 'idle';
}

function buildCurrentAction(modelName, groupAgents, tasks, moons, status, events) {
  const agentNames = groupAgents.map(a => a.name);
  const active = tasks.find(t => ['running', 'waiting_children', 'awaiting_approval'].includes(t.status));
  if (active) {
    const latestEvent = events.find(e => e.text?.includes(active.title) || agentNames.some(n => e.text?.includes(n)));
    const childCount = moons.filter(m => m.parentTaskId === active.id).length || (active.children?.length ?? 0);
    const childNote = childCount ? ` (супутників: ${childCount})` : '';
    return {
      headline: `Виконує задачу «${active.title}»${childNote}`,
      detail: active.prompt,
      eventNote: latestEvent?.text ?? null,
      beats: active.beats ?? null
    };
  }
  const failed = tasks.find(t => ['failed', 'blocked'].includes(t.status));
  if (failed) {
    return {
      headline: `${failed.status === 'blocked' ? 'Заблоковано задачу' : 'Помилка у задачі'} «${failed.title}»`,
      detail: failed.error ?? failed.prompt,
      eventNote: null,
      beats: null
    };
  }
  if (status === 'cancelled') {
    const cancelledTask = tasks.find(t => t.status === 'cancelled');
    return {
      headline: `Задачу «${cancelledTask?.title ?? modelName}» скасовано`,
      detail: cancelledTask?.result ?? 'Виконання зупинено користувачем.',
      eventNote: null,
      beats: null
    };
  }
  const queued = tasks.find(t => t.status === 'pending');
  if (status === 'pending' && queued) {
    return {
      headline: `Очікує черги: «${queued.title}»`,
      detail: queued.prompt,
      eventNote: null,
      beats: null
    };
  }
  if (status === 'done') {
    const lastDone = [...tasks].reverse().find(t => t.status === 'done' || t.status === 'completed');
    return {
      headline: `Завершено всі призначені задачі (${tasks.length})`,
      detail: lastDone?.result ?? lastDone?.title ?? modelName,
      eventNote: null,
      beats: null
    };
  }
  return {
    headline: 'Очікує запуску оркестратора',
    detail: groupAgents.map(a => a.role).filter(Boolean).join(' · ') || modelName,
    eventNote: null,
    beats: null
  };
}

function moonActionText(child, status, modelLabel, parentTitle) {
  if (status === 'running' || status === 'waiting_children') {
    return `Виконує підзадачу «${child.title}» на моделі ${modelLabel}.`;
  }
  if (status === 'done' || status === 'completed') {
    return child.result ?? `Підзадачу «${child.title}» успішно завершено.`;
  }
  if (status === 'failed' || status === 'blocked') {
    return child.error ?? `${status === 'blocked' ? 'Заблоковано підзадачу' : 'Помилка підзадачі'} «${child.title}».`;
  }
  if (status === 'cancelled') {
    return `Підзадачу «${child.title}» скасовано.`;
  }
  return `Очікує виконання в межах задачі «${parentTitle}».`;
}

function findRootAncestor(task, taskById) {
  let cursor = task;
  const seen = new Set();
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    seen.add(cursor.id);
    const parent = taskById.get(cursor.parentId);
    if (!parent) break;
    cursor = parent;
  }
  return cursor;
}

function taskAgentIds(task) {
  return task?.agentIds?.length ? task.agentIds : (task?.assignedAgentIds ?? []);
}

function collectMoonsForGroup(group, allTasks, taskById, agentById, execAgents, ownerPlanetByTaskId, labels) {
  const moons = [];
  const seen = new Set();

  // 1. Explicit nested `task.children` (demo scenarios) attached to root tasks in this planet's group.
  for (const task of allTasks) {
    if (task.parentId) continue;
    if (ownerPlanetByTaskId.get(task.id) !== group.modelName) continue;
    for (const child of task.children ?? []) {
      const moonKey = `${task.id}:${child.id}`;
      if (seen.has(moonKey)) continue;
      seen.add(moonKey);
      const childAgentId = child.agentIds?.[0] ?? child.agentId;
      const childExec = childAgentId ? (execAgents.get(childAgentId) ?? agentById.get(childAgentId)) : null;
      const modelLabel = childExec?.model ?? group.modelName;
      const status = child.status ?? 'pending';
      const billingInfo = formatBillingBadge(childExec?.billing ?? group.billing, childExec?.billingBoundary ?? group.billingBoundary);
      moons.push({
        id: child.id,
        key: moonKey,
        kind: 'moon',
        parentPlanetId: group.modelName,
        parentTaskId: task.id,
        parentTaskTitle: task.title,
        name: child.title,
        prompt: child.prompt ?? `Дочірня задача у межах «${task.title}».`,
        model: modelLabel,
        provider: childExec ? `${childExec.provider ?? 'CLI'}${childExec.access ? ' · ' + childExec.access : ''}` : group.provider,
        billing: childExec?.billing ?? group.billing ?? null,
        billingBoundary: childExec?.billingBoundary ?? group.billingBoundary ?? null,
        billingLabel: billingInfo.label,
        billingTone: billingInfo.tone,
        role: childExec?.name ? `${childExec.name} · ${modelLabel}` : `Субагент · ${modelLabel}`,
        status,
        statusLabel: labels[status] ?? status,
        result: child.result ?? null,
        error: child.error ?? null,
        cancellable: CANCELLABLE_TASK_STATUSES.has(status),
        description: `Дочірня задача, делегована в межах «${task.title}».`,
        currentAction: moonActionText(child, status, modelLabel, task.title)
      });
    }
  }

  // 2. Real engine delegated child tasks (`parentId != null`, any nesting depth).
  // Every delegated subtask orbits its root task's primary planet while retaining its own executing model & billing metadata.
  for (const child of allTasks) {
    if (!child.parentId) continue;
    const childIds = taskAgentIds(child);
    const directOwnerId = childIds[0];
    const rootAncestor = findRootAncestor(child, taskById);
    const parentTask = taskById.get(child.parentId) ?? rootAncestor;
    const targetPlanet = ownerPlanetByTaskId.get(rootAncestor?.id)
      ?? (directOwnerId && group.agentIds.has(directOwnerId) ? group.modelName : null);
    if (targetPlanet !== group.modelName) continue;

    const moonKey = `${child.parentId}:${child.id}`;
    if (seen.has(moonKey)) continue;
    seen.add(moonKey);

    const childExec = directOwnerId ? (execAgents.get(directOwnerId) ?? agentById.get(directOwnerId)) : null;
    const modelLabel = childExec?.model ?? group.modelName;
    const status = child.status ?? 'pending';
    const billing = childExec?.billing ?? group.billing ?? null;
    const billingBoundary = childExec?.billingBoundary ?? group.billingBoundary ?? null;
    const billingInfo = formatBillingBadge(billing, billingBoundary);
    moons.push({
      id: child.id,
      key: moonKey,
      kind: 'moon',
      parentPlanetId: group.modelName,
      parentTaskId: parentTask?.id ?? child.parentId,
      parentTaskTitle: parentTask?.title ?? 'Батьківська задача',
      name: child.title,
      prompt: child.prompt ?? `Делегована підзадача для «${parentTask?.title ?? child.parentId}».`,
      model: modelLabel,
      provider: childExec ? `${childExec.provider ?? 'codex'}${childExec.access ? ' · ' + childExec.access : ''}` : group.provider,
      billing,
      billingBoundary,
      billingLabel: billingInfo.label,
      billingTone: billingInfo.tone,
      role: childExec?.name ? `${childExec.name} · ${modelLabel}` : `Модель ${modelLabel}`,
      status,
      statusLabel: labels[status] ?? status,
      result: child.result ?? null,
      error: child.error ?? null,
      cancellable: CANCELLABLE_TASK_STATUSES.has(status),
      description: child.prompt ?? `Дочірня задача у межах «${parentTask?.title ?? child.parentId}».`,
      currentAction: moonActionText(child, status, modelLabel, parentTask?.title ?? '')
    });
  }

  return moons;
}

/**
 * Maps an orchestrator project into a Solar System view model:
 * - Sun = orchestrator/project
 * - Planets = distinct models actually used in tasks / execution
 * - Moons = delegated child subtasks orbiting the executing model planet
 */
export function buildSolarSystemModel(project, agents = [], labels = {}, routingEntry = null) {
  if (!project) return null;
  const agentById = new Map(agents.map(a => [a.id, a]));
  const isReal = project.execution?.mode === 'real';
  const allTasks = isReal && project.execution.tasks ? project.execution.tasks : project.tasks ?? [];
  const taskById = new Map(allTasks.map(t => [t.id, t]));
  const rootTasks = allTasks.filter(t => !t.parentId);
  const events = project.events ?? [];
  const execAgents = new Map((isReal ? (project.execution?.agents ?? []) : []).map(a => [a.id, a]));

  const proposal = routingEntry?.proposal ?? null;
  const routingStale = Boolean(
    routingEntry?.stale || (proposal && Number(proposal.revision) !== Number(project.revision))
  );
  const proposalRouteMap = new Map((proposal?.routes ?? []).map(r => [r.id, r]));
  const routedModelByTask = new Map();
  if (proposal?.assignments) {
    for (const a of proposal.assignments) {
      const firstRouteId = a.routeIds?.[0];
      const route = firstRouteId ? proposalRouteMap.get(firstRouteId) : null;
      if (route) routedModelByTask.set(a.taskId, { route, reason: a.reason, allRouteIds: a.routeIds });
    }
  }

  const doneCount = rootTasks.filter(t => t.status === 'done' || t.status === 'completed').length;
  const runningTasks = rootTasks.filter(t => ['running', 'waiting_children'].includes(t.status));
  const failedTasks = allTasks.filter(t => ['failed', 'blocked'].includes(t.status));
  const progress = Math.round((doneCount / Math.max(1, rootTasks.length)) * 100);

  // Collect agents actually assigned to root tasks (or all tasks if no root assignments exist).
  const usedAgentIds = [];
  const usedSet = new Set();
  for (const t of rootTasks.length ? rootTasks : allTasks) {
    for (const id of taskAgentIds(t)) {
      if (!usedSet.has(id) && (agentById.has(id) || execAgents.has(id))) {
        usedSet.add(id);
        usedAgentIds.push(id);
      }
    }
  }

  // Group used agents by their effective model name so planet count equals distinct models used.
  const modelGroups = new Map();
  const agentToModel = new Map();
  for (const agentId of usedAgentIds) {
    const profile = agentById.get(agentId) ?? execAgents.get(agentId);
    const execAgent = execAgents.get(agentId);
    const agentTasks = rootTasks.filter(t => taskAgentIds(t).includes(agentId));
    const routedEntry = agentTasks.map(t => routedModelByTask.get(t.id)).find(Boolean) ?? null;

    let modelName = profile?.model ?? agentId;
    let provider = profile?.provider ?? 'API';
    let modelSource = 'profile';
    let sourceLabel = 'Рекомендований профіль ролі';
    let billing = null;
    let billingBoundary = null;

    if (isReal && execAgent) {
      modelName = execAgent.model;
      provider = `${execAgent.provider ?? 'codex'} · ${execAgent.access}`;
      modelSource = 'execution';
      sourceLabel = 'Фактичний виконавець запуску';
      billing = execAgent.billing ?? null;
      billingBoundary = execAgent.billingBoundary ?? null;
    } else if (routedEntry?.route) {
      modelName = routedEntry.route.model;
      provider = `${routedEntry.route.backend} · маршрут`;
      modelSource = 'routing';
      sourceLabel = routingStale ? 'AI-пропозиція команди (застаріла)' : 'AI-пропозиція команди (/api/routing)';
      billing = routedEntry.route.billing ?? null;
      billingBoundary = routedEntry.route.billingBoundary ?? null;
    }

    agentToModel.set(agentId, modelName);

    if (!modelGroups.has(modelName)) {
      modelGroups.set(modelName, {
        modelName,
        provider,
        modelSource,
        sourceLabel,
        billing,
        billingBoundary,
        agentIds: new Set(),
        agents: [],
        recommendedModels: new Set(),
        routedModels: new Set(),
        actualModels: new Set(),
        firstColor: profile?.color
      });
    }
    const group = modelGroups.get(modelName);
    group.agentIds.add(agentId);
    if (profile) group.agents.push(profile);
    if (profile?.model && !execAgent) group.recommendedModels.add(profile.model);
    if (routedEntry?.route) group.routedModels.add(routedEntry.route.id ?? routedEntry.route.model);
    if (execAgent?.model) group.actualModels.add(execAgent.model);
    if (!group.billing && billing) {
      group.billing = billing;
      group.billingBoundary = billingBoundary;
    }
  }

  // Also backfill recommended profile models when real execution runs via hashed `route-...` IDs.
  if (isReal) {
    for (const templateTask of project.tasks ?? []) {
      if (templateTask.parentId) continue;
      const runTask = rootTasks.find(t => t.id === templateTask.id);
      if (!runTask) continue;
      for (const execId of taskAgentIds(runTask)) {
        const mName = agentToModel.get(execId);
        const group = mName ? modelGroups.get(mName) : null;
        if (!group) continue;
        for (const profId of taskAgentIds(templateTask)) {
          const prof = agentById.get(profId);
          if (prof?.model) group.recommendedModels.add(prof.model);
        }
      }
    }
  }

  // Map each task to a single primary owning planet so moons never duplicate across shared models.
  const ownerPlanetByTaskId = new Map();
  for (const t of allTasks) {
    const firstId = taskAgentIds(t)[0];
    if (firstId && agentToModel.has(firstId)) {
      ownerPlanetByTaskId.set(t.id, agentToModel.get(firstId));
    }
  }

  const planets = Array.from(modelGroups.values()).map((group, index) => {
    const assignedTasks = rootTasks.filter(t => taskAgentIds(t).some(id => group.agentIds.has(id)));
    const status = resolveTasksStatus(assignedTasks);
    const moons = collectMoonsForGroup(group, allTasks, taskById, agentById, execAgents, ownerPlanetByTaskId, labels);
    const action = buildCurrentAction(group.modelName, group.agents, assignedTasks, moons, status, events);
    const palette = PLANET_PALETTES[group.firstColor] ?? PALETTE_LIST[index % PALETTE_LIST.length];
    const roleSummary = group.agents.map(a => a.name).join(', ');
    const billingInfo = formatBillingBadge(group.billing, group.billingBoundary);

    return {
      id: group.modelName,
      kind: 'planet',
      orbitIndex: index,
      agentIds: [...group.agentIds],
      name: group.modelName,
      model: roleSummary || group.modelName,
      provider: group.provider,
      modelSource: group.modelSource,
      sourceLabel: group.sourceLabel,
      billing: group.billing,
      billingBoundary: group.billingBoundary,
      billingLabel: group.billing ? billingInfo.label : null,
      billingTone: billingInfo.tone,
      recommendedModels: [...group.recommendedModels],
      routedModels: [...group.routedModels],
      actualModels: [...group.actualModels],
      role: group.agents.map(a => `${a.name}: ${a.role}`).join(' · '),
      skills: [...new Set(group.agents.flatMap(a => a.skills ?? []))],
      palette,
      status,
      statusLabel: labels[status] ?? status,
      description: group.agents.map(a => a.role ? `${a.name} — ${a.role}` : a.name).join('\n'),
      currentAction: action.headline,
      currentDetail: action.detail,
      eventNote: action.eventNote,
      beats: action.beats,
      tasks: assignedTasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        statusLabel: labels[t.status] ?? t.status,
        prompt: t.prompt,
        result: t.result ?? null,
        error: t.error ?? null,
        cancellable: CANCELLABLE_TASK_STATUSES.has(t.status)
      })),
      moons
    };
  });

  const totalMoons = planets.reduce((sum, p) => sum + p.moons.length, 0);
  const activePlanets = planets.filter(p => p.status === 'running').length;

  let sunCurrentAction = `Проєкт готовий до запуску (${rootTasks.length} задач, моделей у роботі: ${planets.length}).`;
  if (project.execution?.draining) {
    sunCurrentAction = `Зупиняється… Завершуємо активні виклики (${doneCount}/${rootTasks.length} виконано).`;
  } else if (project.status === 'running' && project.execution?.recovery?.status === 'planning') {
    sunCurrentAction = `AI-керівник підбирає заміну виконавцям (${doneCount}/${rootTasks.length} результатів збережено).`;
  } else if (project.status === 'running') {
    const titles = runningTasks.map(t => `«${t.title}»`).join(', ');
    sunCurrentAction = runningTasks.length
      ? `Координує виконання: ${titles} (${doneCount}/${rootTasks.length} завершено).`
      : `Оновлює чергу задач (${doneCount}/${rootTasks.length} завершено).`;
  } else if (project.status === 'paused') {
    sunCurrentAction = `Оркестрацію призупинено. Завершено ${doneCount} з ${rootTasks.length} задач.`;
  } else if (project.status === 'completed') {
    sunCurrentAction = `Місію завершено: усі ${rootTasks.length} задач успішно виконано.`;
  } else if (project.status === 'failed') {
    sunCurrentAction = `Запуск зупинено з помилкою (${failedTasks.length} не виконано, ${doneCount}/${rootTasks.length} готово).`;
  } else if (project.status === 'interrupted') {
    sunCurrentAction = `Запуск перервано перезапуском сервера (${doneCount}/${rootTasks.length} виконано).`;
  } else if (project.status === 'cancelled') {
    sunCurrentAction = `Запуск скасовано. Завершено ${doneCount} з ${rootTasks.length} задач.`;
  }

  const latestResultTask = allTasks.slice().reverse().find(t => t.result);
  const sun = {
    id: 'sun',
    projectId: project.id,
    kind: 'sun',
    name: project.name,
    subtitle: 'ОРКЕСТРАТОР ПРОЄКТУ',
    modeLabel: isReal ? 'РЕАЛЬНИЙ ЗАПУСК · AI-КОМАНДА' : 'СИМУЛЯЦІЯ / ПЛАН',
    isReal,
    draining: Boolean(project.execution?.draining),
    status: project.status,
    statusLabel: project.execution?.draining ? 'Зупиняється…' : (labels[project.status] ?? project.status),
    description: project.description,
    currentAction: sunCurrentAction,
    progress,
    doneCount,
    totalTasks: rootTasks.length,
    runningTasks: runningTasks.map(t => ({ id: t.id, title: t.title })),
    failedTasks: failedTasks.map(t => ({ id: t.id, title: t.title, error: t.error ?? 'Помилка виконання' })),
    latestResult: latestResultTask ? { title: latestResultTask.title, text: latestResultTask.result } : null,
    concurrency: project.concurrency,
    calls: isReal ? project.execution.calls : null,
    usage: isReal ? project.execution.usage : null,
    recentEvents: events.slice(0, 4)
  };

  return { sun, planets, totalMoons, activePlanets };
}
