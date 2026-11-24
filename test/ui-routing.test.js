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
import { awaitingExecutionDetails, executionPanel, fileArtifacts } from '../apps/web/src/execution-ui.js';
import { applyExecutionRun, serializeWorkspaceState } from '../apps/web/src/execution.js';

const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const button = (action, text, _glyph, cls = 'btn', extra = '') => `<button data-action="${action}" class="${cls}" ${extra}>${text}</button>`;
const icon = name => `<i data-icon="${name}"></i>`;
const heading = (_e, title) => `<h1>${title}</h1>`;

test('the cached reference to a real run renders before its executor details arrive', () => {
  const project={execution:{mode:'real',id:'run-1',status:'blocked',agents:[],tasks:[],files:[]}};
  const cached=serializeWorkspaceState({projects:[project]}).projects[0];
  assert.equal(awaitingExecutionDetails(cached),true);
  assert.match(executionPanel(cached,h,button),/Завантажуємо дані запуску/);
  assert.equal(fileArtifacts(cached,h,button),'');
  assert.equal(awaitingExecutionDetails(project),false);
  assert.match(executionPanel(project,h,button),/Реальне виконання команди/);
});

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
    workerRouteIds: ['opencode:opencode/big-pickle'],
    requirements: { t1: 'text', t2: 'write' }
  });
  assert.deepEqual(payload, {
    projectId: 'p1',
    revision: 3,
    priority: 'economy',
    maxAgentsPerTask: 2,
    managerRouteId: 'opencode:opencode/big-pickle',
    requirements: {
      t1: { workspaceWrite: false, tools: false, allowedRouteIds: ['opencode:opencode/big-pickle'] },
      t2: { workspaceWrite: true, tools: false, allowedRouteIds: ['opencode:opencode/big-pickle'] }
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

test('execution failure summary distinguishes the original error from blocked dependency tasks',()=>{
  const html=executionPanel({execution:{mode:'real',status:'failed',calls:1,agents:[],tasks:[
    {id:'a',title:'Root task',status:'failed',error:'Invalid schema'},
    ...Array.from({length:27},(_,i)=>({id:`dependent-${i}`,title:`Dependent ${i}`,status:'blocked'}))
  ]}},h,button);
  assert.match(html,/Root task: Invalid schema/);assert.match(html,/Залежні задачі не запускалися: 27/);
  assert.doesNotMatch(html,/помилка виконання|Dependent 26/);
});

test('timeout continuation is offered only when the server confirms eligibility',()=>{
  const p={execution:{mode:'real',status:'failed',calls:6,agents:[],tasks:[],canContinue:true}};
  assert.match(executionPanel(p,h,button),/data-action="continue-run"/);
  assert.match(executionPanel(p,h,button),/Готові результати й облік викликів зберігаються/);
  p.execution.canContinue=false;assert.doesNotMatch(executionPanel(p,h,button),/data-action="continue-run"/);
});

test('blocked reports show a clarification action and draft checks instead of an execution failure',()=>{
  const p={execution:{mode:'real',status:'blocked',calls:2,agents:[],canClarify:true,tasks:[{id:'t',title:'Assortment',status:'blocked',failure:{code:'AGENT_BLOCKED'},
    blockedReport:{summary:'Inventory not confirmed <script>',files:['draft.md'],checks:[{command:'draft check',status:'passed',details:'verified'}]}}]}};
  const html=executionPanel(p,h,button);assert.match(html,/Потрібне уточнення вимог/);assert.match(html,/data-action="clarify-run"/);
  assert.match(html,/draft.md/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/Запуск завершився помилкою/);
});

test('saved local checks show progress and remaining requirements without prompting for clarification',()=>{
  const task={id:'b',title:'Storefront quality',status:'blocked',attempts:1,canVerifyOnHost:false,failure:{code:'AGENT_BLOCKED'},
    blockedReport:{summary:'HTTP EACCES',files:['draft.md'],checks:[{command:'Physical Safari',status:'not_run',details:'Потрібен iPhone'}]},
    verificationBlockers:[{command:'HTTP tests',reason:'Loopback unavailable'}],
    hostVerificationProgress:{attempt:1,checks:[{command:'HTTP tests',status:'passed'}]},
    pendingVerificationChecks:[{command:'Physical Safari',details:'Потрібен iPhone'}]};
  const html=executionPanel({execution:{mode:'real',status:'blocked',canClarify:true,calls:1,agents:[],tasks:[task]}},h,button);
  assert.match(html,/Локальні результати збережено/);
  assert.match(html,/HTTP tests<\/code> · Пройшла локально/);
  assert.match(html,/Physical Safari<\/code> · Очікує перевірки/);
  assert.equal(html.match(/<strong>Storefront quality<\/strong>/g).length,1);
  assert.match(html,/<details><summary>Чернетка та початковий звіт агента<\/summary>\s*<p>HTTP EACCES<\/p>/);
  assert.match(html,/draft.md/);
  assert.doesNotMatch(html,/data-action="clarify-run"|data-action="verify-host-run"/);
});

test('access retry has a separate action and explains entitlement revalidation',()=>{
  const p={execution:{mode:'real',status:'failed',calls:8,agents:[],tasks:[],canRetryAccess:true}};
  assert.match(executionPanel(p,h,button),/data-action="retry-access-run"/);
  assert.match(executionPanel(p,h,button),/повторно перевіримо підписку, квоту й тариф/);
  p.execution.canRetryAccess=false;assert.doesNotMatch(executionPanel(p,h,button),/data-action="retry-access-run"/);
});
