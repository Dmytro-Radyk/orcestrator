import { avatar, badge, button, h, icon, progress } from './primitives.js';

export function renderSidebar({ state, route, navOpen, executionReady }) {
  const nav = [
    ['overview', 'grid', 'Огляд простору'],
    ['projects', 'layers', 'Проєкти'],
    ['agents', 'users', 'Агенти'],
    ['runs', 'pulse', 'Запуски'],
    ['connections', 'plug', 'Підключення']
  ];
  return `${navOpen ? '<div class="sidebar-backdrop" data-action="close-nav" aria-hidden="true"></div>' : ''}<aside id="app-sidebar" class="sidebar ${navOpen ? 'is-open' : ''}" aria-label="Бічна навігація"><div class="sidebar-top-row"><a class="brand" href="#overview"><span class="brand-symbol">${icon('orbit')}</span>orcestrator<span class="brand-dot">®</span></a><button type="button" class="sidebar-close" data-action="close-nav" aria-label="Закрити меню навігації">${icon('close')}</button></div><button type="button" class="workspace" data-action="workspace"><span class="workspace-icon">W</span><span>Мій робочий простір<small>Personal workspace</small></span>${icon('chevron')}</button><div class="nav-label">РОБОЧИЙ ПРОСТІР</div><nav aria-label="Основна навігація">${nav.map(([id, glyph, label]) => `<a href="#${id}" class="nav-item ${route === id || (route === 'project' && id === 'projects') ? 'active' : ''}">${icon(glyph)}<span>${label}</span>${id === 'projects' ? `<span class="nav-count">${state.projects.length}</span>` : ''}</a>`).join('')}</nav><div class="nav-label project-label">МОЇ ПРОЄКТИ<button type="button" data-action="new-project" aria-label="Створити проєкт">${icon('plus')}</button></div><div class="side-projects">${state.projects.map(p => `<button type="button" class="side-project ${route === 'project' && p.id === state.activeId ? 'current' : ''}" data-action="open-project" data-id="${h(p.id)}"><span class="project-dot ${p.id === 'core' ? 'orange' : 'purple'}"></span><span>${h(p.name)}</span></button>`).join('')}</div><div class="sidebar-bottom"><div class="local-card"><span class="live-dot"></span> Локальний простір<small>${executionReady ? 'Дані на локальному сервері' : 'Підключення до сервера…'}</small></div><a class="nav-item ${route === 'settings' ? 'active' : ''}" href="#settings">${icon('settings')}<span>Налаштування</span></a><div class="profile"><span class="user-avatar">ВИ</span><span>Мій профіль<small>Особистий простір</small></span><span class="profile-local">LOCAL</span></div></div></aside>`;
}

export function renderHeader({ route, projectName, navOpen, executionReady }) {
  const titles = {
    overview: 'Огляд простору',
    projects: 'Проєкти',
    project: projectName,
    agents: 'Агенти',
    runs: 'Запуски',
    connections: 'Підключення',
    settings: 'Налаштування'
  };
  return `<header class="topbar"><button type="button" class="mobile-nav-btn" data-action="toggle-nav" aria-label="${navOpen ? 'Закрити меню навігації' : 'Відкрити меню навігації'}" aria-expanded="${navOpen}" aria-controls="app-sidebar">${icon('menu')}</button><div class="breadcrumb">Робочий простір ${icon('chevron')}<strong>${h(titles[route] ?? 'Огляд')}</strong></div><div class="topbar-right"><button type="button" class="search-trigger" data-action="search" aria-label="Швидкий пошук (Ctrl+K)">${icon('search')}<span>Швидкий пошук</span><kbd>Ctrl K</kbd></button><span class="top-divider" aria-hidden="true"></span><span class="mode-dot" aria-hidden="true"></span><span class="mode-text">${executionReady ? 'Локальний сервер' : 'Підключення…'}</span><span class="user-avatar small" aria-hidden="true">ВИ</span></div></header>`;
}

export function renderProjectCard(p, resolveAgent) {
  return `<button type="button" class="project-card" data-action="open-project" data-id="${h(p.id)}"><div class="project-card-top"><span class="project-glyph ${p.id === 'core' ? 'orange' : 'purple'}">${icon(p.icon)}</span>${badge(p.status)}</div><h3>${h(p.name)}</h3><p>${h(p.description)}</p><div class="project-card-progress"><span>Виконання плану</span><strong>${progress(p)}%</strong></div><div class="progress"><span style="width:${progress(p)}%"></span></div><div class="project-card-footer"><div class="avatar-stack">${p.team.slice(0, 4).map(id => avatar(resolveAgent(id), true)).join('')}</div><span>${p.tasks.length} задач ${icon('arrow')}</span></div></button>`;
}

export function renderStats(p) {
  const metrics = [
    ['users', p.team.length.toString().padStart(2, '0'), 'Агентів у команді', 'Ролі підібрані під задачі'],
    ['branch', p.tasks.length.toString().padStart(2, '0'), 'Задач у плані', `${p.tasks.filter(t => t.status === 'done').length} завершено · ${p.tasks.filter(t => t.status === 'pending').length} у черзі`],
    ['pulse', p.tasks.filter(t => t.status === 'running').length.toString().padStart(2, '0'), 'Виконуються зараз', `До ${Number(p.concurrency) || 1} задач одночасно`],
    ['shield', p.execution?.mode === 'real' ? String(p.execution.calls) : '—', p.execution?.mode === 'real' ? 'Викликів оркестратора' : 'Витрати на моделі', p.execution?.mode === 'real' ? 'Грошова сума не обчислюється' : 'Демо без викликів API']
  ];
  return `<div class="stats">${metrics.map(([glyph, value, label, note]) => `<div class="stat"><div class="stat-label">${icon(glyph)}${label}</div><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>`;
}

export function renderActivity(p, count = 5) {
  return `<div class="activity">${p.events.length ? p.events.slice(0, count).map((e, i) => `<div class="activity-row"><span class="activity-marker ${i === 0 ? 'latest' : ''}">${icon(i === 0 ? 'pulse' : 'check')}</span><div><p>${h(e.text)}</p><small>${e.real ? 'AI-команда · реальний запуск' : 'Демонстраційний сценарій'}</small></div><time>${new Date(e.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('') : '<div class="empty compact">Події з’являться після першого запуску.</div>'}</div>`;
}

export function renderOverview({ state, activeProject, resolveAgent }) {
  const p = activeProject;
  return `<section class="mission-hero"><div class="hero-copy"><div class="eyebrow"><span class="hero-beacon"></span> MISSION CONTROL <span class="hero-coordinate">/ 001</span></div><h1>Ваш центр керування<br><span>командним інтелектом.</span></h1><p>Кожен агент — частина сузір’я.<br>Поєднайте їхні можливості для вашої наступної місії.</p><div class="hero-actions">${button('new-project', 'Новий проєкт', 'plus', 'btn primary')}<a class="hero-link" href="#projects">Переглянути проєкти ${icon('arrow')}</a></div></div><div class="orbital-art" aria-hidden="true"><img src="/orbital.svg" alt=""><span class="orbital-label">MULTI-AGENT CONSTELLATION</span></div><span class="hero-corner">LOCAL SPACE</span></section><section class="solar-overview-section"><div class="section-heading"><h2>Сонячна система оркестратора <span>LIVE</span></h2><button type="button" class="text-button" data-action="open-project" data-id="${h(p.id)}">Відкрити проєкт ${icon('arrow')}</button></div><div id="solar-stage" data-compact="true"></div></section>${renderStats(p)}<section><div class="section-heading"><h2>Ваші проєкти <span>${state.projects.length}</span></h2><a href="#projects">Усі проєкти ${icon('arrow')}</a></div><div class="project-cards">${state.projects.slice(0, 2).map(item => renderProjectCard(item, resolveAgent)).join('')}<button type="button" class="new-project-card" data-action="new-project"><span>${icon('plus')}</span><strong>Створити проєкт</strong><p>Нова мета. Нова команда.<br>Наступний результат.</p></button></div></section><div class="overview-bottom"><section class="panel"><div class="panel-heading"><h2>Журнал місії</h2><span class="muted text-small">${h(p.name)}</span></div>${renderActivity(p, 4)}</section><section class="panel next-step"><span class="eyebrow">НАСТУПНИЙ КРОК</span><div class="step-illustration">${icon('orbit')}</div><h2>Виведіть команду на орбіту</h2><p>Перегляньте граф задач, налаштуйте виконавців і запустіть команду.</p>${button('open-project', 'Відкрити робочий простір', 'arrow', 'btn', `data-id="${h(p.id)}"`)}</section></div>`;
}

export function renderNotificationSettings(execution) {
  const status = execution?.desktopNotificationState() ?? 'unavailable';
  const label = { enabled: 'Вимкнути', disabled: 'Увімкнути', denied: 'Дозвіл заблоковано', unavailable: 'Недоступні' }[status] ?? 'Недоступні';
  return `<div class="settings-row"><span>Сповіщення на робочому столі<small>Про завершення етапів і проєктів, поки панель відкрита</small></span>${button('toggle-desktop-notifications', h(label), 'settings', 'btn', status === 'denied' || status === 'unavailable' ? 'disabled' : '')}</div>`;
}

export function renderSearchResultsHtml(state, value) {
  const query = value.toLocaleLowerCase();
  const items = state.projects.filter(p => p.name.toLocaleLowerCase().includes(query))
    .map(p => `<button type="button" class="search-result" data-action="open-project" data-id="${h(p.id)}">${icon('layers')}<span>${h(p.name)}<small>Проєкт</small></span>${icon('arrow')}</button>`).join('') +
    state.agents.filter(a => a.name.toLocaleLowerCase().includes(query))
      .map(a => `<button type="button" class="search-result" data-action="agent-detail" data-id="${h(a.id)}">${avatar(a, true)}<span>${h(a.name)}<small>Агент</small></span>${icon('arrow')}</button>`).join('');
  return items || '<p class="empty compact">Нічого не знайдено</p>';
}
