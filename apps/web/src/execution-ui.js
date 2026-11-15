export function executionPanel(p,h,button) {
  if(p.execution?.mode!=='real')return '';
  const run=p.execution;
  return `<section class="panel execution-panel"><div class="panel-heading"><h2>Реальне виконання · Codex CLI</h2><span>${run.calls} викликів</span></div><p class="workspace-path">${h(run.workspace)}</p><div class="execution-bindings">${run.agents.map(a=>`<span>${h(a.name)} → <b>${h(a.model)}</b><small>codex · ${h(a.access)}</small></span>`).join('')}</div><p class="muted text-small">План v${run.uiRevision} · токени CLI: ${run.usage?.input??0} вхідних / ${run.usage?.output??0} вихідних</p><small class="muted">Запуск ${h(run.id)}</small>${button('view-run','Звіт запуску','file','btn small-btn',`data-id="${h(run.id)}"`)}</section>`;
}
export function fileArtifacts(p,h,button) {
  if(p.execution?.mode!=='real')return '';
  return `<section class="panel execution-files"><h2>Файли робочої папки</h2><p class="muted text-small">Маніфест фіксується після завершення запуску. Завантаження читає поточний файл у папці проєкту.</p>${p.execution.files.length?p.execution.files.map(f=>`<div class="execution-file"><span><strong>${h(f.path)}</strong><small>${h({created:'Створено',modified:'Змінено',unchanged:'Без змін',deleted:'Видалено'}[f.change]??f.change)} · ${f.size} байтів</small></span>${f.change!=='deleted'?button('execution-file','Завантажити','download','btn small-btn',`data-path="${h(f.path)}"`):''}</div>`).join(''):'<p>Список з’явиться після завершення або зупинки запуску.</p>'}</section>`;
}
export function runHistory(runs,h,button,labels) {
  return `<section class="panel run-list"><div class="panel-heading"><h2>Реальні запуски <span>${runs.length}</span></h2></div>${runs.length?runs.map(r=>`<button data-action="view-run" data-id="${h(r.id)}"><span class="project-glyph purple">↗</span><span><strong>${h(r.name)}</strong><small>${h(new Date(r.createdAt).toLocaleString('uk-UA'))} · план v${r.uiRevision} · ${r.calls} викликів</small></span><span class="badge ${h(r.status)}">${h(labels[r.status]??r.status)}</span></button>`).join(''):'<p class="empty compact">Після першого запуску тут буде його історія.</p>'}</section>`;
}
