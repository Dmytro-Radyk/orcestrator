import { awaitingExecutionDetails, executionPanel, fileArtifacts, hasVerificationChecks } from '../execution-ui.js';
import { formatBillingBadge, renderRoutingSection, summarizeTaskModels } from '../routing-ui.js';
import { avatar, badge, button, h, icon } from './primitives.js';
import { renderActivity } from './shell-and-overview.js';

export function renderAgentCard(a, p, isLocked) {
  return `<article class="agent-card"><div class="agent-card-top">${avatar(a)}<span class="provider-pill">${h(a.provider)}</span></div><h3>${h(a.name)}</h3><p>${h(a.role)}</p><div class="model-label">${icon(a.provider === 'CLI' ? 'code' : 'spark')}${h(a.model)}</div><div class="skills">${a.skills.map(s => `<span>${h(s)}</span>`).join('')}</div><div class="agent-card-bottom"><span><i class="demo-indicator"></i> Профіль ролі</span>${button(p ? 'toggle-agent' : 'agent-detail', p ? 'Вилучити' : 'Профіль', p ? 'close' : 'arrow', 'text-button', `data-id="${h(a.id)}" ${p && isLocked ? 'disabled' : ''}`)}</div></article>`;
}

export function renderRunControls(p, { execution, verifyingHost, resumingCancelled }) {
  if (awaitingExecutionDetails(p)) return '';
  if (p.execution?.hostChecking || (p.execution?.id && verifyingHost.has(p.execution.id))) {
    return button('noop', 'Локальна перевірка…', 'clock', 'btn', 'disabled');
  }
  if (p.execution?.canClarify) {
    const task = p.execution.tasks.find(item => item.canVerifyOnHost);
    if (task) return button('verify-host-run', 'Запустити локальні перевірки', 'play', 'btn primary', `data-id="${h(task.id)}"`);
    if (p.execution.tasks.some(hasVerificationChecks)) return button('verify-blocked-run', 'Додати результати перевірок', 'file', 'btn');
    return button('clarify-run', 'Уточнити вимоги', 'spark', 'btn primary');
  }
  if (p.execution?.draining) return button('noop', 'Зупиняється…', 'clock', 'btn', 'disabled');
  if (p.status === 'running') return `${button('pause', 'Пауза', 'pause')}${button('cancel', 'Зупинити', 'stop', 'btn danger-quiet')}`;
  if (p.status === 'paused') return `${button('resume', 'Продовжити', 'play', 'btn primary')}${button('cancel', 'Зупинити', 'stop')}`;
  if (p.status === 'cancelled' && p.execution?.canResumeCancelled) {
    const busy = resumingCancelled.has(p.execution.id);
    return button('resume-cancelled-run', busy ? 'Перевіряємо доступ…' : 'Продовжити після скасування', 'play', 'btn primary',
      busy || !execution?.ready ? 'disabled' : '');
  }
  return button('real-start', 'Запустити AI-команду', 'play', 'btn primary', execution?.ready ? '' : 'disabled') + button('start', 'Демо', '', 'btn');
}

function renderTaskNode(t, index, selected, resolveAgent, style = '') {
  return `<button type="button" class="task-node ${h(t.status)} ${selected === t.id ? 'focused' : ''}" data-action="select-task" data-id="${h(t.id)}" ${style}><div class="task-node-top"><span class="task-number">${String(index + 1).padStart(2, '0')}</span><span class="node-state">${icon(t.status === 'done' ? 'check' : t.status === 'running' ? 'pulse' : 'clock')}</span></div><strong>${h(t.title)}</strong><div class="task-agent">${t.agentIds.map(id => avatar(resolveAgent(id), true)).join('')}<span>${h(resolveAgent(t.agentIds[0])?.name ?? 'Не призначено')}${t.agentIds.length > 1 ? ` +${t.agentIds.length - 1}` : ''}</span></div><div class="node-bottom">${badge(t.status)}${t.children ? `<span>${icon('branch')} ${t.children.length}</span>` : ''}</div></button>`;
}

function renderGraph(p, selected, resolveAgent) {
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
  for (let col = 0; col <= max; col++) {
    const nodes = p.tasks.filter(t => levels.get(t.id) === col);
    nodes.forEach((t, row) => positions.set(t.id, { x: 25 + col * 246, y: 34 + row * 192 }));
  }
  const width = Math.max(950, (max + 1) * 246 + 30);
  const rows = Math.max(1, ...Array.from({ length: max + 1 }, (_, col) => p.tasks.filter(t => levels.get(t.id) === col).length));
  const height = Math.max(340, rows * 192 + 65);
  return `<div class="graph-scroll"><div class="graph-canvas" style="width:${width}px;height:${height}px"><svg class="edges" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7f91b8"/></marker></defs>${p.tasks.flatMap(t => (t.dependsOn ?? []).map(id => {
    const from = positions.get(id), to = positions.get(t.id);
    if (!from || !to) return '';
    return `<path d="M${from.x + 210},${from.y + 78} C${from.x + 230},${from.y + 78} ${to.x - 20},${to.y + 78} ${to.x - 4},${to.y + 78}" fill="none" stroke="${t.status === 'done' ? '#6ecdb5' : '#4a6084'}" stroke-width="1.5" marker-end="url(#arrow)"/>`;
  })).join('')}</svg>${p.tasks.map((t, i) => {
    const pos = positions.get(t.id) ?? { x: 25, y: 34 };
    return renderTaskNode(t, i, selected, resolveAgent, `style="left:${pos.x}px;top:${pos.y}px"`);
  }).join('')}<span class="canvas-label">${icon('branch')} WORKFLOW / ${h(p.name.toUpperCase())}</span></div></div>`;
}

function renderTaskList(p, resolveAgent) {
  return `<div class="task-list">${p.tasks.map((t, i) => `<button type="button" data-action="select-task" data-id="${h(t.id)}"><span class="task-number">${String(i + 1).padStart(2, '0')}</span><strong>${h(t.title)}</strong><span>${t.agentIds.map(id => avatar(resolveAgent(id), true)).join('')}</span>${badge(t.status)}${icon('chevron')}</button>`).join('')}</div>`;
}

function renderTree(p) {
  const rows = tasks => tasks.map(t => `<div class="tree-task"><button type="button" data-action="select-task" data-id="${h(t.id)}">${icon(t.parentId ? 'users' : 'branch')}<strong>${h(t.title)}</strong>${badge(t.status)}</button>${t.children?.length ? `<div class="tree-child">${rows(t.children)}</div>` : ''}</div>`).join('');
  const count = p.execution?.tasks?.filter(t => t.parentId).length ?? p.tasks.reduce((n, t) => n + (t.children?.length ?? 0), 0);
  return `<div class="subtree"><div class="tree-root">${icon('layers')} ${h(p.name)}</div>${rows(p.tasks)}<p class="muted text-small">${p.execution?.mode === 'real' ? `Створено дочірніх задач: ${count}. Ліміт глибини: ${Number(p.maxDepth ?? 2) || 0}.` : 'Демонстраційне дерево задач.'}</p></div>`;
}

function renderPlanningDetails(p, t) {
  const assignment = p.planning?.routing?.assignments.find(a => a.taskId === t.id);
  return (t.acceptanceCriteria?.length ? '<div class="drawer-section"><h3>Критерії готовності</h3><ul class="acceptance-list">' + t.acceptanceCriteria.map(v => '<li>' + h(v) + '</li>').join('') + '</ul></div>' : '') +
    (assignment ? '<div class="drawer-section"><h3>Чому обрано ці профілі ролей</h3><p>' + h(assignment.reason) + '</p><small class="muted">' + (assignment.manual ? 'Призначення скориговано вручну' : p.planning.teamSource?.mode === 'ai' ? 'AI-рекомендація профілів' : 'Демо-правило за навичками') + '</small></div>' : '');
}

export function renderTaskDrawer(p, { selected, stateAgents, execution, resolveAgent, isLocked }) {
  const t = p.tasks.find(item => item.id === selected) ?? p.execution?.tasks?.find(item => item.id === selected);
  if (!t) return '';
  const summary = summarizeTaskModels(p, t, stateAgents, execution?.routingState(p.id));
  const pill = (billing, billingBoundary) => {
    const b = formatBillingBadge(billing, billingBoundary);
    return `<span class="billing-pill ${h(b.tone)}">${h(b.shortLabel)}</span>`;
  };
  return `<div class="drawer-backdrop" data-live-key="task-drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" data-live-key="task-drawer" aria-label="Деталі задачі"><div class="drawer-heading"><span class="eyebrow">ДЕТАЛІ ЗАДАЧІ</span>${button('close-drawer', '', 'close', 'btn icon-btn', 'aria-label="Закрити деталі"')}</div>${badge(t.status)}<h2>${h(t.title)}</h2><p>${h(t.prompt)}</p><div class="drawer-section"><h3>Рекомендовані профілі (орієнтир)</h3>${summary.recommended.map(a => { const full = resolveAgent(a.id); return `<div class="drawer-agent">${avatar(full)}<span>${h(a.name)}<small>Профіль: ${h(a.model)} · ${h(a.provider)}</small></span></div>`; }).join('')}</div><div class="drawer-section"><h3>AI-маршрути (/api/routing)</h3>${summary.routed ? `${summary.routed.stale ? '<p class="route-blocked text-small">Пропозиція застаріла (план змінився після підбору)</p>' : ''}${summary.routed.routes.map(r => `<p><code>${h(r.id)}</code> → <strong>${h(r.model)}</strong> ${pill(r.billing, r.billingBoundary)} <small class="muted">(${h(r.backend)})</small></p>`).join('')}<p class="muted text-small">${h(summary.routed.reason)}</p>` : '<p class="muted text-small">Точні маршрути ще не підібрані. Налаштуйте у вкладці «План».</p>'}</div><div class="drawer-section"><h3>Фактичні виконавці запуску</h3>${summary.actual.active ? (summary.actual.agents.length ? summary.actual.agents.map(a => `<p><strong>${h(a.name)}</strong> → ${h(a.model)} ${pill(a.billing, a.billingBoundary)} · ${h(a.access)}</p>`).join('') : '<p class="muted text-small">Для ролей цієї задачі виконавець не зафіксований.</p>') : '<p class="muted text-small">Ще не призначені — обираються перед запуском команди.</p>'}</div><div class="drawer-section"><h3>Залежності</h3>${t.dependsOn.length ? t.dependsOn.map(id => `<div class="dependency">${icon('link')}${h(p.tasks.find(d => d.id === id)?.title)}</div>`).join('') : '<p class="muted">Може починатися незалежно.</p>'}</div>${t.children ? `<div class="drawer-section"><h3>Субагенти</h3>${t.children.map(c => `<div class="dependency">${h(c.title)} ${badge(c.status)}</div>`).join('')}</div>` : ''}<div class="drawer-section"><h3>Результат</h3><p>${h(t.result ?? 'Результат з’явиться після завершення задачі.')}</p></div>${t.error ? `<div class="drawer-section execution-error"><h3>Помилка</h3><pre>${h(t.error)}</pre></div>` : ''}${renderPlanningDetails(p, t)}<div class="drawer-actions">${!t.parentId && !isLocked ? button('edit-task', 'Редагувати', 'settings', 'btn', `data-id="${h(t.id)}"`) : ['pending', 'running', 'waiting_children'].includes(t.status) ? button('cancel-task', 'Скасувати задачу', 'stop', 'btn', `data-id="${h(t.id)}"`) : ''}</div></aside>`;
}

export function renderPlanSection(p, { view, selected, stateAgents, execution, resolveAgent, isLocked }) {
  return `<div class="plan-layout"><section class="panel graph-panel"><div class="panel-heading"><div><h2>Сонячна система та задачі <span class="count">${p.tasks.length}</span></h2><p class="muted text-small">Залежності задач і призначені виконавці</p></div>${button('new-task', 'Задача', 'plus', 'btn small-btn', isLocked ? 'disabled title="Редагування доступне після завершення запуску"' : '')}</div><div class="graph-toolbar"><div class="segmented">${[['solar', 'orbit', 'Сонячна система'], ['graph', 'branch', 'Граф'], ['list', 'layers', 'Список'], ['tree', 'users', 'Субагенти']].map(([id, glyph, label]) => button(`view-${id}`, label, glyph, view === id ? 'chosen' : '')).join('')}</div><div class="graph-legend"><span class="legend-dot done"></span>Готово<span class="legend-dot running"></span>В роботі<span class="legend-dot pending"></span>У черзі</div></div>${view === 'solar' ? '<div id="solar-stage" data-live-key="solar-stage"></div>' : view === 'graph' ? renderGraph(p, selected, resolveAgent) : view === 'list' ? renderTaskList(p, resolveAgent) : renderTree(p)}<div class="graph-footer"><span>${icon('link')}${view === 'solar' ? 'Натисніть Сонце, планету або супутник для деталей' : 'Натисніть задачу, щоб переглянути деталі'}</span><span>${p.execution?.mode === 'real' ? `ІЗОЛЬОВАНІ WORKTREE · ${Number(p.concurrency) || 1} паралельних викликів` : 'ДЕМО · ' + (Number(p.concurrency) || 1) + ' паралельні задачі'}</span></div></section><section class="panel team-summary"><div class="panel-heading"><h2>Команда проєкту</h2><button type="button" class="text-button" data-action="tab" data-id="team">${icon('settings')}</button></div>${p.team.map(id => { const a = resolveAgent(id); if (!a) return ''; const working = p.tasks.some(t => t.status === 'running' && t.agentIds.includes(id)); return `<button type="button" class="team-member" data-action="agent-detail" data-id="${h(id)}">${avatar(a)}<span><strong>${h(a.name)}</strong><small>${h(a.model)}</small></span><span class="availability ${working ? 'busy' : ''}" title="${working ? 'Виконує задачу' : 'Профіль ролі'}"></span></button>`; }).join('')}<div class="team-summary-footer">${icon('shield')}Агенти працюють у межах<br>прав та бюджету проєкту</div></section></div>${selected ? renderTaskDrawer(p, { selected, stateAgents, execution, resolveAgent, isLocked }) : ''}`;
}

export function renderTeamPage(p, { execution, resolveAgent, isLocked }) {
  const routingEntry = execution?.routingState(p.id);
  return `${renderRoutingSection(p, routingEntry, execution?.catalog, { h, icon, button })}
    <div class="section-heading section-spaced"><div><h2>Рекомендовані профілі ролей (${p.team.length})</h2><p class="muted">Рольові шаблони та навички команди — це орієнтир, а не підтверджений маршрут запуску.</p></div>${button('choose-team', 'Додати агента', 'plus')}</div>
    <div class="agent-grid">${p.team.map(id => resolveAgent(id)).filter(Boolean).map(a => renderAgentCard(a, p, isLocked)).join('')}</div>
    <section class="panel actual-executors-note" data-live-key="actual-executors-note"><div class="panel-heading"><h2>Фактичні виконавці запуску</h2><span class="provider-pill">${p.execution?.mode === 'real' ? 'Зафіксовано у запуску' : 'Не призначено'}</span></div>${p.execution?.mode === 'real' ? `<div class="execution-bindings">${(p.execution.agents ?? []).map(a => { const b = formatBillingBadge(a.billing, a.billingBoundary); return `<span>${h(a.name)} → <b>${h(a.model)}</b> <span class="billing-pill ${h(b.tone)}">${h(b.shortLabel)}</span><small>${h(a.provider)} · ${h(a.access)}</small></span>`; }).join('')}</div>` : `<div class="info-note">${icon('shield')}Рекомендовані профілі та AI-маршрути (<code>/api/routing</code>) не запускають код самі по собі. Фактичні виконавці й права доступу фіксуються окремо перед реальним запуском команди.</div>`}</section>`;
}

export function renderArtifactsPage(p, execution) {
  const resolved = execution.resultsFor(p);
  const stages = new Map((resolved.execution?.tasks ?? resolved.tasks).map(task => [task.id, task]));
  const report = (a, completed) => {
    const attr = `data-id="${h(a.id)}"`;
    return `<article class="panel artifact"><span class="project-glyph ${completed ? 'green' : ''}">${icon('file')}</span>
      <h3>${h(a.name)}</h3><p>${completed ? 'Завершений етап' : 'Звіт етапу'} · ${a.real ? 'Markdown' : 'Демонстрація'}</p>
      <div class="artifact-actions">${button('read-artifact', 'Читати звіт', 'file', 'btn', attr)}${button('download-artifact', 'Завантажити', 'download', 'btn', attr)}</div></article>`;
  };
  const completed = resolved.artifacts.filter(a => stages.get(a.taskId)?.status === 'done');
  const other = resolved.artifacts.filter(a => stages.get(a.taskId)?.status !== 'done');
  return `<div class="section-heading results-heading"><h2>Завершені етапи <span>${completed.length}</span></h2>
    <div class="artifact-actions">${button('project-preview', 'Перегляд проєкту', 'play', 'btn primary')}${button('export', 'Експортувати проєкт', 'download')}</div></div>
    ${completed.length ? `<div class="artifact-grid">${completed.map(a => report(a, true)).join('')}</div>` : '<div class="empty panel"><h3>Звіти з’являться після завершення етапів</h3></div>'}
    ${other.length ? `<div class="section-heading results-secondary"><h2>Інші звіти етапів</h2></div><div class="artifact-grid">${other.map(a => report(a, false)).join('')}</div>` : ''}
    <div class="results-secondary">${fileArtifacts(resolved, h, button)}</div>`;
}

export function renderConfigForm(p, isLocked) {
  return `<form id="config-form" data-live-key="config-form" class="panel settings-form"><div class="panel-heading"><h2>Налаштування проєкту</h2><span class="muted">Ревізія ${Number(p.revision) || 1}</span></div><label>Назва проєкту<input name="name" required maxlength="80" value="${h(p.name)}"></label><label>Мета та опис<textarea name="description" required maxlength="12000">${h(p.description)}</textarea></label><div class="form-grid"><label>Паралельні задачі<input name="concurrency" type="number" min="1" max="16" required value="${Number(p.concurrency) || 1}"></label><label>Ліміт викликів оркестратора<input name="maxCalls" type="number" min="1" max="10000" required value="${Number(p.maxCalls) || 1}"></label></div><div class="form-grid"><label>Глибина субагентів<input name="maxDepth" type="number" min="0" max="8" required value="${Number(p.maxDepth ?? 2) || 0}"></label><label>Ліміт усіх задач<input name="maxTasks" type="number" min="1" max="1000" required value="${Number(p.maxTasks ?? 100) || 1}"></label></div><label><input name="allowDelegation" type="checkbox" ${p.allowDelegation !== false ? 'checked' : ''}> Дозволити агентам створювати підзадачі</label><p class="muted text-small">Ліміт викликів діє для реального запуску, включно з усіма призначеними агентами. Делегування також витрачає виклики. Незалежні задачі працюють в окремих worktree.</p><div class="form-footer">${button('export', 'Експортувати JSON', 'download')}<button class="btn primary" type="submit" ${isLocked ? 'disabled' : ''}>Зберегти ревізію</button></div></form>`;
}

export function renderProjectPage(p, {
  tab, view, selected, stateAgents, execution, projectChat,
  verifyingHost, resumingCancelled, resolveAgent, isLocked
}) {
  const tabs = [
    ['plan', 'Сонячна система'],
    ['team', 'План'],
    ['activity', 'Активність'],
    ['artifacts', 'Результати'],
    ['chat', 'Чат'],
    ['config', 'Налаштування']
  ];
  const streamState = execution?.streamState?.(p.execution?.id) ?? null;
  return `<div class="project-intro"><div><div class="eyebrow"><span class="project-dot orange"></span> ПРОЄКТ / РЕВІЗІЯ ${Number(p.revision) || 1}</div><h1>${h(p.name)}</h1><p>${h(p.description)}</p></div><div class="heading-actions">${button('edit-project', '', 'settings', 'btn icon-btn', 'aria-label="Редагувати проєкт"')}${renderRunControls(p, { execution, verifyingHost, resumingCancelled })}</div></div><div class="project-meta">${badge(p.status)}<span>${icon('users')}${p.team.length} агенти</span><span>${icon('shield')}Збалансований режим</span><span>${icon('code')}${p.execution?.mode === 'real' ? 'Реальний запуск AI-команди' : 'План проєкту / демо доступне окремо'}</span></div>${executionPanel(p, h, button, streamState)}<div class="tabs" data-live-key="project-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" role="tab" aria-selected="${tab === id}" class="${tab === id ? 'selected' : ''}" data-action="tab" data-id="${id}">${label}</button>`).join('')}</div>${
    tab === 'plan' ? renderPlanSection(p, { view, selected, stateAgents, execution, resolveAgent, isLocked })
    : tab === 'team' ? renderTeamPage(p, { execution, resolveAgent, isLocked })
    : tab === 'activity' ? `<section class="panel" data-live-key="activity-panel"><div class="panel-heading"><h2>Журнал запуску</h2>${button('export', 'Експортувати', 'download')}</div>${renderActivity(p, 100)}</section>`
    : tab === 'artifacts' ? renderArtifactsPage(p, execution)
    : tab === 'chat' ? projectChat.panel(p.id, execution.ready)
    : renderConfigForm(p, isLocked)
  }`;
}
