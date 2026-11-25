/**
 * Race progress: track position (arc length s), checkpoints, laps, ranking,
 * wrong-way / stuck detection and respawn. Pure data, shared with the server.
 *
 * Anti-cut: laps only count when every checkpoint gate has been crossed in
 * order, progress can't jump more than MAX_JUMP metres in one update, and the
 * SDF walls physically keep karts in the corridors.
 */
import { createKartState, copyKartState, type KartInput, type KartState } from './kart';
import { sampleAtS, trackHeight, trackSdf, type Track, type TrackSample } from './track';

const SEARCH_BACK = 18;
const SEARCH_AHEAD = 30;
const MAX_JUMP = 30;
const STUCK_TIME = 2.5;
const OFFTRACK_TIME = 0.6;

export interface RaceProgress {
  /** Arc length on the main loop of the nearest sample. */
  s: number;
  sample: TrackSample;
  /** Laps started (0 = still behind the line on the grid, 1..laps racing). */
  lap: number;
  /** Next gate index to cross (1..gates-1), or `gates` meaning "finish line next". */
  nextGate: number;
  finished: boolean;
  finishTime: number;
  lapStartTime: number;
  lapTimes: number[];
  bestLap: number;
  /** Continuous race distance for ranking (m). */
  distance: number;
  wrongWayTime: number;
  stuckTime: number;
  offTrackTime: number;
  respawns: number;
  /** Set for one update when a lap was completed / race finished / respawned. */
  events: { lapCompleted: boolean; finished: boolean; respawned: boolean; gate: boolean };
}

export function createProgress(track: Track, kart: KartState): RaceProgress {
  const sample = nearestSample(track, kart.x, kart.z, null);
  return {
    s: sample.s,
    sample,
    lap: 0,
    nextGate: track.def.gates, // grid is behind the line: crossing it starts lap 1
    finished: false,
    finishTime: 0,
    lapStartTime: 0,
    lapTimes: [],
    bestLap: Infinity,
    distance: sample.s - track.length,
    wrongWayTime: 0,
    stuckTime: 0,
    offTrackTime: 0,
    respawns: 0,
    events: { lapCompleted: false, finished: false, respawned: false, gate: false },
  };
}

function circularDelta(from: number, to: number, length: number): number {
  let d = to - from;
  if (d > length / 2) d -= length;
  else if (d < -length / 2) d += length;
  return d;
}

/** Nearest sample, optionally restricted to an s-window around `aroundS`. */
export function nearestSample(track: Track, x: number, z: number, aroundS: number | null): TrackSample {
  let best: TrackSample | null = null;
  let bestD = Infinity;
  for (const smp of track.all) {
    if (aroundS !== null) {
      const ds = circularDelta(aroundS, smp.s, track.length);
      if (ds < -SEARCH_BACK || ds > SEARCH_AHEAD) continue;
    }
    const d = (smp.x - x) ** 2 + (smp.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = smp;
    }
  }
  if (!best) return aroundS === null ? track.main[0] : nearestSample(track, x, z, null);
  // Window search found something far away (e.g. after a teleport): global search.
  if (aroundS !== null && bestD > (best.hw + 6) ** 2) return nearestSample(track, x, z, null);
  return best;
}

/** True if s moved forward across `gate` (all values on the circular track). */
function crossedForward(prevS: number, ds: number, gate: number, length: number): boolean {
  if (ds <= 0) return false;
  const a = circularDelta(prevS, gate, length);
  return a > 0 && a <= ds;
}

function crossedBackward(prevS: number, ds: number, gate: number, length: number): boolean {
  if (ds >= 0) return false;
  const a = circularDelta(prevS, gate, length);
  return a <= 0 && a > ds;
}

/**
 * Update progress after a physics step. Returns true if the kart should be
 * respawned (stuck or off track); call respawnKart() in that case.
 */
export function updateProgress(
  prog: RaceProgress,
  kart: KartState,
  input: KartInput,
  track: Track,
  time: number,
  dt: number,
): boolean {
  prog.events.lapCompleted = false;
  prog.events.finished = false;
  prog.events.respawned = false;
  prog.events.gate = false;

  const sample = nearestSample(track, kart.x, kart.z, prog.s);
  const L = track.length;
  const ds = circularDelta(prog.s, sample.s, L);
  if (Math.abs(ds) <= MAX_JUMP) {
    const gates = track.def.gates;
    // Checkpoint gates (1..gates-1), in order only.
    if (prog.nextGate < gates && crossedForward(prog.s, ds, track.gateS[prog.nextGate], L)) {
      prog.nextGate += 1;
      prog.events.gate = true;
    } else if (prog.nextGate > 1 && prog.nextGate <= gates && crossedBackward(prog.s, ds, track.gateS[prog.nextGate - 1], L)) {
      prog.nextGate -= 1;
    }
    // Finish line (s = 0).
    if (crossedForward(prog.s, ds, 0, L) && prog.nextGate === gates) {
      if (prog.lap >= 1) {
        const lapTime = time - prog.lapStartTime;
        prog.lapTimes.push(lapTime);
        prog.bestLap = Math.min(prog.bestLap, lapTime);
        prog.events.lapCompleted = true;
      }
      prog.lap += 1;
      prog.lapStartTime = time;
      prog.nextGate = 1;
      if (prog.lap > track.def.laps && !prog.finished) {
        prog.finished = true;
        prog.finishTime = time;
        prog.events.finished = true;
      }
    } else if (crossedBackward(prog.s, ds, 0, L) && prog.nextGate === 1 && prog.lap >= 1) {
      // Reversed back over the line: undo the lap start.
      prog.lap -= 1;
      prog.nextGate = gates;
    }
    prog.s = sample.s;
    prog.sample = sample;
  }
  const lapBase = (prog.lap - 1) * L;
  prog.distance = prog.lap === 0 ? prog.s - L : lapBase + prog.s;
  if (prog.finished) prog.distance = track.def.laps * L + 1e6 - prog.finishTime;

  // Wrong way: facing against the track tangent while moving.
  const fx = Math.sin(kart.heading);
  const fz = Math.cos(kart.heading);
  const along = fx * sample.tx + fz * sample.tz;
  if (along < -0.35 && Math.abs(kart.forwardSpeed) > 3) prog.wrongWayTime += dt;
  else prog.wrongWayTime = Math.max(0, prog.wrongWayTime - dt * 2);

  // Stuck: pressing throttle but not moving.
  if (Math.abs(input.throttle) > 0.5 && Math.abs(kart.forwardSpeed) < 1) prog.stuckTime += dt;
  else prog.stuckTime = 0;

  // Off track (should be rare: walls keep karts in).
  if (trackSdf(track, kart.x, kart.z) < -1.2) prog.offTrackTime += dt;
  else prog.offTrackTime = 0;

  return prog.stuckTime > STUCK_TIME || prog.offTrackTime > OFFTRACK_TIME;
}

/** Put a kart back on the centre line a few metres behind its progress point. */
export function respawnKart(prog: RaceProgress, kart: KartState, track: Track): void {
  const p = sampleAtS(track, prog.s - 4);
  const fresh = createKartState(p.x, p.z, Math.atan2(p.tx, p.tz));
  fresh.y = trackHeight(track, p.x, p.z);
  copyKartState(fresh, kart);
  prog.s = p.s;
  prog.sample = p;
  prog.stuckTime = 0;
  prog.offTrackTime = 0;
  prog.wrongWayTime = 0;
  prog.respawns += 1;
  prog.events.respawned = true;
}

/** Ranking: indices sorted by race distance (first = leader). */
export function computeRanking(progresses: readonly RaceProgress[]): number[] {
  return progresses
    .map((p, i) => ({ i, d: p.distance }))
    .sort((a, b) => b.d - a.d)
    .map((e) => e.i);
}
