/**
 * Pure camera math and target-tracking helpers for the 3D Solar System view.
 * Keeps look-at locked to a moving planet/moon without orbital velocity drift.
 */

export const SUN_RADIUS = 21;

export const DEFAULT_OVERVIEW_CAMERA = Object.freeze({
  yaw: 0.56,
  pitch: 0.42,
  distance: 275,
  minDistance: 28,
  maxDistance: 780
});

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Computes safe near plane and camera distance bounds for a celestial body so
 * zooming closely never clips into the surface, atmosphere, or planetary rings.
 */
export function computeTargetBounds(targetInfo) {
  if (!targetInfo || targetInfo.kind === 'sun' && !targetInfo.focused) {
    return {
      minDistance: 36,
      maxDistance: 780,
      focusDistance: DEFAULT_OVERVIEW_CAMERA.distance,
      nearPlane: 1.5
    };
  }

  const radius = Math.max(1.5, Number(targetInfo.radius) || 8);
  const ringFactor = targetInfo.hasRing ? 2.45 : 1.0;
  const envelope = radius * ringFactor;

  if (targetInfo.kind === 'sun') {
    const minDistance = Math.max(34, radius * 2.15);
    return {
      minDistance,
      maxDistance: 780,
      focusDistance: radius * 6.4,
      nearPlane: 1.2
    };
  }

  if (targetInfo.kind === 'moon') {
    const minDistance = Math.max(7.5, radius * 3.1);
    return {
      minDistance,
      maxDistance: 240,
      focusDistance: Math.max(minDistance * 1.65, radius * 6.2),
      nearPlane: 0.45
    };
  }

  const minDistance = Math.max(16, radius * 2.15, envelope * 1.18);
  const focusDistance = Math.max(minDistance * 1.5, radius * (targetInfo.hasRing ? 6.2 : 5.4));
  return {
    minDistance,
    maxDistance: 560,
    focusDistance,
    nearPlane: clamp(minDistance * 0.04, 0.45, 1.8)
  };
}

export function createCameraState(overrides = {}) {
  return {
    yaw: overrides.yaw ?? DEFAULT_OVERVIEW_CAMERA.yaw,
    pitch: overrides.pitch ?? DEFAULT_OVERVIEW_CAMERA.pitch,
    distance: overrides.distance ?? DEFAULT_OVERVIEW_CAMERA.distance,
    desiredDistance: overrides.desiredDistance ?? overrides.distance ?? DEFAULT_OVERVIEW_CAMERA.distance,
    focusRef: overrides.focusRef ?? { kind: 'sun' },
    transitionOffset: overrides.transitionOffset ? [...overrides.transitionOffset] : [0, 0, 0],
    lastTargetPos: overrides.lastTargetPos ? [...overrides.lastTargetPos] : [0, 0, 0]
  };
}

/**
 * Reconciles selected / focused references against an updated solar model (e.g. SSE update).
 * Keeps tracking the same planet even if IDs transition via agentIds; falls back to Sun if removed.
 */
export function reconcileTargetWithModel(selected, focusRef, model) {
  if (!model) {
    return { selected: null, focusRef: { kind: 'sun' }, fellBack: Boolean(selected || focusRef?.kind !== 'sun') };
  }

  const resolveRef = ref => {
    if (!ref) return null;
    if (ref.kind === 'sun') return { kind: 'sun' };
    if (ref.kind === 'planet') {
      let planet = model.planets.find(p => p.id === ref.id);
      if (!planet && ref.agentIds?.length) {
        planet = model.planets.find(p => p.agentIds?.some(id => ref.agentIds.includes(id)));
      }
      if (!planet) return null;
      return { kind: 'planet', id: planet.id, agentIds: planet.agentIds };
    }
    if (ref.kind === 'moon') {
      for (const p of model.planets) {
        const moon = p.moons.find(m => m.key === ref.key || (ref.id && m.id === ref.id));
        if (moon) return { kind: 'moon', key: moon.key, id: moon.id };
      }
      return null;
    }
    return null;
  };

  const nextSelected = selected ? resolveRef(selected) : null;
  const resolvedFocus = focusRef ? resolveRef(focusRef) : null;
  const hadNonSunTarget = Boolean((selected && !nextSelected) || (focusRef && focusRef.kind !== 'sun' && !resolvedFocus));

  return {
    selected: nextSelected,
    focusRef: resolvedFocus ?? { kind: 'sun' },
    fellBack: hadNonSunTarget
  };
}

/**
 * Finds the current world-space coordinates and bounding info for the focused target.
 */
export function resolveTargetPositionAndBounds(focusRef, planetPositions, sunRadius = SUN_RADIUS) {
  if (focusRef?.kind === 'planet') {
    const ps = planetPositions.find(p => p.planet.id === focusRef.id);
    if (ps) {
      return {
        found: true,
        center: [...ps.center],
        bounds: computeTargetBounds({ kind: 'planet', radius: ps.radius, hasRing: Boolean(ps.arch?.hasRing) })
      };
    }
  } else if (focusRef?.kind === 'moon') {
    for (const ps of planetPositions) {
      const m = ps.moons.find(item => item.moon.key === focusRef.key || (focusRef.id && item.moon.id === focusRef.id));
      if (m) {
        return {
          found: true,
          center: [...m.center],
          bounds: computeTargetBounds({ kind: 'moon', radius: m.radius, hasRing: false })
        };
      }
    }
  }
  const focusedSun = Boolean(focusRef?.kind === 'sun' && focusRef.focused);
  return {
    found: !focusRef || focusRef.kind === 'sun',
    center: [0, 0, 0],
    bounds: computeTargetBounds({ kind: 'sun', radius: sunRadius, focused: focusedSun })
  };
}

/**
 * Switches camera focus target smoothly by preserving visual continuity via transitionOffset.
 * Unlike smoothing the world position directly, decaying an offset leaves zero orbital lag once settled.
 */
export function setCameraFocus(cam, nextFocusRef, nextCenter, bounds, { snap = false, keepDistance = false } = {}) {
  const prevTarget = [
    cam.lastTargetPos[0] + cam.transitionOffset[0],
    cam.lastTargetPos[1] + cam.transitionOffset[1],
    cam.lastTargetPos[2] + cam.transitionOffset[2]
  ];
  cam.focusRef = nextFocusRef ?? { kind: 'sun' };
  cam.lastTargetPos = [...nextCenter];

  if (snap) {
    cam.transitionOffset = [0, 0, 0];
  } else {
    cam.transitionOffset = [
      prevTarget[0] - nextCenter[0],
      prevTarget[1] - nextCenter[1],
      prevTarget[2] - nextCenter[2]
    ];
  }

  if (!keepDistance && bounds) {
    cam.desiredDistance = clamp(bounds.focusDistance, bounds.minDistance, bounds.maxDistance);
    if (snap) cam.distance = cam.desiredDistance;
  } else if (bounds) {
    cam.desiredDistance = clamp(cam.desiredDistance, bounds.minDistance, bounds.maxDistance);
    if (snap) cam.distance = cam.desiredDistance;
  }
}

export function resetCameraToSun(cam, { snap = false } = {}) {
  const bounds = computeTargetBounds({ kind: 'sun', focused: false });
  setCameraFocus(cam, { kind: 'sun' }, [0, 0, 0], bounds, { snap });
  cam.yaw = DEFAULT_OVERVIEW_CAMERA.yaw;
  cam.pitch = DEFAULT_OVERVIEW_CAMERA.pitch;
  cam.desiredDistance = DEFAULT_OVERVIEW_CAMERA.distance;
  if (snap) cam.distance = DEFAULT_OVERVIEW_CAMERA.distance;
}

export function applyCameraOrbitDelta(cam, dYaw, dPitch) {
  cam.yaw += dYaw;
  cam.pitch = clamp(cam.pitch + dPitch, 0.06, 1.48);
}

export function applyCameraZoomFactor(cam, factor, bounds) {
  const next = cam.desiredDistance * factor;
  cam.desiredDistance = clamp(next, bounds.minDistance, bounds.maxDistance);
}

/**
 * Advances FPS-independent camera interpolation and returns exact target, eye, and nearPlane.
 */
export function stepCameraFrame(cam, currentTargetPos, bounds, dt, { reducedMotion = false } = {}) {
  const safeDt = Math.max(0, Math.min(0.1, Number(dt) || 0));
  cam.lastTargetPos = [...currentTargetPos];

  if (reducedMotion || safeDt === 0) {
    cam.transitionOffset = [0, 0, 0];
    cam.distance = clamp(cam.desiredDistance, bounds.minDistance, bounds.maxDistance);
  } else {
    const offsetAlpha = Math.exp(-8.5 * safeDt);
    cam.transitionOffset = [
      cam.transitionOffset[0] * offsetAlpha,
      cam.transitionOffset[1] * offsetAlpha,
      cam.transitionOffset[2] * offsetAlpha
    ];
    if (Math.hypot(cam.transitionOffset[0], cam.transitionOffset[1], cam.transitionOffset[2]) < 0.002) {
      cam.transitionOffset = [0, 0, 0];
    }

    const clampedDesired = clamp(cam.desiredDistance, bounds.minDistance, bounds.maxDistance);
    cam.desiredDistance = clampedDesired;
    const distLerp = 1 - Math.exp(-12 * safeDt);
    cam.distance += (clampedDesired - cam.distance) * distLerp;
    cam.distance = clamp(cam.distance, bounds.minDistance, bounds.maxDistance);
  }

  const target = [
    currentTargetPos[0] + cam.transitionOffset[0],
    currentTargetPos[1] + cam.transitionOffset[1],
    currentTargetPos[2] + cam.transitionOffset[2]
  ];

  const eye = [
    target[0] + cam.distance * Math.cos(cam.pitch) * Math.sin(cam.yaw),
    target[1] + cam.distance * Math.sin(cam.pitch),
    target[2] + cam.distance * Math.cos(cam.pitch) * Math.cos(cam.yaw)
  ];

  const nearPlane = clamp(Math.min(bounds.nearPlane, cam.distance * 0.12), 0.35, 2.0);
  return { target, eye, nearPlane };
}

/**
 * Builds an ordered list of keyboard-selectable targets: Sun, Planets, Moons.
 */
export function buildFocusableTargetList(model) {
  if (!model) return [];
  const list = [{ kind: 'sun', label: model.sun.name }];
  for (const p of model.planets) {
    list.push({ kind: 'planet', id: p.id, agentIds: p.agentIds, label: p.name });
    for (const m of p.moons) {
      list.push({ kind: 'moon', key: m.key, id: m.id, label: m.name });
    }
  }
  return list;
}

export function stepTargetCycle(model, currentSelected, direction = 1) {
  const list = buildFocusableTargetList(model);
  if (!list.length) return null;
  let idx = -1;
  if (currentSelected?.kind === 'sun') {
    idx = 0;
  } else if (currentSelected?.kind === 'planet') {
    idx = list.findIndex(item => item.kind === 'planet' && item.id === currentSelected.id);
  } else if (currentSelected?.kind === 'moon') {
    idx = list.findIndex(item => item.kind === 'moon' && (item.key === currentSelected.key || item.id === currentSelected.id));
  }
  const nextIdx = idx === -1
    ? (direction >= 0 ? 0 : list.length - 1)
    : (idx + direction + list.length) % list.length;
  return list[nextIdx];
}
