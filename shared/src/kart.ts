/**
 * Arcade forklift ("kart") simulation shared by the client (local prediction)
 * and, from step 5, the authoritative server. Pure functions over plain data:
 * no Three.js, no DOM, no Math.random. Always stepped at FIXED_DT.
 *
 * Conventions: world is X/Z on the ground, Y up. heading = 0 faces +Z,
 * forward = (sin h, cos h). steer = +1 means "turn right" on screen.
 */

export const FIXED_DT = 1 / 60;

export interface KartInput {
  /** +1 accelerate, -1 brake / reverse, 0 coast. */
  throttle: number;
  /** -1 left, +1 right. */
  steer: number;
  /** Drift / hop button held. */
  drift: boolean;
  /** Use item button held (used from step 3). */
  item: boolean;
}

export const NEUTRAL_INPUT: KartInput = { throttle: 0, steer: 0, drift: false, item: false };

export interface KartState {
  x: number;
  y: number;
  z: number;
  heading: number;
  vx: number;
  vz: number;
  /** Smoothed steering actually applied, -1..1. */
  steer: number;
  /** -1 / +1 while drifting, 0 otherwise. */
  driftDir: number;
  driftTime: number;
  driftCharge: number;
  /** 0 none, 1 blue, 2 orange, 3 red mini-turbo ready. */
  driftLevel: number;
  /** Visual hop timer (seconds remaining). */
  hop: number;
  boostTime: number;
  /** Remaining time during which a wall bump blocks drift start. */
  stunTime: number;
  /** Spinning out after a hit (no control). */
  spinTime: number;
  /** Total duration of the current spin (for rendering the rotation). */
  spinDuration: number;
  /** Cannot be hit again while > 0. */
  invulnTime: number;
  driftHeldPrev: boolean;
  /** Forward speed after the last step (m/s, negative in reverse). */
  forwardSpeed: number;
  /** Strongest impact speed during the last step (for camera shake / sfx). */
  lastImpact: number;
  /** Boost level granted at the last step (0 if none) - one-shot event. */
  boostEvent: number;
}

export interface KartParams {
  maxSpeed: number;
  accel: number;
  brakeDecel: number;
  reverseAccel: number;
  maxReverse: number;
  coastDecel: number;
  turnRate: number;
  steerResponse: number;
  grip: number;
  driftGrip: number;
  driftTurnRate: number;
  driftMinSpeed: number;
  boostMultiplier: number;
  boostAccel: number;
  wallRestitution: number;
  kartRestitution: number;
}

export const DEFAULT_KART_PARAMS: KartParams = {
  maxSpeed: 17,
  accel: 16,
  brakeDecel: 32,
  reverseAccel: 10,
  maxReverse: 6.5,
  coastDecel: 5,
  turnRate: 2.5,
  steerResponse: 9,
  grip: 11,
  driftGrip: 5.5,
  driftTurnRate: 2.2,
  driftMinSpeed: 7,
  boostMultiplier: 1.4,
  boostAccel: 28,
  wallRestitution: 0.45,
  kartRestitution: 0.6,
};

/** Seconds of drift charge needed for each mini-turbo level. */
export const DRIFT_LEVELS = [0.85, 1.8, 3.0];
/** Boost duration granted per level. */
export const DRIFT_BOOST_TIME = [0, 0.55, 1.0, 1.5];

/** Kart footprint: two circles (front / rear) along the heading. */
export const KART_CIRCLE_OFFSET = 0.55;
export const KART_CIRCLE_RADIUS = 0.72;

export function createKartState(x = 0, z = 0, heading = 0): KartState {
  return {
    x,
    y: 0,
    z,
    heading,
    vx: 0,
    vz: 0,
    steer: 0,
    driftDir: 0,
    driftTime: 0,
    driftCharge: 0,
    driftLevel: 0,
    hop: 0,
    boostTime: 0,
    stunTime: 0,
    spinTime: 0,
    spinDuration: 0,
    invulnTime: 0,
    driftHeldPrev: false,
    forwardSpeed: 0,
    lastImpact: 0,
    boostEvent: 0,
  };
}

export function copyKartState(from: KartState, to: KartState): KartState {
  Object.assign(to, from);
  return to;
}

function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function endDrift(state: KartState, grantBoost: boolean): void {
  if (grantBoost && state.driftLevel > 0) {
    state.boostTime = Math.max(state.boostTime, DRIFT_BOOST_TIME[state.driftLevel]);
    state.boostEvent = state.driftLevel;
  }
  state.driftDir = 0;
  state.driftTime = 0;
  state.driftCharge = 0;
  state.driftLevel = 0;
}

/** Grant an external boost (e.g. "Livraison express" item). */
export function applyBoost(state: KartState, seconds: number): void {
  state.boostTime = Math.max(state.boostTime, seconds);
}

/** Advance one kart by dt using arcade rules. Collisions are resolved separately. */
/** Floor height lookup (ramps / mezzanine). Omit for a flat floor. */
export type GroundFn = (x: number, z: number) => number;

export function stepKart(state: KartState, input: KartInput, dt: number, p: KartParams, ground?: GroundFn): void {
  state.lastImpact = 0;
  state.boostEvent = 0;

  const spinning = state.spinTime > 0;
  if (spinning) input = NEUTRAL_INPUT;
  const throttle = clamp(input.throttle, -1, 1);
  const steerIn = clamp(input.steer, -1, 1);

  // Smooth steering: snappy in, faster back to center.
  const steerRate = (Math.abs(steerIn) < Math.abs(state.steer) ? 1.4 : 1) * p.steerResponse;
  state.steer = approach(state.steer, steerIn, steerRate * dt);

  let fx = Math.sin(state.heading);
  let fz = Math.cos(state.heading);
  let vf = state.vx * fx + state.vz * fz;
  let vl = state.vx * -fz + state.vz * fx;

  // --- Drift start / maintain / release ---------------------------------
  const driftPressed = input.drift && !state.driftHeldPrev;
  if (driftPressed) state.hop = 0.22;
  if (
    state.driftDir === 0 &&
    input.drift &&
    state.stunTime <= 0 &&
    Math.abs(steerIn) > 0.35 &&
    vf > p.driftMinSpeed
  ) {
    state.driftDir = steerIn > 0 ? 1 : -1;
    state.driftTime = 0;
    state.driftCharge = 0;
    state.driftLevel = 0;
  }
  if (state.driftDir !== 0) {
    if (!input.drift) {
      endDrift(state, true);
    } else if (vf < p.driftMinSpeed * 0.6) {
      endDrift(state, false);
    } else {
      state.driftTime += dt;
      // Steering into the drift charges faster; counter-steer charges slower.
      const into = steerIn * state.driftDir;
      state.driftCharge += dt * (0.75 + 0.55 * Math.max(0, into) - 0.25 * Math.max(0, -into));
      let level = 0;
      for (let i = 0; i < DRIFT_LEVELS.length; i += 1) if (state.driftCharge >= DRIFT_LEVELS[i]) level = i + 1;
      state.driftLevel = level;
    }
  }
  state.driftHeldPrev = input.drift;

  // --- Longitudinal --------------------------------------------------------
  const boosting = state.boostTime > 0;
  const top = p.maxSpeed * (boosting ? p.boostMultiplier : 1);
  if (boosting) {
    if (vf < top) vf = Math.min(top, vf + p.boostAccel * dt);
  } else if (throttle > 0.05) {
    if (vf < 0) vf = Math.min(0, vf + p.brakeDecel * throttle * dt);
    else {
      const ratio = clamp(vf / top, 0, 1);
      vf += p.accel * throttle * (1 - ratio * ratio * 0.85) * dt;
    }
  } else if (throttle < -0.05) {
    if (vf > 0.4) vf = Math.max(0, vf + p.brakeDecel * throttle * dt);
    else vf = Math.max(-p.maxReverse, vf + p.reverseAccel * throttle * dt);
  } else {
    vf = approach(vf, 0, p.coastDecel * dt);
  }
  if (vf > top) vf = approach(vf, top, (boosting ? 10 : 9) * dt);
  if (state.driftDir !== 0) vf = approach(vf, top * 0.94, 2.5 * dt); // tiny scrub while drifting
  if (ground) {
    // Gravity along the slope (softened for arcade feel): slower uphill, faster downhill.
    const ahead = ground(state.x + fx * 0.8, state.z + fz * 0.8);
    const behind = ground(state.x - fx * 0.8, state.z - fz * 0.8);
    vf -= 9.81 * 0.55 * ((ahead - behind) / 1.6) * dt;
  }

  // --- Yaw -------------------------------------------------------------------
  const speedAbs = Math.abs(vf);
  const lowSpeed = clamp(speedAbs / 3.5, 0, 1);
  const highSpeedDamp = 1 - 0.3 * clamp(speedAbs / p.maxSpeed, 0, 1);
  let yawRate: number;
  if (state.driftDir !== 0) {
    // Neutral stick keeps a mid arc; into = tight; counter = wide.
    const arc = 1 + 0.6 * state.steer * state.driftDir;
    yawRate = -state.driftDir * arc * p.driftTurnRate * lowSpeed;
  } else {
    yawRate = -state.steer * p.turnRate * lowSpeed * highSpeedDamp * (vf >= 0 ? 1 : -1);
  }
  state.heading += yawRate * dt;
  if (state.heading > Math.PI) state.heading -= Math.PI * 2;
  else if (state.heading < -Math.PI) state.heading += Math.PI * 2;

  // Velocity keeps its world direction, so the new heading produces lateral slip.
  const worldVx = fx * vf - fz * vl;
  const worldVz = fz * vf + fx * vl;
  fx = Math.sin(state.heading);
  fz = Math.cos(state.heading);
  vf = worldVx * fx + worldVz * fz;
  vl = worldVx * -fz + worldVz * fx;

  // --- Lateral grip ---------------------------------------------------------
  const grip = state.driftDir !== 0 ? p.driftGrip : p.grip;
  const keep = Math.exp(-grip * dt);
  const lostLateral = Math.abs(vl) * (1 - keep);
  vl *= keep;
  // Turn part of the scrubbed sideways speed back into forward momentum (arcade).
  if (vf > 0) vf += lostLateral * (state.driftDir !== 0 ? 0.65 : 0.35);

  state.vx = fx * vf - fz * vl;
  state.vz = fz * vf + fx * vl;
  if (spinning) {
    const decay = Math.exp(-2.4 * dt);
    state.vx *= decay;
    state.vz *= decay;
  }
  state.x += state.vx * dt;
  state.z += state.vz * dt;
  if (ground) state.y = ground(state.x, state.z);
  state.forwardSpeed = vf;

  state.boostTime = Math.max(0, state.boostTime - dt);
  state.stunTime = Math.max(0, state.stunTime - dt);
  state.spinTime = Math.max(0, state.spinTime - dt);
  state.invulnTime = Math.max(0, state.invulnTime - dt);
  state.hop = Math.max(0, state.hop - dt);
}

/** Hop height in metres for rendering (small parabola when drift is pressed). */
export function hopHeight(state: KartState): number {
  if (state.hop <= 0) return 0;
  const t = 1 - state.hop / 0.22;
  return 4 * t * (1 - t) * 0.22;
}

/** Called by collision code when a kart hits something hard. */
export function onKartImpact(state: KartState, impactSpeed: number): void {
  state.lastImpact = Math.max(state.lastImpact, impactSpeed);
  if (impactSpeed > 5 && state.driftDir !== 0) {
    endDrift(state, false);
    state.stunTime = 0.35;
  }
}

/**
 * Spin a kart out (item hit). Returns false if it is currently invulnerable.
 * Kills drift and boost; the kart slides to a near stop without control.
 */
export function hitKart(state: KartState, seconds: number): boolean {
  if (state.invulnTime > 0 || state.spinTime > 0) return false;
  endDrift(state, false);
  state.boostTime = 0;
  state.spinTime = seconds;
  state.spinDuration = seconds;
  state.invulnTime = seconds + 1.2;
  state.hop = 0.22;
  return true;
}
