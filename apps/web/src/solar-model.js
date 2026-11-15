const PLANET_PALETTES = {
  orange: { core: '#ffb86c', mid: '#e07a3c', dark: '#5e2812', glow: 'rgba(255, 166, 84, 0.45)', ring: true },
  blue: { core: '#7ad7ff', mid: '#2f7ed8', dark: '#0e2d5c', glow: 'rgba(102, 204, 255, 0.45)', ring: false },
  purple: { core: '#d4b3ff', mid: '#7d56d9', dark: '#291859', glow: 'rgba(184, 151, 255, 0.45)', ring: false },
  green: { core: '#7ef0c8', mid: '#26997b', dark: '#0d3b32', glow: 'rgba(110, 232, 188, 0.45)', ring: false }
};

const PALETTE_LIST = [PLANET_PALETTES.orange, PLANET_PALETTES.blue, PLANET_PALETTES.purple, PLANET_PALETTES.green];

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

function buildCurrentAction(modelName, groupAgents, tasks, status, events) {
  const agentNames = groupAgents.map(a => a.name);
  const active = tasks.find(t => t.status === 'running');
  if (active) {
    const latestEvent = events.find(e => e.text?.includes(active.title) || agentNames.some(n => e.text?.includes(n)));
    const childCount = active.children?.length ?? 0;
    const childNote = childCount ? ` (субагентів: ${childCount})` : '';
    return {
      headline: `Виконує задачу «${active.title}»${childNote}`,
      detail: active.prompt,
      eventNote: latestEvent?.text ?? null,
      beats: active.beats ?? null
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
  const failed = tasks.find(t => t.status === 'failed');
  if (failed) {
    return {
      headline: `Помилка у задачі «${failed.title}»`,
      detail: failed.error ?? failed.prompt,
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
    detail: groupAgents.map(a => a.role).join(' · '),
    eventNote: null,
    beats: null
  };
}

function collectMoonsForModel(modelKey, primaryAgentIds, allTasks, agentById, labels) {
  const moons = [];
  const seen = new Set();

  for (const task of allTasks) {
    if (task.parentId) continue;
    const primaryOwner = task.agentIds?.[0];
    if (!primaryOwner || !primaryAgentIds.has(primaryOwner)) continue;

    // Combine explicit `task.children` (demo / UI tree) and child tasks referencing `parentId` (real engine runs).
    const delegated = [
      ...(task.children ?? []),
      ...allTasks.filter(st => st.parentId === task.id)
    ];

    for (const child of delegated) {
      const moonKey = `${task.id}:${child.id}`;
      if (seen.has(moonKey)) continue;
      seen.add(moonKey);
      const childAgent = child.agentId ? agentById.get(child.agentId) : null;
      const status = child.status ?? 'pending';
      const statusLabel = labels[status] ?? status;
      const parentAgent = agentById.get(primaryOwner);
      moons.push({
        id: child.id,
        key: moonKey,
        kind: 'moon',
        parentPlanetId: modelKey,
        parentTaskId: task.id,
        parentTaskTitle: task.title,
        name: child.title,
        role: childAgent ? `${childAgent.name} · ${childAgent.model}` : 'Керований субагент',
        status,
        statusLabel,
        description: `Субагент, делегований у межах задачі «${task.title}».`,
        currentAction: status === 'running'
          ? `Виконує підзадачу «${child.title}» для ${parentAgent?.model ?? modelKey}.`
          : status === 'done' || status === 'completed'
            ? `Підзадачу «${child.title}» успішно завершено.`
            : status === 'cancelled'
              ? `Підзадачу «${child.title}» скасовано.`
              : `Очікує виконання в межах задачі «${task.title}».`
      });
    }
  }
  return moons;
}

/**
 * Maps an orchestrator project into a Solar System view model:
 * - Sun = orchestrator/project
 * - Planets = distinct models actually used by tasks in the project
 * - Moons = delegated subagents actually active/present on those tasks
 */
export function buildSolarSystemModel(project, agents = [], labels = {}) {
  if (!project) return null;
  const agentById = new Map(agents.map(a => [a.id, a]));
  const allTasks = project.tasks ?? [];
  const rootTasks = allTasks.filter(t => !t.parentId);
  const events = project.events ?? [];
  const execAgents = new Map((project.execution?.agents ?? []).map(a => [a.id, a]));

  const doneCount = rootTasks.filter(t => t.status === 'done' || t.status === 'completed').length;
  const runningTasks = rootTasks.filter(t => t.status === 'running');
  const progress = Math.round((doneCount / Math.max(1, rootTasks.length)) * 100);

  // Collect only agents actually assigned to at least one task in the project.
  const usedAgentIds = [];
  const usedSet = new Set();
  for (const t of rootTasks) {
    for (const id of t.agentIds ?? []) {
      if (!usedSet.has(id) && (agentById.has(id) || execAgents.has(id))) {
        usedSet.add(id);
        usedAgentIds.push(id);
      }
    }
  }

  // Group used agents by their effective model name so planet count equals distinct models used.
  const modelGroups = new Map();
  for (const agentId of usedAgentIds) {
    const profile = agentById.get(agentId) ?? execAgents.get(agentId);
    const execAgent = execAgents.get(agentId);
    const modelName = execAgent?.model ?? profile?.model ?? agentId;
    const provider = execAgent ? `codex · ${execAgent.access}` : (profile?.provider ?? 'API');
    if (!modelGroups.has(modelName)) {
      modelGroups.set(modelName, {
        modelName,
        provider,
        agentIds: new Set(),
        agents: [],
        firstColor: profile?.color
      });
    }
    const group = modelGroups.get(modelName);
    group.agentIds.add(agentId);
    if (profile) group.agents.push(profile);
  }

  const planets = Array.from(modelGroups.values()).map((group, index) => {
    const assignedTasks = rootTasks.filter(t => t.agentIds?.some(id => group.agentIds.has(id)));
    const status = resolveTasksStatus(assignedTasks);
    const moons = collectMoonsForModel(group.modelName, group.agentIds, allTasks, agentById, labels);
    const action = buildCurrentAction(group.modelName, group.agents, assignedTasks, status, events);
    const palette = PLANET_PALETTES[group.firstColor] ?? PALETTE_LIST[index % PALETTE_LIST.length];
    const roleSummary = group.agents.map(a => a.name).join(', ');

    return {
      id: group.modelName,
      kind: 'planet',
      orbitIndex: index,
      name: group.modelName,
      model: roleSummary || group.modelName,
      provider: group.provider,
      role: group.agents.map(a => `${a.name}: ${a.role}`).join(' · '),
      skills: [...new Set(group.agents.flatMap(a => a.skills ?? []))],
      palette,
      status,
      statusLabel: labels[status] ?? status,
      description: group.agents.map(a => `${a.name} — ${a.role}`).join('\n'),
      currentAction: action.headline,
      currentDetail: action.detail,
      eventNote: action.eventNote,
      beats: action.beats,
      tasks: assignedTasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        statusLabel: labels[t.status] ?? t.status,
        prompt: t.prompt
      })),
      moons
    };
  });

  const totalMoons = planets.reduce((sum, p) => sum + p.moons.length, 0);
  const activePlanets = planets.filter(p => p.status === 'running').length;

  let sunCurrentAction = `Проєкт готовий до запуску (${rootTasks.length} задач, моделей у роботі: ${planets.length}).`;
  if (project.status === 'running') {
    const titles = runningTasks.map(t => `«${t.title}»`).join(', ');
    sunCurrentAction = runningTasks.length
      ? `Координує виконання: ${titles} (${doneCount}/${rootTasks.length} завершено).`
      : `Оновлює чергу задач (${doneCount}/${rootTasks.length} завершено).`;
  } else if (project.status === 'paused') {
    sunCurrentAction = `Оркестрацію призупинено. Завершено ${doneCount} з ${rootTasks.length} задач.`;
  } else if (project.status === 'completed') {
    sunCurrentAction = `Місію завершено: усі ${rootTasks.length} задач успішно виконано.`;
  } else if (project.status === 'cancelled') {
    sunCurrentAction = `Запуск зупинено. Завершено ${doneCount} з ${rootTasks.length} задач.`;
  }

  const sun = {
    id: 'sun',
    kind: 'sun',
    name: project.name,
    subtitle: 'ОРКЕСТРАТОР ПРОЄКТУ',
    modeLabel: project.execution?.mode === 'real' ? 'CODEX CLI · РЕАЛЬНИЙ ЗАПУСК' : 'СИМУЛЯЦІЯ / ПЛАН',
    status: project.status,
    statusLabel: labels[project.status] ?? project.status,
    description: project.description,
    currentAction: sunCurrentAction,
    progress,
    doneCount,
    totalTasks: rootTasks.length,
    runningTasks: runningTasks.map(t => ({ id: t.id, title: t.title })),
    concurrency: project.concurrency,
    calls: project.execution?.mode === 'real' ? project.execution.calls : null,
    recentEvents: events.slice(0, 4)
  };

  return { sun, planets, totalMoons, activePlanets };
}
