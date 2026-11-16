import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OVERVIEW_CAMERA,
  computeTargetBounds,
  createCameraState,
  reconcileTargetWithModel,
  resolveTargetPositionAndBounds,
  setCameraFocus,
  resetCameraToSun,
  applyCameraOrbitDelta,
  applyCameraZoomFactor,
  stepCameraFrame,
  stepTargetCycle,
  buildFocusableTargetList
} from '../apps/web/src/solar-camera.js';

test('camera target bounds prevent clipping into planets, moons, and planetary rings', () => {
  const ringedBounds = computeTargetBounds({ kind: 'planet', radius: 8.6, hasRing: true });
  assert.ok(ringedBounds.minDistance > 8.6 * 2.45, 'minDistance must clear outer ring radius');
  assert.ok(ringedBounds.nearPlane < ringedBounds.minDistance - 8.6);

  const terraBounds = computeTargetBounds({ kind: 'planet', radius: 7.8, hasRing: false });
  assert.ok(terraBounds.minDistance > 7.8 * 2);
  assert.ok(terraBounds.minDistance < ringedBounds.minDistance);

  const moonBounds = computeTargetBounds({ kind: 'moon', radius: 2.5, hasRing: false });
  assert.ok(moonBounds.minDistance >= 7.5 && moonBounds.nearPlane <= 0.5);
});

test('camera tracks a moving planet with zero orbital lag regardless of FPS once settled', () => {
  const planetBounds = computeTargetBounds({ kind: 'planet', radius: 7.8, hasRing: false });
  const initialPlanetPos = [110, 0, 0];

  // Simulate 60 Hz steps for 1.5s while the planet moves along its orbit
  const cam60 = createCameraState();
  setCameraFocus(cam60, { kind: 'planet', id: 'p1' }, initialPlanetPos, planetBounds);
  let pos60 = [...initialPlanetPos];
  let out60;
  for (let i = 1; i <= 90; i++) {
    const angle = i * (1 / 60) * 0.25;
    pos60 = [Math.cos(angle) * 110, 0, Math.sin(angle) * 110];
    out60 = stepCameraFrame(cam60, pos60, planetBounds, 1 / 60);
  }

  // Exact lock: once transitionOffset decays, camera look-at equals exact live planet world position
  assert.ok(Math.hypot(out60.target[0] - pos60[0], out60.target[1] - pos60[1], out60.target[2] - pos60[2]) < 0.01);

  // Orbit drag & zoom apply around the tracked planet's current center
  const prevDist = cam60.desiredDistance;
  applyCameraOrbitDelta(cam60, 0.5, 0.2);
  applyCameraZoomFactor(cam60, 0.5, planetBounds);
  const afterZoom = stepCameraFrame(cam60, pos60, planetBounds, 0.5);
  assert.ok(cam60.desiredDistance < prevDist);
  const eyeDistFromPlanet = Math.hypot(
    afterZoom.eye[0] - pos60[0],
    afterZoom.eye[1] - pos60[1],
    afterZoom.eye[2] - pos60[2]
  );
  assert.ok(Math.abs(eyeDistFromPlanet - cam60.distance) < 0.05);
  assert.ok(eyeDistFromPlanet >= planetBounds.minDistance - 0.001);
});

test('reducedMotion snaps transitions immediately and reset returns to Sun overview', () => {
  const bounds = computeTargetBounds({ kind: 'planet', radius: 8.2, hasRing: false });
  const cam = createCameraState();
  const targetPos = [90, 0, -45];
  setCameraFocus(cam, { kind: 'planet', id: 'ice' }, targetPos, bounds, { snap: true });
  const out = stepCameraFrame(cam, targetPos, bounds, 0.016, { reducedMotion: true });
  assert.deepEqual(out.target, targetPos);
  assert.equal(cam.distance, clampToBounds(bounds));

  resetCameraToSun(cam, { snap: true });
  const sunOut = stepCameraFrame(cam, [0, 0, 0], computeTargetBounds({ kind: 'sun', focused: false }), 0.016);
  assert.deepEqual(sunOut.target, [0, 0, 0]);
  assert.equal(cam.yaw, DEFAULT_OVERVIEW_CAMERA.yaw);
  assert.equal(cam.distance, DEFAULT_OVERVIEW_CAMERA.distance);
});

function clampToBounds(b) {
  return Math.max(b.minDistance, Math.min(b.maxDistance, b.focusDistance));
}

test('reconcileTargetWithModel preserves renamed agent planet via agentIds and falls back to Sun if removed', () => {
  const prevModel = {
    sun: { name: 'Core' },
    planets: [
      { id: 'GPT-6 Astra', name: 'GPT-6 Astra', agentIds: ['architect'], moons: [{ id: 'm1', key: 't1:m1', name: 'Sub 1' }] },
      { id: 'Codex CLI', name: 'Codex CLI', agentIds: ['backend'], moons: [] }
    ]
  };

  // Switch from planned profile model to real execution model owning same agentIds
  const realModel = {
    sun: { name: 'Core' },
    planets: [
      { id: 'gpt-5.4', name: 'gpt-5.4', agentIds: ['architect', 'route-arch'], moons: [] }
    ]
  };

  const kept = reconcileTargetWithModel(
    { kind: 'planet', id: 'GPT-6 Astra', agentIds: ['architect'] },
    { kind: 'planet', id: 'GPT-6 Astra', agentIds: ['architect'] },
    realModel
  );
  assert.equal(kept.fellBack, false);
  assert.equal(kept.selected.id, 'gpt-5.4');
  assert.equal(kept.focusRef.id, 'gpt-5.4');

  // If the previously selected moon or planet vanishes completely, fall back cleanly to Sun
  const vanished = reconcileTargetWithModel(
    { kind: 'planet', id: 'Codex CLI', agentIds: ['backend'] },
    { kind: 'planet', id: 'Codex CLI', agentIds: ['backend'] },
    realModel
  );
  assert.equal(vanished.fellBack, true);
  assert.equal(vanished.selected, null);
  assert.deepEqual(vanished.focusRef, { kind: 'sun' });

  // Missing planet in resolveTargetPositionAndBounds safely returns Sun [0,0,0]
  const resolved = resolveTargetPositionAndBounds({ kind: 'planet', id: 'missing' }, [], 17);
  assert.equal(resolved.found, false);
  assert.deepEqual(resolved.center, [0, 0, 0]);

  // Keyboard target cycle traverses Sun -> Planets -> Moons
  const targets = buildFocusableTargetList(prevModel);
  assert.equal(targets.length, 4);
  assert.equal(stepTargetCycle(prevModel, null, 1).kind, 'sun');
  assert.equal(stepTargetCycle(prevModel, { kind: 'sun' }, 1).id, 'GPT-6 Astra');
  assert.equal(stepTargetCycle(prevModel, { kind: 'planet', id: 'GPT-6 Astra' }, 1).key, 't1:m1');
  assert.equal(stepTargetCycle(prevModel, { kind: 'sun' }, -1).id, 'Codex CLI');
});
