import { demoIdea, demoPlan, demoAssignments, validateIdea, validatePlan, validateAssignments } from './planning.js';
import {plannerChoices,draftRoutingInput,proposalTeam} from './project-composition.js';
import {formatBillingBadge,renderWorkerModelOptions} from './routing-ui.js';
import {planningErrorMessage} from './planning-errors.js';
import {saveProjectDraft,restoreProjectDraft,clearProjectDraft} from './project-draft.js';
import {answeredInterview,basicInterview,interviewTopics,needsInterview,validateInterview} from './project-interview.js';

export function deriveProjectName(description) {
  const clean = String(description ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return 'Новий проєкт';
  const sentence = clean.split(/[.!?\n]/)[0].trim();
  const stripped = sentence.replace(/^(?:створи(?:ти)?|зроби(?:ти)?|побудуй(?:те)?|розроби(?:ти)?|потрібен|хочу)\s+/i, '').trim() || sentence;
  return (stripped.length > 60 ? stripped.slice(0, 57).trim() + '…' : stripped).slice(0, 80);
}

export function createProjectWizard({ modal, h, icon, button, agents, onCreate, notify, getCatalog, scanConnections, proposeDraft, listFolders }) {
  let draft, config, step = 1, busy = false, busyKind, busyStatus = '', controller, generation = 0, completed = false;
  let folderPicker, folderRequest=0;
  const draftStorage={getItem:key=>sessionStorage.getItem(key),setItem:(key,value)=>sessionStorage.setItem(key,value),removeItem:key=>sessionStorage.removeItem(key)};
  const dialog = document.querySelector('#modal');
  dialog.addEventListener('close', () => {if(!dialog.querySelector('#creation-project'))return;if(!completed){if(!busy)capture();if(draft)saveProjectDraft(draftStorage,draft);} generation++; folderRequest++; folderPicker=null; controller?.abort(); busy = false; busyStatus = ''; });
  const list = values => `<ul>${values.map(v => `<li>${h(v)}</li>`).join('')}</ul>`;
  const managerCatalog=()=>({routes:config?.managerRoutes??getCatalog?.()?.routes??[]});
  const selectedPlanner=()=>draft.managerRouteId?managerCatalog().routes.find(r=>r.id===draft.managerRouteId):null;
  const canPlan=()=>Boolean(config?.token&&(draft.managerRouteId?selectedPlanner():config.configured));
  const note = () => {const selected=selectedPlanner(),used=draft[`${step===2?'idea':step===3?'plan':'team'}Source`]??(step===4?draft.planSource:null);return `<div class="planner-status">${icon('spark')}<span><strong>${draft.managerRouteId?'Обраний AI-керівник':used?.mode==='ai'?'AI підібрав керівника':'Автопідбір за проєктом'}</strong><small>${h(draft.managerRouteId?(selected?`${selected.name??selected.model} · ${selected.backend}`:'Обраний керівник недоступний'):used?.mode==='ai'?`${used.model} · ${used.provider}`:config?.configured?'Модель буде обрана за описом і вимогами цього етапу':config?.blockedReason??'Перевіряємо доступні моделі…')}</small></span><span class="provider-pill">${canPlan()?'AI':'Перевірка доступу'}</span></div>`;};
  function capture() {
    const form = dialog.querySelector('form'); if (!form) return;
    const data = new FormData(form);
    if (step === 1) {
      draft.name = String(data.get('name') ?? '').trim();
      draft.projectParent = String(data.get('projectParent') ?? '').trim();
      draft.description = String(data.get('description') ?? '').trim();
      draft.mode = data.get('mode') ?? 'auto';
      draft.priority = data.get('priority') ?? 'balanced';
      draft.managerRouteId = String(data.get('managerRouteId') ?? '');
      draft.freeWorkers = data.has('freeWorkers');
      draft.workerRouteIds = data.getAll('workerRouteId');
      draft.maxAgentsPerTask = Number(data.get('maxAgentsPerTask') ?? 1);
    }
    if (step === 2) {
      if (draft.idea && data.has('summary')) draft.idea.summary = String(data.get('summary')).trim();
      if (data.has('feedback')) draft.feedback = String(data.get('feedback')).trim();
      for(const item of draft.interview??[]){
        const field=`answer-${item.topic}`;
        if(data.has(field))item.answer=String(data.get(field));
      }
    }
    if (step === 3 && draft.plan) {
      draft.plan.summary = String(data.get('summary') ?? draft.plan.summary).trim();
      draft.plan.tasks.forEach(t => { t.title = String(data.get(`title-${t.id}`) ?? t.title).trim(); t.prompt = String(data.get(`prompt-${t.id}`) ?? t.prompt).trim(); t.acceptanceCriteria = String(data.get(`criteria-${t.id}`) ?? t.acceptanceCriteria.join('\n')).split('\n').map(s=>s.trim()).filter(Boolean); });
      draft.requirements=Object.fromEntries(draft.plan.tasks.map(t=>[t.id,data.get(`access-${t.id}`)==='text'?'text':'write']));
    }
  }
  function generateButtons(kind, label) {
    return `<div class="generation-actions">${button('',label,'spark','btn primary',`data-creation="generate-${kind}" ${!canPlan() || busy ? 'disabled' : ''}`)}${button('','Показати демо-приклад','','btn',`data-creation="demo-${kind}" ${busy ? 'disabled' : ''}`)}</div><p class="muted text-small">${canPlan()?'Керівник опрацює запит.':'Для AI потрібен доступний керівник. Перевірте «Підключення» або явно оберіть демо-приклад.'}</p>`;
  }
  function source(kind) { const meta=draft[`${kind}Source`]; if(!meta)return ''; const mode=meta.mode==='ai'?'ai':'demo'; return `<div class="source-label ${mode}">${icon(mode === 'ai' ? 'spark' : 'file')}${meta.method==='rules'?'Правила каталогу · без виклику керівника':mode === 'ai' ? `Створено AI · ${h(meta.model)}` : 'Демо-приклад · без модельного запиту'}</div>${meta.selection?.reason?`<p class="planner-selection-reason"><strong>Чому ця модель:</strong> ${h(meta.selection.reason)}</p>`:''}`; }
  function refreshStep1PlannerControls() {
    const select = dialog.querySelector('select[name="managerRouteId"]');
    const statusBox = dialog.querySelector('[data-autopilot-status]');
    if (select) {
      const current = select.value || draft.managerRouteId;
      const choices = plannerChoices(managerCatalog());
      select.innerHTML = `<option value="">Автоматично за описом проєкту</option>${current&&!choices.some(r=>r.id===current)?`<option value="${h(current)}" selected>${h(selectedPlanner()?.name??current)} · доступ буде перевірено</option>`:''}${choices.map(r=>`<option value="${h(r.id)}" ${current===r.id?'selected':''}>${h(r.name??r.model)} · ${h(r.backend)}</option>`).join('')}`;
      select.value = current;
    }
    if (statusBox) {
      statusBox.textContent = canPlan()
        ? 'AI-керівник готовий допомогти з ідеєю та планом.'
        : (config?.blockedReason ?? 'Перевіряємо доступні моделі…');
    }
    const models=dialog.querySelector('[data-creation-worker-options]');
    if(models)models.innerHTML=renderWorkerModelOptions(getCatalog?.()?.routes??[],draft.workerRouteIds??[],h);
  }
  function interviewBody(){
    if(!draft.interview)return `${note()}<h3>Уточнимо ідею</h3><p class="creation-description">AI підготує запитання саме для цього проєкту.</p>
      <div class="generation-actions">${button('','Підготувати запитання','spark','btn primary','data-creation="generate-questions"')}${button('','Відкрити базові питання','','btn','data-creation="basic-questions"')}</div>`;
    return `${note()}<h3>Уточнимо ідею</h3>${source('interview')}
      ${draft.interview.length?`<p id="interview-hint" class="creation-description">Відповідай на те, що вже знаєш. Решту AI запропонує як припущення в концепції.</p>
      <div class="interview-questions">${draft.interview.map(({topic,question,answer})=>`<label><span class="interview-topic">${h(interviewTopics[topic])}</span><span>${h(question)}</span><textarea name="answer-${h(topic)}" rows="2" maxlength="1200" aria-describedby="interview-hint">${h(answer)}</textarea></label>`).join('')}</div>`:
      '<p class="creation-description">Опис уже містить потрібні деталі. Можна перейти до концепції.</p>'}
      ${!canPlan()?button('','Показати демо-концепцію','','btn','data-creation="demo-idea"'):''}`;
  }
  function body() {
    if (step === 1) return `<h3>Створення проєкту</h3>
      <div class="info-note">${icon('spark')}<span data-autopilot-status>${h(canPlan()?'AI-керівник готовий допомогти з ідеєю та планом.':config?.blockedReason??'Перевіряємо доступні моделі…')}</span></div>
      <div class="creation-modes">
        <label><input type="radio" name="mode" value="auto" ${draft.mode==='auto'?'checked':''}><span><strong>Автопілот</strong><small>Для короткого задуму AI спершу поставить запитання. Готовий опис одразу переходить у планування й запуск.</small></span></label>
        <label><input type="radio" name="mode" value="ready" ${draft.mode==='ready'?'checked':''}><span><strong>Переглянути план перед запуском</strong><small>Створити план і команду з можливістю редагувати задачі вручну.</small></span></label>
        <label><input type="radio" name="mode" value="idea" ${draft.mode==='idea'?'checked':''}><span><strong>Опрацювати ідею з AI</strong><small>Відповісти на запитання, прийняти концепцію, переглянути план і команду.</small></span></label>
      </div>
      <label>Що потрібно створити<textarea name="description" required maxlength="12000" placeholder="Наприклад, онлайн-книгарню для батьків і дітей. Або вставте готовий опис проєкту.">${h(draft.description)}</textarea></label>
      <label>Назва проєкту <small class="muted">(необов’язково — заповниться автоматично)</small><input name="name" maxlength="80" value="${h(draft.name)}" placeholder="Наприклад, Інтернет-магазин смартфонів"></label>
      <div class="project-folder-field"><label>Де створити проєкт<input name="projectParent" maxlength="1024" value="${h(draft.projectParent??'')}" placeholder="Стандартна папка оркестратора"></label><button type="button" class="btn" data-creation="browse-folders">Вибрати папку</button></div>
      ${folderPicker?folderPickerMarkup():''}
      <details class="worker-model-picker" ${draft.workerRouteIds?.length?'open':''}><summary>Моделі виконавців</summary>
        <div data-creation-worker-options>${renderWorkerModelOptions(getCatalog?.()?.routes??[],draft.workerRouteIds??[],h)}</div>
        ${button('','Оновити каталог','pulse','btn small-btn','data-creation="refresh-worker-models"')}
      </details>
      <details><summary>Додаткові налаштування моделей і команди</summary>
        <label>Пріоритет підбору моделей<select name="priority">${[['quality','Якість і продуманість'],['balanced','Баланс якості та часу'],['economy','Економія токенів за дотримання вимог']].map(([v,label])=>`<option value="${v}" ${draft.priority===v?'selected':''}>${label}</option>`).join('')}</select></label>
        <label>AI-керівник<select name="managerRouteId"><option value="">Автоматично за описом проєкту</option>${draft.managerRouteId&&!plannerChoices(managerCatalog()).some(r=>r.id===draft.managerRouteId)?`<option value="${h(draft.managerRouteId)}" selected>${h(selectedPlanner()?.name??draft.managerRouteId)} · доступ буде перевірено</option>`:''}${plannerChoices(managerCatalog()).map(r=>`<option value="${h(r.id)}" ${draft.managerRouteId===r.id?'selected':''}>${h(r.name??r.model)} · ${h(r.backend)}</option>`).join('')}</select></label>
        <label>Максимум моделей на задачу<select name="maxAgentsPerTask">${[1,2,3,4,5,6].map(n=>`<option value="${n}" ${draft.maxAgentsPerTask===n?'selected':''}>${n}</option>`).join('')}</select></label>
        <label class="checkline"><input type="checkbox" name="freeWorkers" ${draft.freeWorkers?'checked':''}>Тільки безкоштовні виконавці</label>
        <p class="muted text-small">За замовчуванням доступні підтверджені безкоштовні моделі та включені квоти наявних підписок. Платні API-списання заблоковані.</p>
      </details>`;
    if (step === 2) {
      if(!draft.idea)return interviewBody();
      return `${note()}<h3>Концепція проєкту</h3>${source('idea')}
        <label>Концепція — можна відредагувати<textarea name="summary" required maxlength="12000">${h(draft.idea.summary)}</textarea></label>
        <div class="brief-columns"><div><h4>Ключові можливості</h4>${list(draft.idea.features)}</div>${draft.idea.questions.length?`<div><h4>Додаткові уточнення</h4>${list(draft.idea.questions)}</div>`:''}</div>
        ${draft.idea.risks.length?`<h4>Ризики</h4>${list(draft.idea.risks)}`:''}
        <label>Додаткові вимоги<textarea name="feedback" maxlength="6000">${h(draft.feedback)}</textarea></label>
        ${generateButtons('idea','Оновити концепцію')}${draft.interview?button('','Змінити відповіді','','btn','data-creation="edit-answers"'):''}`;
    }
    if (step === 3) return `${note()}<h3>Детальний план проєкту</h3><p class="creation-description">План визначає компактний набір інженерних задач, залежності та перевірювані критерії якості.</p>${generateButtons('plan',draft.plan?'Перепланувати з AI':'Створити план з AI')}${draft.plan ? `${source('plan')}<label>Підхід і межі<textarea name="summary" required>${h(draft.plan.summary)}</textarea></label><div class="brief-columns"><div><h4>Припущення</h4>${list(draft.plan.assumptions)}</div><div><h4>Ризики</h4>${list(draft.plan.risks)}</div></div><div class="planned-tasks">${draft.plan.tasks.map((t,i)=>`<details ${i===0?'open':''}><summary><span>${String(i+1).padStart(2,'0')}</span>${h(t.title)}<small>${t.dependsOn.length?'Після: '+h(t.dependsOn.join(', ')):'Незалежна задача'}</small></summary><label>Назва<input name="title-${h(t.id)}" value="${h(t.title)}" required></label><label>Інструкція<textarea name="prompt-${h(t.id)}" required>${h(t.prompt)}</textarea></label><label>Критерії готовності — по одному на рядок<textarea name="criteria-${h(t.id)}" required>${h(t.acceptanceCriteria.join('\n'))}</textarea></label><div class="skills">${t.skills.map(s=>`<span>${h(s)}</span>`).join('')}</div></details>`).join('')}</div>` : '<div class="creation-empty">Задачі з’являться після планування. Команда буде підібрана за цим планом.</div>'}`;
    const exact=draft.teamSource?.mode==='ai'&&draft.proposal;
    return `${note()}<h3>Команда для прийнятого плану</h3><p class="creation-description">Керівник обирає точні моделі для кожної задачі з доступних безкоштовних маршрутів і підтверджених підписок.</p>${generateButtons('team','Повторити підбір команди')}${draft.routing?`${source('team')}<div class="routing-cards">${draft.routing.assignments.map(a=>{const task=draft.plan.tasks.find(t=>t.id===a.taskId);return `<article><h4>${h(task.title)}</h4><div class="recommended-agents">${exact?draft.proposal.assignments.find(v=>v.taskId===a.taskId).routeIds.map(id=>{const route=draft.proposal.routes.find(r=>r.id===id),bill=formatBillingBadge(route.billing,route.billingBoundary);return `<span><b>${h(route.model)}</b><small>${h(route.backend)} · ${h(bill.label)}</small></span>`;}).join(''):a.agentIds.map(id=>`<span><b>${h(agents().find(v=>v.id===id)?.name??id)}</b><small>Демо-профіль</small></span>`).join('')}</div><p>${h(a.reason)}</p><small class="muted">${draft.requirements?.[a.taskId]==='text'?'Аналіз без зміни файлів':'Робота з файлами'}</small></article>`;}).join('')}</div><div class="info-note">${icon('shield')}${exact?'Проєкт буде збережено разом із цим призначенням. Перед збереженням і запуском доступ перевіряється повторно.':'Демо показує рольові профілі. Реальні моделі для цього прикладу ще не призначені.'}</div>`:'<div class="creation-empty">Тут з’являться моделі та пояснення вибору для кожної задачі.</div>'}`;
  }
  const initialSubmitLabel=()=>needsInterview(draft)?'Уточнити ідею':draft.mode==='auto'?'Створити та запустити автоматично':'Продовжити';
  function show(next=step) {
    const stepChanged=next!==step;
    step=next;
    saveProjectDraft(draftStorage,draft);
    const names=['Задум','Ідея й вимоги','План','Команда'];
    const disabled=busy || (step===2&&!draft.idea&&!draft.interview) || (step===3&&!draft.plan) || (step===4&&!draft.routing);
    const access=step===3&&draft.plan?`<details><summary>Доступ виконавців до файлів</summary><p class="muted text-small">Для дослідження або перевірки можна обрати аналіз без зміни файлів.</p>${draft.plan.tasks.map(t=>`<label>${h(t.title)}<select name="access-${h(t.id)}"><option value="write" ${draft.requirements?.[t.id]!=='text'?'selected':''}>Робота з файлами</option><option value="text" ${draft.requirements?.[t.id]==='text'?'selected':''}>Аналіз без зміни файлів</option></select></label>`).join('')}</details>`:'';
    const submitLabel = step === 1
      ? initialSubmitLabel()
      : step===2?(draft.idea?draft.mode==='auto'&&draft.ideaSource?.mode!=='demo'?'Прийняти й запустити автопілот':'Прийняти концепцію':'Сформувати концепцію')
      : step===3?'Прийняти план і підібрати команду':'Створити та запустити';
    const busyText = busyStatus || (busyKind==='create'?'Зберігаємо проєкт і запускаємо команду…':`${busyKind==='plan'?'Керівник складає детальний план':'Керівник опрацьовує запит'}. Очікуємо завершення моделі без фіксованого ліміту часу. Можна зупинити очікування; попередні дані залишаться в майстрі.`);
    modal('Новий проєкт',`<div class="creation-flow">
      <div class="wizard-steps" aria-label="Етапи створення">${names.map((n,i)=>`<span ${step===i+1?'aria-current="step"':''} class="${step===i+1?'current':step>i+1?'finished':''} ${i===1&&!needsInterview(draft)?'skipped':''}">${i+1}<b>${n}</b></span>${i<3?'<i></i>':''}`).join('')}</div>
      <form id="creation-project" data-step="${step}" aria-busy="${busy}">
      ${busy?`<div class="planning-busy" role="status">${h(busyText)}</div>${busyKind!=='create'?button('','Зупинити очікування','','btn','data-creation="cancel-generation"'):''}`:''}
      ${draft.error?`<p class="execution-error" role="alert">${h(draft.error)}</p>`:''}
      <fieldset class="creation-fields" ${busy?'disabled':''}>${body()}${access}</fieldset>
      <div class="form-footer">${button('',step===1?'Скасувати':'Назад','','btn',`data-creation="back" ${busy?'disabled':''}`)}<button type="submit" class="btn primary" ${disabled?'disabled':''}>${submitLabel} ${icon('arrow')}</button></div>
      </form></div>`);
    dialog.scrollTop=0;
    if(stepChanged){
      const heading=dialog.querySelector('.creation-fields > h3');
      heading?.setAttribute('tabindex','-1');
      heading?.focus({preventScroll:true});
    }
  }
  async function requestPlanning(kind, signal) {
    if (kind==='team') {
      const proposal=await proposeDraft(draftRoutingInput(draft),signal);
      return {value:proposalTeam(proposal,draft.plan).routing,provenance:proposal.provenance,proposal};
    }
    const interview=answeredInterview(draft.interview);
    const input={name:draft.name,description:draft.description,priority:draft.priority,idea:draft.idea,feedback:draft.feedback,plan:draft.plan,...(interview.length?{interview}:{})};
    const interviewRoute=draft.interviewSource?.routeId;
    const route=draft.managerRouteId||(kind==='idea'&&plannerChoices(managerCatalog()).some(row=>row.id===interviewRoute)?interviewRoute:'');
    const response=await fetch('/api/planning',{method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':config?.token??''},body:JSON.stringify({kind,input,...(route?{managerRouteId:route}:{})}),signal});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error??'Помилка планування');
    return result;
  }
  async function ensurePlanningConfig(signal) {
    if (!config?.token || !canPlan()) {
      let res = await fetch('/api/planning/status', { signal });
      if (res.ok) config = await res.json();
      if (!canPlan() && scanConnections) {
        busyStatus = 'Перевіряємо доступні підключення та моделі…'; show();
        await scanConnections();
        res = await fetch('/api/planning/status', { signal });
        if (res.ok) config = await res.json();
      }
    }
    if (!canPlan()) throw new Error(config?.blockedReason ?? 'Немає доступного AI-керівника. Перевірте розділ «Підключення».');
  }
  async function runAutopilot() {
    const ownDraft = draft, version = ++generation;
    controller?.abort(); controller = new AbortController();
    busy = true; busyKind = 'autopilot'; draft.error = null;
    try {
      await ensurePlanningConfig(controller.signal);
      if (generation !== version || draft !== ownDraft || !dialog.open) return;
      busyStatus = 'Етап 1/3 · AI складає продуктовий план проєкту…'; show(3);
      const planRes = await requestPlanning('plan', controller.signal);
      if (generation !== version || draft !== ownDraft || !dialog.open) return;
      validatePlan(planRes.value);
      draft.plan = planRes.value; draft.planSource = planRes.provenance;
      draft.requirements = Object.fromEntries(draft.plan.tasks.map(t => [t.id, 'write']));

      busyStatus = 'Етап 2/3 · AI підбирає моделі під задачі…'; show(4);
      const teamRes = await requestPlanning('team', controller.signal);
      if (generation !== version || draft !== ownDraft || !dialog.open) return;
      validateAssignments(teamRes.value, draft.plan, proposalTeam(teamRes.proposal, draft.plan).profiles);
      draft.routing = teamRes.value; draft.proposal = teamRes.proposal; draft.teamSource = teamRes.provenance;

      busyKind = 'create';
      busyStatus = 'Етап 3/3 · Зберігаємо проєкт і запускаємо AI-команду…'; show(4);
      await onCreate(structuredClone(draft), { autoStart: true });
      completed = true;
      clearProjectDraft(draftStorage);
      if (draft === ownDraft && generation === version && dialog.open) dialog.close();
    } catch (error) {
      if (error.name !== 'AbortError' && dialog.open && generation === version) {
        draft.error = planningErrorMessage(error, busyKind === 'autopilot' ? (step === 2 ? 'idea' : step === 3 ? 'plan' : 'team') : undefined);
      }
    } finally {
      if (generation === version && dialog.open && !completed) { busy = false; busyStatus = ''; show(); }
    }
  }
  async function generate(kind, demo=false) {
    capture(); const ownDraft=draft, version=++generation; controller?.abort(); controller=new AbortController(); busy=true;busyKind=kind;busyStatus=''; draft.error=null; show();
    try {
      const input={name:draft.name,description:draft.description};
      let result;
      if (demo) result={value:kind==='idea'?demoIdea(input):kind==='plan'?demoPlan(input):demoAssignments(draft.plan,agents()),provenance:{mode:'demo',at:new Date().toISOString()}};
      else {
        if(kind==='questions'||kind==='idea')await ensurePlanningConfig(controller.signal);
        if(generation!==version || draft!==ownDraft || !dialog.open)return;
        result = await requestPlanning(kind, controller.signal);
      }
      if (generation!==version || draft!==ownDraft || !dialog.open) return;
      if(kind==='questions'){
        draft.interview=validateInterview(result.value?.questions);
        draft.interviewSource=result.provenance;
      }
      if(kind==='idea'){validateIdea(result.value);draft.idea=result.value;draft.plan=null;draft.routing=null;draft.proposal=null;delete draft.planSource;delete draft.teamSource;}
      if(kind==='plan'){validatePlan(result.value);draft.plan=result.value;draft.routing=null;draft.proposal=null;delete draft.teamSource;}
      if(kind==='team'){validateAssignments(result.value,draft.plan,result.proposal?proposalTeam(result.proposal,draft.plan).profiles:agents());draft.routing=result.value;draft.proposal=result.proposal??null;}
      if(kind!=='questions')draft[`${kind}Source`]=result.provenance;
    } catch(error){ if(error.name!=='AbortError'&&dialog.open&&generation===version){
      draft.error=planningErrorMessage(error,kind);
      if(kind==='questions'&&!draft.interview)draft.interview=basicInterview();
    } }
    finally { if(generation===version&&dialog.open){busy=false;busyStatus='';show();} }
  }
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-creation]'); if(!el)return;
    const action=el.dataset.creation;
    if(action==='cancel-generation'&&busy&&busyKind!=='create'){controller?.abort();return;}
    if(busy)return;
    if(action==='refresh-worker-models'){
      el.disabled=true;
      const currentDraft=draft;
      void Promise.resolve(scanConnections?.()).then(async()=>{
        const refreshed=await fetch('/api/planning/status');
        if(!dialog.open||draft!==currentDraft||step!==1||busy)return;
        if(refreshed.ok)config=await refreshed.json();
        if(!dialog.open||draft!==currentDraft||step!==1||busy)return;
        capture();refreshStep1PlannerControls();
      }).catch(error=>notify(error.message)).finally(()=>{el.disabled=false;});
      return;
    }
    if(action==='browse-folders'||action==='open-folder'){void browseFolders(action==='open-folder'?el.dataset.path:undefined);return;}
    if(action==='close-folders'||action==='use-folder'){
      capture();
      if(action==='use-folder')draft.projectParent=folderPicker?.path??'';
      folderRequest++;folderPicker=null;saveProjectDraft(draftStorage,draft);show();return;
    }
    if(action==='back'){capture();if(step===1)dialog.close();else show(step===3&&!needsInterview(draft)?1:step-1);}
    if(action==='basic-questions'){draft.interview=basicInterview();draft.error=null;show();}
    if(action==='edit-answers'){capture();draft.idea=null;draft.plan=null;draft.routing=null;draft.proposal=null;delete draft.ideaSource;delete draft.planSource;delete draft.teamSource;show();}
    if(action.startsWith('generate-')) generate(action.slice(9));
    if(action.startsWith('demo-')) generate(action.slice(5),true);
  });
  function folderPickerMarkup(){
    if(folderPicker.loading)return '<div class="folder-picker" role="status">Завантажую папки…</div>';
    const control=(name,path)=>`<button type="button" class="btn" data-creation="open-folder" data-path="${h(path??'')}">${h(name)}</button>`;
    return `<div class="folder-picker"><div class="folder-picker-actions">${control('Диски','')}${folderPicker.parent?control('На рівень вище',folderPicker.parent):''}
      <button type="button" class="btn" data-creation="close-folders">Закрити</button></div>
      ${folderPicker.path?`<p class="workspace-path">${h(folderPicker.path)}</p>`:''}
      ${folderPicker.error?`<p role="alert">${h(folderPicker.error)}</p>`:''}
      <div class="folder-picker-list">${(folderPicker.folders??[]).map(entry=>control(entry.name,entry.path)).join('')||'<p>Доступних вкладених папок немає.</p>'}</div>
      ${folderPicker.path?`<button type="button" class="btn primary" data-creation="use-folder">Вибрати цю папку</button>`:''}</div>`;
  }
  async function browseFolders(path){
    capture();
    const version=generation, request=++folderRequest;
    folderPicker={loading:true};show();
    let result;
    try{result=await listFolders(path??draft.projectParent);}
    catch(error){result={error:error.message};}
    if(generation===version&&folderRequest===request&&dialog.open&&step===1){capture();folderPicker=result;show();}
  }
  document.addEventListener('submit',async event=>{
    if(event.target.id!=='creation-project')return; event.preventDefault(); if(busy)return;
    const submittedDraft=draft;
    try {
      capture();
      if(step===1){
        if(!draft.description)throw new Error('Опишіть, який проєкт потрібно створити');
        if(!draft.name)draft.name=deriveProjectName(draft.description);
        const interview=needsInterview(draft);
        if(!interview||draft.interviewDescription!==draft.description){delete draft.interview;delete draft.interviewSource;draft.feedback='';}
        draft.idea=null;draft.plan=null;draft.routing=null;draft.proposal=null;
        delete draft.ideaSource;delete draft.planSource;delete draft.teamSource;
        if(interview){draft.interviewDescription=draft.description;show(2);if(!draft.interview)void generate('questions');return;}
        if(draft.mode==='auto'){void runAutopilot();return;}
        show(3);
        if(canPlan())void generate('plan');
      }
      else if(step===2){
        if(!draft.idea){validateInterview(draft.interview,{answers:true});void generate('idea');return;}
        validateIdea(draft.idea);draft.plan=null;draft.routing=null;draft.proposal=null;delete draft.planSource;delete draft.teamSource;
        if(draft.mode==='auto'&&draft.ideaSource?.mode==='ai'){void runAutopilot();return;}
        show(3);if(canPlan())void generate('plan');
      }
      else if(step===3){validatePlan(draft.plan);draft.routing=null;draft.proposal=null;delete draft.teamSource;show(4);generate('team',draft.planSource?.mode==='demo');}
      else {
        if(draft.teamSource?.mode==='ai')proposalTeam(draft.proposal,draft.plan);else validateAssignments(draft.routing,draft.plan,agents());
        const version=++generation;busy=true;busyKind='create';busyStatus='';draft.error=null;show();
        await onCreate(structuredClone(draft), { autoStart: draft.teamSource?.mode === 'ai' });
        completed=true;clearProjectDraft(draftStorage);
        if(draft===submittedDraft&&generation===version&&dialog.open)dialog.close();
      }
    }catch(error){if(draft!==submittedDraft)return;busy=false;busyStatus='';draft.error=planningErrorMessage(error);show();}
  });
  const saveInput=event=>{
    if(!busy&&event.target.closest?.('#creation-project')){
      capture();
      saveProjectDraft(draftStorage,draft);
      if(step===1&&['mode','description'].includes(event.target.name)){
        const btn=dialog.querySelector('#creation-project button[type="submit"]');
        if(btn)btn.innerHTML=`${initialSubmitLabel()} ${icon('arrow')}`;
      }
    }
  };
  document.addEventListener('input',saveInput);document.addEventListener('change',saveInput);
  return {open(){
    generation++;completed=false;
    const restored=restoreProjectDraft(draftStorage);
    draft=restored?.draft??{name:'',description:'',mode:'auto',priority:'balanced',managerRouteId:'',freeWorkers:false,maxAgentsPerTask:1,requirements:{},feedback:'',idea:null,plan:null,routing:null,proposal:null};
    config=null;busy=false;busyStatus='';show(restored?.step??1);
    const openedDraft=draft;
    fetch('/api/planning/status').then(response=>response.ok?response.json():null).then(value=>{
      if(draft!==openedDraft||!dialog.open)return;
      config=value;
      if(busy)return;
      if(step===1){refreshStep1PlannerControls();return;}
      const field=document.activeElement;
      const editing=field?.matches('#creation-project textarea');
      const scroll=dialog.scrollTop;
      capture();show();
      if(editing){
        const replacement=dialog.querySelector('#creation-project').elements.namedItem(field.name);
        replacement?.focus({preventScroll:true});
        replacement?.setSelectionRange(field.selectionStart,field.selectionEnd);
        dialog.scrollTop=scroll;
      }
    }).catch(()=>{});
  }};
}
