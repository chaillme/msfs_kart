/**
 * 2D collision (X/Z plane) for karts against static level geometry and each
 * other. Karts are two circles; static colliders are oriented boxes or circles.
 * Responses are arcade: push out, bounce, slide along walls - never stick.
 */
import { KART_CIRCLE_OFFSET, KART_CIRCLE_RADIUS, onKartImpact, type KartParams, type KartState } from './kart';
import { trackSdf, trackSdfGradient, type Track } from './track';

export interface BoxCollider {
  kind: 'box';
  x: number;
  z: number;
  /** Half extents along local X and Z. */
  hx: number;
  hz: number;
  /** Rotation around Y in radians. */
  angle: number;
}

export interface CircleCollider {
  kind: 'circle';
  x: number;
  z: number;
  r: number;
}

export type StaticCollider = BoxCollider | CircleCollider;

interface Contact {
  nx: number;
  nz: number;
  depth: number;
}

const contact: Contact = { nx: 0, nz: 0, depth: 0 };

function circleVsBox(cx: number, cz: number, r: number, b: BoxCollider, out: Contact): boolean {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const dx = cx - b.x;
  const dz = cz - b.z;
  // Into box local space (rotation by -angle around Y).
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  const px = Math.max(-b.hx, Math.min(b.hx, lx));
  const pz = Math.max(-b.hz, Math.min(b.hz, lz));
  let nlx = lx - px;
  let nlz = lz - pz;
  const distSq = nlx * nlx + nlz * nlz;
  if (distSq > r * r) return false;
  let depth: number;
  if (distSq > 1e-8) {
    const dist = Math.sqrt(distSq);
    nlx /= dist;
    nlz /= dist;
    depth = r - dist;
  } else {
    // Centre inside the box: exit through the nearest face.
    const ex = b.hx - Math.abs(lx);
    const ez = b.hz - Math.abs(lz);
    if (ex < ez) {
      nlx = lx >= 0 ? 1 : -1;
      nlz = 0;
      depth = ex + r;
    } else {
      nlx = 0;
      nlz = lz >= 0 ? 1 : -1;
      depth = ez + r;
    }
  }
  // Back to world space (rotation by +angle).
  out.nx = c * nlx + s * nlz;
  out.nz = -s * nlx + c * nlz;
  out.depth = depth;
  return true;
}

function circleVsCircle(ax: number, az: number, ar: number, bx: number, bz: number, br: number, out: Contact): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  const rr = ar + br;
  const distSq = dx * dx + dz * dz;
  if (distSq >= rr * rr) return false;
  const dist = Math.sqrt(distSq);
  if (dist < 1e-6) {
    out.nx = 1;
    out.nz = 0;
  } else {
    out.nx = dx / dist;
    out.nz = dz / dist;
  }
  out.depth = rr - dist;
  return true;
}

function kartCircle(state: KartState, index: 0 | 1): { x: number; z: number } {
  const sign = index === 0 ? 1 : -1;
  return {
    x: state.x + Math.sin(state.heading) * KART_CIRCLE_OFFSET * sign,
    z: state.z + Math.cos(state.heading) * KART_CIRCLE_OFFSET * sign,
  };
}

/** Push a kart out of static geometry and bounce it. Returns the strongest impact speed. */
export function collideKartWithStatics(state: KartState, statics: readonly StaticCollider[], p: KartParams): number {
  let strongest = 0;
  // A couple of iterations so corners between two boxes resolve cleanly.
  for (let iter = 0; iter < 3; iter += 1) {
    let any = false;
    for (let ci = 0 as 0 | 1; ci <= 1; ci = (ci + 1) as 0 | 1) {
      for (const col of statics) {
        const circle = kartCircle(state, ci);
        const hit =
          col.kind === 'box'
            ? circleVsBox(circle.x, circle.z, KART_CIRCLE_RADIUS, col, contact)
            : circleVsCircle(circle.x, circle.z, KART_CIRCLE_RADIUS, col.x, col.z, col.r, contact);
        if (!hit) continue;
        any = true;
        strongest = Math.max(strongest, respondToWall(state, contact.nx, contact.nz, contact.depth, p));
      }
    }
    if (!any) break;
  }
  if (strongest > 0) onKartImpact(state, strongest);
  return strongest;
}

/** Push out along a wall normal, bounce, slide. Returns impact speed (0 if separating). */
function respondToWall(state: KartState, nx: number, nz: number, depth: number, p: KartParams): number {
  state.x += nx * depth;
  state.z += nz * depth;
  const vn = state.vx * nx + state.vz * nz;
  if (vn >= 0) return 0;
  const impact = -vn;
  // Bounce off the normal, keep most of the tangential speed (slide along).
  state.vx -= (1 + p.wallRestitution) * vn * nx;
  state.vz -= (1 + p.wallRestitution) * vn * nz;
  const tangentKeep = 1 - Math.min(0.35, impact * 0.025);
  const tx = -nz;
  const tz = nx;
  const vt = state.vx * tx + state.vz * tz;
  const vn2 = state.vx * nx + state.vz * nz;
  state.vx = tx * vt * tangentKeep + nx * vn2;
  state.vz = tz * vt * tangentKeep + nz * vn2;
  // Nudge heading toward the wall tangent so a glancing hit doesn't pin the nose.
  if (impact > 1.5) {
    const fx = Math.sin(state.heading);
    const fz = Math.cos(state.heading);
    const alongNormal = fx * nx + fz * nz;
    if (alongNormal < 0 && alongNormal > -0.92) {
      const side = fx * tx + fz * tz >= 0 ? 1 : -1;
      const targetHeading = Math.atan2(tx * side, tz * side);
      let diff = targetHeading - state.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      state.heading += diff * Math.min(0.35, impact * 0.03);
    }
  }
  return impact;
}

const grad = { x: 0, z: 0 };

/** Keep a kart inside the track's drivable area (SDF walls). */
export function collideKartWithTrack(state: KartState, track: Track, p: KartParams): number {
  let strongest = 0;
  for (let iter = 0; iter < 2; iter += 1) {
    let any = false;
    for (let ci = 0 as 0 | 1; ci <= 1; ci = (ci + 1) as 0 | 1) {
      const c = kartCircle(state, ci);
      const d = trackSdf(track, c.x, c.z);
      if (d >= KART_CIRCLE_RADIUS) continue;
      trackSdfGradient(track, c.x, c.z, grad);
      if (grad.x === 0 && grad.z === 0) continue;
      any = true;
      strongest = Math.max(strongest, respondToWall(state, grad.x, grad.z, KART_CIRCLE_RADIUS - d, p));
    }
    if (!any) break;
  }
  if (strongest > 0) onKartImpact(state, strongest);
  return strongest;
}

/** Kart-vs-kart: separate and exchange momentum. Boosting karts are heavier. */
export function collideKarts(a: KartState, b: KartState, p: KartParams): number {
  let strongest = 0;
  const massA = a.boostTime > 0 ? 2.2 : 1;
  const massB = b.boostTime > 0 ? 2.2 : 1;
  const invSum = 1 / (1 / massA + 1 / massB);
  for (let ia = 0 as 0 | 1; ia <= 1; ia = (ia + 1) as 0 | 1) {
    for (let ib = 0 as 0 | 1; ib <= 1; ib = (ib + 1) as 0 | 1) {
      const ca = kartCircle(a, ia);
      const cb = kartCircle(b, ib);
      if (!circleVsCircle(ca.x, ca.z, KART_CIRCLE_RADIUS, cb.x, cb.z, KART_CIRCLE_RADIUS, contact)) continue;
      const shareA = (1 / massA) * invSum;
      const shareB = (1 / massB) * invSum;
      a.x += contact.nx * contact.depth * shareA;
      a.z += contact.nz * contact.depth * shareA;
      b.x -= contact.nx * contact.depth * shareB;
      b.z -= contact.nz * contact.depth * shareB;
      const rvx = a.vx - b.vx;
      const rvz = a.vz - b.vz;
      const vn = rvx * contact.nx + rvz * contact.nz;
      if (vn >= 0) continue;
      // Minimum shove so even slow contact visibly pushes.
      const j = -(1 + p.kartRestitution) * vn * invSum + 1.2;
      a.vx += (j / massA) * contact.nx;
      a.vz += (j / massA) * contact.nz;
      b.vx -= (j / massB) * contact.nx;
      b.vz -= (j / massB) * contact.nz;
      strongest = Math.max(strongest, -vn);
    }
  }
  if (strongest > 0) {
    onKartImpact(a, strongest);
    onKartImpact(b, strongest);
  }
  return strongest;
}

/** Generic circle-vs-static test for projectiles. Returns the push-out normal/depth or null. */
export function circleVsStatic(x: number, z: number, r: number, col: StaticCollider): { nx: number; nz: number; depth: number } | null {
  const out: Contact = { nx: 0, nz: 0, depth: 0 };
  const hit = col.kind === 'box' ? circleVsBox(x, z, r, col, out) : circleVsCircle(x, z, r, col.x, col.z, col.r, out);
  return hit ? out : null;
}

/** Distance from a point to the nearest of a kart's two collision circles' centres. */
export function distanceToKart(state: KartState, x: number, z: number): number {
  const a = kartCircle(state, 0);
  const b = kartCircle(state, 1);
  return Math.min(Math.hypot(a.x - x, a.z - z), Math.hypot(b.x - x, b.z - z));
}
