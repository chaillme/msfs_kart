// Full-race checks with bots (run: npm run test:session).
import { BOT_ROSTER } from '../src/bot';
import { FIXED_DT } from '../src/kart';
import { COUNTDOWN, RaceSession, type RaceEvent, type RacerSetup } from '../src/session';
import { buildTrack } from '../src/track';
import { WAREHOUSE_TRACK } from '../src/tracks/warehouse';
import type { ItemEvent } from '../src/items';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures += 1;
}

const track = buildTrack(WAREHOUSE_TRACK);
const COLORS = ['#e8202a', '#2f8cff', '#2fa84f', '#f2c230', '#8e5bd6', '#ff8a1e'];

function setups(humans: number): RacerSetup[] {
  const list: RacerSetup[] = [];
  BOT_ROSTER.forEach((b, i) => list.push({ id: `bot${i}`, name: b.name, color: COLORS[i + 1], bot: b }));
  for (let h = 0; h < humans; h += 1) list.push({ id: `human${h}`, name: 'Vous', color: COLORS[0] });
  return list;
}

interface RunStats {
  session: RaceSession;
  events: RaceEvent[];
  itemEvents: ItemEvent[];
  simSeconds: number;
  wallMs: number;
}

function runRace(seed: number, humanDrive: 'idle' | 'auto', maxSeconds = 220): RunStats {
  const session = new RaceSession(track, setups(1), { seed });
  if (humanDrive === 'auto') session.setAutoDrive('human0', true);
  const events: RaceEvent[] = [];
  const itemEvents: ItemEvent[] = [];
  const t0 = performance.now();
  let t = 0;
  while (session.phase !== 'finished' && t < maxSeconds) {
    session.step(FIXED_DT);
    events.push(...session.events);
    itemEvents.push(...session.items.events);
    t += FIXED_DT;
  }
  return { session, events, itemEvents, simSeconds: t, wallMs: performance.now() - t0 };
}

// 1. Countdown freezes karts, emits 3-2-1-GO.
{
  const session = new RaceSession(track, setups(1), { seed: 3 });
  const start = { ...session.racer('bot0')!.kart };
  const values: number[] = [];
  while (session.time < COUNTDOWN - 0.05) {
    session.step(FIXED_DT);
    for (const e of session.events) if (e.type === 'countdown') values.push(e.value);
  }
  const k = session.racer('bot0')!.kart;
  check('karts stay on the grid during the countdown', k.x === start.x && k.z === start.z, `moved ${Math.hypot(k.x - start.x, k.z - start.z).toFixed(3)} m`);
  session.step(FIXED_DT * 4);
  for (const e of session.events) if (e.type === 'countdown') values.push(e.value);
  check('countdown 3, 2, 1, GO', values.join(',') === '3,2,1,0' && session.phase === 'racing', `values ${values.join(',')}, phase ${session.phase}`);
}

// 2. Rocket start and stall for a human.
{
  const s1 = new RaceSession(track, setups(1), { seed: 3 });
  let t = 0;
  while (s1.phase === 'countdown') {
    t += FIXED_DT;
    s1.setInput('human0', { throttle: s1.time > COUNTDOWN - 0.5 ? 1 : 0, steer: 0, drift: false, item: false });
    s1.step(FIXED_DT);
  }
  check('throttle ~0.5 s before GO gives a rocket start', s1.racer('human0')!.kart.boostTime > 0.9, `boost ${s1.racer('human0')!.kart.boostTime.toFixed(2)}s`);
  const s2 = new RaceSession(track, setups(1), { seed: 3 });
  while (s2.phase === 'countdown') {
    s2.setInput('human0', { throttle: 1, steer: 0, drift: false, item: false });
    s2.step(FIXED_DT);
  }
  for (let i = 0; i < 30; i += 1) s2.step(FIXED_DT);
  check('holding throttle from the start stalls the engine', Math.abs(s2.racer('human0')!.kart.forwardSpeed) < 0.1, `speed after 0.5 s ${s2.racer('human0')!.kart.forwardSpeed.toFixed(2)}`);
}

// 3. Full race: bots + auto-driven human all finish 3 laps.
const race = runRace(11, 'auto');
{
  const res = race.session.results();
  const finished = race.session.racers.filter((r) => r.finishTime !== null).length;
  const table = res.map((r) => `${r.position}.${r.name} ${r.time.toFixed(1)}s${r.estimated ? '*' : ''}`).join(' | ');
  check('all 6 racers finish 3 laps', finished === 6 && race.session.phase === 'finished', `${finished}/6 finished in ${race.simSeconds.toFixed(0)} s sim · ${table}`);
  const times = res.map((r) => r.time);
  check('race is competitive (all within 25 s of the winner)', times[times.length - 1] - times[0] < 25, `spread ${(times[times.length - 1] - times[0]).toFixed(1)} s`);
  check('winner time is plausible (75-110 s for 3 laps)', times[0] > 75 && times[0] < 110, `${times[0].toFixed(1)} s`);
  const respawns = race.events.filter((e) => e.type === 'respawn').length;
  check('bots rarely need a respawn', respawns <= 3, `${respawns} respawns in the race`);
  const uses = race.itemEvents.filter((e) => e.type === 'use');
  const kinds = new Set(uses.map((e) => (e.type === 'use' ? e.item : '')));
  check('bots pick up and use items', uses.length >= 15 && kinds.size >= 4, `${uses.length} uses, kinds: ${[...kinds].join(', ')}`);
  const hits = race.itemEvents.filter((e) => e.type === 'hit').length;
  check('items actually hit people', hits >= 3, `${hits} hits, ${race.itemEvents.filter((e) => e.type === 'blocked').length} blocked by film`);
  const drifts = race.events.filter((e) => e.type === 'boost').length;
  check('bots drift and earn mini-turbos', drifts >= 10, `${drifts} mini-turbos`);
  check('race simulates far faster than real time', race.wallMs < race.simSeconds * 1000 * 0.25, `${race.wallMs.toFixed(0)} ms for ${race.simSeconds.toFixed(0)} s`);
}

// 4. Determinism: same seed -> identical race.
{
  const again = runRace(11, 'auto');
  const a = race.session.results().map((r) => `${r.id}:${r.time.toFixed(4)}`).join(',');
  const b = again.session.results().map((r) => `${r.id}:${r.time.toFixed(4)}`).join(',');
  check('same seed gives an identical race', a === b, a === b ? 'identical results' : `${a} vs ${b}`);
  const other = runRace(12, 'auto');
  const c = other.session.results().map((r) => `${r.id}:${r.time.toFixed(4)}`).join(',');
  check('different seed gives a different race', a !== c, 'differs');
}

// 5. Idle human: race still ends (grace period) with an estimated time.
{
  const idle = runRace(5, 'idle', 400);
  const me = idle.session.results().find((r) => r.id === 'human0')!;
  const botsDone = idle.session.racers.filter((r) => r.isBot && r.finishTime !== null).length;
  check('idle human: bots finish, human is last', botsDone === 5 && me.position === 6, `bots finished ${botsDone}, human P${me.position}`);
  check('race over only when everyone finished (human idle never does)', idle.session.phase !== 'finished', `phase ${idle.session.phase} after ${idle.simSeconds.toFixed(0)} s`);
}

// 6. Shortcut is used by some bots across several races.
{
  let shortcutLaps = 0;
  for (const seed of [21, 22, 23]) {
    const s = new RaceSession(track, setups(1), { seed });
    s.setAutoDrive('human0', true);
    const branch = track.branches[0];
    const mid = branch[Math.floor(branch.length / 2)];
    const seen = new Set<string>();
    for (let t = 0; t < 120 && s.phase !== 'finished'; t += FIXED_DT) {
      s.step(FIXED_DT);
      for (const r of s.racers) {
        if (Math.hypot(r.kart.x - mid.x, r.kart.z - mid.z) < 1.5) {
          const key = `${r.id}:${r.prog.lap}`;
          if (!seen.has(key)) {
            seen.add(key);
            shortcutLaps += 1;
          }
        }
      }
    }
  }
  check('some bots take the shortcut', shortcutLaps >= 3, `${shortcutLaps} shortcut passes over 3 races`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll session checks passed');
process.exit(failures ? 1 : 0);
