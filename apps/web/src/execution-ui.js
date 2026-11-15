import { formatBillingBadge } from './routing-ui.js';

function streamIndicator(streamState, runStatus, run, h) {
  if (!['running', 'paused'].includes(runStatus) && !run.draining) return '';
  if (!streamState) return '<span class="sse-pill"><i></i>Потік очікує</span>';
  if (streamState.status === 'live') return '<span class="sse-pill live"><i></i>SSE LIVE</span>';
  if (streamState.status === 'reconnecting') {
    return `<span class="sse-pill reconnecting"><i></i>SSE перепідключення (${streamState.attempts})…</span>`;
  }
  if (streamState.status === 'error') {
    return `<span class="sse-pill error"><i></i>${h(streamState.error ?? 'Потік подій недоступний')}</span>`;
  }
  return '<span class="sse-pill"><i></i>Підключення SSE…</span>';
}

function runStateNote(runStatus, run, h) {
  if (run.draining) {
    return '<div class="execution-state-note paused">Зупиняється… Очікуємо завершення активних викликів без нових запусків.</div>';
  }
  if (runStatus === 'paused') {
    return '<div class="execution-state-note paused">Чергу поставлено на паузу. Активні виклики завершуються, нові не стартують.</div>';
  }
  if (run.recovery?.status === 'planning' && runStatus === 'running') {
    return '<div class="execution-state-note paused">AI-керівник підбирає заміну невдалим виконавцям. Готові результати збережено.</div>';
  }
  if (runStatus === 'failed') {
    const failedTasks = (run.tasks ?? []).filter(t => ['failed', 'blocked'].includes(t.status));
    const detail = failedTasks.map(t => `${t.title}: ${t.error ?? 'помилка виконання'}`).join(' · ');
    return `<div class="execution-state-note failed">Запуск завершився помилкою.${detail ? ' ' + h(detail) : ''}${run.recovery?.reason ? ' Відновлення зупинено: ' + h(run.recovery.reason) : ''}</div>`;
  }
  if (runStatus === 'cancelled') {
    return '<div class="execution-state-note cancelled">Запуск скасовано. Зміни файлів, що вже відбулися, не відкочуються автоматично.</div>';
  }
  if (runStatus === 'interrupted') {
    return '<div class="execution-state-note failed">Запуск перервано перезапуском сервера.</div>';
  }
  return '';
}

export function executionPanel(p, h, button, streamState = null) {
  if (p.execution?.mode !== 'real') return '';
  const run = p.execution;
  const runStatus = run.status ?? p.status;
  return `<section class="panel execution-panel" data-live-key="execution-panel">
    <div class="panel-heading">
      <div>
        <span class="eyebrow">ФАКТИЧНІ ВИКОНАВЦІ ЗАПУСКУ</span>
        <h2>Реальне виконання команди</h2>
        <p class="muted text-small">Зафіксовані виконавці цього запуску (окремо від AI-пропозиції та рольових шаблонів).</p>
      </div>
      <div class="execution-head-right">
        ${streamIndicator(streamState, runStatus, run, h)}
        <span class="provider-pill">${run.calls} викликів</span>
      </div>
    </div>
    ${runStateNote(runStatus, run, h)}
    <p class="workspace-path">${h(run.workspace)}</p>
    <div class="execution-bindings">${run.agents.map(a => {
      const b = formatBillingBadge(a.billing, a.billingBoundary);
      return `<span class="execution-binding-card">
        <strong>${h(a.name)} → <b>${h(a.model)}</b></strong>
        <small>${h(a.provider)} · ${h(a.access)}</small>
        <span class="billing-pill ${b.tone}">${h(b.label)}</span>
      </span>`;
    }).join('')}</div>
    <p class="muted text-small">План v${run.uiRevision ?? p.revision ?? 1} · токени: ${run.usage?.input ?? 0} вхідних / ${run.usage?.output ?? 0} вихідних</p>
    <div class="execution-panel-footer">
      <small class="muted">Запуск ${h(run.id)}</small>
      ${button('view-run', 'Звіт запуску', 'file', 'btn small-btn', `data-id="${h(run.id)}"`)}
    </div>
  </section>`;
}

export function fileArtifacts(p, h, button) {
  if (p.execution?.mode !== 'real') return '';
  return `<section class="panel execution-files" data-live-key="execution-files"><h2>Файли робочої папки</h2><p class="muted text-small">Маніфест фіксується після завершення запуску. Завантаження читає поточний файл у папці проєкту.</p>${p.execution.files.length ? p.execution.files.map(f => `<div class="execution-file"><span><strong>${h(f.path)}</strong><small>${h({ created: 'Створено', modified: 'Змінено', unchanged: 'Без змін', deleted: 'Видалено' }[f.change] ?? f.change)} · ${f.size} байтів</small></span>${f.change !== 'deleted' ? button('execution-file', 'Завантажити', 'download', 'btn small-btn', `data-path="${h(f.path)}"`) : ''}</div>`).join('') : '<p>Список з’явиться після завершення або зупинки запуску.</p>'}</section>`;
}

export function runHistory(runs, h, button, labels) {
  return `<section class="panel run-list"><div class="panel-heading"><h2>Реальні запуски <span>${runs.length}</span></h2></div>${runs.length ? runs.map(r => `<button data-action="view-run" data-id="${h(r.id)}"><span class="project-glyph purple">↗</span><span><strong>${h(r.name)}</strong><small>${h(new Date(r.createdAt).toLocaleString('uk-UA'))} · план v${r.uiRevision} · ${r.calls} викликів</small></span><span class="badge ${h(r.status)}">${h(labels[r.status] ?? r.status)}</span></button>`).join('') : '<p class="empty compact">Після першого запуску тут буде його історія.</p>'}</section>`;
}
