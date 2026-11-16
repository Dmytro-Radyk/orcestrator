import { preferredAgentRuntime } from './agent-library.js';
import { buildRoutingPayload, formatBillingBadge } from './routing-ui.js';
import { readEventStream,applyRunFrame } from './event-stream.js';

const terminal = status => !['running','paused'].includes(status);
const statusLabels={ 'run.started':'Запуск розпочато','run.paused':'Чергу поставлено на паузу','run.resumed':'Чергу продовжено',
  'run.cancelled':'Запуск скасовано','run.completed':'Запуск завершено','run.failed':'Запуск завершився помилкою',
  'run.interrupted':'Запуск перервано перезапуском сервера','task.started':'Почато задачу','task.completed':'Завершено задачу',
  'task.failed':'Помилка задачі','task.cancelled':'Скасовано задачу','agent.started':'Агент почав роботу','agent.completed':'Агент завершив роботу','agent.failed':'Помилка агента'};

export function applyExecutionRun(project,run) {
  const mapped=run.tasks.map(t=>({...t,status:t.status==='completed'?'done':t.status}));
  const children=id=>mapped.filter(t=>t.parentId===id).map(t=>({...t,children:children(t.id)}));
  project.tasks=project.tasks.filter(t=>!t.parentId).map(t=>{const {beats,children:oldChildren,result,error,...base}=t;return {...base,...mapped.find(item=>item.id===t.id),agentIds:base.agentIds,children:children(t.id)};});
  project.status=run.status;
  project.execution={mode:'real',id:run.id,status:run.status,draining:run.draining,recovery:run.recovery,uiRevision:run.project.uiRevision,workspace:run.project.workspace,calls:run.calls,
    agents:run.project.agents.map(({id,name,model,provider,access,role,skills,billing,billingBoundary})=>({id,name,model,provider,access,role,skills,billing,billingBoundary})),tasks:mapped,files:run.files??[],createdAt:run.createdAt,
    usage:run.events.filter(e=>['agent.completed','agent.failed','recovery.manager_completed'].includes(e.type)).reduce((sum,o)=>({input:sum.input+(o.usage?.input_tokens??o.usage?.prompt_tokens??0),output:sum.output+(o.usage?.output_tokens??o.usage?.completion_tokens??0)}),{input:0,output:0})};
  project.events=run.events.slice(-300).reverse().map(e=>({at:e.at,real:true,text:
    `${statusLabels[e.type]??(e.type==='agent.progress'?'':'Подія '+e.type)}${e.taskId?' · '+(run.tasks.find(t=>t.id===e.taskId)?.title??e.taskId):''}${e.agentId?' · '+(run.project.agents.find(a=>a.id===e.agentId)?.name??e.agentId):''}${e.message?'\n'+e.message:''}`}));
  project.artifacts=run.tasks.filter(t=>t.result).map(t=>({id:t.id,taskId:t.id,name:`${t.title}.md`,text:t.result,real:true}));
}

export function createExecutionClient({getState,setState,render,saveLocal,notify,modal,h,button,download}) {
  let token,revision=0,ready=false,timer,queue=Promise.resolve(),conflict=false;
  const streams=new Map();
  const routingStates=new Map();
  const client={ready:false,history:[],runtimes:[],saving:false,catalog:null,loadingCatalog:false,scanning:false,catalogError:null};
  function ensureRouting(projectId) {
    if(!routingStates.has(projectId))routingStates.set(projectId,{loading:false,proposing:false,error:null,proposal:null,stale:false,draftConfig:null,loadSeq:0,proposeSeq:0});
    return routingStates.get(projectId);
  }
  async function call(path,method='GET',body) {
    const response=await fetch(path,{method,headers:{'X-Execution-Token':token??'',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error??'Помилка сервера');return data;
  }
  function persist() {
    clearTimeout(timer);
    if(!ready || conflict)return queue;
    const workspace=structuredClone(getState());
    client.saving=true;
    const request=queue.then(async()=>{const stored=await call('/api/workspace','PUT',{revision,workspace});revision=stored.revision;});
    queue=request.catch(error=>{if(error.message.includes('Конфлікт'))conflict=true;notify('Не вдалося зберегти на сервері: '+error.message);}).finally(()=>{client.saving=false;});
    return request;
  }
  client.scheduleSave=()=>{if(ready&&!conflict){clearTimeout(timer);timer=setTimeout(()=>persist().catch(()=>{}),300);}};
  client.flush=()=>persist();
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
  client.streamState=runId=>{
    const entry=runId?streams.get(runId):null;
    return entry?{status:entry.status,attempts:entry.attempts,error:entry.error}:null;
  };
  function watch(run) {
    if(streams.has(run.id)||terminal(run.status)&&!run.draining)return;
    const controller=new AbortController(),entry={run,cursor:0,controller,status:'connecting',attempts:0,error:null};streams.set(run.id,entry);
    void (async()=>{
      while(!controller.signal.aborted) {
        try {
          const response=await fetch(`/api/execution/runs/${encodeURIComponent(run.id)}/events`,{headers:{'X-Execution-Token':token,'Last-Event-ID':String(entry.cursor)},signal:controller.signal});
          if(!response.ok){
            if(response.status===403){entry.status='error';entry.error='Сервер перезапущено: оновіть сторінку';notify(entry.error);render({executionOnly:true});break;}
            throw Error('Потік подій недоступний');
          }
          let finished=false;
          for await(const frame of readEventStream(response.body)) {
            if(!['snapshot','change','finished','stream-error'].includes(frame.event))continue;
            if(frame.event==='stream-error'){const payload=JSON.parse(frame.data);entry.status='error';entry.error=payload.message;render({executionOnly:true});continue;}
            if(frame.event==='change'&&Number(frame.id)<=entry.cursor)continue;
            entry.status='live';entry.attempts=0;entry.error=null;
            const result=applyRunFrame(entry.run,frame);entry.run=result.run;entry.cursor=result.cursor??entry.cursor;
            const p=getState().projects.find(p=>p.id===entry.run.project.uiProjectId);
            if(p&&p.revision===entry.run.project.uiRevision){applyExecutionRun(p,entry.run);saveLocal();render({executionOnly:true});}
            if(result.finished){finished=true;entry.status='closed';await history();render({executionOnly:true});break;}
          }
          if(finished)break;
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
      streams.delete(run.id);
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
    modal('Історія запуску',`<div class="run-report"><p>${h(run.project.name)} · ревізія плану ${run.project.uiRevision} · ${h(run.status)} · ${run.calls} викликів</p><p class="workspace-path">${h(run.project.workspace)}</p>${run.tasks.map(t=>`<details><summary>${h(t.title)} · ${h(t.status)}</summary><pre>${h(t.result??t.error??'Результат ще відсутній')}</pre></details>`).join('')}<p class="muted text-small">Це знімок цього запуску. Відкриття історії не змінює поточний план.</p></div>`);
  };
  client.setup=async p=>{
    if(!ready)throw new Error('Дочекайтеся підключення до локального сервера');
    await persist();
    const preview=await call('/api/execution/preview','POST',{projectId:p.id});
    const ids=[...new Set(p.tasks.flatMap(t=>t.agentIds))];
    const available=preview.runtimes.filter(r=>r.allowed);
    if(preview.proposal) {
      const proposal=preview.proposal;
      const allowed=proposal.assignments.every(a=>a.routeIds.every(id=>preview.runtimes.some(r=>r.routeId===id&&r.allowed&&r.access===(proposal.requirements[a.taskId]?.workspaceWrite===false?'read-only':'workspace-write'))));
      modal('Запуск AI-команди',`<form id="execution-form" data-project="${h(p.id)}" data-revision="${p.revision}" data-proposal="${h(proposal.id)}"><p>AI-пропозицію команди буде зафіксовано як фактичних виконавців цього запуску. Доступ і тарифи перевіряються повторно перед кожним викликом.</p><label>Робоча папка<input readonly value="${h(preview.workspace)}"></label>${proposal.assignments.map(a=>`<div class="info-note"><div><strong>${h(p.tasks.find(t=>t.id===a.taskId)?.title??a.taskId)}</strong><p>${a.routeIds.map(id=>{const rt=proposal.routes.find(r=>r.id===id);const b=formatBillingBadge(rt?.billing,rt?.billingBoundary);return `${h(rt?.model??id)} <span class="billing-pill ${b.tone}">${h(b.label)}</span>`;}).join(' → ')}</p><small>${h(a.reason)}</small></div></div>`).join('')}<p class="muted text-small">Незалежні задачі працюють в окремих worktree. Перевірені зміни інтегруються в папку проєкту; конфлікт зупиняє інтеграцію. Делегування: ${p.allowDelegation===false?'вимкнено':`до ${p.maxDepth??2} рівнів`} · до ${p.maxCalls} викликів.</p>${!allowed?'<p class="route-blocked">Обраний маршрут зараз недоступний. Повторіть AI-підбір моделей.</p>':''}<div class="form-footer">${button('close-modal','Скасувати')}<button class="btn primary" type="submit" ${!allowed?'disabled':''}>Запустити AI-команду</button></div></form>`);
      return;
    }
    modal('Реальний запуск',`<form id="execution-form" data-project="${h(p.id)}" data-revision="${p.revision}"><p>Агенти виконають прийнятий план у цій робочій папці. Файли попередніх запусків цього проєкту залишаються доступними.</p><label>Робоча папка<input readonly value="${h(preview.workspace)}"></label><div class="info-note">AI-пропозиція для цього плану відсутня або застаріла. Можна виконати AI-підбір у вкладці «Команда» або призначити фактичних виконавців вручну. ${!available.length?"Немає маршрутів із підтвердженим доступом без доплат. Перевірте розділ «Підключення».":""}</div>${ids.map(id=>{const a=getState().agents.find(a=>a.id===id);return `<label>${h(a?.name??id)} · профіль: ${h(a?.model)}<select name="binding-${h(id)}" required>${!preferredAgentRuntime(a,preview.runtimes)?'<option value="" selected disabled>Оберіть доступного виконавця</option>':''}${preview.runtimes.map(r=>{const b=formatBillingBadge(r.billing,r.billingBoundary);return `<option value="${h(r.id)}" ${!r.allowed?'disabled':''} ${r.id===preferredAgentRuntime(a,preview.runtimes)?'selected':''}>${h(r.name)} · ${h(r.model)} · ${h(r.access)} · ${h(b.shortLabel)}${!r.allowed?" · заблоковано":""}</option>`;}).join('')}</select></label>`;}).join('')}<p class="muted text-small">${p.tasks.length} задач · до ${p.maxCalls} викликів оркестратора · Незалежні задачі працюють в ізольованих worktree; перевірені зміни інтегруються автоматично. Ліміт не обмежує внутрішні звернення CLI. Запуск може змінювати файли; скасування не відкочує їх.</p><div class="form-footer">${button('close-modal','Скасувати')}<button class="btn primary" type="submit" ${!available.length?"disabled":""}>Запустити команду</button></div></form>`);
  };
  client.control=async(p,action,taskId)=>{
    const run=await call(`/api/execution/runs/${encodeURIComponent(p.execution.id)}/${action}`,'POST',taskId?{taskId}:{});
    applyExecutionRun(p,run);watch(run);saveLocal();await history();render({executionOnly:true});
  };
  client.file=async(p,path)=>{
    const file=await call(`/api/execution/runs/${encodeURIComponent(p.execution.id)}/file?path=${encodeURIComponent(path)}`);
    download(file.path,file.text,'text/plain;charset=utf-8');
  };
  document.addEventListener('submit',async event=>{
    if(event.target.id!=='execution-form')return;event.preventDefault();
    const form=event.target,data=new FormData(form),submit=form.querySelector('[type=submit]');submit.disabled=true;
    try {
      await persist();const p=getState().projects.find(p=>p.id===form.dataset.project);
      const bindings=Object.fromEntries([...new Set(p.tasks.flatMap(t=>t.agentIds))].map(id=>[id,data.get(`binding-${id}`)]));
      const run=await call('/api/execution/runs','POST',{projectId:p.id,revision:Number(form.dataset.revision),...(form.dataset.proposal?{proposalId:form.dataset.proposal}:{bindings})});
      applyExecutionRun(p,run);watch(run);saveLocal();await persist();document.querySelector('#modal').close();await history();render();notify('Реальний запуск розпочато');
    }catch(error){notify(error.message);submit.disabled=false;}
  });
  client.init=async()=>{
    try {
      const status=await call('/api/execution/status');token=status.token;client.runtimes=status.runtimes;
      const stored=await call('/api/workspace');revision=stored.revision;
      client.loadingCatalog=true;render();
      try {
        client.catalog=await call('/api/connections');client.catalogError=null;
      }catch(error){client.catalogError=error.message;}finally{client.loadingCatalog=false;}
      if(stored.workspace)setState(stored.workspace);
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
  window.addEventListener('beforeunload',()=>{for(const entry of streams.values())entry.controller.abort();});
  return client;
}
