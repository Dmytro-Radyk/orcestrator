import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function executionAgent(route,{access='workspace-write',role,skills=[],config={},id,name}={}) {
  if(!['codex','opencode'].includes(route.backend))throw Error('Виконавець цього маршруту не підтримується');
  if(access==='workspace-write'&&route.capabilities?.workspaceWrite!==true)throw Error('Маршрут не підтримує потрібний запис файлів');
  return {id:id??`route-${createHash('sha256').update(`${route.id}#${access==='workspace-write'?'write':'read'}`).digest('hex').slice(0,16)}`,
    name:name??route.model,role,skills,provider:route.backend,model:route.model,command:config.command,
    access,billing:route.billing,billingBoundary:route.billingBoundary,reasoningEffort:config.reasoningEffort??'high',ephemeral:true,executionReport:true,ignoreUserConfig:true,
    ...(route.backend==='opencode'?{fileWorker:true}:{}),...(process.platform==='win32'?{windowsSandbox:'elevated'}:{}),
    outputSchema:fileURLToPath(new URL('./schemas/execution.json',import.meta.url)),
    instructions:'Працюй лише над задачею в поточній worktree. Git та інтеграцією керує оркестратор. Не змінюй зовнішні проєкти, не публікуй нічого й не читай секрети. Виконай потрібні перевірки. Звіт має містити реальний результат. Для дозволеного делегування поверни status=delegated, порожні files/checks та subtasks з title,prompt,skills і необовʼязковими agentIds; не поєднуй делегування зі змінами файлів.'};
}
