export function formatBillingBadge(billing, billingBoundary) {
  if (billing === 'subscription_included') {
    return {
      label: billingBoundary === 'subscription_quota_guarded' ? 'Підписка (контроль квоти)' : billingBoundary === 'included_only' ? 'Включено до підписки' : 'Підписка · межу списань не підтверджено',
      shortLabel: 'Підписка',
      tone: 'subscription'
    };
  }
  if (billing === 'free_tier') {
    return {
      label: 'Безкоштовний маршрут',
      shortLabel: 'Безкоштовний маршрут',
      tone: 'free'
    };
  }
  if (billing === 'metered') {
    return { label: 'Оплата за фактом (заблоковано)', shortLabel: 'За фактом', tone: 'blocked' };
  }
  if (billing === 'local') {
    return { label: 'Локальний запуск', shortLabel: 'Локально', tone: 'neutral' };
  }
  return { label: 'Тариф не підтверджено', shortLabel: 'Невідомо', tone: 'unknown' };
}

const priorityLabels = {
  quality: 'Якість і продуманість',
  balanced: 'Баланс якості та витрат',
  economy: 'Економія ресурсів'
};

export function catalogManager(catalog) {
  if(typeof catalog?.manager!=='string')return catalog?.manager??null;
  const route=catalog.routes?.find(r=>r.id===catalog.manager);
  return {routeId:catalog.manager,model:route?.model,available:route?.decision?.allowed===true,reason:route?.decision?.reason};
}

export function mapWizardPriorityToRouting(priority) {
  if (priority === 'cost' || priority === 'economy') return 'economy';
  if (priority === 'quality') return 'quality';
  return 'balanced';
}

export function isProposalStale(project, routingEntry) {
  if (!project || !routingEntry?.proposal) return Boolean(routingEntry?.stale);
  return Boolean(routingEntry.stale) || Number(routingEntry.proposal.revision) !== Number(project.revision);
}

export function defaultTaskModes(project, routingEntry) {
  const savedReq = routingEntry?.draftConfig?.requirements ?? routingEntry?.proposal?.requirements ?? {};
  const modes = {};
  for (const t of project?.tasks ?? []) {
    if (t.parentId) continue;
    const req = savedReq[t.id];
    modes[t.id] = req==='text'||req?.workspaceWrite===false ? 'text' : 'write';
  }
  return modes;
}

export function buildRoutingPayload(project, draftConfig = {}) {
  const priority = mapWizardPriorityToRouting(draftConfig.priority ?? project?.planning?.priority);
  const maxAgentsPerTask = Math.max(1, Math.min(6, Number(draftConfig.maxAgentsPerTask ?? 1) || 1));
  const managerRouteId = draftConfig.managerRouteId ? String(draftConfig.managerRouteId) : undefined;
  const modes = draftConfig.requirements ?? {};
  const requirements = {};
  for (const t of project?.tasks ?? []) {
    if (t.parentId) continue;
    const writeNeeded = (modes[t.id] ?? 'write') !== 'text';
    requirements[t.id] = { workspaceWrite: writeNeeded, tools: false };
  }
  return {
    projectId: project.id,
    revision: project.revision,
    priority,
    maxAgentsPerTask,
    ...(managerRouteId ? { managerRouteId } : {}),
    requirements
  };
}

export function summarizeTaskModels(project, task, agents = [], routingEntry = null) {
  const agentMap = new Map(agents.map(a => [a.id, a]));
  const recommended = (task?.agentIds ?? []).map(id => {
    const a = agentMap.get(id);
    return a ? { id: a.id, name: a.name, model: a.model, provider: a.provider } : { id, name: id, model: '—', provider: 'Профіль' };
  });

  const proposal = routingEntry?.proposal ?? null;
  const assignment = proposal?.assignments?.find(a => a.taskId === task?.id) ?? null;
  const routeMap = new Map((proposal?.routes ?? []).map(r => [r.id, r]));
  const routed = assignment
    ? {
        stale: isProposalStale(project, routingEntry),
        revision: proposal.revision,
        reason: assignment.reason,
        routes: (assignment.routeIds ?? []).map(routeId => routeMap.get(routeId) ?? { id: routeId, model: routeId, backend: 'route', billing: 'unknown' })
      }
    : null;

  const actualTask=project?.execution?.tasks?.find(t=>t.id===task?.id);
  const actualIds=actualTask?.assignedAgentIds??actualTask?.agentIds??task?.agentIds??[];
  const execAgents = project?.execution?.mode === 'real'
    ? (project.execution.agents ?? []).filter(a => actualIds.includes(a.id)).map(a => ({ ...a, billingInfo: formatBillingBadge(a.billing, a.billingBoundary) }))
    : [];

  return {
    recommended,
    routed,
    actual: {
      active: project?.execution?.mode === 'real',
      agents: execAgents
    }
  };
}

export function renderRoutingSection(project, routingEntry, catalog, { h, icon, button }) {
  const routes = catalog?.routes ?? [];
  const allowedRoutes = routes.filter(r => r.decision?.allowed);
  const manager = catalogManager(catalog);
  const loading = Boolean(routingEntry?.loading);
  const proposing = Boolean(routingEntry?.proposing);
  const proposal = routingEntry?.proposal ?? null;
  const stale = isProposalStale(project, routingEntry);
  const locked = ['running', 'paused'].includes(project.status);

  const selectedPriority = mapWizardPriorityToRouting(
    routingEntry?.draftConfig?.priority ?? proposal?.priority ?? project.planning?.priority
  );
  const maxAgents = Number(routingEntry?.draftConfig?.maxAgentsPerTask ?? proposal?.maxAgentsPerTask ?? 1);
  const selectedManager = routingEntry?.draftConfig?.managerRouteId ?? proposal?.provenance?.routeId ?? '';
  const modes = defaultTaskModes(project, routingEntry);
  const rootTasks = (project.tasks ?? []).filter(t => !t.parentId);
  const routeMap = new Map((proposal?.routes ?? []).map(r => [r.id, r]));

  return `
    <section class="panel routing-panel" data-live-key="routing-panel" aria-label="AI-пропозиція команди">
      <div class="panel-heading">
        <div>
          <span class="eyebrow">AI-ПРОПОЗИЦІЯ КОМАНДИ · /API/ROUTING</span>
          <h2>AI-пропозиція моделей під план</h2>
          <p class="muted text-small">Плановий підбір маршрутів з каталогу <code>/api/connections</code>. Пропозиція не запускає задачі; фактичні виконавці фіксуються при старті запуску.</p>
        </div>
        <div class="routing-head-meta">
          <span class="provider-pill">${allowedRoutes.length} дозволено з ${routes.length}</span>
          ${button('routing-refresh', loading ? 'Оновлення…' : 'Синхронізувати', 'pulse', 'btn small-btn', loading || proposing ? 'disabled' : '')}
        </div>
      </div>

      ${!routes.length || !allowedRoutes.length ? `
        <div class="api-error-banner" role="alert">
          <strong>У каталозі немає дозволених моделей для підбору.</strong>
          Перейдіть у розділ <a href="#connections">«Підключення»</a> та оновіть сканування CLI (наприклад, анонімний OpenCode або авторизований Codex CLI).
        </div>
      ` : ''}

      ${manager && !manager.available ? `
        <div class="info-note">
          ${icon('shield')}AI-директор автоматично не вибраний: ${h(manager.reason ?? 'немає дозволеної моделі-директора')}.
        </div>
      ` : ''}

      ${loading || proposing ? `
        <div class="planning-busy" role="status">
          ${proposing ? 'AI-директор оцінює задачі плану v' + project.revision + ' та підбирає точні маршрути…' : 'Завантажуємо збережену пропозицію маршрутизації…'}
        </div>
      ` : ''}

      ${routingEntry?.error ? `
        <div class="api-error-banner" role="alert">
          <strong>Помилка AI-підбору (/api/routing):</strong> ${h(routingEntry.error)}
        </div>
      ` : ''}

      ${proposal && stale ? `
        <div class="routing-stale-banner" role="status">
          <div>
            <strong>Пропозиція застаріла</strong>
            <p class="text-small">План або команда змінились (ревізія плану v${project.revision}, пропозиція складена для v${proposal.revision}). Оновіть підбір перед орієнтацією на ці маршрути.</p>
          </div>
          <span class="badge pending"><i></i>Застаріла · v${proposal.revision} → v${project.revision}</span>
        </div>
      ` : ''}

      <form id="routing-form" class="routing-form" data-project="${h(project.id)}">
        <div class="form-grid routing-controls">
          <label>Пріоритет підбору
            <select name="priority" ${proposing ? 'disabled' : ''}>
              ${Object.entries(priorityLabels).map(([val, label]) => `<option value="${val}" ${selectedPriority === val ? 'selected' : ''}>${h(label)}</option>`).join('')}
            </select>
          </label>
          <label>Макс. моделей на задачу
            <input name="maxAgentsPerTask" type="number" min="1" max="6" value="${maxAgents}" ${proposing ? 'disabled' : ''}>
          </label>
          <label>Модель-директор (опційно)
            <select name="managerRouteId" ${proposing ? 'disabled' : ''}>
              <option value="">Автоматично (${h(manager?.available ? (manager.model ?? manager.routeId) : 'за каталогом')})</option>
              ${allowedRoutes.map(r => `<option value="${h(r.id)}" ${selectedManager === r.id ? 'selected' : ''}>${h(r.name)} (${h(r.backend)})</option>`).join('')}
            </select>
          </label>
        </div>

        <div class="routing-reqs-head">
          <div>
            <strong>Вимоги до можливостей задач</strong>
            <small class="muted">OpenCode передає зміни оркестратору: він застосовує їх у worktree та запускає перевірки. Прямі інструменти моделі не потрібні.</small>
          </div>
          <div class="routing-presets">
            <button type="button" class="btn small-btn" data-action="routing-preset" data-mode="text" ${proposing ? 'disabled' : ''}>Усі: лише текст</button>
            <button type="button" class="btn small-btn" data-action="routing-preset" data-mode="write" ${proposing ? 'disabled' : ''}>Усі: запис файлів</button>
          </div>
        </div>

        <div class="routing-task-reqs">
          ${rootTasks.map((t, idx) => `
            <div class="routing-req-row">
              <span><b>${String(idx + 1).padStart(2, '0')}</b> ${h(t.title)}</span>
              <select name="req-${h(t.id)}" ${proposing ? 'disabled' : ''}>
                <option value="write" ${modes[t.id] === 'write' ? 'selected' : ''}>Керовані зміни файлів (workspaceWrite: true)</option>
                <option value="text" ${modes[t.id] === 'text' ? 'selected' : ''}>Перевірка / аналіз без змін (workspaceWrite: false)</option>
              </select>
            </div>
          `).join('')}
        </div>

        <div class="form-footer">
          <span class="muted text-small">Запит зберігається на сервері для ревізії v${project.revision}.</span>
          <button type="submit" class="btn primary" ${proposing || locked ? 'disabled' : ''}>
            ${icon('spark')}${proposing ? 'Підбір триває…' : proposal ? 'Оновити AI-підбір моделей' : 'Підібрати точні моделі через AI'}
          </button>
        </div>
      </form>

      ${proposal ? `
        <div class="routing-results ${stale ? 'is-stale' : ''}">
          <div class="routing-provenance">
            <span class="badge ${stale ? 'pending' : 'done'}"><i></i>${stale ? 'Застаріла пропозиція' : 'Актуальна пропозиція · v' + proposal.revision}</span>
            <span>Директор: <strong>${h(proposal.provenance?.model ?? proposal.provenance?.routeId)}</strong> (${h(proposal.provenance?.provider ?? 'ai')})</span>
            <span>Час: ${h(new Date(proposal.provenance?.at ?? Date.now()).toLocaleString('uk-UA'))}</span>
            ${proposal.provenance?.usage ? `<span>Токени: ${Number(proposal.provenance.usage.input_tokens) || 0} → ${Number(proposal.provenance.usage.output_tokens) || 0}</span>` : ''}
          </div>

          <div class="routing-assignment-grid">
            ${proposal.assignments.map(a => {
              const task = rootTasks.find(t => t.id === a.taskId);
              return `<article class="routing-assignment-card">
                <div class="routing-card-head">
                  <h4>${h(task?.title ?? a.taskId)}</h4>
                  <small class="muted">${(proposal.requirements?.[a.taskId]?.workspaceWrite === false) ? 'Текстовий режим' : 'Запис файлів'}</small>
                </div>
                <div class="routing-route-chips">
                  ${(a.routeIds ?? []).map(routeId => {
                    const route = routeMap.get(routeId);
                    const b = formatBillingBadge(route?.billing, route?.billingBoundary);
                    return `<div class="routing-route-chip">
                      <div class="routing-chip-top">
                        <strong>${h(route?.model ?? routeId)}</strong>
                        <span class="billing-pill ${b.tone}">${h(b.label)}</span>
                      </div>
                      <code>${h(routeId)}</code>
                      <small>${h(route?.backend ?? '')} · AI-пропозиція</small>
                    </div>`;
                  }).join('')}
                </div>
                <p class="routing-reason">${h(a.reason)}</p>
              </article>`;
            }).join('')}
          </div>
        </div>
      ` : !loading ? '<p class="muted text-small routing-empty-note">Для цього проєкту ще немає збереженої AI-пропозиції маршрутизації (/api/routing).</p>' : ''}
    </section>
  `;
}
