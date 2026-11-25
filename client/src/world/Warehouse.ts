import * as THREE from 'three';
import { trackSdf, type Track, type TrackSample } from '@shared/track';
import { createWallLogoTexture } from './logoTexture';
import { RACK, RackKit } from './RackKit';
import {
  bannerTexture,
  checkerTexture,
  chevronTexture,
  claddingTexture,
  concreteTexture,
  diamondPlateTexture,
  dockNumberTexture,
  doorTexture,
  hazardTexture,
  signTexture,
} from './textures';

/**
 * Builds the whole warehouse scene around a Track. Collision lives in the
 * shared SDF; everything here is visual, but placed from the same data so the
 * walls you see are where the walls are.
 */

const WALL = { minX: -69.4, maxX: 69.4, minZ: -44, maxZ: 44, height: 12 };
const DOOR_XS = [-36, -21, -6, 9, 24, 39, 54];
const OPEN_DOORS = new Set([1, 4]);

interface Quad {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  d: THREE.Vector3;
}

/** Geometry from quads (a,b,c,d counter-clockwise seen from the front). */
function quadsGeometry(quads: Quad[], uvScale = 1): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  for (const q of quads) {
    pos.push(q.a.x, q.a.y, q.a.z, q.b.x, q.b.y, q.b.z, q.c.x, q.c.y, q.c.z);
    pos.push(q.a.x, q.a.y, q.a.z, q.c.x, q.c.y, q.c.z, q.d.x, q.d.y, q.d.z);
    const w = q.a.distanceTo(q.b) * uvScale;
    const h = q.b.distanceTo(q.c) * uvScale;
    uv.push(0, 0, w, 0, w, h, 0, 0, w, h, 0, h);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function right(s: TrackSample): THREE.Vector2 {
  return new THREE.Vector2(-s.tz, s.tx);
}

class Instancer {
  private readonly list: THREE.Matrix4[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly e = new THREE.Euler();
  constructor(
    private readonly geo: THREE.BufferGeometry,
    private readonly mat: THREE.Material,
    private readonly shadow = true,
  ) {}
  add(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rotY = 0, rotX = 0): void {
    this.e.set(rotX, rotY, 0, 'YXZ');
    this.q.setFromEuler(this.e);
    this.m.compose(this.v.set(x, y, z), this.q, this.s.set(sx, sy, sz));
    this.list.push(this.m.clone());
  }
  build(): THREE.InstancedMesh | null {
    if (!this.list.length) return null;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, this.list.length);
    this.list.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = this.shadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

export interface WarehouseScene {
  group: THREE.Group;
  /** Emissive ceiling fixtures (toggle intensity for quality presets). */
  fixtures: THREE.InstancedMesh | null;
}

export function buildWarehouse(track: Track): WarehouseScene {
  const group = new THREE.Group();
  group.name = 'warehouse';
  const add = (o: THREE.Object3D | null) => {
    if (o) group.add(o);
  };

  const yellow = new THREE.MeshStandardMaterial({ color: '#f2c230', roughness: 0.55 });
  const steelGrey = new THREE.MeshStandardMaterial({ color: '#5d646c', roughness: 0.5, metalness: 0.6 });
  const blue = new THREE.MeshStandardMaterial({ color: '#1f5fbf', roughness: 0.45, metalness: 0.55 });
  const orange = new THREE.MeshStandardMaterial({ color: '#f07a12', roughness: 0.42, metalness: 0.45 });
  const hazard = new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.6 });

  // --- Floor --------------------------------------------------------------
  const b = track.def.bounds;
  const floorTex = concreteTexture();
  floorTex.repeat.set((b.maxX - b.minX) / 8, (b.maxZ - b.minZ) / 8);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.75, metalness: 0.05 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  floor.receiveShadow = true;
  add(floor);

  buildShell(group, steelGrey);
  const fixtures = buildCeiling(group);

  // --- Racking fills everything that is not track ----------------------------
  const occupancy = buildRacking(group, track);

  // --- Mezzanine deck + ramps --------------------------------------------------
  buildMezzanine(group, track, blue, orange);

  // --- Rails where the track edge isn't backed by racking ---------------------
  buildRails(group, track, occupancy, yellow, hazard);

  // --- Floor paint -------------------------------------------------------------
  buildFloorLines(group, track);
  buildStartLine(group, track, steelGrey);

  // --- Signage -----------------------------------------------------------------
  buildSigns(group, track, steelGrey);
  buildChevrons(group, track);

  // --- Loading dock -------------------------------------------------------------
  buildDocks(group, hazard, yellow);

  // --- Obstacles from the track definition ---------------------------------------
  buildObstacles(group, track, yellow);

  return { group, fixtures };
}

function buildShell(group: THREE.Group, steel: THREE.Material): void {
  const clad = claddingTexture();
  const wallMat = new THREE.MeshStandardMaterial({ map: clad, roughness: 0.7, metalness: 0.2 });
  const bandMat = new THREE.MeshStandardMaterial({ color: '#163f86', roughness: 0.6 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: '#f07a12', roughness: 0.6 });
  const w = WALL;
  const walls: [number, number, number, number][] = [
    [(w.minX + w.maxX) / 2, w.minZ - 0.25, w.maxX - w.minX + 1, 0.5],
    [(w.minX + w.maxX) / 2, w.maxZ + 0.25, w.maxX - w.minX + 1, 0.5],
    [w.minX - 0.25, 0, 0.5, w.maxZ - w.minZ],
    [w.maxX + 0.25, 0, 0.5, w.maxZ - w.minZ],
  ];
  for (const [x, z, sx, sz] of walls) {
    const tex = clad.clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(sx, sz) / 2, w.height / 8);
    const mat = wallMat.clone();
    mat.map = tex;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, w.height, sz), mat);
    wall.position.set(x, w.height / 2, z);
    wall.receiveShadow = true;
    group.add(wall);
    const band = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.02, 1.4, sz + 0.02), bandMat);
    band.position.set(x, 0.7, z);
    group.add(band);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.03, 0.18, sz + 0.03), stripeMat);
    stripe.position.set(x, 1.5, z);
    group.add(stripe);
  }
  // Steel building columns along the walls.
  const col = new Instancer(new THREE.BoxGeometry(0.45, w.height, 0.45), steel, false);
  for (let x = -60; x <= 60; x += 12) {
    col.add(x, w.height / 2, w.minZ + 0.25);
    if (!DOOR_XS.some((dx) => Math.abs(dx - x) < 3)) col.add(x, w.height / 2, w.maxZ - 0.25);
  }
  for (let z = -36; z <= 36; z += 12) {
    col.add(w.minX + 0.25, w.height / 2, z);
    col.add(w.maxX - 0.25, w.height / 2, z);
  }
  const m = col.build();
  if (m) group.add(m);
}

function buildCeiling(group: THREE.Group): THREE.InstancedMesh | null {
  const w = WALL;
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(w.maxX - w.minX, w.maxZ - w.minZ),
    new THREE.MeshStandardMaterial({ color: '#3a4048', roughness: 0.9 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, w.height, 0);
  group.add(ceiling);

  const trussMat = new THREE.MeshStandardMaterial({ color: '#4c535c', roughness: 0.6, metalness: 0.5 });
  const truss = new Instancer(new THREE.BoxGeometry(0.25, 0.6, w.maxZ - w.minZ), trussMat, false);
  for (let x = -66; x <= 66; x += 6) truss.add(x, w.height - 0.6, 0);
  const t = truss.build();
  if (t) group.add(t);
  const purlin = new Instancer(new THREE.BoxGeometry(w.maxX - w.minX, 0.15, 0.15), trussMat, false);
  for (let z = -40; z <= 40; z += 4) purlin.add(0, w.height - 0.25, z);
  const p = purlin.build();
  if (p) group.add(p);

  // High-bay LED fixtures (emissive; lighting itself is the hemisphere + key light).
  const fixtureMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    emissive: '#f4f8ff',
    emissiveIntensity: 2.4,
    roughness: 0.4,
  });
  const fix = new Instancer(new THREE.BoxGeometry(0.35, 0.08, 2.6), fixtureMat, false);
  for (let x = -63; x <= 63; x += 6) for (let z = -38; z <= 38; z += 6.5) fix.add(x, w.height - 1.4, z);
  const f = fix.build();
  if (f) group.add(f);
  // Hangers.
  const hanger = new Instancer(new THREE.BoxGeometry(0.02, 0.8, 0.02), trussMat, false);
  for (let x = -63; x <= 63; x += 6) for (let z = -38; z <= 38; z += 6.5) {
    hanger.add(x, w.height - 1.0, z - 1.1);
    hanger.add(x, w.height - 1.0, z + 1.1);
  }
  const h = hanger.build();
  if (h) group.add(h);
  return f;
}

/** Rows of back-to-back racking everywhere the SDF says "not track". */
function buildRacking(group: THREE.Group, track: Track): Uint8Array {
  const g = track.grid;
  const occupancy = new Uint8Array(g.nx * g.nz);
  const kit = new RackKit();
  const margin = 0.45;
  const pairPeriod = 5.6;
  const halfDepth = RACK.depth / 2;
  const fits = (cx: number, cz: number) => {
    for (const ox of [-1.35, -0.67, 0, 0.67, 1.35]) {
      for (const oz of [-halfDepth, 0, halfDepth]) {
        if (trackSdf(track, cx + ox, cz + oz) > -margin) return false;
      }
    }
    return cx - 1.35 > WALL.minX + 1.2 && cx + 1.35 < WALL.maxX - 1.2 && cz - halfDepth > WALL.minZ + 1.0 && cz + halfDepth < WALL.maxZ - 3;
  };
  const mark = (cx: number, cz: number, hx: number, hz: number) => {
    const x0 = Math.floor((cx - hx - g.minX) / g.cell);
    const x1 = Math.ceil((cx + hx - g.minX) / g.cell);
    const z0 = Math.floor((cz - hz - g.minZ) / g.cell);
    const z1 = Math.ceil((cz + hz - g.minZ) / g.cell);
    for (let z = Math.max(0, z0); z <= Math.min(g.nz - 1, z1); z += 1)
      for (let x = Math.max(0, x0); x <= Math.min(g.nx - 1, x1); x += 1) occupancy[z * g.nx + x] = 1;
  };
  for (let pz = WALL.minZ + 2.4; pz < WALL.maxZ; pz += pairPeriod) {
    for (const rowZ of [pz - 0.62, pz + 0.62]) {
      let runStart = -1;
      let runLen = 0;
      const flush = () => {
        if (runLen > 0) {
          const startX = -68 + runStart * RACK.bayWidth;
          const centerX = startX + (runLen * RACK.bayWidth) / 2;
          kit.addRow(centerX, rowZ, runLen);
          mark(centerX, rowZ, (runLen * RACK.bayWidth) / 2, halfDepth);
        }
        runStart = -1;
        runLen = 0;
      };
      for (let i = 0; ; i += 1) {
        const cx = -68 + (i + 0.5) * RACK.bayWidth;
        if (cx > 68) break;
        if (fits(cx, rowZ)) {
          if (runStart < 0) runStart = i;
          runLen += 1;
        } else flush();
      }
      flush();
    }
  }
  // Nothing is placed under the mezzanine deck / ramps: stacks there poked through the ramp.
  group.add(kit.build());
  return occupancy;
}

function elevatedRanges(track: Track): [number, number][] {
  const main = track.main;
  const ranges: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < main.length; i += 1) {
    const up = main[i].y > 0.01;
    if (up && start < 0) start = i;
    if (!up && start >= 0) {
      ranges.push([Math.max(0, start - 1), i]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start - 1, main.length - 1]);
  return ranges;
}

function buildMezzanine(group: THREE.Group, track: Track, blue: THREE.Material, orange: THREE.Material): void {
  const plate = diamondPlateTexture();
  plate.repeat.set(1, 1);
  const topMat = new THREE.MeshStandardMaterial({ map: plate, roughness: 0.45, metalness: 0.7 });
  const sideMat = new THREE.MeshStandardMaterial({ color: '#4a5058', roughness: 0.6, metalness: 0.5 });
  const kick = new THREE.MeshStandardMaterial({ color: '#f2c230', roughness: 0.5 });
  const columns = new Instancer(new THREE.BoxGeometry(0.22, 1, 0.22), blue);
  const beams = new Instancer(new THREE.BoxGeometry(1, 0.3, 0.16), orange);

  for (const [i0, i1] of elevatedRanges(track)) {
    const tops: Quad[] = [];
    const sides: Quad[] = [];
    const kicks: Quad[] = [];
    for (let i = i0; i < i1; i += 1) {
      const p = track.main[i];
      const q = track.main[i + 1];
      const rp = right(p);
      const rq = right(q);
      const wp = p.hw + 0.2;
      const wq = q.hw + 0.2;
      const yp = p.y + 0.03;
      const yq = q.y + 0.03;
      const pl = new THREE.Vector3(p.x - rp.x * wp, yp, p.z - rp.y * wp);
      const pr = new THREE.Vector3(p.x + rp.x * wp, yp, p.z + rp.y * wp);
      const ql = new THREE.Vector3(q.x - rq.x * wq, yq, q.z - rq.y * wq);
      const qr = new THREE.Vector3(q.x + rq.x * wq, yq, q.z + rq.y * wq);
      tops.push({ a: pl, b: pr, c: qr, d: ql });
      // Sides: solid ramp skirts down to the floor; the deck is a 0.4 m slab.
      const deck = p.y > 3.9 && q.y > 3.9;
      const bp = deck ? yp - 0.4 : 0;
      const bq = deck ? yq - 0.4 : 0;
      const edges: [THREE.Vector3, THREE.Vector3, number, number][] = [
        [pr, qr, bp, bq],
        [ql, pl, bq, bp],
      ];
      for (const [a, c, ya, yc] of edges) {
        sides.push({ a: a.clone().setY(ya), b: c.clone().setY(yc), c: c.clone(), d: a.clone() });
        kicks.push({ a: a.clone(), b: c.clone(), c: c.clone().setY(c.y + 0.15), d: a.clone().setY(a.y + 0.15) });
      }
      if (deck) {
        sides.push({ a: ql.clone().setY(bq), b: qr.clone().setY(bq), c: pr.clone().setY(bp), d: pl.clone().setY(bp) });
        if (i % 4 === 0) {
          for (const side of [-1, 1]) {
            const cx = p.x + rp.x * (p.hw - 0.1) * side;
            const cz = p.z + rp.y * (p.hw - 0.1) * side;
            columns.add(cx, (p.y - 0.4) / 2, cz, 1, p.y - 0.4, 1);
          }
          beams.add(p.x, p.y - 0.55, p.z, (p.hw + 0.2) * 2, 1, 1, Math.atan2(rp.x, rp.y) + Math.PI / 2);
        }
      }
    }
    const topGeo = quadsGeometry(tops, 0.5);
    const topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.receiveShadow = true;
    group.add(topMesh);
    const sideGeo = quadsGeometry(sides);
    const sideMesh = new THREE.Mesh(sideGeo, sideMat);
    sideMat.side = THREE.DoubleSide;
    sideMesh.castShadow = true;
    sideMesh.receiveShadow = true;
    group.add(sideMesh);
    kick.side = THREE.DoubleSide;
    group.add(new THREE.Mesh(quadsGeometry(kicks), kick));
  }
  const c = columns.build();
  if (c) group.add(c);
  const bm = beams.build();
  if (bm) group.add(bm);
}

function isRack(track: Track, occ: Uint8Array, x: number, z: number): boolean {
  const g = track.grid;
  const ix = Math.round((x - g.minX) / g.cell);
  const iz = Math.round((z - g.minZ) / g.cell);
  if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return true;
  return occ[iz * g.nx + ix] === 1;
}

function buildRails(group: THREE.Group, track: Track, occ: Uint8Array, yellow: THREE.Material, hazardMat: THREE.Material): void {
  const postGeo = new THREE.BoxGeometry(0.1, 1, 0.1);
  const railGeo = new THREE.BoxGeometry(0.08, 0.12, 1);
  const posts = new Instancer(postGeo, yellow);
  const rails = new Instancer(railGeo, hazardMat);
  const handrails = new Instancer(railGeo, yellow);
  const lists: { samples: TrackSample[]; closed: boolean }[] = [
    { samples: track.main, closed: true },
    ...track.branches.map((s) => ({ samples: s, closed: false })),
  ];
  for (const { samples, closed } of lists) {
    for (const side of [-1, 1]) {
      let prev: { x: number; z: number; y: number; ok: boolean } | null = null;
      const n = closed ? samples.length + 1 : samples.length;
      for (let k = 0; k < n; k += 1) {
        const s = samples[k % samples.length];
        const r = right(s);
        const off = s.hw + 0.3;
        const x = s.x + r.x * off * side;
        const z = s.z + r.y * off * side;
        const elevated = s.y > 0.3;
        const boundary = trackSdf(track, x, z) < -0.05;
        const backed = isRack(track, occ, x + r.x * side * 0.9, z + r.y * side * 0.9) || isRack(track, occ, x, z);
        const ok = boundary && (elevated || !backed);
        if (ok && k % 2 === 0) posts.add(x, s.y + (elevated ? 0.55 : 0.35), z, 1, elevated ? 1.1 : 0.7, 1);
        if (ok && prev?.ok) {
          const dx = x - prev.x;
          const dz = z - prev.z;
          const len = Math.hypot(dx, dz);
          if (len < 2) {
            const yaw = Math.atan2(dx, dz);
            const my = (s.y + prev.y) / 2;
            const pitch = -Math.atan2(s.y - prev.y, len);
            if (elevated || prev.y > 0.3) {
              handrails.add((x + prev.x) / 2, my + 1.1, (z + prev.z) / 2, 1, 1, len + 0.05, yaw, pitch);
              handrails.add((x + prev.x) / 2, my + 0.6, (z + prev.z) / 2, 1, 1, len + 0.05, yaw, pitch);
            } else {
              rails.add((x + prev.x) / 2, 0.62, (z + prev.z) / 2, 1, 1.6, len + 0.05, yaw);
              rails.add((x + prev.x) / 2, 0.3, (z + prev.z) / 2, 1, 1.6, len + 0.05, yaw);
            }
          }
        }
        prev = { x, z, y: s.y, ok };
      }
    }
  }
  for (const inst of [posts, rails, handrails]) {
    const m = inst.build();
    if (m) group.add(m);
  }
}

function buildFloorLines(group: THREE.Group, track: Track): void {
  const quads: Quad[] = [];
  const lists: { samples: TrackSample[]; closed: boolean }[] = [
    { samples: track.main, closed: true },
    ...track.branches.map((s) => ({ samples: s, closed: false })),
  ];
  const lineW = 0.12;
  for (const { samples, closed } of lists) {
    for (const side of [-1, 1]) {
      const n = closed ? samples.length : samples.length - 1;
      for (let k = 0; k < n; k += 1) {
        const p = samples[k];
        const q = samples[(k + 1) % samples.length];
        const rp = right(p);
        const rq = right(q);
        const check = (s: TrackSample, r: THREE.Vector2) =>
          trackSdf(track, s.x + r.x * (s.hw + 0.25) * side, s.z + r.y * (s.hw + 0.25) * side) < 0;
        if (!check(p, rp) || !check(q, rq)) continue;
        const o1 = p.hw - 0.35;
        const o2 = q.hw - 0.35;
        const y1 = p.y + 0.045;
        const y2 = q.y + 0.045;
        const pIn = new THREE.Vector3(p.x + rp.x * (o1 - lineW) * side, y1, p.z + rp.y * (o1 - lineW) * side);
        const pOut = new THREE.Vector3(p.x + rp.x * (o1 + lineW) * side, y1, p.z + rp.y * (o1 + lineW) * side);
        const qIn = new THREE.Vector3(q.x + rq.x * (o2 - lineW) * side, y2, q.z + rq.y * (o2 - lineW) * side);
        const qOut = new THREE.Vector3(q.x + rq.x * (o2 + lineW) * side, y2, q.z + rq.y * (o2 + lineW) * side);
        quads.push(side > 0 ? { a: pIn, b: pOut, c: qOut, d: qIn } : { a: pOut, b: pIn, c: qIn, d: qOut });
      }
    }
  }
  // Dock zone outline (south edge, along the doors).
  for (const zone of track.def.zones) {
    for (let x = zone.minX; x < zone.maxX; x += 1) {
      const z = zone.maxZ - 0.35;
      if (trackSdf(track, x + 0.5, zone.maxZ + 0.3) >= 0) continue;
      quads.push({
        a: new THREE.Vector3(x, 0.012, z + lineW),
        b: new THREE.Vector3(x + 1, 0.012, z + lineW),
        c: new THREE.Vector3(x + 1, 0.012, z - lineW),
        d: new THREE.Vector3(x, 0.012, z - lineW),
      });
    }
  }
  const geo = quadsGeometry(quads);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: '#f2c230',
      roughness: 0.6,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  mesh.receiveShadow = true;
  group.add(mesh);
}

function buildStartLine(group: THREE.Group, track: Track, steel: THREE.Material): void {
  const s = track.main[0];
  const yaw = Math.atan2(s.tx, s.tz);
  const tex = checkerTexture();
  tex.repeat.set((s.hw * 2) / 2, 1);
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(s.hw * 2, 1.2),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  line.rotation.set(-Math.PI / 2, 0, yaw);
  line.position.set(s.x, 0.02, s.z);
  line.receiveShadow = true;
  group.add(line);

  // Gantry with banner.
  const r = right(s);
  const gantry = new THREE.Group();
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6.2, 0.3), steel);
    post.position.set(s.x + r.x * (s.hw + 0.2) * side, 3.1, s.z + r.y * (s.hw + 0.2) * side);
    post.castShadow = true;
    gantry.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(s.hw * 2 + 0.7, 0.35, 0.35), steel);
  beam.position.set(s.x, 6.1, s.z);
  beam.rotation.y = yaw + Math.PI / 2;
  gantry.add(beam);
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(s.hw * 2, 1.1),
    new THREE.MeshStandardMaterial({ map: bannerTexture('MSF SUPPLY KART'), roughness: 0.6, side: THREE.DoubleSide }),
  );
  banner.position.set(s.x, 5.3, s.z);
  banner.rotation.y = yaw + Math.PI;
  gantry.add(banner);
  // Start lights (used by the countdown in step 4).
  const lightMat = new THREE.MeshStandardMaterial({ color: '#330606', emissive: '#ff1a1a', emissiveIntensity: 0.15 });
  for (let i = 0; i < 3; i += 1) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 16), lightMat.clone());
    lamp.rotation.x = Math.PI / 2;
    lamp.rotation.z = yaw;
    const off = (i - 1) * 0.6;
    lamp.position.set(s.x + r.x * off, 6.1, s.z + r.y * off);
    lamp.lookAt(s.x - s.tx * 10, 6.1, s.z - s.tz * 10);
    lamp.rotateX(Math.PI / 2);
    lamp.name = `start-light-${i}`;
    gantry.add(lamp);
  }
  gantry.name = 'start-gantry';
  group.add(gantry);
}

function nearestMain(track: Track, x: number, z: number): TrackSample {
  let best = track.main[0];
  let bd = Infinity;
  for (const s of track.main) {
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

function buildSigns(group: THREE.Group, track: Track, steel: THREE.Material): void {
  const signs: [number, number, string, string][] = [
    [26, -32, 'ALLÉE A', 'DÉPART · ARRIVÉE'],
    [32, -16, 'ALLÉE B', 'RAYONNAGES B01–B24'],
    [26, 0, 'ALLÉE C', 'RAYONNAGES C01–C24'],
    [24, 33, 'QUAIS', 'EXPÉDITION · Q1–Q7'],
    [-58, 22, 'MEZZANINE', 'RAMPE ↑ 4 M'],
  ];
  for (const [x, z, label, sub] of signs) {
    const s = nearestMain(track, x, z);
    const yaw = Math.atan2(s.tx, s.tz);
    const y = s.y + 7;
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 1.3),
      new THREE.MeshStandardMaterial({ map: signTexture(label, sub), roughness: 0.5, side: THREE.DoubleSide }),
    );
    board.position.set(s.x, y, s.z);
    board.rotation.y = yaw + Math.PI;
    group.add(board);
    for (const off of [-1.6, 1.6]) {
      const r = right(s);
      const wire = new THREE.Mesh(new THREE.BoxGeometry(0.02, WALL.height - y, 0.02), steel);
      wire.position.set(s.x + r.x * off, (WALL.height + y) / 2, s.z + r.y * off);
      group.add(wire);
    }
  }
  // Small "Q<n>" plates are on the doors (buildDocks).
}

function buildChevrons(group: THREE.Group, track: Track): void {
  const main = track.main;
  const n = main.length;
  const mat = new THREE.MeshStandardMaterial({ map: chevronTexture(), roughness: 0.5, side: THREE.DoubleSide });
  const postMat = new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.6 });
  const turn = (i: number) => {
    const a = main[(i - 4 + n) % n];
    const c = main[(i + 4) % n];
    const cross = a.tx * c.tz - a.tz * c.tx;
    const dot = a.tx * c.tx + a.tz * c.tz;
    return Math.atan2(cross, dot);
  };
  const placed: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = turn(i);
    if (Math.abs(t) < 0.75) continue;
    let isMax = true;
    for (let k = -8; k <= 8; k += 1) if (Math.abs(turn((i + k + n) % n)) > Math.abs(t)) isMax = false;
    if (!isMax || placed.some((p) => Math.abs(p - i) < 15)) continue;
    placed.push(i);
    const s = main[i];
    // Outside of the turn: if turning left (t > 0 means heading increases => left), outside is right.
    const outside = t > 0 ? 1 : -1;
    const r = right(s);
    const off = s.hw + 0.5;
    const x = s.x + r.x * off * outside;
    const z = s.z + r.y * off * outside;
    // Face the approaching driver.
    const a = main[(i - 10 + n) % n];
    const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), mat.clone());
    if (outside < 0) {
      // Mirror so the arrows point into the turn.
      const tex = (board.material as THREE.MeshStandardMaterial).map!.clone();
      tex.needsUpdate = true;
      tex.repeat.x = -1;
      tex.offset.x = 1;
      tex.wrapS = THREE.RepeatWrapping;
      (board.material as THREE.MeshStandardMaterial).map = tex;
    }
    board.position.set(x, s.y + 1.3, z);
    board.lookAt(x - a.tx * 10, s.y + 1.3, z - a.tz * 10);
    group.add(board);
    for (const side of [-1.5, 1.5]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.3, 0.08), postMat);
      const lx = new THREE.Vector3(side, 0, 0).applyQuaternion(board.quaternion);
      post.position.set(x + lx.x, s.y + 0.65, z + lx.z);
      group.add(post);
    }
  }
}

function buildDocks(group: THREE.Group, hazardMat: THREE.Material, yellow: THREE.Material): void {
  const z = WALL.maxZ;
  const doorTex = doorTexture();
  const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.5, metalness: 0.3 });
  const frameMat = new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.6 });
  const bumperMat = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.9 });
  const outsideMat = new THREE.MeshBasicMaterial({ color: '#dfeaf5' });
  const trailerMat = new THREE.MeshStandardMaterial({ color: '#f1f2f3', roughness: 0.5 });
  const greenLight = new THREE.MeshStandardMaterial({ color: '#0b3', emissive: '#1f6', emissiveIntensity: 2 });
  const redLight = new THREE.MeshStandardMaterial({ color: '#600', emissive: '#f22', emissiveIntensity: 2 });
  const W = 3.6;
  const H = 4.2;
  DOOR_XS.forEach((x, i) => {
    const open = OPEN_DOORS.has(i);
    // Recess / frame.
    for (const side of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.25, H + 0.3, 0.3), hazardMat);
      jamb.position.set(x + side * (W / 2 + 0.12), (H + 0.3) / 2, z - 0.1);
      group.add(jamb);
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 0.35), bumperMat);
      bumper.position.set(x + side * (W / 2 - 0.3), 0.6, z - 0.3);
      group.add(bumper);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(W + 0.5, 0.3, 0.35), frameMat);
    head.position.set(x, H + 0.15, z - 0.1);
    group.add(head);
    const panelH = open ? 1.1 : H;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(W, panelH, 0.08), doorMat);
    panel.position.set(x, H - panelH / 2, z - 0.02);
    group.add(panel);
    if (open) {
      const outside = new THREE.Mesh(new THREE.PlaneGeometry(W, H - panelH), outsideMat);
      outside.position.set(x, (H - panelH) / 2, z + 0.4);
      outside.rotation.y = Math.PI;
      group.add(outside);
      const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.8, 0.2), trailerMat);
      trailer.position.set(x, 1.6, z + 0.35);
      group.add(trailer);
    }
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), new THREE.MeshStandardMaterial({ map: dockNumberTexture(i + 1) }));
    plate.position.set(x, H + 0.65, z - 0.05);
    plate.rotation.y = Math.PI;
    group.add(plate);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), open ? greenLight : redLight);
    lamp.position.set(x + W / 2 + 0.55, 2.4, z - 0.15);
    group.add(lamp);
    // Dock leveller plate on the floor.
    const leveller = new THREE.Mesh(new THREE.BoxGeometry(W - 0.4, 0.04, 1.4), new THREE.MeshStandardMaterial({ map: diamondPlateTexture(), metalness: 0.7, roughness: 0.45 }));
    leveller.position.set(x, 0.02, z - 0.8);
    group.add(leveller);
  });

  // MSF Supply logo banner on the wall above the dock doors (in front of the wall columns).
  const logoW = 20;
  const logoH = 4.4;
  const logoX = (DOOR_XS[0] + DOOR_XS[DOOR_XS.length - 1]) / 2;
  const logoY = H + 1.3 + logoH / 2;
  const logoZ = z - 0.6;
  const backing = new THREE.Mesh(new THREE.BoxGeometry(logoW + 0.4, logoH + 0.4, 0.12), frameMat);
  backing.position.set(logoX, logoY, logoZ + 0.08);
  group.add(backing);
  const logo = new THREE.Mesh(
    new THREE.PlaneGeometry(logoW, logoH),
    new THREE.MeshStandardMaterial({ map: createWallLogoTexture(logoW / logoH), roughness: 0.55 }),
  );
  logo.position.set(logoX, logoY, logoZ);
  logo.rotation.y = Math.PI;
  group.add(logo);
  void yellow;
}

function buildObstacles(group: THREE.Group, track: Track, yellow: THREE.Material): void {
  const kit = new RackKit();
  const concrete = new THREE.MeshStandardMaterial({ color: '#b5b8bb', roughness: 0.85 });
  for (const o of track.def.obstacles) {
    if (o.kind === 'circle') {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.6, WALL.height, 0.6), concrete);
      col.position.set(o.x, WALL.height / 2, o.z);
      col.castShadow = col.receiveShadow = true;
      group.add(col);
      const guard = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r, 1.1, 20), yellow);
      guard.position.set(o.x, 0.55, o.z);
      guard.castShadow = true;
      group.add(guard);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(o.r + 0.01, o.r + 0.01, 0.15, 20), new THREE.MeshStandardMaterial({ color: '#111' }));
      band.position.set(o.x, 0.8, o.z);
      group.add(band);
    } else {
      kit.addPalletStack(o.x, o.z, 2 + (Math.round(Math.abs(o.x)) % 2), o.angle);
    }
  }
  group.add(kit.build());
}

