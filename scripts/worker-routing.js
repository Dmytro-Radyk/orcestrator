const isCodex=route=>route.backend==='codex';
export const isGeminiWorker=route=>route.backend==='antigravity'&&/^gemini-/i.test(route.model);
const quotaUse=route=>Math.max(0,...[route.quota?.primary,route.quota?.secondary,...(route.quota?.extra??[])]
  .map(window=>window?.usedPercent).filter(Number.isFinite));
const specialty=task=>[task.title,...(task.skills??[])].join(' ').toLowerCase();
const needsNativeTools=task=>/\b(?:backend|devops|ci\/cd|database|security|playwright|migration|browser|deploy|seo|analytics)\b|автентиф|транзакц|баз[иа] даних|безпек|інтеграц|тестуван|резервн|розгортан|реліз|платіж|браузер|аналітик/.test(specialty(task));

export function suitsManagedWorker(task,need={}) {
  if(need.tools)return false;
  if(need.workspaceWrite===false)return true;
  return !needsNativeTools(task)&&/\b(?:docs?|documentation|content|planning|research|copywriting|markdown|frontend|ux)\b|документ|плануван|контент|аналіз вимог|інструкц|текстов|специфікац|валідація форм/.test(specialty(task));
}

export function balanceWorkerCandidates(tasks,candidates,requirements,{priority,maxAgentsPerTask}){
  if(priority==='quality'||maxAgentsPerTask!==1)return candidates;
  const choices=new Map(candidates);
  if(priority==='economy'){
    for(const [id,routes] of choices){
      const free=routes.filter(route=>route.billing==='free_tier');
      if(free.length)choices.set(id,free);
    }
  }
  if(tasks.length<2)return choices;
  const ordered=[...tasks].sort((a,b)=>a.dependsOn.length-b.dependsOn.length);
  const load={codex:0,gemini:0};
  for(const task of ordered){
    const routes=choices.get(task.id),codex=routes.filter(isCodex),gemini=routes.filter(isGeminiWorker);
    if(!codex.length||!gemini.length)continue;
    const need=requirements[task.id];
    if(need?.workspaceWrite!==false&&needsNativeTools(task)){
      const native=routes.filter(route=>route.capabilities?.tools===true);
      if(native.length)choices.set(task.id,native);
      continue;
    }
    if(!suitsManagedWorker(task,need))continue;
    const loadScore=(pool,options)=>(load[pool]+1)/Math.max(1,100-Math.min(...options.map(quotaUse)));
    const chosen=loadScore('gemini',gemini)<=loadScore('codex',codex)?'gemini':'codex';
    choices.set(task.id,chosen==='gemini'?gemini:codex);
    load[chosen]++;
  }
  return choices;
}

export function geminiByHeadroom(routes){
  return routes.filter(isGeminiWorker).sort((a,b)=>quotaUse(a)-quotaUse(b)||
    Number(b.isDefault===true)-Number(a.isDefault===true)||a.id.localeCompare(b.id));
}
