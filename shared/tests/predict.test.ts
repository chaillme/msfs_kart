// Client prediction + reconciliation under simulated latency (run: npm run test:predict).
import { createKartState, DEFAULT_KART_PARAMS as P, FIXED_DT, stepKart, type KartInput } from '../src/kart';
import { collideKartWithStatics, collideKartWithTrack } from '../src/collision';
import { packKart, unpackKart } from '../src/net';
import { Predictor } from '../src/predict';
import { buildTrack, gridSlot, sampleAtS, trackHeight } from '../src/track';
import { WAREHOUSE_TRACK } from '../src/tracks/warehouse';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures += 1;
}

const track = buildTrack(WAREHOUSE_TRACK);
const ground = (x: number, z: number) => trackHeight(track, x, z);

/** Scripted driver input for tick n (accelerate, weave, drift bursts). */
function inputAt(n: number, kart: { x: number; z: number; heading: number; forwardSpeed: number }, s: number): KartInput {
  const target = sampleAtS(track, s + 6 + Math.abs(kart.forwardSpeed) * 0.35);
  let diff = Math.atan2(target.x - kart.x, target.z - kart.z) - kart.heading;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return {
    throttle: Math.abs(diff) > 0.55 && kart.forwardSpeed > 9 ? -0.4 : 1,
    steer: Math.max(-1, Math.min(1, -diff * 2.8 + Math.sin(n * 0.05) * 0.2)),
    drift: n % 300 > 200 && kart.forwardSpeed > 10,
    item: false,
  };
}

function runScenario(latencyTicks: number, seconds: number) {
  const g = gridSlot(track, 0);
  const server = createKartState(g.x, g.z, g.heading);
  server.y = ground(g.x, g.z);
  const client = new Predictor(track, server);
  // Messages in flight: client->server inputs and server->client snapshots, each delayed by half the RTT.
  const toServer: { at: number; seq: number; input: KartInput }[] = [];
  const toClient: { at: number; state: number[]; ack: number }[] = [];
  let serverAck = 0;
  let serverInput: KartInput = { throttle: 0, steer: 0, drift: false, item: false };
  let maxCorrection = 0;
  let sumCorrection = 0;
  let corrections = 0;
  let s = 0;
  const half = Math.ceil(latencyTicks / 2);
  const ticks = Math.round(seconds / FIXED_DT);
  let maxPredictionLead = 0;
  for (let n = 0; n < ticks; n += 1) {
    // Client: input from its own (predicted) view, applied immediately.
    s = Math.max(s, sampleS(client.state.x, client.state.z, s));
    const input = inputAt(n, client.state, s);
    const seq = client.nextSeq();
    client.apply(seq, input, P, track.def.obstacles);
    toServer.push({ at: n + half, seq, input });
    // Server: consume inputs that arrived, one per tick.
    const arrived = toServer.filter((m) => m.at <= n);
    if (arrived.length) {
      const m = arrived[0];
      toServer.splice(toServer.indexOf(m), 1);
      serverInput = m.input;
      serverAck = m.seq;
    }
    stepKart(server, serverInput, FIXED_DT, P, ground);
    collideKartWithTrack(server, track, P);
    collideKartWithStatics(server, track.def.obstacles, P);
    server.y = ground(server.x, server.z);
    if (n % 3 === 0) toClient.push({ at: n + half, state: packKart(server), ack: serverAck });
    // Client: apply snapshots that arrived.
    while (toClient.length && toClient[0].at <= n) {
      const snap = toClient.shift()!;
      const corr = client.reconcile(unpackKart(snap.state, createKartState()), snap.ack, P, track.def.obstacles);
      maxCorrection = Math.max(maxCorrection, corr);
      sumCorrection += corr;
      corrections += 1;
    }
    maxPredictionLead = Math.max(maxPredictionLead, client.pendingCount);
  }
  return { maxCorrection, avgCorrection: sumCorrection / Math.max(1, corrections), maxPredictionLead, travelled: s };
}

function sampleS(x: number, z: number, around: number): number {
  let best = around;
  let bd = Infinity;
  for (let d = -5; d <= 20; d += 1) {
    const smp = sampleAtS(track, around + d);
    const dist = (smp.x - x) ** 2 + (smp.z - z) ** 2;
    if (dist < bd) {
      bd = dist;
      best = around + d;
    }
  }
  return best;
}

for (const [label, rtt] of [
  ['LAN (RTT 33 ms)', 2],
  ['Internet (RTT 100 ms)', 6],
  ['Mauvais réseau (RTT 250 ms)', 15],
] as const) {
  const r = runScenario(rtt, 40);
  check(
    `prediction stays in sync: ${label}`,
    r.maxCorrection < 0.05,
    `max correction ${(r.maxCorrection * 100).toFixed(2)} cm, avg ${(r.avgCorrection * 100).toFixed(3)} cm, ${r.maxPredictionLead} inputs ahead, ${r.travelled.toFixed(0)} m driven`,
  );
}

// A server-side event the client could not predict (e.g. being hit) is corrected in one snapshot.
{
  const g = gridSlot(track, 0);
  const server = createKartState(g.x, g.z, g.heading);
  const client = new Predictor(track, server);
  const inp: KartInput = { throttle: 1, steer: 0, drift: false, item: false };
  for (let n = 0; n < 60; n += 1) {
    client.apply(client.nextSeq(), inp, P, []);
    stepKart(server, inp, FIXED_DT, P, ground);
  }
  server.vx *= 0.2;
  server.vz *= 0.2;
  server.spinTime = 1;
  server.spinDuration = 1;
  const corr = client.reconcile(server, 60, P, []);
  check('unpredicted hit is corrected on the next snapshot', corr < 0.01 && client.state.spinTime === 1, `state now spinning, residual ${corr.toFixed(4)} m`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll prediction checks passed');
process.exit(failures ? 1 : 0);
