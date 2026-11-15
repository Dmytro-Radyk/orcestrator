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
});
