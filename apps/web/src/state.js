export const uid = () => crypto.randomUUID();
export const labels = { pending: 'У черзі', running: 'Виконується', done: 'Завершено', cancelled: 'Скасовано', blocked: 'Заблоковано', idle: 'Готовий до запуску', paused: 'На паузі', completed: 'Завершено' };
export function initialTasks(goal, team, agents) {
  const candidates = agents.filter(a => team.includes(a.id));
  const pick = skills => candidates.find(a => a.skills.some(s => skills.includes(s)))?.id ?? team[0];
  const ids = [uid(), uid(), uid()];
  return [
    { title: 'Планування', agentIds: [pick(['planning', 'architecture'])] },
    { title: 'Виконання', agentIds: [pick(['code', 'backend', 'frontend'])] },
    { title: 'Перевірка', agentIds: [pick(['review', 'testing'])] }
  ].map((task, index) => ({ ...task, id: ids[index], prompt: `${task.title}: ${goal}`, dependsOn: index ? [ids[index - 1]] : [], status: 'pending' }));
}
export function seed() {
  const agents = [
    { id: 'architect', name: 'Архітектор', role: 'Планування та системний дизайн', model: 'GPT-6 Astra', provider: 'API', color: 'orange', initials: 'AR', skills: ['architecture', 'planning'] },
    { id: 'backend', name: 'Backend engineer', role: 'Сервер, API та модель даних', model: 'Codex CLI', provider: 'CLI', color: 'blue', initials: 'BE', skills: ['backend', 'code'] },
    { id: 'frontend', name: 'Frontend engineer', role: 'Інтерфейс та взаємодія', model: 'GPT-6.1 Sol', provider: 'API', color: 'purple', initials: 'FE', skills: ['frontend', 'code'] },
    { id: 'reviewer', name: 'Рецензент', role: 'Перевірка якості та тестів', model: 'Claude Code', provider: 'CLI', color: 'green', initials: 'QA', skills: ['review', 'testing'] }
  ];
  const tasks = [
    { id: 'design', title: 'Системна архітектура', prompt: 'Визначити межі модулів, контракти й критерії приймання.', agentIds: ['architect'], dependsOn: [], status: 'done' },
    { id: 'api', title: 'Сервер та API', prompt: 'Спроєктувати API проєктів, задач і команд агентів.', agentIds: ['backend'], dependsOn: ['design'], status: 'pending' },
    { id: 'ui', title: 'Панель керування', prompt: 'Побудувати інтерфейс команди та граф задач.', agentIds: ['frontend'], dependsOn: ['design'], status: 'pending' },
    { id: 'integration', title: 'Інтеграція модулів', prompt: 'Поєднати сервер і панель керування за погодженими контрактами.', agentIds: ['backend', 'frontend'], dependsOn: ['api', 'ui'], status: 'pending' },
    { id: 'review', title: 'Перевірка результату', prompt: 'Перевірити поведінку, доступність і критерії приймання.', agentIds: ['reviewer'], dependsOn: ['integration'], status: 'pending' }
  ];
  return { version: 1, agents, activeId: 'core', projects: [
    { id: 'core', name: 'Orcestrator Core', description: 'Робочий простір для команд AI-агентів. Від ідеї до перевіреного результату.', icon: 'layers', team: agents.map(a => a.id), tasks, concurrency: 3, maxCalls: 50, revision: 1, status: 'idle', events: [{ text: 'Підготовлено демонстраційний план і команду', at: new Date().toISOString() }], artifacts: [] },
    { id: 'knowledge', name: 'Knowledge Base', description: 'Дослідження, перевірка джерел і база знань проєкту.', icon: 'book', team: ['architect', 'reviewer'], tasks: [{ id: 'research', title: 'Зібрати матеріали', prompt: 'Підготувати структуру дослідження.', agentIds: ['architect'], dependsOn: [], status: 'pending' }], concurrency: 2, maxCalls: 20, revision: 1, status: 'idle', events: [], artifacts: [] }
  ] };
}
export function validateTasks(tasks) {
  const map = new Map(tasks.map(t => [t.id, t]));
  if (map.size !== tasks.length) throw new Error('Задачі повинні мати унікальні ID');
  const visiting = new Set(), seen = new Set();
  function visit(id) {
    if (!map.has(id)) throw new Error('Невідома залежність задачі');
    if (visiting.has(id)) throw new Error('Ця залежність створює цикл');
    if (seen.has(id)) return;
    visiting.add(id); map.get(id).dependsOn.forEach(visit); visiting.delete(id); seen.add(id);
  }
  tasks.forEach(t => visit(t.id));
}
export function log(project, text) { project.events.unshift({ text, at: new Date().toISOString() }); project.events = project.events.slice(0, 100); }
export function start(project) {
  if (!project.tasks.length) throw new Error('Спочатку додайте задачу');
  if (project.tasks.some(t => !t.agentIds.length || t.agentIds.some(id => !project.team.includes(id)))) throw new Error('Призначте агентів з команди на всі задачі');
  validateTasks(project.tasks);
  project.tasks.forEach(t => { t.status = 'pending'; delete t.beats; delete t.result; delete t.children; });
  project.artifacts = []; project.status = 'running'; log(project, 'Розпочато демонстраційний запуск');
}
export function tick(project) {
  if (project.status !== 'running') return false;
  project.tasks.filter(t => t.status === 'running').forEach(t => {
    t.beats = (t.beats ?? 0) + 1;
    if (t.children) t.children.forEach(c => { c.status = t.beats >= 3 ? 'done' : 'running'; });
    if (t.beats >= 4) {
      t.status = 'done'; t.result = `Демонстраційний результат: «${t.title}». Критерії сценарію виконано. Реальна модель не викликалась.`;
      project.artifacts.push({ id: uid(), taskId: t.id, name: `${t.title}.md`, text: `# ${t.title}\n\n${t.result}\n\nЗавдання: ${t.prompt}` });
      log(project, `Завершено: ${t.title}`);
    }
  });
  let slots = project.concurrency - project.tasks.filter(t => t.status === 'running').length;
  for (const t of project.tasks) {
    if (t.status !== 'pending') continue;
    if (t.dependsOn.some(id => ['cancelled', 'blocked'].includes(project.tasks.find(d => d.id === id)?.status))) { t.status = 'blocked'; continue; }
    if (slots > 0 && t.dependsOn.every(id => project.tasks.find(d => d.id === id)?.status === 'done')) {
      t.status = 'running'; t.beats = 0; slots--; log(project, `Агент почав: ${t.title}`);
      if (t.id === 'api') t.children = [{ id: 'contract', title: 'Перевірка контрактів', status: 'running', agentId: 'reviewer' }];
    }
  }
  if (project.tasks.every(t => ['done', 'cancelled', 'blocked'].includes(t.status))) {
    project.status = project.tasks.every(t => t.status === 'done') ? 'completed' : 'cancelled'; log(project, 'Демонстраційний запуск завершено');
  }
  return true;
}
export function cancelTask(project, id) {
  const task = project.tasks.find(t => t.id === id);
  if (!task || ['done', 'cancelled', 'blocked'].includes(task.status)) return;
  task.status = 'cancelled'; task.children?.forEach(c => c.status = 'cancelled');
  let changed;
  do {
    changed = false;
    for (const t of project.tasks) if (t.status === 'pending' && t.dependsOn.some(id => ['cancelled', 'blocked'].includes(project.tasks.find(d => d.id === id)?.status))) { t.status = 'blocked'; changed = true; }
  } while (changed);
  log(project, `Скасовано задачу: ${task.title}`);
}
