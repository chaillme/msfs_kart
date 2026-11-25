import * as THREE from 'three';
import { ITEM_TUNING, type Hazard, type ItemSystem, type Projectile } from '@shared/items';
import { createCrateTexture } from '../world/logoTexture';
import type { KartFx } from './KartFx';

const CRATE_SIZE = 0.95;
const CRATE_HOVER = 0.75;

function cartonTex(tracked: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c49a64';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(150,110,60,0.9)';
  ctx.fillRect(0, 56, 128, 16);
  if (tracked) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(20, 18, 88, 34);
    ctx.fillStyle = '#e00';
    ctx.font = 'bold 18px Arial';
    ctx.fillText('TRACKED', 26, 41);
    ctx.fillStyle = '#111';
    for (let x = 24; x < 104; x += 5) ctx.fillRect(x, 84, x % 3 ? 2 : 3, 26);
  } else {
    ctx.fillStyle = '#fff';
    ctx.fillRect(16, 84, 40, 26);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function oilTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 256);
  const blobs: [number, number, number][] = [
    [128, 128, 86],
    [70, 110, 46],
    [180, 160, 52],
    [150, 70, 40],
    [92, 180, 38],
  ];
  for (const [x, y, r] of blobs) {
    const g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.2, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(60,52,40,0.98)');
    g.addColorStop(0.7, 'rgba(18,15,12,0.96)');
    g.addColorStop(1, 'rgba(10,8,6,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Rainbow sheen.
  ctx.globalCompositeOperation = 'source-atop';
  const sheen = ctx.createLinearGradient(40, 40, 220, 220);
  sheen.addColorStop(0.3, 'rgba(80,0,160,0)');
  sheen.addColorStop(0.45, 'rgba(60,120,255,0.25)');
  sheen.addColorStop(0.55, 'rgba(60,255,140,0.22)');
  sheen.addColorStop(0.65, 'rgba(255,200,40,0.2)');
  sheen.addColorStop(0.8, 'rgba(255,0,80,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ringTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 20, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function filmTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(235,245,255,0.18)';
  ctx.fillRect(0, 0, 256, 64);
  for (let i = 0; i < 40; i += 1) {
    ctx.strokeStyle = `rgba(255,255,255,${0.15 + (i % 5) * 0.08})`;
    ctx.lineWidth = 1 + (i % 3);
    ctx.beginPath();
    const y = (i * 37) % 64;
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(80, y + 6, 170, y - 6, 256, y + 2);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Renders crates, projectiles, hazards and shields from the shared ItemSystem state. */
export class ItemView {
  readonly group = new THREE.Group();
  private readonly crates: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly crateScale: number[];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly e = new THREE.Euler();
  private time = 0;

  private readonly projectileMeshes = new Map<number, THREE.Object3D>();
  private readonly hazardMeshes = new Map<number, THREE.Object3D>();
  private readonly cartonGeo = new THREE.BoxGeometry(0.6, 0.5, 0.6);
  private readonly cartonMat = new THREE.MeshStandardMaterial({ map: cartonTex(false), roughness: 0.8 });
  private readonly trackedMat = new THREE.MeshStandardMaterial({ map: cartonTex(true), roughness: 0.8 });
  private readonly beaconMat = new THREE.MeshStandardMaterial({ color: '#600', emissive: '#ff2020', emissiveIntensity: 3 });
  private readonly oilGeo = new THREE.PlaneGeometry(ITEM_TUNING.oilRadius * 2.6, ITEM_TUNING.oilRadius * 2.6);
  private readonly oilMat = new THREE.MeshStandardMaterial({
    map: oilTex(),
    transparent: true,
    roughness: 0.08,
    metalness: 0.3,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
  });
  private readonly warnMat = new THREE.MeshBasicMaterial({ color: '#ff2b2b', map: ringTex(), transparent: true, depthWrite: false });
  private readonly palletWood = new THREE.MeshStandardMaterial({ color: '#a77b4b', roughness: 0.85 });
  private readonly palletLoad = new THREE.MeshStandardMaterial({ color: '#c49a64', roughness: 0.8 });
  private readonly palletWrap = new THREE.MeshStandardMaterial({ color: '#eef3f6', transparent: true, opacity: 0.5, roughness: 0.2 });
  private readonly shieldGeo = new THREE.CylinderGeometry(1.25, 1.25, 2.5, 28, 1, true);
  private readonly shieldTex = filmTex();
  private readonly shieldMat = new THREE.MeshStandardMaterial({
    map: this.shieldTex,
    transparent: true,
    opacity: 0.5,
    roughness: 0.1,
    metalness: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly shields = new Map<string, THREE.Mesh>();

  constructor(private readonly system: ItemSystem) {
    const count = system.crates.length;
    const crateMat = new THREE.MeshStandardMaterial({ map: createCrateTexture(), roughness: 0.35, metalness: 0.02 });
    this.crates = new THREE.InstancedMesh(new THREE.BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE), crateMat, count);
    this.crates.castShadow = true;
    this.crates.frustumCulled = false;
    this.group.add(this.crates);
    const ringGeo = new THREE.PlaneGeometry(1.8, 1.8);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: '#ff4040',
        map: ringTex(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      count,
    );
    this.rings.frustumCulled = false;
    this.group.add(this.rings);
    this.crateScale = system.crates.map(() => 1);
  }

  /** React to one-shot item events (bursts, dust). */
  onEvents(fx: KartFx): void {
    for (const e of this.system.events) {
      if (e.type === 'pickup') {
        const c = this.system.crates[e.crate];
        this.crateScale[e.crate] = 0;
        fx.emitSparks(new THREE.Vector3(c.x, c.y + CRATE_HOVER, c.z), new THREE.Color('#ffffff'), 18, 1.4);
        fx.emitSparks(new THREE.Vector3(c.x, c.y + CRATE_HOVER, c.z), new THREE.Color('#ff3030'), 10, 1.2);
      } else if (e.type === 'bounce') {
        fx.emitSparks(new THREE.Vector3(e.x, 0.4, e.z), new THREE.Color('#d8b080'), 5, 0.8);
      } else if (e.type === 'destroyed') {
        fx.emitSparks(new THREE.Vector3(e.x, 0.4, e.z), new THREE.Color('#c49a64'), 16, 1.3);
      } else if (e.type === 'land') {
        fx.emitSparks(new THREE.Vector3(e.x, 0.1, e.z), new THREE.Color('#9a9a9a'), 30, 1.8);
      }
    }
  }

  update(dt: number, karts: { id: string; root: THREE.Object3D; shield: number }[]): void {
    this.time += dt;
    const sys = this.system;

    // Crates: hover, spin, scale back in after respawn.
    sys.crates.forEach((c, i) => {
      const target = c.active ? 1 : 0;
      const k = target > this.crateScale[i] ? 1 - Math.exp(-6 * dt) : 1;
      this.crateScale[i] += (target - this.crateScale[i]) * k;
      const sc = this.crateScale[i];
      const bob = Math.sin(this.time * 2.2 + i * 1.3) * 0.12;
      this.e.set(0.25, this.time * 1.1 + i, 0.2);
      this.q.setFromEuler(this.e);
      this.m.compose(this.v.set(c.x, c.y + CRATE_HOVER + bob, c.z), this.q, this.s.set(sc, sc, sc));
      this.crates.setMatrixAt(i, this.m);
      const pulse = 0.85 + Math.sin(this.time * 4 + i) * 0.15;
      this.m.compose(this.v.set(c.x, c.y + 0.03, c.z), this.q.identity(), this.s.set(sc * pulse, 1, sc * pulse));
      this.rings.setMatrixAt(i, this.m);
    });
    this.crates.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;

    // Projectiles.
    const seen = new Set<number>();
    for (const p of sys.projectiles) {
      seen.add(p.id);
      let obj = this.projectileMeshes.get(p.id);
      if (!obj) {
        obj = this.createProjectile(p);
        this.projectileMeshes.set(p.id, obj);
        this.group.add(obj);
      }
      obj.position.set(p.x, p.y + 0.4, p.z);
      obj.rotation.y = Math.atan2(p.vx, p.vz) + (p.kind === 'carton' ? this.time * 9 : 0);
      if (p.kind === 'tracked') {
        const beacon = obj.getObjectByName('beacon') as THREE.Mesh | undefined;
        if (beacon) beacon.visible = Math.sin(this.time * 18) > 0;
      }
    }
    for (const [id, obj] of this.projectileMeshes) {
      if (!seen.has(id)) {
        obj.removeFromParent();
        this.projectileMeshes.delete(id);
      }
    }

    // Hazards.
    const seenH = new Set<number>();
    for (const h of sys.hazards) {
      seenH.add(h.id);
      let obj = this.hazardMeshes.get(h.id);
      if (!obj) {
        obj = this.createHazard(h);
        this.hazardMeshes.set(h.id, obj);
        this.group.add(obj);
      }
      if (h.kind === 'oil') {
        const grow = Math.min(1, h.age * 4);
        obj.scale.set(grow, 1, grow);
      } else {
        const load = obj.getObjectByName('load')!;
        const warn = obj.getObjectByName('warn')!;
        const fallT = Math.max(0, h.fall) / ITEM_TUNING.palletFallTime;
        load.position.y = fallT * fallT * 7;
        warn.visible = h.fall > 0;
        warn.scale.setScalar(0.7 + (1 - fallT) * 0.5 + Math.sin(this.time * 20) * 0.05);
        // Sink into the floor during the last half second.
        const end = ITEM_TUNING.palletFallTime + ITEM_TUNING.palletLife;
        if (h.age > end - 0.5) load.position.y = -((h.age - (end - 0.5)) / 0.5) * 1.6;
      }
    }
    for (const [id, obj] of this.hazardMeshes) {
      if (!seenH.has(id)) {
        obj.removeFromParent();
        this.hazardMeshes.delete(id);
      }
    }

    // Stretch-film shields.
    this.shieldTex.offset.x = (this.time * 0.6) % 1;
    for (const k of karts) {
      let mesh = this.shields.get(k.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.shieldGeo, this.shieldMat);
        mesh.position.set(0, 1.15, 0);
        mesh.scale.set(1, 1, 1.35);
        mesh.renderOrder = 2;
        k.root.add(mesh);
        this.shields.set(k.id, mesh);
      }
      mesh.visible = k.shield > 0;
      // Flicker during the last 2 seconds.
      if (k.shield > 0 && k.shield < 2) mesh.visible = Math.sin(this.time * 25) > -0.3;
    }
  }

  private createProjectile(p: Projectile): THREE.Object3D {
    const g = new THREE.Group();
    const box = new THREE.Mesh(this.cartonGeo, p.kind === 'tracked' ? this.trackedMat : this.cartonMat);
    box.castShadow = true;
    g.add(box);
    if (p.kind === 'tracked') {
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), this.beaconMat);
      beacon.position.y = 0.32;
      beacon.name = 'beacon';
      g.add(beacon);
    }
    return g;
  }

  private createHazard(h: Hazard): THREE.Object3D {
    const g = new THREE.Group();
    g.position.set(h.x, h.y, h.z);
    g.rotation.y = h.angle;
    if (h.kind === 'oil') {
      const puddle = new THREE.Mesh(this.oilGeo, this.oilMat);
      puddle.rotation.x = -Math.PI / 2;
      puddle.rotation.z = h.id * 1.7;
      puddle.position.y = 0.025;
      puddle.receiveShadow = true;
      g.add(puddle);
      return g;
    }
    const T = ITEM_TUNING;
    const warn = new THREE.Mesh(new THREE.PlaneGeometry(T.palletHalfWidth * 2.6, T.palletHalfWidth * 2.6), this.warnMat);
    warn.rotation.x = -Math.PI / 2;
    warn.position.y = 0.04;
    warn.name = 'warn';
    g.add(warn);
    const load = new THREE.Group();
    load.name = 'load';
    // Two pallets side by side with wrapped cartons: 3.0 x 1.3 m footprint.
    for (const x of [-0.75, 0.75]) {
      const pallet = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.15, T.palletHalfDepth * 2), this.palletWood);
      pallet.position.set(x, 0.075, 0);
      pallet.castShadow = true;
      load.add(pallet);
      const cargo = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.0, T.palletHalfDepth * 2 - 0.1), this.palletLoad);
      cargo.position.set(x, 0.65, 0);
      cargo.castShadow = true;
      load.add(cargo);
      const wrap = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.05, T.palletHalfDepth * 2 - 0.05), this.palletWrap);
      wrap.position.set(x, 0.66, 0);
      load.add(wrap);
    }
    g.add(load);
    return g;
  }
}
