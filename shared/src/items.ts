/**
 * Items ("bonus"): MSF Supply crates on the track, weighted rolls by race
 * position, and the six logistics-themed items. Deterministic (seeded RNG,
 * fixed dt) so the authoritative server can run the exact same code.
 *
 *  express  Livraison express  3 s speed boost
 *  oil      Flaque d'huile     dropped behind, spins out whoever drives over it
 *  carton   Carton lancé       straight projectile, bounces off racks / walls
 *  tracked  Colis tracké       homing projectile, chases the kart ahead
 *  film     Film étirable      shield, absorbs one attack
 *  pallet   Palette (rare)     falls in front of the kart ahead, blocks part of the aisle
 */
import { circleVsStatic, distanceToKart, type BoxCollider, type StaticCollider } from './collision';
import { applyBoost, hitKart, type KartInput, type KartState } from './kart';
import { nearestSample } from './race';
import { Rng } from './rng';
import { sampleAtS, trackHeight, trackSdf, trackSdfGradient, type Track } from './track';

export const ITEM_TYPES = ['express', 'oil', 'carton', 'tracked', 'film', 'pallet'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_LABELS: Record<ItemType, string> = {
  express: 'Livraison express',
  oil: "Flaque d'huile",
  carton: 'Carton lancé',
  tracked: 'Colis tracké',
  film: 'Film étirable',
  pallet: 'Palette qui tombe',
};

export const ITEM_TUNING = {
  crateRadius: 1.35,
  crateRespawn: 4,
  rollTime: 1.3,
  boostTime: 3,
  shieldTime: 12,
  spinOil: 1.0,
  spinHit: 1.4,
  spinPallet: 1.2,
  oilRadius: 1.0,
  oilLife: 30,
  cartonSpeed: 34,
  cartonLife: 5,
  cartonBounces: 6,
  trackedSpeed: 29,
  trackedLife: 12,
  projectileRadius: 0.35,
  palletFallTime: 0.9,
  palletLife: 8,
  palletHalfWidth: 1.5,
  palletHalfDepth: 0.65,
};

export interface ItemSlot {
  item: ItemType | null;
  /** Roulette time remaining before the item can be used. */
  rolling: number;
  /** Second item held in reserve; moves to `item` once that one is used. */
  reserve: ItemType | null;
  /** Roulette time remaining for the reserve item. */
  reserveRolling: number;
  /** Stretch-film shield time remaining. */
  shield: number;
  usePrev: boolean;
}

export function createSlot(): ItemSlot {
  return { item: null, rolling: 0, reserve: null, reserveRolling: 0, shield: 0, usePrev: false };
}

/** Move the reserve item into the main slot when the main slot is free. */
function promoteReserve(slot: ItemSlot): void {
  if (slot.item !== null || slot.rolling > 0 || slot.reserve === null) return;
  slot.item = slot.reserve;
  slot.rolling = slot.reserveRolling;
  slot.reserve = null;
  slot.reserveRolling = 0;
}

/** What the item system needs to know about each racer. */
export interface ItemRacer {
  id: string;
  kart: KartState;
  input: KartInput;
  slot: ItemSlot;
  /** 1 = leader. */
  rank: number;
  /** Arc length on the main loop. */
  s: number;
}

export interface Crate {
  id: number;
  x: number;
  y: number;
  z: number;
  active: boolean;
  respawnAt: number;
}

export interface Projectile {
  id: number;
  kind: 'carton' | 'tracked';
  owner: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  age: number;
  bounces: number;
  targetId: string | null;
  s: number;
}

export interface Hazard {
  id: number;
  kind: 'oil' | 'pallet';
  owner: string;
  x: number;
  y: number;
  z: number;
  angle: number;
  age: number;
  /** Pallet: seconds until it lands (warning shadow until then). */
  fall: number;
}

export type ItemEvent =
  | { type: 'pickup'; racer: string; crate: number }
  | { type: 'rolled'; racer: string; item: ItemType }
  | { type: 'use'; racer: string; item: ItemType }
  | { type: 'hit'; racer: string; by: string; cause: 'oil' | 'carton' | 'tracked' | 'pallet' }
  | { type: 'blocked'; racer: string; cause: 'oil' | 'carton' | 'tracked' | 'pallet' }
  | { type: 'bounce'; projectile: number; x: number; z: number }
  | { type: 'destroyed'; projectile: number; x: number; z: number }
  | { type: 'land'; hazard: number; x: number; z: number };

/** Item weights by normalised position f (0 = leader, 1 = last). */
export function itemWeights(rank: number, racers: number): Record<ItemType, number> {
  const f = racers > 1 ? (rank - 1) / (racers - 1) : 0;
  return {
    express: 10 + 26 * f,
    oil: 30 - 22 * f,
    carton: 26 - 8 * f,
    tracked: rank === 1 ? 0 : 6 + 22 * f,
    film: 22 - 12 * f,
    pallet: f > 0.45 ? 7 * f : 0,
  };
}

export class ItemSystem {
  readonly crates: Crate[];
  readonly projectiles: Projectile[] = [];
  readonly hazards: Hazard[] = [];
  readonly events: ItemEvent[] = [];
  private nextId = 1;
  private rng: Rng;
  private readonly palletColliders: BoxCollider[] = [];
  private readonly grad = { x: 0, z: 0 };

  constructor(
    private readonly track: Track,
    seed = 1,
  ) {
    this.rng = new Rng(seed);
    this.crates = track.itemSpots.map((p, i) => ({ id: i, x: p.x, y: p.y, z: p.z, active: true, respawnAt: 0 }));
  }

  reset(seed: number): void {
    this.rng = new Rng(seed);
    for (const c of this.crates) {
      c.active = true;
      c.respawnAt = 0;
    }
    this.projectiles.length = 0;
    this.hazards.length = 0;
    this.events.length = 0;
  }

  /** Landed pallets act as temporary walls for kart collision. */
  colliders(): readonly BoxCollider[] {
    this.palletColliders.length = 0;
    for (const h of this.hazards) {
      if (h.kind === 'pallet' && h.fall <= 0) {
        this.palletColliders.push({
          kind: 'box',
          x: h.x,
          z: h.z,
          hx: ITEM_TUNING.palletHalfWidth,
          hz: ITEM_TUNING.palletHalfDepth,
          angle: h.angle,
        });
      }
    }
    return this.palletColliders;
  }

  roll(rank: number, racers: number): ItemType {
    const w = itemWeights(rank, racers);
    let total = 0;
    for (const t of ITEM_TYPES) total += w[t];
    let r = this.rng.next() * total;
    for (const t of ITEM_TYPES) {
      r -= w[t];
      if (r <= 0) return t;
    }
    return 'oil';
  }

  /** Advance items one fixed step. Clears and refills `events`. */
  step(dt: number, time: number, racers: ItemRacer[], statics: readonly StaticCollider[]): void {
    this.events.length = 0;
    const T = ITEM_TUNING;

    // Crate respawn + pickup.
    for (const c of this.crates) {
      if (!c.active) {
        if (time >= c.respawnAt) c.active = true;
        continue;
      }
      for (const r of racers) {
        const k = r.kart;
        if (Math.abs(k.y - c.y) > 1.5) continue;
        if (distanceToKart(k, c.x, c.z) > T.crateRadius) continue;
        c.active = false;
        c.respawnAt = time + T.crateRespawn;
        this.events.push({ type: 'pickup', racer: r.id, crate: c.id });
        if (r.slot.item === null && r.slot.rolling <= 0) {
          r.slot.item = this.roll(r.rank, racers.length);
          r.slot.rolling = T.rollTime;
        } else if (r.slot.reserve === null) {
          r.slot.reserve = this.roll(r.rank, racers.length);
          r.slot.reserveRolling = T.rollTime;
        }
        break;
      }
    }

    // Slots: roulette, shields, use button (edge-triggered).
    for (const r of racers) {
      const slot = r.slot;
      if (slot.rolling > 0) {
        slot.rolling = Math.max(0, slot.rolling - dt);
        if (slot.rolling === 0 && slot.item) this.events.push({ type: 'rolled', racer: r.id, item: slot.item });
      }
      if (slot.reserveRolling > 0) {
        slot.reserveRolling = Math.max(0, slot.reserveRolling - dt);
        if (slot.reserveRolling === 0 && slot.reserve) this.events.push({ type: 'rolled', racer: r.id, item: slot.reserve });
      }
      promoteReserve(slot);
      slot.shield = Math.max(0, slot.shield - dt);
      const pressed = r.input.item && !slot.usePrev;
      slot.usePrev = r.input.item;
      if (pressed && slot.item && slot.rolling <= 0 && r.kart.spinTime <= 0) {
        const item = slot.item;
        slot.item = null;
        promoteReserve(slot);
        this.use(r, item, racers);
        this.events.push({ type: 'use', racer: r.id, item });
      }
    }

    this.stepProjectiles(dt, racers, statics);
    this.stepHazards(dt, racers);
  }

  private use(r: ItemRacer, item: ItemType, racers: ItemRacer[]): void {
    const k = r.kart;
    const fx = Math.sin(k.heading);
    const fz = Math.cos(k.heading);
    const T = ITEM_TUNING;
    switch (item) {
      case 'express':
        applyBoost(k, T.boostTime);
        break;
      case 'film':
        r.slot.shield = T.shieldTime;
        break;
      case 'oil':
        this.hazards.push({
          id: this.nextId++,
          kind: 'oil',
          owner: r.id,
          x: k.x - fx * 3.0,
          y: k.y,
          z: k.z - fz * 3.0,
          angle: k.heading,
          age: 0,
          fall: 0,
        });
        break;
      case 'carton':
      case 'tracked': {
        const speed = item === 'carton' ? T.cartonSpeed : T.trackedSpeed;
        const ahead = item === 'tracked' ? racers.find((o) => o.rank === r.rank - 1) : undefined;
        this.projectiles.push({
          id: this.nextId++,
          kind: item,
          owner: r.id,
          x: k.x + fx * 1.9,
          y: k.y,
          z: k.z + fz * 1.9,
          vx: fx * speed + k.vx * 0.3,
          vz: fz * speed + k.vz * 0.3,
          age: 0,
          bounces: 0,
          targetId: ahead ? ahead.id : null,
          s: r.s,
        });
        break;
      }
      case 'pallet': {
        // Drop on the racing line of the kart directly ahead (or behind us when leading).
        const ahead = racers.find((o) => o.rank === r.rank - 1);
        const target = ahead ?? r;
        const s = ahead ? target.s + 14 : r.s - 12;
        const p = sampleAtS(this.track, s);
        // Lateral offset of the target kart from the centre line, clamped so a lane stays open.
        const lat = (target.kart.x - p.x) * -p.tz + (target.kart.z - p.z) * p.tx;
        const maxLat = Math.max(0, p.hw - T.palletHalfWidth - 1.8);
        const off = Math.max(-maxLat, Math.min(maxLat, lat));
        const x = p.x - p.tz * off;
        const z = p.z + p.tx * off;
        this.hazards.push({
          id: this.nextId++,
          kind: 'pallet',
          owner: r.id,
          x,
          y: trackHeight(this.track, x, z),
          z,
          angle: Math.atan2(p.tx, p.tz),
          age: 0,
          fall: T.palletFallTime,
        });
        break;
      }
    }
  }

  /** Apply a hit unless shielded / invulnerable. */
  private tryHit(victim: ItemRacer, by: string, cause: 'oil' | 'carton' | 'tracked' | 'pallet', seconds: number): boolean {
    if (victim.kart.invulnTime > 0 || victim.kart.spinTime > 0) return false;
    if (victim.slot.shield > 0) {
      victim.slot.shield = 0;
      victim.kart.invulnTime = 0.6;
      this.events.push({ type: 'blocked', racer: victim.id, cause });
      return true;
    }
    if (hitKart(victim.kart, seconds)) {
      this.events.push({ type: 'hit', racer: victim.id, by, cause });
      return true;
    }
    return false;
  }

  private stepProjectiles(dt: number, racers: ItemRacer[], statics: readonly StaticCollider[]): void {
    const T = ITEM_TUNING;
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const p = this.projectiles[i];
      p.age += dt;
      const life = p.kind === 'carton' ? T.cartonLife : T.trackedLife;
      let dead = p.age > life;

      if (p.kind === 'tracked') this.steerTracked(p, dt, racers);

      // Sub-step to avoid tunnelling through thin walls at 30+ m/s.
      const sub = 3;
      for (let k = 0; k < sub && !dead; k += 1) {
        p.x += (p.vx * dt) / sub;
        p.z += (p.vz * dt) / sub;
        const d = trackSdf(this.track, p.x, p.z);
        if (d < T.projectileRadius) {
          trackSdfGradient(this.track, p.x, p.z, this.grad);
          p.x += this.grad.x * (T.projectileRadius - d);
          p.z += this.grad.z * (T.projectileRadius - d);
          const vn = p.vx * this.grad.x + p.vz * this.grad.z;
          if (vn < 0) {
            if (p.kind === 'carton') {
              p.vx -= 2 * vn * this.grad.x;
              p.vz -= 2 * vn * this.grad.z;
              p.bounces += 1;
              this.events.push({ type: 'bounce', projectile: p.id, x: p.x, z: p.z });
              if (p.bounces > T.cartonBounces) dead = true;
            } else {
              // Tracked parcels slide along walls instead of bouncing.
              p.vx -= vn * this.grad.x;
              p.vz -= vn * this.grad.z;
            }
          }
        }
        for (const col of statics) {
          const c = circleVsStatic(p.x, p.z, T.projectileRadius, col);
          if (c) {
            dead = true;
            break;
          }
        }
      }
      p.y = trackHeight(this.track, p.x, p.z);

      if (!dead) {
        for (const r of racers) {
          if (r.id === p.owner && p.age < 0.6) continue;
          if (Math.abs(r.kart.y - p.y) > 1.5) continue;
          if (distanceToKart(r.kart, p.x, p.z) > 0.72 + T.projectileRadius) continue;
          this.tryHit(r, p.owner, p.kind, T.spinHit);
          dead = true;
          break;
        }
      }
      if (dead) {
        this.events.push({ type: 'destroyed', projectile: p.id, x: p.x, z: p.z });
        this.projectiles.splice(i, 1);
      }
    }
  }

  private steerTracked(p: Projectile, dt: number, racers: ItemRacer[]): void {
    const T = ITEM_TUNING;
    const sample = nearestSample(this.track, p.x, p.z, p.s);
    p.s = sample.s;
    const target = p.targetId ? racers.find((r) => r.id === p.targetId) : undefined;
    let tx: number;
    let tz: number;
    const near = target && Math.hypot(target.kart.x - p.x, target.kart.z - p.z) < 16 && this.lineOfSight(p.x, p.z, target.kart.x, target.kart.z);
    if (target && near) {
      tx = target.kart.x;
      tz = target.kart.z;
    } else {
      const ahead = sampleAtS(this.track, p.s + 7);
      tx = ahead.x;
      tz = ahead.z;
    }
    const desired = Math.atan2(tx - p.x, tz - p.z);
    const current = Math.atan2(p.vx, p.vz);
    let diff = desired - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = 6 * dt;
    const heading = current + Math.max(-maxTurn, Math.min(maxTurn, diff));
    p.vx = Math.sin(heading) * T.trackedSpeed;
    p.vz = Math.cos(heading) * T.trackedSpeed;
  }

  private lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const steps = 8;
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      if (trackSdf(this.track, ax + (bx - ax) * t, az + (bz - az) * t) < 0.3) return false;
    }
    return true;
  }

  private stepHazards(dt: number, racers: ItemRacer[]): void {
    const T = ITEM_TUNING;
    for (let i = this.hazards.length - 1; i >= 0; i -= 1) {
      const h = this.hazards[i];
      h.age += dt;
      let dead = false;
      if (h.kind === 'oil') {
        if (h.age > T.oilLife) dead = true;
        for (const r of racers) {
          if (dead) break;
          if (r.id === h.owner && h.age < 1) continue;
          if (Math.abs(r.kart.y - h.y) > 1.5) continue;
          if (distanceToKart(r.kart, h.x, h.z) > T.oilRadius + 0.45) continue;
          if (this.tryHit(r, h.owner, 'oil', T.spinOil)) dead = true;
        }
      } else {
        if (h.fall > 0) {
          h.fall -= dt;
          if (h.fall <= 0) {
            this.events.push({ type: 'land', hazard: h.id, x: h.x, z: h.z });
            // Anything under the pallet when it lands gets flattened (spun out).
            for (const r of racers) {
              const c = Math.cos(h.angle);
              const s = Math.sin(h.angle);
              const dx = r.kart.x - h.x;
              const dz = r.kart.z - h.z;
              const lx = c * dx - s * dz;
              const lz = s * dx + c * dz;
              if (Math.abs(lx) < T.palletHalfWidth + 0.6 && Math.abs(lz) < T.palletHalfDepth + 0.9) {
                this.tryHit(r, h.owner, 'pallet', T.spinPallet);
              }
            }
          }
        } else if (h.age > T.palletFallTime + T.palletLife) dead = true;
      }
      if (dead) this.hazards.splice(i, 1);
    }
  }
}
