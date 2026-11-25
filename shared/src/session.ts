/**
 * RaceSession: one complete race simulation — karts, progress, items, bots,
 * countdown, finish and results. The solo client runs it locally; the
 * multiplayer server (step 5) runs the very same class authoritatively.
 */
import { botThink, createBrain, type BotBrain, type BotProfile } from './bot';
import { collideKarts, collideKartWithStatics, collideKartWithTrack } from './collision';
import { createSlot, ItemSystem, type ItemRacer, type ItemSlot } from './items';
import { applyBoost, createKartState, DEFAULT_KART_PARAMS, NEUTRAL_INPUT, stepKart, type KartInput, type KartParams, type KartState } from './kart';
import { computeRanking, createProgress, respawnKart, updateProgress, type RaceProgress } from './race';
import { Rng } from './rng';
import { gridSlot, trackHeight, type Track } from './track';

/** Session time at which the race starts ("GO"). Lights at 0.6 / 1.6 / 2.6 s. */
export const COUNTDOWN = 3.6;
const COUNTDOWN_MARKS = [0.6, 1.6, 2.6, COUNTDOWN];
/** Throttle first pressed in this window before GO (and held) = rocket start. */
const ROCKET_WINDOW: [number, number] = [0.85, 0.2];
/** Seconds to keep racing after the last human finished before closing the race. */
const FINISH_GRACE = 25;

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface RacerSetup {
  id: string;
  name: string;
  color: string;
  /** Present for AI racers. */
  bot?: BotProfile;
}

export interface SessionRacer {
  id: string;
  name: string;
  color: string;
  isBot: boolean;
  kart: KartState;
  input: KartInput;
  params: KartParams;
  prog: RaceProgress;
  slot: ItemSlot;
  rank: number;
  brain: BotBrain | null;
  /** Human who finished (or disconnected): driven by the AI from now on. */
  autoDrive: boolean;
  finishTime: number | null;
  finishPosition: number | null;
  startPress: number | null;
  stall: number;
  /** Planned throttle time for bots during the countdown. */
  botStartAt: number;
  speedScale: number;
  /** Player pressed R: respawn on the next step. */
  respawnRequested: boolean;
}

export type RaceEvent =
  | { type: 'countdown'; value: 3 | 2 | 1 | 0 }
  | { type: 'lap'; racer: string; lap: number; lapTime: number }
  | { type: 'finish'; racer: string; position: number; time: number }
  | { type: 'respawn'; racer: string }
  | { type: 'impact'; racer: string; strength: number }
  | { type: 'boost'; racer: string; level: number }
  | { type: 'startBoost'; racer: string }
  | { type: 'stall'; racer: string }
  | { type: 'raceOver' };

export interface RaceResult {
  id: string;
  name: string;
  color: string;
  isBot: boolean;
  position: number;
  /** Race time in seconds (estimated if the racer had not finished). */
  time: number;
  estimated: boolean;
  bestLap: number;
  lapTimes: number[];
}

export interface SessionOptions {
  seed?: number;
  /** Gently speeds up bots far behind the best human and slows those far ahead. */
  rubberBand?: boolean;
  params?: KartParams;
}

export class RaceSession {
  readonly racers: SessionRacer[] = [];
  readonly items: ItemSystem;
  readonly events: RaceEvent[] = [];
  phase: RacePhase = 'countdown';
  /** Session time (s); the race clock is time - COUNTDOWN. */
  time = 0;
  private finishCount = 0;
  private lastHumanFinish = -1;
  private readonly rng: Rng;
  private readonly itemRacers: ItemRacer[] = [];
  private readonly rubberBand: boolean;

  constructor(
    readonly track: Track,
    setups: RacerSetup[],
    opts: SessionOptions = {},
  ) {
    const seed = opts.seed ?? 1;
    this.rng = new Rng(seed * 31 + 7);
    this.items = new ItemSystem(track, seed);
    this.rubberBand = opts.rubberBand ?? true;
    const base = opts.params ?? DEFAULT_KART_PARAMS;
    setups.forEach((setup, i) => {
      const slot = gridSlot(track, i);
      const kart = createKartState(slot.x, slot.z, slot.heading);
      kart.y = trackHeight(track, slot.x, slot.z);
      const skill = setup.bot?.skill ?? 1;
      const speedScale = setup.bot ? 0.93 + 0.07 * skill : 1;
      this.racers.push({
        id: setup.id,
        name: setup.name,
        color: setup.color,
        isBot: !!setup.bot,
        kart,
        input: { ...NEUTRAL_INPUT },
        params: { ...base, maxSpeed: base.maxSpeed * speedScale },
        prog: createProgress(track, kart),
        slot: createSlot(),
        rank: i + 1,
        brain: setup.bot ? createBrain(setup.bot, seed * 1000 + i) : null,
        autoDrive: false,
        finishTime: null,
        finishPosition: null,
        startPress: null,
        stall: 0,
        // Good bots hit the rocket window more often; weaker ones are early/late.
        botStartAt: COUNTDOWN - (0.15 + this.rng.next() * (0.55 + (1 - skill) * 2)),
        speedScale,
        respawnRequested: false,
      });
    });
  }

  get raceTime(): number {
    return Math.max(0, this.time - COUNTDOWN);
  }

  racer(id: string): SessionRacer | undefined {
    return this.racers.find((r) => r.id === id);
  }

  /** Human input (ignored for bots / auto-driven racers). */
  setInput(id: string, input: KartInput): void {
    const r = this.racer(id);
    if (r && !r.isBot && !r.autoDrive) Object.assign(r.input, input);
  }

  /** Hand a human racer to the AI (finished, or disconnected in multiplayer). */
  setAutoDrive(id: string, on: boolean): void {
    const r = this.racer(id);
    if (!r || r.isBot) return;
    r.autoDrive = on;
    if (on && !r.brain) r.brain = createBrain({ name: r.name, skill: 0.9, aggression: 0.5, lane: 0, shortcutChance: 0 }, 99);
  }

  /** Manual respawn (R key / menu). */
  requestRespawn(id: string): void {
    const r = this.racer(id);
    if (r && this.phase !== 'countdown') r.respawnRequested = true;
  }

  teleport(id: string, x: number, z: number, heading: number): void {
    const r = this.racer(id);
    if (!r) return;
    const fresh = createKartState(x, z, heading);
    fresh.y = trackHeight(this.track, x, z);
    Object.assign(r.kart, fresh);
    r.prog = createProgress(this.track, r.kart);
    r.prog.lap = Math.max(1, r.prog.lap);
    r.prog.nextGate = 1;
  }

  step(dt: number): void {
    this.events.length = 0;
    const prevTime = this.time;
    this.time += dt;
    for (let i = 0; i < COUNTDOWN_MARKS.length; i += 1) {
      if (prevTime < COUNTDOWN_MARKS[i] && this.time >= COUNTDOWN_MARKS[i]) {
        this.events.push({ type: 'countdown', value: (3 - i) as 3 | 2 | 1 | 0 });
      }
    }

    if (this.phase === 'countdown') {
      this.stepCountdown();
      if (this.time >= COUNTDOWN) this.startRace();
      return;
    }
    this.stepRacing(dt);
  }

  private stepCountdown(): void {
    for (const r of this.racers) {
      if (r.isBot) {
        r.input.throttle = this.time >= r.botStartAt ? 1 : 0;
      }
      if (r.input.throttle > 0.5) {
        if (r.startPress === null) r.startPress = this.time;
      } else r.startPress = null;
    }
  }

  private startRace(): void {
    this.phase = 'racing';
    for (const r of this.racers) {
      if (r.startPress === null) continue;
      const early = COUNTDOWN - r.startPress;
      if (early > ROCKET_WINDOW[0]) {
        r.stall = 0.8;
        this.events.push({ type: 'stall', racer: r.id });
      } else if (early >= ROCKET_WINDOW[1] || early >= 0) {
        if (early >= ROCKET_WINDOW[1]) {
          applyBoost(r.kart, 1.1);
          this.events.push({ type: 'startBoost', racer: r.id });
        }
      }
    }
  }

  private stepRacing(dt: number): void {
    const track = this.track;
    const ground = (x: number, z: number) => trackHeight(track, x, z);

    // Rubber band against the best human.
    let bestHuman = -Infinity;
    for (const r of this.racers) if (!r.isBot) bestHuman = Math.max(bestHuman, r.prog.distance);
    for (const r of this.racers) {
      if (!r.isBot) continue;
      let rb = 1;
      if (this.rubberBand && Number.isFinite(bestHuman) && !r.prog.finished) {
        const gap = r.prog.distance - bestHuman;
        rb = Math.max(0.94, Math.min(1.07, 1 - gap * 0.0006));
      }
      r.params.maxSpeed = DEFAULT_KART_PARAMS.maxSpeed * r.speedScale * rb;
    }

    // Inputs.
    for (const r of this.racers) {
      if ((r.isBot || r.autoDrive) && r.brain) {
        botThink(
          r.brain,
          {
            self: { id: r.id, kart: r.kart, prog: r.prog, slot: r.slot, rank: r.rank, params: r.params },
            others: this.racers.filter((o) => o !== r),
            items: this.items,
            track,
          },
          dt,
          r.input,
        );
      }
      if (r.stall > 0) {
        r.stall -= dt;
        r.input.throttle = 0;
      }
    }

    // Physics.
    const statics = [...track.def.obstacles, ...this.items.colliders()];
    for (const r of this.racers) {
      stepKart(r.kart, r.input, dt, r.params, ground);
      let impact = collideKartWithTrack(r.kart, track, r.params);
      impact = Math.max(impact, collideKartWithStatics(r.kart, statics, r.params));
      r.kart.y = ground(r.kart.x, r.kart.z);
      if (impact > 2) this.events.push({ type: 'impact', racer: r.id, strength: impact });
      if (r.kart.boostEvent > 0) this.events.push({ type: 'boost', racer: r.id, level: r.kart.boostEvent });
    }
    for (let i = 0; i < this.racers.length; i += 1) {
      for (let j = i + 1; j < this.racers.length; j += 1) {
        const a = this.racers[i];
        const b = this.racers[j];
        if (Math.abs(a.kart.y - b.kart.y) > 1.5) continue;
        const impact = collideKarts(a.kart, b.kart, a.params);
        if (impact > 2) {
          this.events.push({ type: 'impact', racer: a.id, strength: impact });
          this.events.push({ type: 'impact', racer: b.id, strength: impact });
        }
      }
    }

    // Progress, laps, finish, respawn.
    for (const r of this.racers) {
      const lapBefore = r.prog.lap;
      const respawn = updateProgress(r.prog, r.kart, r.input, track, this.time, dt);
      // Lap 1 is timed from GO, not from crossing the line (the grid is behind it).
      if (lapBefore === 0 && r.prog.lap === 1) r.prog.lapStartTime = COUNTDOWN;
      if (r.prog.events.lapCompleted) {
        this.events.push({ type: 'lap', racer: r.id, lap: r.prog.lap, lapTime: r.prog.lapTimes[r.prog.lapTimes.length - 1] });
      }
      if (r.prog.events.finished && r.finishTime === null) {
        this.finishCount += 1;
        r.finishTime = r.prog.finishTime - COUNTDOWN;
        r.finishPosition = this.finishCount;
        this.events.push({ type: 'finish', racer: r.id, position: this.finishCount, time: r.finishTime });
        if (!r.isBot) {
          this.setAutoDrive(r.id, true);
          this.lastHumanFinish = this.time;
        }
      }
      if (respawn || r.respawnRequested) {
        r.respawnRequested = false;
        respawnKart(r.prog, r.kart, track);
        this.events.push({ type: 'respawn', racer: r.id });
      }
    }

    // Ranking + items.
    const ranking = computeRanking(this.racers.map((r) => r.prog));
    ranking.forEach((idx, pos) => (this.racers[idx].rank = pos + 1));
    this.itemRacers.length = 0;
    for (const r of this.racers) {
      this.itemRacers.push({ id: r.id, kart: r.kart, input: r.input, slot: r.slot, rank: r.rank, s: r.prog.s });
    }
    this.items.step(dt, this.time, this.itemRacers, track.def.obstacles);

    // End of race.
    if (this.phase === 'racing') {
      const allDone = this.racers.every((r) => r.finishTime !== null);
      const humans = this.racers.filter((r) => !r.isBot);
      const humansDone = humans.length > 0 && humans.every((r) => r.finishTime !== null);
      if (allDone || (humansDone && this.time - this.lastHumanFinish > FINISH_GRACE)) {
        this.phase = 'finished';
        this.events.push({ type: 'raceOver' });
      }
    }
  }

  /** Final (or live) classification. Unfinished racers get an estimated time. */
  results(): RaceResult[] {
    const ranking = computeRanking(this.racers.map((r) => r.prog));
    const L = this.track.length;
    const totalDist = this.track.def.laps * L;
    return ranking.map((idx, pos) => {
      const r = this.racers[idx];
      let time = r.finishTime ?? 0;
      let estimated = false;
      if (r.finishTime === null) {
        const done = Math.max(1, r.prog.distance);
        const avg = done / Math.max(1, this.raceTime);
        time = this.raceTime + Math.max(0, totalDist - done) / Math.max(4, avg);
        estimated = true;
      }
      return {
        id: r.id,
        name: r.name,
        color: r.color,
        isBot: r.isBot,
        position: pos + 1,
        time,
        estimated,
        bestLap: r.prog.bestLap,
        lapTimes: r.prog.lapTimes.slice(),
      };
    });
  }
}
