import { demoIdea, demoPlan, demoAssignments, validateIdea, validatePlan, validateAssignments } from './planning.js';
import {plannerChoices,draftRoutingInput,proposalTeam} from './project-composition.js';
import {formatBillingBadge} from './routing-ui.js';
import {planningErrorMessage} from './planning-errors.js';
import {saveProjectDraft,restoreProjectDraft,clearProjectDraft} from './project-draft.js';

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
      draft.priority = data.get('priority') ?? 'quality';
      draft.managerRouteId = String(data.get('managerRouteId') ?? '');
      draft.freeWorkers = data.has('freeWorkers');
      draft.maxAgentsPerTask = Number(data.get('maxAgentsPerTask') ?? 1);
    }
    if (step === 2) { if (draft.idea && data.has('summary')) draft.idea.summary = String(data.get('summary')).trim(); draft.feedback = String(data.get('feedback') ?? '').trim(); }
    if (step === 3 && draft.plan) {
      draft.plan.summary = String(data.get('summary') ?? draft.plan.summary).trim();
      draft.plan.tasks.forEach(t => { t.title = String(data.get(`title-${t.id}`) ?? t.title).trim(); t.prompt = String(data.get(`prompt-${t.id}`) ?? t.prompt).trim(); t.acceptanceCriteria = String(data.get(`criteria-${t.id}`) ?? t.acceptanceCriteria.join('\n')).split('\n').map(s=>s.trim()).filter(Boolean); });
      draft.requirements=Object.fromEntries(draft.plan.tasks.map(t=>[t.id,data.get(`access-${t.id}`)==='text'?'text':'write']));
    }
  }
  function generateButtons(kind, label) {
    return `<div class="generation-actions">${button('',label,'spark','btn primary',`data-creation="generate-${kind}" ${!canPlan() || busy ? 'disabled' : ''}`)}${button('','Показати демо-приклад','','btn',`data-creation="demo-${kind}" ${busy ? 'disabled' : ''}`)}</div><p class="muted text-small">${canPlan()?'Керівник опрацює запит.':'Для AI потрібен доступний керівник. Перевірте «Підключення» або явно оберіть демо-приклад.'}</p>`;
  }
  function source(kind) { const meta=draft[`${kind}Source`]; if(!meta)return ''; const mode=meta.mode==='ai'?'ai':'demo'; return `<div class="source-label ${mode}">${icon(mode === 'ai' ? 'spark' : 'file')}${mode === 'ai' ? `Створено AI · ${h(meta.model)}` : 'Демо-приклад · без модельного запиту'}</div>${meta.selection?.reason?`<p class="planner-selection-reason"><strong>Чому ця модель:</strong> ${h(meta.selection.reason)}</p>`:''}`; }
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
        ? 'AI-керівник готовий: у режимі автопілоту проєкт буде сплановано, укомплектовано моделями та запущено автоматично.'
        : (config?.blockedReason ?? 'Перевіряємо доступні моделі…');
    }
  }
  function body() {
    if (step === 1) return `<h3>Створення проєкту</h3>
      <div class="info-note">${icon('spark')}<span data-autopilot-status>${h(canPlan()?'AI-керівник готовий: у режимі автопілоту проєкт буде сплановано, укомплектовано моделями та запущено автоматично.':config?.blockedReason??'Перевіряємо доступні моделі…')}</span></div>
      <div class="creation-modes">
        <label><input type="radio" name="mode" value="auto" ${draft.mode==='auto'?'checked':''}><span><strong>Автопілот — без зайвих кроків</strong><small>Опишіть ідею: система сама складе сильний план, підбере моделі й одразу запустить виконання.</small></span></label>
        <label><input type="radio" name="mode" value="ready" ${draft.mode==='ready'?'checked':''}><span><strong>Переглянути план перед запуском</strong><small>Створити план і команду з можливістю редагувати задачі вручну.</small></span></label>
        <label><input type="radio" name="mode" value="idea" ${draft.mode==='idea'?'checked':''}><span><strong>Покроково з опрацюванням ідеї</strong><small>Спершу уточнити концепцію, потім план і команду.</small></span></label>
      </div>
      <label>Що потрібно створити<textarea name="description" required maxlength="12000" placeholder="Опишіть продукт, ключові функції, дизайн і очікуваний результат. Наприклад: сучасний інтернет-магазин смартфонів із каталогом 12+ моделей, фотографіями, фільтрами, порівнянням, кошиком та оформленням замовлення.">${h(draft.description)}</textarea></label>
      <label>Назва проєкту <small class="muted">(необов’язково — заповниться автоматично)</small><input name="name" maxlength="80" value="${h(draft.name)}" placeholder="Наприклад, Інтернет-магазин смартфонів"></label>
      <div class="project-folder-field"><label>Де створити проєкт<input name="projectParent" maxlength="1024" value="${h(draft.projectParent??'')}" placeholder="Стандартна папка оркестратора"></label><button type="button" class="btn" data-creation="browse-folders">Вибрати папку</button></div>
      ${folderPicker?folderPickerMarkup():''}
      <details><summary>Додаткові налаштування моделей і команди</summary>
        <label>Пріоритет підбору моделей<select name="priority">${[['quality','Якість і продуманість'],['balanced','Баланс якості та часу'],['economy','Економія токенів за дотримання вимог']].map(([v,label])=>`<option value="${v}" ${draft.priority===v?'selected':''}>${label}</option>`).join('')}</select></label>
        <label>AI-керівник<select name="managerRouteId"><option value="">Автоматично за описом проєкту</option>${draft.managerRouteId&&!plannerChoices(managerCatalog()).some(r=>r.id===draft.managerRouteId)?`<option value="${h(draft.managerRouteId)}" selected>${h(selectedPlanner()?.name??draft.managerRouteId)} · доступ буде перевірено</option>`:''}${plannerChoices(managerCatalog()).map(r=>`<option value="${h(r.id)}" ${draft.managerRouteId===r.id?'selected':''}>${h(r.name??r.model)} · ${h(r.backend)}</option>`).join('')}</select></label>
        <label>Максимум моделей на задачу<select name="maxAgentsPerTask">${[1,2,3,4,5,6].map(n=>`<option value="${n}" ${draft.maxAgentsPerTask===n?'selected':''}>${n}</option>`).join('')}</select></label>
        <label class="checkline"><input type="checkbox" name="freeWorkers" ${draft.freeWorkers?'checked':''}>Тільки безкоштовні виконавці</label>
        <p class="muted text-small">За замовчуванням доступні підтверджені безкоштовні моделі та включені квоти наявних підписок. Платні API-списання заблоковані.</p>
      </details>`;
    if (step === 2) return `${note()}<h3>Від задуму до продуманої концепції</h3><p class="creation-description">Планувальник допоможе визначити ключовий досвід користувача, дизайн, наповнення та функції першої версії.</p>${generateButtons('idea',draft.idea?'Уточнити з AI':'Продумати ідею з AI')}${draft.idea ? `${source('idea')}<label>Концепція — можна відредагувати<textarea name="summary" required maxlength="12000">${h(draft.idea.summary)}</textarea></label><div class="brief-columns"><div><h4>Ключові можливості</h4>${list(draft.idea.features)}</div><div><h4>Що потрібно уточнити</h4>${list(draft.idea.questions)}</div></div><h4>Ризики</h4>${list(draft.idea.risks)}<label>Відповіді та уточнення<textarea name="feedback" maxlength="6000" placeholder="Дайте відповіді на питання або поясніть, що змінити…">${h(draft.feedback)}</textarea></label>` : '<div class="creation-empty">Спочатку отримайте концепцію, уточніть її та прийміть перед плануванням.</div>'}`;
    if (step === 3) return `${note()}<h3>Детальний план проєкту</h3><p class="creation-description">План визначає компактний набір інженерних задач, залежності та перевірювані критерії якості.</p>${generateButtons('plan',draft.plan?'Перепланувати з AI':'Створити план з AI')}${draft.plan ? `${source('plan')}<label>Підхід і межі<textarea name="summary" required>${h(draft.plan.summary)}</textarea></label><div class="brief-columns"><div><h4>Припущення</h4>${list(draft.plan.assumptions)}</div><div><h4>Ризики</h4>${list(draft.plan.risks)}</div></div><div class="planned-tasks">${draft.plan.tasks.map((t,i)=>`<details ${i===0?'open':''}><summary><span>${String(i+1).padStart(2,'0')}</span>${h(t.title)}<small>${t.dependsOn.length?'Після: '+h(t.dependsOn.join(', ')):'Незалежна задача'}</small></summary><label>Назва<input name="title-${h(t.id)}" value="${h(t.title)}" required></label><label>Інструкція<textarea name="prompt-${h(t.id)}" required>${h(t.prompt)}</textarea></label><label>Критерії готовності — по одному на рядок<textarea name="criteria-${h(t.id)}" required>${h(t.acceptanceCriteria.join('\n'))}</textarea></label><div class="skills">${t.skills.map(s=>`<span>${h(s)}</span>`).join('')}</div></details>`).join('')}</div>` : '<div class="creation-empty">Задачі з’являться після планування. Команда буде підібрана за цим планом.</div>'}`;
    const exact=draft.teamSource?.mode==='ai'&&draft.proposal;
    return `${note()}<h3>Команда для прийнятого плану</h3><p class="creation-description">Керівник обирає точні моделі для кожної задачі з доступних безкоштовних маршрутів і підтверджених підписок.</p>${generateButtons('team','Повторити підбір команди')}${draft.routing?`${source('team')}<div class="routing-cards">${draft.routing.assignments.map(a=>{const task=draft.plan.tasks.find(t=>t.id===a.taskId);return `<article><h4>${h(task.title)}</h4><div class="recommended-agents">${exact?draft.proposal.assignments.find(v=>v.taskId===a.taskId).routeIds.map(id=>{const route=draft.proposal.routes.find(r=>r.id===id),bill=formatBillingBadge(route.billing,route.billingBoundary);return `<span><b>${h(route.model)}</b><small>${h(route.backend)} · ${h(bill.label)}</small></span>`;}).join(''):a.agentIds.map(id=>`<span><b>${h(agents().find(v=>v.id===id)?.name??id)}</b><small>Демо-профіль</small></span>`).join('')}</div><p>${h(a.reason)}</p><small class="muted">${draft.requirements?.[a.taskId]==='text'?'Аналіз без зміни файлів':'Робота з файлами'}</small></article>`;}).join('')}</div><div class="info-note">${icon('shield')}${exact?'Проєкт буде збережено разом із цим призначенням. Перед збереженням і запуском доступ перевіряється повторно.':'Демо показує рольові профілі. Реальні моделі для цього прикладу ще не призначені.'}</div>`:'<div class="creation-empty">Тут з’являться моделі та пояснення вибору для кожної задачі.</div>'}`;
  }
  function show(next=step) {
    step=next;
    saveProjectDraft(draftStorage,draft);
    const names=['Задум','Концепція','План','Команда'];
    const disabled=busy || (step===2&&!draft.idea) || (step===3&&!draft.plan) || (step===4&&!draft.routing);
    const access=step===3&&draft.plan?`<details><summary>Доступ виконавців до файлів</summary><p class="muted text-small">Для дослідження або перевірки можна обрати аналіз без зміни файлів.</p>${draft.plan.tasks.map(t=>`<label>${h(t.title)}<select name="access-${h(t.id)}"><option value="write" ${draft.requirements?.[t.id]!=='text'?'selected':''}>Робота з файлами</option><option value="text" ${draft.requirements?.[t.id]==='text'?'selected':''}>Аналіз без зміни файлів</option></select></label>`).join('')}</details>`:'';
    const submitLabel = step === 1
      ? (draft.mode === 'auto' ? 'Створити та запустити автоматично' : 'Продовжити')
      : ['Продовжити','Прийняти концепцію','Прийняти план і підібрати команду','Створити та запустити'][step-1];
    const busyText = busyStatus || (busyKind==='create'?'Зберігаємо проєкт і запускаємо команду…':`${busyKind==='plan'?'Керівник складає детальний план':'Керівник опрацьовує запит'}. Очікуємо завершення моделі без фіксованого ліміту часу. Можна зупинити очікування; попередні дані залишаться в майстрі.`);
    modal('Новий проєкт',`<div class="creation-flow">
      <div class="wizard-steps" aria-label="Етапи створення">${names.map((n,i)=>`<span ${step===i+1?'aria-current="step"':''} class="${step===i+1?'current':step>i+1?'finished':''} ${i===1&&(draft.mode==='ready'||draft.mode==='auto')?'skipped':''}">${i+1}<b>${n}</b></span>${i<3?'<i></i>':''}`).join('')}</div>
      <form id="creation-project" data-step="${step}" aria-busy="${busy}">
      ${busy?`<div class="planning-busy" role="status">${h(busyText)}</div>${busyKind!=='create'?button('','Зупинити очікування','','btn','data-creation="cancel-generation"'):''}`:''}
      ${draft.error?`<p class="execution-error" role="alert">${h(draft.error)}</p>`:''}
      <fieldset class="creation-fields" ${busy?'disabled':''}>${body()}${access}</fieldset>
      <div class="form-footer">${button('',step===1?'Скасувати':'Назад','','btn',`data-creation="back" ${busy?'disabled':''}`)}<button type="submit" class="btn primary" ${disabled?'disabled':''}>${submitLabel} ${icon('arrow')}</button></div>
      </form></div>`);
    dialog.scrollTop=0;
  }
  async function requestPlanning(kind, signal) {
    const input={name:draft.name,description:draft.description,priority:draft.priority,idea:draft.idea,feedback:draft.feedback,plan:draft.plan,...(kind==='team'?{agents:agents().map(({id,name,model,provider,skills,role})=>({id,name,model,provider,skills,role}))}:{})};
    if (kind==='team') {
      const proposal=await proposeDraft(draftRoutingInput(draft),signal);
      return {value:proposalTeam(proposal,draft.plan).routing,provenance:proposal.provenance,proposal};
    }
    const response=await fetch('/api/planning',{method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':config?.token??''},body:JSON.stringify({kind,input,...(draft.managerRouteId?{managerRouteId:draft.managerRouteId}:{})}),signal});
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
      const needIdea = draft.description.length < 220;
      if (needIdea) {
        busyStatus = 'Етап 1/4 · AI формує концепцію продукту та функціонал…'; show(2);
        const ideaRes = await requestPlanning('idea', controller.signal);
        if (generation !== version || draft !== ownDraft || !dialog.open) return;
        validateIdea(ideaRes.value);
        draft.idea = ideaRes.value; draft.ideaSource = ideaRes.provenance;
      }
      busyStatus = needIdea ? 'Етап 2/4 · AI складає продуктовий план проєкту…' : 'Етап 1/3 · AI складає продуктовий план проєкту…'; show(3);
      const planRes = await requestPlanning('plan', controller.signal);
      if (generation !== version || draft !== ownDraft || !dialog.open) return;
      validatePlan(planRes.value);
      draft.plan = planRes.value; draft.planSource = planRes.provenance;
      draft.requirements = Object.fromEntries(draft.plan.tasks.map(t => [t.id, 'write']));

      busyStatus = needIdea ? 'Етап 3/4 · AI підбирає найкращі моделі під задачі…' : 'Етап 2/3 · AI підбирає найкращі моделі під задачі…'; show(4);
      const teamRes = await requestPlanning('team', controller.signal);
      if (generation !== version || draft !== ownDraft || !dialog.open) return;
      validateAssignments(teamRes.value, draft.plan, proposalTeam(teamRes.proposal, draft.plan).profiles);
      draft.routing = teamRes.value; draft.proposal = teamRes.proposal; draft.teamSource = teamRes.provenance;

      busyKind = 'create';
      busyStatus = needIdea ? 'Етап 4/4 · Зберігаємо проєкт і запускаємо AI-команду…' : 'Етап 3/3 · Зберігаємо проєкт і запускаємо AI-команду…'; show(4);
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
      const input={name:draft.name,description:draft.description,priority:draft.priority,idea:draft.idea,feedback:draft.feedback,plan:draft.plan,...(kind==='team'?{agents:agents().map(({id,name,model,provider,skills,role})=>({id,name,model,provider,skills,role}))}:{})};
      let result;
      if (demo) result={value:kind==='idea'?demoIdea(input):kind==='plan'?demoPlan(input):demoAssignments(draft.plan,agents()),provenance:{mode:'demo',at:new Date().toISOString()}};
      else result = await requestPlanning(kind, controller.signal);
      if (generation!==version || draft!==ownDraft || !dialog.open) return;
      if(kind==='idea'){validateIdea(result.value);draft.idea=result.value;draft.plan=null;draft.routing=null;draft.proposal=null;delete draft.planSource;delete draft.teamSource;}
      if(kind==='plan'){validatePlan(result.value);draft.plan=result.value;draft.routing=null;draft.proposal=null;delete draft.teamSource;}
      if(kind==='team'){validateAssignments(result.value,draft.plan,result.proposal?proposalTeam(result.proposal,draft.plan).profiles:agents());draft.routing=result.value;draft.proposal=result.proposal??null;}
      draft[`${kind}Source`]=result.provenance;
    } catch(error){ if(error.name!=='AbortError'&&dialog.open&&generation===version)draft.error=planningErrorMessage(error,kind); }
    finally { if(generation===version&&dialog.open){busy=false;busyStatus='';show();} }
  }
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-creation]'); if(!el)return;
    const action=el.dataset.creation;
    if(action==='cancel-generation'&&busy&&busyKind!=='create'){controller?.abort();return;}
    if(busy)return;
    if(action==='browse-folders'||action==='open-folder'){void browseFolders(action==='open-folder'?el.dataset.path:undefined);return;}
    if(action==='close-folders'||action==='use-folder'){
      capture();
      if(action==='use-folder')draft.projectParent=folderPicker?.path??'';
      folderRequest++;folderPicker=null;saveProjectDraft(draftStorage,draft);show();return;
    }
    if(action==='back'){capture();if(step===1)dialog.close();else show(step===3&&(draft.mode==='ready'||draft.mode==='auto')?1:step-1);}
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
        draft.idea=null;draft.plan=null;draft.routing=null;draft.proposal=null;
        delete draft.ideaSource;delete draft.planSource;delete draft.teamSource;
        if(draft.mode==='auto'){void runAutopilot();return;}
        show(draft.mode==='ready'?3:2);
        if(canPlan())void generate(draft.mode==='ready'?'plan':'idea');
      }
      else if(step===2){validateIdea(draft.idea);draft.plan=null;draft.routing=null;draft.proposal=null;delete draft.planSource;delete draft.teamSource;show(3);if(canPlan())void generate('plan');}
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
      if(step===1&&event.target.name==='mode'){
        const btn=dialog.querySelector('#creation-project button[type="submit"]');
        if(btn)btn.innerHTML=`${draft.mode==='auto'?'Створити та запустити автоматично':'Продовжити'} ${icon('arrow')}`;
      }
    }
  };
  document.addEventListener('input',saveInput);document.addEventListener('change',saveInput);
  return {open(){generation++;completed=false;const restored=restoreProjectDraft(draftStorage);draft=restored?.draft??{name:'',description:'',mode:'auto',priority:'quality',managerRouteId:'',freeWorkers:false,maxAgentsPerTask:1,requirements:{},feedback:'',idea:null,plan:null,routing:null,proposal:null};config=null;busy=false;busyStatus='';show(restored?.step??1);const openedDraft=draft;fetch('/api/planning/status').then(r=>r.ok?r.json():null).then(value=>{if(draft===openedDraft&&dialog.open){config=value;if(!busy){if(step===1)refreshStep1PlannerControls();else{capture();show();}}}}).catch(()=>{});}};
}
