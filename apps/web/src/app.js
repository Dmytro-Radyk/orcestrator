import {
  addCatalogAgentToProject, agentLibraryGroups, agentLibraryItems,
  providerNames, reasoningChoices, renderAgentLibrary, resolveReasoningChoice
} from './agent-library.js';
import { renderConnections } from './connections.js';
import { createProjectWizard } from './create-project.js';
import { runHistory } from './execution-ui.js';
import { createExecutionClient, serializeWorkspaceState } from './execution.js';
import { patchLiveDom } from './live-dom.js';
import { createProjectChat } from './project-chat.js';
import { composeProject } from './project-composition.js';
import { formatBillingBadge } from './routing-ui.js';
import { renderSolarStage } from './solar-system.js';
import { cancelTask, labels, log, seed, start, tick, uid, validateTasks } from './state.js';
import { $, avatar, badge, button, download, h, heading, icon } from './ui/primitives.js';
import { renderAgentCard, renderProjectPage } from './ui/project-views.js';
import {
  renderHeader, renderNotificationSettings, renderOverview,
  renderProjectCard, renderSearchResultsHtml, renderSidebar
} from './ui/shell-and-overview.js';

let state, execution;
try {
  state = JSON.parse(localStorage.getItem('orcestrator.ui.v1'));
  if (state?.version !== 1 || !state.projects?.length) state = seed();
} catch {
  state = seed();
}
for (const p of state.projects) {
  if (p.status === 'running' && p.execution?.mode !== 'real') {
    p.status = 'paused';
    log(p, 'Демо відновлено на паузі після відкриття сторінки');
  }
}

let route = location.hash.slice(1) || 'overview', tab = 'plan', view = 'solar', selected = null, navOpen = false;
const resumingCancelled = new Set(), verifyingHost = new Set();
let toastTimer;
let agentLibraryFilters = { query: '', backend: '', billing: '', status: 'all' };

const mobileNavigation = window.matchMedia('(max-width: 700px)');
mobileNavigation.addEventListener('change', () => {
  if (navOpen) { navOpen = false; render({ executionOnly: true }); }
});

function availableProfiles() {
  const all = new Map(state.agents.map(a => [a.id, a]));
  for (const item of agentLibraryItems(execution?.catalog, state.agents)) {
    if (item.available) all.set(item.profile.id, item.profile);
  }
  return [...all.values()];
}

function retainProfiles(ids) {
  const all = availableProfiles();
  const missing = [...new Set(ids)].filter(id => !state.agents.some(a => a.id === id)).map(id => all.find(a => a.id === id));
  if (missing.some(a => !a)) throw Error('Агент більше не доступний: оновіть команду');
  if (state.agents.length + missing.length > 100) throw Error('Досягнуто ліміт 100 збережених профілів');
  state.agents.push(...missing);
}

const project = () => state.projects.find(p => p.id === state.activeId) ?? state.projects[0];
const agent = id => state.agents.find(a => a.id === id) ??
  project().execution?.agents?.map(a => ({ ...a, initials: a.name.slice(0, 2).toUpperCase(), color: 'purple' })).find(a => a.id === id);
const locked = (p = project()) => Boolean(execution?.conflict) || ['running', 'paused'].includes(p.status) ||
  Boolean(p.execution?.draining || p.execution?.hostChecking || (p.execution?.id && verifyingHost.has(p.execution.id)));

function save(localOnly = false) {
  try { localStorage.setItem('orcestrator.ui.v1', JSON.stringify(serializeWorkspaceState(state))); }
  catch { toast('Не вдалося зберегти кеш у браузері. Експортуйте проєкт.'); }
  if (!localOnly) execution?.scheduleSave();
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  if ($('#modal').open) {
    let note = $('#modal .modal-alert');
    if (!note) {
      note = document.createElement('div');
      note.className = 'modal-alert';
      note.setAttribute('role', 'alert');
      ($('#modal form') ?? $('#modal')).prepend(note);
    }
    note.textContent = message;
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}

function navigate(next) { location.hash = next; }
window.addEventListener('hashchange', () => {
  route = location.hash.slice(1) || 'overview';
  selected = null;
  navOpen = false;
  render();
});

function modal(title, body, footer = '') {
  const d = $('#modal');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', 'modal-title');
  d.innerHTML = `<div class="modal-heading"><div><span class="eyebrow">ORCESTRATOR WORKSPACE</span><h2 id="modal-title">${h(title)}</h2></div>${button('close-modal', '', 'close', 'btn icon-btn', 'aria-label="Закрити вікно"')}</div>${body}${footer}`;
  if (!d.open) d.showModal();
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
      <div class="preview-toolbar">${preview.demo ? '<span class="muted text-small">Демонстраційні дані</span>' : ''}<a class="btn" href="${h(preview.url)}" target="_blank" rel="noopener noreferrer">Відкрити в окремій вкладці</a></div>
      <iframe src="${h(preview.url)}" title="${h(p.name)}" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe></div>`);
    return;
  }
  modal(title, `<form id="project-preview-form">
    <p class="modal-alert" ${error ? 'role="alert"' : ''}>${h(error ?? 'Готовий сайт у папці проєкту не знайдено. Можна відкрити локальний сервер проєкту за його адресою.')}</p>
    <label>Адреса локального сервера<input name="url" type="url" required placeholder="http://127.0.0.1:3000/" value="${h(url)}"></label>
    <button class="btn primary" type="submit">Відкрити перегляд</button>
  </form>`);
}

function mainContent() {
  const p = project();
  if (route === 'project') {
    return renderProjectPage(p, {
      tab, view, selected, stateAgents: state.agents, execution, projectChat,
      verifyingHost, resumingCancelled, resolveAgent: agent, isLocked: locked(p)
    });
  }
  if (route === 'projects') {
    return `${heading('PROJECTS', 'Усе починається з мети.', 'Ваші проєкти та команди в одному робочому просторі.', button('new-project', 'Новий проєкт', 'plus', 'btn primary'))}<div class="project-cards full">${state.projects.map(item => renderProjectCard(item, agent)).join('')}</div>`;
  }
  if (route === 'agents') {
    return `${heading('AGENT LIBRARY', 'Правильний агент для кожної задачі.', 'Моделі з твоїх підключень та профілі команди.', button('new-agent', 'Новий профіль', 'plus', 'btn primary'))}${renderAgentLibrary(execution?.catalog, state.agents, agentLibraryFilters, { h, icon, button, avatar, renderProfile: a => renderAgentCard(a, null, false), loading: execution?.scanning || execution?.loadingCatalog, error: execution?.catalogError })}`;
  }
  if (route === 'connections') {
    return renderConnections(execution?.catalog, execution?.scanning, { h, button, heading, loading: execution?.loadingCatalog, error: execution?.catalogError });
  }
  if (route === 'runs') {
    return `${heading('RUN HISTORY', 'Виконання під контролем.', 'Історія реальних запусків та стан проєктів.')}${runHistory(execution?.history ?? [], h, button, labels)}<section class="panel run-list">${state.projects.map(item => `<button type="button" data-action="open-project" data-id="${h(item.id)}"><span class="project-glyph orange">${icon('pulse')}</span><span><strong>${h(item.name)}</strong><small>${item.events.length ? h(item.events[0].text) : 'Ще не запускався'}</small></span>${badge(item.status)}${icon('chevron')}</button>`).join('')}</section>`;
  }
  if (route === 'settings') {
    return `${heading('WORKSPACE SETTINGS', 'Ваш простір. Ваші правила.', 'Локальний сервер, кеш браузера та історія запусків.')}<section class="panel workspace-settings"><h2>Зберігання даних</h2><p>Проєкти й профілі зберігаються локальним сервером; браузер тримає кеш. Історія реальних запусків та знімки планів зберігаються окремо й не замінюються скиданням демо. Реальні секрети не вводяться й не зберігаються.</p><div class="settings-row"><span>Експортувати робочий простір<small>Усі проєкти та профілі у JSON</small></span>${button('export-all', 'Експортувати', 'download')}</div><div class="settings-row"><span>Відновити демонстрацію<small>Поточні локальні дані буде замінено стартовими</small></span>${button('confirm-reset', 'Відновити', 'settings')}</div>${renderNotificationSettings(execution)}</section>`;
  }
  return renderOverview({ state, activeProject: p, resolveAgent: agent });
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
      if (actionOrStatus === 'view-artifacts') { route = 'project'; location.hash = 'project'; tab = 'artifacts'; render(); return; }
      if (actionOrStatus === 'real-start') { void execution?.setup(p).catch(error => toast(error.message)); return; }
      if (actionOrStatus === 'start') {
        if (p.execution?.id) execution?.stopStream?.(p.execution.id);
        p.execution = null; start(p); toast('Запущено демо. Реальні моделі не викликаються.');
        save(); render(); return;
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

function render({ executionOnly = false } = {}) {
  const scroll = window.scrollY;
  const existingStage = document.querySelector('#solar-stage');
  const existingViewport = existingStage?.querySelector('.solar-viewport');
  const p = project();
  const html = `<a class="skip-link" href="#main-content" data-action="skip-content">Перейти до вмісту</a>${renderSidebar({ state, route, navOpen, executionReady: Boolean(execution?.ready) })}<div class="shell" ${navOpen && mobileNavigation.matches ? 'inert' : ''}>${renderHeader({ route, projectName: p.name, navOpen, executionReady: Boolean(execution?.ready) })}<main id="main-content" tabindex="-1">${mainContent()}<footer class="page-footer"><span>orcestrator <b>/</b> Ваш простір для командного інтелекту</span><span>UI Preview · v0.1</span></footer></main></div>`;
  const chatting = route === 'project' && tab === 'chat';
  if (executionOnly || chatting || (route === 'agents' && document.activeElement?.matches('[data-agent-filter]'))) {
    patchLiveDom($('#app'), html);
  } else {
    $('#app').innerHTML = html;
  }
  projectChat.show(chatting && execution.ready ? p.id : null);
  const nextStage = document.querySelector('#solar-stage');
  if (nextStage) {
    const compact = nextStage.dataset.compact === 'true';
    if (existingViewport && existingStage !== nextStage) nextStage.appendChild(existingViewport);
    renderSolarStage(nextStage, p, state.agents, labels, solarCallbacks(compact));
  }
  document.querySelector('.team-summary .text-button')?.setAttribute('aria-label', 'Редагувати команду');
  window.scrollTo(0, scroll);
}

const checks = (ids, name = 'team') => availableProfiles().map(a =>
  `<label class="agent-option">${avatar(a)}<span><strong>${h(a.name)}</strong><small>${h(a.model)}${a.backend ? ' · ' + h(providerNames[a.backend] ?? a.backend) : ''}</small></span><input type="checkbox" name="${name}" value="${h(a.id)}" ${ids.includes(a.id) ? 'checked' : ''}></label>`
).join('');

function taskModal(task) {
  const p = project();
  if (locked(p)) { toast(execution?.conflict ? 'Конфлікт збереження з сервером: оновіть сторінку' : 'Завершіть або скасуйте запуск перед зміною плану'); return; }
  modal(task ? 'Редагувати задачу' : 'Нова задача', `<form id="task-form" data-id="${h(task?.id ?? '')}"><label>Назва<input name="title" required maxlength="100" value="${h(task?.title ?? '')}"></label><label>Інструкція<textarea name="prompt" required maxlength="12000">${h(task?.prompt ?? '')}</textarea></label><fieldset><legend>Виконавці — можна обрати кількох</legend>${p.team.map(id => { const a = agent(id); return `<label class="checkline"><input type="checkbox" name="agents" value="${h(id)}" ${task?.agentIds.includes(id) ? 'checked' : ''}>${h(a?.name)}</label>`; }).join('')}</fieldset><fieldset><legend>Почати після завершення</legend>${p.tasks.filter(t => t.id !== task?.id).map(t => `<label class="checkline"><input type="checkbox" name="deps" value="${h(t.id)}" ${task?.dependsOn.includes(t.id) ? 'checked' : ''}>${h(t.title)}</label>`).join('') || '<span class="muted">Перша задача у плані</span>'}</fieldset><div class="form-footer">${button('close-modal', 'Скасувати')}<button type="submit" class="btn primary">Зберегти задачу</button></div></form>`);
}

const searchResults = value => { $('#search-results').innerHTML = renderSearchResultsHtml(state, value); };

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled || target.hasAttribute('data-creation')) return;
  const action = target.dataset.action, id = target.dataset.id, p = project();
  try {
    if (action === 'skip-content') { event.preventDefault(); $('#main-content')?.focus(); return; }
    if (action === 'toggle-nav') { navOpen = !navOpen; render({ executionOnly: true }); (navOpen ? document.querySelector('#app-sidebar .sidebar-close') : document.querySelector('.mobile-nav-btn'))?.focus(); return; }
    if (action === 'close-nav') { navOpen = false; render({ executionOnly: true }); document.querySelector('.mobile-nav-btn')?.focus(); return; }
    if (!execution?.ready && !['close-modal', 'view-solar', 'view-graph', 'view-list', 'view-tree'].includes(action)) { toast('Дочекайтеся відновлення даних із сервера'); return; }
    if (action === 'scan-connections') { await execution.scan(); return; }
    if (action === 'toggle-desktop-notifications') {
      const previous = execution.desktopNotificationState();
      const enabled = await execution.toggleDesktopNotifications();
      render();
      toast(enabled ? 'Сповіщення на робочому столі увімкнено.' : previous === 'enabled' ? 'Сповіщення на робочому столі вимкнено.' : 'Сповіщення доступні в панелі.');
      return;
    }
    if (action === 'agent-library-reset') { agentLibraryFilters = { query: '', backend: '', billing: '', status: 'all' }; render({ executionOnly: true }); return; }
    if (action === 'agent-filter-preset') {
      const st = target.dataset.status, bl = target.dataset.billing;
      if (st !== undefined) agentLibraryFilters.status = st;
      if (bl !== undefined) agentLibraryFilters.billing = agentLibraryFilters.billing === bl ? '' : bl;
      render({ executionOnly: true });
      return;
    }
    if (action === 'catalog-agent-detail' || action === 'catalog-agent-add') {
      const item = agentLibraryGroups(execution.catalog, state.agents).find(entry => entry.id === id);
      if (!item) throw Error('Модель більше не знайдено: оновіть каталог');
      if (action === 'catalog-agent-detail') {
        const billing = formatBillingBadge(item.route?.billing, item.route?.billingBoundary);
        modal(item.profile.name, `<div class="agent-detail">${avatar(item.profile)}<div class="detail-pair"><span>Провайдер</span><strong>${h(providerNames[item.profile.backend] ?? item.profile.backend)}</strong></div><div class="detail-pair"><span>Модель</span><strong>${h(item.profile.model)}</strong></div><p><span class="billing-pill ${billing.tone}">${h(billing.label)}</span></p><p class="${item.available ? 'route-allowed' : 'route-blocked'}">${h(item.reason)}</p><p class="muted">${h(item.route?.description ?? '')}</p><p class="muted text-small">Рівень роздумів обирається при додаванні в команду. Доступ перевіряється перед кожним запуском. Додавання не запускає модель.</p>${button('catalog-agent-add', 'Додати в команду', 'plus', 'btn primary', `data-id="${h(id)}" ${item.available ? '' : 'disabled'}`)}</div>`);
      } else {
        if (!item.available) throw Error(item.reason);
        const projects = state.projects.filter(item => !['running', 'paused'].includes(item.status) && !item.execution?.draining);
        const choices = reasoningChoices(item), availableChoices = choices.filter(c => c.item.available);
        modal('Додати агента в команду', `<form id="catalog-agent-form" data-group="${h(id)}"><p><strong>${h(item.profile.name)}</strong> · ${h(providerNames[item.profile.backend] ?? item.profile.backend)}</p><label>Рівень роздумів<select name="reasoning" required>${availableChoices.length !== 1 ? '<option value="" selected disabled>Оберіть рівень</option>' : ''}${choices.map(c => `<option value="${h(c.value)}" ${!c.item.available ? 'disabled' : ''} ${availableChoices.length === 1 && c.item.available ? 'selected' : ''}>${h(c.label)}${c.item.available ? '' : ' · недоступний'}</option>`).join('')}</select></label><p class="muted text-small">Рівень визначає глибину опрацювання та витрати включеної квоти. Доступ перевіряється перед запуском.</p><label>Проєкт<select name="project" required>${projects.map(proj => `<option value="${h(proj.id)}" ${proj.id === state.activeId ? 'selected' : ''}>${h(proj.name)}</option>`).join('')}</select></label>${!projects.length ? '<p class="route-blocked">Завершіть активний запуск або створіть новий проєкт.</p>' : '<p class="muted">Агент стане доступним для призначення задач у вибраному проєкті.</p>'}<div class="form-footer">${button('close-modal', 'Скасувати')}<button type="submit" class="btn primary" ${projects.length ? '' : 'disabled'}>Додати в команду</button></div></form>`);
      }
      return;
    }
    if (action === 'routing-refresh') { await execution.loadRouting(p.id, { silent: false }); return; }
    if (action === 'routing-preset') {
      const mode = target.dataset.mode === 'text' ? 'text' : 'write';
      execution.updateRoutingDraft(p.id, { requirements: Object.fromEntries(p.tasks.filter(t => !t.parentId).map(t => [t.id, mode])) });
      render();
      return;
    }
    if (action === 'real-start') { await execution.setup(p); return; }
    if (action === 'continue-run') { await execution.control(p, 'continue'); return; }
    if (action === 'retry-access-run') { await execution.control(p, 'retry-access'); return; }
    if (action === 'retry-budget-run') { await execution.control(p, 'retry-budget'); return; }
    if (action === 'retry-project-review') { await execution.control(p, 'retry-project-review'); return; }
    if (action === 'choose-subscription-review') { execution.chooseSubscriptionReview(p); return; }
    if (action === 'change-run-budget') { execution.changeBudget(p); return; }
    if (action === 'balance-gemini-run') { await execution.control(p, 'balance-gemini'); toast('Розподіл нерозпочатих задач оновлено'); return; }
    if (action === 'verify-blocked-run') { execution.clarify(p, true); return; }
    if (action === 'verify-host-run') {
      const runId = p.execution?.id;
      if (!runId || p.execution.hostChecking || verifyingHost.has(runId)) return;
      verifyingHost.add(runId); render({ executionOnly: true });
      try { await execution.control(p, 'verify-host', id); }
      finally { verifyingHost.delete(runId); render({ executionOnly: true }); }
      return;
    }
    if (action === 'resume-cancelled-run') {
      const runId = p.execution.id;
      if (resumingCancelled.has(runId)) return;
      resumingCancelled.add(runId); render({ executionOnly: true });
      try { await execution.control(p, 'resume-cancelled'); }
      finally { resumingCancelled.delete(runId); render({ executionOnly: true }); }
      return;
    }
    if (action === 'clarify-run') { execution.clarify(p); return; }
    if (action === 'view-run') { await execution.viewRun(id); return; }
    if (action === 'chat-retry') { await projectChat.retry(p.id, id); return; }
    if (action === 'chat-retry-subscription') { await projectChat.retry(p.id, id, { allowSubscription: true }); return; }
    if (action === 'chat-cancel') { await projectChat.cancel(p.id, id); return; }
    if (action === 'execution-file') { await execution.file(execution.resultsFor(p), target.dataset.path); return; }
    if (p.execution?.mode === 'real' && ['pause', 'resume', 'cancel', 'cancel-task'].includes(action)) { await execution.control(p, action, id); return; }
    if (action === 'new-project') { navOpen = false; creation.open(); return; }
    if (action === 'close-modal') { $('#modal').close(); return; }
    if (action === 'workspace') { navOpen = false; navigate('settings'); return; }
    if (action === 'open-project') {
      navOpen = false; state.activeId = id; selected = null; tab = 'plan'; save();
      if (route === 'project') render(); else navigate('project');
      $('#modal').close(); void execution.loadRouting(id, { silent: true });
      return;
    }
    if (action === 'tab') {
      tab = id;
      if (id === 'chat') { render(); return; }
      if (id === 'team' && !execution.routingState(p.id)?.proposal && !execution.routingState(p.id)?.loading) void execution.loadRouting(p.id, { silent: true });
      if (id === 'artifacts') void execution.loadResults(p).catch(error => toast(error.message));
    } else if (action.startsWith('view-')) view = action.slice(5);
    else if (action === 'select-task') selected = id;
    else if (action === 'close-drawer') selected = null;
    else if (action === 'start') { if (p.execution?.id) execution?.stopStream?.(p.execution.id); p.execution = null; start(p); toast('Запущено демо. Реальні моделі не викликаються.'); }
    else if (action === 'pause') { p.status = 'paused'; log(p, 'Демонстрацію поставлено на паузу'); }
    else if (action === 'resume') { p.status = 'running'; log(p, 'Демонстрацію продовжено'); }
    else if (action === 'cancel') { p.tasks.filter(t => ['running', 'pending'].includes(t.status)).forEach(t => { t.status = 'cancelled'; t.children?.forEach(c => { c.status = 'cancelled'; }); }); p.status = 'cancelled'; log(p, 'Демонстрацію зупинено користувачем'); }
    else if (action === 'cancel-task') cancelTask(p, id);
    else if (action === 'new-task') { taskModal(); return; }
    else if (action === 'edit-task') { taskModal(p.tasks.find(t => t.id === id)); return; }
    else if (action === 'edit-project') { tab = 'config'; }
    else if (action === 'choose-team') {
      if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною команди');
      modal('Команда проєкту', `<form id="team-form"><div class="agent-options">${checks(p.team)}</div><div class="form-footer">${button('close-modal', 'Скасувати')}<button class="btn primary" type="submit">Зберегти команду</button></div></form>`);
      return;
    } else if (action === 'toggle-agent') {
      if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною команди');
      if (p.tasks.some(t => t.agentIds.includes(id))) throw new Error('Спочатку перепризначте задачі цього агента');
      if (p.team.length <= 1) throw new Error('Залиште щонайменше одного агента');
      p.team = p.team.filter(a => a !== id); p.revision++;
    } else if (action === 'agent-detail') {
      const a = agent(id);
      if (!a) return;
      modal(a.name, `<div class="agent-detail">${avatar(a)}<p>${h(a.role)}</p><div class="detail-pair"><span>Модель / backend</span><strong>${h(a.model)}</strong></div><div class="detail-pair"><span>Спосіб виконання</span><strong>${h(a.provider)}</strong></div><div class="skills">${a.skills.map(s => `<span>${h(s)}</span>`).join('')}</div><div class="info-note">${icon('shield')}Профіль зберігає роль та модель. Фактичний виконавець і права показуються перед запуском; доступ перевіряється повторно.</div></div>`);
      return;
    } else if (action === 'new-agent') {
      modal('Новий профіль агента', `<form id="agent-form"><label>Назва<input name="name" required maxlength="60"></label><label>Роль<input name="role" required maxlength="120" placeholder="Наприклад, перевірка безпеки"></label><div class="form-grid"><label>Backend<select name="provider"><option>API</option><option>CLI</option><option>Local</option></select></label><label>Модель / CLI<input name="model" required maxlength="80" placeholder="Назва моделі"></label></div><label>Навички через кому<input name="skills" required maxlength="160" placeholder="review, testing"></label><div class="form-footer">${button('close-modal', 'Скасувати')}<button type="submit" class="btn primary">Створити профіль</button></div></form>`);
      return;
    } else if (action === 'export' || action === 'export-all') {
      download(action === 'export-all' ? 'orcestrator-workspace.json' : `${p.name}.json`, JSON.stringify(action === 'export-all' ? state : p, null, 2));
      toast('JSON експортовано');
      return;
    } else if (action === 'project-preview') { await showProjectPreview(p); return; }
    else if (action === 'read-artifact') {
      const a = execution.resultsFor(p).artifacts.find(item => item.id === id);
      if (a) modal(a.name, `<pre class="artifact-report">${h(a.text)}</pre>`, `<div class="form-footer">${button('download-artifact', 'Завантажити', 'download', 'btn', `data-id="${h(a.id)}"`)}</div>`);
      return;
    } else if (action === 'download-artifact') {
      const a = execution.resultsFor(p).artifacts.find(item => item.id === id);
      if (a) download(a.name, a.text, 'text/markdown;charset=utf-8');
      return;
    } else if (action === 'confirm-reset') {
      modal('Відновити демонстраційні дані?', '<p class="modal-text">Ваші локальні проєкти та профілі буде замінено початковим прикладом. Перед цим можна експортувати робочий простір.</p>', `<div class="form-footer">${button('close-modal', 'Скасувати')}${button('reset', 'Відновити демо', '', 'btn primary')}</div>`);
      return;
    } else if (action === 'reset') {
      if (execution.history.some(r => ['running', 'paused'].includes(r.status))) throw new Error('Спочатку завершіть або скасуйте реальні запуски');
      execution?.stopAllStreams?.(); execution?.clearRoutingStates?.();
      state = seed(); $('#modal').close(); toast('Демонстраційні дані відновлено');
    } else if (action === 'search') {
      modal('Знайти у просторі', '<label class="search-field">Проєкти та агенти<input id="quick-search" type="search" placeholder="Почніть вводити назву…" autofocus></label><div id="search-results"></div>');
      searchResults('');
      return;
    }
    save(); render();
  } catch (error) { toast(error.message); }
});

document.addEventListener('submit', event => {
  if (['creation-project', 'execution-form', 'execution-clarify-form', 'execution-budget-form', 'execution-review-subscription-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (!execution?.ready) { toast('Дочекайтеся відновлення даних із сервера'); return; }
  const form = event.target, data = new FormData(form), p = project();
  if (form.id === 'project-chat-form') { void projectChat.send(p.id, form.elements.message); return; }
  if (form.id === 'project-preview-form') { void showProjectPreview(p, String(data.get('url') ?? '')); return; }
  try {
    if (execution?.conflict) throw new Error('Конфлікт збереження з сервером: оновіть сторінку перед внесенням змін');
    if (form.id === 'routing-form') {
      const targetProject = state.projects.find(item => item.id === form.dataset.project) ?? p;
      const requirements = Object.fromEntries(targetProject.tasks.filter(t => !t.parentId).map(t => [t.id, data.get(`req-${t.id}`) === 'text' ? 'text' : 'write']));
      void execution.proposeRouting(targetProject.id, {
        priority: String(data.get('priority') ?? 'balanced'),
        maxAgentsPerTask: Number(data.get('maxAgentsPerTask') ?? 3),
        managerRouteId: String(data.get('managerRouteId') ?? ''),
        freeWorkers: data.has('freeWorkers'),
        workerRouteIds: data.getAll('workerRouteId'),
        requirements
      });
      return;
    }
    if (form.id === 'team-form') {
      if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною команди');
      const team = data.getAll('team');
      if (!team.length) throw new Error('Оберіть щонайменше одного агента');
      if (p.tasks.some(t => t.agentIds.some(id => !team.includes(id)))) throw new Error('Спочатку перепризначте задачі агентів, яких вилучаєте');
      retainProfiles(team); p.team = team; p.revision++; log(p, 'Оновлено склад команди'); toast('Команду збережено');
    } else if (form.id === 'catalog-agent-form') {
      const choice = resolveReasoningChoice(execution.catalog, state.agents, form.dataset.group, String(data.get('reasoning')));
      const result = addCatalogAgentToProject(state, execution.catalog, choice.item.id, String(data.get('project')), { reasoningEffort: choice.reasoningEffort });
      if (result.changed) log(result.project, `Додано агента ${result.profile.name}`);
      toast(result.changed ? 'Агента додано в команду' : 'Агент уже є в цій команді');
    } else if (form.id === 'task-form') {
      if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною плану');
      const agentIds = data.getAll('agents');
      if (!agentIds.length) throw new Error('Оберіть виконавця');
      const title = data.get('title').trim(), prompt = data.get('prompt').trim();
      if (!title || !prompt) throw new Error('Заповніть назву й інструкцію');
      const old = p.tasks.find(t => t.id === form.dataset.id);
      const next = { ...(old ?? {}), skills: old?.skills ?? [], acceptanceCriteria: old?.acceptanceCriteria ?? [], id: old?.id ?? uid(), title, prompt, agentIds, dependsOn: data.getAll('deps'), status: 'pending' };
      const tasks = old ? p.tasks.map(t => t.id === old.id ? next : t) : [...p.tasks, next];
      validateTasks(tasks); p.tasks = tasks; p.revision++; p.status = 'idle'; selected = next.id; log(p, `Оновлено план: ${title}`); toast('Задачу збережено');
    } else if (form.id === 'agent-form') {
      const name = data.get('name').trim(), role = data.get('role').trim(), model = data.get('model').trim();
      const skills = data.get('skills').split(',').map(s => s.trim()).filter(Boolean);
      if (!name || !role || !model || !skills.length) throw new Error('Заповніть профіль та навички');
      state.agents.push({ id: uid(), name, role, model, skills, provider: data.get('provider'), initials: name.slice(0, 2).toUpperCase(), color: ['orange', 'blue', 'purple', 'green'][state.agents.length % 4] });
      toast('Профіль агента створено');
    } else if (form.id === 'config-form') {
      if (locked()) throw new Error('Завершіть або скасуйте запуск перед зміною налаштувань');
      const name = data.get('name').trim(), description = data.get('description').trim();
      if (!name || !description) throw new Error('Заповніть назву й мету');
      p.name = name; p.description = description; p.concurrency = Number(data.get('concurrency')); p.maxCalls = Number(data.get('maxCalls'));
      p.maxDepth = Number(data.get('maxDepth')); p.maxTasks = Number(data.get('maxTasks')); p.allowDelegation = data.has('allowDelegation'); p.revision++;
      form.querySelectorAll('[data-user-edited]').forEach(el => { delete el.dataset.userEdited; });
      log(p, `Збережено ревізію ${p.revision}`); toast('Налаштування збережено');
    }
    save(); $('#modal').close(); render();
  } catch (error) { toast(error.message); }
});

document.addEventListener('change', event => {
  if (event.target.dataset.agentFilter) { agentLibraryFilters[event.target.dataset.agentFilter] = event.target.value; render({ executionOnly: true }); return; }
  if (event.target.matches?.('#config-form input, #config-form select, #routing-form select')) event.target.dataset.userEdited = '1';
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
    freeWorkers: data.has('freeWorkers'),
    workerRouteIds: data.getAll('workerRouteId'),
    requirements
  });
});

document.addEventListener('input', event => {
  if (event.target.dataset.agentFilter === 'query') { agentLibraryFilters.query = event.target.value; render({ executionOnly: true }); }
  else if (event.target.id === 'project-chat-message') { event.target.setCustomValidity(''); projectChat.edit(project().id, event.target.value); }
  else if (event.target.id === 'quick-search') searchResults(event.target.value);
  else if (event.target.matches?.('#config-form input, #config-form textarea')) event.target.dataset.userEdited = '1';
});

document.addEventListener('keydown', event => {
  if ($('#modal').open) return;
  if (navOpen && mobileNavigation.matches && event.key === 'Tab') {
    const sidebarEl = $('#app-sidebar'), items = [...sidebarEl.querySelectorAll('a[href],button:not([disabled])')].filter(el => el.getClientRects().length);
    const first = items[0], last = items.at(-1), active = document.activeElement;
    if (first && ((event.shiftKey && (active === first || !sidebarEl.contains(active))) || (!event.shiftKey && (active === last || !sidebarEl.contains(active))))) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (navOpen) { navOpen = false; render({ executionOnly: true }); }
    document.querySelector('[data-action="search"]').click();
  }
  if (event.key === 'Escape') {
    if (navOpen) { navOpen = false; render({ executionOnly: true }); document.querySelector('.mobile-nav-btn')?.focus(); }
    else if (selected) { selected = null; render(); }
  }
});

$('#modal').addEventListener('click', event => {
  if (event.target === $('#modal')) {
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
  }
});

setInterval(() => {
  let changed = false;
  for (const p of state.projects) changed = (p.execution?.mode === 'real' ? false : tick(p)) || changed;
  if (changed) { save(); if (!$('#modal').open) render({ executionOnly: true }); }
}, 1600);

const creation = createProjectWizard({
  modal, h, icon, button, agents: availableProfiles, notify: toast,
  listFolders: path => execution.listFolders(path),
  getCatalog: () => execution?.catalog,
  scanConnections: () => execution?.scan(),
  proposeDraft: (input, signal) => execution.proposeDraft(input, signal),
  async onCreate(draft, { autoStart = false } = {}) {
    const { project: next, profiles } = composeProject(draft, availableProfiles());
    log(next, draft.teamSource?.mode === 'ai' ? 'Прийнято AI-план і точне призначення моделей' : 'Прийнято демонстраційний план і підбір за правилами');
    await execution.createPlannedProject({ project: next, profiles, projectParent: draft.projectParent, ...(draft.teamSource?.mode === 'ai' ? { routingDraftId: draft.proposal.id } : {}) });
    tab = 'plan'; selected = null; route = 'project'; location.hash = 'project';
    render();
    if (autoStart && draft.teamSource?.mode === 'ai' && draft.proposal) {
      try { await execution.launchProposal(next, draft.proposal); return; }
      catch (error) { toast(`Проєкт створено, але автозапуск не вдався: ${error.message}`); return; }
    }
    toast('Проєкт створено з прийнятим планом і командою');
  }
});

execution = createExecutionClient({
  getState: () => state, setState: value => { state = value; },
  render, saveLocal: () => save(true), notify: toast, modal, h, button, download
});
const projectChat = createProjectChat({
  request: execution.projectChat, cancel: execution.cancelChatRun,
  refresh: () => render({ executionOnly: true }), h, button
});

render();
execution.init();
