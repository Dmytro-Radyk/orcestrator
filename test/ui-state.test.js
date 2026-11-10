import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, start, tick, cancelTask, validateTasks, initialTasks } from '../apps/web/src/state.js';

test('UI demonstration starts parallel dependencies and completes artifacts', () => {
  const p = seed().projects[0]; start(p);
  for (let i = 0; i < 100 && p.status === 'running'; i++) tick(p);
  assert.equal(p.status, 'completed'); assert.equal(p.artifacts.length, p.tasks.length);
  assert.ok(p.tasks.find(t => t.id === 'api').children.every(c => c.status === 'done'));
});
test('UI pause preserves task progress and resume continues', () => {
  const p = seed().projects[0]; start(p); tick(p); p.status = 'paused';
  const snapshot = JSON.stringify(p); assert.equal(tick(p), false); assert.equal(JSON.stringify(p), snapshot);
  p.status = 'running'; assert.equal(tick(p), true);
});
test('UI cancellation blocks dependent tasks but permits independent work', () => {
  const p = seed().projects[0]; start(p); cancelTask(p, 'api');
  assert.equal(p.tasks.find(t => t.id === 'integration').status, 'blocked');
  assert.equal(p.tasks.find(t => t.id === 'review').status, 'blocked');
  for (let i = 0; i < 100 && p.status === 'running'; i++) tick(p);
  assert.equal(p.tasks.find(t => t.id === 'ui').status, 'done'); assert.equal(p.status, 'cancelled');
});
test('UI rejects cycles and unassigned agents before starting', () => {
  const p = seed().projects[0]; p.tasks[0].dependsOn = ['review'];
  assert.throws(() => validateTasks(p.tasks), /цикл/);
  const clean = seed().projects[0]; clean.team = [];
  assert.throws(() => start(clean), /Призначте/);
});
test('UI project template chooses agents by role and skills', () => {
  const state = seed();
  const tasks = initialTasks('Build', state.agents.map(a => a.id), state.agents);
  assert.deepEqual(tasks.map(t => t.agentIds), [['architect'], ['backend'], ['reviewer']]);
  validateTasks(tasks);
  const single = initialTasks('Build', ['reviewer'], state.agents);
  assert.ok(single.every(t => t.agentIds[0] === 'reviewer'));
});
