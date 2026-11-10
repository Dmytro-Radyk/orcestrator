import { validateTasks } from './state.js';

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value, label) => requireValue(typeof value === 'string' && value.trim() && value.length <= 12000, `Некоректне поле: ${label}`);
const texts = (value, label) => { requireValue(Array.isArray(value) && value.length <= 30, `Некоректний список: ${label}`); value.forEach(v => text(v, label)); };
export function validateIdea(idea) {
  text(idea.summary, 'концепція'); texts(idea.features, 'функції'); texts(idea.questions, 'уточнення'); texts(idea.risks, 'ризики'); return idea;
}
export function validatePlan(plan) {
  text(plan.summary, 'підсумок'); texts(plan.risks, 'ризики'); texts(plan.assumptions, 'припущення');
  requireValue(Array.isArray(plan.tasks) && plan.tasks.length > 0 && plan.tasks.length <= 30, 'План повинен містити від 1 до 30 задач');
  for (const t of plan.tasks) {
    text(t.id, 'ID'); text(t.title, 'назва задачі'); text(t.prompt, 'інструкція'); texts(t.skills, 'навички');
    texts(t.acceptanceCriteria, 'критерії готовності'); requireValue(t.acceptanceCriteria.length > 0, 'Додайте критерії готовності');
    texts(t.dependsOn, 'залежності');
  }
  validateTasks(plan.tasks); return plan;
}
export function validateAssignments(result, plan, agents) {
  requireValue(Array.isArray(result.assignments) && result.assignments.length === plan.tasks.length, 'Потрібне призначення для кожної задачі');
  const ids = new Set();
  for (const a of result.assignments) {
    requireValue(plan.tasks.some(t => t.id === a.taskId) && !ids.has(a.taskId), 'Невідома або повторна задача'); ids.add(a.taskId);
    texts(a.agentIds, 'агенти'); requireValue(a.agentIds.length > 0 && a.agentIds.length <= 6 && new Set(a.agentIds).size === a.agentIds.length, 'Некоректна команда задачі');
    requireValue(a.agentIds.every(id => agents.some(agent => agent.id === id)), 'AI запропонував агента поза каталогом');
    text(a.reason, 'пояснення призначення');
  }
  return result;
}
// Explicitly labelled deterministic examples; never reported as AI-generated.
export function demoIdea(brief) {
  return { summary: `Концепція «${brief.name}»: ${brief.description}`, features: ['Основний сценарій користувача та очікуваний результат', 'Перегляд стану роботи та збереження результатів'], questions: ['Хто основний користувач?', 'Який результат обов’язковий для першої версії?', 'Які є обмеження часу, бюджету та даних?'], risks: ['Поки не визначено межі першої версії та джерела даних.'] };
}
export function demoPlan(brief) {
  const task = (id, title, prompt, skills, dependsOn, criteria) => ({ id, title, prompt, skills, dependsOn, acceptanceCriteria: [criteria] });
  return { summary: `Навчальний приклад плану для «${brief.name}». Його потрібно адаптувати до реального проєкту.`, assumptions: ['Цей приклад описує програмний продукт; для іншого типу проєкту потрібен власний план.'], risks: ['Доступність моделей і вартість ще не перевірені.'], tasks: [
    task('requirements', 'Вимоги й архітектура', `Уточнити сценарії, дані та межі: ${brief.description}`, ['planning','architecture'], [], 'Узгоджено вимоги, контракти і критерії приймання.'),
    task('backend', 'Сервер і дані', 'Реалізувати серверну частину за прийнятою архітектурою.', ['backend','code'], ['requirements'], 'Основні операції даних проходять інтеграційні перевірки.'),
    task('frontend', 'Інтерфейс користувача', 'Реалізувати основні екрани та взаємодію.', ['frontend','code'], ['requirements'], 'Головний сценарій працює на desktop і мобільному екрані.'),
    task('integrate', 'Інтеграція', 'Поєднати інтерфейс і сервер, перевірити спільний результат.', ['backend','frontend'], ['backend','frontend'], 'Наскрізний сценарій завершується без втрати даних.'),
    task('review', 'Незалежна перевірка', 'Перевірити результати за критеріями, ризиками та тестами.', ['review','testing'], ['integrate'], 'Зафіксовано звіт перевірки та усунено критичні зауваження.')
  ] };
}
export function demoAssignments(plan, agents) {
  return { assignments: plan.tasks.map(t => {
    const ranked = agents.map(a => ({ agent: a, matches: t.skills.filter(s => a.skills.includes(s)) })).sort((a,b) => b.matches.length - a.matches.length);
    requireValue(ranked.length, 'Додайте профіль агента');
    const chosen = [ranked[0]];
    if (t.skills.includes('backend') && t.skills.includes('frontend')) {
      const second = ranked.find(a => a.agent.id !== chosen[0].agent.id && a.matches.includes('frontend')); if (second) chosen.push(second);
    }
    return { taskId: t.id, agentIds: chosen.map(c => c.agent.id), reason: `Демо-правило: ${chosen.map(c => `${c.agent.name} — ${c.matches.join(', ') || 'резервний профіль'}`).join('; ')}. Це збіг навичок, не оцінка якості моделей.` };
  }) };
}
