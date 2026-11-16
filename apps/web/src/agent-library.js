import {formatBillingBadge} from './routing-ui.js';

export const providerNames={codex:'Codex',opencode:'OpenCode',antigravity:'Antigravity',claude:'Claude Code',ollama:'Ollama'};
const colors={codex:'purple',opencode:'green',antigravity:'blue'};
export const reasoningLabels={none:'Без роздумів',minimal:'Мінімальний',low:'Низький',medium:'Середній',high:'Високий',xhigh:'Дуже високий',max:'Максимальний',ultra:'Ультра'};
export function catalogAgent(route,{reasoningEffort}={}) {
  const explicit=reasoningEffort!==undefined;
  if(explicit&&(route.backend!=='codex'||!route.reasoningEfforts?.includes(reasoningEffort)))throw Error('Цей рівень роздумів недоступний для моделі');
  return {id:`catalog-${encodeURIComponent(route.id)}${explicit?'-reasoning-'+encodeURIComponent(reasoningEffort):''}`,source:'catalog',routeId:route.id,
    name:(route.name||route.model)+(explicit?' · '+(reasoningLabels[reasoningEffort]??reasoningEffort):''),model:route.model,backend:route.backend,provider:'CLI',
    ...(explicit?{reasoningEffort}:{}),
    role:'AI-виконавець із каталогу моделей',skills:['text',...(route.capabilities?.code?['code']:[])],
    initials:(providerNames[route.backend]??route.backend??'AI').slice(0,2).toUpperCase(),color:colors[route.backend]??'orange'};
}
export function agentLibraryItems(catalog,profiles=[],now=Date.now()) {
  const unique=new Map((catalog?.routes??[]).map(r=>[r.id,r]));
  for(const profile of profiles.filter(p=>p.source==='catalog'&&p.routeId))if(!unique.has(profile.routeId))unique.set(profile.routeId,null);
  return [...unique].map(([id,route])=>{
    const saved=profiles.find(p=>p.source==='catalog'&&p.routeId===id),profile=saved??catalogAgent(route);
    const fresh=Boolean(route&&Date.parse(route.expiresAt)>now&&Date.parse(route.checkedAt)<=now+60000);
    const available=fresh&&route.decision?.allowed===true;
    const reason=!route?'Модель відсутня в актуальному каталозі':!fresh?'Оновіть перевірку доступу':route.decision?.reason??'Доступ не підтверджено';
    return {id,route,profile,available,reason};
  });
}
function modelIdentity(item) {
  const model=item.profile.model,name=item.route?.name??item.profile.name;
  // Antigravity advertises reasoning variants as separate exact model IDs. Other providers keep their IDs intact.
  const suffix=item.profile.backend==='antigravity'&&/^(.*)-(none|minimal|low|medium|high|xhigh|max|ultra)$/.exec(model);
  const titleSuffix=/\s*\((None|Minimal|Low|Medium|High|XHigh|Max|Ultra)\)$/i.exec(name);
  if(suffix&&titleSuffix&&suffix[2]===titleSuffix[1].toLowerCase())return {model:suffix[1],name:name.slice(0,titleSuffix.index),effort:suffix[2]};
  return {model,name,effort:null};
}
export function agentLibraryGroups(catalog,profiles=[],now=Date.now()) {
  const groups=new Map();
  for(const item of agentLibraryItems(catalog,profiles,now)) {
    const identity=modelIdentity(item),id=`model-group:${item.profile.backend}:${identity.model}`;
    const group=groups.get(id)??{id,profile:{...item.profile,name:identity.name,model:identity.model},variants:[]};
    group.variants.push({...item,effort:identity.effort});groups.set(id,group);
  }
  return [...groups.values()].map(group=>{
    const representative=group.variants.find(v=>v.available)??group.variants[0];
    return {...group,route:representative.route,available:group.variants.some(v=>v.available),reason:representative.reason};
  });
}
export function reasoningChoices(group) {
  const choices=group.variants.flatMap(item=>{
    const efforts=item.route?.backend==='codex'?[...new Set(item.route.reasoningEfforts??[])]:[];
    return efforts.length?efforts.map(effort=>({value:`effort:${effort}`,label:reasoningLabels[effort]??effort,item,reasoningEffort:effort})):
      [{value:item.id,label:item.effort?(reasoningLabels[item.effort]??item.effort):'Стандартний',item}];
  });
  const order=Object.keys(reasoningLabels),rank=choice=>{const effort=choice.reasoningEffort??choice.item.effort;return effort?(order.indexOf(effort)<0?order.length:order.indexOf(effort)):-1;};
  return choices.sort((a,b)=>rank(a)-rank(b));
}
export function resolveReasoningChoice(catalog,profiles,groupId,value,now=Date.now()) {
  const group=agentLibraryGroups(catalog,profiles,now).find(g=>g.id===groupId);
  const choice=group&&reasoningChoices(group).find(c=>c.value===value);
  if(!choice)throw Error('Оберіть доступний рівень роздумів');
  if(!choice.item.available)throw Error(choice.item.reason);
  return choice;
}
export function filterAgentLibrary(items,{query='',backend='',billing='',status='all'}={}) {
  const q=query.trim().toLocaleLowerCase('uk-UA');
  return items.filter(item=>(!backend||item.profile.backend===backend)&&(!billing||item.route?.billing===billing)&&
    (status==='all'||(status==='available'?item.available:!item.available))&&
    (!q||[item.profile.name,item.profile.model,item.id,providerNames[item.profile.backend]].filter(Boolean).join(' ').toLocaleLowerCase('uk-UA').includes(q)));
}
export function preferredAgentRuntime(profile,runtimes) {
  const allowed=runtimes.filter(r=>r.allowed&&(!profile?.routeId||r.routeId===profile.routeId));
  const access=profile?.id==='reviewer'||profile?.skills?.includes('review')&&!profile?.skills?.includes('code')?'read-only':'workspace-write';
  return (allowed.find(r=>r.access===access)??allowed[0])?.id??null;
}
export function addCatalogAgentToProject(state,catalog,routeId,projectId,{now=Date.now(),reasoningEffort}={}) {
  const item=agentLibraryItems(catalog,state.agents,now).find(item=>item.id===routeId);
  if(!item?.available)throw Error(item?.reason??'Модель не знайдено: оновіть каталог');
  const project=state.projects.find(p=>p.id===projectId);if(!project)throw Error('Оберіть проєкт');
  if(['running','paused'].includes(project.status)||project.execution?.draining)throw Error('Завершіть або скасуйте запуск перед зміною команди');
  const next=catalogAgent(item.route,{reasoningEffort});
  let profile=state.agents.find(p=>p.source==='catalog'&&p.routeId===routeId&&p.reasoningEffort===reasoningEffort);
  if(!profile){if(state.agents.length>=100)throw Error('Досягнуто ліміт 100 збережених профілів');profile=next;if(state.agents.some(p=>p.id===profile.id))throw Error('Конфлікт ID профілю агента');state.agents.push(profile);}
  const changed=!project.team.includes(profile.id);
  if(changed){project.team.push(profile.id);project.revision++;}
  return {profile,project,changed};
}
export function renderAgentLibrary(catalog,profiles,filters,{h,icon,button,avatar,renderProfile,loading=false,error=null}) {
  const items=agentLibraryGroups(catalog,profiles),shown=filterAgentLibrary(items,filters),available=items.filter(i=>i.available).length;
  const backends=[...new Set(items.map(i=>i.profile.backend))].sort();
  const select=(key,label,options)=>`<label>${label}<select data-agent-filter="${key}" id="agent-filter-${key}">${options.map(([value,text])=>`<option value="${h(value)}" ${filters[key]===value?'selected':''}>${h(text)}</option>`).join('')}</select></label>`;
  const roleProfiles=profiles.filter(p=>p.source!=='catalog');
  return `<section class="agent-library" aria-label="Каталог агентів">
    <div class="section-heading"><div><h2>Моделі для агентів <span class="count">${items.length}</span></h2><p class="muted">Codex, OpenCode та Antigravity — моделі з підключених CLI.</p></div>${button('scan-connections',loading?'Оновлення…':'Оновити доступ','search','btn small-btn',loading?'disabled':'')}</div>
    ${loading?'<p class="planning-busy" role="status">Перевіряємо підключення й квоти моделей…</p>':''}
    ${error?`<p class="api-error-banner" role="alert">${h(error)}</p>`:''}
    <div class="agent-library-filters" data-live-key="agent-library-filters" role="search" aria-label="Пошук агентів">
      <label class="agent-library-query">Пошук моделі<input type="search" id="agent-library-query" data-agent-filter="query" value="${h(filters.query??'')}" placeholder="Назва моделі або провайдера"></label>
      ${select('backend','Провайдер',[['','Усі провайдери'],...backends.map(b=>[b,providerNames[b]??b])])}
      ${select('billing','Доступ',[['','Усі тарифи'],['free_tier','Безкоштовні'],['subscription_included','За підпискою']])}
      ${select('status','Стан',[['all','Усі моделі'],['available','Доступні зараз'],['blocked','Потребують перевірки']])}
    </div>
    <p class="muted agent-library-summary" data-live-key="agent-library-summary" role="status" aria-live="polite">Показано ${shown.length} з ${items.length} · доступні зараз: ${available}</p>
    <div class="agent-grid agent-model-grid" data-live-key="agent-model-grid">${shown.map(item=>{
      const {profile:a,route:r}=item,b=formatBillingBadge(r?.billing,r?.billingBoundary);
      return `<article class="agent-card agent-model-card" data-live-key="agent-model-${h(item.id)}">
        <div class="agent-card-top">${avatar(a)}<span class="provider-pill">${h(providerNames[a.backend]??a.backend)}</span></div>
        <h3>${h(a.name)}</h3><p class="agent-model-id">${h(a.model)}</p>
        <div class="agent-model-status"><span class="badge ${item.available?'done':'blocked'}"><i></i>${item.available?'Доступна зараз':'Потребує перевірки'}</span><span class="billing-pill ${b.tone}">${h(b.label)}</span></div>
        <div class="skills"><span>${r?.capabilities?.workspaceWrite?'Робота з файлами':'Текстові задачі'}</span><span>${r?.capabilities?.tools?'Інструменти':'Керований текстовий виклик'}</span></div>
        <p class="agent-access-note">${h(item.reason)}</p>
        <div class="agent-card-bottom">${button('catalog-agent-detail','Деталі','arrow','text-button',`data-id="${h(item.id)}"`)}${button('catalog-agent-add','У команду','plus','btn small-btn',`data-id="${h(item.id)}" ${item.available?'':'disabled'}`)}</div>
      </article>`;
    }).join('')}</div>
    ${!shown.length?`<div class="empty panel"><h3>${items.length?'Немає моделей за цими фільтрами':'Каталог ще не завантажено'}</h3><p>${items.length?'Спробуйте іншу назву або скиньте фільтри.':'Оновіть доступ, щоб знайти встановлені CLI та моделі.'}</p>${button('agent-library-reset','Скинути фільтри','search')}${button('scan-connections','Оновити доступ','plug','btn',loading?'disabled':'')}</div>`:''}
    <details class="agent-role-profiles" data-live-key="agent-role-profiles"><summary>Рольові та власні профілі (${roleProfiles.length})</summary><p class="muted">Шаблони ролей можна використовувати для планування. Доступ до їхніх рекомендованих моделей перевіряється окремо.</p><div class="agent-grid">${roleProfiles.map(renderProfile).join('')}</div></details>
  </section>`;
}
