import { buildSolarSystemModel } from './solar-model.js';
import { createSolarGL, mat4LookAt, mat4Multiply, mat4Perspective, projectWorldToScreen } from './solar-gl.js';
import { patchLiveDom } from './live-dom.js';
import { formatBillingBadge } from './routing-ui.js';

const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const uiState = {
  lastProjectId: null,
  yaw: 0.56,
  pitch: 0.42,
  zoom: 0.96,
  focusRef: null,
  camTarget: [0, 0, 0],
  motionPaused: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  showGrid: true,
  showLabels: true,
  fullscreen: false,
  selected: null,
  hovered: null,
  simTime: 0
};

// 1 = Gas Giant (rings), 2 = Earth, 3 = Ice Giant, 4 = Exoplanet
const PLANET_ARCHETYPES = {
  orange: { type: 1, atmo: [0.98, 0.72, 0.42], ring: [0.88, 0.76, 0.58], orbitRgb: [0.92, 0.62, 0.34], hasRing: true, tilt: 0.36, baseRadius: 8.6, tex: '/textures/gas_giant.jpg' },
  blue:   { type: 2, atmo: [0.35, 0.68, 1.00], ring: [0.55, 0.78, 0.96], orbitRgb: [0.36, 0.78, 0.98], hasRing: false, tilt: 0.41, baseRadius: 7.8, tex: '/textures/earth_day.jpg' },
  purple: { type: 3, atmo: [0.58, 0.52, 0.98], ring: [0.68, 0.65, 0.95], orbitRgb: [0.66, 0.56, 0.98], hasRing: false, tilt: 0.25, baseRadius: 8.2, tex: '/textures/ice_giant.jpg' },
  green:  { type: 4, atmo: [0.34, 0.90, 0.74], ring: [0.62, 0.90, 0.80], orbitRgb: [0.36, 0.88, 0.70], hasRing: false, tilt: 0.18, baseRadius: 7.5, tex: '/textures/exo_planet.jpg' }
};

function archetypeForPlanet(planet, idx) {
  if (planet.palette?.ring) return PLANET_ARCHETYPES.orange;
  if (planet.palette?.core === '#7ad7ff') return PLANET_ARCHETYPES.blue;
  if (planet.palette?.core === '#d4b3ff') return PLANET_ARCHETYPES.purple;
  if (planet.palette?.core === '#7ef0c8') return PLANET_ARCHETYPES.green;
  const list = Object.values(PLANET_ARCHETYPES);
  return list[idx % list.length];
}

const BELT_ASTEROIDS = Array.from({ length: 580 }, (_, i) => ({
  angle: (i / 580) * Math.PI * 2 + ((i * 17) % 10) * 0.015,
  rOffset: (((i * 37) % 100) / 100 - 0.5) * 28,
  yOffset: (((i * 53) % 100) / 100 - 0.5) * 6.5,
  size: 1.2 + ((i * 19) % 10) * 0.2,
  alpha: 0.22 + ((i * 29) % 10) * 0.05
}));

function spacedLabel(text) {
  const clean = String(text ?? '').trim().toUpperCase();
  return clean.length <= 16 ? clean.split('').join(' ') : clean;
}

function drawReticle(ctx, sx, sy, radius, color) {
  const r = radius + 8;
  const len = Math.max(6, Math.min(11, r * 0.42));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.beginPath();
    ctx.moveTo(sx + dx * r, sy + dy * (r - len));
    ctx.lineTo(sx + dx * r, sy + dy * r);
    ctx.lineTo(sx + dx * (r - len), sy + dy * r);
    ctx.stroke();
  }
  ctx.restore();
}

function resolveSelectedEntity(model) {
  if (!model || !uiState.selected) return null;
  if (uiState.selected.kind === 'sun') return model.sun;
  if (uiState.selected.kind === 'planet') {
    let idx = model.planets.findIndex(p => p.id === uiState.selected.id);
    if (idx === -1 && uiState.selected.agentIds?.length) {
      idx = model.planets.findIndex(p => p.agentIds?.some(id => uiState.selected.agentIds.includes(id)));
      if (idx !== -1) {
        uiState.selected = { ...uiState.selected, id: model.planets[idx].id };
        if (uiState.focusRef?.kind === 'planet') {
          uiState.focusRef = { ...uiState.focusRef, id: model.planets[idx].id };
        }
      }
    }
    if (idx === -1) return null;
    const p = model.planets[idx];
    return { ...p, tex: archetypeForPlanet(p, idx).tex };
  }
  if (uiState.selected.kind === 'moon') {
    for (const p of model.planets) {
      const moon = p.moons.find(m => m.key === uiState.selected.key || m.id === uiState.selected.id);
      if (moon) return { ...moon, parentPlanetName: p.name, parentPlanetModel: p.model };
    }
  }
  return null;
}

function billingBadgeHtml(billing, billingBoundary) {
  if (!billing && !billingBoundary) return '';
  const b = formatBillingBadge(billing, billingBoundary);
  return `<span class="billing-pill ${h(b.tone)}" title="${h(b.label)}">${h(b.shortLabel)}</span>`;
}

function solarRunControlsHtml(model, callbacks) {
  if (!callbacks.onRunAction) return '';
  const st = model.sun.status;
  const draining = Boolean(model.sun.draining);
  const btns = [];
  if (draining) {
    // A cancelled run can still own active calls; do not offer a new launch yet.
  } else if (st === 'running') {
    if (!draining) btns.push('<button type="button" class="solar-ctrl-btn" data-solar-control="pause">Пауза</button>');
    btns.push('<button type="button" class="solar-ctrl-btn danger" data-solar-control="cancel">Скасувати запуск</button>');
  } else if (st === 'paused') {
    btns.push('<button type="button" class="solar-ctrl-btn primary" data-solar-control="resume">Продовжити</button>');
    btns.push('<button type="button" class="solar-ctrl-btn danger" data-solar-control="cancel">Скасувати запуск</button>');
  } else {
    if (callbacks.canRealStart) {
      btns.push('<button type="button" class="solar-ctrl-btn primary" data-solar-control="real-start">Запустити AI</button>');
    }
    btns.push('<button type="button" class="solar-ctrl-btn" data-solar-control="start">Демо</button>');
  }
  if (model.sun.isReal) {
    btns.push('<button type="button" class="solar-ctrl-btn" data-solar-control="view-artifacts">Звіт / Артефакти</button>');
  }
  if (!btns.length) return '';
  return `
    <div class="solar-block">
      <h4>Дії керування</h4>
      ${draining ? '<p class="solar-event-note">Очікуємо завершення активних викликів…</p>' : ''}
      <div class="solar-inspector-actions">${btns.join('')}</div>
    </div>
  `;
}

function renderInspectorHtml(model, callbacks) {
  const entity = resolveSelectedEntity(model);
  if (!entity) return '';

  const isFocused = uiState.focusRef && (
    (entity.kind === 'sun' && uiState.focusRef.kind === 'sun') ||
    (entity.kind === 'planet' && uiState.focusRef.kind === 'planet' && uiState.focusRef.id === entity.id) ||
    (entity.kind === 'moon' && uiState.focusRef.kind === 'moon' && uiState.focusRef.key === entity.key)
  );
  const focusBtn = `<button type="button" class="solar-link-btn" data-solar-action="${isFocused ? 'reset-camera' : 'focus-selected'}">${isFocused ? 'Загальний огляд' : 'Наблизити камеру'}</button>`;

  if (entity.kind === 'sun') {
    const runningList = entity.runningTasks.length
      ? entity.runningTasks.map(t => `<button type="button" class="solar-chip-btn" data-solar-task="${h(t.id)}">${h(t.title)}</button>`).join('')
      : '<span class="solar-muted">Немає активних задач</span>';
    return `
      <aside class="solar-inspector" data-live-key="solar-inspector-sun" aria-label="Інспектор оркестратора">
        <div class="solar-inspector-head">
          <span class="solar-eyebrow">ОРКЕСТРАТОР · СОНЦЕ</span>
          <button type="button" class="solar-close" data-solar-action="close-inspector" aria-label="Закрити">×</button>
        </div>
        <div class="solar-inspector-title">
          <span class="solar-orb" style="background:url('/textures/sun.jpg') center/cover;box-shadow:0 0 18px rgba(255,190,70,.65)"></span>
          <div>
            <h3>${h(entity.name)}</h3>
            <small>${h(entity.modeLabel)}</small>
          </div>
        </div>
        <div class="solar-status-row">
          <span class="badge ${h(entity.status)}"><i></i>${h(entity.statusLabel)}</span>
          <span class="solar-metric">${entity.progress}% · ${entity.doneCount}/${entity.totalTasks}</span>
        </div>
        <div class="solar-block">
          <h4>Опис проєкту</h4>
          <p>${h(entity.description)}</p>
        </div>
        <div class="solar-block solar-live-block">
          <h4>Що виконує зараз</h4>
          <p>${h(entity.currentAction)}</p>
        </div>
        ${entity.failedTasks?.length ? `
          <div class="solar-block solar-error-block">
            <h4>Помилки задач (${entity.failedTasks.length})</h4>
            ${entity.failedTasks.slice(0, 3).map(f => `<p class="solar-detail-text"><strong>${h(f.title)}:</strong> ${h(f.error)}</p>`).join('')}
          </div>` : ''}
        ${entity.latestResult ? `
          <div class="solar-block">
            <h4>Останній результат</h4>
            <p class="solar-result-preview">${h(entity.latestResult.text)}</p>
          </div>` : ''}
        <div class="solar-block">
          <h4>Активні задачі (${entity.runningTasks.length})</h4>
          <div class="solar-chips">${runningList}</div>
        </div>
        ${solarRunControlsHtml(model, callbacks)}
        ${entity.recentEvents.length ? `
          <div class="solar-block">
            <h4>Останні події</h4>
            <ul class="solar-events">
              ${entity.recentEvents.map(e => `<li>${h(e.text)}</li>`).join('')}
            </ul>
          </div>` : ''}
      </aside>
    `;
  }

  if (entity.kind === 'planet') {
    const primaryTask = entity.tasks.find(t => t.status === 'running' || t.status === 'waiting_children') || entity.tasks[0] || null;
    const latestResultTask = entity.tasks.find(t => t.result || t.error);
    return `
      <aside class="solar-inspector" data-live-key="solar-inspector-planet-${h(entity.id)}" aria-label="Інспектор моделі">
        <div class="solar-inspector-head">
          <span class="solar-eyebrow">МОДЕЛЬ · ПЛАНЕТА</span>
          <button type="button" class="solar-close" data-solar-action="close-inspector" aria-label="Закрити">×</button>
        </div>
        <div class="solar-inspector-title">
          <span class="solar-orb" style="background:url('${h(entity.tex)}') center/cover;box-shadow:inset -6px -4px 10px rgba(0,0,0,.7),0 0 14px rgba(110,195,255,.3)"></span>
          <div>
            <h3>${h(entity.name)}</h3>
            <small>${h(entity.model)} · ${h(entity.provider)}</small>
          </div>
        </div>
        <div class="solar-status-row">
          <span class="badge ${h(entity.status)}"><i></i>${h(entity.statusLabel)}</span>
          ${billingBadgeHtml(entity.billing, entity.billingBoundary)}
          ${focusBtn}
        </div>
        <div class="solar-block">
          <h4>Походження моделі</h4>
          <p><strong>${h(entity.sourceLabel ?? 'Профіль ролі')}</strong></p>
          ${entity.recommendedModels?.length ? `<p class="solar-detail-text">Профіль ролі: ${h(entity.recommendedModels.join(', '))}</p>` : ''}
          ${entity.routedModels?.length ? `<p class="solar-detail-text">AI-пропозиція (/api/routing): ${h(entity.routedModels.join(', '))}</p>` : ''}
          ${entity.actualModels?.length ? `<p class="solar-detail-text">Фактичний виконавець: ${h(entity.actualModels.join(', '))}</p>` : '<p class="solar-detail-text">Фактичний виконавець запуску ще не зафіксований</p>'}
        </div>
        <div class="solar-block">
          <h4>Роль моделі</h4>
          <p>${h(entity.description)}</p>
        </div>
        <div class="solar-block solar-live-block">
          <h4>Задача і поточний стан</h4>
          <p><strong>${h(entity.currentAction)}</strong></p>
          <p class="solar-detail-text">${h(primaryTask?.prompt || entity.currentDetail)}</p>
          ${entity.eventNote ? `<p class="solar-event-note">${h(entity.eventNote)}</p>` : ''}
        </div>
        ${latestResultTask?.error ? `
          <div class="solar-block solar-error-block">
            <h4>Помилка виконання</h4>
            <p class="solar-result-preview">${h(latestResultTask.error)}</p>
          </div>` : ''}
        ${latestResultTask?.result ? `
          <div class="solar-block">
            <h4>Результат</h4>
            <p class="solar-result-preview">${h(latestResultTask.result)}</p>
          </div>` : ''}
        ${entity.moons.length ? `
          <div class="solar-block">
            <h4>Субагенти · супутники (${entity.moons.length})</h4>
            <div class="solar-list">
              ${entity.moons.map(m => `
                <button type="button" class="solar-list-item" data-solar-moon="${h(m.key)}">
                  <span><strong>${h(m.name)}</strong><small>${h(m.model || m.role)}</small></span>
                  <span class="badge ${h(m.status)}"><i></i>${h(m.statusLabel)}</span>
                </button>`).join('')}
            </div>
          </div>` : ''}
        <div class="solar-block">
          <h4>Призначені задачі (${entity.tasks.length})</h4>
          <div class="solar-list">
            ${entity.tasks.length ? entity.tasks.map(t => `
              <div class="solar-task-card">
                <button type="button" class="solar-list-item" data-solar-task="${h(t.id)}" ${callbacks.onSelectTask ? '' : 'disabled'}>
                  <span><strong>${h(t.title)}</strong>${t.result ? `<small>${h(t.result)}</small>` : t.error ? `<small class="solar-text-err">${h(t.error)}</small>` : ''}</span>
                  <span class="badge ${h(t.status)}"><i></i>${h(t.statusLabel)}</span>
                </button>
                ${t.cancellable && callbacks.onCancelTask ? `<div class="solar-task-mini-actions"><button type="button" class="solar-ctrl-btn danger" data-solar-cancel-task="${h(t.id)}">Скасувати задачу</button></div>` : ''}
              </div>`).join('') : '<span class="solar-muted">Немає призначених задач</span>'}
          </div>
        </div>
        ${solarRunControlsHtml(model, callbacks)}
      </aside>
    `;
  }

  return `
    <aside class="solar-inspector" data-live-key="solar-inspector-moon-${h(entity.key)}" aria-label="Інспектор субагента">
      <div class="solar-inspector-head">
        <span class="solar-eyebrow">ДОЧІРНЯ ЗАДАЧА · СУПУТНИК</span>
        <button type="button" class="solar-close" data-solar-action="close-inspector" aria-label="Закрити">×</button>
      </div>
      <div class="solar-inspector-title">
        <span class="solar-orb" style="background:url('/textures/moon.jpg') center/cover;box-shadow:inset -6px -4px 10px rgba(0,0,0,.75)"></span>
        <div>
          <h3>${h(entity.name)}</h3>
          <small>${h(entity.model || entity.role)}${entity.provider ? ` · ${h(entity.provider)}` : ''}</small>
        </div>
      </div>
      <div class="solar-status-row">
        <span class="badge ${h(entity.status)}"><i></i>${h(entity.statusLabel)}</span>
        ${billingBadgeHtml(entity.billing, entity.billingBoundary)}
        ${focusBtn}
      </div>
      <div class="solar-block">
        <h4>Модель і походження</h4>
        <p><strong>${h(entity.model || entity.parentPlanetModel || 'Модель плану')}</strong> · ${h(entity.source === 'execution' ? 'Фактичний виконавець' : 'План проєкту')}</p>
        <p class="solar-detail-text">Батьківська планета: <button type="button" class="solar-link-btn" data-solar-planet="${h(entity.parentPlanetId)}">${h(entity.parentPlanetName)}</button></p>
      </div>
      <div class="solar-block">
        <h4>Задача субагента</h4>
        <p>${h(entity.prompt || entity.description)}</p>
      </div>
      <div class="solar-block solar-live-block">
        <h4>Поточний статус</h4>
        <p>${h(entity.currentAction)}</p>
      </div>
      ${entity.error ? `
        <div class="solar-block solar-error-block">
          <h4>Помилка</h4>
          <p class="solar-result-preview">${h(entity.error)}</p>
        </div>` : ''}
      <div class="solar-block">
        <h4>Результат</h4>
        <p class="solar-result-preview">${h(entity.result || 'Результат з’явиться після завершення дочірньої задачі.')}</p>
      </div>
      <div class="solar-block">
        <h4>Дії керування</h4>
        <div class="solar-inspector-actions">
          ${entity.id ? `<button type="button" class="solar-ctrl-btn" data-solar-task="${h(entity.id)}">Відкрити картку</button>` : ''}
          <button type="button" class="solar-ctrl-btn" data-solar-task="${h(entity.parentTaskId)}">Батьківська задача</button>
          ${entity.cancellable && callbacks.onCancelTask ? `<button type="button" class="solar-ctrl-btn danger" data-solar-cancel-task="${h(entity.id)}">Скасувати підзадачу</button>` : ''}
        </div>
      </div>
      ${solarRunControlsHtml(model, callbacks)}
    </aside>
  `;
}

function renderTimeBarData(model) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('uk-UA', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const timeStr = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const liveClass = model.sun.status === 'running' ? '' : model.sun.status === 'paused' ? 'paused' : 'idle';
  const liveLabel = model.sun.status === 'running' ? 'LIVE' : model.sun.statusLabel.toUpperCase();
  return { dateStr, timeStr, liveClass, liveLabel };
}

function buildGridAndOrbitLines(planetPositions, maxOrbit) {
  const verts = [];
  const pushSeg = (ax, ay, az, bx, by, bz, r, g, b, a) => {
    verts.push(ax, ay, az, r, g, b, a, bx, by, bz, r, g, b, a);
  };

  // Whisper-faint ecliptic reference ring outside orbits
  const outerR = maxOrbit + 50;
  const outerSteps = 96;
  for (let i = 0; i < outerSteps; i++) {
    const t0 = (i / outerSteps) * Math.PI * 2;
    const t1 = ((i + 1) / outerSteps) * Math.PI * 2;
    pushSeg(Math.cos(t0) * outerR, 0, Math.sin(t0) * outerR, Math.cos(t1) * outerR, 0, Math.sin(t1) * outerR, 0.25, 0.45, 0.65, 0.04);
  }

  // Pale, non-intrusive planet orbits with soft trailing fade behind the planet
  for (const ps of planetPositions) {
    const steps = 112;
    const isRunning = ps.planet.status === 'running';
    const [cr, cg, cb] = ps.arch.orbitRgb;
    for (let i = 0; i < steps; i++) {
      const a0 = ps.angle - (i / steps) * Math.PI * 2;
      const a1 = ps.angle - ((i + 1) / steps) * Math.PI * 2;
      const trail = Math.max(0, 1 - (i / steps) * 1.25);
      const alpha = isRunning ? 0.04 + 0.14 * trail : 0.025 + 0.075 * trail;
      pushSeg(
        Math.cos(a0) * ps.orbitR, 0, Math.sin(a0) * ps.orbitR,
        Math.cos(a1) * ps.orbitR, 0, Math.sin(a1) * ps.orbitR,
        cr, cg, cb, alpha
      );
    }

    // Faint moon orbit rings around planet
    ps.moons.forEach((m, mIdx) => {
      const mSteps = 48;
      for (let i = 0; i < mSteps; i++) {
        const t0 = (i / mSteps) * Math.PI * 2;
        const t1 = ((i + 1) / mSteps) * Math.PI * 2;
        const inc = (mIdx % 2 === 0 ? 1 : -1) * 0.22;
        pushSeg(
          ps.center[0] + Math.cos(t0) * m.orbitR,
          ps.center[1] + Math.sin(t0) * m.orbitR * inc,
          ps.center[2] + Math.sin(t0) * m.orbitR,
          ps.center[0] + Math.cos(t1) * m.orbitR,
          ps.center[1] + Math.sin(t1) * m.orbitR * inc,
          ps.center[2] + Math.sin(t1) * m.orbitR,
          0.55, 0.86, 1.0, 0.10
        );
      }
    });
  }

  return new Float32Array(verts);
}

const activeControllers = new WeakMap();
const viewportControllers = new WeakMap();

export function renderSolarStage(container, project, agents, labels, callbacks = {}) {
  if (!container || !project) return;
  if (uiState.lastProjectId && uiState.lastProjectId !== project.id) {
    uiState.selected = null;
    uiState.focusRef = null;
  }
  uiState.lastProjectId = project.id;

  const model = buildSolarSystemModel(project, agents, labels, callbacks.routing ?? null);
  if (!model) return;

  const existingViewport = container.querySelector('.solar-viewport');
  let ctrl = (existingViewport && viewportControllers.get(existingViewport)) || activeControllers.get(container);
  if (ctrl && existingViewport) {
    activeControllers.set(container, ctrl);
    ctrl.update(model, callbacks);
    return;
  }

  const tb = renderTimeBarData(model);

  container.innerHTML = `
    <div class="solar-viewport ${uiState.fullscreen ? 'is-fullscreen' : ''} ${callbacks.compact ? 'is-compact' : ''}">
      <canvas class="solar-canvas-gl"></canvas>
      <canvas class="solar-canvas-hud"></canvas>
      <div class="solar-hud-top">
        <div class="solar-brand-pill">
          <span class="solar-beacon"></span>
          <div>
            <strong>SOLAR ORCHESTRATOR</strong>
            <small class="solar-project-sub">${h(model.sun.name)} · ${model.planets.length} моделей · ${model.totalMoons} субагентів</small>
          </div>
        </div>
        <div class="solar-legend-pills">
          <span class="solar-pill sun"><i></i>Сонце: Оркестратор</span>
          <span class="solar-pill planet"><i></i>Планети: Моделі</span>
          <span class="solar-pill moon"><i></i>Супутники: Субагенти</span>
        </div>
      </div>

      <div class="solar-dock" role="toolbar" aria-label="Керування картою">
        <button type="button" class="solar-dock-btn" data-solar-action="select-sun" title="Інспектор оркестратора (Сонце)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
        </button>
        <button type="button" class="solar-dock-btn ${uiState.showGrid ? 'active' : ''}" data-solar-action="toggle-grid" title="Орбіти">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="4"/></svg>
        </button>
        <button type="button" class="solar-dock-btn" data-solar-action="zoom-in" title="Наблизити">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button type="button" class="solar-dock-btn" data-solar-action="zoom-out" title="Віддалити">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12h14"/></svg>
        </button>
        <button type="button" class="solar-dock-btn ${uiState.showLabels ? 'active' : ''}" data-solar-action="toggle-labels" title="Підписи">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
        </button>
        <button type="button" class="solar-dock-btn" data-solar-action="reset-camera" title="Центрувати на Сонці">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/></svg>
        </button>
        <button type="button" class="solar-dock-btn ${uiState.fullscreen ? 'active' : ''}" data-solar-action="toggle-fullscreen" title="На весь екран">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3H3v5m18-5h-5m5 0v5M3 16v5h5m13-5v5h-5"/></svg>
        </button>
      </div>

      <div class="solar-inspector-slot"></div>

      <div class="solar-bottom-bar">
        <button type="button" class="solar-play-btn" data-solar-action="toggle-motion" title="${uiState.motionPaused ? 'Відновити рух' : 'Пауза руху'}">
          ${uiState.motionPaused ? '▶' : '❚❚'}
        </button>
        <span class="solar-live-tag ${tb.liveClass}"><i></i><span class="solar-live-text">${h(tb.liveLabel)}</span></span>
        <span class="solar-time-readout">${h(tb.dateStr)}</span>
        <span class="solar-rate-tag">${uiState.motionPaused ? 'PAUSED' : 'REAL RATE'}</span>
        <span class="solar-time-readout solar-clock-readout">${h(tb.timeStr)}</span>
        ${callbacks.onRunAction ? `
          <button type="button" class="solar-sim-btn" data-solar-action="run-control" ${model.sun.draining ? 'disabled' : ''}>
            ${model.sun.draining ? 'Зупиняється…' : model.sun.status === 'running' ? 'Пауза' : model.sun.status === 'paused' ? 'Продовжити' : callbacks.canRealStart ? 'Запустити AI' : 'Запустити демо'}
          </button>` : ''}
      </div>
    </div>
  `;

  const viewport = container.querySelector('.solar-viewport');
  const glCanvas = container.querySelector('.solar-canvas-gl');
  const hudCanvas = container.querySelector('.solar-canvas-hud');
  const inspectorSlot = container.querySelector('.solar-inspector-slot');
  const subEl = container.querySelector('.solar-project-sub');
  const liveTagEl = container.querySelector('.solar-live-tag');
  const liveTextEl = container.querySelector('.solar-live-text');
  const clockEl = container.querySelector('.solar-clock-readout');
  const rateEl = container.querySelector('.solar-rate-tag');
  const simBtn = container.querySelector('[data-solar-action="run-control"]');

  const glEngine = createSolarGL(glCanvas);

  let currentModel = model;
  let currentCallbacks = callbacks;
  let hitTargets = [];
  let dragging = false;
  let dragMoved = false;
  let lastX = 0;
  let lastY = 0;
  let rafId = 0;
  let lastFrame = performance.now();

  function syncHud() {
    viewport.classList.toggle('is-fullscreen', uiState.fullscreen);
    if (subEl) subEl.textContent = `${currentModel.sun.name} · ${currentModel.planets.length} моделей · ${currentModel.totalMoons} субагентів`;
    const nextTb = renderTimeBarData(currentModel);
    if (liveTagEl) liveTagEl.className = `solar-live-tag ${nextTb.liveClass}`;
    if (liveTextEl) liveTextEl.textContent = nextTb.liveLabel;
    if (clockEl) clockEl.textContent = nextTb.timeStr;
    if (rateEl) rateEl.textContent = uiState.motionPaused ? 'PAUSED' : 'REAL RATE';
    if (simBtn) {
      simBtn.disabled = Boolean(currentModel.sun.draining);
      simBtn.textContent = currentModel.sun.draining ? 'Зупиняється…' : currentModel.sun.status === 'running' ? 'Пауза' : currentModel.sun.status === 'paused' ? 'Продовжити' : currentCallbacks.canRealStart ? 'Запустити AI' : 'Запустити демо';
    }
    const motionBtn = viewport.querySelector('[data-solar-action="toggle-motion"]');
    if (motionBtn) {
      motionBtn.textContent = uiState.motionPaused ? '▶' : '❚❚';
      motionBtn.title = uiState.motionPaused ? 'Відновити рух' : 'Пауза руху';
    }
    viewport.querySelector('[data-solar-action="toggle-grid"]')?.classList.toggle('active', uiState.showGrid);
    viewport.querySelector('[data-solar-action="toggle-labels"]')?.classList.toggle('active', uiState.showLabels);
    viewport.querySelector('[data-solar-action="toggle-fullscreen"]')?.classList.toggle('active', uiState.fullscreen);
    patchLiveDom(inspectorSlot, renderInspectorHtml(currentModel, currentCallbacks));
  }

  function findHit(cx, cy) {
    for (let i = hitTargets.length - 1; i >= 0; i--) {
      const t = hitTargets[i];
      const dx = cx - t.sx;
      const dy = cy - t.sy;
      if (dx * dx + dy * dy <= t.r * t.r) return t;
    }
    return null;
  }

  glCanvas.addEventListener('pointerdown', e => {
    dragging = true;
    dragMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    glCanvas.setPointerCapture(e.pointerId);
  });

  glCanvas.addEventListener('pointermove', e => {
    const rect = glCanvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
      uiState.yaw += dx * 0.007;
      uiState.pitch = Math.max(0.08, Math.min(1.45, uiState.pitch + dy * 0.006));
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    const hit = findHit(cx, cy);
    uiState.hovered = hit ? hit.ref : null;
    glCanvas.style.cursor = hit ? 'pointer' : 'grab';
  });

  glCanvas.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    if (!dragMoved) {
      const rect = glCanvas.getBoundingClientRect();
      const hit = findHit(e.clientX - rect.left, e.clientY - rect.top);
      uiState.selected = hit ? hit.ref : null;
      syncHud();
    }
  });

  glCanvas.addEventListener('dblclick', e => {
    const rect = glCanvas.getBoundingClientRect();
    const hit = findHit(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      uiState.selected = hit.ref;
      uiState.focusRef = hit.ref;
      uiState.zoom = hit.ref.kind === 'sun' ? 1.35 : hit.ref.kind === 'moon' ? 4.8 : 3.5;
    } else {
      uiState.focusRef = null;
      uiState.zoom = 0.96;
    }
    syncHud();
  });

  glCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.90 : 1.11;
    uiState.zoom = Math.max(0.42, Math.min(7.0, uiState.zoom * factor));
  }, { passive: false });

  viewport.addEventListener('click', e => {
    const actionBtn = e.target.closest('[data-solar-action]');
    if (actionBtn) {
      const act = actionBtn.dataset.solarAction;
      if (act === 'select-sun') uiState.selected = { kind: 'sun' };
      else if (act === 'toggle-grid') uiState.showGrid = !uiState.showGrid;
      else if (act === 'zoom-in') uiState.zoom = Math.min(7.0, uiState.zoom * 1.28);
      else if (act === 'zoom-out') uiState.zoom = Math.max(0.42, uiState.zoom * 0.78);
      else if (act === 'toggle-labels') uiState.showLabels = !uiState.showLabels;
      else if (act === 'reset-camera') { uiState.yaw = 0.56; uiState.pitch = 0.42; uiState.zoom = 0.96; uiState.focusRef = null; }
      else if (act === 'focus-selected' && uiState.selected) {
        uiState.focusRef = uiState.selected;
        uiState.zoom = uiState.selected.kind === 'sun' ? 1.35 : uiState.selected.kind === 'moon' ? 4.8 : 3.5;
      }
      else if (act === 'toggle-fullscreen') uiState.fullscreen = !uiState.fullscreen;
      else if (act === 'toggle-motion') uiState.motionPaused = !uiState.motionPaused;
      else if (act === 'close-inspector') { uiState.selected = null; uiState.focusRef = null; }
      else if (act === 'run-control') {
        if (currentModel.sun.draining) return;
        const nextAct = currentModel.sun.status === 'running' ? 'pause' : currentModel.sun.status === 'paused' ? 'resume' : (currentCallbacks.canRealStart ? 'real-start' : 'start');
        currentCallbacks.onRunAction?.(nextAct);
      }
      syncHud();
      return;
    }
    const ctrlBtn = e.target.closest('[data-solar-control]');
    if (ctrlBtn && currentCallbacks.onRunAction) {
      currentCallbacks.onRunAction(ctrlBtn.dataset.solarControl);
      return;
    }
    const cancelTaskBtn = e.target.closest('[data-solar-cancel-task]');
    if (cancelTaskBtn && currentCallbacks.onCancelTask) {
      currentCallbacks.onCancelTask(cancelTaskBtn.dataset.solarCancelTask);
      return;
    }
    const moonBtn = e.target.closest('[data-solar-moon]');
    if (moonBtn) {
      uiState.selected = { kind: 'moon', key: moonBtn.dataset.solarMoon };
      syncHud();
      return;
    }
    const planetBtn = e.target.closest('[data-solar-planet]');
    if (planetBtn) {
      uiState.selected = { kind: 'planet', id: planetBtn.dataset.solarPlanet };
      syncHud();
      return;
    }
    const taskBtn = e.target.closest('[data-solar-task]');
    if (taskBtn && currentCallbacks.onSelectTask) {
      currentCallbacks.onSelectTask(taskBtn.dataset.solarTask);
    }
  });

  function drawFrame(now) {
    if (!document.body.contains(glCanvas)) {
      cancelAnimationFrame(rafId);
      return;
    }
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!uiState.motionPaused) uiState.simTime += dt;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = viewport.clientWidth || 800;
    const height = viewport.clientHeight || 500;
    const hudW = Math.round(width * dpr);
    const hudH = Math.round(height * dpr);
    if (hudCanvas.width !== hudW || hudCanvas.height !== hudH) {
      hudCanvas.width = hudW;
      hudCanvas.height = hudH;
    }

    const sunRadius = 17;
    const totalPlanets = Math.max(1, currentModel.planets.length);
    const planetPositions = currentModel.planets.map((planet, idx) => {
      const arch = archetypeForPlanet(planet, idx);
      const orbitR = 66 + idx * 44;
      const speed = (planet.status === 'running' ? 0.22 : 0.085) / (1 + idx * 0.35);
      const angle = (idx / totalPlanets) * Math.PI * 2 + 0.55 + uiState.simTime * speed;
      const px = Math.cos(angle) * orbitR;
      const pz = Math.sin(angle) * orbitR;
      const moons = planet.moons.map((moon, mIdx) => {
        const mOrbitR = arch.baseRadius * 2.8 + mIdx * 7;
        const mAngle = mIdx * 2.1 + uiState.simTime * (moon.status === 'running' ? 0.95 : 0.42);
        const inc = (mIdx % 2 === 0 ? 1 : -1) * 0.22;
        return {
          moon,
          orbitR: mOrbitR,
          radius: 2.5,
          center: [px + Math.cos(mAngle) * mOrbitR, Math.sin(mAngle) * mOrbitR * inc, pz + Math.sin(mAngle) * mOrbitR]
        };
      });
      return {
        planet,
        idx,
        arch,
        orbitR,
        angle,
        radius: arch.baseRadius,
        center: [px, 0, pz],
        moons
      };
    });

    let desiredTarget = [0, 0, 0];
    if (uiState.focusRef?.kind === 'planet') {
      const found = planetPositions.find(p => p.planet.id === uiState.focusRef.id);
      if (found) desiredTarget = found.center;
    } else if (uiState.focusRef?.kind === 'moon') {
      for (const ps of planetPositions) {
        const foundM = ps.moons.find(m => m.moon.key === uiState.focusRef.key);
        if (foundM) { desiredTarget = foundM.center; break; }
      }
    }
    const lerp = 1 - Math.exp(-6 * dt);
    uiState.camTarget = [
      uiState.camTarget[0] + (desiredTarget[0] - uiState.camTarget[0]) * lerp,
      uiState.camTarget[1] + (desiredTarget[1] - uiState.camTarget[1]) * lerp,
      uiState.camTarget[2] + (desiredTarget[2] - uiState.camTarget[2]) * lerp
    ];

    const camDist = 375 / uiState.zoom;
    const eye = [
      uiState.camTarget[0] + camDist * Math.cos(uiState.pitch) * Math.sin(uiState.yaw),
      uiState.camTarget[1] + camDist * Math.sin(uiState.pitch),
      uiState.camTarget[2] + camDist * Math.cos(uiState.pitch) * Math.cos(uiState.yaw)
    ];

    const proj = mat4Perspective((42 * Math.PI) / 180, width / Math.max(1, height), 2, 2400);
    const view = mat4LookAt(eye, uiState.camTarget, [0, 1, 0]);
    const viewProj = mat4Multiply(proj, view);

    const bodies = [{
      center: [0, 0, 0],
      radius: sunRadius,
      spin: uiState.simTime * 0.08,
      tilt: 0.12,
      type: 0,
      active: currentModel.sun.status === 'running',
      atmoColor: [1.0, 0.72, 0.25]
    }];
    const rings = [];

    for (const ps of planetPositions) {
      bodies.push({
        center: ps.center,
        radius: ps.radius,
        spin: uiState.simTime * (0.28 + ps.idx * 0.06),
        tilt: ps.arch.tilt,
        type: ps.arch.type,
        active: ps.planet.status === 'running',
        atmoColor: ps.arch.atmo
      });
      if (ps.arch.hasRing) {
        rings.push({
          center: ps.center,
          radius: ps.radius,
          tilt: ps.arch.tilt,
          color: ps.arch.ring
        });
      }
      ps.moons.forEach(m => {
        bodies.push({
          center: m.center,
          radius: m.radius,
          spin: uiState.simTime * 0.3,
          tilt: 0.1,
          type: 5,
          active: m.moon.status === 'running',
          atmoColor: [0.65, 0.85, 1.0]
        });
      });
    }

    const maxOrbit = 66 + Math.max(0, currentModel.planets.length - 1) * 44;
    const beltBase = maxOrbit + 36;
    const beltPoints = new Float32Array(BELT_ASTEROIDS.length * 5);
    for (let i = 0; i < BELT_ASTEROIDS.length; i++) {
      const a = BELT_ASTEROIDS[i];
      const ang = a.angle + uiState.simTime * 0.02;
      const r = beltBase + a.rOffset;
      beltPoints[i * 5 + 0] = Math.cos(ang) * r;
      beltPoints[i * 5 + 1] = a.yOffset;
      beltPoints[i * 5 + 2] = Math.sin(ang) * r;
      beltPoints[i * 5 + 3] = a.size * Math.min(1.5, uiState.zoom);
      beltPoints[i * 5 + 4] = a.alpha;
    }

    const gridSegments = uiState.showGrid ? buildGridAndOrbitLines(planetPositions, maxOrbit) : new Float32Array(0);

    if (glEngine) {
      glEngine.render({
        width, height, dpr, eye, viewProj,
        yaw: uiState.yaw, pitch: uiState.pitch, time: uiState.simTime,
        showGrid: uiState.showGrid, gridSegments, bodies, rings, beltPoints
      });
    }

    // 2D HUD Overlay: NASA Eyes spaced typography, orbital marker rings, telemetry beams, and reticles
    const hctx = hudCanvas.getContext('2d');
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hctx.clearRect(0, 0, width, height);

    const nextHits = [];
    const sunScreen = projectWorldToScreen([0, 0, 0], viewProj, width, height);

    if (sunScreen) {
      for (const ps of planetPositions) {
        if (ps.planet.status !== 'running') continue;
        const pScreen = projectWorldToScreen(ps.center, viewProj, width, height);
        if (!pScreen) continue;
        hctx.save();
        hctx.strokeStyle = 'rgba(116, 232, 255, 0.24)';
        hctx.lineWidth = 1.0;
        hctx.setLineDash([4, 6]);
        hctx.lineDashOffset = -uiState.simTime * 34;
        hctx.beginPath();
        hctx.moveTo(sunScreen.sx, sunScreen.sy);
        hctx.lineTo(pScreen.sx, pScreen.sy);
        hctx.stroke();
        hctx.restore();
      }
    }

    const labelQueue = [];

    if (sunScreen) {
      const approxR = (sunRadius / sunScreen.depth) * (height * 1.18);
      nextHits.push({ sx: sunScreen.sx, sy: sunScreen.sy, r: Math.max(20, approxR + 8), depth: sunScreen.depth, ref: { kind: 'sun' } });
      if (uiState.selected?.kind === 'sun' || uiState.hovered?.kind === 'sun') {
        drawReticle(hctx, sunScreen.sx, sunScreen.sy, Math.max(22, approxR + 4), '#ffd97d');
      }
      if (uiState.showLabels) {
        labelQueue.push({
          depth: sunScreen.depth,
          draw() {
            hctx.font = '600 10px "Cascadia Code", Consolas, monospace';
            hctx.textAlign = 'left';
            hctx.fillStyle = '#ffeab8';
            hctx.fillText(spacedLabel(currentModel.sun.name), sunScreen.sx + Math.max(18, approxR + 8), sunScreen.sy - 4);
          }
        });
      }
    }

    for (const ps of planetPositions) {
      const pScreen = projectWorldToScreen(ps.center, viewProj, width, height);
      if (pScreen) {
        const approxR = (ps.radius / pScreen.depth) * (height * 1.18);
        nextHits.push({ sx: pScreen.sx, sy: pScreen.sy, r: Math.max(18, approxR + 8), depth: pScreen.depth, ref: { kind: 'planet', id: ps.planet.id, agentIds: ps.planet.agentIds } });

        // Crisp NASA Eyes orbital marker circle when zoomed out
        if (approxR < 18) {
          const [cr, cg, cb] = ps.arch.orbitRgb;
          hctx.strokeStyle = `rgba(${Math.round(cr * 255)}, ${Math.round(cg * 255)}, ${Math.round(cb * 255)}, 0.72)`;
          hctx.lineWidth = 1.1;
          hctx.beginPath();
          hctx.arc(pScreen.sx, pScreen.sy, Math.max(7, approxR + 4), 0, Math.PI * 2);
          hctx.stroke();
        }

        const isSel = uiState.selected?.kind === 'planet' && uiState.selected.id === ps.planet.id;
        const isHov = uiState.hovered?.kind === 'planet' && uiState.hovered.id === ps.planet.id;
        if (isSel || isHov) {
          drawReticle(hctx, pScreen.sx, pScreen.sy, Math.max(14, approxR + 4), isSel ? '#8ce8ff' : 'rgba(205, 232, 255, 0.78)');
        }
        if (uiState.showLabels) {
          labelQueue.push({
            depth: pScreen.depth,
            draw() {
              const xOff = pScreen.sx + Math.max(12, approxR + 9);
              hctx.textAlign = 'left';
              hctx.font = '600 10px "Cascadia Code", Consolas, monospace';
              hctx.fillStyle = ps.planet.status === 'running' ? '#9cf2ff' : '#eef4ff';
              hctx.fillText(spacedLabel(ps.planet.name), xOff, pScreen.sy - 2);
              hctx.font = '400 9px "Cascadia Code", Consolas, monospace';
              hctx.fillStyle = 'rgba(165, 194, 228, 0.85)';
              hctx.fillText(ps.planet.model, xOff, pScreen.sy + 9);
            }
          });
        }
      }

      for (const m of ps.moons) {
        const mScreen = projectWorldToScreen(m.center, viewProj, width, height);
        if (!mScreen) continue;
        const approxR = (m.radius / mScreen.depth) * (height * 1.18);
        nextHits.push({ sx: mScreen.sx, sy: mScreen.sy, r: Math.max(14, approxR + 7), depth: mScreen.depth, ref: { kind: 'moon', key: m.moon.key, id: m.moon.id } });

        // Sleek NASA Eyes probe/satellite hex marker when zoomed out
        if (approxR < 10) {
          hctx.strokeStyle = m.moon.status === 'running' ? '#7cf0ff' : 'rgba(195, 222, 250, 0.7)';
          hctx.lineWidth = 1;
          hctx.beginPath();
          const mr = 5.5;
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            const hx = mScreen.sx + Math.cos(a) * mr;
            const hy = mScreen.sy + Math.sin(a) * mr;
            if (k === 0) hctx.moveTo(hx, hy); else hctx.lineTo(hx, hy);
          }
          hctx.closePath();
          hctx.stroke();
        }

        const isSel = uiState.selected?.kind === 'moon' && uiState.selected.key === m.moon.key;
        const isHov = uiState.hovered?.kind === 'moon' && uiState.hovered.key === m.moon.key;
        if (isSel || isHov) {
          drawReticle(hctx, mScreen.sx, mScreen.sy, Math.max(10, approxR + 3), '#9cf2ff');
        }
        if (uiState.showLabels) {
          labelQueue.push({
            depth: mScreen.depth,
            draw() {
              hctx.textAlign = 'left';
              hctx.font = '500 9px "Cascadia Code", Consolas, monospace';
              hctx.fillStyle = '#cbe4ff';
              hctx.fillText(m.moon.name, mScreen.sx + Math.max(8, approxR + 6), mScreen.sy + 3);
            }
          });
        }
      }
    }

    nextHits.sort((a, b) => b.depth - a.depth);
    hitTargets = nextHits;

    hctx.shadowColor = 'rgba(2, 6, 14, 0.95)';
    hctx.shadowBlur = 4;
    for (const item of labelQueue) item.draw();
    hctx.shadowBlur = 0;

    rafId = requestAnimationFrame(drawFrame);
  }

  syncHud();
  rafId = requestAnimationFrame(drawFrame);

  ctrl = {
    update(nextModel, nextCallbacks) {
      currentModel = nextModel;
      currentCallbacks = nextCallbacks;
      syncHud();
    }
  };
  viewportControllers.set(viewport, ctrl);
  activeControllers.set(container, ctrl);
}
