import { demoIdea, demoPlan, demoAssignments, validateIdea, validatePlan, validateAssignments } from './planning.js';

export function createProjectWizard({ modal, h, icon, button, agents, onCreate, notify }) {
  let draft, config, step = 1, busy = false, controller, generation = 0;
  const dialog = document.querySelector('#modal');
  dialog.addEventListener('close', () => { generation++; controller?.abort(); busy = false; });
  const list = values => `<ul>${values.map(v => `<li>${h(v)}</li>`).join('')}</ul>`;
  const note = () => `<div class="planner-status">${icon('spark')}<span><strong>Модель-планувальник</strong><small>${config?.configured ? `${h(config.model)} · ${h(config.provider)}` : 'Не підключена · доступний явний демо-приклад'}</small></span><span class="provider-pill">${config?.configured ? 'AI' : 'DEMO'}</span></div>`;
  function capture() {
    const form = dialog.querySelector('form'); if (!form) return;
    const data = new FormData(form);
    if (step === 1) { draft.name = String(data.get('name') ?? '').trim(); draft.description = String(data.get('description') ?? '').trim(); draft.mode = data.get('mode') ?? 'idea'; draft.priority = data.get('priority') ?? 'quality'; }
    if (step === 2) { if (draft.idea && data.has('summary')) draft.idea.summary = String(data.get('summary')).trim(); draft.feedback = String(data.get('feedback') ?? '').trim(); }
    if (step === 3 && draft.plan) {
      draft.plan.summary = String(data.get('summary') ?? draft.plan.summary).trim();
      draft.plan.tasks.forEach(t => { t.title = String(data.get(`title-${t.id}`) ?? t.title).trim(); t.prompt = String(data.get(`prompt-${t.id}`) ?? t.prompt).trim(); t.acceptanceCriteria = String(data.get(`criteria-${t.id}`) ?? t.acceptanceCriteria.join('\n')).split('\n').map(s=>s.trim()).filter(Boolean); });
    }
    if (step === 4 && draft.routing) draft.routing.assignments.forEach(a => { if (data.has(`manual-${a.taskId}`)) { const ids=data.getAll(`agent-${a.taskId}`); if(JSON.stringify([...ids].sort())!==JSON.stringify([...a.agentIds].sort()))a.manual=true; a.agentIds=ids; } });
  }
  function generateButtons(kind, label) {
    return `<div class="generation-actions">${button('',label,'spark','btn primary',`data-creation="generate-${kind}" ${!config?.configured || busy ? 'disabled' : ''}`)}${button('','Показати демо-приклад','','btn',`data-creation="demo-${kind}" ${busy ? 'disabled' : ''}`)}</div>${!config?.configured ? '<p class="muted text-small">Справжнє AI-планування потребує підключеної моделі. Демо використовує шаблон і правила, а не AI.</p>' : '<p class="muted text-small">Запит буде надіслано налаштованій моделі. Виконання задач ще не починається.</p>'}`;
  }
  function source(kind) { const meta=draft[`${kind}Source`]; return meta ? `<div class="source-label ${meta.mode}">${icon(meta.mode === 'ai' ? 'spark' : 'file')}${meta.mode === 'ai' ? `Створено AI · ${h(meta.model)}` : 'Демо-приклад · без модельного запиту'}</div>` : ''; }
  function body() {
    if (step === 1) return `<h3>На якій стадії ваш проєкт?</h3><div class="creation-modes"><label><input type="radio" name="mode" value="idea" ${draft.mode==='idea'?'checked':''}><span><strong>Допоможіть продумати ідею</strong><small>AI уточнить задум, запропонує функції та визначить межі першої версії.</small></span></label><label><input type="radio" name="mode" value="ready" ${draft.mode==='ready'?'checked':''}><span><strong>Проєкт уже придуманий</strong><small>Пропустити опрацювання ідеї та перейти до детального плану.</small></span></label></div><label>Робоча назва<input name="name" required maxlength="80" value="${h(draft.name)}" placeholder="Наприклад, розумний помічник для досліджень"></label><label>Ідея, вимоги або готовий опис<textarea name="description" required maxlength="12000" placeholder="Що хочете створити, для кого і який результат отримати?">${h(draft.description)}</textarea></label><label>Пріоритет підбору моделей<select name="priority"><option value="quality" ${draft.priority==='quality'?'selected':''}>Якість і продуманість</option><option value="balanced" ${draft.priority==='balanced'?'selected':''}>Баланс якості, часу та вартості</option><option value="cost" ${draft.priority==='cost'?'selected':''}>Економія за дотримання вимог</option></select></label>`;
    if (step === 2) return `${note()}<h3>Від задуму до продуманої концепції</h3><p class="creation-description">Планувальник допоможе визначити користувача, ключову користь, функції, ризики та відкриті питання.</p>${generateButtons('idea',draft.idea?'Уточнити з AI':'Продумати ідею з AI')}${draft.idea ? `${source('idea')}<label>Концепція — можна відредагувати<textarea name="summary" required maxlength="12000">${h(draft.idea.summary)}</textarea></label><div class="brief-columns"><div><h4>Ключові можливості</h4>${list(draft.idea.features)}</div><div><h4>Що потрібно уточнити</h4>${list(draft.idea.questions)}</div></div><h4>Ризики</h4>${list(draft.idea.risks)}<label>Відповіді та уточнення<textarea name="feedback" maxlength="6000" placeholder="Дайте відповіді на питання або поясніть, що змінити…">${h(draft.feedback)}</textarea></label>` : '<div class="creation-empty">Спочатку отримайте концепцію, уточніть її та прийміть перед плануванням.</div>'}`;
    if (step === 3) return `${note()}<h3>Детальний план проєкту</h3><p class="creation-description">План має визначати конкретні задачі, залежності, необхідні навички та перевірювані критерії готовності.</p>${generateButtons('plan',draft.plan?'Перепланувати з AI':'Створити план з AI')}${draft.plan ? `${source('plan')}<label>Підхід і межі<textarea name="summary" required>${h(draft.plan.summary)}</textarea></label><div class="brief-columns"><div><h4>Припущення</h4>${list(draft.plan.assumptions)}</div><div><h4>Ризики</h4>${list(draft.plan.risks)}</div></div><div class="planned-tasks">${draft.plan.tasks.map((t,i)=>`<details ${i===0?'open':''}><summary><span>${String(i+1).padStart(2,'0')}</span>${h(t.title)}<small>${t.dependsOn.length?'Після: '+h(t.dependsOn.join(', ')):'Незалежна задача'}</small></summary><label>Назва<input name="title-${h(t.id)}" value="${h(t.title)}" required></label><label>Інструкція<textarea name="prompt-${h(t.id)}" required>${h(t.prompt)}</textarea></label><label>Критерії готовності — по одному на рядок<textarea name="criteria-${h(t.id)}" required>${h(t.acceptanceCriteria.join('\n'))}</textarea></label><div class="skills">${t.skills.map(s=>`<span>${h(s)}</span>`).join('')}</div></details>`).join('')}</div>` : '<div class="creation-empty">Задачі з’являться після планування. Команда буде підібрана за цим планом.</div>'}`;
    return `${note()}<h3>Команда, підібрана під ваш план</h3><p class="creation-description">Для кожної задачі — рекомендовані профілі, моделі та пояснення вибору. Кілька агентів можуть працювати над однією задачею.</p>${generateButtons('team','Повторити підбір з AI')}${draft.routing ? `${source('team')}<div class="routing-cards">${draft.routing.assignments.map(a=>{ const t=draft.plan.tasks.find(t=>t.id===a.taskId); return `<article><h4>${h(t.title)}</h4><div class="recommended-agents">${a.agentIds.map(id=>{const agent=agents().find(v=>v.id===id); return `<span><b>${h(agent.name)}</b><small>${h(agent.model)} · ${h(agent.provider)}</small></span>`;}).join('')}</div><p>${h(a.reason)}</p><details><summary>Скоригувати вручну</summary><input type="hidden" name="manual-${h(a.taskId)}" value="1">${agents().map(agent=>`<label class="checkline"><input type="checkbox" name="agent-${h(a.taskId)}" value="${h(agent.id)}" ${a.agentIds.includes(agent.id)?'checked':''}>${h(agent.name)} · ${h(agent.model)}</label>`).join('')}</details></article>`;}).join('')}</div><div class="info-note">${icon('shield')}Каталог містить профілі, доступність яких ще не перевірена. Підбір є рекомендацією; виконання створеного проєкту поки демонстраційне.</div>` : '<div class="creation-empty">Підбираємо команду за прийнятим планом…</div>'}`;
  }
  function show(next=step) {
    step=next;
    const names=['Задум','Концепція','План','Команда'];
    const disabled=busy || (step===2&&!draft.idea) || (step===3&&!draft.plan) || (step===4&&!draft.routing);
    modal('Новий проєкт',`<div class="creation-flow"><div class="wizard-steps">${names.map((n,i)=>`<span class="${step===i+1?'current':step>i+1?'finished':''} ${i===1&&draft.mode==='ready'?'skipped':''}">${i+1}<b>${n}</b></span>${i<3?'<i></i>':''}`).join('')}</div><form id="creation-project" data-step="${step}">${busy?'<div class="planning-busy" role="status">AI опрацьовує запит. Можна закрити вікно, щоб скасувати очікування.</div>':''}${body()}<div class="form-footer">${button('',step===1?'Скасувати':'Назад','','btn',`data-creation="back" ${busy?'disabled':''}`)}<button type="submit" class="btn primary" ${disabled?'disabled':''}>${['Продовжити','Прийняти концепцію','Прийняти план і підібрати команду','Створити проєкт'][step-1]} ${icon('arrow')}</button></div></form></div>`);
    dialog.scrollTop=0;
  }
  async function generate(kind, demo=false) {
    capture(); const ownDraft=draft, version=++generation; controller?.abort(); controller=new AbortController(); busy=true; draft.error=null; show();
    try {
      const input={name:draft.name,description:draft.description,priority:draft.priority,idea:draft.idea,feedback:draft.feedback,plan:draft.plan,...(kind==='team'?{agents:agents().map(({id,name,model,provider,skills,role})=>({id,name,model,provider,skills,role}))}:{})};
      let result;
      if (demo) result={value:kind==='idea'?demoIdea(input):kind==='plan'?demoPlan(input):demoAssignments(draft.plan,agents()),provenance:{mode:'demo',at:new Date().toISOString()}};
      else { const response=await fetch('/api/planning',{method:'POST',headers:{'Content-Type':'application/json','X-Planning-Token':config?.token??''},body:JSON.stringify({kind,input}),signal:controller.signal}); result=await response.json(); if(!response.ok)throw new Error(result.error??'Помилка планування'); }
      if (generation!==version || draft!==ownDraft || !dialog.open) return;
      if(kind==='idea'){validateIdea(result.value);draft.idea=result.value;draft.plan=null;draft.routing=null;}
      if(kind==='plan'){validatePlan(result.value);draft.plan=result.value;draft.routing=null;}
      if(kind==='team'){validateAssignments(result.value,draft.plan,agents());draft.routing=result.value;}
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
  document.addEventListener('submit',event=>{
    if(event.target.id!=='creation-project')return; event.preventDefault(); if(busy)return;
    try {
      capture();
      if(step===1){if(!draft.name||!draft.description)throw new Error('Опишіть назву та задум проєкту');draft.idea=null;draft.plan=null;draft.routing=null;show(draft.mode==='ready'?3:2);}
      else if(step===2){validateIdea(draft.idea);draft.plan=null;draft.routing=null;show(3);}
      else if(step===3){validatePlan(draft.plan);draft.routing=null;show(4);generate('team',!config?.configured||draft.planSource?.mode==='demo');}
      else {validateAssignments(draft.routing,draft.plan,agents());onCreate(structuredClone(draft));dialog.close();}
    }catch(error){notify(error.message);}
  });
  return {open(){generation++;draft={name:'',description:'',mode:'idea',priority:'quality',feedback:'',idea:null,plan:null,routing:null};config=null;busy=false;show(1);const openedDraft=draft;fetch('/api/planning/status').then(r=>r.ok?r.json():null).then(value=>{if(draft===openedDraft&&dialog.open){config=value;if(step!==1&&!busy){capture();show();}}}).catch(()=>{});}};
}
