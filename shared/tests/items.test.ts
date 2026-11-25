// Item system checks (run: npm run test:items).
import { collideKartWithStatics, collideKartWithTrack } from '../src/collision';
import { ITEM_TUNING, ITEM_TYPES, ItemSystem, createSlot, itemWeights, type ItemRacer, type ItemType } from '../src/items';
import { createKartState, DEFAULT_KART_PARAMS as P, FIXED_DT, stepKart } from '../src/kart';
import { nearestSample } from '../src/race';
import { Rng } from '../src/rng';
import { buildTrack, sampleAtS, trackHeight } from '../src/track';
import { WAREHOUSE_TRACK } from '../src/tracks/warehouse';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures += 1;
}

const track = buildTrack(WAREHOUSE_TRACK);
const ground = (x: number, z: number) => trackHeight(track, x, z);

function racerAt(id: string, s: number, lateral = 0, rank = 1): ItemRacer {
  const p = sampleAtS(track, s);
  const kart = createKartState(p.x - p.tz * lateral, p.z + p.tx * lateral, Math.atan2(p.tx, p.tz));
  kart.y = p.y;
  return { id, kart, input: { throttle: 0, steer: 0, drift: false, item: false }, slot: createSlot(), rank, s };
}

/** Full pipeline step for a set of racers. */
function step(items: ItemSystem, racers: ItemRacer[], time: number) {
  for (const r of racers) {
    stepKart(r.kart, r.input, FIXED_DT, P, ground);
    collideKartWithTrack(r.kart, track, P);
    collideKartWithStatics(r.kart, [...track.def.obstacles, ...items.colliders()], P);
    r.s = nearestSample(track, r.kart.x, r.kart.z, r.s).s;
  }
  items.step(FIXED_DT, time, racers, track.def.obstacles);
  return items.events.slice();
}

function run(items: ItemSystem, racers: ItemRacer[], seconds: number, t0 = 0, each?: (t: number) => void) {
  const events: ReturnType<typeof step> = [];
  let t = t0;
  for (; t < t0 + seconds; t += FIXED_DT) {
    each?.(t);
    events.push(...step(items, racers, t));
  }
  return { events, t };
}

const press = (r: ItemRacer) => {
  r.input.item = true;
};

// 1. Weights
{
  const lead = itemWeights(1, 6);
  const last = itemWeights(6, 6);
  check('leader never rolls a tracked parcel', lead.tracked === 0, `tracked weight ${lead.tracked}`);
  check('pallet only for the back of the pack', lead.pallet === 0 && last.pallet > 0, `lead ${lead.pallet}, last ${last.pallet.toFixed(1)}`);
  const sys = new ItemSystem(track, 42);
  const count = (rank: number) => {
    const c: Record<string, number> = {};
    for (const t of ITEM_TYPES) c[t] = 0;
    for (let i = 0; i < 6000; i += 1) c[sys.roll(rank, 6)] += 1;
    return c;
  };
  const c1 = count(1);
  const c6 = count(6);
  const fmt = (c: Record<string, number>) => ITEM_TYPES.map((t) => `${t}:${((c[t] / 6000) * 100).toFixed(0)}%`).join(' ');
  check('last place gets better items (more express/tracked)', c6.express > c1.express * 1.8 && c6.tracked > 1000, `1st ${fmt(c1)} | 6th ${fmt(c6)}`);
  const r1 = new Rng(7);
  const r2 = new Rng(7);
  check('rolls are deterministic with a seed', r1.next() === r2.next() && r1.next() === r2.next(), 'same sequence');
}

// 2. Pickup, roll delay, one item at a time, crate respawn.
{
  const items = new ItemSystem(track, 1);
  const spot = track.itemSpots[2]; // middle crate of the first row
  const s0 = nearestSample(track, spot.x, spot.z, null).s;
  const r = racerAt('p', s0 - 12);
  const lateral = (spot.x - sampleAtS(track, s0).x) * -sampleAtS(track, s0).tz + (spot.z - sampleAtS(track, s0).z) * sampleAtS(track, s0).tx;
  Object.assign(r, racerAt('p', s0 - 12, lateral));
  r.input.throttle = 1;
  const { events, t } = run(items, [r], 2.0);
  const pickup = events.find((e) => e.type === 'pickup');
  check('driving into a crate picks it up', !!pickup && r.slot.item !== null, `item ${r.slot.item}, rolling ${r.slot.rolling.toFixed(2)}s`);
  const crate = items.crates.find((c) => pickup && pickup.type === 'pickup' && c.id === pickup.crate)!;
  check('crate disappears then respawns after ~4 s', !crate.active, `active=${crate.active}`);
  const held = r.slot.item;
  press(r);
  run(items, [r], 0.2, t);
  check('cannot use during the roulette', r.slot.item === held, `still holding ${r.slot.item}`);
  r.input.item = false;
  r.input.throttle = 0;
  const after = run(items, [r], 4, t + 0.2);
  check('roulette ends with a "rolled" event', after.events.some((e) => e.type === 'rolled'), `item ${r.slot.item}`);
  check('crate respawned', crate.active, `active=${crate.active}`);
}

{
  // Second slot: a crate picked up while holding an item goes to the reserve,
  // and the reserve moves up once the main item is used.
  const items = new ItemSystem(track, 11);
  const r = racerAt('r', 0, 0, 2);
  r.slot.item = 'oil';
  r.slot.rolling = 0;
  const c = items.crates[0];
  r.kart.x = c.x;
  r.kart.z = c.z;
  r.kart.y = c.y;
  items.step(1 / 60, 0, [r], []);
  check('second crate fills the reserve', r.slot.item === 'oil' && r.slot.reserve !== null, `reserve ${r.slot.reserve}`);
  const reserved = r.slot.reserve;
  for (let t = 0; t < ITEM_TUNING.rollTime + 0.1; t += 1 / 60) items.step(1 / 60, 0.1, [r], []);
  r.input.item = true;
  items.step(1 / 60, 2, [r], []);
  check('using the item promotes the reserve', r.slot.item === reserved && r.slot.reserve === null, `item ${r.slot.item}`);
}

// Helper to force an item into a slot.
function give(r: ItemRacer, item: ItemType) {
  r.slot.item = item;
  r.slot.rolling = 0;
  r.slot.usePrev = false;
}

// 3. Express boost.
{
  const items = new ItemSystem(track, 1);
  const r = racerAt('p', 40);
  give(r, 'express');
  press(r);
  run(items, [r], FIXED_DT * 2);
  check('express gives a 3 s boost', Math.abs(r.kart.boostTime - ITEM_TUNING.boostTime) < 0.1 && r.slot.item === null, `boost ${r.kart.boostTime.toFixed(2)}s`);
}

// 4. Oil: owner immune, follower spins.
{
  const items = new ItemSystem(track, 1);
  const a = racerAt('a', 60, 0, 1);
  const b = racerAt('b', 45, 0, 2);
  a.input.throttle = 1;
  b.input.throttle = 1;
  give(a, 'oil');
  press(a);
  let hitAt = -1;
  const { events } = run(items, [a, b], 3, 0, (t) => {
    if (hitAt < 0 && b.kart.spinTime > 0) hitAt = t;
  });
  const hit = events.find((e) => e.type === 'hit');
  check('oil spins out the kart behind', !!hit && hit.type === 'hit' && hit.racer === 'b' && hit.cause === 'oil', `hit at ${hitAt.toFixed(2)}s`);
  check('oil does not hit its owner', a.kart.spinTime === 0 && !events.some((e) => e.type === 'hit' && e.racer === 'a'), 'owner fine');
  check('puddle is consumed', items.hazards.length === 0, `${items.hazards.length} hazards left`);
}

// 5. Carton: hits the kart ahead on a straight; bounces off walls.
{
  const items = new ItemSystem(track, 1);
  const a = racerAt('a', 20, 0, 2);
  const b = racerAt('b', 45, 0, 1);
  give(a, 'carton');
  press(a);
  const { events } = run(items, [a, b], 2);
  check('carton hits the kart ahead', events.some((e) => e.type === 'hit' && e.racer === 'b' && e.cause === 'carton'), `b spin ${b.kart.spinTime.toFixed(2)}`);

  const items2 = new ItemSystem(track, 1);
  const c = racerAt('c', 30);
  c.kart.heading += 0.9; // aim diagonally at the rack wall
  give(c, 'carton');
  press(c);
  const r2 = run(items2, [c], 1.5);
  const bounces = r2.events.filter((e) => e.type === 'bounce').length;
  check('carton bounces off the racking', bounces >= 2, `${bounces} bounces`);
}

// 6. Tracked parcel: homes onto the kart ahead even when offset.
{
  const items = new ItemSystem(track, 1);
  const a = racerAt('a', 15, -2.5, 2);
  const b = racerAt('b', 70, 2.8, 1);
  b.input.throttle = 0.6;
  give(a, 'tracked');
  press(a);
  const { events } = run(items, [a, b], 6);
  check('tracked parcel homes onto the kart ahead', events.some((e) => e.type === 'hit' && e.racer === 'b' && e.cause === 'tracked'), `b spin ${b.kart.spinTime.toFixed(2)}`);
  // Around a hairpin: target placed after the east hairpin.
  const items2 = new ItemSystem(track, 1);
  const c = racerAt('c', 50, 0, 2);
  const d = racerAt('d', 112, 0, 1);
  give(c, 'tracked');
  press(c);
  const r2 = run(items2, [c, d], 8);
  check('tracked parcel follows the track round a hairpin', r2.events.some((e) => e.type === 'hit' && e.racer === 'd'), `d spin ${d.kart.spinTime.toFixed(2)}`);
}

// 7. Film shield absorbs one hit.
{
  const items = new ItemSystem(track, 1);
  const a = racerAt('a', 20, 0, 2);
  const b = racerAt('b', 40, 0, 1);
  give(b, 'film');
  press(b);
  run(items, [a, b], 0.1);
  b.input.item = false;
  check('film gives a shield', b.slot.shield > 11, `shield ${b.slot.shield.toFixed(1)}s`);
  give(a, 'carton');
  press(a);
  const r1 = run(items, [a, b], 1.5, 0.1);
  check('shield blocks the first hit', r1.events.some((e) => e.type === 'blocked' && e.racer === 'b') && b.kart.spinTime === 0 && b.slot.shield === 0, `spin ${b.kart.spinTime}`);
  a.input.item = false;
  run(items, [a, b], 0.1, 1.6);
  give(a, 'carton');
  press(a);
  const r2 = run(items, [a, b], 1.5, 1.7);
  check('second hit spins the kart', r2.events.some((e) => e.type === 'hit' && e.racer === 'b'), `spin ${b.kart.spinTime.toFixed(2)}`);
}

// 8. Pallet drops ahead of the kart in front, blocks for a while, then clears.
{
  const items = new ItemSystem(track, 1);
  const a = racerAt('a', 20, 0, 2);
  const b = racerAt('b', 40, 2, 1);
  give(a, 'pallet');
  press(a);
  run(items, [a, b], 0.05);
  const h = items.hazards[0];
  const hs = h ? nearestSample(track, h.x, h.z, null).s : -1;
  check('pallet targets 14 m ahead of the kart in front', !!h && Math.abs(hs - 54) < 3, `pallet at s=${hs}`);
  check('pallet only collides after landing', items.colliders().length === 0, `${items.colliders().length} colliders while falling`);
  run(items, [a, b], 1.0, 0.05);
  check('landed pallet is a wall', items.colliders().length === 1, `${items.colliders().length} colliders`);
  const lane = Math.abs((h.x - sampleAtS(track, hs).x) * -sampleAtS(track, hs).tz + (h.z - sampleAtS(track, hs).z) * sampleAtS(track, hs).tx);
  check('a lane stays open next to the pallet', sampleAtS(track, hs).hw - lane - ITEM_TUNING.palletHalfWidth >= 1.7, `free width ${(sampleAtS(track, hs).hw * 2 - ITEM_TUNING.palletHalfWidth * 2).toFixed(1)} m total`);
  run(items, [a, b], 8.5, 1.05);
  check('pallet clears after ~8 s', items.hazards.length === 0, `${items.hazards.length} hazards`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll item checks passed');
process.exit(failures ? 1 : 0);
