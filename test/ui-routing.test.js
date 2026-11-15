import test from 'node:test';
import assert from 'node:assert/strict';
import { describeConnectionAuth, renderConnections } from '../apps/web/src/connections.js';
import {
  mapWizardPriorityToRouting,
  isProposalStale,
  buildRoutingPayload,
  summarizeTaskModels,
  renderRoutingSection,
  formatBillingBadge
} from '../apps/web/src/routing-ui.js';
import { executionPanel } from '../apps/web/src/execution-ui.js';
import { applyExecutionRun } from '../apps/web/src/execution.js';

const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const button = (action, text, _glyph, cls = 'btn', extra = '') => `<button data-action="${action}" class="${cls}" ${extra}>${text}</button>`;
const icon = name => `<i data-icon="${name}"></i>`;
const heading = (_e, title) => `<h1>${title}</h1>`;

test('anonymous OpenCode connection renders as working without login', () => {
  const openCodeAuth = describeConnectionAuth({
    id: 'opencode',
    name: 'OpenCode',
    installed: true,
    authenticated: false,
    authType: 'anonymous',
    requiresAuth: false
  });
  assert.equal(openCodeAuth.isAnonymous, true);
  assert.equal(openCodeAuth.badgeClass, 'done');
  assert.match(openCodeAuth.text, /без входу/i);

  const codexNoAuth = describeConnectionAuth({
    id: 'codex',
    name: 'Codex CLI',
    installed: true,
    authenticated: false,
    authType: 'chatgpt',
    requiresAuth: true
  });
  assert.equal(codexNoAuth.isAnonymous, false);
  assert.equal(codexNoAuth.text, 'Потрібен вхід');
});

test('renderConnections shows availability, billing, quota, block reason, loading and error states', () => {
  const catalog = {
    checkedAt: '2026-11-15T12:00:00Z',
    manager: { available: false, reason: 'Немає моделі з правами директора' },
    connections: [
      { id: 'opencode', name: 'OpenCode', installed: true, authenticated: false, authType: 'anonymous', requiresAuth: false, note: 'Анонімний каталог' },
      { id: 'codex', name: 'Codex CLI', installed: true, authenticated: false, authType: 'chatgpt', quota: { known: true, primary: { usedPercent: 42 } }, note: 'Потрібен вхід' }
    ],
    routes: [
      {
        id: 'opencode:opencode/big-pickle',
        connectionId: 'opencode',
        name: 'Big Pickle',
        description: 'Безкоштовна текстова модель',
        billing: 'free_tier',
        availability: 'ready',
        source: 'opencode models --verbose',
        checkedAt: '2026-11-15T12:00:00Z',
        limit: { context: 200000, output: 16384 },
        capabilities: { workspaceWrite: false, tools: false, structuredOutput: false, jsonOutput: 'prompt_validated' },
        decision: { allowed: true, reason: 'Підтверджено безкоштовний тариф OpenCode' }
      },
      {
        id: 'codex:gpt-5.4',
        connectionId: 'codex',
        name: 'GPT-5.4',
        description: 'Потрібна підписка ChatGPT',
        billing: 'unknown',
        availability: 'unavailable',
        source: 'codex app-server',
        checkedAt: '2026-11-15T12:00:00Z',
        decision: { allowed: false, reason: 'Користувач не увійшов у Codex CLI' }
      }
    ]
  };

  const html = renderConnections(catalog, true, { h, button, heading, loading: true, error: 'Таймаут сканування' });
  assert.match(html, /Сканування встановлених CLI/);
  assert.match(html, /Не вдалося оновити каталог підключень:.*Таймаут сканування/);
  assert.match(html, /Працює без входу \(anonymous\)/);
  assert.match(html, /Використано 42%/);
  assert.match(html, /Доступна/);
  assert.match(html, /Недоступна/);
  assert.match(html, /Користувач не увійшов у Codex CLI/);
  assert.match(html, /Лише текст \(без запису файлів\)/);
});

test('routing payload maps wizard priorities and per-task requirements correctly', () => {
  assert.equal(mapWizardPriorityToRouting('cost'), 'economy');
  assert.equal(mapWizardPriorityToRouting('quality'), 'quality');

  const project = {
    id: 'p1',
    revision: 3,
    status: 'idle',
    tasks: [
      { id: 't1', title: 'Аналіз' },
      { id: 't2', title: 'Код' }
    ]
  };
  const payload = buildRoutingPayload(project, {
    priority: 'cost',
    maxAgentsPerTask: 2,
    managerRouteId: 'opencode:opencode/big-pickle',
    requirements: { t1: 'text', t2: 'write' }
  });
  assert.deepEqual(payload, {
    projectId: 'p1',
    revision: 3,
    priority: 'economy',
    maxAgentsPerTask: 2,
    managerRouteId: 'opencode:opencode/big-pickle',
    requirements: {
      t1: { workspaceWrite: false, tools: false },
      t2: { workspaceWrite: true, tools: false }
    }
  });
});

test('isProposalStale detects revision mismatch and summarizes recommended vs routed vs actual separately', () => {
  const project = {
    id: 'p1',
    revision: 4,
    status: 'idle',
    tasks: [{ id: 't1', title: 'Задача', agentIds: ['architect'] }],
    execution: null
  };
  const routingEntry = {
    loading: false,
    proposing: false,
    error: 'Немає дозволеної моделі для workspaceWrite',
    stale: false,
    proposal: {
      id: 'rp1',
      revision: 3,
      priority: 'economy',
      maxAgentsPerTask: 2,
      provenance: { model: 'opencode/big-pickle', backend: 'opencode', at: '2026-11-15T12:00:00Z' },
      requirements: { t1: { workspaceWrite: false, tools: false } },
      routes: [{ id: 'opencode:opencode/big-pickle', backend: 'opencode', model: 'opencode/big-pickle', billing: 'free_tier' }],
      assignments: [{ taskId: 't1', routeIds: ['opencode:opencode/big-pickle'], reason: 'Підходить для текстового аналізу' }]
    }
  };

  assert.equal(isProposalStale(project, routingEntry), true);

  const summary = summarizeTaskModels(
    project,
    project.tasks[0],
    [{ id: 'architect', name: 'Архітектор', model: 'GPT-6 Astra', provider: 'API' }],
    routingEntry
  );
  assert.equal(summary.recommended[0].model, 'GPT-6 Astra');
  assert.equal(summary.routed.routes[0].id, 'opencode:opencode/big-pickle');
  assert.equal(summary.routed.stale, true);
  assert.equal(summary.actual.active, false);

  const html = renderRoutingSection(project, routingEntry, { routes: [], manager: null }, { h, icon, button });
  assert.match(html, /Пропозиція застаріла/);
  assert.match(html, /Немає дозволеної моделі для workspaceWrite/);
  assert.match(html, /opencode:opencode\/big-pickle/);
  assert.match(html, /Підходить для текстового аналізу/);
});

test('UI resolves the actual catalog manager ID and runtime assignments independently of role profiles',()=>{
  const project={id:'p',revision:1,tasks:[{id:'t',agentIds:['backend']}],execution:{mode:'real',agents:[{id:'route-a',model:'free-code',provider:'opencode'}],tasks:[{id:'t',assignedAgentIds:['route-a']}]}};
  assert.equal(summarizeTaskModels(project,project.tasks[0]).actual.agents[0].model,'free-code');
  const catalog={manager:'opencode:free-code',routes:[{id:'opencode:free-code',model:'free-code',decision:{allowed:true,reason:'verified'}}],connections:[]};
  assert.match(renderConnections(catalog,false,{h,button,heading}),/Готовий до підбору/);
  assert.match(renderRoutingSection(project,null,catalog,{h,icon,button}),/Автоматично \(free-code\)/);
  assert.equal(buildRoutingPayload(project).maxAgentsPerTask,1);
});

test('formatBillingBadge and executionPanel surface subscription/free routes, SSE stream state, draining, and failures', () => {
  assert.deepEqual(formatBillingBadge('subscription_included', 'subscription_quota_guarded'), {
    label: 'Підписка (контроль квоти)',
    shortLabel: 'Підписка',
    tone: 'subscription'
  });
  assert.deepEqual(formatBillingBadge('free_tier'), {
    label: 'Безкоштовний маршрут',
    shortLabel: 'Безкоштовний маршрут',
    tone: 'free'
  });
  assert.deepEqual(formatBillingBadge('metered'), {
    label: 'Оплата за фактом (заблоковано)',
    shortLabel: 'За фактом',
    tone: 'blocked'
  });

  const runningPanelHtml = executionPanel({
    revision: 3,
    status: 'running',
    execution: {
      mode: 'real',
      id: 'run-99',
      status: 'running',
      calls: 2,
      maxCalls: 20,
      draining: true,
      workspace: '.orchestrator/workspaces/demo',
      agents: [
        { id: 'route-sub', name: 'Codex Dev', model: 'gpt-5.4', provider: 'Codex CLI', billing: 'subscription_included', billingBoundary: 'subscription_quota_guarded', access: 'workspace-write' },
        { id: 'route-free', name: 'OpenCode Reviewer', model: 'opencode/big-pickle', provider: 'OpenCode', billing: 'free_tier', access: 'read-only' }
      ],
      tasks: []
    }
  }, h, button, { status: 'reconnecting', attempts: 2 });

  assert.match(runningPanelHtml, /SSE перепідключення \(2\)/);
  assert.match(runningPanelHtml, /Зупиняється/);
  assert.match(runningPanelHtml, /Підписка \(контроль квоти\)/);
  assert.match(runningPanelHtml, /Безкоштовний маршрут/);

  const failedPanelHtml = executionPanel({
    revision: 3,
    status: 'failed',
    execution: {
      mode: 'real',
      id: 'run-100',
      status: 'failed',
      calls: 2,
      agents: [],
      tasks: [{ id: 't1', title: 'Перевірка збірки', status: 'failed', error: 'Exit code 1' }]
    }
  }, h, button);
  assert.match(failedPanelHtml, /Запуск завершився помилкою/);
  assert.match(failedPanelHtml, /Exit code 1/);
});

test('live execution retains recovery state, counts manager tokens once, and explains blocked routes', () => {
  const project = { id: 'p', tasks: [{ id: 't', title: 'API', agentIds: ['profile'] }] };
  const run = {
    id: 'r', status: 'running', calls: 2,
    project: { agents: [], workspace: 'workspace', uiRevision: 1 },
    tasks: [{ id: 't', title: 'API', status: 'blocked', error: '<route denied>' }],
    recovery: { status: 'planning', rounds: [] },
    events: [
      { type: 'agent.failed', usage: { input_tokens: 10, output_tokens: 2 } },
      { type: 'recovery.manager_completed', usage: { prompt_tokens: 20, completion_tokens: 3 } },
      { type: 'recovery.completed' }
    ]
  };
  applyExecutionRun(project, run);
  assert.deepEqual(project.execution.usage, { input: 30, output: 5 });
  assert.equal(project.execution.recovery.status, 'planning');
  assert.match(executionPanel(project, h, button), /AI-керівник підбирає заміну/);
  applyExecutionRun(project, run);
  assert.deepEqual(project.execution.usage, { input: 30, output: 5 });
  run.status = 'failed'; run.recovery = { status: 'stopped', reason: 'Немає дозволених маршрутів' };
  applyExecutionRun(project, run);
  const html = executionPanel(project, h, button);
  assert.match(html, /&lt;route denied&gt;/);
  assert.doesNotMatch(html, /<route denied>/);
  assert.match(html, /Відновлення зупинено: Немає дозволених маршрутів/);
  assert.match(formatBillingBadge('subscription_included').label, /межу списань не підтверджено/);
});
