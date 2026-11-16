import { demoIdea, demoPlan, demoAssignments, validateIdea, validatePlan, validateAssignments } from './planning.js';
import {plannerChoices,draftRoutingInput,proposalTeam} from './project-composition.js';
import {formatBillingBadge} from './routing-ui.js';

export function createProjectWizard({ modal, h, icon, button, agents, onCreate, notify, getCatalog, proposeDraft }) {
  let draft, config, step = 1, busy = false, controller, generation = 0;
  const dialog = document.querySelector('#modal');
  dialog.addEventListener('close', () => { generation++; controller?.abort(); busy = false; });
  const list = values => `<ul>${values.map(v => `<li>${h(v)}</li>`).join('')}</ul>`;
  const managerCatalog=()=>({routes:config?.managerRoutes??getCatalog?.()?.routes??[]});
  const selectedPlanner=()=>draft.managerRouteId?managerCatalog().routes.find(r=>r.id===draft.managerRouteId):null;
  const canPlan=()=>Boolean(config?.token&&(draft.managerRouteId?selectedPlanner():config.configured));
  const note = () => {const selected=selectedPlanner();return `<div class="planner-status">${icon('spark')}<span><strong>${draft.managerRouteId?'Обраний AI-керівник':'Автоматичний AI-керівник'}</strong><small>${h(selected?`${selected.name??selected.model} · ${selected.backend}`:draft.managerRouteId?'Обраний керівник недоступний':config?.configured?`${config.model} · ${config.provider}`:config?.blockedReason??'Перевіряємо доступні моделі…')}</small></span><span class="provider-pill">${canPlan()?'AI':'Перевірка доступу'}</span></div>`;};
  function capture() {
    const form = dialog.querySelector('form'); if (!form) return;
    const data = new FormData(form);
    if (step === 1) { draft.name = String(data.get('name') ?? '').trim(); draft.description = String(data.get('description') ?? '').trim(); draft.mode = data.get('mode') ?? 'idea'; draft.priority = data.get('priority') ?? 'quality';draft.managerRouteId=String(data.get('managerRouteId')??'');draft.freeWorkers=data.has('freeWorkers');draft.maxAgentsPerTask=Number(data.get('maxAgentsPerTask')??1); }
    if (step === 2) { if (draft.idea && data.has('summary')) draft.idea.summary = String(data.get('summary')).trim(); draft.feedback = String(data.get('feedback') ?? '').trim(); }
    if (step === 3 && draft.plan) {
      draft.plan.summary = String(data.get('summary') ?? draft.plan.summary).trim();
      draft.plan.tasks.forEach(t => { t.title = String(data.get(`title-${t.id}`) ?? t.title).trim(); t.prompt = String(data.get(`prompt-${t.id}`) ?? t.prompt).trim(); t.acceptanceCriteria = String(data.get(`criteria-${t.id}`) ?? t.acceptanceCriteria.join('\n')).split('\n').map(s=>s.trim()).filter(Boolean); });
      draft.requirements=Object.fromEntries(draft.plan.tasks.map(t=>[t.id,data.get(`access-${t.id}`)==='text'?'text':'write']));
    }
  }
  function generateButtons(kind, label) {
    return `<div class="generation-actions">${button('',label,'spark','btn primary',`data-creation="generate-${kind}" ${!canPlan() || busy ? 'disabled' : ''}`)}${button('','Показати демо-приклад','','btn',`data-creation="demo-${kind}" ${busy ? 'disabled' : ''}`)}</div><p class="muted text-small">${canPlan()?'Керівник опрацює запит. Виконання задач почнеться після окремого підтвердження запуску.':'Для AI потрібен доступний керівник. Перевірте «Підключення» або явно оберіть демо-приклад.'}</p>`;
  }
  function source(kind) { const meta=draft[`${kind}Source`]; return meta ? `<div class="source-label ${meta.mode}">${icon(meta.mode === 'ai' ? 'spark' : 'file')}${meta.mode === 'ai' ? `Створено AI · ${h(meta.model)}` : 'Демо-приклад · без модельного запиту'}</div>` : ''; }
  function body() {
    if (step === 1) return `<h3>Керівник і задум проєкту</h3>
      <label>AI-керівник<select name="managerRouteId"><option value="">Автоматично з доступних моделей</option>${draft.managerRouteId&&!plannerChoices(managerCatalog()).some(r=>r.id===draft.managerRouteId)?`<option value="${h(draft.managerRouteId)}" selected>${h(selectedPlanner()?.name??draft.managerRouteId)} · доступ буде перевірено</option>`:''}${plannerChoices(managerCatalog()).map(r=>`<option value="${h(r.id)}" ${draft.managerRouteId===r.id?'selected':''}>${h(r.name??r.model)} · ${h(r.backend)}</option>`).join('')}</select></label>
      <p class="muted text-small">Обрана модель продумує ідею, складає план і підбирає виконавців. Автоматичний режим обирає дозволений маршрут на кожному етапі.</p>
      <div class="creation-modes"><label><input type="radio" name="mode" value="idea" ${draft.mode==='idea'?'checked':''}><span><strong>Допоможіть продумати ідею</strong><small>Уточнити задум, функції та межі першої версії.</small></span></label><label><input type="radio" name="mode" value="ready" ${draft.mode==='ready'?'checked':''}><span><strong>Проєкт уже придуманий</strong><small>Перейти від готового опису до детального плану.</small></span></label></div>
      <label>Робоча назва<input name="name" required maxlength="80" value="${h(draft.name)}" placeholder="Наприклад, помічник для досліджень"></label>
      <label>Ідея, вимоги або готовий опис<textarea name="description" required maxlength="12000" placeholder="Що хочете створити, для кого і який результат отримати?">${h(draft.description)}</textarea></label>
      <label>Пріоритет підбору моделей<select name="priority">${[['quality','Якість і продуманість'],['balanced','Баланс якості та часу'],['economy','Економія токенів за дотримання вимог']].map(([v,label])=>`<option value="${v}" ${draft.priority===v?'selected':''}>${label}</option>`).join('')}</select></label>
      <details><summary>Налаштування команди</summary><label>Максимум моделей на задачу<select name="maxAgentsPerTask">${[1,2,3,4,5,6].map(n=>`<option value="${n}" ${draft.maxAgentsPerTask===n?'selected':''}>${n}</option>`).join('')}</select></label><label class="checkline"><input type="checkbox" name="freeWorkers" ${draft.freeWorkers?'checked':''}>Тільки безкоштовні виконавці</label><p class="muted text-small">За замовчуванням також доступні моделі, включені у підтверджені підписки. Оплата за токени й непідтверджені маршрути заблоковані. Обмеження виконавців не змінює доступ обраного керівника.</p></details>`;
    if (step === 2) return `${note()}<h3>Від задуму до продуманої концепції</h3><p class="creation-description">Планувальник допоможе визначити користувача, ключову користь, функції, ризики та відкриті питання.</p>${generateButtons('idea',draft.idea?'Уточнити з AI':'Продумати ідею з AI')}${draft.idea ? `${source('idea')}<label>Концепція — можна відредагувати<textarea name="summary" required maxlength="12000">${h(draft.idea.summary)}</textarea></label><div class="brief-columns"><div><h4>Ключові можливості</h4>${list(draft.idea.features)}</div><div><h4>Що потрібно уточнити</h4>${list(draft.idea.questions)}</div></div><h4>Ризики</h4>${list(draft.idea.risks)}<label>Відповіді та уточнення<textarea name="feedback" maxlength="6000" placeholder="Дайте відповіді на питання або поясніть, що змінити…">${h(draft.feedback)}</textarea></label>` : '<div class="creation-empty">Спочатку отримайте концепцію, уточніть її та прийміть перед плануванням.</div>'}`;
    if (step === 3) return `${note()}<h3>Детальний план проєкту</h3><p class="creation-description">План має визначати конкретні задачі, залежності, необхідні навички та перевірювані критерії готовності.</p>${generateButtons('plan',draft.plan?'Перепланувати з AI':'Створити план з AI')}${draft.plan ? `${source('plan')}<label>Підхід і межі<textarea name="summary" required>${h(draft.plan.summary)}</textarea></label><div class="brief-columns"><div><h4>Припущення</h4>${list(draft.plan.assumptions)}</div><div><h4>Ризики</h4>${list(draft.plan.risks)}</div></div><div class="planned-tasks">${draft.plan.tasks.map((t,i)=>`<details ${i===0?'open':''}><summary><span>${String(i+1).padStart(2,'0')}</span>${h(t.title)}<small>${t.dependsOn.length?'Після: '+h(t.dependsOn.join(', ')):'Незалежна задача'}</small></summary><label>Назва<input name="title-${h(t.id)}" value="${h(t.title)}" required></label><label>Інструкція<textarea name="prompt-${h(t.id)}" required>${h(t.prompt)}</textarea></label><label>Критерії готовності — по одному на рядок<textarea name="criteria-${h(t.id)}" required>${h(t.acceptanceCriteria.join('\n'))}</textarea></label><div class="skills">${t.skills.map(s=>`<span>${h(s)}</span>`).join('')}</div></details>`).join('')}</div>` : '<div class="creation-empty">Задачі з’являться після планування. Команда буде підібрана за цим планом.</div>'}`;
    const exact=draft.teamSource?.mode==='ai'&&draft.proposal;
    return `${note()}<h3>Команда для прийнятого плану</h3><p class="creation-description">Керівник обирає точні моделі для кожної задачі з доступних безкоштовних маршрутів і підтверджених підписок.</p>${generateButtons('team','Повторити підбір команди')}${draft.routing?`${source('team')}<div class="routing-cards">${draft.routing.assignments.map(a=>{const task=draft.plan.tasks.find(t=>t.id===a.taskId);return `<article><h4>${h(task.title)}</h4><div class="recommended-agents">${exact?draft.proposal.assignments.find(v=>v.taskId===a.taskId).routeIds.map(id=>{const route=draft.proposal.routes.find(r=>r.id===id),bill=formatBillingBadge(route.billing,route.billingBoundary);return `<span><b>${h(route.model)}</b><small>${h(route.backend)} · ${h(bill.label)}</small></span>`;}).join(''):a.agentIds.map(id=>`<span><b>${h(agents().find(v=>v.id===id)?.name??id)}</b><small>Демо-профіль</small></span>`).join('')}</div><p>${h(a.reason)}</p><small class="muted">${draft.requirements?.[a.taskId]==='text'?'Аналіз без зміни файлів':'Робота з файлами'}</small></article>`;}).join('')}</div><div class="info-note">${icon('shield')}${exact?'Проєкт буде збережено разом із цим призначенням. Перед збереженням і запуском доступ перевіряється повторно.':'Демо показує рольові профілі. Реальні моделі для цього прикладу ще не призначені.'}</div>`:'<div class="creation-empty">Тут з’являться моделі та пояснення вибору для кожної задачі.</div>'}`;
  }
  function show(next=step) {
    step=next;
    const names=['Задум','Концепція','План','Команда'];
    const disabled=busy || (step===2&&!draft.idea) || (step===3&&!draft.plan) || (step===4&&!draft.routing);
    const access=step===3&&draft.plan?`<details><summary>Доступ виконавців до файлів</summary><p class="muted text-small">Для дослідження або перевірки можна обрати аналіз без зміни файлів.</p>${draft.plan.tasks.map(t=>`<label>${h(t.title)}<select name="access-${h(t.id)}"><option value="write" ${draft.requirements?.[t.id]!=='text'?'selected':''}>Робота з файлами</option><option value="text" ${draft.requirements?.[t.id]==='text'?'selected':''}>Аналіз без зміни файлів</option></select></label>`).join('')}</details>`:'';
    modal('Новий проєкт',`<div class="creation-flow">
      <div class="wizard-steps" aria-label="Етапи створення">${names.map((n,i)=>`<span ${step===i+1?'aria-current="step"':''} class="${step===i+1?'current':step>i+1?'finished':''} ${i===1&&draft.mode==='ready'?'skipped':''}">${i+1}<b>${n}</b></span>${i<3?'<i></i>':''}`).join('')}</div>
      <form id="creation-project" data-step="${step}" aria-busy="${busy}">
      ${busy?'<div class="planning-busy" role="status">Опрацьовуємо запит. AI-планування може тривати до 4 хвилин.</div>':''}
      ${draft.error?`<p class="execution-error" role="alert">${h(draft.error)}</p>`:''}
      <fieldset class="creation-fields" ${busy?'disabled':''}>${body()}${access}</fieldset>
      <div class="form-footer">${button('',step===1?'Скасувати':'Назад','','btn',`data-creation="back" ${busy?'disabled':''}`)}<button type="submit" class="btn primary" ${disabled?'disabled':''}>${['Продовжити','Прийняти концепцію','Прийняти план і підібрати команду','Створити проєкт'][step-1]} ${icon('arrow')}</button></div>
      </form></div>`);
    dialog.scrollTop=0;
  }
  async function generate(kind, demo=false) {
    capture(); const ownDraft=draft, version=++generation; controller?.abort(); controller=new AbortController(); busy=true; draft.error=null; show();
    try {
      const input={name:draft.name,description:draft.description,priority:draft.priority,idea:draft.idea,feedback:draft.feedback,plan:draft.plan,...(kind==='team'?{agents:agents().map(({id,name,model,provider,skills,role})=>({id,name,model,provider,skills,role}))}:{})};
      let result;
      if (demo) result={value:kind==='idea'?demoIdea(input):kind==='plan'?demoPlan(input):demoAssignments(draft.plan,agents()),provenance:{mode:'demo',at:new Date().toISOString()}};
      else if(kind==='team'){const proposal=await proposeDraft(draftRoutingInput(draft),controller.signal);result={value:proposalTeam(proposal,draft.plan).routing,provenance:proposal.provenance,proposal};}
      else { const response=await fetch('/api/planning',{method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':config?.token??''},body:JSON.stringify({kind,input,...(draft.managerRouteId?{managerRouteId:draft.managerRouteId}:{})}),signal:controller.signal}); result=await response.json(); if(!response.ok)throw new Error(result.error??'Помилка планування'); }
      if (generation!==version || draft!==ownDraft || !dialog.open) return;
      if(kind==='idea'){validateIdea(result.value);draft.idea=result.value;draft.plan=null;draft.routing=null;}
      if(kind==='plan'){validatePlan(result.value);draft.plan=result.value;draft.routing=null;}
      if(kind==='team'){validateAssignments(result.value,draft.plan,result.proposal?proposalTeam(result.proposal,draft.plan).profiles:agents());draft.routing=result.value;draft.proposal=result.proposal??null;}
      draft[`${kind}Source`]=result.provenance;
    } catch(error){ if(error.name!=='AbortError'&&dialog.open&&generation===version)draft.error=error.message; }
    finally { if(generation===version&&dialog.open){busy=false;show();if(draft.error)notify(draft.error);} }
  }
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-creation]'); if(!el||busy)return;
    const action=el.dataset.creation;
    if(action==='back'){capture();if(step===1)dialog.close();else show(step===3&&draft.mode==='ready'?1:step-1);}
    if(action.startsWith('generate-')) generate(action.slice(9));
    if(action.startsWith('demo-')) generate(action.slice(5),true);
  });
  document.addEventListener('submit',async event=>{
    if(event.target.id!=='creation-project')return; event.preventDefault(); if(busy)return;
    const submittedDraft=draft;
    try {
      capture();
      if(step===1){if(!draft.name||!draft.description)throw new Error('Опишіть назву та задум проєкту');draft.idea=null;draft.plan=null;draft.routing=null;show(draft.mode==='ready'?3:2);}
      else if(step===2){validateIdea(draft.idea);draft.plan=null;draft.routing=null;show(3);}
      else if(step===3){validatePlan(draft.plan);draft.routing=null;draft.proposal=null;show(4);generate('team',draft.planSource?.mode==='demo');}
      else {if(draft.teamSource?.mode==='ai')proposalTeam(draft.proposal,draft.plan);else validateAssignments(draft.routing,draft.plan,agents());const version=++generation;busy=true;draft.error=null;show();await onCreate(structuredClone(draft));if(draft===submittedDraft&&generation===version&&dialog.open)dialog.close();}
    }catch(error){if(draft!==submittedDraft)return;busy=false;draft.error=error.message;show();notify(error.message);}
  });
  return {open(){generation++;draft={name:'',description:'',mode:'idea',priority:'quality',managerRouteId:'',freeWorkers:false,maxAgentsPerTask:1,requirements:{},feedback:'',idea:null,plan:null,routing:null,proposal:null};config=null;busy=false;show(1);const openedDraft=draft;fetch('/api/planning/status').then(r=>r.ok?r.json():null).then(value=>{if(draft===openedDraft&&dialog.open){config=value;if(!busy){capture();show();}}}).catch(()=>{});}};
}
