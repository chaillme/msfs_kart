/**
 * Bot driver AI. Produces a KartInput from what a player could see: the track
 * ahead, nearby karts, hazards and its own item. Deterministic (seeded RNG) so
 * the server and a solo client get identical bot behaviour.
 *
 *  - follows the centre line with a personal lane offset (pure pursuit)
 *  - brakes for corners from a look-ahead curvature scan
 *  - drifts through long corners and releases for the mini-turbo
 *  - steers around oil puddles and pallets, overtakes slower karts
 *  - may take the shortcut (skill / personality dependent)
 *  - uses items tactically, with a human-like reaction delay
 *  - backs out when stuck
 */
import type { ItemSlot, ItemSystem } from './items';
import type { KartInput, KartParams, KartState } from './kart';
import type { RaceProgress } from './race';
import { Rng } from './rng';
import { sampleAtS, trackSdf, type Track, type TrackSample } from './track';
import botNames from '../config/bot-names.json';

export interface BotProfile {
  name: string;
  /** 0.7 (beginner) .. 1 (expert): corner speed, line precision, start, drift use. */
  skill: number;
  /** 0..1: how eagerly items are fired. */
  aggression: number;
  /** Preferred lateral position, fraction of half-width (-1 left .. 1 right). */
  lane: number;
  /** Chance per lap to try the narrow shortcut. */
  shortcutChance: number;
}

export interface BotBrain {
  profile: BotProfile;
  rng: Rng;
  laneTarget: number;
  lane: number;
  laneTimer: number;
  /** Item: seconds to wait before considering use (reaction / tactics). */
  itemWait: number;
  itemHeld: number;
  reverseTimer: number;
  stuckTimer: number;
  shortcutLap: number;
  takingShortcut: boolean;
  wobble: number;
}

export interface BotContext {
  self: { id: string; kart: KartState; prog: RaceProgress; slot: ItemSlot; rank: number; params: KartParams };
  others: { id: string; kart: KartState; prog: RaceProgress; rank: number }[];
  items: ItemSystem;
  track: Track;
}

export function createBrain(profile: BotProfile, seed: number): BotBrain {
  return {
    profile,
    rng: new Rng(seed),
    laneTarget: profile.lane,
    lane: profile.lane,
    laneTimer: 2,
    itemWait: 1,
    itemHeld: 0,
    reverseTimer: 0,
    stuckTimer: 0,
    shortcutLap: -1,
    takingShortcut: false,
    wobble: 0,
  };
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function tangentAngle(s: TrackSample): number {
  return Math.atan2(s.tx, s.tz);
}

/** Signed lateral offset of (x, z) from a sample (positive = right). */
function lateralOf(s: TrackSample, x: number, z: number): number {
  return (x - s.x) * -s.tz + (z - s.z) * s.tx;
}

function circularDelta(from: number, to: number, length: number): number {
  let d = to - from;
  if (d > length / 2) d -= length;
  else if (d < -length / 2) d += length;
  return d;
}

/** Decide this step's inputs for a bot. */
export function botThink(brain: BotBrain, ctx: BotContext, dt: number, out: KartInput): KartInput {
  const { self, track } = ctx;
  const k = self.kart;
  const p = brain.profile;
  const speed = k.forwardSpeed;
  const L = track.length;
  const s = self.prog.s;
  const here = sampleAtS(track, s);

  // --- Lane choice: personality drift + overtaking + hazard avoidance --------
  brain.laneTimer -= dt;
  if (brain.laneTimer <= 0) {
    brain.laneTimer = 2.5 + brain.rng.next() * 3.5;
    brain.laneTarget = Math.max(-0.7, Math.min(0.7, p.lane + (brain.rng.next() - 0.5) * 0.7));
  }
  let laneGoal = brain.laneTarget;
  // Overtake: kart just ahead in my lane -> pick the other side.
  for (const o of ctx.others) {
    const ds = circularDelta(s, o.prog.s, L);
    if (ds <= 0 || ds > 10) continue;
    const otherLane = lateralOf(here, o.kart.x, o.kart.z) / Math.max(1, here.hw);
    if (Math.abs(otherLane - laneGoal) < 0.45 && o.kart.forwardSpeed < speed + 1) {
      laneGoal = otherLane > 0 ? otherLane - 0.7 : otherLane + 0.7;
    }
  }
  // Hazards ahead (oil, pallets): steer clear.
  for (const h of ctx.items.hazards) {
    const hs = nearestS(track, h.x, h.z, s);
    const ds = circularDelta(s, hs.s, L);
    if (ds < 2 || ds > 28) continue;
    const hl = lateralOf(hs, h.x, h.z) / Math.max(1, hs.hw);
    const half = h.kind === 'pallet' ? 0.75 : 0.45;
    if (Math.abs(hl - laneGoal) < half + 0.15) {
      // Skill decides whether the bot reacts in time.
      if (brain.rng.next() < 0.6 + p.skill * 0.4 || ds > 15) laneGoal = hl > 0 ? hl - half - 0.35 : hl + half + 0.35;
    }
  }
  laneGoal = Math.max(-0.75, Math.min(0.75, laneGoal));
  brain.lane += (laneGoal - brain.lane) * (1 - Math.exp(-2.5 * dt));

  // --- Shortcut decision (once per lap, before the entry) ---------------------
  const branch = track.branches[0];
  if (branch) {
    const entry = branch[0].s;
    const exit = branch[branch.length - 1].s;
    const toEntry = circularDelta(s, entry, L);
    if (toEntry > 25 && toEntry < 40 && brain.shortcutLap !== self.prog.lap) {
      brain.shortcutLap = self.prog.lap;
      brain.takingShortcut = brain.rng.next() < p.shortcutChance;
    }
    if (circularDelta(s, exit, L) < -2) brain.takingShortcut = false;
  }

  // --- Target point (pure pursuit) -------------------------------------------
  const look = 4.5 + Math.abs(speed) * 0.32;
  let target: { x: number; z: number };
  const onShortcut = brain.takingShortcut && branch && circularDelta(s, branch[0].s, L) < 6;
  if (onShortcut && branch) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < branch.length; i += 1) {
      const d = (branch[i].x - k.x) ** 2 + (branch[i].z - k.z) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const t = branch[Math.min(branch.length - 1, bi + Math.round(look))];
    target = { x: t.x, z: t.z };
  } else {
    const a = sampleAtS(track, s + look);
    const off = brain.lane * Math.max(0, a.hw - 1.6);
    target = { x: a.x - a.tz * off, z: a.z + a.tx * off };
  }

  // --- Corner speed from a curvature scan ------------------------------------
  const baseAngle = tangentAngle(here);
  let allowed = self.params.maxSpeed * 1.5;
  let cornerAhead = 0;
  let cornerSign = 0;
  const cornerGrip = 0.82 + p.skill * 0.2;
  for (let d = 4; d <= 46; d += 3) {
    const a = sampleAtS(track, s + d);
    const turn = wrapAngle(tangentAngle(a) - baseAngle);
    const mag = Math.abs(turn);
    // Tight turns need low speed; more distance = more braking room.
    const vCorner = Math.max(7.5, self.params.maxSpeed * cornerGrip * (1 - mag / 2.6));
    const v = vCorner + d * 0.55;
    if (v < allowed) allowed = v;
    if (d <= 22 && mag > cornerAhead) {
      cornerAhead = mag;
      cornerSign = Math.sign(turn);
    }
  }
  if (onShortcut) allowed = Math.min(allowed, 11 + p.skill * 3);

  // --- Steering ----------------------------------------------------------------
  const desired = Math.atan2(target.x - k.x, target.z - k.z);
  let diff = wrapAngle(desired - k.heading);
  brain.wobble += dt;
  diff += Math.sin(brain.wobble * 1.7) * (1 - p.skill) * 0.06;
  out.steer = Math.max(-1, Math.min(1, -diff * 2.8));

  // --- Throttle / brake ----------------------------------------------------------
  if (speed > allowed + 1.5) out.throttle = -1;
  else if (speed > allowed) out.throttle = 0;
  else out.throttle = 1;
  if (Math.abs(diff) > 1.1 && speed > 6) out.throttle = -0.5;

  // --- Drift: long corners at speed, release when it straightens --------------
  const wantsDrift = p.skill > 0.78 && cornerAhead > 0.75 && speed > 11 && !onShortcut;
  if (k.driftDir !== 0) {
    // Keep drifting while the corner continues and we are not drifting the wrong way.
    const turnNow = wrapAngle(tangentAngle(sampleAtS(track, s + 6)) - baseAngle);
    const stillTurning = Math.abs(turnNow) > 0.12 && Math.sign(turnNow) === -k.driftDir;
    out.drift = stillTurning && Math.abs(diff) < 0.9;
  } else {
    // A left turn increases heading (turn > 0) and needs steer < 0.
    out.drift = wantsDrift && Math.sign(out.steer) === -cornerSign && Math.abs(out.steer) > 0.4;
  }

  // --- Stuck: back out ------------------------------------------------------------
  if (brain.reverseTimer > 0) {
    brain.reverseTimer -= dt;
    out.throttle = -1;
    out.steer = -out.steer;
    out.drift = false;
  } else if (out.throttle > 0 && Math.abs(speed) < 0.8 && k.spinTime <= 0) {
    brain.stuckTimer += dt;
    if (brain.stuckTimer > 0.9) {
      brain.stuckTimer = 0;
      brain.reverseTimer = 0.8;
    }
  } else brain.stuckTimer = 0;

  // --- Items ------------------------------------------------------------------------
  out.item = false;
  const slot = self.slot;
  if (slot.item && slot.rolling <= 0) {
    brain.itemHeld += dt;
    brain.itemWait -= dt;
    if (brain.itemWait <= 0) {
      if (shouldUseItem(brain, ctx, slot.item, cornerAhead)) {
        out.item = true;
        brain.itemHeld = 0;
      }
      brain.itemWait = 0.25 + (1 - p.aggression) * 0.5 * brain.rng.next();
    }
  } else {
    brain.itemHeld = 0;
    if (slot.rolling > 0) brain.itemWait = 0.4 + brain.rng.next() * (1.6 - p.aggression);
  }
  return out;
}

function shouldUseItem(brain: BotBrain, ctx: BotContext, item: string, cornerAhead: number): boolean {
  const { self, track } = ctx;
  const L = track.length;
  const k = self.kart;
  const held = brain.itemHeld;
  const ahead = (maxDs: number) =>
    ctx.others.filter((o) => {
      const ds = circularDelta(self.prog.s, o.prog.s, L);
      return ds > 1 && ds < maxDs && Math.abs(o.kart.y - k.y) < 1.5;
    });
  const behind = (maxDs: number) =>
    ctx.others.filter((o) => {
      const ds = circularDelta(self.prog.s, o.prog.s, L);
      return ds < -1 && ds > -maxDs;
    });
  switch (item) {
    case 'film':
      return true;
    case 'pallet':
      return self.rank > 1 || held > 4;
    case 'express':
      return cornerAhead < 0.35 || held > 6;
    case 'oil':
      return behind(16).length > 0 || held > 9;
    case 'tracked':
      return self.rank > 1 ? ahead(70).length > 0 || held > 3 : held > 12;
    case 'carton': {
      for (const o of ahead(32)) {
        const ang = Math.atan2(o.kart.x - k.x, o.kart.z - k.z);
        if (Math.abs(wrapAngle(ang - k.heading)) < 0.12 && lineClear(track, k.x, k.z, o.kart.x, o.kart.z)) return true;
      }
      return held > 10;
    }
  }
  return held > 8;
}

function lineClear(track: Track, ax: number, az: number, bx: number, bz: number): boolean {
  for (let i = 1; i < 8; i += 1) {
    const t = i / 8;
    if (trackSdf(track, ax + (bx - ax) * t, az + (bz - az) * t) < 0.4) return false;
  }
  return true;
}

/** Cheap nearest main sample around an s estimate (for hazards). */
function nearestS(track: Track, x: number, z: number, aroundS: number): TrackSample {
  let best = sampleAtS(track, aroundS);
  let bd = Infinity;
  for (let d = -10; d <= 40; d += 1) {
    const smp = sampleAtS(track, aroundS + d);
    const dist = (smp.x - x) ** 2 + (smp.z - z) ** 2;
    if (dist < bd) {
      bd = dist;
      best = smp;
    }
  }
  return best;
}

// Bot names live in shared/config/bot-names.json (one name per slot, strongest bot first).
// A missing or empty entry falls back to the default name below.
const DEFAULT_BOT_ROSTER: BotProfile[] = [
  { name: 'Amina', skill: 0.97, aggression: 0.7, lane: -0.25, shortcutChance: 0.6 },
  { name: 'Lucas', skill: 0.93, aggression: 0.9, lane: 0.3, shortcutChance: 0.35 },
  { name: 'Fatou', skill: 0.9, aggression: 0.5, lane: 0.1, shortcutChance: 0.2 },
  { name: 'Karim', skill: 0.86, aggression: 0.8, lane: -0.45, shortcutChance: 0.5 },
  { name: 'Sofia', skill: 0.82, aggression: 0.4, lane: 0.45, shortcutChance: 0.1 },
];

const configuredNames: unknown[] = Array.isArray(botNames) ? botNames : [];

export const BOT_ROSTER: BotProfile[] = DEFAULT_BOT_ROSTER.map((profile, i) => {
  const name = configuredNames[i];
  return typeof name === 'string' && name.trim() ? { ...profile, name: name.trim() } : profile;
});
