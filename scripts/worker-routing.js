const isCodex=route=>route.backend==='codex';
export const isGeminiWorker=route=>route.backend==='antigravity'&&/^gemini-/i.test(route.model);
export const quotaUse=route=>Math.max(0,...[route.quota?.primary,route.quota?.secondary,...(route.quota?.extra??[])]
  .map(window=>window?.usedPercent).filter(Number.isFinite));
const specialty=task=>[task.title,...(task.skills??[])].join(' ').toLowerCase();
const needsNativeTools=task=>/\b(?:backend|devops|ci\/cd|database|security|playwright|migration|browser|deploy|seo|analytics)\b|автентиф|транзакц|баз[иа] даних|безпек|інтеграц|тестуван|резервн|розгортан|реліз|платіж|браузер|аналітик/.test(specialty(task));

export function suitsManagedWorker(task,need={}) {
  if(need.tools)return false;
  if(need.workspaceWrite===false)return true;
  return !needsNativeTools(task)&&/\b(?:docs?|documentation|content|planning|research|copywriting|markdown|frontend|ux)\b|документ|плануван|контент|аналіз вимог|інструкц|текстов|специфікац|валідація форм/.test(specialty(task));
}

export function balanceWorkerCandidates(tasks,candidates,requirements,{priority}){
  const choices=new Map(candidates);
  const load={codex:0,gemini:0};
  const flexible=[];
  for(const task of tasks){
    let routes=choices.get(task.id);
    const need=requirements[task.id];
    if(need?.workspaceWrite!==false&&needsNativeTools(task)&&routes.some(isCodex)&&routes.some(isGeminiWorker)){
      const native=routes.filter(route=>route.capabilities?.tools===true);
      if(native.length)routes=native;
    }
    if(priority==='economy'){
      const free=routes.filter(route=>route.billing==='free_tier');
      if(free.length)routes=free;
    }
    choices.set(task.id,routes);
    const codex=routes.filter(isCodex),gemini=routes.filter(isGeminiWorker);
    if(codex.length===routes.length)load.codex++;
    else if(gemini.length===routes.length)load.gemini++;
    else if(codex.length&&gemini.length&&suitsManagedWorker(task,need))flexible.push({task,codex,gemini});
  }
  for(const {task,codex,gemini} of flexible.sort((a,b)=>a.task.dependsOn.length-b.task.dependsOn.length)){
    const loadScore=(pool,options)=>(load[pool]+1)/Math.max(1,100-Math.min(...options.map(quotaUse)));
    const chosen=loadScore('gemini',gemini)<=loadScore('codex',codex)?'gemini':'codex';
    const workerPool=chosen==='gemini'?gemini:codex;
    choices.set(task.id,workerPool.sort((a,b)=>quotaUse(a)-quotaUse(b)));
    load[chosen]++;
  }
  return choices;
}

export function geminiByHeadroom(routes){
  return routes.filter(isGeminiWorker).sort((a,b)=>quotaUse(a)-quotaUse(b)||
    Number(b.isDefault===true)-Number(a.isDefault===true)||a.id.localeCompare(b.id));
}
