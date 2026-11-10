import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export function assert(value, message) {
  if (!value) throw new Error(message);
}
export function integer(value, min, max, label) {
  assert(Number.isInteger(value) && value >= min && value <= max, `${label}: expected integer ${min}..${max}`);
}
export function validateProject(project) {
  assert(typeof project.name === 'string' && project.name.trim(), 'Project name is required');
  assert(Array.isArray(project.agents) && project.agents.length, 'At least one agent is required');
  assert(Array.isArray(project.tasks) && project.tasks.length, 'At least one task is required');
  integer(project.limits.concurrency, 1, 32, 'concurrency');
  integer(project.limits.maxCalls, 1, 10000, 'maxCalls');
  integer(project.limits.maxDepth, 0, 8, 'maxDepth');
  integer(project.limits.maxTasks, 1, 1000, 'maxTasks');
  integer(project.limits.timeoutMs, 10, 3600000, 'timeoutMs');
  integer(project.limits.maxOutputTokens, 16, 100000, 'maxOutputTokens');
  assert(project.tasks.length <= project.limits.maxTasks, 'Task limit exceeded');
  const agents = new Set();
  for (const a of project.agents) {
    assert(typeof a.id === 'string' && a.id && !agents.has(a.id), 'Agent IDs must be unique');
    agents.add(a.id);
    assert(Array.isArray(a.skills) && a.skills.every(s => typeof s === 'string'), `Invalid skills: ${a.id}`);
    assert(['demo', 'responses', 'chat', 'codex', 'claude', 'cli'].includes(a.provider), `Unknown provider: ${a.provider}`);
    if (['responses', 'chat'].includes(a.provider)) {
      assert(typeof a.model === 'string' && a.model, `Model is required: ${a.id}`);
      const url = new URL(a.baseUrl);
      assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Invalid API URL');
    }
    if (a.provider === 'cli') {
      assert(typeof a.command === 'string' && a.command, 'CLI executable required');
      assert(Array.isArray(a.args) && a.args.every(s => typeof s === 'string'), 'CLI args must be a string array');
    }
    assert(!a.apiKey, 'Use apiKeyEnv instead of storing API keys');
    if (a.access) assert(['read-only', 'workspace-write'].includes(a.access), 'Invalid agent access');
  }
  const tasks = new Map();
  for (const t of project.tasks) {
    assert(typeof t.id === 'string' && t.id && !tasks.has(t.id), 'Task IDs must be unique');
    tasks.set(t.id, t);
    assert(typeof t.title === 'string' && t.title.trim(), 'Task title is required');
    assert(typeof t.prompt === 'string' && t.prompt.trim(), 'Task prompt is required');
    assert(Array.isArray(t.skills) && t.skills.every(s => typeof s === 'string'), 'Task skills must be strings');
    assert(Array.isArray(t.dependsOn) && Array.isArray(t.agentIds), 'Invalid task assignments');
    assert(['parallel', 'pipeline'].includes(t.mode), 'Invalid task mode');
    integer(t.teamSize, 1, 16, 'teamSize');
    integer(t.retries, 0, 5, 'retries');
    for (const a of [...t.agentIds, ...(t.reviewerId ? [t.reviewerId] : [])]) assert(agents.has(a), `Unknown agent: ${a}`);
    if (t.agentIds.length) assert(new Set(t.agentIds).size === t.agentIds.length, 'Duplicate agent assignment');
    else assert(project.agents.filter(a => a.enabled !== false && (!t.skills.length || t.skills.some(s => a.skills.includes(s)))).length >= t.teamSize, `Not enough matching agents: ${t.id}`);
  }
  const visited = new Set(), visiting = new Set();
  function visit(key) {
    assert(tasks.has(key), `Unknown task dependency: ${key}`);
    assert(!visiting.has(key), 'Task dependency cycle');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of tasks.get(key).dependsOn) visit(dep);
    visiting.delete(key); visited.add(key);
  }
  for (const key of tasks.keys()) visit(key);
  return project;
}
export function taskDefaults(task) {
  return { skills: [], dependsOn: [], agentIds: [], teamSize: 1, mode: 'parallel', retries: 0, ...task };
}
export function makeProject(input, previous) {
  const project = {
    ...input,
    id: previous?.id ?? id(), revision: (previous?.revision ?? 0) + 1,
    limits: { concurrency: 4, maxCalls: 50, maxDepth: 2, maxTasks: 100, timeoutMs: 120000, maxOutputTokens: 4096, ...input.limits },
    tasks: (input.tasks ?? []).map(taskDefaults),
    updatedAt: new Date().toISOString()
  };
  return validateProject(project);
}
export function selectAgents(project, task) {
  if (task.agentIds.length) return task.agentIds.map(key => {
    const agent = project.agents.find(a => a.id === key && a.enabled !== false);
    assert(agent, `Agent unavailable: ${key}`);
    return agent;
  });
  const ranked = project.agents.filter(a => a.enabled !== false).map(a => ({
    agent: a,
    score: task.skills.filter(s => a.skills.includes(s)).length
  })).filter(x => !task.skills.length || x.score > 0)
    .sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id));
  assert(ranked.length >= task.teamSize, `Not enough agents for ${task.id}`);
  return ranked.slice(0, task.teamSize).map(x => x.agent);
}
