import * as THREE from 'three';

const MAX_SPARKS = 900;
const MAX_SKIDS = 1400;

function sparkSprite(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/** Pooled drift sparks + tyre skid marks shared by all karts. */
export class KartFx {
  readonly group = new THREE.Group();
  private readonly sparkPos = new Float32Array(MAX_SPARKS * 3);
  private readonly sparkCol = new Float32Array(MAX_SPARKS * 3);
  private readonly sparkVel = new Float32Array(MAX_SPARKS * 3);
  private readonly sparkLife = new Float32Array(MAX_SPARKS);
  private readonly sparkBase = new Float32Array(MAX_SPARKS * 3);
  private sparkCursor = 0;
  private readonly sparkGeo = new THREE.BufferGeometry();
  private readonly sparks: THREE.Points;

  private readonly skids: THREE.InstancedMesh;
  private skidCursor = 0;
  private readonly lastSkid = new Map<string, THREE.Vector3>();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private seed = 1;
  /** 0..1 particle budget (quality preset). */
  density = 1;

  constructor() {
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3));
    this.sparks = new THREE.Points(
      this.sparkGeo,
      new THREE.PointsMaterial({
        size: 0.16,
        map: sparkSprite(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.sparks.frustumCulled = false;
    this.group.add(this.sparks);
    for (let i = 0; i < MAX_SPARKS; i += 1) this.sparkPos[i * 3 + 1] = -100;

    const skidGeo = new THREE.PlaneGeometry(1, 1);
    skidGeo.rotateX(-Math.PI / 2);
    this.skids = new THREE.InstancedMesh(
      skidGeo,
      new THREE.MeshBasicMaterial({
        color: '#050505',
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      MAX_SKIDS,
    );
    this.skids.frustumCulled = false;
    this.tmpMatrix.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_SKIDS; i += 1) this.skids.setMatrixAt(i, this.tmpMatrix);
    this.skids.renderOrder = 1;
    this.group.add(this.skids);
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  emitSparks(pos: THREE.Vector3, color: THREE.Color, count: number, spread = 1): void {
    count = count > 0 ? Math.max(1, Math.round(count * this.density)) : 0;
    for (let n = 0; n < count; n += 1) {
      const i = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;
      this.sparkPos[i * 3] = pos.x + (this.rand() - 0.5) * 0.15;
      this.sparkPos[i * 3 + 1] = pos.y + 0.05;
      this.sparkPos[i * 3 + 2] = pos.z + (this.rand() - 0.5) * 0.15;
      this.sparkVel[i * 3] = (this.rand() - 0.5) * 3 * spread;
      this.sparkVel[i * 3 + 1] = 1.2 + this.rand() * 2.2 * spread;
      this.sparkVel[i * 3 + 2] = (this.rand() - 0.5) * 3 * spread;
      this.sparkLife[i] = 0.25 + this.rand() * 0.25;
      this.sparkBase[i * 3] = color.r;
      this.sparkBase[i * 3 + 1] = color.g;
      this.sparkBase[i * 3 + 2] = color.b;
    }
  }

  /** Lay a skid segment for a given wheel; pass active=false to lift the pen. */
  skid(key: string, pos: THREE.Vector3, active: boolean): void {
    const last = this.lastSkid.get(key);
    if (!active) {
      if (last) this.lastSkid.delete(key);
      return;
    }
    if (!last) {
      this.lastSkid.set(key, pos.clone());
      return;
    }
    const dx = pos.x - last.x;
    const dz = pos.z - last.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.22) return;
    if (len > 3) {
      last.copy(pos);
      return;
    }
    this.tmpPos.set((pos.x + last.x) / 2, 0.012, (pos.z + last.z) / 2);
    this.tmpQuat.setFromAxisAngle(this.up, Math.atan2(dx, dz));
    this.tmpScale.set(0.17, 1, len + 0.04);
    this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
    this.skids.setMatrixAt(this.skidCursor, this.tmpMatrix);
    this.skidCursor = (this.skidCursor + 1) % MAX_SKIDS;
    this.skids.instanceMatrix.needsUpdate = true;
    last.copy(pos);
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_SPARKS; i += 1) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt;
      const o = i * 3;
      if (this.sparkLife[i] <= 0) {
        this.sparkPos[o + 1] = -100;
        continue;
      }
      this.sparkVel[o + 1] -= 9 * dt;
      this.sparkPos[o] += this.sparkVel[o] * dt;
      this.sparkPos[o + 1] = Math.max(0.02, this.sparkPos[o + 1] + this.sparkVel[o + 1] * dt);
      this.sparkPos[o + 2] += this.sparkVel[o + 2] * dt;
      const fade = Math.min(1, this.sparkLife[i] * 4);
      this.sparkCol[o] = this.sparkBase[o] * fade;
      this.sparkCol[o + 1] = this.sparkBase[o + 1] * fade;
      this.sparkCol[o + 2] = this.sparkBase[o + 2] * fade;
    }
    this.sparkGeo.attributes.position.needsUpdate = true;
    this.sparkGeo.attributes.color.needsUpdate = true;
  }
}
