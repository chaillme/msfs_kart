import * as THREE from 'three';
import {
  copyKartState,
  createKartState,
  hopHeight,
  type KartInput,
  type KartParams,
  type KartState,
} from '@shared/kart';
import { createForklift, type ForkliftParts } from './ForkliftModel';
import type { KartFx } from '../systems/KartFx';

export const DRIFT_COLORS = [
  new THREE.Color('#d8dde3'),
  new THREE.Color('#2f8cff'),
  new THREE.Color('#ff8a1e'),
  new THREE.Color('#ff2b45'),
];

const flameGeo = new THREE.ConeGeometry(0.12, 0.7, 10, 1, true);
flameGeo.rotateX(-Math.PI / 2);
flameGeo.translate(0, 0, -0.35);

/**
 * Kart view: renders a simulation KartState (owned by the RaceSession) with
 * interpolation between the last two fixed steps.
 */
export class Kart {
  readonly prev: KartState;
  readonly parts: ForkliftParts;
  private readonly flames: THREE.Mesh[] = [];
  private readonly flameMat: THREE.MeshBasicMaterial;
  private roll = 0;
  private pitch = 0;
  private driftYaw = 0;
  private wheelAngle = 0;
  private lastSpeed = 0;
  private lastHeading = 0;
  private time = 0;
  private pendingBoost = 0;
  private slope = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(
    readonly id: string,
    color: THREE.ColorRepresentation,
    readonly state: KartState,
    readonly input: KartInput,
  ) {
    this.prev = createKartState(state.x, state.z, state.heading);
    copyKartState(state, this.prev);
    const heading = state.heading;
    this.parts = createForklift(color);
    this.flameMat = new THREE.MeshBasicMaterial({
      color: '#7fd0ff',
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const side of [0.32, -0.32]) {
      const flame = new THREE.Mesh(flameGeo, this.flameMat);
      flame.position.x = side;
      flame.visible = false;
      this.parts.boostAnchor.add(flame);
      this.flames.push(flame);
    }
    this.lastHeading = heading;
  }

  get object(): THREE.Group {
    return this.parts.root;
  }

  /** Record one-shot events produced by a fixed step (call right after stepping). */
  collectStepEvents(): void {
    if (this.state.boostEvent > 0) this.pendingBoost = this.state.boostEvent;
  }

  /** Call before each fixed simulation step. */
  savePrevious(): void {
    copyKartState(this.state, this.prev);
  }

  /** Jump to the current state without interpolation (respawn, teleport, reset). */
  snap(): void {
    copyKartState(this.state, this.prev);
    this.lastHeading = this.state.heading;
    this.parts.root.position.set(this.state.x, this.state.y, this.state.z);
    this.parts.root.rotation.y = this.state.heading;
  }

  /** Interpolate between the last two fixed steps and animate visuals. */
  render(alpha: number, dt: number, params: KartParams, fx: KartFx, ground?: (x: number, z: number) => number): void {
    this.time += dt;
    const s = this.state;
    const p = this.prev;
    const root = this.parts.root;
    root.position.set(p.x + (s.x - p.x) * alpha, p.y + (s.y - p.y) * alpha, p.z + (s.z - p.z) * alpha);
    let dh = s.heading - p.heading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    else if (dh < -Math.PI) dh += Math.PI * 2;
    const heading = p.heading + dh * alpha;
    root.rotation.order = 'YXZ';
    root.rotation.y = heading;
    if (ground) {
      // Follow ramp slope.
      const fx0 = Math.sin(heading);
      const fz0 = Math.cos(heading);
      const hf = ground(root.position.x + fx0 * 0.9, root.position.z + fz0 * 0.9);
      const hb = ground(root.position.x - fx0 * 0.9, root.position.z - fz0 * 0.9);
      const target = -Math.atan2(hf - hb, 1.8);
      this.slope += (target - this.slope) * (1 - Math.exp(-14 * dt));
      root.rotation.x = this.slope;
    }

    // Visual springs from accelerations (never fed back into the simulation).
    const safeDt = Math.max(dt, 1e-4);
    const longAcc = (s.forwardSpeed - this.lastSpeed) / safeDt;
    let yawDelta = heading - this.lastHeading;
    if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    else if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    const yawRate = yawDelta / safeDt;
    this.lastSpeed = s.forwardSpeed;
    this.lastHeading = heading;
    const latAcc = yawRate * s.forwardSpeed;

    const k = 1 - Math.exp(-10 * dt);
    this.roll += (THREE.MathUtils.clamp(latAcc * 0.0045, -0.09, 0.09) - this.roll) * k;
    this.pitch += (THREE.MathUtils.clamp(-longAcc * 0.0035, -0.07, 0.07) - this.pitch) * k;
    this.driftYaw += (-s.driftDir * 0.42 - this.driftYaw) * (1 - Math.exp(-8 * dt));
    let spin = 0;
    if (s.spinTime > 0 && s.spinDuration > 0) {
      const t = 1 - s.spinTime / s.spinDuration;
      spin = (1 - (1 - t) * (1 - t)) * Math.PI * 4; // two turns, easing out
    }
    this.parts.chassis.rotation.y = this.driftYaw + spin;
    const body = this.parts.body;
    body.rotation.set(this.pitch, 0, this.roll);
    body.position.y = hopHeight(s);

    this.wheelAngle += (s.forwardSpeed * dt) / 0.3;
    for (const w of this.parts.frontWheels) w.rotation.x = this.wheelAngle;
    for (const w of this.parts.rearWheels) w.rotation.x = this.wheelAngle * 1.3;
    for (const pivot of this.parts.rearPivots) pivot.rotation.y = s.steer * 0.55 - s.driftDir * 0.25;

    // Beacon blink, brake lights.
    this.parts.beaconMaterial.emissiveIntensity = Math.sin(this.time * 9) > 0.2 ? 3.2 : 0.25;
    const braking = this.input.throttle < -0.05 && s.forwardSpeed > 0.5;
    const reversing = s.forwardSpeed < -0.3;
    this.parts.brakeMaterial.emissiveIntensity = braking ? 3 : reversing ? 1.4 : 0.25;

    // Boost flames.
    const boosting = s.boostTime > 0;
    for (const flame of this.flames) {
      flame.visible = boosting;
      if (boosting) {
        const flicker = 0.85 + Math.sin(this.time * 60 + flame.position.x * 20) * 0.15;
        flame.scale.set(1, 1, (0.8 + Math.min(1, s.boostTime) * 0.8) * flicker);
      }
    }
    this.flameMat.color.setHSL(0.56 - Math.min(1, s.boostTime) * 0.5, 1, 0.6);
    void params;

    // Drift sparks + skid marks at the rear wheels.
    root.updateMatrixWorld(true);
    const drifting = s.driftDir !== 0;
    const lateral = Math.abs(s.vx * Math.cos(s.heading) - s.vz * Math.sin(s.heading));
    const skidding = drifting || (braking && s.forwardSpeed > 6) || lateral > 3.2;
    for (let i = 0; i < this.parts.rearContacts.length; i += 1) {
      this.tmp.copy(this.parts.rearContacts[i]);
      this.parts.chassis.localToWorld(this.tmp);
      fx.skid(`${this.id}:${i}`, this.tmp, skidding && body.position.y < 0.02);
      if (drifting) {
        const level = s.driftLevel;
        const outside = (i === 0 ? 1 : -1) === s.driftDir;
        const count = level === 0 ? (outside ? 1 : 0) : outside ? 3 : 1;
        if (count > 0) fx.emitSparks(this.tmp, DRIFT_COLORS[level], count, 0.6 + level * 0.25);
      }
    }
    if (this.pendingBoost > 0) {
      this.tmp.set(0, 0.4, -1.3);
      root.localToWorld(this.tmp);
      fx.emitSparks(this.tmp, DRIFT_COLORS[this.pendingBoost], 30, 1.6);
      this.pendingBoost = 0;
    }
  }
}
