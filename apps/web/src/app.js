import { createProjectWizard } from './create-project.js';
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
let state;
try { state = JSON.parse(localStorage.getItem('orcestrator.ui.v1')); if (state?.version !== 1 || !state.projects?.length) state = seed(); } catch { state = seed(); }
// A closed prototype tab does not imply a live background execution.
for (const p of state.projects) if (p.status === 'running') { p.status = 'paused'; log(p, 'Демо відновлено на паузі після відкриття сторінки'); }
let route = location.hash.slice(1) || 'overview', tab = 'plan', view = 'graph', selected = null, search = '';
const project = () => state.projects.find(p => p.id === state.activeId) ?? state.projects[0];
const agent = id => state.agents.find(a => a.id === id);
function save() { try { localStorage.setItem('orcestrator.ui.v1', JSON.stringify(state)); } catch { toast('Не вдалося зберегти дані у браузері. Експортуйте проєкт.'); } }
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
  setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}
function navigate(next) { location.hash = next; }
window.addEventListener('hashchange', () => { route = location.hash.slice(1) || 'overview'; selected = null; search = ''; render(); });
function sidebar() {
  const nav = [['overview', 'grid', 'Огляд простору'], ['projects', 'layers', 'Проєкти'], ['agents', 'users', 'Агенти'], ['runs', 'pulse', 'Запуски'], ['connections', 'plug', 'Підключення']];
  return `<aside class="sidebar"><a class="brand" href="#overview"><span class="brand-symbol">${icon('orbit')}</span>orcestrator<span class="brand-dot">®</span></a><button class="workspace" data-action="workspace"><span class="workspace-icon">W</span><span>Мій робочий простір<small>Personal workspace</small></span>${icon('chevron')}</button><div class="nav-label">РОБОЧИЙ ПРОСТІР</div><nav>${nav.map(([id, glyph, label]) => `<a href="#${id}" class="nav-item ${route === id || (route === 'project' && id === 'projects') ? 'active' : ''}">${icon(glyph)}<span>${label}</span>${id === 'projects' ? `<span class="nav-count">${state.projects.length}</span>` : ''}</a>`).join('')}</nav><div class="nav-label project-label">МОЇ ПРОЄКТИ<button data-action="new-project" aria-label="Створити проєкт">${icon('plus')}</button></div><div class="side-projects">${state.projects.map(p => `<button class="side-project ${route === 'project' && p.id === state.activeId ? 'current' : ''}" data-action="open-project" data-id="${h(p.id)}"><span class="project-dot ${p.id === 'core' ? 'orange' : 'purple'}"></span>${h(p.name)}</button>`).join('')}</div><div class="sidebar-bottom"><div class="local-card"><span class="live-dot"></span> Локальний простір<small>Дані зберігаються у браузері</small></div><a class="nav-item ${route === 'settings' ? 'active' : ''}" href="#settings">${icon('settings')}Налаштування</a><div class="profile"><span class="user-avatar">ВИ</span><span>Мій профіль<small>Особистий простір</small></span><span class="profile-local">LOCAL</span></div></div></aside>`;
}
function header() {
  const titles = { overview: 'Огляд простору', projects: 'Проєкти', project: project().name, agents: 'Агенти', runs: 'Запуски', connections: 'Підключення', settings: 'Налаштування' };
  return `<header class="topbar"><div class="breadcrumb">Робочий простір ${icon('chevron')}<strong>${h(titles[route] ?? 'Огляд')}</strong></div><div class="topbar-right"><button class="search-trigger" data-action="search">${icon('search')}<span>Швидкий пошук</span><kbd>Ctrl K</kbd></button><span class="top-divider"></span><span class="mode-dot"></span><span class="mode-text">Демо-режим</span><span class="user-avatar small">ВИ</span></div></header>`;
}
function heading(eyebrow, title, description, action = '') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${h(title)}</h1><p>${h(description)}</p></div><div class="heading-actions">${action}</div></div>`; }
function progress(p) { return Math.round(p.tasks.filter(t => t.status === 'done').length / Math.max(1, p.tasks.length) * 100); }
function projectCard(p) {
  return `<button class="project-card" data-action="open-project" data-id="${h(p.id)}"><div class="project-card-top"><span class="project-glyph ${p.id === 'core' ? 'orange' : 'purple'}">${icon(p.icon)}</span>${badge(p.status)}</div><h3>${h(p.name)}</h3><p>${h(p.description)}</p><div class="project-card-progress"><span>Виконання плану</span><strong>${progress(p)}%</strong></div><div class="progress"><span style="width:${progress(p)}%"></span></div><div class="project-card-footer"><div class="avatar-stack">${p.team.slice(0, 4).map(id => avatar(agent(id), true)).join('')}</div><span>${p.tasks.length} задач ${icon('arrow')}</span></div></button>`;
}
function stats(p) {
  const metrics = [ ['users', p.team.length.toString().padStart(2, '0'), 'Агентів у команді', 'Ролі підібрані під задачі'], ['branch', p.tasks.length.toString().padStart(2, '0'), 'Задач у плані', `${p.tasks.filter(t => t.status === 'done').length} завершено · ${p.tasks.filter(t => t.status === 'pending').length} у черзі`], ['pulse', p.tasks.filter(t => t.status === 'running').length.toString().padStart(2, '0'), 'Виконуються зараз', `До ${p.concurrency} задач одночасно`], ['shield', '—', 'Витрати на моделі', 'Демо без викликів API'] ];
  return `<div class="stats">${metrics.map(([glyph, value, label, note]) => `<div class="stat"><div class="stat-label">${icon(glyph)}${label}</div><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>`;
}
function activity(p, count = 5) {
  return `<div class="activity">${p.events.length ? p.events.slice(0, count).map((e, i) => `<div class="activity-row"><span class="activity-marker ${i === 0 ? 'latest' : ''}">${icon(i === 0 ? 'pulse' : 'check')}</span><div><p>${h(e.text)}</p><small>Демонстраційний сценарій</small></div><time>${new Date(e.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('') : '<div class="empty compact">Події з’являться після першого запуску.</div>'}</div>`;
}
function overview() {
  const p = project();
  return `<section class="mission-hero"><div class="hero-copy"><div class="eyebrow"><span class="hero-beacon"></span> MISSION CONTROL <span class="hero-coordinate">/ 001</span></div><h1>Ваш центр керування<br><span>командним інтелектом.</span></h1><p>Кожен агент — частина сузір’я.<br>Поєднайте їхні можливості для вашої наступної місії.</p><div class="hero-actions">${button('new-project', 'Новий проєкт', 'plus', 'btn primary')}<a class="hero-link" href="#projects">Переглянути проєкти ${icon('arrow')}</a></div></div><div class="orbital-art" aria-hidden="true"><img src="/orbital.svg" alt=""><span class="orbital-label">MULTI-AGENT CONSTELLATION</span></div><span class="hero-corner">LOCAL SPACE · DEMO</span></section>${stats(p)}<section><div class="section-heading"><h2>Ваші проєкти <span>${state.projects.length}</span></h2><a href="#projects">Усі проєкти ${icon('arrow')}</a></div><div class="project-cards">${state.projects.slice(0, 2).map(projectCard).join('')}<button class="new-project-card" data-action="new-project"><span>${icon('plus')}</span><strong>Створити проєкт</strong><p>Нова мета. Нова команда.<br>Наступний результат.</p></button></div></section><div class="overview-bottom"><section class="panel"><div class="panel-heading"><h2>Журнал місії</h2><span class="muted text-small">${h(p.name)}</span></div>${activity(p, 4)}</section><section class="panel next-step"><span class="eyebrow">НАСТУПНИЙ КРОК</span><div class="step-illustration">${icon('orbit')}</div><h2>Виведіть команду на орбіту</h2><p>Перегляньте граф задач та запустіть демонстрацію спільної роботи агентів.</p>${button('open-project', 'Відкрити робочий простір', 'arrow', 'btn', `data-id="${h(p.id)}"`)}</section></div>`;
}
function runControls(p) {
  if (p.status === 'running') return `${button('pause', 'Пауза', 'pause')}${button('cancel', 'Зупинити', 'stop', 'btn danger-quiet')}`;
  if (p.status === 'paused') return `${button('resume', 'Продовжити', 'play', 'btn primary')}${button('cancel', 'Зупинити', 'stop')}`;
  return button('start', p.status === 'idle' ? 'Запустити демо' : 'Повторити демо', 'play', 'btn primary');
}
function projectPage() {
  const p = project();
  const tabs = [['plan', 'План задач'], ['team', 'Команда'], ['activity', 'Активність'], ['artifacts', 'Результати'], ['config', 'Налаштування']];
  return `<div class="project-intro"><div><div class="eyebrow"><span class="project-dot orange"></span> ПРОЄКТ / РЕВІЗІЯ ${p.revision}</div><h1>${h(p.name)}</h1><p>${h(p.description)}</p></div><div class="heading-actions">${button('edit-project', '', 'settings', 'btn icon-btn', 'aria-label="Редагувати проєкт"')}${runControls(p)}</div></div><div class="project-meta">${badge(p.status)}<span>${icon('users')}${p.team.length} агенти</span><span>${icon('shield')}Збалансований режим</span><span>${icon('code')}Демонстраційні дані</span></div><div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button role="tab" aria-selected="${tab === id}" class="${tab === id ? 'selected' : ''}" data-action="tab" data-id="${id}">${label}${id === 'team' ? `<span>${p.team.length}</span>` : ''}</button>`).join('')}</div>${tab === 'plan' ? plan(p) : tab === 'team' ? teamPage(p) : tab === 'activity' ? `<section class="panel"><div class="panel-heading"><h2>Журнал запуску</h2>${button('export', 'Експортувати', 'download')}</div>${activity(p, 100)}</section>` : tab === 'artifacts' ? artifacts(p) : config(p)}`;
}
function plan(p) {
  return `<div class="plan-layout"><section class="panel graph-panel"><div class="panel-heading"><div><h2>План виконання <span class="count">${p.tasks.length}</span></h2><p class="muted text-small">Залежності задач і призначені виконавці</p></div>${button('new-task', 'Задача', 'plus', 'btn small-btn', ['running', 'paused'].includes(p.status) ? 'disabled title="Редагування доступне після завершення демо"' : '')}</div><div class="graph-toolbar"><div class="segmented">${[['graph','branch','Граф'], ['list','layers','Список'], ['tree','users','Субагенти']].map(([id, glyph, label]) => button(`view-${id}`, label, glyph, view === id ? 'chosen' : '')).join('')}</div><div class="graph-legend"><span class="legend-dot done"></span>Готово<span class="legend-dot running"></span>В роботі<span class="legend-dot pending"></span>У черзі</div></div>${view === 'graph' ? graph(p) : view === 'list' ? taskList(p) : tree(p)}<div class="graph-footer"><span>${icon('link')}Натисніть задачу, щоб переглянути деталі</span><span>ДЕМО · ${p.concurrency} паралельні задачі</span></div></section><section class="panel team-summary"><div class="panel-heading"><h2>Команда проєкту</h2><button class="text-button" data-action="tab" data-id="team">${icon('settings')}</button></div>${p.team.map(id => { const a = agent(id); if (!a) return ''; const working = p.tasks.some(t => t.status === 'running' && t.agentIds.includes(id)); return `<button class="team-member" data-action="agent-detail" data-id="${h(id)}">${avatar(a)}<span><strong>${h(a.name)}</strong><small>${h(a.model)}</small></span><span class="availability ${working ? 'busy' : ''}" title="${working ? 'Виконує демо-задачу' : 'Готовий до демо'}"></span></button>`; }).join('')}<div class="team-summary-footer">${icon('shield')}Агенти працюють у межах<br>прав та бюджету проєкту</div></section></div><div class="section-heading section-spaced"><h2>Активність запуску</h2><button class="text-button" data-action="tab" data-id="activity">Повний журнал ${icon('arrow')}</button></div><section class="panel">${activity(p, 3)}</section>${selected ? drawer(p) : ''}`;
}
function taskNode(t, index, style = '') {
  return `<button class="task-node ${h(t.status)} ${selected === t.id ? 'focused' : ''}" data-action="select-task" data-id="${h(t.id)}" ${style}><div class="task-node-top"><span class="task-number">${String(index + 1).padStart(2, '0')}</span><span class="node-state">${icon(t.status === 'done' ? 'check' : t.status === 'running' ? 'pulse' : 'clock')}</span></div><strong>${h(t.title)}</strong><div class="task-agent">${t.agentIds.map(id => avatar(agent(id), true)).join('')}<span>${h(agent(t.agentIds[0])?.name ?? 'Не призначено')}${t.agentIds.length > 1 ? ` +${t.agentIds.length - 1}` : ''}</span></div><div class="node-bottom">${badge(t.status)}${t.children ? `<span>${icon('branch')} ${t.children.length}</span>` : ''}</div></button>`;
}
function graph(p) {
  const levels = new Map();
  const level = t => { if (levels.has(t.id)) return levels.get(t.id); const value = t.dependsOn.length ? Math.max(...t.dependsOn.map(id => level(p.tasks.find(d => d.id === id)))) + 1 : 0; levels.set(t.id, value); return value; };
  p.tasks.forEach(level);
  const max = Math.max(0, ...levels.values()), positions = new Map();
  for (let col = 0; col <= max; col++) { const nodes = p.tasks.filter(t => levels.get(t.id) === col); nodes.forEach((t, row) => positions.set(t.id, { x: 25 + col * 246, y: 34 + row * 192 })); }
  const width = Math.max(950, (max + 1) * 246 + 30), rows = Math.max(1, ...Array.from({ length: max + 1 }, (_, col) => p.tasks.filter(t => levels.get(t.id) === col).length)), height = Math.max(340, rows * 192 + 65);
  return `<div class="graph-scroll"><div class="graph-canvas" style="width:${width}px;height:${height}px"><svg class="edges" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7f91b8"/></marker></defs>${p.tasks.flatMap(t => t.dependsOn.map(id => { const from = positions.get(id), to = positions.get(t.id); return `<path d="M${from.x + 210},${from.y + 78} C${from.x + 230},${from.y + 78} ${to.x - 20},${to.y + 78} ${to.x - 4},${to.y + 78}" fill="none" stroke="${t.status === 'done' ? '#6ecdb5' : '#4a6084'}" stroke-width="1.5" marker-end="url(#arrow)"/>`; })).join('')}</svg>${p.tasks.map((t, i) => { const pos = positions.get(t.id); return taskNode(t, i, `style="left:${pos.x}px;top:${pos.y}px"`); }).join('')}<span class="canvas-label">${icon('branch')} WORKFLOW / ${h(p.name.toUpperCase())}</span></div></div>`;
}
function taskList(p) { return `<div class="task-list">${p.tasks.map((t, i) => `<button data-action="select-task" data-id="${h(t.id)}"><span class="task-number">${String(i+1).padStart(2,'0')}</span><strong>${h(t.title)}</strong><span>${t.agentIds.map(id => avatar(agent(id), true)).join('')}</span>${badge(t.status)}${icon('chevron')}</button>`).join('')}</div>`; }
function tree(p) { return `<div class="subtree"><div class="tree-root">${icon('layers')} ${h(p.name)}</div>${p.tasks.map(t => `<div class="tree-task"><button data-action="select-task" data-id="${h(t.id)}">${icon('branch')}<strong>${h(t.title)}</strong>${badge(t.status)}</button>${t.children?.map(c => `<div class="tree-child">${icon('users')}<span>${h(c.title)}<small>Керований субагент · демонстрація</small></span>${badge(c.status)}</div>`).join('') ?? ''}</div>`).join('')}<p class="muted text-small">Дочірня задача з’являється під час демонстраційного виконання сервера та API.</p></div>`; }
function drawer(p) {
  const t = p.tasks.find(t => t.id === selected); if (!t) return '';
  return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" aria-label="Деталі задачі"><div class="drawer-heading"><span class="eyebrow">ДЕТАЛІ ЗАДАЧІ</span>${button('close-drawer', '', 'close', 'btn icon-btn', 'aria-label="Закрити деталі"')}</div>${badge(t.status)}<h2>${h(t.title)}</h2><p>${h(t.prompt)}</p><div class="drawer-section"><h3>Виконавці</h3>${t.agentIds.map(id => { const a = agent(id); return a ? `<div class="drawer-agent">${avatar(a)}<span>${h(a.name)}<small>${h(a.model)}</small></span></div>` : ''; }).join('')}</div><div class="drawer-section"><h3>Залежності</h3>${t.dependsOn.length ? t.dependsOn.map(id => `<div class="dependency">${icon('link')}${h(p.tasks.find(d => d.id === id)?.title)}</div>`).join('') : '<p class="muted">Може починатися незалежно.</p>'}</div>${t.children ? `<div class="drawer-section"><h3>Субагенти</h3>${t.children.map(c => `<div class="dependency">${h(c.title)} ${badge(c.status)}</div>`).join('')}</div>` : ''}<div class="drawer-section"><h3>Результат</h3><p>${h(t.result ?? 'Результат з’явиться після завершення демонстраційної задачі.')}</p></div>${planningDetails(p,t)}<div class="drawer-actions">${!['running', 'paused'].includes(p.status) ? button('edit-task', 'Редагувати', 'settings', 'btn', `data-id="${h(t.id)}"`) : ['pending', 'running'].includes(t.status) ? button('cancel-task', 'Скасувати задачу', 'stop', 'btn', `data-id="${h(t.id)}"`) : ''}</div></aside>`;
}
function planningDetails(p,t) {
  const assignment=p.planning?.routing?.assignments.find(a=>a.taskId===t.id);
  return (t.acceptanceCriteria?.length ? '<div class="drawer-section"><h3>Критерії готовності</h3><ul class="acceptance-list">'+t.acceptanceCriteria.map(v=>'<li>'+h(v)+'</li>').join('')+'</ul></div>' : '')
    + (assignment ? '<div class="drawer-section"><h3>Чому обрано цю команду</h3><p>'+h(assignment.reason)+'</p><small class="muted">'+(assignment.manual?'Призначення скориговано вручну':p.planning.teamSource?.mode==='ai'?'AI-рекомендація':'Демо-правило за навичками')+'</small></div>' : '');
}
function agentCard(a, p) { return `<article class="agent-card"><div class="agent-card-top">${avatar(a)}<span class="provider-pill">${h(a.provider)}</span></div><h3>${h(a.name)}</h3><p>${h(a.role)}</p><div class="model-label">${icon(a.provider === 'CLI' ? 'code' : 'spark')}${h(a.model)}</div><div class="skills">${a.skills.map(s => `<span>${h(s)}</span>`).join('')}</div><div class="agent-card-bottom"><span><i class="demo-indicator"></i> Демо-профіль</span>${button(p ? 'toggle-agent' : 'agent-detail', p ? 'Вилучити' : 'Профіль', p ? 'close' : 'arrow', 'text-button', `data-id="${h(a.id)}" ${p && ['running','paused'].includes(p.status) ? 'disabled' : ''}`)}</div></article>`; }
function teamPage(p) { return `<div class="section-heading"><div><h2>Люди задають мету. Агенти виконують.</h2><p class="muted">Профілі та ролі команди цього проєкту.</p></div>${button('choose-team', 'Додати агента', 'plus')}</div><div class="agent-grid">${p.team.map(id => agent(id)).filter(Boolean).map(a => agentCard(a, p)).join('')}</div><div class="info-note">${icon('shield')}Профілі демонстраційні. Моделі та CLI ще не підключені до цього інтерфейсу.</div>`; }
function artifacts(p) { return `<div class="section-heading"><h2>Результати задач <span>${p.artifacts.length}</span></h2>${button('export', 'Експортувати проєкт', 'download')}</div>${p.artifacts.length ? `<div class="artifact-grid">${p.artifacts.map(a => `<article class="panel artifact"><span class="project-glyph green">${icon('file')}</span><h3>${h(a.name)}</h3><p>Текстовий результат демонстрації</p>${button('download-artifact', 'Завантажити', 'download', 'btn', `data-id="${h(a.id)}"`)}</article>`).join('')}</div>` : `<div class="empty panel">${icon('file')}<h3>Тут будуть результати команди</h3><p>Запустіть демо — завершені задачі створять текстові артефакти.</p>${button('start', 'Запустити демо', 'play', 'btn primary')}</div>`}`; }
function config(p) { return `<form id="config-form" class="panel settings-form"><div class="panel-heading"><h2>Налаштування проєкту</h2><span class="muted">Ревізія ${p.revision}</span></div><label>Назва проєкту<input name="name" required maxlength="80" value="${h(p.name)}"></label><label>Мета та опис<textarea name="description" required maxlength="1000">${h(p.description)}</textarea></label><div class="form-grid"><label>Паралельні задачі<input name="concurrency" type="number" min="1" max="16" required value="${p.concurrency}"></label><label>Ліміт викликів для майбутнього API<input name="maxCalls" type="number" min="1" max="1000" required value="${p.maxCalls}"></label></div><p class="muted text-small">У демо використовується ліміт паралельних задач. Ліміт API зберігається як налаштування для наступного етапу.</p><div class="form-footer">${button('export', 'Експортувати JSON', 'download')}<button class="btn primary" type="submit">Зберегти ревізію</button></div></form>`; }
function connections() { return `${heading('CONNECTIONS', 'Моделі та підключення', 'Єдиний простір для хмарних моделей, локальних моделей і CLI-агентів.')}<div class="info-note">${icon('plug')}Зараз доступний UI-прототип. Ці картки показують заплановані інтеграції; авторизація та запити ще не підключені.</div><div class="connection-grid">${[['OpenAI', 'API моделей', 'Responses API · текст та інструменти', 'O', 'green'], ['Codex CLI', 'Локальний агент', 'Репозиторій · інструменти · код', '⌘', 'blue'], ['Claude Code', 'Локальний агент', 'Розробка · рецензування', 'C', 'orange'], ['Ollama', 'Локальні моделі', 'Ваш комп’ютер · сумісний API', 'OL', 'purple']].map(([name, type, description, symbol, color]) => `<article class="panel connection"><span class="connection-symbol ${color}">${symbol}</span><span class="provider-pill">${type}</span><h3>${name}</h3><p>${description}</p><div class="connection-bottom"><span class="muted text-small">Не підключено</span>${button('connection-info', 'Деталі', 'arrow', 'btn small-btn', `data-id="${name}"`)}</div></article>`).join('')}</div>`; }
function main() {
  if (route === 'project') return projectPage();
  if (route === 'projects') return `${heading('PROJECTS', 'Усе починається з мети.', 'Ваші проєкти та команди в одному робочому просторі.', button('new-project','Новий проєкт','plus','btn primary'))}<div class="project-cards full">${state.projects.map(projectCard).join('')}</div>`;
  if (route === 'agents') return `${heading('AGENT LIBRARY', 'Правильний агент для кожної задачі.', 'Бібліотека профілів: ролі, навички та спосіб виконання.',button('new-agent','Новий агент','plus','btn primary'))}<div class="agent-grid">${state.agents.map(a => agentCard(a)).join('')}</div>`;
  if (route === 'connections') return connections();
  if (route === 'runs') return `${heading('RUN HISTORY','Виконання під контролем.','Стан демонстраційних запусків і останні події.')}<section class="panel run-list">${state.projects.map(p => `<button data-action="open-project" data-id="${h(p.id)}"><span class="project-glyph orange">${icon('pulse')}</span><span><strong>${h(p.name)}</strong><small>${p.events.length ? h(p.events[0].text) : 'Ще не запускався'}</small></span>${badge(p.status)}${icon('chevron')}</button>`).join('')}</section>`;
  if (route === 'settings') return `${heading('WORKSPACE SETTINGS','Ваш простір. Ваші правила.','Локальні налаштування та збережені демонстраційні дані.')}<section class="panel workspace-settings"><h2>Зберігання даних</h2><p>Проєкти, профілі та результати зберігаються у цьому браузері. Реальні секрети не вводяться й не зберігаються.</p><div class="settings-row"><span>Експортувати робочий простір<small>Усі проєкти та профілі у JSON</small></span>${button('export-all','Експортувати','download')}</div><div class="settings-row"><span>Відновити демонстрацію<small>Поточні локальні дані буде замінено стартовими</small></span>${button('confirm-reset','Відновити','settings')}</div></section>`;
  return overview();
}
function render() { const scroll = window.scrollY; $('#app').innerHTML = `${sidebar()}<div class="shell">${header()}<main>${main()}<footer class="page-footer"><span>orcestrator <b>/</b> Ваш простір для командного інтелекту</span><span>UI Preview · v0.1</span></footer></main></div>`; document.querySelector('.team-summary .text-button')?.setAttribute('aria-label', 'Редагувати команду'); window.scrollTo(0, scroll); }
function modal(title, body, footer = '') { const d = $('#modal'); d.innerHTML = `<div class="modal-heading"><div><span class="eyebrow">ORCESTRATOR WORKSPACE</span><h2>${h(title)}</h2></div>${button('close-modal','','close','btn icon-btn','aria-label="Закрити вікно"')}</div>${body}${footer}`; if (!d.open) d.showModal(); }
function checks(ids, name = 'team') { return state.agents.map(a => `<label class="agent-option">${avatar(a)}<span><strong>${h(a.name)}</strong><small>${h(a.model)}</small></span><input type="checkbox" name="${name}" value="${h(a.id)}" ${ids.includes(a.id) ? 'checked' : ''}></label>`).join(''); }
function newProject() { creation.open(); }

function taskModal(task) {
  const p = project();
  if (['running','paused'].includes(p.status)) { toast('Завершіть демо перед зміною плану'); return; }
  modal(task ? 'Редагувати задачу' : 'Нова задача', `<form id="task-form" data-id="${h(task?.id ?? '')}"><label>Назва<input name="title" required maxlength="100" value="${h(task?.title ?? '')}"></label><label>Інструкція<textarea name="prompt" required maxlength="2000">${h(task?.prompt ?? '')}</textarea></label><fieldset><legend>Виконавці — можна обрати кількох</legend>${p.team.map(id => { const a=agent(id); return `<label class="checkline"><input type="checkbox" name="agents" value="${h(id)}" ${task?.agentIds.includes(id) ? 'checked' : ''}>${h(a?.name)}</label>`; }).join('')}</fieldset><fieldset><legend>Почати після завершення</legend>${p.tasks.filter(t => t.id !== task?.id).map(t => `<label class="checkline"><input type="checkbox" name="deps" value="${h(t.id)}" ${task?.dependsOn.includes(t.id) ? 'checked' : ''}>${h(t.title)}</label>`).join('') || '<span class="muted">Перша задача у плані</span>'}</fieldset><div class="form-footer">${button('close-modal','Скасувати')}<button type="submit" class="btn primary">Зберегти задачу</button></div></form>`);
}
function download(name, content, type = 'application/json') { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name.replace(/[<>:"/\\|?*]/g, '-'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function locked() { return ['running','paused'].includes(project().status); }
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]'); if (!target || target.disabled) return;
  const action = target.dataset.action, id = target.dataset.id, p = project();
  try {
    if (action === 'new-project') { newProject(); return; }
    if (action === 'close-modal') { $('#modal').close(); return; }
    if (action === 'workspace') { navigate('settings'); return; }
    if (action === 'open-project') { state.activeId = id; selected = null; tab = 'plan'; save(); if (route === 'project') render(); else navigate('project'); $('#modal').close(); return; }
    if (action === 'tab') tab = id;
    else if (action.startsWith('view-')) view = action.slice(5);
    else if (action === 'select-task') selected = id;
    else if (action === 'close-drawer') selected = null;
    else if (action === 'start') { start(p); toast('Запущено демо. Реальні моделі не викликаються.'); }
    else if (action === 'pause') { p.status = 'paused'; log(p, 'Демонстрацію поставлено на паузу'); }
    else if (action === 'resume') { p.status = 'running'; log(p, 'Демонстрацію продовжено'); }
    else if (action === 'cancel') { p.tasks.filter(t => ['running', 'pending'].includes(t.status)).forEach(t => { t.status = 'cancelled'; t.children?.forEach(c => c.status = 'cancelled'); }); p.status = 'cancelled'; log(p, 'Демонстрацію зупинено користувачем'); }
    else if (action === 'cancel-task') cancelTask(p, id);
    else if (action === 'new-task') { taskModal(); return; }
    else if (action === 'edit-task') { taskModal(p.tasks.find(t => t.id === id)); return; }
    else if (action === 'edit-project') { tab = 'config'; }
    else if (action === 'choose-team') { if (locked()) throw new Error('Завершіть демо перед зміною команди'); modal('Команда проєкту', `<form id="team-form"><div class="agent-options">${checks(p.team)}</div><div class="form-footer">${button('close-modal','Скасувати')}<button class="btn primary" type="submit">Зберегти команду</button></div></form>`); return; }
    else if (action === 'toggle-agent') { if (p.tasks.some(t => t.agentIds.includes(id))) throw new Error('Спочатку перепризначте задачі цього агента'); if (p.team.length <= 1) throw new Error('Залиште щонайменше одного агента'); p.team = p.team.filter(a => a !== id); p.revision++; }
    else if (action === 'agent-detail') { const a = agent(id); modal(a.name, `<div class="agent-detail">${avatar(a)}<p>${h(a.role)}</p><div class="detail-pair"><span>Модель / backend</span><strong>${h(a.model)}</strong></div><div class="detail-pair"><span>Спосіб виконання</span><strong>${h(a.provider)}</strong></div><div class="skills">${a.skills.map(s => `<span>${h(s)}</span>`).join('')}</div><div class="info-note">${icon('shield')}Демонстраційний профіль. Реальні інструменти й авторизація не підключені.</div></div>`); return; }
    else if (action === 'new-agent') { modal('Новий профіль агента', `<form id="agent-form"><label>Назва<input name="name" required maxlength="60"></label><label>Роль<input name="role" required maxlength="120" placeholder="Наприклад, перевірка безпеки"></label><div class="form-grid"><label>Backend<select name="provider"><option>API</option><option>CLI</option><option>Local</option></select></label><label>Модель / CLI<input name="model" required maxlength="80" placeholder="Назва моделі"></label></div><label>Навички через кому<input name="skills" required maxlength="160" placeholder="review, testing"></label><div class="form-footer">${button('close-modal','Скасувати')}<button type="submit" class="btn primary">Створити профіль</button></div></form>`); return; }
    else if (action === 'export' || action === 'export-all') { download(action === 'export-all' ? 'orcestrator-workspace.json' : `${p.name}.json`, JSON.stringify(action === 'export-all' ? state : p, null, 2)); toast('JSON експортовано'); return; }
    else if (action === 'download-artifact') { const a = p.artifacts.find(a => a.id === id); download(a.name, a.text, 'text/markdown;charset=utf-8'); return; }
    else if (action === 'connection-info') { modal(id, `<div class="connection-description"><p>Інтеграція ${h(id)} передбачена архітектурою. Цей прототип дозволяє налаштувати склад команди та перевірити взаємодію.</p><p>Підключення до справжніх моделей, перевірка авторизації та потокове виконання — наступний етап.</p><div class="info-note">${icon('shield')}API-ключі у цьому UI не запитуються.</div></div>`); return; }
    else if (action === 'confirm-reset') { modal('Відновити демонстраційні дані?', '<p class="modal-text">Ваші локальні проєкти та профілі буде замінено початковим прикладом. Перед цим можна експортувати робочий простір.</p>', `<div class="form-footer">${button('close-modal','Скасувати')}${button('reset','Відновити демо','','btn primary')}</div>`); return; }
    else if (action === 'reset') { state = seed(); $('#modal').close(); toast('Демонстраційні дані відновлено'); }
    else if (action === 'search') { modal('Знайти у просторі', '<label class="search-field">Проєкти та агенти<input id="quick-search" type="search" placeholder="Почніть вводити назву…" autofocus></label><div id="search-results"></div>'); searchResults(''); return; }
    save(); render();
  } catch (error) { toast(error.message); }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'creation-project') return;
  event.preventDefault(); const form = event.target, data = new FormData(form), p = project();
  try {
    if (form.id === 'team-form') {
      if (locked()) throw new Error('Завершіть демо перед зміною команди'); const team = data.getAll('team'); if (!team.length) throw new Error('Оберіть щонайменше одного агента');
      if (p.tasks.some(t => t.agentIds.some(id => !team.includes(id)))) throw new Error('Спочатку перепризначте задачі агентів, яких вилучаєте'); p.team = team; p.revision++; log(p, 'Оновлено склад команди'); toast('Команду збережено');
    } else if (form.id === 'task-form') {
      if (locked()) throw new Error('Завершіть демо перед зміною плану');
      const agentIds = data.getAll('agents'); if (!agentIds.length) throw new Error('Оберіть виконавця');
      const title = data.get('title').trim(), prompt = data.get('prompt').trim(); if (!title || !prompt) throw new Error('Заповніть назву й інструкцію');
      const old = p.tasks.find(t => t.id === form.dataset.id), next = { id: old?.id ?? uid(), title, prompt, agentIds, dependsOn: data.getAll('deps'), status: 'pending' };
      const tasks = old ? p.tasks.map(t => t.id === old.id ? next : t) : [...p.tasks, next]; validateTasks(tasks); p.tasks = tasks; p.revision++; p.status = 'idle'; selected = next.id; log(p, `Оновлено план: ${title}`); toast('Задачу збережено');
    } else if (form.id === 'agent-form') {
      const name = data.get('name').trim(), role = data.get('role').trim(), model = data.get('model').trim(), skills = data.get('skills').split(',').map(s => s.trim()).filter(Boolean);
      if (!name || !role || !model || !skills.length) throw new Error('Заповніть профіль та навички'); state.agents.push({ id: uid(), name, role, model, skills, provider: data.get('provider'), initials: name.slice(0, 2).toUpperCase(), color: ['orange','blue','purple','green'][state.agents.length % 4] }); toast('Профіль агента створено');
    } else if (form.id === 'config-form') {
      if (locked()) throw new Error('Завершіть демо перед зміною налаштувань');
      const name = data.get('name').trim(), description = data.get('description').trim(); if (!name || !description) throw new Error('Заповніть назву й мету');
      p.name = name; p.description = description; p.concurrency = Number(data.get('concurrency')); p.maxCalls = Number(data.get('maxCalls')); p.revision++; log(p, `Збережено ревізію ${p.revision}`); toast('Налаштування збережено');
    }
    save(); $('#modal').close(); render();
  } catch (error) { toast(error.message); }
});
function searchResults(value) { const query = value.toLocaleLowerCase(); $('#search-results').innerHTML = state.projects.filter(p => p.name.toLocaleLowerCase().includes(query)).map(p => `<button class="search-result" data-action="open-project" data-id="${h(p.id)}">${icon('layers')}<span>${h(p.name)}<small>Проєкт</small></span>${icon('arrow')}</button>`).join('') + state.agents.filter(a => a.name.toLocaleLowerCase().includes(query)).map(a => `<button class="search-result" data-action="agent-detail" data-id="${h(a.id)}">${avatar(a, true)}<span>${h(a.name)}<small>Агент</small></span>${icon('arrow')}</button>`).join(''); if (!$('#search-results').innerHTML) $('#search-results').innerHTML = '<p class="empty compact">Нічого не знайдено</p>'; }
document.addEventListener('input', event => { if (event.target.id === 'quick-search') searchResults(event.target.value); });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector('[data-action="search"]').click(); } if (event.key === 'Escape' && selected) { selected = null; render(); } });
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
setInterval(() => { let changed = false; for (const p of state.projects) changed = tick(p) || changed; if (changed) { save(); if (!$('#modal').open && !document.activeElement?.matches('input,textarea,select')) render(); } }, 1600);
const creation = createProjectWizard({ modal, h, icon, button, agents: () => state.agents, notify: toast,
  onCreate(draft) {
    const tasks = draft.plan.tasks.map(t => ({ ...t, status: 'pending', agentIds: draft.routing.assignments.find(a => a.taskId === t.id).agentIds }));
    const team = [...new Set(tasks.flatMap(t => t.agentIds))];
    const next = { id: uid(), name: draft.name, description: draft.idea?.summary ?? draft.description, icon: 'layers', team, tasks,
      concurrency: 3, maxCalls: 50, revision: 1, status: 'idle', events: [], artifacts: [],
      planning: { mode: draft.mode, originalBrief: draft.description, priority: draft.priority, idea: draft.idea, plan: draft.plan,
        routing: draft.routing, ideaSource: draft.ideaSource, planSource: draft.planSource, teamSource: draft.teamSource } };
    log(next, draft.planSource?.mode === 'ai' ? 'Прийнято AI-план і рекомендації команди' : 'Прийнято демонстраційний план і підбір за правилами');
    state.projects.push(next); state.activeId = next.id; tab = 'plan'; selected = null; route = 'project'; location.hash = 'project';
    save(); render(); toast('Проєкт створено з прийнятим планом і командою');
  }
});
render(); save();
