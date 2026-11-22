import { createProjectWizard } from './create-project.js';
import { composeProject } from './project-composition.js';
import { renderConnections } from './connections.js';
import { createExecutionClient, serializeWorkspaceState } from './execution.js';
import { executionPanel, fileArtifacts, hasVerificationChecks, runHistory } from './execution-ui.js';
import { renderRoutingSection, summarizeTaskModels, formatBillingBadge } from './routing-ui.js';
import { renderSolarStage } from './solar-system.js';
import { patchLiveDom } from './live-dom.js';
import {agentLibraryItems,agentLibraryGroups,reasoningChoices,resolveReasoningChoice,renderAgentLibrary,addCatalogAgentToProject,providerNames} from './agent-library.js';
import { seed, uid, labels, start, tick, log, validateTasks, cancelTask } from './state.js';

const $ = s => document.querySelector(s);
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paths = {
  orbit: '<ellipse cx="12" cy="12" rx="11" ry="5" transform="rotate(-35 12 12)"/><circle cx="12" cy="12" r="4"/><circle cx="20" cy="5" r="1.3" fill="currentColor"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',
  pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zm6 9v4"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-4c8 0 12-1 12-5"/>',
  file: '<path d="M14 2H5v20h14V7zM14 2v6h5M8 13h8m-8 4h6"/>',
  book: '<path d="M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-3-1-7-2-10 1zm0 0v16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z"/><path d="m8 12 3 3 5-6"/>',
  spark: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>',
  link: '<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-2 2"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.layers}</svg>`;
let state, execution;
try { state = JSON.parse(localStorage.getItem('orcestrator.ui.v1')); if (state?.version !== 1 || !state.projects?.length) state = seed(); } catch { state = seed(); }
// A closed prototype tab does not imply a live background execution.
for (const p of state.projects) if (p.status === 'running' && p.execution?.mode !== 'real') { p.status = 'paused'; log(p, 'Демо відновлено на паузі після відкриття сторінки'); }
let route = location.hash.slice(1) || 'overview', tab = 'plan', view = 'solar', selected = null, search = '', navOpen = false;
const resumingCancelled = new Set();
const verifyingHost = new Set();
let toastTimer;
const mobileNavigation=window.matchMedia('(max-width: 700px)');
mobileNavigation.addEventListener('change',()=>{if(navOpen){navOpen=false;render({executionOnly:true});}});
let agentLibraryFilters = {query:'',backend:'',billing:'',status:'all'};
function availableProfiles() {
  const all=new Map(state.agents.map(a=>[a.id,a]));
  for(const item of agentLibraryItems(execution?.catalog,state.agents))if(item.available)all.set(item.profile.id,item.profile);
  return [...all.values()];
}
function retainProfiles(ids) {
  const all=availableProfiles(),missing=[...new Set(ids)].filter(id=>!state.agents.some(a=>a.id===id)).map(id=>all.find(a=>a.id===id));
  if(missing.some(a=>!a))throw Error('Агент більше не доступний: оновіть команду');
  if(state.agents.length+missing.length>100)throw Error('Досягнуто ліміт 100 збережених профілів');
  state.agents.push(...missing);
}
const project = () => state.projects.find(p => p.id === state.activeId) ?? state.projects[0];
const agent = id => state.agents.find(a => a.id === id) ?? project().execution?.agents?.map(a=>({...a,initials:a.name.slice(0,2).toUpperCase(),color:'purple'})).find(a=>a.id===id);
function save(localOnly=false) { try { localStorage.setItem('orcestrator.ui.v1', JSON.stringify(serializeWorkspaceState(state))); } catch { toast('Не вдалося зберегти кеш у браузері. Експортуйте проєкт.'); } if(!localOnly)execution?.scheduleSave(); }
const button = (action, text, glyph, cls = 'btn', extra = '') => `<button type="button" class="${cls}" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ''}${text}</button>`;
const badge = status => `<span class="badge ${h(status)}"><i></i>${h(labels[status] ?? status)}</span>`;
const avatar = (a, small = false) => a ? `<span class="avatar ${h(a.color)} ${small ? 'small' : ''}" title="${h(a.name)}">${h(a.initials)}</span>` : '';
function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('visible');
  if ($('#modal').open) {
    let note = $('#modal .modal-alert');
    if (!note) { note = document.createElement('div'); note.className = 'modal-alert'; note.setAttribute('role', 'alert'); ($('#modal form') ?? $('#modal')).prepend(note); }
    note.textContent = message;
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}
function navigate(next) { location.hash = next; }
window.addEventListener('hashchange', () => { route = location.hash.slice(1) || 'overview'; selected = null; search = ''; navOpen = false; render(); });
function sidebar() {
  const nav = [['overview', 'grid', 'Огляд простору'], ['projects', 'layers', 'Проєкти'], ['agents', 'users', 'Агенти'], ['runs', 'pulse', 'Запуски'], ['connections', 'plug', 'Підключення']];
  return `${navOpen ? '<div class="sidebar-backdrop" data-action="close-nav" aria-hidden="true"></div>' : ''}<aside id="app-sidebar" class="sidebar ${navOpen ? 'is-open' : ''}" aria-label="Бічна навігація"><div class="sidebar-top-row"><a class="brand" href="#overview"><span class="brand-symbol">${icon('orbit')}</span>orcestrator<span class="brand-dot">®</span></a><button type="button" class="sidebar-close" data-action="close-nav" aria-label="Закрити меню навігації">${icon('close')}</button></div><button type="button" class="workspace" data-action="workspace"><span class="workspace-icon">W</span><span>Мій робочий простір<small>Personal workspace</small></span>${icon('chevron')}</button><div class="nav-label">РОБОЧИЙ ПРОСТІР</div><nav aria-label="Основна навігація">${nav.map(([id, glyph, label]) => `<a href="#${id}" class="nav-item ${route === id || (route === 'project' && id === 'projects') ? 'active' : ''}">${icon(glyph)}<span>${label}</span>${id === 'projects' ? `<span class="nav-count">${state.projects.length}</span>` : ''}</a>`).join('')}</nav><div class="nav-label project-label">МОЇ ПРОЄКТИ<button type="button" data-action="new-project" aria-label="Створити проєкт">${icon('plus')}</button></div><div class="side-projects">${state.projects.map(p => `<button type="button" class="side-project ${route === 'project' && p.id === state.activeId ? 'current' : ''}" data-action="open-project" data-id="${h(p.id)}"><span class="project-dot ${p.id === 'core' ? 'orange' : 'purple'}"></span><span>${h(p.name)}</span></button>`).join('')}</div><div class="sidebar-bottom"><div class="local-card"><span class="live-dot"></span> Локальний простір<small>${execution?.ready ? 'Дані на локальному сервері' : 'Підключення до сервера…'}</small></div><a class="nav-item ${route === 'settings' ? 'active' : ''}" href="#settings">${icon('settings')}<span>Налаштування</span></a><div class="profile"><span class="user-avatar">ВИ</span><span>Мій профіль<small>Особистий простір</small></span><span class="profile-local">LOCAL</span></div></div></aside>`;
}
function header() {
  const titles = { overview: 'Огляд простору', projects: 'Проєкти', project: project().name, agents: 'Агенти', runs: 'Запуски', connections: 'Підключення', settings: 'Налаштування' };
  return `<header class="topbar"><button type="button" class="mobile-nav-btn" data-action="toggle-nav" aria-label="${navOpen ? 'Закрити меню навігації' : 'Відкрити меню навігації'}" aria-expanded="${navOpen}" aria-controls="app-sidebar">${icon('menu')}</button><div class="breadcrumb">Робочий простір ${icon('chevron')}<strong>${h(titles[route] ?? 'Огляд')}</strong></div><div class="topbar-right"><button type="button" class="search-trigger" data-action="search" aria-label="Швидкий пошук (Ctrl+K)">${icon('search')}<span>Швидкий пошук</span><kbd>Ctrl K</kbd></button><span class="top-divider" aria-hidden="true"></span><span class="mode-dot" aria-hidden="true"></span><span class="mode-text">${execution?.ready ? "Локальний сервер" : "Підключення…"}</span><span class="user-avatar small" aria-hidden="true">ВИ</span></div></header>`;
}
function heading(eyebrow, title, description, action = '') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${h(title)}</h1><p>${h(description)}</p></div><div class="heading-actions">${action}</div></div>`; }
function progress(p) { return Math.round(p.tasks.filter(t => t.status === 'done').length / Math.max(1, p.tasks.length) * 100); }
function projectCard(p) {
  return `<button type="button" class="project-card" data-action="open-project" data-id="${h(p.id)}"><div class="project-card-top"><span class="project-glyph ${p.id === 'core' ? 'orange' : 'purple'}">${icon(p.icon)}</span>${badge(p.status)}</div><h3>${h(p.name)}</h3><p>${h(p.description)}</p><div class="project-card-progress"><span>Виконання плану</span><strong>${progress(p)}%</strong></div><div class="progress"><span style="width:${progress(p)}%"></span></div><div class="project-card-footer"><div class="avatar-stack">${p.team.slice(0, 4).map(id => avatar(agent(id), true)).join('')}</div><span>${p.tasks.length} задач ${icon('arrow')}</span></div></button>`;
}
function stats(p) {
  const metrics = [ ['users', p.team.length.toString().padStart(2, '0'), 'Агентів у команді', 'Ролі підібрані під задачі'], ['branch', p.tasks.length.toString().padStart(2, '0'), 'Задач у плані', `${p.tasks.filter(t => t.status === 'done').length} завершено · ${p.tasks.filter(t => t.status === 'pending').length} у черзі`], ['pulse', p.tasks.filter(t => t.status === 'running').length.toString().padStart(2, '0'), 'Виконуються зараз', `До ${Number(p.concurrency) || 1} задач одночасно`], ['shield', p.execution?.mode==='real'?String(p.execution.calls):'—', p.execution?.mode==='real'?'Викликів оркестратора':'Витрати на моделі', p.execution?.mode==='real'?'Грошова сума не обчислюється':'Демо без викликів API'] ];
  return `<div class="stats">${metrics.map(([glyph, value, label, note]) => `<div class="stat"><div class="stat-label">${icon(glyph)}${label}</div><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>`;
}
function activity(p, count = 5) {
  return `<div class="activity">${p.events.length ? p.events.slice(0, count).map((e, i) => `<div class="activity-row"><span class="activity-marker ${i === 0 ? 'latest' : ''}">${icon(i === 0 ? 'pulse' : 'check')}</span><div><p>${h(e.text)}</p><small>${e.real ? "AI-команда · реальний запуск" : "Демонстраційний сценарій"}</small></div><time>${new Date(e.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('') : '<div class="empty compact">Події з’являться після першого запуску.</div>'}</div>`;
}
function overview() {
  const p = project();
  return `<section class="mission-hero"><div class="hero-copy"><div class="eyebrow"><span class="hero-beacon"></span> MISSION CONTROL <span class="hero-coordinate">/ 001</span></div><h1>Ваш центр керування<br><span>командним інтелектом.</span></h1><p>Кожен агент — частина сузір’я.<br>Поєднайте їхні можливості для вашої наступної місії.</p><div class="hero-actions">${button('new-project', 'Новий проєкт', 'plus', 'btn primary')}<a class="hero-link" href="#projects">Переглянути проєкти ${icon('arrow')}</a></div></div><div class="orbital-art" aria-hidden="true"><img src="/orbital.svg" alt=""><span class="orbital-label">MULTI-AGENT CONSTELLATION</span></div><span class="hero-corner">LOCAL SPACE</span></section><section class="solar-overview-section"><div class="section-heading"><h2>Сонячна система оркестратора <span>LIVE</span></h2><button type="button" class="text-button" data-action="open-project" data-id="${h(p.id)}">Відкрити проєкт ${icon('arrow')}</button></div><div id="solar-stage" data-compact="true"></div></section>${stats(p)}<section><div class="section-heading"><h2>Ваші проєкти <span>${state.projects.length}</span></h2><a href="#projects">Усі проєкти ${icon('arrow')}</a></div><div class="project-cards">${state.projects.slice(0, 2).map(projectCard).join('')}<button type="button" class="new-project-card" data-action="new-project"><span>${icon('plus')}</span><strong>Створити проєкт</strong><p>Нова мета. Нова команда.<br>Наступний результат.</p></button></div></section><div class="overview-bottom"><section class="panel"><div class="panel-heading"><h2>Журнал місії</h2><span class="muted text-small">${h(p.name)}</span></div>${activity(p, 4)}</section><section class="panel next-step"><span class="eyebrow">НАСТУПНИЙ КРОК</span><div class="step-illustration">${icon('orbit')}</div><h2>Виведіть команду на орбіту</h2><p>Перегляньте граф задач, налаштуйте виконавців і запустіть команду.</p>${button('open-project', 'Відкрити робочий простір', 'arrow', 'btn', `data-id="${h(p.id)}"`)}</section></div>`;
}
function runControls(p) {
  if (p.execution?.hostChecking || (p.execution?.id && verifyingHost.has(p.execution.id))) return button('noop','Локальна перевірка…','clock','btn','disabled');
  if(p.execution?.canClarify){
    const task=p.execution.tasks.find(task=>task.canVerifyOnHost);
    if(task)return button('verify-host-run','Запустити локальні перевірки','play','btn primary',`data-id="${h(task.id)}"`);
    if(p.execution.tasks.some(hasVerificationChecks))return button('verify-blocked-run','Додати результати перевірок','file','btn');
    return button('clarify-run','Уточнити вимоги','spark','btn primary');
  }
  if (p.execution?.draining) return button('noop','Зупиняється…','clock','btn','disabled');
  if (p.status === 'running') return `${button('pause', 'Пауза', 'pause')}${button('cancel', 'Зупинити', 'stop', 'btn danger-quiet')}`;
  if (p.status === 'paused') return `${button('resume', 'Продовжити', 'play', 'btn primary')}${button('cancel', 'Зупинити', 'stop')}`;
  if (p.status === 'cancelled' && p.execution?.canResumeCancelled) {
    const busy = resumingCancelled.has(p.execution.id);
    return button('resume-cancelled-run', busy ? 'Перевіряємо доступ…' : 'Продовжити після скасування', 'play', 'btn primary',
      busy || !execution?.ready ? 'disabled' : '');
  }
  return button('real-start','Запустити AI-команду','play','btn primary',execution?.ready?'':'disabled') + button('start','Демо','','btn');
}
function projectPage() {
  const p = project();
  const tabs = [['plan', 'Сонячна система'], ['team', 'План'], ['activity', 'Активність'], ['artifacts', 'Результати'], ['config', 'Налаштування']];
  const streamState = execution?.streamState?.(p.execution?.id) ?? null;
  return `<div class="project-intro"><div><div class="eyebrow"><span class="project-dot orange"></span> ПРОЄКТ / РЕВІЗІЯ ${Number(p.revision) || 1}</div><h1>${h(p.name)}</h1><p>${h(p.description)}</p></div><div class="heading-actions">${button('edit-project', '', 'settings', 'btn icon-btn', 'aria-label="Редагувати проєкт"')}${runControls(p)}</div></div><div class="project-meta">${badge(p.status)}<span>${icon('users')}${p.team.length} агенти</span><span>${icon('shield')}Збалансований режим</span><span>${icon('code')}${p.execution?.mode==='real'?'Реальний запуск AI-команди':'План проєкту / демо доступне окремо'}</span></div>${executionPanel(p,h,button,streamState)}<div class="tabs" data-live-key="project-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" role="tab" aria-selected="${tab === id}" class="${tab === id ? 'selected' : ''}" data-action="tab" data-id="${id}">${label}</button>`).join('')}</div>${tab === 'plan' ? plan(p) : tab === 'team' ? teamPage(p) : tab === 'activity' ? `<section class="panel" data-live-key="activity-panel"><div class="panel-heading"><h2>Журнал запуску</h2>${button('export', 'Експортувати', 'download')}</div>${activity(p, 100)}</section>` : tab === 'artifacts' ? artifacts(p) : config(p)}`;
}
function plan(p) {
  return `<div class="plan-layout"><section class="panel graph-panel"><div class="panel-heading"><div><h2>Сонячна система та задачі <span class="count">${p.tasks.length}</span></h2><p class="muted text-small">Залежності задач і призначені виконавці</p></div>${button('new-task', 'Задача', 'plus', 'btn small-btn', locked(p) ? 'disabled title="Редагування доступне після завершення запуску"' : '')}</div><div class="graph-toolbar"><div class="segmented">${[['solar','orbit','Сонячна система'], ['graph','branch','Граф'], ['list','layers','Список'], ['tree','users','Субагенти']].map(([id, glyph, label]) => button(`view-${id}`, label, glyph, view === id ? 'chosen' : '')).join('')}</div><div class="graph-legend"><span class="legend-dot done"></span>Готово<span class="legend-dot running"></span>В роботі<span class="legend-dot pending"></span>У черзі</div></div>${view === 'solar' ? '<div id="solar-stage" data-live-key="solar-stage"></div>' : view === 'graph' ? graph(p) : view === 'list' ? taskList(p) : tree(p)}<div class="graph-footer"><span>${icon('link')}${view === 'solar' ? 'Натисніть Сонце, планету або супутник для деталей' : 'Натисніть задачу, щоб переглянути деталі'}</span><span>${p.execution?.mode==='real'?`ІЗОЛЬОВАНІ WORKTREE · ${Number(p.concurrency) || 1} паралельних викликів`:'ДЕМО · '+(Number(p.concurrency) || 1)+' паралельні задачі'}</span></div></section><section class="panel team-summary"><div class="panel-heading"><h2>Команда проєкту</h2><button type="button" class="text-button" data-action="tab" data-id="team">${icon('settings')}</button></div>${p.team.map(id => { const a = agent(id); if (!a) return ''; const working = p.tasks.some(t => t.status === 'running' && t.agentIds.includes(id)); return `<button type="button" class="team-member" data-action="agent-detail" data-id="${h(id)}">${avatar(a)}<span><strong>${h(a.name)}</strong><small>${h(a.model)}</small></span><span class="availability ${working ? 'busy' : ''}" title="${working ? 'Виконує задачу' : 'Профіль ролі'}"></span></button>`; }).join('')}<div class="team-summary-footer">${icon('shield')}Агенти працюють у межах<br>прав та бюджету проєкту</div></section></div>${selected ? drawer(p) : ''}`;
}
function taskNode(t, index, style = '') {
  return `<button type="button" class="task-node ${h(t.status)} ${selected === t.id ? 'focused' : ''}" data-action="select-task" data-id="${h(t.id)}" ${style}><div class="task-node-top"><span class="task-number">${String(index + 1).padStart(2, '0')}</span><span class="node-state">${icon(t.status === 'done' ? 'check' : t.status === 'running' ? 'pulse' : 'clock')}</span></div><strong>${h(t.title)}</strong><div class="task-agent">${t.agentIds.map(id => avatar(agent(id), true)).join('')}<span>${h(agent(t.agentIds[0])?.name ?? 'Не призначено')}${t.agentIds.length > 1 ? ` +${t.agentIds.length - 1}` : ''}</span></div><div class="node-bottom">${badge(t.status)}${t.children ? `<span>${icon('branch')} ${t.children.length}</span>` : ''}</div></button>`;
}
function graph(p) {
  const levels = new Map(), byId = new Map(p.tasks.map(t => [t.id, t]));
  const level = (t, visiting = new Set()) => {
    if (!t) return 0;
    if (levels.has(t.id)) return levels.get(t.id);
    if (visiting.has(t.id)) return 0;
    visiting.add(t.id);
    const deps = (t.dependsOn ?? []).map(id => byId.get(id)).filter(Boolean);
    const value = deps.length ? Math.max(...deps.map(d => level(d, visiting))) + 1 : 0;
    visiting.delete(t.id);
    levels.set(t.id, value);
    return value;
  };
  p.tasks.forEach(t => level(t));
  const max = Math.max(0, ...levels.values()), positions = new Map();
  for (let col = 0; col <= max; col++) { const nodes = p.tasks.filter(t => levels.get(t.id) === col); nodes.forEach((t, row) => positions.set(t.id, { x: 25 + col * 246, y: 34 + row * 192 })); }
  const width = Math.max(950, (max + 1) * 246 + 30), rows = Math.max(1, ...Array.from({ length: max + 1 }, (_, col) => p.tasks.filter(t => levels.get(t.id) === col).length)), height = Math.max(340, rows * 192 + 65);
  return `<div class="graph-scroll"><div class="graph-canvas" style="width:${width}px;height:${height}px"><svg class="edges" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7f91b8"/></marker></defs>${p.tasks.flatMap(t => (t.dependsOn ?? []).map(id => { const from = positions.get(id), to = positions.get(t.id); if (!from || !to) return ''; return `<path d="M${from.x + 210},${from.y + 78} C${from.x + 230},${from.y + 78} ${to.x - 20},${to.y + 78} ${to.x - 4},${to.y + 78}" fill="none" stroke="${t.status === 'done' ? '#6ecdb5' : '#4a6084'}" stroke-width="1.5" marker-end="url(#arrow)"/>`; })).join('')}</svg>${p.tasks.map((t, i) => { const pos = positions.get(t.id) ?? { x: 25, y: 34 }; return taskNode(t, i, `style="left:${pos.x}px;top:${pos.y}px"`); }).join('')}<span class="canvas-label">${icon('branch')} WORKFLOW / ${h(p.name.toUpperCase())}</span></div></div>`;
}
function taskList(p) { return `<div class="task-list">${p.tasks.map((t, i) => `<button type="button" data-action="select-task" data-id="${h(t.id)}"><span class="task-number">${String(i+1).padStart(2,'0')}</span><strong>${h(t.title)}</strong><span>${t.agentIds.map(id => avatar(agent(id), true)).join('')}</span>${badge(t.status)}${icon('chevron')}</button>`).join('')}</div>`; }
function tree(p) {
  const rows=tasks=>tasks.map(t=>`<div class="tree-task"><button type="button" data-action="select-task" data-id="${h(t.id)}">${icon(t.parentId?'users':'branch')}<strong>${h(t.title)}</strong>${badge(t.status)}</button>${t.children?.length?`<div class="tree-child">${rows(t.children)}</div>`:''}</div>`).join('');
  const count=p.execution?.tasks?.filter(t=>t.parentId).length??p.tasks.reduce((n,t)=>n+(t.children?.length??0),0);
  return `<div class="subtree"><div class="tree-root">${icon('layers')} ${h(p.name)}</div>${rows(p.tasks)}<p class="muted text-small">${p.execution?.mode==='real'?`Створено дочірніх задач: ${count}. Ліміт глибини: ${Number(p.maxDepth??2)||0}.`:'Демонстраційне дерево задач.'}</p></div>`;
}
function drawer(p) {
  const t = p.tasks.find(t => t.id === selected) ?? p.execution?.tasks?.find(t=>t.id===selected); if (!t) return '';
  const summary = summarizeTaskModels(p, t, state.agents, execution?.routingState(p.id));
  const pill = (billing, billingBoundary) => {
    const b = formatBillingBadge(billing, billingBoundary);
    return `<span class="billing-pill ${h(b.tone)}">${h(b.shortLabel)}</span>`;
  };
  return `<div class="drawer-backdrop" data-live-key="task-drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" data-live-key="task-drawer" aria-label="Деталі задачі"><div class="drawer-heading"><span class="eyebrow">ДЕТАЛІ ЗАДАЧІ</span>${button('close-drawer', '', 'close', 'btn icon-btn', 'aria-label="Закрити деталі"')}</div>${badge(t.status)}<h2>${h(t.title)}</h2><p>${h(t.prompt)}</p><div class="drawer-section"><h3>Рекомендовані профілі (орієнтир)</h3>${summary.recommended.map(a => { const full = agent(a.id); return `<div class="drawer-agent">${avatar(full)}<span>${h(a.name)}<small>Профіль: ${h(a.model)} · ${h(a.provider)}</small></span></div>`; }).join('')}</div><div class="drawer-section"><h3>AI-маршрути (/api/routing)</h3>${summary.routed ? `${summary.routed.stale ? '<p class="route-blocked text-small">Пропозиція застаріла (план змінився після підбору)</p>' : ''}${summary.routed.routes.map(r => `<p><code>${h(r.id)}</code> → <strong>${h(r.model)}</strong> ${pill(r.billing, r.billingBoundary)} <small class="muted">(${h(r.backend)})</small></p>`).join('')}<p class="muted text-small">${h(summary.routed.reason)}</p>` : '<p class="muted text-small">Точні маршрути ще не підібрані. Налаштуйте у вкладці «Команда».</p>'}</div><div class="drawer-section"><h3>Фактичні виконавці запуску</h3>${summary.actual.active ? (summary.actual.agents.length ? summary.actual.agents.map(a => `<p><strong>${h(a.name)}</strong> → ${h(a.model)} ${pill(a.billing, a.billingBoundary)} · ${h(a.access)}</p>`).join('') : '<p class="muted text-small">Для ролей цієї задачі виконавець не зафіксований.</p>') : '<p class="muted text-small">Ще не призначені — обираються перед запуском команди.</p>'}</div><div class="drawer-section"><h3>Залежності</h3>${t.dependsOn.length ? t.dependsOn.map(id => `<div class="dependency">${icon('link')}${h(p.tasks.find(d => d.id === id)?.title)}</div>`).join('') : '<p class="muted">Може починатися незалежно.</p>'}</div>${t.children ? `<div class="drawer-section"><h3>Субагенти</h3>${t.children.map(c => `<div class="dependency">${h(c.title)} ${badge(c.status)}</div>`).join('')}</div>` : ''}<div class="drawer-section"><h3>Результат</h3><p>${h(t.result ?? 'Результат з’явиться після завершення задачі.')}</p></div>${t.error?`<div class="drawer-section execution-error"><h3>Помилка</h3><pre>${h(t.error)}</pre></div>`:""}${planningDetails(p,t)}<div class="drawer-actions">${!t.parentId&&!locked(p) ? button('edit-task', 'Редагувати', 'settings', 'btn', `data-id="${h(t.id)}"`) : ['pending', 'running','waiting_children'].includes(t.status) ? button('cancel-task', 'Скасувати задачу', 'stop', 'btn', `data-id="${h(t.id)}"`) : ''}</div></aside>`;
}
function planningDetails(p,t) {
  const assignment=p.planning?.routing?.assignments.find(a=>a.taskId===t.id);
  return (t.acceptanceCriteria?.length ? '<div class="drawer-section"><h3>Критерії готовності</h3><ul class="acceptance-list">'+t.acceptanceCriteria.map(v=>'<li>'+h(v)+'</li>').join('')+'</ul></div>' : '')
    + (assignment ? '<div class="drawer-section"><h3>Чому обрано ці профілі ролей</h3><p>'+h(assignment.reason)+'</p><small class="muted">'+(assignment.manual?'Призначення скориговано вручну':p.planning.teamSource?.mode==='ai'?'AI-рекомендація профілів':'Демо-правило за навичками')+'</small></div>' : '');
}
function agentCard(a, p) { return `<article class="agent-card"><div class="agent-card-top">${avatar(a)}<span class="provider-pill">${h(a.provider)}</span></div><h3>${h(a.name)}</h3><p>${h(a.role)}</p><div class="model-label">${icon(a.provider === 'CLI' ? 'code' : 'spark')}${h(a.model)}</div><div class="skills">${a.skills.map(s => `<span>${h(s)}</span>`).join('')}</div><div class="agent-card-bottom"><span><i class="demo-indicator"></i> Профіль ролі</span>${button(p ? 'toggle-agent' : 'agent-detail', p ? 'Вилучити' : 'Профіль', p ? 'close' : 'arrow', 'text-button', `data-id="${h(a.id)}" ${p && locked(p) ? 'disabled' : ''}`)}</div></article>`; }
function teamPage(p) {
  const routingEntry = execution?.routingState(p.id);
  return `${renderRoutingSection(p, routingEntry, execution?.catalog, { h, icon, button })}
    <div class="section-heading section-spaced"><div><h2>Рекомендовані профілі ролей (${p.team.length})</h2><p class="muted">Рольові шаблони та навички команди — це орієнтир, а не підтверджений маршрут запуску.</p></div>${button('choose-team', 'Додати агента', 'plus')}</div>
    <div class="agent-grid">${p.team.map(id => agent(id)).filter(Boolean).map(a => agentCard(a, p)).join('')}</div>
    <section class="panel actual-executors-note" data-live-key="actual-executors-note"><div class="panel-heading"><h2>Фактичні виконавці запуску</h2><span class="provider-pill">${p.execution?.mode==='real'?'Зафіксовано у запуску':'Не призначено'}</span></div>${p.execution?.mode==='real' ? `<div class="execution-bindings">${p.execution.agents.map(a => { const b = formatBillingBadge(a.billing, a.billingBoundary); return `<span>${h(a.name)} → <b>${h(a.model)}</b> <span class="billing-pill ${h(b.tone)}">${h(b.shortLabel)}</span><small>${h(a.provider)} · ${h(a.access)}</small></span>`; }).join('')}</div>` : `<div class="info-note">${icon('shield')}Рекомендовані профілі та AI-маршрути (<code>/api/routing</code>) не запускають код самі по собі. Фактичні виконавці й права доступу фіксуються окремо перед реальним запуском команди.</div>`}</section>`;
}
function artifacts(p) {
  p = execution.resultsFor(p);
  const stages = new Map((p.execution?.tasks ?? p.tasks).map(task => [task.id, task]));
  const report = (a, completed) => {
    const attr = `data-id="${h(a.id)}"`;
    return `<article class="panel artifact"><span class="project-glyph ${completed ? 'green' : ''}">${icon('file')}</span>
      <h3>${h(a.name)}</h3><p>${completed ? 'Завершений етап' : 'Звіт етапу'} · ${a.real ? 'Markdown' : 'Демонстрація'}</p>
      <div class="artifact-actions">${button('read-artifact', 'Читати звіт', 'file', 'btn', attr)}${button('download-artifact', 'Завантажити', 'download', 'btn', attr)}</div></article>`;
  };
  const completed = p.artifacts.filter(a => stages.get(a.taskId)?.status === 'done');
  const other = p.artifacts.filter(a => stages.get(a.taskId)?.status !== 'done');
  return `<div class="section-heading results-heading"><h2>Завершені етапи <span>${completed.length}</span></h2>
    <div class="artifact-actions">${button('project-preview', 'Перегляд проєкту', 'play', 'btn primary')}${button('export', 'Експортувати проєкт', 'download')}</div></div>
    ${completed.length ? `<div class="artifact-grid">${completed.map(a => report(a, true)).join('')}</div>` : '<div class="empty panel"><h3>Звіти з’являться після завершення етапів</h3></div>'}
    ${other.length ? `<div class="section-heading results-secondary"><h2>Інші звіти етапів</h2></div><div class="artifact-grid">${other.map(a => report(a, false)).join('')}</div>` : ''}
    <div class="results-secondary">${fileArtifacts(p,h,button)}</div>`;
}

let previewRequest = 0;
async function showProjectPreview(p, url = '') {
  const request = ++previewRequest;
  const title = `Перегляд · ${p.name}`;
  modal(title, '<p class="modal-text project-preview" role="status">Відкриваю перегляд…</p>');
  const loading = $('#modal .project-preview');
  let preview, error;
  try { preview = await execution.projectPreview(p.id, url); }
  catch (cause) { error = cause.message; }
  if (request !== previewRequest || !$('#modal').open || !loading.isConnected) return;
  if (preview?.url) {
    modal(title, `<div class="project-preview">
      <div class="preview-toolbar"><a class="btn" href="${h(preview.url)}" target="_blank" rel="noopener noreferrer">Відкрити в окремій вкладці</a></div>
      <iframe src="${h(preview.url)}" title="${h(p.name)}" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe></div>`);
    return;
  }
  modal(title, `<form id="project-preview-form">
    <p class="modal-alert" ${error ? 'role="alert"' : ''}>${h(error ?? 'Готовий сайт у папці проєкту не знайдено. Можна відкрити локальний сервер проєкту за його адресою.')}</p>
    <label>Адреса локального сервера<input name="url" type="url" required placeholder="http://127.0.0.1:3000/" value="${h(url)}"></label>
    <button class="btn primary" type="submit">Відкрити перегляд</button>
  </form>`);
}
function config(p) { return `<form id="config-form" data-live-key="config-form" class="panel settings-form"><div class="panel-heading"><h2>Налаштування проєкту</h2><span class="muted">Ревізія ${Number(p.revision) || 1}</span></div><label>Назва проєкту<input name="name" required maxlength="80" value="${h(p.name)}"></label><label>Мета та опис<textarea name="description" required maxlength="1000">${h(p.description)}</textarea></label><div class="form-grid"><label>Паралельні задачі<input name="concurrency" type="number" min="1" max="16" required value="${Number(p.concurrency) || 1}"></label><label>Ліміт викликів оркестратора<input name="maxCalls" type="number" min="1" max="10000" required value="${Number(p.maxCalls) || 1}"></label></div><div class="form-grid"><label>Глибина субагентів<input name="maxDepth" type="number" min="0" max="8" required value="${Number(p.maxDepth??2)||0}"></label><label>Ліміт усіх задач<input name="maxTasks" type="number" min="1" max="1000" required value="${Number(p.maxTasks??100)||1}"></label></div><label><input name="allowDelegation" type="checkbox" ${p.allowDelegation!==false?'checked':''}> Дозволити агентам створювати підзадачі</label><p class="muted text-small">Ліміт викликів діє для реального запуску, включно з усіма призначеними агентами. Делегування також витрачає виклики. Незалежні задачі працюють в окремих worktree.</p><div class="form-footer">${button('export', 'Експортувати JSON', 'download')}<button class="btn primary" type="submit">Зберегти ревізію</button></div></form>`; }
function connections() { return renderConnections(execution?.catalog,execution?.scanning,{h,button,heading,loading:execution?.loadingCatalog,error:execution?.catalogError}); }
function main() {
  if (route === 'project') return projectPage();
  if (route === 'projects') return `${heading('PROJECTS', 'Усе починається з мети.', 'Ваші проєкти та команди в одному робочому просторі.', button('new-project','Новий проєкт','plus','btn primary'))}<div class="project-cards full">${state.projects.map(projectCard).join('')}</div>`;
  if (route === 'agents') return `${heading('AGENT LIBRARY', 'Правильний агент для кожної задачі.', 'Моделі з твоїх підключень та профілі команди.',button('new-agent','Новий профіль','plus','btn primary'))}${renderAgentLibrary(execution?.catalog,state.agents,agentLibraryFilters,{h,icon,button,avatar,renderProfile:a=>agentCard(a),loading:execution?.scanning||execution?.loadingCatalog,error:execution?.catalogError})}`;
  if (route === 'connections') return connections();
  if (route === 'runs') return `${heading('RUN HISTORY','Виконання під контролем.','Історія реальних запусків та стан проєктів.')}${runHistory(execution?.history??[],h,button,labels)}<section class="panel run-list">${state.projects.map(p => `<button type="button" data-action="open-project" data-id="${h(p.id)}"><span class="project-glyph orange">${icon('pulse')}</span><span><strong>${h(p.name)}</strong><small>${p.events.length ? h(p.events[0].text) : 'Ще не запускався'}</small></span>${badge(p.status)}${icon('chevron')}</button>`).join('')}</section>`;
  if (route === 'settings') return `${heading('WORKSPACE SETTINGS','Ваш простір. Ваші правила.','Локальний сервер, кеш браузера та історія запусків.')}<section class="panel workspace-settings"><h2>Зберігання даних</h2><p>Проєкти й профілі зберігаються локальним сервером; браузер тримає кеш. Історія реальних запусків та знімки планів зберігаються окремо й не замінюються скиданням демо. Реальні секрети не вводяться й не зберігаються.</p><div class="settings-row"><span>Експортувати робочий простір<small>Усі проєкти та профілі у JSON</small></span>${button('export-all','Експортувати','download')}</div><div class="settings-row"><span>Відновити демонстрацію<small>Поточні локальні дані буде замінено стартовими</small></span>${button('confirm-reset','Відновити','settings')}</div></section>`;
  return overview();
}
function solarCallbacks(compact) {
  const p = project();
  return {
    compact,
    canRealStart: Boolean(execution?.ready),
    routing: execution?.routingState(p.id) ?? null,
    onSelectTask: taskId => {
      if (route !== 'project') { route = 'project'; location.hash = 'project'; tab = 'plan'; }
      selected = taskId;
      render();
    },
    onCancelTask: taskId => {
      if (!taskId) return;
      if (p.execution?.mode === 'real') {
        void execution.control(p, 'cancel-task', taskId).catch(error => toast(error.message));
        return;
      }
      cancelTask(p, taskId);
      save(); render();
    },
    onRunAction: actionOrStatus => {
      if (actionOrStatus === 'view-artifacts') {
        route = 'project'; location.hash = 'project'; tab = 'artifacts';
        render();
        return;
      }
      if (actionOrStatus === 'real-start') {
        void execution?.setup(p).catch(error => toast(error.message));
        return;
      }
      if (actionOrStatus === 'start') {
        if (p.execution?.id) execution?.stopStream?.(p.execution.id);
        p.execution = null; start(p); toast('Запущено демо. Реальні моделі не викликаються.');
        save(); render();
        return;
      }
      const act = actionOrStatus === 'running' ? 'pause' : actionOrStatus === 'paused' ? 'resume' : actionOrStatus;
      if (p.execution?.mode === 'real') {
        if (['pause', 'resume', 'cancel'].includes(act)) void execution.control(p, act).catch(error => toast(error.message));
        return;
      }
      if (act === 'pause') { p.status = 'paused'; log(p, 'Демонстрацію поставлено на паузу'); }
      else if (act === 'resume') { p.status = 'running'; log(p, 'Демонстрацію продовжено'); }
      else if (act === 'cancel') {
        p.tasks.filter(t => ['running', 'pending'].includes(t.status)).forEach(t => {
          t.status = 'cancelled';
          t.children?.forEach(c => { c.status = 'cancelled'; });
        });
        p.status = 'cancelled';
        log(p, 'Демонстрацію зупинено користувачем');
      } else {
        if (p.execution?.id) execution?.stopStream?.(p.execution.id);
        p.execution = null; start(p); toast('Запущено демо. Реальні моделі не викликаються.');
      }
      save(); render();
    }
  };
}
function render({executionOnly=false}={}) {
  const scroll = window.scrollY;
  const existingStage = document.querySelector('#solar-stage');
  const existingViewport = existingStage?.querySelector('.solar-viewport');
  const html = `<a class="skip-link" href="#main-content" data-action="skip-content">Перейти до вмісту</a>${sidebar()}<div class="shell" ${navOpen&&mobileNavigation.matches?'inert':''}>${header()}<main id="main-content" tabindex="-1">${main()}<footer class="page-footer"><span>orcestrator <b>/</b> Ваш простір для командного інтелекту</span><span>UI Preview · v0.1</span></footer></main></div>`;
  if(executionOnly || route==='agents'&&document.activeElement?.matches('[data-agent-filter]'))patchLiveDom($('#app'),html);else $('#app').innerHTML=html;
  const nextStage = document.querySelector('#solar-stage');
  if (nextStage) {
    const compact = nextStage.dataset.compact === 'true';
    if (existingViewport && existingStage!==nextStage) {
      nextStage.appendChild(existingViewport);
    }
    renderSolarStage(nextStage, project(), state.agents, labels, solarCallbacks(compact));
  }
  document.querySelector('.team-summary .text-button')?.setAttribute('aria-label', 'Редагувати команду');
  window.scrollTo(0, scroll);
}
function modal(title, body, footer = '') { const d = $('#modal'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'modal-title'); d.innerHTML = `<div class="modal-heading"><div><span class="eyebrow">ORCESTRATOR WORKSPACE</span><h2 id="modal-title">${h(title)}</h2></div>${button('close-modal','','close','btn icon-btn','aria-label="Закрити вікно"')}</div>${body}${footer}`; if (!d.open) d.showModal(); }
function checks(ids, name = 'team') { return availableProfiles().map(a => `<label class="agent-option">${avatar(a)}<span><strong>${h(a.name)}</strong><small>${h(a.model)}${a.backend?' · '+h(providerNames[a.backend]??a.backend):''}</small></span><input type="checkbox" name="${name}" value="${h(a.id)}" ${ids.includes(a.id) ? 'checked' : ''}></label>`).join(''); }
function newProject() { creation.open(); }

function taskModal(task) {
  const p = project();
  if (locked(p)) { toast('Завершіть або скасуйте запуск перед зміною плану'); return; }
  modal(task ? 'Редагувати задачу' : 'Нова задача', `<form id="task-form" data-id="${h(task?.id ?? '')}"><label>Назва<input name="title" required maxlength="100" value="${h(task?.title ?? '')}"></label><label>Інструкція<textarea name="prompt" required maxlength="2000">${h(task?.prompt ?? '')}</textarea></label><fieldset><legend>Виконавці — можна обрати кількох</legend>${p.team.map(id => { const a=agent(id); return `<label class="checkline"><input type="checkbox" name="agents" value="${h(id)}" ${task?.agentIds.includes(id) ? 'checked' : ''}>${h(a?.name)}</label>`; }).join('')}</fieldset><fieldset><legend>Почати після завершення</legend>${p.tasks.filter(t => t.id !== task?.id).map(t => `<label class="checkline"><input type="checkbox" name="deps" value="${h(t.id)}" ${task?.dependsOn.includes(t.id) ? 'checked' : ''}>${h(t.title)}</label>`).join('') || '<span class="muted">Перша задача у плані</span>'}</fieldset><div class="form-footer">${button('close-modal','Скасувати')}<button type="submit" class="btn primary">Зберегти задачу</button></div></form>`);
}
function download(name, content, type = 'application/json') { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name.replace(/[<>:"/\\|?*]/g, '-'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function locked(p = project()) { return ['running','paused'].includes(p.status) || Boolean(p.execution?.draining || p.execution?.hostChecking || (p.execution?.id && verifyingHost.has(p.execution.id))); }
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]'); if (!target || target.disabled) return;
  if(target.hasAttribute('data-creation'))return;
  const action = target.dataset.action, id = target.dataset.id, p = project();
  try {
    if(action==='skip-content'){event.preventDefault();$('#main-content')?.focus();return;}
    if (action === 'toggle-nav') { navOpen = !navOpen; render({ executionOnly: true }); if (navOpen) document.querySelector('#app-sidebar .sidebar-close')?.focus(); else document.querySelector('.mobile-nav-btn')?.focus(); return; }
    if (action === 'close-nav') { navOpen = false; render({ executionOnly: true }); document.querySelector('.mobile-nav-btn')?.focus(); return; }
    if (!execution?.ready && !['close-modal','view-solar','view-graph','view-list','view-tree'].includes(action)) { toast('Дочекайтеся відновлення даних із сервера'); return; }
    if (action === 'scan-connections') { await execution.scan(); return; }
    if (action === 'agent-library-reset') { agentLibraryFilters={query:'',backend:'',billing:'',status:'all'};render({executionOnly:true});return; }
    if (action === 'agent-filter-preset') {
      const st = target.dataset.status; const bl = target.dataset.billing;
      if (st !== undefined) agentLibraryFilters.status = st;
      if (bl !== undefined) agentLibraryFilters.billing = agentLibraryFilters.billing === bl ? '' : bl;
      render({ executionOnly: true });
      return;
    }
    if (action === 'catalog-agent-detail' || action === 'catalog-agent-add') {
      const item=agentLibraryGroups(execution.catalog,state.agents).find(item=>item.id===id);
      if(!item)throw Error('Модель більше не знайдено: оновіть каталог');
      if(action==='catalog-agent-detail') {
        const billing=formatBillingBadge(item.route?.billing,item.route?.billingBoundary);
        modal(item.profile.name,`<div class="agent-detail">${avatar(item.profile)}<div class="detail-pair"><span>Провайдер</span><strong>${h(providerNames[item.profile.backend]??item.profile.backend)}</strong></div><div class="detail-pair"><span>Модель</span><strong>${h(item.profile.model)}</strong></div><p><span class="billing-pill ${billing.tone}">${h(billing.label)}</span></p><p class="${item.available?'route-allowed':'route-blocked'}">${h(item.reason)}</p><p class="muted">${h(item.route?.description??'')}</p><p class="muted text-small">Рівень роздумів обирається при додаванні в команду. Доступ перевіряється перед кожним запуском. Додавання не запускає модель.</p>${button('catalog-agent-add','Додати в команду','plus','btn primary',`data-id="${h(id)}" ${item.available?'':'disabled'}`)}</div>`);
      } else {
        if(!item.available)throw Error(item.reason);
        const projects=state.projects.filter(p=>!['running','paused'].includes(p.status)&&!p.execution?.draining);
        const choices=reasoningChoices(item),availableChoices=choices.filter(c=>c.item.available);
        modal('Додати агента в команду',`<form id="catalog-agent-form" data-group="${h(id)}"><p><strong>${h(item.profile.name)}</strong> · ${h(providerNames[item.profile.backend]??item.profile.backend)}</p><label>Рівень роздумів<select name="reasoning" required>${availableChoices.length!==1?'<option value="" selected disabled>Оберіть рівень</option>':''}${choices.map(c=>`<option value="${h(c.value)}" ${!c.item.available?'disabled':''} ${availableChoices.length===1&&c.item.available?'selected':''}>${h(c.label)}${c.item.available?'':' · недоступний'}</option>`).join('')}</select></label><p class="muted text-small">Рівень визначає глибину опрацювання та витрати включеної квоти. Доступ перевіряється перед запуском.</p><label>Проєкт<select name="project" required>${projects.map(p=>`<option value="${h(p.id)}" ${p.id===state.activeId?'selected':''}>${h(p.name)}</option>`).join('')}</select></label>${!projects.length?'<p class="route-blocked">Завершіть активний запуск або створіть новий проєкт.</p>':'<p class="muted">Агент стане доступним для призначення задач у вибраному проєкті.</p>'}<div class="form-footer">${button('close-modal','Скасувати')}<button type="submit" class="btn primary" ${projects.length?'':'disabled'}>Додати в команду</button></div></form>`);
      }
      return;
    }
    if (action === 'routing-refresh') { await execution.loadRouting(p.id, { silent: false }); return; }
    if (action === 'routing-preset') {
      const mode = target.dataset.mode === 'text' ? 'text' : 'write';
      const requirements = Object.fromEntries(p.tasks.filter(t => !t.parentId).map(t => [t.id, mode]));
      execution.updateRoutingDraft(p.id, { requirements });
      render();
      return;
    }
    if (action === 'real-start') { await execution.setup(p); return; }
    if (action === 'continue-run') { await execution.control(p,'continue'); return; }
    if (action === 'retry-access-run') { await execution.control(p,'retry-access'); return; }
    if (action === 'retry-budget-run') { await execution.control(p,'retry-budget'); return; }
    if (action === 'change-run-budget') { execution.changeBudget(p); return; }
    if (action === 'balance-gemini-run') { await execution.control(p,'balance-gemini'); toast('Розподіл нерозпочатих задач оновлено'); return; }
    if (action === 'verify-blocked-run') { execution.clarify(p,true); return; }
    if (action === 'verify-host-run') {
      const runId = p.execution?.id;
      if (!runId || p.execution.hostChecking || verifyingHost.has(runId)) return;
      verifyingHost.add(runId);
      render({executionOnly:true});
      try { await execution.control(p,'verify-host',id); }
      finally { verifyingHost.delete(runId); render({executionOnly:true}); }
      return;
    }
    if (action === 'resume-cancelled-run') {
      const runId = p.execution.id;
      if (resumingCancelled.has(runId)) return;
      resumingCancelled.add(runId);
      render({executionOnly:true});
      try { await execution.control(p,'resume-cancelled'); }
      finally { resumingCancelled.delete(runId); render({executionOnly:true}); }
      return;
    }
    if (action === 'clarify-run') { execution.clarify(p); return; }
    if (action === 'view-run') { await execution.viewRun(id); return; }
    if (action === 'execution-file') { await execution.file(execution.resultsFor(p),target.dataset.path); return; }
    if (p.execution?.mode==='real' && ['pause','resume','cancel','cancel-task'].includes(action)) { await execution.control(p,action,id); return; }
    if (action === 'new-project') { navOpen = false; newProject(); return; }
    if (action === 'close-modal') { $('#modal').close(); return; }
    if (action === 'workspace') { navOpen = false; navigate('settings'); return; }
    if (action === 'open-project') { navOpen = false; state.activeId = id; selected = null; tab = 'plan'; save(); if (route === 'project') render(); else navigate('project'); $('#modal').close(); void execution.loadRouting(id, { silent: true }); return; }
    if (action === 'tab') { tab = id; if (id === 'team' && !execution.routingState(p.id)?.proposal && !execution.routingState(p.id)?.loading) void execution.loadRouting(p.id, { silent: true }); if (id === 'artifacts') void execution.loadResults(p).catch(error=>toast(error.message)); }
    else if (action.startsWith('view-')) view = action.slice(5);
    else if (action === 'select-task') selected = id;
    else if (action === 'close-drawer') selected = null;
    else if (action === 'start') { if (p.execution?.id) execution?.stopStream?.(p.execution.id); p.execution=null; start(p); toast('Запущено демо. Реальні моделі не викликаються.'); }
    else if (action === 'pause') { p.status = 'paused'; log(p, 'Демонстрацію поставлено на паузу'); }
    else if (action === 'resume') { p.status = 'running'; log(p, 'Демонстрацію продовжено'); }
    else if (action === 'cancel') { p.tasks.filter(t => ['running', 'pending'].includes(t.status)).forEach(t => { t.status = 'cancelled'; t.children?.forEach(c => c.status = 'cancelled'); }); p.status = 'cancelled'; log(p, 'Демонстрацію зупинено користувачем'); }
    else if (action === 'cancel-task') cancelTask(p, id);
    else if (action === 'new-task') { taskModal(); return; }
    else if (action === 'edit-task') { taskModal(p.tasks.find(t => t.id === id)); return; }
    else if (action === 'edit-project') { tab = 'config'; }
    else if (action === 'choose-team') { if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною команди'); modal('Команда проєкту', `<form id="team-form"><div class="agent-options">${checks(p.team)}</div><div class="form-footer">${button('close-modal','Скасувати')}<button class="btn primary" type="submit">Зберегти команду</button></div></form>`); return; }
    else if (action === 'toggle-agent') { if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною команди'); if (p.tasks.some(t => t.agentIds.includes(id))) throw new Error('Спочатку перепризначте задачі цього агента'); if (p.team.length <= 1) throw new Error('Залиште щонайменше одного агента'); p.team = p.team.filter(a => a !== id); p.revision++; }
    else if (action === 'agent-detail') { const a = agent(id); if (!a) return; modal(a.name, `<div class="agent-detail">${avatar(a)}<p>${h(a.role)}</p><div class="detail-pair"><span>Модель / backend</span><strong>${h(a.model)}</strong></div><div class="detail-pair"><span>Спосіб виконання</span><strong>${h(a.provider)}</strong></div><div class="skills">${a.skills.map(s => `<span>${h(s)}</span>`).join('')}</div><div class="info-note">${icon('shield')}Профіль зберігає роль та модель. Фактичний виконавець і права показуються перед запуском; доступ перевіряється повторно.</div></div>`); return; }
    else if (action === 'new-agent') { modal('Новий профіль агента', `<form id="agent-form"><label>Назва<input name="name" required maxlength="60"></label><label>Роль<input name="role" required maxlength="120" placeholder="Наприклад, перевірка безпеки"></label><div class="form-grid"><label>Backend<select name="provider"><option>API</option><option>CLI</option><option>Local</option></select></label><label>Модель / CLI<input name="model" required maxlength="80" placeholder="Назва моделі"></label></div><label>Навички через кому<input name="skills" required maxlength="160" placeholder="review, testing"></label><div class="form-footer">${button('close-modal','Скасувати')}<button type="submit" class="btn primary">Створити профіль</button></div></form>`); return; }
    else if (action === 'export' || action === 'export-all') { download(action === 'export-all' ? 'orcestrator-workspace.json' : `${p.name}.json`, JSON.stringify(action === 'export-all' ? state : p, null, 2)); toast('JSON експортовано'); return; }
    else if (action === 'project-preview') { await showProjectPreview(p); return; }
    else if (action === 'read-artifact') {
      const a = execution.resultsFor(p).artifacts.find(item => item.id === id);
      if (a) modal(a.name, `<pre class="artifact-report">${h(a.text)}</pre>`, `<div class="form-footer">${button('download-artifact', 'Завантажити', 'download', 'btn', `data-id="${h(a.id)}"`)}</div>`);
      return;
    }
    else if (action === 'download-artifact') { const a = execution.resultsFor(p).artifacts.find(a => a.id === id); if (!a) return; download(a.name, a.text, 'text/markdown;charset=utf-8'); return; }
    else if (action === 'confirm-reset') { modal('Відновити демонстраційні дані?', '<p class="modal-text">Ваші локальні проєкти та профілі буде замінено початковим прикладом. Перед цим можна експортувати робочий простір.</p>', `<div class="form-footer">${button('close-modal','Скасувати')}${button('reset','Відновити демо','','btn primary')}</div>`); return; }
    else if (action === 'reset') { if(execution.history.some(r=>['running','paused'].includes(r.status)))throw new Error('Спочатку завершіть або скасуйте реальні запуски'); execution?.stopAllStreams?.(); execution?.clearRoutingStates?.(); state = seed(); $('#modal').close(); toast('Демонстраційні дані відновлено'); }
    else if (action === 'search') { modal('Знайти у просторі', '<label class="search-field">Проєкти та агенти<input id="quick-search" type="search" placeholder="Почніть вводити назву…" autofocus></label><div id="search-results"></div>'); searchResults(''); return; }
    save(); render();
  } catch (error) { toast(error.message); }
});
document.addEventListener('submit', event => {
  if (['creation-project','execution-form','execution-clarify-form','execution-budget-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (!execution?.ready) { toast('Дочекайтеся відновлення даних із сервера'); return; }
  const form = event.target, data = new FormData(form), p = project();
  if (form.id === 'project-preview-form') { void showProjectPreview(p, String(data.get('url') ?? '')); return; }
  try {
    if (form.id === 'routing-form') {
      const targetProject = state.projects.find(item => item.id === form.dataset.project) ?? p;
      const requirements = Object.fromEntries(targetProject.tasks.filter(t => !t.parentId).map(t => [t.id, data.get(`req-${t.id}`) === 'text' ? 'text' : 'write']));
      const formConfig = {
        priority: String(data.get('priority') ?? 'balanced'),
        maxAgentsPerTask: Number(data.get('maxAgentsPerTask') ?? 3),
        managerRouteId: String(data.get('managerRouteId') ?? ''),
        requirements
      };
      void execution.proposeRouting(targetProject.id, formConfig);
      return;
    }
    if (form.id === 'team-form') {
      if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною команди'); const team = data.getAll('team'); if (!team.length) throw new Error('Оберіть щонайменше одного агента');
      if (p.tasks.some(t => t.agentIds.some(id => !team.includes(id)))) throw new Error('Спочатку перепризначте задачі агентів, яких вилучаєте'); retainProfiles(team); p.team = team; p.revision++; log(p, 'Оновлено склад команди'); toast('Команду збережено');
    } else if (form.id === 'catalog-agent-form') {
      const choice=resolveReasoningChoice(execution.catalog,state.agents,form.dataset.group,String(data.get('reasoning')));
      const result=addCatalogAgentToProject(state,execution.catalog,choice.item.id,String(data.get('project')),{reasoningEffort:choice.reasoningEffort});
      if(result.changed)log(result.project,`Додано агента ${result.profile.name}`);
      toast(result.changed?'Агента додано в команду':'Агент уже є в цій команді');
    } else if (form.id === 'task-form') {
      if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною плану');
      const agentIds = data.getAll('agents'); if (!agentIds.length) throw new Error('Оберіть виконавця');
      const title = data.get('title').trim(), prompt = data.get('prompt').trim(); if (!title || !prompt) throw new Error('Заповніть назву й інструкцію');
      const old = p.tasks.find(t => t.id === form.dataset.id), next = { skills:old?.skills??[], acceptanceCriteria:old?.acceptanceCriteria??[], id: old?.id ?? uid(), title, prompt, agentIds, dependsOn: data.getAll('deps'), status: 'pending' };
      const tasks = old ? p.tasks.map(t => t.id === old.id ? next : t) : [...p.tasks, next]; validateTasks(tasks); p.tasks = tasks; p.revision++; p.status = 'idle'; selected = next.id; log(p, `Оновлено план: ${title}`); toast('Задачу збережено');
    } else if (form.id === 'agent-form') {
      const name = data.get('name').trim(), role = data.get('role').trim(), model = data.get('model').trim(), skills = data.get('skills').split(',').map(s => s.trim()).filter(Boolean);
      if (!name || !role || !model || !skills.length) throw new Error('Заповніть профіль та навички'); state.agents.push({ id: uid(), name, role, model, skills, provider: data.get('provider'), initials: name.slice(0, 2).toUpperCase(), color: ['orange','blue','purple','green'][state.agents.length % 4] }); toast('Профіль агента створено');
    } else if (form.id === 'config-form') {
      if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною налаштувань');
      const name = data.get('name').trim(), description = data.get('description').trim(); if (!name || !description) throw new Error('Заповніть назву й мету');
      p.name = name; p.description = description; p.concurrency = Number(data.get('concurrency')); p.maxCalls = Number(data.get('maxCalls')); p.maxDepth=Number(data.get('maxDepth')); p.maxTasks=Number(data.get('maxTasks')); p.allowDelegation=data.has('allowDelegation'); p.revision++;
      form.querySelectorAll('[data-user-edited]').forEach(el => { delete el.dataset.userEdited; });
      log(p, `Збережено ревізію ${p.revision}`); toast('Налаштування збережено');
    }
    save(); $('#modal').close(); render();
  } catch (error) { toast(error.message); }
});
function searchResults(value) { const query = value.toLocaleLowerCase(); $('#search-results').innerHTML = state.projects.filter(p => p.name.toLocaleLowerCase().includes(query)).map(p => `<button type="button" class="search-result" data-action="open-project" data-id="${h(p.id)}">${icon('layers')}<span>${h(p.name)}<small>Проєкт</small></span>${icon('arrow')}</button>`).join('') + state.agents.filter(a => a.name.toLocaleLowerCase().includes(query)).map(a => `<button type="button" class="search-result" data-action="agent-detail" data-id="${h(a.id)}">${avatar(a, true)}<span>${h(a.name)}<small>Агент</small></span>${icon('arrow')}</button>`).join(''); if (!$('#search-results').innerHTML) $('#search-results').innerHTML = '<p class="empty compact">Нічого не знайдено</p>'; }
document.addEventListener('change', event => {
  if(event.target.dataset.agentFilter){agentLibraryFilters[event.target.dataset.agentFilter]=event.target.value;render({executionOnly:true});return;}
  if (event.target.matches?.('#config-form input, #config-form select, #routing-form select')) {
    event.target.dataset.userEdited = '1';
  }
  const routingForm = event.target.closest?.('#routing-form');
  if (!routingForm || !execution) return;
  const targetProject = state.projects.find(item => item.id === routingForm.dataset.project);
  if (!targetProject) return;
  const data = new FormData(routingForm);
  const requirements = Object.fromEntries(targetProject.tasks.filter(t => !t.parentId).map(t => [t.id, data.get(`req-${t.id}`) === 'text' ? 'text' : 'write']));
  execution.updateRoutingDraft(targetProject.id, {
    priority: String(data.get('priority') ?? 'balanced'),
    maxAgentsPerTask: Number(data.get('maxAgentsPerTask') ?? 3),
    managerRouteId: String(data.get('managerRouteId') ?? ''),
    requirements
  });
});
document.addEventListener('input', event => {
  if(event.target.dataset.agentFilter==='query'){agentLibraryFilters.query=event.target.value;render({executionOnly:true});}
  else if (event.target.id === 'quick-search') searchResults(event.target.value);
  else if (event.target.matches?.('#config-form input, #config-form textarea')) event.target.dataset.userEdited = '1';
});
document.addEventListener('keydown', event => {
  if($('#modal').open)return;
  if(navOpen&&mobileNavigation.matches&&event.key==='Tab'){
    const sidebar=$('#app-sidebar'),items=[...sidebar.querySelectorAll('a[href],button:not([disabled])')].filter(el=>el.getClientRects().length);
    const first=items[0],last=items.at(-1),active=document.activeElement;
    if(first&&((event.shiftKey&&(active===first||!sidebar.contains(active)))||(!event.shiftKey&&(active===last||!sidebar.contains(active))))){event.preventDefault();(event.shiftKey?last:first).focus();}
  }
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(navOpen){navOpen=false;render({executionOnly:true});}document.querySelector('[data-action="search"]').click();}
  if(event.key==='Escape'){if(navOpen){navOpen=false;render({executionOnly:true});document.querySelector('.mobile-nav-btn')?.focus();}else if(selected){selected=null;render();}}
});
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
setInterval(() => { let changed = false; for (const p of state.projects) changed = (p.execution?.mode==='real'?false:tick(p)) || changed; if (changed) { save(); if (!$('#modal').open) render({ executionOnly: true }); } }, 1600);
const creation = createProjectWizard({ modal, h, icon, button, agents: availableProfiles, notify: toast,
  listFolders:path=>execution.listFolders(path),
  getCatalog:()=>execution?.catalog,
  scanConnections:()=>execution?.scan(),
  proposeDraft:(input,signal)=>execution.proposeDraft(input,signal),
  async onCreate(draft, { autoStart = false } = {}) {
    const {project:next,profiles}=composeProject(draft,availableProfiles());
    log(next,draft.teamSource?.mode==='ai'?'Прийнято AI-план і точне призначення моделей':'Прийнято демонстраційний план і підбір за правилами');
    await execution.createPlannedProject({project:next,profiles,projectParent:draft.projectParent,...(draft.teamSource?.mode==='ai'?{routingDraftId:draft.proposal.id}:{})});
    tab='plan';selected=null;route='project';location.hash='project';
    render();
    if (autoStart && draft.teamSource?.mode === 'ai' && draft.proposal) {
      try {
        await execution.launchProposal(next, draft.proposal);
        return;
      } catch (error) {
        toast(`Проєкт створено, але автозапуск не вдався: ${error.message}`);
        return;
      }
    }
    toast('Проєкт створено з прийнятим планом і командою');
  }
});
execution = createExecutionClient({getState:()=>state,setState:value=>{state=value;},render,saveLocal:()=>save(true),notify:toast,modal,h,button,download});
render(); execution.init();
