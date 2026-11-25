import * as THREE from 'three';

export interface ChaseTarget {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  maxSpeed: number;
  boosting: boolean;
  driftDir: number;
}

/**
 * Dynamic third-person camera: lags behind the kart's yaw (so turns and drifts
 * read), pulls back and widens FOV with speed, punches on boost, shakes on impact.
 */
export class ChaseCamera {
  baseFov = 64;
  distance = 5.0;
  height = 2.3;
  yawFollow = 5.5;
  /** Extra yaw around the kart (intro swing): 0 = behind, PI = in front. */
  orbit = 0;
  /** Signed distance to the walls (> 0 inside); keeps the camera out of the racks. */
  wallDistance: ((x: number, z: number) => number) | null = null;
  private yaw = 0;
  private fov = 64;
  private trauma = 0;
  private time = 0;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly smoothLook = new THREE.Vector3();
  private extraDistance = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  snap(t: ChaseTarget): void {
    this.yaw = t.heading;
    this.extraDistance = 0;
    this.compute(t);
    this.camera.position.copy(this.pos);
    this.smoothLook.copy(this.look);
    this.camera.lookAt(this.smoothLook);
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt: number, t: ChaseTarget): void {
    this.time += dt;
    // Yaw lag: looser while drifting so the slide angle is visible.
    let diff = t.heading - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const follow = t.driftDir !== 0 ? this.yawFollow * 0.55 : this.yawFollow;
    this.yaw += diff * (1 - Math.exp(-follow * dt));

    const speedRatio = THREE.MathUtils.clamp(t.speed / t.maxSpeed, 0, 1.5);
    const targetExtra = speedRatio * 1.1 + (t.boosting ? 0.8 : 0);
    this.extraDistance += (targetExtra - this.extraDistance) * (1 - Math.exp(-3 * dt));

    this.compute(t);
    this.camera.position.lerp(this.pos, 1 - Math.exp(-14 * dt));
    this.smoothLook.lerp(this.look, 1 - Math.exp(-18 * dt));

    const targetFov = this.baseFov + speedRatio * 10 + (t.boosting ? 9 : 0);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-5 * dt));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.lookAt(this.smoothLook);

    // Trauma shake (shake = trauma^2), deterministic noise from accumulated time.
    this.trauma = Math.max(0, this.trauma - 1.6 * dt);
    if (this.trauma > 0) {
      const shake = this.trauma * this.trauma;
      const f = this.time * 30;
      this.camera.position.x += 0.35 * shake * noise(f, 1);
      this.camera.position.y += 0.35 * shake * noise(f, 2);
      this.camera.rotation.z += 0.06 * shake * noise(f, 3);
    }
  }

  private compute(t: ChaseTarget): void {
    const fx = Math.sin(this.yaw + this.orbit);
    const fz = Math.cos(this.yaw + this.orbit);
    const dist = this.distance + this.extraDistance + Math.sin(this.orbit) * 1.5;
    let d = dist;
    if (this.wallDistance) {
      // March out from the kart; stop before the camera would enter racking.
      for (let m = 0.5; m <= dist; m += 0.25) {
        if (this.wallDistance(t.x - fx * m, t.z - fz * m) < 0.35) {
          d = Math.max(1.2, m - 0.25);
          break;
        }
      }
    }
    const lift = (dist - d) * 0.35;
    this.pos.set(t.x - fx * d, t.y + this.height + this.extraDistance * 0.15 + lift, t.z - fz * d);
    const hx = Math.sin(t.heading);
    const hz = Math.cos(t.heading);
    // Look ahead of the kart when behind it, at the kart itself during the intro swing.
    const ahead = 2.6 * Math.max(0, Math.cos(this.orbit));
    this.look.set(t.x + hx * ahead, t.y + 1.05, t.z + hz * ahead);
  }
}

function noise(t: number, seed: number): number {
  const x = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}
