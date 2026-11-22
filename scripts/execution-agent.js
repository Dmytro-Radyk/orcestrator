import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function executionAgent(route,{access='workspace-write',role,skills=[],config={},id,name,reasoningEffort}={}) {
  if(!['codex','opencode','antigravity'].includes(route.backend))throw Error('Виконавець цього маршруту не підтримується');
  if(access==='workspace-write'&&route.capabilities?.workspaceWrite!==true)throw Error('Маршрут не підтримує потрібний запис файлів');
  if(reasoningEffort!==undefined&&(route.backend!=='codex'||!route.reasoningEfforts?.includes(reasoningEffort)))throw Error('Обраний рівень роздумів недоступний для моделі');
  const configuredEffort=config.reasoningEffort&&config.reasoningEffort!=='auto'&&route.backend==='codex'&&route.reasoningEfforts?.includes(config.reasoningEffort)?config.reasoningEffort:undefined;
  const defaultEffort=configuredEffort??['medium','low','high'].find(effort=>route.reasoningEfforts?.includes(effort));
  return {id:id??`route-${createHash('sha256').update(`${route.id}#${access==='workspace-write'?'write':'read'}`).digest('hex').slice(0,16)}`,
    name:name??route.model,role,skills,provider:route.backend,model:route.model,
    ...(route.backend==='codex'&&config.command?{command:config.command}:{}),
    access,billing:route.billing,billingBoundary:route.billingBoundary,
    ...(route.backend==='codex'&&(reasoningEffort??defaultEffort)?{reasoningEffort:reasoningEffort??defaultEffort}:{}),
    ephemeral:true,executionReport:true,ignoreUserConfig:true,
    ...(['opencode','antigravity'].includes(route.backend)?{fileWorker:true}:{}),...(process.platform==='win32'?{windowsSandbox:'elevated'}:{}),
    outputSchema:fileURLToPath(new URL('./schemas/execution.json',import.meta.url)),
    instructions:'Працюй лише над задачею в поточній worktree. Git та інтеграцією керує оркестратор. Не змінюй зовнішні проєкти, не публікуй нічого й не читай секрети. Створюй цілісний, візуально охайний, функціонально повний продукт, яким приємно користуватися: без сірих заглушок, без однакових прямокутників замість зображень товарів і без тривожних технічних банерів поверх вітрини. Не зупиняй задачу (status=blocked) через відсутність зовнішніх платіжних ключів, реального прайсу чи організаційних погоджень — використовуй багаті реалістичні стартові дані та локальну симуляцію сценарію. Виконай потрібні перевірки. Звіт має містити реальний результат. Завжди повертай subtasks: [] без делегування. Для дозволеного делегування поверни status=delegated, порожні files/checks та subtasks з title,prompt,skills,agentIds (порожній список agentIds означає успадкування виконавця); не поєднуй делегування зі змінами файлів.'};
}
