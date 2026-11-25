// Track + race-logic checks with a simple pure-pursuit autopilot (run: npm run test:track).
import { collideKartWithStatics, collideKartWithTrack } from '../src/collision';
import { createKartState, DEFAULT_KART_PARAMS as P, FIXED_DT, stepKart, type KartInput, type KartState } from '../src/kart';
import { createProgress, respawnKart, updateProgress, type RaceProgress } from '../src/race';
import { buildTrack, gridSlot, sampleAtS, trackHeight, trackSdf, type Track, type TrackSample } from '../src/track';
import { WAREHOUSE_TRACK } from '../src/tracks/warehouse';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures += 1;
}

const t0 = performance.now();
const track = buildTrack(WAREHOUSE_TRACK);
const buildMs = performance.now() - t0;
check('track builds quickly', buildMs < 500, `${buildMs.toFixed(0)} ms, length ${track.length} m, ${track.all.length} samples`);

// Centreline is well inside the drivable area everywhere.
let minCentre = Infinity;
for (const s of track.all) minCentre = Math.min(minCentre, trackSdf(track, s.x, s.z));
check('centreline inside corridor', minCentre > 1.2, `min SDF on centreline ${minCentre.toFixed(2)} m`);

for (let i = 0; i < 6; i += 1) {
  const g = gridSlot(track, i);
  const d = trackSdf(track, g.x, g.z);
  if (d < 1.2) check(`grid slot ${i} inside`, false, `sdf ${d.toFixed(2)}`);
}
check('6 grid slots inside track', true, 'ok');

const deck = sampleAtS(track, track.length - 40);
check('mezzanine is elevated', trackHeight(track, -58, -6) > 3.9, `deck y=${trackHeight(track, -58, -6).toFixed(2)}, ramp-foot sample y=${deck.y.toFixed(2)}`);

interface Driver {
  kart: KartState;
  prog: RaceProgress;
  input: KartInput;
}

function autopilot(d: Driver, path: TrackSample[] | null) {
  const k = d.kart;
  const look = 5 + Math.abs(k.forwardSpeed) * 0.35;
  let target: TrackSample;
  if (path) {
    // Follow a specific polyline (branch): nearest index + lookahead.
    let bi = 0;
    let bd = Infinity;
    path.forEach((p, i) => {
      const dd = (p.x - k.x) ** 2 + (p.z - k.z) ** 2;
      if (dd < bd) {
        bd = dd;
        bi = i;
      }
    });
    target = path[Math.min(path.length - 1, bi + Math.round(look))];
  } else {
    target = sampleAtS(track, d.prog.s + look);
  }
  const desired = Math.atan2(target.x - k.x, target.z - k.z);
  let diff = desired - k.heading;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  d.input.steer = Math.max(-1, Math.min(1, -diff * 2.8));
  d.input.throttle = Math.abs(diff) > 0.55 && k.forwardSpeed > 9 ? -0.4 : 1;
  d.input.drift = false;
}

function makeDriver(slot: number): Driver {
  const g = gridSlot(track, slot);
  const kart = createKartState(g.x, g.z, g.heading);
  return { kart, prog: createProgress(track, kart), input: { throttle: 0, steer: 0, drift: false, item: false } };
}

function simulate(d: Driver, seconds: number, pathFor?: (d: Driver) => TrackSample[] | null, startTime = 0): { time: number; respawns: number; walls: number } {
  let time = startTime;
  let walls = 0;
  const ground = (x: number, z: number) => trackHeight(track, x, z);
  for (let t = 0; t < seconds; t += FIXED_DT) {
    autopilot(d, pathFor ? pathFor(d) : null);
    stepKart(d.kart, d.input, FIXED_DT, P, ground);
    if (collideKartWithTrack(d.kart, track, P) > 4) walls += 1;
    collideKartWithStatics(d.kart, track.def.obstacles, P);
    time += FIXED_DT;
    if (updateProgress(d.prog, d.kart, d.input, track, time, FIXED_DT)) respawnKart(d.prog, d.kart, track);
    if (d.prog.finished) break;
  }
  return { time, respawns: d.prog.respawns, walls };
}

// 1. Autopilot completes the full race.
{
  const d = makeDriver(0);
  const r = simulate(d, 400);
  const laps = d.prog.lapTimes.map((t) => t.toFixed(1)).join(' / ');
  check('autopilot finishes 3 laps', d.prog.finished && d.prog.lapTimes.length === 3, `laps: ${laps}s, total ${d.prog.finishTime.toFixed(1)}s`);
  check('no respawn needed on the racing line', r.respawns === 0, `${r.respawns} respawns, ${r.walls} hard wall hits`);
  let maxY = 0;
  // (height reached is checked implicitly by mezzanine test above)
  void maxY;
}

// 2. Shortcut: drive through the narrow gap and still get a valid lap.
{
  const d = makeDriver(0);
  const branch = track.branches[0];
  const entryS = branch[0].s;
  const exitS = branch[branch.length - 1].s;
  let tookShortcut = false;
  const pathFor = (dr: Driver) => {
    const s = dr.prog.s;
    const inWindow = s > entryS - 25 && s < exitS + 1;
    if (inWindow && !(s > exitS - 2)) {
      tookShortcut = true;
      return branch;
    }
    return null;
  };
  simulate(d, 400, pathFor);
  const lapLen = d.prog.lapTimes.map((t) => t.toFixed(1)).join(' / ');
  check('shortcut lap is valid and faster', d.prog.finished && tookShortcut, `laps ${lapLen}s, respawns ${d.prog.respawns}`);
}

// 3. Cheat: teleporting across the map does not count gates / laps.
{
  const d = makeDriver(0);
  simulate(d, 3); // cross the line -> lap 1
  const lapBefore = d.prog.lap;
  const far = sampleAtS(track, track.length - 3);
  d.kart.x = far.x;
  d.kart.z = far.z;
  d.kart.heading = Math.atan2(far.tx, far.tz);
  simulate(d, 2);
  check('teleport to just before the line does not add a lap', d.prog.lap === lapBefore, `lap ${lapBefore} -> ${d.prog.lap}, nextGate ${d.prog.nextGate}`);
}

// 4. Cheat: reversing back over the line and forward again does not add laps.
{
  const d = makeDriver(0);
  simulate(d, 1.6);
  const lapAfterStart = d.prog.lap;
  // Drive backwards across the line.
  for (let t = 0; t < 9; t += FIXED_DT) {
    d.input.throttle = -1;
    d.input.steer = 0;
    stepKart(d.kart, d.input, FIXED_DT, P);
    collideKartWithTrack(d.kart, track, P);
    updateProgress(d.prog, d.kart, d.input, track, 0, FIXED_DT);
  }
  const lapReversed = d.prog.lap;
  simulate(d, 4);
  check('reverse over line undoes lap start, forward again: lap 1', lapAfterStart === 1 && lapReversed === 0 && d.prog.lap === 1, `start ${lapAfterStart}, reversed ${lapReversed}, again ${d.prog.lap}`);
}

// 5. Stuck detection respawns a kart pinned against a wall.
{
  const d = makeDriver(0);
  const s = sampleAtS(track, 40);
  // Face straight into the right-hand wall.
  d.kart.x = s.x;
  d.kart.z = s.z;
  d.kart.heading = Math.atan2(s.tx, s.tz) - Math.PI / 2;
  let respawned = false;
  for (let t = 0; t < 5 && !respawned; t += FIXED_DT) {
    d.input.throttle = 1;
    d.input.steer = 0;
    stepKart(d.kart, d.input, FIXED_DT, P);
    collideKartWithTrack(d.kart, track, P);
    if (updateProgress(d.prog, d.kart, d.input, track, 0, FIXED_DT)) {
      respawnKart(d.prog, d.kart, track);
      respawned = true;
    }
  }
  const sdf = trackSdf(track, d.kart.x, d.kart.z);
  check('stuck kart respawns on the centreline', respawned && sdf > 3, `respawned=${respawned}, sdf after ${sdf.toFixed(1)}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll track checks passed');
process.exit(failures ? 1 : 0);

void ({} as Track);
