import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, start, tick, labels } from '../apps/web/src/state.js';
import { buildSolarSystemModel } from '../apps/web/src/solar-model.js';

test('solar model maps orchestrator to sun, used models to planets, and delegated children to moons', () => {
  const state = seed();
  const project = state.projects[0];
  start(project);
  // Before 'api' runs, there are 0 subagents.
  const initialModel = buildSolarSystemModel(project, state.agents, labels);
  assert.equal(initialModel.totalMoons, 0);

  // Run 6 ticks so 'design' completes and 'api' + 'ui' run with 1 delegated child on 'api'.
  for (let i = 0; i < 6; i++) tick(project);

  const model = buildSolarSystemModel(project, state.agents, labels);
  assert.equal(model.sun.name, project.name);
  assert.equal(model.sun.status, 'running');
  assert.equal(model.planets.length, 4);

  const backend = model.planets.find(p => p.id === 'Codex CLI');
  assert.equal(backend.status, 'running');
  assert.match(backend.currentAction, /Сервер та API/);
  assert.equal(backend.moons.length, 1);
  assert.equal(backend.moons[0].name, 'Перевірка контрактів');
  assert.equal(backend.moons[0].status, 'running');
});

test('solar model creates planets only for models actually used in tasks and groups shared models', () => {
  const state = seed();
  // Knowledge Base has 2 agents in team, but only 1 agent/model is assigned to tasks.
  const kb = state.projects[1];
  const kbModel = buildSolarSystemModel(kb, state.agents, labels);
  assert.equal(kbModel.planets.length, 1);
  assert.equal(kbModel.planets[0].name, 'GPT-6 Astra');
  assert.equal(kbModel.totalMoons, 0);

  // When multiple agents in real execution use the same model, they consolidate into 1 planet for that model.
  const core = state.projects[0];
  core.execution = {
    mode: 'real',
    calls: 3,
    agents: [
      { id: 'architect', name: 'Архітектор', model: 'gpt-6.1-sol', access: 'workspace-write' },
      { id: 'backend', name: 'Backend engineer', model: 'gpt-6.1-sol', access: 'workspace-write' },
      { id: 'frontend', name: 'Frontend engineer', model: 'gpt-6.1-sol', access: 'workspace-write' },
      { id: 'reviewer', name: 'Рецензент', model: 'gpt-5-codex', access: 'read-only' }
    ]
  };
  const realModel = buildSolarSystemModel(core, state.agents, labels);
  assert.equal(realModel.planets.length, 2);
  assert.deepEqual(realModel.planets.map(p => p.name), ['gpt-6.1-sol', 'gpt-5-codex']);
  assert.equal(realModel.planets[0].modelSource, 'execution');
  assert.match(realModel.planets[0].sourceLabel, /Фактичний виконавець/);
});

test('solar model distinguishes routing proposal models from recommended profiles and actual execution', () => {
  const state = seed();
  const kb = state.projects[1];
  const taskId = kb.tasks[0].id;
  const routingEntry = {
    stale: false,
    proposal: {
      revision: kb.revision,
      assignments: [{ taskId, routeIds: ['opencode:opencode/big-pickle'], reason: 'Безкоштовний текстовий маршрут' }],
      routes: [{ id: 'opencode:opencode/big-pickle', backend: 'opencode', model: 'opencode/big-pickle', billing: 'free_tier' }]
    }
  };
  const routedModel = buildSolarSystemModel(kb, state.agents, labels, routingEntry);
  assert.equal(routedModel.planets.length, 1);
  assert.equal(routedModel.planets[0].name, 'opencode/big-pickle');
  assert.equal(routedModel.planets[0].modelSource, 'routing');
  assert.deepEqual(routedModel.planets[0].recommendedModels, ['GPT-6 Astra']);
  assert.deepEqual(routedModel.planets[0].routedModels, ['opencode:opencode/big-pickle']);
  assert.deepEqual(routedModel.planets[0].actualModels, []);
});

test('solar model maps nested parentId child subtasks to moons with real model, billing, result, error, and draining state', () => {
  const project = {
    id: 'real-1',
    name: 'Real System',
    description: 'Execution test',
    revision: 2,
    status: 'running',
    team: ['backend'],
    events: [{ text: 'Делеговано підзадачу', at: 1000, real: true }],
    tasks: [
      { id: 't1', title: 'Побудова API', prompt: 'Напиши ендпоінти', status: 'waiting_children', agentIds: ['backend'], dependsOn: [], assignedAgentIds: ['route-1'], children: [] }
    ],
    execution: {
      mode: 'real',
      id: 'run-1',
      status: 'running',
      draining: true,
      calls: 4,
      agents: [
        { id: 'route-1', name: 'Backend Codex', model: 'gpt-5.4', provider: 'Codex CLI', billing: 'subscription_included', billingBoundary: 'subscription_quota_guarded', access: 'workspace-write' },
        { id: 'route-2', name: 'Subagent Helper', model: 'opencode/big-pickle', provider: 'OpenCode', billing: 'free_tier', billingBoundary: null, access: 'read-only' }
      ],
      tasks: [
        { id: 't1', title: 'Побудова API', prompt: 'Напиши ендпоінти', status: 'waiting_children', assignedAgentIds: ['route-1'], dependsOn: [], result: 'Базовий каркас готовий' },
        { id: 'c1', parentId: 't1', title: 'Юніт-тести API', prompt: 'Додай тести', status: 'running', assignedAgentIds: ['route-2'], dependsOn: [] },
        { id: 'c2', parentId: 'c1', title: 'Перевірка схеми', prompt: 'Перевір OpenAPI', status: 'failed', assignedAgentIds: ['route-2'], dependsOn: [], error: 'Таймаут схеми' }
      ]
    }
  };

  const model = buildSolarSystemModel(project, [{ id: 'backend', name: 'Backend', model: 'GPT-6 Astra', provider: 'API' }], labels);
  assert.equal(model.sun.draining, true);
  assert.equal(model.sun.isReal, true);
  assert.equal(model.sun.failedTasks.length, 1);
  assert.equal(model.sun.failedTasks[0].error, 'Таймаут схеми');
  assert.equal(model.sun.latestResult.text, 'Базовий каркас готовий');

  assert.equal(model.planets.length, 1);
  const planet = model.planets[0];
  assert.equal(planet.name, 'gpt-5.4');
  assert.equal(planet.billingTone, 'subscription');
  assert.match(planet.billingLabel, /Підписка/);
  assert.equal(planet.tasks[0].result, 'Базовий каркас готовий');
  assert.equal(planet.tasks[0].cancellable, true);

  assert.equal(planet.moons.length, 2);
  const child1 = planet.moons.find(m => m.id === 'c1');
  const child2 = planet.moons.find(m => m.id === 'c2');
  assert.equal(child1.model, 'opencode/big-pickle');
  assert.equal(child1.billingTone, 'free');
  assert.equal(child1.cancellable, true);
  assert.equal(child2.status, 'failed');
  assert.equal(child2.error, 'Таймаут схеми');
  assert.equal(child2.cancellable, false);
});

test('solar inspector retains guarded billing and blocked task reasons during recovery', () => {
  const state = seed(), project = state.projects[1], root = project.tasks[0];
  project.status = 'failed';
  project.execution = {
    mode: 'real', calls: 1,
    agents: [{ id: 'real', name: 'Worker', model: 'codex', billing: 'subscription_included', billingBoundary: 'subscription_quota_guarded' }],
    tasks: [
      { id: root.id, title: 'Root', status: 'blocked', error: 'Quota denied', assignedAgentIds: ['real'] },
      { id: 'child', parentId: root.id, title: 'Child', status: 'blocked', error: 'Child quota denied', assignedAgentIds: ['real'] }
    ]
  };
  const model = buildSolarSystemModel(project, state.agents, labels);
  assert.equal(model.sun.failedTasks.length, 2);
  assert.match(model.sun.currentAction, /2 не виконано/);
  assert.equal(model.planets[0].currentDetail, 'Quota denied');
  assert.equal(model.planets[0].billingBoundary, 'subscription_quota_guarded');
  assert.equal(model.planets[0].moons[0].billingBoundary, 'subscription_quota_guarded');
  assert.equal(model.planets[0].moons[0].currentAction, 'Child quota denied');
  project.status = 'running'; project.execution.recovery = { status: 'planning' };
  assert.match(buildSolarSystemModel(project, state.agents, labels).sun.currentAction, /AI-керівник підбирає заміну/);
});
