const terminal = status => !['running','paused'].includes(status);
const statusLabels={ 'run.started':'Запуск розпочато','run.paused':'Чергу поставлено на паузу','run.resumed':'Чергу продовжено',
  'run.cancelled':'Запуск скасовано','run.completed':'Запуск завершено','run.failed':'Запуск завершився помилкою',
  'run.interrupted':'Запуск перервано перезапуском сервера','task.started':'Почато задачу','task.completed':'Завершено задачу',
  'task.failed':'Помилка задачі','task.cancelled':'Скасовано задачу','agent.started':'Агент почав роботу','agent.completed':'Агент завершив роботу','agent.failed':'Помилка агента'};

export function applyExecutionRun(project,run) {
  const mapped=run.tasks.map(t=>({...t,status:t.status==='completed'?'done':t.status}));
  project.tasks=project.tasks.map(t=>{const {beats,children,result,error,...base}=t;return {...base,...mapped.find(item=>item.id===t.id)};});
  project.status=run.status;
  project.execution={mode:'real',id:run.id,status:run.status,draining:run.draining,uiRevision:run.project.uiRevision,workspace:run.project.workspace,calls:run.calls,
    agents:run.project.agents.map(({id,name,model,provider,access})=>({id,name,model,provider,access})),files:run.files??[],createdAt:run.createdAt,
    usage:run.events.filter(e=>['agent.completed','agent.failed'].includes(e.type)).reduce((sum,o)=>({input:sum.input+(o.usage?.input_tokens??o.usage?.prompt_tokens??0),output:sum.output+(o.usage?.output_tokens??o.usage?.completion_tokens??0)}),{input:0,output:0})};
  project.events=run.events.slice(-300).reverse().map(e=>({at:e.at,real:true,text:
    `${statusLabels[e.type]??(e.type==='agent.progress'?'':'Подія '+e.type)}${e.taskId?' · '+(run.tasks.find(t=>t.id===e.taskId)?.title??e.taskId):''}${e.agentId?' · '+(run.project.agents.find(a=>a.id===e.agentId)?.name??e.agentId):''}${e.message?'\n'+e.message:''}`}));
  project.artifacts=run.tasks.filter(t=>t.result).map(t=>({id:t.id,taskId:t.id,name:`${t.title}.md`,text:t.result,real:true}));
}

export function createExecutionClient({getState,setState,render,saveLocal,notify,modal,h,button,download}) {
  let token,revision=0,ready=false,timer,queue=Promise.resolve(),polling=false,conflict=false;
  const client={ready:false,history:[],runtimes:[],saving:false,catalog:null,scanning:false};
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
  client.scan=async()=>{
    if(client.scanning)return;client.scanning=true;render();
    try {
      client.catalog=await call('/api/connections/scan','POST',{});
      const status=await call('/api/execution/status');client.runtimes=status.runtimes;
      notify(`Перевірено підключення. Моделей у каталозі: ${client.catalog.routes.length}`);
    }catch(error){notify(error.message);}finally{client.scanning=false;render();}
  };
  async function history() { client.history=(await call('/api/execution/runs')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); }
  async function loadRun(id,force=false) {
    const run=await call(`/api/execution/runs/${encodeURIComponent(id)}`);
    const p=getState().projects.find(p=>p.id===run.project.uiProjectId);
    if(p&&(force||p.revision===run.project.uiRevision)) {
      applyExecutionRun(p,run);getState().activeId=p.id;saveLocal();
    }
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
    modal('Реальний запуск',`<form id="execution-form" data-project="${h(p.id)}" data-revision="${p.revision}"><p>Агенти виконають прийнятий план у цій робочій папці. Файли попередніх запусків цього проєкту залишаються доступними.</p><label>Робоча папка<input readonly value="${h(preview.workspace)}"></label><div class="info-note">Налаштовано Codex CLI · reasoning ${h(preview.reasoningEffort)}. Призначте фактичного виконавця кожній ролі з підтвердженим тарифом. ${!available.length?"Немає маршрутів, для яких підтверджено відсутність додаткових списань. Перевірте розділ «Підключення».":""}</div>${ids.map(id=>{const a=getState().agents.find(a=>a.id===id);return `<label>${h(a?.name??id)} · рекомендація: ${h(a?.model)}<select name="binding-${h(id)}">${preview.runtimes.map(r=>`<option value="${h(r.id)}" ${!r.allowed?'disabled':''} ${r.allowed&&r.access==='read-only'&&id==='reviewer'?'selected':''}>${h(r.name)} · ${h(r.model)} · ${h(r.access)}${!r.allowed?" · заблоковано":""}</option>`).join('')}</select></label>`;}).join('')}<p class="muted text-small">${p.tasks.length} задач · до ${p.maxCalls} викликів оркестратора · Codex у спільній папці працює послідовно. Ліміт не обмежує внутрішні звернення CLI. Запуск може змінювати файли; скасування не відкочує їх.</p><div class="form-footer">${button('close-modal','Скасувати')}<button class="btn primary" type="submit" ${!available.length?"disabled":""}>Запустити Codex</button></div></form>`);
  };
  client.control=async(p,action,taskId)=>{
    const run=await call(`/api/execution/runs/${encodeURIComponent(p.execution.id)}/${action}`,'POST',taskId?{taskId}:{});
    applyExecutionRun(p,run);saveLocal();await history();render();
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
      const run=await call('/api/execution/runs','POST',{projectId:p.id,revision:Number(form.dataset.revision),bindings});
      applyExecutionRun(p,run);saveLocal();await persist();document.querySelector('#modal').close();await history();render();notify('Реальний запуск Codex розпочато');
    }catch(error){notify(error.message);submit.disabled=false;}
  });
  client.init=async()=>{
    try {
      const status=await call('/api/execution/status');token=status.token;client.runtimes=status.runtimes;
      const stored=await call('/api/workspace');revision=stored.revision;
      client.catalog=await call('/api/connections');
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
      if(!client.catalog.checkedAt)void client.scan();
    }catch(error){notify('Серверне збереження недоступне: '+error.message);}
  };
  setInterval(async()=>{
    if(!ready||polling)return;polling=true;
    try {
      let changed=false;
      for(const p of getState().projects)if(p.execution?.mode==='real'&&(!terminal(p.status)||p.execution.draining)) {
        const activeId=getState().activeId;await loadRun(p.execution.id);getState().activeId=activeId;changed=true;
      }
      if(changed){await history();if(!document.querySelector('#modal').open&&!document.activeElement?.matches('input,textarea,select'))render();}
    }catch(error){notify('Не вдалося оновити запуск: '+error.message);}
    finally{polling=false;}
  },1500);
  return client;
}
