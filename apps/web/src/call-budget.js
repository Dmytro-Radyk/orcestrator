export const MAX_RUN_CALLS = 10000;

export function plannedCalls(tasks) {
  return tasks.reduce((sum, task) => sum + (task.agentIds?.length || task.teamSize || 1) + Number(Boolean(task.reviewerId)), 0);
}

export function recommendedCalls(tasks) {
  const base = plannedCalls(tasks);
  return Math.min(MAX_RUN_CALLS, base + Math.max(4, Math.ceil(base / 4)));
}
