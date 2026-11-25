import * as THREE from 'three';
import type { BoxCollider } from '@shared/collision';

/**
 * Instanced pallet-racking kit: blue uprights, orange beams, pallets and cartons.
 * Collect placements with addRow(), then build() once -> a handful of InstancedMesh.
 */

export const RACK = {
  bayWidth: 2.7,
  depth: 1.1,
  levels: [0.0, 1.55, 3.1],
  height: 4.6,
};

class Batch {
  readonly matrices: THREE.Matrix4[] = [];
  readonly colors: THREE.Color[] = [];
  constructor(
    readonly geometry: THREE.BufferGeometry,
    readonly material: THREE.Material,
    readonly castShadow = true,
  ) {}
  add(m: THREE.Matrix4, color?: THREE.Color): void {
    this.matrices.push(m.clone());
    if (color) this.colors.push(color);
  }
  build(): THREE.InstancedMesh | null {
    if (this.matrices.length === 0) return null;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.matrices.length);
    this.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    if (this.colors.length === this.matrices.length) this.colors.forEach((c, i) => mesh.setColorAt(i, c));
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

function cartonTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c49a64';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 400; i += 1) {
    ctx.fillStyle = `rgba(${90 + ((i * 37) % 60)},${60 + ((i * 17) % 40)},30,0.06)`;
    ctx.fillRect((i * 53) % 128, (i * 29) % 128, 3, 2);
  }
  ctx.fillStyle = 'rgba(150,110,60,0.9)';
  ctx.fillRect(0, 58, 128, 12); // tape
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(14, 82, 34, 24); // shipping label
  ctx.fillStyle = '#222';
  for (let y = 86; y < 104; y += 4) ctx.fillRect(17, y, 26, 1.5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function palletGeometry(): THREE.BufferGeometry {
  // Three stringers + top deck merged into one box-ish proxy (cheap but readable).
  const g = new THREE.BoxGeometry(1.2, 0.14, 1.0);
  return g;
}

export class RackKit {
  private readonly uprightMat = new THREE.MeshStandardMaterial({ color: '#1f5fbf', roughness: 0.45, metalness: 0.55 });
  private readonly beamMat = new THREE.MeshStandardMaterial({ color: '#f07a12', roughness: 0.42, metalness: 0.45 });
  private readonly palletMat = new THREE.MeshStandardMaterial({ color: '#a77b4b', roughness: 0.85 });
  private readonly cartonMat = new THREE.MeshStandardMaterial({ map: cartonTexture(), roughness: 0.8 });
  private readonly wrapMat = new THREE.MeshStandardMaterial({
    color: '#e8eef2',
    roughness: 0.2,
    metalness: 0.0,
    transparent: true,
    opacity: 0.55,
  });

  private readonly uprights = new Batch(new THREE.BoxGeometry(0.09, RACK.height, 0.09), this.uprightMat);
  private readonly braces = new Batch(new THREE.BoxGeometry(0.04, 0.04, RACK.depth), this.uprightMat, false);
  private readonly beams = new Batch(new THREE.BoxGeometry(RACK.bayWidth, 0.13, 0.06), this.beamMat);
  private readonly pallets = new Batch(palletGeometry(), this.palletMat);
  private readonly cartons = new Batch(new THREE.BoxGeometry(1, 1, 1), this.cartonMat);
  private readonly wraps = new Batch(new THREE.BoxGeometry(1, 1, 1), this.wrapMat, false);

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private seed = 7;

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** Place a matrix in local rack-row space, transformed by the row frame. */
  private put(batch: Batch, frame: THREE.Matrix4, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rotY = 0): void {
    this.q.setFromAxisAngle(this.up, rotY);
    this.m.compose(this.v.set(x, y, z), this.q, this.sc.set(sx, sy, sz));
    this.m.premultiply(frame);
    batch.add(this.m);
  }

  /**
   * A straight row of racking. (x, z) is the row centre, angle rotates the row
   * around Y; bays run along local X. Returns the collision box for the row.
   */
  addRow(x: number, z: number, bays: number, angle = 0, fill = 0.85): BoxCollider {
    const frame = new THREE.Matrix4().compose(
      new THREE.Vector3(x, 0, z),
      new THREE.Quaternion().setFromAxisAngle(this.up, angle),
      new THREE.Vector3(1, 1, 1),
    );
    const length = bays * RACK.bayWidth;
    const half = RACK.depth / 2;
    for (let b = 0; b <= bays; b += 1) {
      const lx = -length / 2 + b * RACK.bayWidth;
      this.put(this.uprights, frame, lx, RACK.height / 2, -half);
      this.put(this.uprights, frame, lx, RACK.height / 2, half);
      for (const y of [0.6, 1.9, 3.2, 4.3]) this.put(this.braces, frame, lx, y, 0);
    }
    for (let b = 0; b < bays; b += 1) {
      const cx = -length / 2 + (b + 0.5) * RACK.bayWidth;
      for (const level of RACK.levels) {
        const beamY = level === 0 ? 0.12 : level;
        this.put(this.beams, frame, cx, beamY, -half);
        this.put(this.beams, frame, cx, beamY, half);
        // Two pallet positions per bay.
        for (const slot of [-0.65, 0.65]) {
          if (this.rand() > fill) continue;
          const px = cx + slot;
          const py = beamY + 0.13;
          this.put(this.pallets, frame, px, py, 0, 1, 1, 1);
          const h = 0.5 + this.rand() * 0.75;
          const style = this.rand();
          if (style < 0.7) {
            this.put(this.cartons, frame, px, py + 0.07 + h / 2, 0, 1.1, h, 0.95, (this.rand() - 0.5) * 0.04);
          } else {
            this.put(this.wraps, frame, px, py + 0.07 + h / 2, 0, 1.14, h, 0.98);
            this.put(this.cartons, frame, px, py + 0.07 + h / 2, 0, 1.06, h * 0.96, 0.9);
          }
        }
      }
    }
    return { kind: 'box', x, z, hx: length / 2 + 0.05, hz: half + 0.06, angle };
  }

  /** Floor-standing pallet stack (no racking). Returns its collider. */
  addPalletStack(x: number, z: number, layers: number, angle = 0): BoxCollider {
    const frame = new THREE.Matrix4().compose(
      new THREE.Vector3(x, 0, z),
      new THREE.Quaternion().setFromAxisAngle(this.up, angle),
      new THREE.Vector3(1, 1, 1),
    );
    let y = 0;
    for (let i = 0; i < layers; i += 1) {
      this.put(this.pallets, frame, 0, y + 0.07, 0);
      const h = 0.55 + this.rand() * 0.4;
      this.put(this.cartons, frame, 0, y + 0.14 + h / 2, 0, 1.12, h, 0.98);
      y += 0.14 + h;
    }
    return { kind: 'box', x, z, hx: 0.62, hz: 0.52, angle };
  }

  build(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'racking';
    for (const batch of [this.uprights, this.braces, this.beams, this.pallets, this.cartons, this.wraps]) {
      const mesh = batch.build();
      if (mesh) g.add(mesh);
    }
    return g;
  }
}
