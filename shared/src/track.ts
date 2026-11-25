/**
 * Track geometry shared by client and server.
 *
 * A track is a closed main centerline plus optional branches (shortcuts), each
 * a list of waypoints with a half-width and a height. Waypoints are smoothed
 * (Catmull-Rom) and sampled every ~1 m. From the samples we build:
 *  - a signed distance field (SDF) on a grid: > 0 inside the drivable area,
 *    < 0 outside. Karts collide against its zero contour, which gives smooth
 *    walls that exactly follow the track (racks, rails, mezzanine edges).
 *  - a height grid (ramps / mezzanine deck).
 *  - arc-length "s" for every sample (branch samples are mapped onto the main
 *    loop's s range) used for progress, checkpoints, ranking and respawn.
 */
import type { StaticCollider } from './collision';

export interface Waypoint {
  x: number;
  z: number;
  /** Half width of the drivable corridor (m). */
  hw: number;
  /** Floor height (m), default 0. */
  y?: number;
}

export interface RectZone {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TrackDef {
  name: string;
  /** Closed loop; waypoint 0 is the start/finish line. */
  main: Waypoint[];
  /** Open polylines whose ends lie inside the main corridor (shortcuts). */
  branches: Waypoint[][];
  /** Open drivable areas (e.g. loading dock), height 0. */
  zones: RectZone[];
  /** Solid obstacles inside the drivable area (pillars, pallet stacks). */
  obstacles: StaticCollider[];
  /** Building interior bounds (used for the grids). */
  bounds: RectZone;
  /** Rows of item crates across the track: nearest sample to (x, z), `count` crates. */
  itemRows: { x: number; z: number; count: number }[];
  laps: number;
  /** Number of checkpoint gates (including the finish line). */
  gates: number;
}

export interface TrackSample {
  x: number;
  z: number;
  y: number;
  hw: number;
  /** Unit tangent in driving direction. */
  tx: number;
  tz: number;
  /** Arc length on the main loop (branch samples: mapped). */
  s: number;
  /** -1 for the main loop, else branch index. */
  branch: number;
}

export interface Track {
  def: TrackDef;
  length: number;
  main: TrackSample[];
  branches: TrackSample[][];
  /** All samples (main then branches) for nearest-sample searches. */
  all: TrackSample[];
  gateS: number[];
  /** World positions of item crates. */
  itemSpots: { x: number; y: number; z: number }[];
  grid: {
    minX: number;
    minZ: number;
    cell: number;
    nx: number;
    nz: number;
    sdf: Float32Array;
    height: Float32Array;
  };
}

const SAMPLE_SPACING = 1;
const GRID_CELL = 0.5;
const SDF_FAR = -6;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Smooth + resample a waypoint list into ~1 m samples (without s/branch yet). */
function sampleWaypoints(wps: Waypoint[], closed: boolean): Omit<TrackSample, 's' | 'branch'>[] {
  const n = wps.length;
  const dense: { x: number; z: number; y: number; hw: number }[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i += 1) {
    const get = (k: number) => {
      if (closed) return wps[(k + n) % n];
      return wps[Math.max(0, Math.min(n - 1, k))];
    };
    const a = get(i - 1);
    const b = get(i);
    const c = get(i + 1);
    const d = get(i + 2);
    const len = Math.hypot(c.x - b.x, c.z - b.z);
    const steps = Math.max(4, Math.ceil(len / 0.25));
    for (let k = 0; k < steps; k += 1) {
      const t = k / steps;
      // Height and width interpolate with smoothstep so ramps ease in/out.
      const st = t * t * (3 - 2 * t);
      dense.push({
        x: catmull(a.x, b.x, c.x, d.x, t),
        z: catmull(a.z, b.z, c.z, d.z, t),
        y: (b.y ?? 0) + ((c.y ?? 0) - (b.y ?? 0)) * st,
        hw: b.hw + (c.hw - b.hw) * t,
      });
    }
  }
  if (!closed) {
    const last = wps[n - 1];
    dense.push({ x: last.x, z: last.z, y: last.y ?? 0, hw: last.hw });
  }
  // Resample at constant arc length.
  const out: Omit<TrackSample, 's' | 'branch'>[] = [];
  let acc = 0;
  out.push({ ...dense[0], tx: 0, tz: 1 });
  const total = closed ? dense.length : dense.length - 1;
  for (let i = 0; i < total; i += 1) {
    const p = dense[i];
    const q = dense[(i + 1) % dense.length];
    const seg = Math.hypot(q.x - p.x, q.z - p.z);
    acc += seg;
    while (acc >= SAMPLE_SPACING) {
      acc -= SAMPLE_SPACING;
      const t = seg > 0 ? 1 - acc / seg : 0;
      out.push({
        x: p.x + (q.x - p.x) * t,
        z: p.z + (q.z - p.z) * t,
        y: p.y + (q.y - p.y) * t,
        hw: p.hw + (q.hw - p.hw) * t,
        tx: 0,
        tz: 1,
      });
    }
  }
  if (closed) {
    // Drop a final sample that nearly duplicates the first.
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.z - l.z) < SAMPLE_SPACING * 0.5) out.pop();
  }
  for (let i = 0; i < out.length; i += 1) {
    const prev = closed ? out[(i - 1 + out.length) % out.length] : out[Math.max(0, i - 1)];
    const next = closed ? out[(i + 1) % out.length] : out[Math.min(out.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    out[i].tx = dx / len;
    out[i].tz = dz / len;
  }
  return out;
}

function nearestMainS(main: TrackSample[], x: number, z: number): number {
  let best = Infinity;
  let s = 0;
  for (const m of main) {
    const d = (m.x - x) ** 2 + (m.z - z) ** 2;
    if (d < best) {
      best = d;
      s = m.s;
    }
  }
  return s;
}

export function buildTrack(def: TrackDef): Track {
  const mainRaw = sampleWaypoints(def.main, true);
  const main: TrackSample[] = mainRaw.map((p, i) => ({ ...p, s: i * SAMPLE_SPACING, branch: -1 }));
  const length = main.length * SAMPLE_SPACING;

  const branches: TrackSample[][] = def.branches.map((wps, bi) => {
    const raw = sampleWaypoints(wps, false);
    const s0 = nearestMainS(main, raw[0].x, raw[0].z);
    let s1 = nearestMainS(main, raw[raw.length - 1].x, raw[raw.length - 1].z);
    if (s1 < s0) s1 += length;
    return raw.map((p, i) => {
      let s = s0 + ((s1 - s0) * i) / Math.max(1, raw.length - 1);
      if (s >= length) s -= length;
      return { ...p, s, branch: bi };
    });
  });

  const gateS: number[] = [];
  for (let g = 0; g < def.gates; g += 1) gateS.push((length * g) / def.gates);

  // --- SDF + height grid ------------------------------------------------------
  const b = def.bounds;
  const nx = Math.ceil((b.maxX - b.minX) / GRID_CELL) + 1;
  const nz = Math.ceil((b.maxZ - b.minZ) / GRID_CELL) + 1;
  const sdf = new Float32Array(nx * nz).fill(SDF_FAR);
  const height = new Float32Array(nx * nz);

  const stamp = (samples: TrackSample[], closed: boolean) => {
    const segs = closed ? samples.length : samples.length - 1;
    for (let i = 0; i < segs; i += 1) {
      const p = samples[i];
      const q = samples[(i + 1) % samples.length];
      const reach = Math.max(p.hw, q.hw) - SDF_FAR + 1;
      const x0 = Math.max(0, Math.floor((Math.min(p.x, q.x) - reach - b.minX) / GRID_CELL));
      const x1 = Math.min(nx - 1, Math.ceil((Math.max(p.x, q.x) + reach - b.minX) / GRID_CELL));
      const z0 = Math.max(0, Math.floor((Math.min(p.z, q.z) - reach - b.minZ) / GRID_CELL));
      const z1 = Math.min(nz - 1, Math.ceil((Math.max(p.z, q.z) + reach - b.minZ) / GRID_CELL));
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const segLenSq = dx * dx + dz * dz || 1e-9;
      for (let gz = z0; gz <= z1; gz += 1) {
        const wz = b.minZ + gz * GRID_CELL;
        for (let gx = x0; gx <= x1; gx += 1) {
          const wx = b.minX + gx * GRID_CELL;
          let t = ((wx - p.x) * dx + (wz - p.z) * dz) / segLenSq;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = p.x + dx * t;
          const cz = p.z + dz * t;
          const dist = Math.hypot(wx - cx, wz - cz);
          const value = p.hw + (q.hw - p.hw) * t - dist;
          const idx = gz * nx + gx;
          if (value > sdf[idx]) {
            sdf[idx] = value;
            height[idx] = p.y + (q.y - p.y) * t;
          }
        }
      }
    }
  };
  stamp(main, true);
  branches.forEach((br) => stamp(br, false));

  for (const zone of def.zones) {
    for (let gz = 0; gz < nz; gz += 1) {
      const wz = b.minZ + gz * GRID_CELL;
      for (let gx = 0; gx < nx; gx += 1) {
        const wx = b.minX + gx * GRID_CELL;
        const ix = Math.min(wx - zone.minX, zone.maxX - wx);
        const iz = Math.min(wz - zone.minZ, zone.maxZ - wz);
        let value: number;
        if (ix >= 0 && iz >= 0) value = Math.min(ix, iz);
        else value = -Math.hypot(Math.min(0, ix), Math.min(0, iz));
        const idx = gz * nx + gx;
        if (value > sdf[idx]) {
          sdf[idx] = value;
          height[idx] = 0;
        }
      }
    }
  }

  const all = [...main, ...branches.flat()];
  const itemSpots: { x: number; y: number; z: number }[] = [];
  for (const row of def.itemRows) {
    let best = all[0];
    let bd = Infinity;
    for (const smp of all) {
      const d = (smp.x - row.x) ** 2 + (smp.z - row.z) ** 2;
      if (d < bd) {
        bd = d;
        best = smp;
      }
    }
    const span = row.count > 1 ? best.hw * 1.3 : 0;
    for (let i = 0; i < row.count; i += 1) {
      const off = row.count > 1 ? -span / 2 + (span * i) / (row.count - 1) : 0;
      itemSpots.push({ x: best.x - best.tz * off, y: best.y, z: best.z + best.tx * off });
    }
  }

  return {
    def,
    length,
    main,
    branches,
    all,
    gateS,
    itemSpots,
    grid: { minX: b.minX, minZ: b.minZ, cell: GRID_CELL, nx, nz, sdf, height },
  };
}

function bilinear(track: Track, field: Float32Array, x: number, z: number, outside: number): number {
  const g = track.grid;
  const fx = (x - g.minX) / g.cell;
  const fz = (z - g.minZ) / g.cell;
  if (fx < 0 || fz < 0 || fx >= g.nx - 1 || fz >= g.nz - 1) return outside;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const i = iz * g.nx + ix;
  const a = field[i];
  const b = field[i + 1];
  const c = field[i + g.nx];
  const d = field[i + g.nx + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** Signed distance to the drivable boundary (> 0 inside). */
export function trackSdf(track: Track, x: number, z: number): number {
  return bilinear(track, track.grid.sdf, x, z, SDF_FAR);
}

export function trackHeight(track: Track, x: number, z: number): number {
  return bilinear(track, track.grid.height, x, z, 0);
}

/** Unit gradient of the SDF (points toward the inside of the track). */
export function trackSdfGradient(track: Track, x: number, z: number, out: { x: number; z: number }): void {
  const e = 0.3;
  const gx = trackSdf(track, x + e, z) - trackSdf(track, x - e, z);
  const gz = trackSdf(track, x, z + e) - trackSdf(track, x, z - e);
  const len = Math.hypot(gx, gz);
  if (len < 1e-6) {
    out.x = 0;
    out.z = 0;
  } else {
    out.x = gx / len;
    out.z = gz / len;
  }
}

/** Main-loop sample at (approximately) arc length s, wrapping. */
export function sampleAtS(track: Track, s: number): TrackSample {
  const L = track.length;
  let w = s % L;
  if (w < 0) w += L;
  return track.main[Math.min(track.main.length - 1, Math.round(w / SAMPLE_SPACING) % track.main.length)];
}

/** Start grid: 2 columns, staggered, behind the finish line. */
export function gridSlot(track: Track, slot: number): { x: number; z: number; heading: number } {
  const row = Math.floor(slot / 2);
  const col = slot % 2 === 0 ? -1 : 1;
  const s = track.length - 5 - row * 5 - (col > 0 ? 2.5 : 0);
  const p = sampleAtS(track, s);
  // Right vector = (-tz, tx) in this project's convention (see kart.ts).
  const lateral = 2.1 * col;
  return {
    x: p.x - p.tz * lateral,
    z: p.z + p.tx * lateral,
    heading: Math.atan2(p.tx, p.tz),
  };
}
