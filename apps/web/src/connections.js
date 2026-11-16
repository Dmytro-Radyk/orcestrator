import { catalogManager, formatBillingBadge } from './routing-ui.js';

const billingNames = {
  free_tier: 'Безкоштовно',
  subscription_included: 'Включено у підписку',
  metered: 'Оплата за використання',
  unknown: 'Тариф не підтверджено',
  local: 'Локальне виконання'
};

const authNames = {
  anonymous: 'Анонімний доступ (без входу)',
  google: 'Вхід через Google · квота підписки',
  chatgpt: 'Вхід через ChatGPT',
  apiKey: 'API-ключ · оплата окремо',
  'claude.ai': 'Вхід через Claude',
  oauth_token: 'OAuth-вхід'
};

const availabilityNames = {
  ready: 'Доступна',
  unavailable: 'Недоступна',
  unknown: 'Статус невідомий'
};

export function describeConnectionAuth(c) {
  if (!c) return { text: 'Невідомо', badgeClass: 'pending', isAnonymous: false };
  if (c.authType === 'anonymous' || c.requiresAuth === false) {
    return {
      text: c.installed ? 'Працює без входу (anonymous)' : 'CLI не знайдено (вхід не потрібен)',
      badgeClass: c.installed ? 'done' : 'pending',
      isAnonymous: true
    };
  }
  if (c.authenticated === true) return { text: 'Авторизовано', badgeClass: 'done', isAnonymous: false };
  if (c.authenticated === false) return { text: 'Потрібен вхід', badgeClass: 'failed', isAnonymous: false };
  return { text: 'Авторизацію не підтверджено', badgeClass: 'pending', isAnonymous: false };
}

function formatLimit(limit) {
  if (!limit) return 'Ліміти не вказані';
  const parts = [];
  if (limit.context) parts.push(`контекст ${Number(limit.context).toLocaleString('uk-UA')}`);
  if (limit.output) parts.push(`відповідь до ${Number(limit.output).toLocaleString('uk-UA')}`);
  return parts.length ? parts.join(' · ') : 'Ліміти не вказані';
}

function formatCapabilities(cap = {}) {
  const tags = [];
  tags.push(cap.workspaceWrite ? 'Запис у файли: так' : 'Лише текст (без запису файлів)');
  tags.push(cap.tools ? 'Інструменти: є' : 'Інструменти: немає');
  if (cap.structuredOutput) tags.push('JSON-схема: так');
  else if (cap.jsonOutput) tags.push(`JSON: ${cap.jsonOutput}`);
  return tags;
}

function renderQuota(quota, h) {
  if (!quota?.known) return '<div class="quota-windows"><span>Квота: не розкривається провайдером</span></div>';
  const windows = [quota.primary, quota.secondary].filter(Boolean);
  if (!windows.length) return '<div class="quota-windows"><span>Квота: ліміти без вікон</span></div>';
  return `<div class="quota-windows">${windows.map(q =>
    `<span>Використано ${h(q.usedPercent)}%${q.resetsAt ? ` · оновлення ${h(new Date(q.resetsAt * 1000).toLocaleString('uk-UA'))}` : ''}</span>`
  ).join('')}</div>`;
}

function renderManagerBanner(manager, routes, h) {
  if (!manager) return '';
  const selectedRoute = manager.routeId ? routes.find(r => r.id === manager.routeId) : null;
  if (manager.available) {
    return `<div class="panel manager-banner"><div><span class="eyebrow">АВТОМАТИЧНИЙ AI-ДИРЕКТОР</span><h3>${h(selectedRoute?.name ?? manager.model ?? manager.routeId)}</h3><p class="muted text-small">Маршрут <code>${h(manager.routeId)}</code> · ${h(manager.reason)}</p></div><span class="badge done"><i></i>Готовий до підбору</span></div>`;
  }
  return `<div class="panel manager-banner is-blocked"><div><span class="eyebrow">АВТОМАТИЧНИЙ AI-ДИРЕКТОР</span><h3>Директор недоступний</h3><p class="route-blocked text-small">${h(manager.reason ?? 'Жодна модель не має підтвердженого дозволу для керування планом.')}</p></div><span class="badge pending"><i></i>Потрібна доступна модель</span></div>`;
}

export function renderConnections(catalog, scanning, { h, button, heading, loading = false, error = null }) {
  const connections = catalog?.connections ?? [];
  const routes = catalog?.routes ?? [];
  const allowedCount = routes.filter(r => r.decision?.allowed).length;
  const connById = new Map(connections.map(c => [c.id, c]));

  const statusLine = loading || scanning
    ? '<div class="planning-busy" role="status">Сканування встановлених CLI та доступних моделей… Запит до локального сервера триває.</div>'
    : '';
  const errorBanner = error
    ? `<div class="api-error-banner" role="alert"><strong>Не вдалося оновити каталог підключень:</strong> ${h(error)} ${button('scan-connections', 'Повторити сканування', 'search', 'btn small-btn')}</div>`
    : '';
  const noAllowedWarning = !loading && !scanning && routes.length > 0 && allowedCount === 0
    ? '<div class="api-error-banner" role="alert"><strong>Немає дозволених моделей для автоматичного запуску.</strong> Перевірте підключення або причини блокування у списку нижче.</div>'
    : '';

  return `${heading('MODEL REGISTRY', 'Доступні підключення й моделі', 'Безкоштовні тарифи та наявні підписки. Доступ і квота перевіряються перед запуском.', button('scan-connections', scanning ? 'Сканування…' : 'Оновити підключення', 'search', 'btn primary', scanning || loading ? 'disabled' : ''))}
    <div class="info-note">Сканування читає встановлені інтеграції та штатні метадані акаунтів. AI-задачі не запускаються; ключі, email і платіжні дані не зберігаються в каталозі.</div>
    ${statusLine}${errorBanner}${noAllowedWarning}
    <p class="muted text-small">${catalog?.checkedAt ? 'Остання перевірка: ' + h(new Date(catalog.checkedAt).toLocaleString('uk-UA')) : 'Ще не скановано'} · дозволено до запуску: ${allowedCount} / ${routes.length}</p>
    ${renderManagerBanner(catalogManager(catalog), routes, h)}
    <div class="connection-grid">${connections.map(c => {
      const auth = describeConnectionAuth(c);
      return `<article class="panel connection">
        <span class="connection-symbol purple">${h(c.name.slice(0, 2))}</span>
        <span class="provider-pill">${c.installed ? 'CLI знайдено' : 'Не знайдено'}</span>
        <h3>${h(c.name)}</h3>
        <p><span class="badge ${auth.badgeClass}"><i></i>${h(auth.text)}</span>${c.plan ? ' · ' + h(c.plan) : ''}</p>
        <small class="muted">${h(authNames[c.authType] ?? c.authType ?? '')}${c.version ? ' · ' + h(c.version) : ''}</small>
        ${c.subscriptionConfirmed ? '<p class="source-label ai">Підписку підтверджено</p>' : auth.isAnonymous ? '<p class="source-label ai">Безкоштовний / анонімний режим</p>' : ''}
        <p>${h(c.note)}</p>
        ${c.quotaScope === 'model-group' || c.id === 'antigravity' ? '<small class="muted">Квоти різняться за групами — наведені біля моделей нижче.</small>' : renderQuota(c.quota, h)}
      </article>`;
    }).join('') || '<div class="empty panel">Запустіть пошук підтримуваних інтеграцій.</div>'}</div>
    <section class="panel model-catalog">
      <div class="panel-heading"><h2>Каталог моделей <span>${routes.length}</span></h2><span class="muted text-small">Перевірка чинна до 5 хвилин</span></div>
      ${routes.length ? routes.map(r => {
        const parentConn = connById.get(r.connectionId);
        const quota = r.quota ?? parentConn?.quota;
        const avail = r.availability ?? 'unknown';
        const capTags = formatCapabilities(r.capabilities);
        return `<article class="model-route">
          <div>
            <div class="route-title-row">
              <h3>${h(r.name)}</h3>
              <span class="badge ${avail === 'ready' ? 'done' : avail === 'unavailable' ? 'failed' : 'pending'}"><i></i>${h(availabilityNames[avail] ?? avail)}</span>
            </div>
            <code>${h(r.id)}</code>
            <p>${h(r.description)}</p>
            <div class="route-meta-tags">${capTags.map(tag => `<span>${h(tag)}</span>`).join('')}<span>${h(formatLimit(r.limit))}</span></div>
            <small>${h(r.source)} · ${h(new Date(r.checkedAt).toLocaleString('uk-UA'))}</small>
          </div>
          <div class="route-decision-col">
            ${(() => { const b = formatBillingBadge(r.billing, r.billingBoundary); return `<span class="billing-pill ${b.tone}">${h(b.label)}</span>`; })()}
            <p class="${r.decision?.allowed ? 'route-allowed' : 'route-blocked'}">${r.decision?.allowed ? 'Можна запускати' : 'Автоматичний запуск заблоковано'}</p>
            <small>${h(r.decision?.reason ?? 'Причина не вказана')}</small>
            ${renderQuota(quota, h)}
          </div>
        </article>`;
      }).join('') : '<p class="empty compact">Моделі з’являться після підтвердження підключення. Статичні демо-профілі не є доказом доступу.</p>'}
    </section>
    <div class="info-note">Якщо CLI не знайдено, його можна встановити й авторизувати штатним способом, а потім оновити підключення. Відсутність у PATH не доводить відсутності підписки в іншому середовищі. Невідомі тарифи та межі оплати не дозволяють автоматичний запуск.</div>`;
}
