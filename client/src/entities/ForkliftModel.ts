import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural counterbalance forklift, facing +Z, origin on the ground at the
 * centre of the collision footprint. Built from shared geometries so six karts
 * stay cheap; only the paint material is per-kart.
 */

export interface ForkliftParts {
  root: THREE.Group;
  /** Drift-yaw group: holds body and wheels so they turn together. */
  chassis: THREE.Group;
  /** Sprung body (roll / pitch / hop / drift yaw applied here). */
  body: THREE.Group;
  frontWheels: THREE.Object3D[];
  rearPivots: THREE.Object3D[];
  rearWheels: THREE.Object3D[];
  beacon: THREE.Mesh;
  beaconMaterial: THREE.MeshStandardMaterial;
  brakeMaterial: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  /** Rear exhaust/boost anchor in body space. */
  boostAnchor: THREE.Object3D;
  /** Rear wheel contact points in chassis space (for sparks & skid marks). */
  rearContacts: THREE.Vector3[];
}

let shared: ReturnType<typeof createSharedAssets> | null = null;

function hazardTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1b1b1b';
  ctx.fillRect(0, 0, 128, 32);
  ctx.fillStyle = '#f2c230';
  for (let x = -32; x < 160; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 32);
    ctx.lineTo(x + 12, 32);
    ctx.lineTo(x + 24, 0);
    ctx.lineTo(x + 12, 0);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSharedAssets() {
  return {
    frame: new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.55, metalness: 0.5 }),
    steel: new THREE.MeshStandardMaterial({ color: '#8d949c', roughness: 0.32, metalness: 0.85 }),
    forkSteel: new THREE.MeshStandardMaterial({ color: '#3b3f45', roughness: 0.45, metalness: 0.7 }),
    rubber: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92, metalness: 0 }),
    seat: new THREE.MeshStandardMaterial({ color: '#1e1f22', roughness: 0.8, metalness: 0.05 }),
    vest: new THREE.MeshStandardMaterial({ color: '#d5f53b', roughness: 0.6, emissive: '#2b3a00', emissiveIntensity: 0.4 }),
    reflective: new THREE.MeshStandardMaterial({ color: '#dfe3e6', roughness: 0.25, metalness: 0.6 }),
    skin: new THREE.MeshStandardMaterial({ color: '#c99474', roughness: 0.7 }),
    trousers: new THREE.MeshStandardMaterial({ color: '#2d3a55', roughness: 0.85 }),
    helmet: new THREE.MeshStandardMaterial({ color: '#f4f4f0', roughness: 0.35, metalness: 0.05 }),
    headlight: new THREE.MeshStandardMaterial({ color: '#fffbe8', emissive: '#fff4c8', emissiveIntensity: 2.2 }),
    hazard: new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.6 }),
    box: (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d),
    rounded: (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r),
    frontTire: new THREE.CylinderGeometry(0.3, 0.3, 0.24, 24),
    frontRim: new THREE.CylinderGeometry(0.17, 0.17, 0.26, 16),
    rearTire: new THREE.CylinderGeometry(0.23, 0.23, 0.2, 20),
    rearRim: new THREE.CylinderGeometry(0.13, 0.13, 0.22, 14),
    post: new THREE.BoxGeometry(0.075, 1, 0.075),
    capsule: new THREE.CapsuleGeometry(0.16, 0.28, 4, 10),
    arm: new THREE.CapsuleGeometry(0.055, 0.32, 3, 8),
    head: new THREE.SphereGeometry(0.115, 16, 12),
    helmetGeo: new THREE.SphereGeometry(0.135, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    brim: new THREE.CylinderGeometry(0.16, 0.16, 0.02, 18),
    beacon: new THREE.CylinderGeometry(0.06, 0.07, 0.12, 12),
    lamp: new THREE.CylinderGeometry(0.06, 0.06, 0.06, 12),
    wheelRing: new THREE.TorusGeometry(0.15, 0.022, 8, 20),
  };
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  return m;
}

export function createForklift(color: THREE.ColorRepresentation): ForkliftParts {
  shared ??= createSharedAssets();
  const s = shared;
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.25 });
  const paintDark = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.55),
    roughness: 0.5,
    metalness: 0.25,
  });
  const beaconMaterial = new THREE.MeshStandardMaterial({
    color: '#ff8a1e',
    emissive: '#ff6a00',
    emissiveIntensity: 2,
    transparent: true,
    opacity: 0.92,
  });
  const brakeMaterial = new THREE.MeshStandardMaterial({ color: '#5a0d0d', emissive: '#ff1a1a', emissiveIntensity: 0.2 });

  const root = new THREE.Group();
  root.name = 'forklift';
  const chassis = new THREE.Group();
  root.add(chassis);
  const body = new THREE.Group();
  chassis.add(body);

  // --- Chassis & counterweight ----------------------------------------
  body.add(mesh(s.rounded(1.14, 0.42, 1.95, 0.08), paint, 0, 0.47, -0.22));
  body.add(mesh(s.rounded(1.22, 0.78, 0.6, 0.14), paint, 0, 0.66, -1.0));
  body.add(mesh(s.rounded(1.02, 0.26, 0.7, 0.1), paint, 0, 0.8, -0.62));
  // Dark grille + hazard bumper on the counterweight.
  body.add(mesh(s.box(0.8, 0.16, 0.02), paintDark, 0, 0.78, -1.305, false));
  body.add(mesh(s.box(0.8, 0.16, 0.02), paintDark, 0, 0.56, -1.305, false));
  const bumper = mesh(s.box(1.26, 0.18, 0.08), s.hazard, 0, 0.3, -1.31);
  body.add(bumper);
  // Side steps.
  body.add(mesh(s.box(0.14, 0.06, 0.7), s.frame, 0.62, 0.36, 0.05));
  body.add(mesh(s.box(0.14, 0.06, 0.7), s.frame, -0.62, 0.36, 0.05));
  // Brake lights.
  body.add(mesh(s.box(0.16, 0.08, 0.03), brakeMaterial, 0.44, 0.98, -1.3, false));
  body.add(mesh(s.box(0.16, 0.08, 0.03), brakeMaterial, -0.44, 0.98, -1.3, false));

  // --- Seat & controls ----------------------------------------------------
  body.add(mesh(s.rounded(0.52, 0.12, 0.46, 0.04), s.seat, 0, 0.98, -0.32));
  const seatBack = mesh(s.rounded(0.52, 0.5, 0.12, 0.05), s.seat, 0, 1.24, -0.55);
  seatBack.rotation.x = -0.12;
  body.add(seatBack);
  const column = mesh(s.box(0.07, 0.5, 0.07), s.frame, 0, 0.92, 0.3);
  column.rotation.x = -0.45;
  body.add(column);
  const wheelRing = mesh(s.wheelRing, s.seat, 0, 1.15, 0.2);
  wheelRing.rotation.x = Math.PI / 2 - 0.45;
  body.add(wheelRing);

  // --- Driver ----------------------------------------------------------------
  const driver = new THREE.Group();
  driver.position.set(0, 0, -0.3);
  driver.add(mesh(s.capsule, s.vest, 0, 1.34, 0));
  driver.add(mesh(s.box(0.34, 0.035, 0.34), s.reflective, 0, 1.28, 0, false));
  const thighL = mesh(s.arm, s.trousers, 0.11, 1.05, 0.2);
  thighL.rotation.x = Math.PI / 2;
  const thighR = thighL.clone();
  thighR.position.x = -0.11;
  driver.add(thighL, thighR);
  driver.add(mesh(s.head, s.skin, 0, 1.69, 0.02));
  driver.add(mesh(s.helmetGeo, s.helmet, 0, 1.72, 0.02));
  driver.add(mesh(s.brim, s.helmet, 0, 1.72, 0.04));
  for (const side of [1, -1]) {
    const arm = mesh(s.arm, s.vest, 0.2 * side, 1.35, 0.2);
    arm.rotation.x = 1.15;
    arm.rotation.z = -0.25 * side;
    driver.add(arm);
  }
  body.add(driver);

  // --- Overhead guard ---------------------------------------------------------
  const guardTop = 2.12;
  const postPositions: [number, number, number][] = [
    [0.52, 0.42, -0.12],
    [-0.52, 0.42, -0.12],
    [0.52, -0.88, 0],
    [-0.52, -0.88, 0],
  ];
  for (const [x, z, tilt] of postPositions) {
    const height = guardTop - 0.72;
    const post = mesh(s.post, s.frame, x, 0.72 + height / 2, z);
    post.scale.y = height;
    post.rotation.x = tilt;
    body.add(post);
  }
  body.add(mesh(s.box(1.12, 0.07, 0.08), s.frame, 0, guardTop, 0.5));
  body.add(mesh(s.box(1.12, 0.07, 0.08), s.frame, 0, guardTop, -0.88));
  body.add(mesh(s.box(0.08, 0.07, 1.46), s.frame, 0.52, guardTop, -0.19));
  body.add(mesh(s.box(0.08, 0.07, 1.46), s.frame, -0.52, guardTop, -0.19));
  for (const x of [-0.26, 0, 0.26]) body.add(mesh(s.box(0.05, 0.04, 1.4), s.frame, x, guardTop + 0.01, -0.19));

  const beacon = mesh(s.beacon, beaconMaterial, 0.38, guardTop + 0.1, -0.8, false);
  body.add(beacon);
  for (const side of [1, -1]) {
    const lamp = mesh(s.lamp, s.headlight, 0.52 * side, 1.62, 0.5, false);
    lamp.rotation.x = Math.PI / 2;
    body.add(lamp);
  }

  // --- Mast, carriage, forks ---------------------------------------------------
  const mastZ = 0.78;
  for (const side of [1, -1]) {
    body.add(mesh(s.box(0.1, 2.15, 0.13), s.forkSteel, 0.34 * side, 1.2, mastZ));
    body.add(mesh(s.box(0.06, 2.05, 0.09), s.steel, 0.24 * side, 1.25, mastZ + 0.04));
  }
  body.add(mesh(s.box(0.78, 0.08, 0.1), s.forkSteel, 0, 2.24, mastZ));
  body.add(mesh(s.box(0.78, 0.08, 0.1), s.forkSteel, 0, 1.1, mastZ));
  const cylinder = mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.6, 10), s.steel, 0, 1.15, mastZ - 0.06);
  body.add(cylinder);
  // Carriage + load backrest.
  const carriageZ = mastZ + 0.1;
  body.add(mesh(s.box(0.9, 0.36, 0.06), paintDark, 0, 0.42, carriageZ));
  body.add(mesh(s.box(0.9, 0.05, 0.05), s.forkSteel, 0, 1.02, carriageZ));
  for (const x of [-0.4, -0.2, 0, 0.2, 0.4]) body.add(mesh(s.box(0.04, 0.42, 0.04), s.forkSteel, x, 0.8, carriageZ));
  for (const side of [1, -1]) {
    body.add(mesh(s.box(0.12, 0.5, 0.05), s.forkSteel, 0.24 * side, 0.36, carriageZ + 0.05));
    body.add(mesh(s.box(0.12, 0.05, 0.78), s.forkSteel, 0.24 * side, 0.13, carriageZ + 0.44));
  }

  // --- Wheels (not sprung: stay on the floor) ---------------------------------
  const frontWheels: THREE.Object3D[] = [];
  const rearWheels: THREE.Object3D[] = [];
  const rearPivots: THREE.Object3D[] = [];
  for (const side of [1, -1]) {
    const fw = new THREE.Group();
    fw.position.set(0.56 * side, 0.3, 0.42);
    const tire = mesh(s.frontTire, s.rubber);
    tire.rotation.z = Math.PI / 2;
    const rim = mesh(s.frontRim, paintDark);
    rim.rotation.z = Math.PI / 2;
    const spoke = mesh(s.box(0.27, 0.05, 0.3), s.steel);
    fw.add(tire, rim, spoke);
    chassis.add(fw);
    frontWheels.push(fw);

    const pivot = new THREE.Group();
    pivot.position.set(0.5 * side, 0.23, -0.98);
    const rw = new THREE.Group();
    const rtire = mesh(s.rearTire, s.rubber);
    rtire.rotation.z = Math.PI / 2;
    const rrim = mesh(s.rearRim, s.steel);
    rrim.rotation.z = Math.PI / 2;
    const rspoke = mesh(s.box(0.23, 0.04, 0.22), s.forkSteel);
    rw.add(rtire, rrim, rspoke);
    pivot.add(rw);
    chassis.add(pivot);
    rearPivots.push(pivot);
    rearWheels.push(rw);
  }

  mergeByMaterial(body);

  const boostAnchor = new THREE.Object3D();
  boostAnchor.position.set(0, 0.55, -1.38);
  body.add(boostAnchor);

  return {
    root,
    chassis,
    body,
    frontWheels,
    rearPivots,
    rearWheels,
    beacon,
    beaconMaterial,
    brakeMaterial,
    paint,
    boostAnchor,
    rearContacts: [new THREE.Vector3(0.5, 0.02, -0.98), new THREE.Vector3(-0.5, 0.02, -0.98)],
  };
}

/** Bake every mesh under `group` into one mesh per material (keeps draw calls low). */
function mergeByMaterial(group: THREE.Group): void {
  group.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const toRemove: THREE.Mesh[] = [];
  group.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, m.matrixWorld));
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    }
    const list = buckets.get(m.material) ?? [];
    list.push(geo);
    buckets.set(m.material, list);
    toRemove.push(m);
  });
  for (const m of toRemove) m.removeFromParent();
  for (const child of [...group.children]) if (!(child as THREE.Mesh).isMesh && child.children.length === 0 && child.type === 'Group') child.removeFromParent();
  for (const [material, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const out = new THREE.Mesh(merged, material);
    out.castShadow = true;
    out.receiveShadow = true;
    group.add(out);
  }
}
