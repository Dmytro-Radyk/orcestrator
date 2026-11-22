import { preferredAgentRuntime } from './agent-library.js';
import { buildRoutingPayload, formatBillingBadge } from './routing-ui.js';
import { readEventStream,applyRunFrame } from './event-stream.js';
import { MAX_RUN_CALLS,plannedCalls,recommendedCalls } from './call-budget.js';
import { hasVerificationChecks } from './execution-ui.js';

const terminal = status => !['running','paused'].includes(status);
const statusLabels={ 'run.started':'Запуск розпочато','run.paused':'Чергу поставлено на паузу','run.resumed':'Чергу продовжено',
  'run.blocked':'Очікуємо уточнення вимог','run.clarified':'Уточнення збережено — роботу продовжено','task.blocked':'Задача очікує уточнення','agent.blocked':'Агент підготував матеріали й очікує уточнення',
  'run.access_retried':'Продовжено після відновлення доступу',
  'run.cancelled_resumed':'Скасований запуск продовжено',
  'run.budget_increased':'Бюджет запуску змінено',
  'run.budget_retried':'Роботу продовжено зі збільшеним бюджетом',
  'run.gemini_balanced':'Розподіл виконавців оновлено',
  'task.host_verification_started':'Локальні перевірки розпочато',
  'task.host_verified':'Результат прийнято після локальних перевірок',
  'task.host_verification_partial':'Збережено результати локальних перевірок',
  'task.storefront_evidence_retry':'Повторно перевіряємо докази вітрини',
  'task.host_verification_failed':'Локальна перевірка не пройшла',
  'task.host_verification_finished':'Локальна перевірка завершена',
  'workspace.resolving':'Узгодження змін файлів',
  'run.cancelled':'Запуск скасовано','run.completed':'Запуск завершено','run.failed':'Запуск завершився помилкою',
  'run.interrupted':'Запуск перервано перезапуском сервера','run.continued':'Запуск продовжено після таймауту','task.started':'Почато задачу','task.completed':'Завершено задачу',
  'task.failed':'Помилка задачі','task.cancelled':'Скасовано задачу','agent.started':'Агент почав роботу','agent.completed':'Агент завершив роботу','agent.failed':'Помилка агента'};

export function serializeWorkspaceState(state) {
  const copy = structuredClone(state);
  if (Array.isArray(copy?.projects)) {
    for (const p of copy.projects) {
      if (p.execution?.mode === 'real') {
        p.execution = { mode: 'real', id: p.execution.id, status: p.execution.status, uiRevision: p.execution.uiRevision };
        p.events = [];
        p.artifacts = [];
        if (Array.isArray(p.tasks)) {
          p.tasks = p.tasks.filter(t => !t.parentId).map(t => {
            const { children, result, error, failure, blockedReason, blockedRouteId, outputs, workspace, review, assignedAgentIds, attempts, recoveryAttempts, ...clean } = t;
            return clean;
          });
        }
      }
    }
  }
  return copy;
}

export function applyExecutionRun(project,run) {
  const mapped=run.tasks.map(t=>({...t,status:t.status==='completed'?'done':t.status}));
  const children=id=>mapped.filter(t=>t.parentId===id).map(t=>({...t,children:children(t.id)}));
  project.tasks=project.tasks.filter(t=>!t.parentId).map(t=>{
    const {beats,children:oldChildren,result,error,...base}=t,runtime=mapped.find(item=>item.id===t.id);
    // Live execution is a projection of the frozen run, not an edit of the plan.
    // Keep plan fields intact even while viewing a different or recovered run.
    const view={...base,children:children(t.id)};
    for(const key of ['status','result','error','failure','blockedReason','blockedRouteId','attempts','recoveryAttempts','assignedAgentIds','workspace','review']) {
      if(runtime&&Object.hasOwn(runtime,key))view[key]=runtime[key];else delete view[key];
    }
    return view;
  });
  project.status=run.status;
  project.execution={mode:'real',id:run.id,status:run.status,draining:run.draining,canContinue:run.canContinue===true,canRetryAccess:run.canRetryAccess===true,canClarify:run.canClarify===true,brief:run.project.executionBrief??'',recovery:run.recovery,uiRevision:run.project.uiRevision,workspace:run.project.workspace,calls:run.calls,
    canResumeCancelled:run.canResumeCancelled===true,canIncreaseBudget:run.canIncreaseBudget===true,
    canRetryBudget:run.canRetryBudget===true,canBalanceGemini:run.canBalanceGemini===true,hostChecking:run.hostChecking===true,maxCalls:run.project.limits?.maxCalls,testCompletion:run.testCompletion,
    agents:run.project.agents.map(({id,name,model,provider,access,role,skills,billing,billingBoundary})=>({id,name,model,provider,access,role,skills,billing,billingBoundary})),tasks:mapped,files:run.files??[],createdAt:run.createdAt,
    usage:run.events.filter(e=>['agent.completed','agent.failed','agent.blocked','recovery.manager_completed'].includes(e.type)).reduce((sum,o)=>({input:sum.input+(Number(o.usage?.input_tokens??o.usage?.prompt_tokens)||0),output:sum.output+(Number(o.usage?.output_tokens??o.usage?.completion_tokens)||0)}),{input:0,output:0})};
  project.events=run.events.slice(-300).reverse().map(e=>({at:e.at,real:true,text:
    `${statusLabels[e.type]??(e.type==='agent.progress'?'':'Подія '+e.type)}${e.taskId?' · '+(run.tasks.find(t=>t.id===e.taskId)?.title??e.taskId):''}${e.agentId?' · '+(run.project.agents.find(a=>a.id===e.agentId)?.name??e.agentId):''}${e.message?'\n'+e.message:''}`}));
  project.artifacts=run.tasks.filter(t=>t.result).map(t=>({id:t.id,taskId:t.id,name:`${t.title}.md`,text:t.result,real:true}));
}

export function createExecutionClient({getState,setState,render,saveLocal,notify,modal,h,button,download}) {
  let token,revision=0,ready=false,timer,queue=Promise.resolve(),conflict=false,savingCount=0;
  const streams=new Map();
  const routingStates=new Map();
  const resultRuns=new Map();
  const client={ready:false,history:[],runtimes:[],saving:false,catalog:null,loadingCatalog:false,scanning:false,catalogError:null};
  function ensureRouting(projectId) {
    if(!routingStates.has(projectId))routingStates.set(projectId,{loading:false,proposing:false,error:null,proposal:null,stale:false,draftConfig:null,loadSeq:0,proposeSeq:0});
    return routingStates.get(projectId);
  }
  function stopStream(runId) {
    const entry=streams.get(runId);
    if(entry){entry.controller.abort();streams.delete(runId);}
  }
  client.stopAllStreams=()=>{for(const entry of streams.values())entry.controller.abort();streams.clear();};
  client.clearRoutingStates=()=>{routingStates.clear();};
  async function call(path,method='GET',body,{signal}={}) {
    const response=await fetch(path,{method,signal,headers:{'X-Execution-Token':token??'',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error??'Помилка сервера');return data;
  }
  function persist() {
    clearTimeout(timer);
    if(!ready || conflict)return queue;
    const workspace=serializeWorkspaceState(getState());
    savingCount++;client.saving=true;
    const request=queue.then(async()=>{
      if(conflict)return;
      const stored=await call('/api/workspace','PUT',{revision,workspace});revision=stored.revision;
    });
    queue=request.catch(error=>{if(error.message.includes('Конфлікт'))conflict=true;notify('Не вдалося зберегти на сервері: '+error.message);}).finally(()=>{if(--savingCount<=0){savingCount=0;client.saving=false;}});
    return request;
  }
  client.scheduleSave=()=>{if(ready&&!conflict){clearTimeout(timer);timer=setTimeout(()=>persist().catch(()=>{}),300);}};
  client.flush=()=>persist();
  client.proposeDraft=(input,signal)=>{
    if(!ready)throw Error('Дочекайтеся підключення до локального сервера');
    return call('/api/routing/draft','POST',input,{signal});
  };
  client.listFolders=path=>call('/api/project-folders'+(path?`?path=${encodeURIComponent(path)}`:''));
  client.projectPreview=(projectId,url)=>call('/api/project-preview','POST',{projectId,...(url?{url}:{})});
  client.createPlannedProject=({project,profiles,routingDraftId,projectParent})=>{
    if(!ready||conflict)throw Error('Оновіть сторінку для збереження проєкту на сервері');
    clearTimeout(timer);savingCount++;client.saving=true;
    const request=queue.then(async()=>{
      if(conflict)throw Error('Конфлікт збереження: оновіть сторінку перед створенням проєкту');
      const workspace=serializeWorkspaceState(getState());
      if(workspace.projects.some(p=>p.id===project.id))throw Error('Проєкт уже створено');
      for(const profile of profiles)if(!workspace.agents.some(a=>a.id===profile.id))workspace.agents.push(profile);
      workspace.projects.push(project);workspace.activeId=project.id;
      const stored=await call('/api/workspace','PUT',{revision,workspace,...(routingDraftId?{routingDraftId,routingProjectId:project.id}:{}),
        ...(projectParent?{projectLocation:{projectId:project.id,parent:projectParent}}:{})});
      revision=stored.revision;
      const live=getState();
      for(const profile of profiles)if(!live.agents.some(a=>a.id===profile.id))live.agents.push(profile);
      live.projects.push(project);live.activeId=project.id;
      saveLocal();
      if(routingDraftId){const entry=ensureRouting(project.id);const data=await call(`/api/routing?projectId=${encodeURIComponent(project.id)}`).catch(()=>null);if(data){entry.proposal=data.proposal;entry.stale=data.stale;}}
      return project;
    });
    queue=request.catch(error=>{if(error.message.includes('Конфлікт'))conflict=true;}).finally(()=>{if(--savingCount<=0){savingCount=0;client.saving=false;}});
    return request;
  };
  client.launchProposal=async(p,proposal)=>{
    if(!ready)throw new Error('Дочекайтеся підключення до локального сервера');
    const planned=p.tasks.filter(task=>!task.parentId).map(task=>{
      const assignment=proposal?.assignments?.find(item=>item.taskId===task.id);
      return assignment?{...task,agentIds:assignment.routeIds}:task;
    });
    const maxCalls=Math.min(MAX_RUN_CALLS,Math.max(p.maxCalls??0,recommendedCalls(planned)));
    const run=await call('/api/execution/runs','POST',{projectId:p.id,revision:p.revision,maxCalls,proposalId:proposal.id});
    stopStream(run.id);
    applyExecutionRun(p,run);watch(run);saveLocal();
    await history().catch(()=>{});
    render();
    notify('Автопілот: проєкт створено й AI-команду запущено');
    return run;
  };
  client.routingState=projectId=>routingStates.get(projectId)??null;
  client.updateRoutingDraft=(projectId,patch)=>{
    if(!projectId)return;
    const entry=ensureRouting(projectId);
    entry.draftConfig={...(entry.draftConfig??{}),...patch};
  };
  client.loadRouting=async(projectId,{silent=true}={})=>{
    if(!ready||!projectId)return;
    const entry=ensureRouting(projectId);
    const seq=++entry.loadSeq;
    entry.loading=true;if(!silent)entry.error=null;render();
    try {
      await persist();
      const data=await call(`/api/routing?projectId=${encodeURIComponent(projectId)}`);
      if(seq!==entry.loadSeq)return;
      entry.proposal=data.proposal??null;
      entry.stale=Boolean(data.stale);
      entry.error=null;
    }catch(error){
      if(seq!==entry.loadSeq)return;
      if(!silent){entry.error=error.message;notify(error.message);}
    }finally{
      if(seq===entry.loadSeq){entry.loading=false;render();}
    }
  };
  client.proposeRouting=async(projectId,formConfig)=>{
    if(!ready)throw new Error('Дочекайтеся підключення до локального сервера');
    const entry=ensureRouting(projectId);
    if(entry.proposing)return;
    const seq=++entry.proposeSeq;
    entry.proposing=true;entry.error=null;entry.draftConfig=formConfig;render();
    try {
      await persist();
      const currentProject=getState().projects.find(item=>item.id===projectId);
      if(!currentProject)throw new Error('Проєкт не знайдено');
      const callRevision=currentProject.revision;
      const payload=buildRoutingPayload(currentProject,formConfig);
      const proposal=await call('/api/routing','POST',payload);
      if(seq!==entry.proposeSeq)return;
      const afterProject=getState().projects.find(item=>item.id===projectId);
      const changedDuring=Boolean(afterProject&&(afterProject.revision!==callRevision||afterProject.revision!==proposal.revision));
      entry.proposal=proposal;
      entry.stale=changedDuring;
      if(changedDuring)notify('План змінився під час AI-підбору — пропозиція позначена як застаріла.');
      else notify('AI-підбір моделей збережено.');
    }catch(error){
      if(seq!==entry.proposeSeq)return;
      entry.error=error.message;
      notify(error.message);
    }finally{
      if(seq===entry.proposeSeq){entry.proposing=false;render();}
    }
  };
  client.scan=async()=>{
    if(client.scanning)return;client.scanning=true;client.catalogError=null;render();
    try {
      client.catalog=await call('/api/connections/scan','POST',{});
      const status=await call('/api/execution/status');client.runtimes=status.runtimes;
      notify(`Перевірено підключення. Моделей у каталозі: ${client.catalog.routes.length}`);
    }catch(error){client.catalogError=error.message;notify(error.message);}finally{client.scanning=false;render();}
  };
  async function history() { client.history=(await call('/api/execution/runs')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); }
  client.resultsFor=p=>{
    if(p.execution?.mode==='real')return p;
    const run=resultRuns.get(p.id);
    if(!run)return p;
    const view={...p};
    applyExecutionRun(view,run);
    return view;
  };
  client.loadResults=async p=>{
    if(p.execution?.mode==='real')return;
    const latest=client.history.find(run=>run.uiProjectId===p.id);
    if(!latest||resultRuns.get(p.id)?.id===latest.id)return;
    const run=await call(`/api/execution/runs/${encodeURIComponent(latest.id)}`);
    resultRuns.set(p.id,run);
    render({executionOnly:true});
  };
  client.streamState=runId=>{
    const entry=runId?streams.get(runId):null;
    return entry?{status:entry.status,attempts:entry.attempts,error:entry.error}:null;
  };
  function watch(run) {
    if(streams.has(run.id)||terminal(run.status)&&!run.draining&&!run.hostChecking)return;
    const controller=new AbortController(),entry={run,cursor:run.events?.length??0,controller,status:'connecting',attempts:0,error:null};streams.set(run.id,entry);
    void (async()=>{
      let completedRun=false;
      while(!controller.signal.aborted) {
        try {
          const response=await fetch(`/api/execution/runs/${encodeURIComponent(run.id)}/events`,{headers:{'X-Execution-Token':token,'Last-Event-ID':String(entry.cursor)},signal:controller.signal});
          if(!response.ok){
            if(response.status===403){entry.status='error';entry.error='Сервер перезапущено: оновіть сторінку';notify(entry.error);render({executionOnly:true});break;}
            throw Error('Потік подій недоступний');
          }
          let finished=false,streamErr=false;
          for await(const frame of readEventStream(response.body)) {
            if(controller.signal.aborted)break;
            if(!['snapshot','change','finished','stream-error'].includes(frame.event))continue;
            if(frame.event==='stream-error'){const payload=JSON.parse(frame.data);entry.status='error';entry.error=payload.message;render({executionOnly:true});streamErr=true;break;}
            if(frame.event==='change'&&Number(frame.id)<=entry.cursor)continue;
            entry.status='live';entry.attempts=0;entry.error=null;
            const result=applyRunFrame(entry.run,frame);entry.run=result.run;entry.cursor=result.cursor??entry.cursor;
            const p=getState().projects.find(p=>p.id===entry.run.project.uiProjectId);
            if(p&&p.revision===entry.run.project.uiRevision){applyExecutionRun(p,entry.run);saveLocal();render({executionOnly:true});}
            if(result.finished){finished=true;completedRun=true;entry.status='closed';break;}
          }
          if(finished||streamErr)break;
          throw Error('З’єднання подій перерване');
        }catch(error){
          if(controller.signal.aborted)break;
          entry.attempts++;
          if(entry.attempts>5){
            entry.status='error';entry.error='Не вдалося відновити потік подій. Оновіть сторінку.';
            notify(entry.error);render({executionOnly:true});break;
          }
          entry.status='reconnecting';entry.error=error.message;render({executionOnly:true});
          await new Promise(resolve=>{const retry=setTimeout(resolve,Math.min(10000,entry.attempts*1000));controller.signal.addEventListener('abort',()=>{clearTimeout(retry);resolve();},{once:true});});
        }
      }
      if(streams.get(run.id)===entry)streams.delete(run.id);
      if(completedRun){await history().catch(()=>{});render({executionOnly:true});}
    })();
  }
  async function loadRun(id,force=false) {
    const run=await call(`/api/execution/runs/${encodeURIComponent(id)}`);
    const p=getState().projects.find(p=>p.id===run.project.uiProjectId);
    if(p&&(force||p.revision===run.project.uiRevision)) {
      applyExecutionRun(p,run);getState().activeId=p.id;saveLocal();
    }
    watch(run);
    return run;
  }
  client.viewRun=async id=>{
    const run=await call(`/api/execution/runs/${encodeURIComponent(id)}`);
    modal('Історія запуску',`<div class="run-report"><p>${h(run.project.name)} · ревізія плану ${Number(run.project.uiRevision)||1} · ${h(run.status)} · ${Number(run.calls)||0} викликів</p><p class="workspace-path">${h(run.project.workspace)}</p>${run.tasks.map(t=>`<details><summary>${h(t.title)} · ${h(t.status)}</summary><pre>${h(t.result??t.error??'Результат ще відсутній')}</pre></details>`).join('')}<p class="muted text-small">Це знімок цього запуску. Відкриття історії не змінює поточний план.</p></div>`);
  };
  client.setup=async p=>{
    if(!ready)throw new Error('Дочекайтеся підключення до локального сервера');
    await persist();
    const preview=await call('/api/execution/preview','POST',{projectId:p.id});
    const ids=[...new Set(p.tasks.flatMap(t=>t.agentIds))];
    const available=preview.runtimes.filter(r=>r.allowed);
    const planned=p.tasks.filter(task=>!task.parentId).map(task=>{
      const assignment=preview.proposal?.assignments.find(item=>item.taskId===task.id);
      return assignment?{...task,agentIds:assignment.routeIds}:task;
    });
    const minimum=plannedCalls(planned);
    const suggested=Math.max(p.maxCalls??0,recommendedCalls(planned));
    const budgetField=`<label>Ліміт викликів цього запуску<input type="number" name="maxCalls" min="${minimum}" max="${MAX_RUN_CALLS}" required value="${suggested}"></label><p class="muted text-small">За поточним планом потрібно щонайменше ${minimum} викликів. Додатковий запас покриває повтори та делегування.</p>`;
    if(preview.proposal) {
      const proposal=preview.proposal;
      const allowed=proposal.assignments.every(a=>a.routeIds.every(id=>preview.runtimes.some(r=>r.routeId===id&&r.allowed&&r.access===(proposal.requirements[a.taskId]?.workspaceWrite===false?'read-only':'workspace-write'))));
      modal('Запуск AI-команди',`<form id="execution-form" data-project="${h(p.id)}" data-revision="${Number(p.revision)||1}" data-proposal="${h(proposal.id)}"><p>AI-пропозицію команди буде зафіксовано як фактичних виконавців цього запуску. Доступ і тарифи перевіряються повторно перед кожним викликом.</p><label>Робоча папка<input readonly value="${h(preview.workspace)}"></label>${proposal.assignments.map(a=>`<div class="info-note"><div><strong>${h(p.tasks.find(t=>t.id===a.taskId)?.title??a.taskId)}</strong><p>${a.routeIds.map(id=>{const rt=proposal.routes.find(r=>r.id===id);const b=formatBillingBadge(rt?.billing,rt?.billingBoundary);return `${h(rt?.model??id)} <span class="billing-pill ${b.tone}">${h(b.label)}</span>`;}).join(' → ')}</p><small>${h(a.reason)}</small></div></div>`).join('')}<p class="muted text-small">Незалежні задачі працюють в окремих worktree. Перевірені зміни інтегруються в папку проєкту; конфлікт зупиняє інтеграцію. Делегування: ${p.allowDelegation===false?'вимкнено':`до ${Number(p.maxDepth??2)||0} рівнів`}.</p>${budgetField}${!allowed?'<p class="route-blocked">Обраний маршрут зараз недоступний. Повторіть AI-підбір моделей.</p>':''}<div class="form-footer">${button('close-modal','Скасувати')}<button class="btn primary" type="submit" ${!allowed?'disabled':''}>Запустити AI-команду</button></div></form>`);
      return;
    }
    modal('Реальний запуск',`<form id="execution-form" data-project="${h(p.id)}" data-revision="${Number(p.revision)||1}"><p>Агенти виконають прийнятий план у цій робочій папці. Файли попередніх запусків цього проєкту залишаються доступними.</p><label>Робоча папка<input readonly value="${h(preview.workspace)}"></label><div class="info-note">AI-пропозиція для цього плану відсутня або застаріла. Можна виконати AI-підбір у вкладці «Команда» або призначити фактичних виконавців вручну. ${!available.length?"Немає маршрутів із підтвердженим доступом без доплат. Перевірте розділ «Підключення».":""}</div>${ids.map(id=>{const a=getState().agents.find(a=>a.id===id);return `<label>${h(a?.name??id)} · профіль: ${h(a?.model)}<select name="binding-${h(id)}" required>${!preferredAgentRuntime(a,preview.runtimes)?'<option value="" selected disabled>Оберіть доступного виконавця</option>':''}${preview.runtimes.map(r=>{const b=formatBillingBadge(r.billing,r.billingBoundary);return `<option value="${h(r.id)}" ${!r.allowed?'disabled':''} ${r.id===preferredAgentRuntime(a,preview.runtimes)?'selected':''}>${h(r.name)} · ${h(r.model)} · ${h(r.access)} · ${h(b.shortLabel)}${!r.allowed?" · заблоковано":""}</option>`;}).join('')}</select></label>`;}).join('')}<p class="muted text-small">${p.tasks.length} задач · Незалежні задачі працюють в ізольованих worktree; перевірені зміни інтегруються автоматично. Ліміт не обмежує внутрішні звернення CLI. Запуск може змінювати файли; скасування не відкочує їх.</p>${budgetField}<div class="form-footer">${button('close-modal','Скасувати')}<button class="btn primary" type="submit" ${!available.length?"disabled":""}>Запустити команду</button></div></form>`);
  };
  client.control=async(p,action,taskId)=>{
    const runId=p.execution.id;
    if(['continue','retry-access','retry-budget','resume-cancelled','balance-gemini'].includes(action))await persist();
    const run=await call(`/api/execution/runs/${encodeURIComponent(runId)}/${action}`,'POST',taskId?{taskId}:{});
    if(['continue','retry-access','retry-budget','resume-cancelled','verify-host','resume'].includes(action))stopStream(run.id);
    applyExecutionRun(p,run);watch(run);saveLocal();await history().catch(()=>{});render({executionOnly:true});
  };
  client.changeBudget=p=>{
    const run=p.execution;
    if(!ready||!run.canIncreaseBudget)throw Error('Зміна бюджету недоступна для цього запуску');
    const remaining=run.tasks.filter(task=>!['done','completed'].includes(task.status)&&(run.status==='cancelled'||task.status!=='cancelled'));
    const suggested=Math.min(MAX_RUN_CALLS,Math.max(run.maxCalls+1,run.calls+recommendedCalls(remaining)));
    modal('Збільшити бюджет запуску',`<form id="execution-budget-form" data-project="${h(p.id)}" data-run="${h(run.id)}" data-limit="${Number(run.maxCalls)||0}"><p>Використано ${Number(run.calls)||0} із ${Number(run.maxCalls)||0} викликів. Орієнтир для решти плану — ${plannedCalls(remaining)} викликів плюс запас на повтори.</p><label>Новий загальний ліміт<input type="number" name="maxCalls" min="${(Number(run.maxCalls)||0)+1}" max="${MAX_RUN_CALLS}" value="${suggested}" required></label><p class="muted text-small">Збільшення ліміту діє лише для цього запуску. Для продовження скористайтеся відповідною кнопкою після збереження.</p><div class="form-footer">${button('close-modal','Скасувати')}<button type="submit" class="btn primary">Зберегти ліміт</button></div></form>`);
  };
  client.clarify=(p,verification=false)=>{
    if(!ready)throw Error('Дочекайтеся завантаження актуального стану запуску');
    const tasks=p.execution.tasks.filter(t=>verification?hasVerificationChecks(t):t.needsCorrection===true||t.status==='blocked'&&(['AGENT_BLOCKED'].includes(t.failure?.code)||t.failure?.code==='WORKSPACE_CONFLICT'&&t.workspace&&t.result)||['failed','blocked'].includes(t.status)&&t.failure?.code==='WORKER_FAILED'&&t.blockedReport?.status==='completed');
    if(!tasks.length)throw Error('Стан запуску оновився. Повторно відкрийте проєкт перед уточненням.');
    modal(verification?'Повторити перевірки':'Уточнення вимог',`<form id="execution-clarify-form" data-project="${h(p.id)}"><p>${verification?'Вкажіть, що змінилося в середовищі, або додайте результати запуску на локальному хості. Це передасть дані виконавцю й використає один виклик.':'Уточнення буде передане виконавцю разом із підготовленою чернеткою. Готові задачі та бюджет зберігаються.'}</p><label>Задача<select name="taskId" required>${tasks.map(t=>`<option value="${h(t.id)}">${h(t.title)}</option>`).join('')}</select></label>${tasks.map(t=>`<details><summary>${h(t.title)}</summary><p>${h(t.blockedReport?.summary??t.error)}</p></details>`).join('')}<label>${verification?'Що виправлено або перевірено?':'Що потрібно уточнити?'}<textarea name="answer" rows="7" maxlength="6000" required placeholder="Уточніть вимоги, припущення та межі роботи"></textarea></label>${verification?'':'<label><input type="checkbox" name="projectScope"> Застосувати до всього проєкту й подальших задач</label>'}<div class="form-footer">${button('close-modal','Скасувати')}<button class="btn primary" type="submit">Зберегти й продовжити</button></div></form>`);
  };
  client.file=async(p,path)=>{
    const file=await call(`/api/execution/runs/${encodeURIComponent(p.execution.id)}/file?path=${encodeURIComponent(path)}`);
    download(file.path,file.text,'text/plain;charset=utf-8');
  };
  document.addEventListener('submit',async event=>{
    if(event.target.id==='execution-budget-form'){
      event.preventDefault();const form=event.target,data=new FormData(form),submit=form.querySelector('[type=submit]');submit.disabled=true;
      try{
        await persist();
        const p=getState().projects.find(project=>project.id===form.dataset.project);
        if(!p)throw Error('Проєкт не знайдено');
        const run=await call(`/api/execution/runs/${encodeURIComponent(form.dataset.run)}/budget`,'POST',
          {previousMaxCalls:Number(form.dataset.limit),maxCalls:Number(data.get('maxCalls'))});
        applyExecutionRun(p,run);saveLocal();document.querySelector('#modal').close();render();notify('Ліміт запуску оновлено.');
      }catch(error){notify(error.message);submit.disabled=false;}
      return;
    }
    if(event.target.id==='execution-clarify-form'){
      event.preventDefault();const form=event.target,data=new FormData(form),submit=form.querySelector('[type=submit]');submit.disabled=true;
      try{
        await persist();const p=getState().projects.find(project=>project.id===form.dataset.project);
        if(!p?.execution?.id)throw Error('Активний запуск не знайдено');
        const run=await call(`/api/execution/runs/${encodeURIComponent(p.execution.id)}/clarify`,'POST',{taskId:data.get('taskId'),answer:data.get('answer'),scope:data.has('projectScope')?'project':'task'});
        if(data.has('projectScope'))p.executionBrief=run.project.executionBrief;
        stopStream(run.id);
        applyExecutionRun(p,run);watch(run);saveLocal();document.querySelector('#modal').close();await history().catch(()=>{});render();notify('Дані збережено. Виконавець продовжує з чернетки.');
      }catch(error){notify(error.message);submit.disabled=false;}return;
    }
    if(event.target.id!=='execution-form')return;event.preventDefault();
    const form=event.target,data=new FormData(form),submit=form.querySelector('[type=submit]');submit.disabled=true;
    try {
      await persist();const p=getState().projects.find(project=>project.id===form.dataset.project);
      if(!p)throw Error('Проєкт не знайдено');
      const bindings=Object.fromEntries([...new Set(p.tasks.flatMap(t=>t.agentIds))].map(id=>[id,data.get(`binding-${id}`)]));
      const run=await call('/api/execution/runs','POST',{projectId:p.id,revision:Number(form.dataset.revision),maxCalls:Number(data.get('maxCalls')),...(form.dataset.proposal?{proposalId:form.dataset.proposal}:{bindings})});
      stopStream(run.id);
      applyExecutionRun(p,run);watch(run);saveLocal();document.querySelector('#modal').close();render();notify('Реальний запуск розпочато');
      void persist().catch(()=>{});
      void history().then(()=>render({executionOnly:true})).catch(()=>{});
    }catch(error){notify(error.message);submit.disabled=false;}
  });
  client.init=async()=>{
    try {
      const status=await call('/api/execution/status');token=status.token;client.runtimes=status.runtimes;
      const stored=await call('/api/workspace');revision=stored.revision;
      if(stored.workspace)setState(stored.workspace);
      client.loadingCatalog=true;render();
      try {
        client.catalog=await call('/api/connections');client.catalogError=null;
      }catch(error){client.catalogError=error.message;}finally{client.loadingCatalog=false;}
      ready=client.ready=true;
      if(!stored.workspace)await persist();
      await history();
      const activeId=getState().activeId;
      for(const p of getState().projects) {
        const latest=client.history.find(r=>r.uiProjectId===p.id&&r.uiRevision===p.revision);
        if(latest&&(p.execution?.mode==='real'||!terminal(latest.status)))await loadRun(latest.id);
      }
      getState().activeId=activeId;
      saveLocal();render();
      if(activeId)void client.loadRouting(activeId,{silent:true});
      if(!client.catalogError&&(!client.catalog?.checkedAt||client.catalog.routes.some(r=>!Number.isFinite(Date.parse(r.expiresAt))||Date.parse(r.expiresAt)<=Date.now())))void client.scan();
    }catch(error){notify('Серверне збереження недоступне: '+error.message);}
  };
  window.addEventListener('beforeunload',()=>{client.stopAllStreams();});
  return client;
}
