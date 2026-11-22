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

export const hasVerificationChecks=task=>Boolean(task.verificationBlockers?.length||task.pendingVerificationChecks?.length);

function runStateNote(runStatus, run, h) {
  if (runStatus==='completed'&&run.testCompletion) return '<div class="execution-state-note" role="status">Тестовий запуск завершено. Реальний пілот, продажі й приймальні перевірки перед запуском відкладено.</div>';
  if (run.hostChecking) return '<div class="execution-state-note paused" role="status">Локальний верифікатор виконує доступні тести. Результати збережуться автоматично.</div>';
  if (run.draining) {
    return '<div class="execution-state-note paused">Зупиняється… Очікуємо завершення активних викликів без нових запусків.</div>';
  }
  if (runStatus === 'paused') {
    return '<div class="execution-state-note paused">Чергу поставлено на паузу. Активні виклики завершуються, нові не стартують.</div>';
  }
  if (['blocked','failed'].includes(runStatus) && (run.tasks??[]).some(hasVerificationChecks)) {
    if(run.tasks.some(task=>task.canVerifyOnHost&&task.hostVerificationAutomatic&&task.hostVerificationProgress?.attempt!==task.attempts))
      return '<div class="execution-state-note paused" role="status">Оркестратор автоматично запустить доступні перевірки чернетки.</div>';
    if(run.tasks.some(task=>task.hostVerificationProgress?.attempt===task.attempts&&task.pendingVerificationChecks?.length))
      return '<div class="execution-state-note paused" role="status">Локальні результати збережено. Нижче наведено перевірки, від яких залежить приймання чернетки.</div>';
    if(run.tasks.some(task=>task.canVerifyOnHost))return '<div class="execution-state-note paused" role="status">Для збереженої чернетки доступні локальні перевірки.</div>';
    return '<div class="execution-state-note paused" role="status">Обов’язкові перевірки чекають на доступне середовище. Чернетки збережено. Повторіть перевірки після усунення блокера.</div>';
  }
  if(runStatus==='blocked'&&(run.tasks??[]).some(t=>t.failure?.code==='AGENT_BLOCKED'))return '<div class="execution-state-note paused" role="status">Потрібне уточнення вимог. Підготовлені матеріали збережені в чернетці; заміна моделі не потрібна.</div>';
  if(runStatus==='blocked'&&(run.tasks??[]).some(t=>t.failure?.code==='WORKSPACE_CONFLICT'))return '<div class="execution-state-note paused" role="status">Потрібно узгодити зміни файлів. Прийняті результати й чернетка збережені; продовження виконає перевірки в окремій робочій папці.</div>';
  if (run.recovery?.status === 'planning' && runStatus === 'running') {
    return '<div class="execution-state-note paused">AI-керівник підбирає заміну невдалим виконавцям. Готові результати збережено.</div>';
  }
  if (runStatus === 'failed') {
    const failedTasks = (run.tasks ?? []).filter(t => t.status==='failed'||t.status==='blocked'&&(t.error||t.failure));
    const dependentCount=(run.tasks??[]).filter(t=>t.status==='blocked'&&!t.error&&!t.failure).length;
    const detail = failedTasks.slice(0,3).map(t => `${t.title}: ${t.error ?? t.failure?.message ?? 'помилка виконання'}`).join(' · ');
    return `<div class="execution-state-note failed">Запуск завершився помилкою.${detail ? ' ' + h(detail) : ''}${failedTasks.length>3?` Ще задач із помилками: ${failedTasks.length-3}. Деталі — у звіті запуску.`:''}${dependentCount?` Залежні задачі не запускалися: ${dependentCount}.`:''}${run.recovery?.reason ? ' Відновлення зупинено: ' + h(run.recovery.reason) : ''}</div>`;
  }
  if (runStatus === 'cancelled') {
    if (run.canResumeCancelled) return `<div class="execution-state-note cancelled">Можна продовжити цей запуск зі збережених чернеток після перевірки доступу. Використано ${h(run.calls)} із ${h(run.maxCalls)} викликів оркестратора.</div>`;
    return '<div class="execution-state-note cancelled">Запуск скасовано. Зміни файлів, що вже відбулися, не відкочуються автоматично.</div>';
  }
  if (runStatus === 'interrupted') {
    return '<div class="execution-state-note failed">Запуск перервано перезапуском сервера.</div>';
  }
  return '';
}

function draftDetails(task,h,{historical=false}={}) {
  const report=task.blockedReport;
  return `<details><summary>${historical?'Чернетка та початковий звіт агента':'Підготовлені матеріали та перевірки'}</summary>
    ${historical&&report?.summary?`<p>${h(report.summary)}</p>`:''}
    <ul>${(report?.files??[]).map(path=>`<li>${h(path)}</li>`).join('')}</ul>
    <pre>${h((report?.checks??[]).map(c=>`${c.command}: ${c.status}${c.required===false?' (необов’язкова)':''}\n${c.details}`).join('\n'))}</pre>
    <p class="workspace-path">${h(task.workspace?.path??'')}</p>
  </details>`;
}

function verificationCard(task,run,h,button) {
  const verification=task.hostVerificationProgress;
  const progress=verification&&verification.attempt===task.attempts?verification.checks:[];
  const local=new Map(progress.map(check=>[check.command,check]));
  const original=new Map((task.verificationBlockers??[]).map(check=>[check.command,check.reason]));
  const pending=task.pendingVerificationChecks??task.verificationBlockers??[];
  return `<div class="info-note"><div><strong>${h(task.title)}</strong>
    <ul>${progress.filter(check=>check.status==='passed').map(check=>`<li><code>${h(check.command)}</code> · Пройшла локально</li>`).join('')}
    ${pending.map(check=>`<li><code>${h(check.command)}</code> · ${h(local.get(check.command)?.details??original.get(check.command)??'Очікує перевірки')}</li>`).join('')}</ul>
    ${task.canVerifyOnHost?button('verify-host-run','Запустити локальні перевірки','play','btn primary',`data-id="${h(task.id)}" ${run.hostChecking?'disabled':''}`):''}
    ${task.blockedReport?draftDetails(task,h,{historical:true}):''}
  </div></div>`;
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
        <span class="provider-pill">${Number(run.calls) || 0}${run.maxCalls==null?'':` / ${Number(run.maxCalls) || 0}`} викликів</span>
      </div>
    </div>
    ${runStateNote(runStatus, run, h)}
    ${(run.tasks??[]).filter(hasVerificationChecks).map(t=>verificationCard(t,run,h,button)).join('')}
    ${run.brief?`<details><summary>Уточнені вимоги проєкту</summary><p class="text-small">${h(run.brief)}</p></details>`:''}
    ${(run.tasks??[]).filter(t=>t.status==='blocked'&&t.failure?.code==='AGENT_BLOCKED'&&!hasVerificationChecks(t)).map(t=>`<div class="info-note"><div><strong>${h(t.title)}</strong><p>${h(t.blockedReport?.summary??t.error)}</p>${draftDetails(t,h)}</div></div>`).join('')}
    <p class="workspace-path">${h(run.workspace)}</p>
    <div class="execution-bindings">${run.agents.map(a => {
      const b = formatBillingBadge(a.billing, a.billingBoundary);
      return `<span class="execution-binding-card">
        <strong>${h(a.name)} → <b>${h(a.model)}</b></strong>
        <small>${h(a.provider)} · ${h(a.access)}</small>
        <span class="billing-pill ${b.tone}">${h(b.label)}</span>
      </span>`;
    }).join('')}</div>
    <p class="muted text-small">План v${Number(run.uiRevision ?? p.revision ?? 1) || 1} · токени: ${Number(run.usage?.input) || 0} вхідних / ${Number(run.usage?.output) || 0} вихідних</p>
    <div class="execution-panel-footer">
      <small class="muted">Запуск ${h(run.id)}</small>
      ${run.canContinue?button('continue-run','Продовжити після таймауту','play','btn primary'):''}
      ${run.canRetryAccess?button('retry-access-run','Повторити після перевірки доступу','play','btn primary'):''}
      ${run.canRetryBudget?button('retry-budget-run','Продовжити зі збільшеним бюджетом','play','btn primary'):''}
      ${run.canClarify&&!run.hostChecking?(run.tasks??[]).some(hasVerificationChecks)?button('verify-blocked-run','Додати відомості вручну','file','btn small-btn'):button('clarify-run','Уточнити вимоги','spark','btn primary'):''}
      ${run.canIncreaseBudget?button('change-run-budget','Збільшити бюджет','settings','btn small-btn'):''}
      ${run.canBalanceGemini?button('balance-gemini-run','Передати частину задач Gemini','split','btn small-btn'):''}
      ${button('view-run', 'Звіт запуску', 'file', 'btn small-btn', `data-id="${h(run.id)}"`)}
    </div>
    ${run.canContinue?'<p class="muted text-small">Продовження повторить лише задачі після таймауту та розблокує їхні залежності. Готові результати й облік викликів зберігаються.</p>':''}
    ${run.canRetryAccess?'<p class="muted text-small">Перед продовженням повторно перевіримо підписку, квоту й тариф. Чернетки, готові результати та витрачені виклики зберігаються.</p>':''}
  </section>`;
}

export function fileArtifacts(p, h, button) {
  if (p.execution?.mode !== 'real') return '';
  return `<section class="panel execution-files" data-live-key="execution-files"><h2>Файли робочої папки</h2><p class="muted text-small">Маніфест фіксується після завершення запуску. Завантаження читає поточний файл у папці проєкту.</p>${p.execution.files.length ? p.execution.files.map(f => `<div class="execution-file"><span><strong>${h(f.path)}</strong><small>${h({ created: 'Створено', modified: 'Змінено', unchanged: 'Без змін', deleted: 'Видалено' }[f.change] ?? f.change)} · ${Number(f.size) || 0} байтів</small></span>${f.change !== 'deleted' ? button('execution-file', 'Завантажити', 'download', 'btn small-btn', `data-path="${h(f.path)}"`) : ''}</div>`).join('') : '<p>Список з’явиться після завершення або зупинки запуску.</p>'}</section>`;
}

export function runHistory(runs, h, button, labels) {
  return `<section class="panel run-list"><div class="panel-heading"><h2>Реальні запуски <span>${runs.length}</span></h2></div>${runs.length ? runs.map(r => `<button type="button" data-action="view-run" data-id="${h(r.id)}"><span class="project-glyph purple">↗</span><span><strong>${h(r.name)}</strong><small>${h(new Date(r.createdAt).toLocaleString('uk-UA'))} · план v${Number(r.uiRevision) || 1} · ${Number(r.calls) || 0} викликів</small></span><span class="badge ${h(r.status)}">${h(labels[r.status] ?? r.status)}</span></button>`).join('') : '<p class="empty compact">Після першого запуску тут буде його історія.</p>'}</section>`;
}
