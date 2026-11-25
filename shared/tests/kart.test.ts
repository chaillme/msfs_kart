// Deterministic driving checks for the shared arcade physics (run: npm run test:physics).
import { collideKarts, collideKartWithStatics, type StaticCollider } from '../src/collision';
import { createKartState, DEFAULT_KART_PARAMS as P, FIXED_DT, stepKart, type KartInput, type KartState } from '../src/kart';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures += 1;
}
function run(s: KartState, input: Partial<KartInput>, seconds: number, statics: StaticCollider[] = [], onStep?: () => void) {
  const inp: KartInput = { throttle: 0, steer: 0, drift: false, item: false, ...input };
  for (let t = 0; t < seconds; t += FIXED_DT) {
    stepKart(s, inp, FIXED_DT, P);
    collideKartWithStatics(s, statics, P);
    onStep?.();
  }
}
const kmh = (v: number) => (v * 3.6).toFixed(0) + ' km/h';

// 1. Acceleration curve
{
  const s = createKartState();
  run(s, { throttle: 1 }, 1);
  const v1 = s.forwardSpeed;
  run(s, { throttle: 1 }, 2);
  check('accelerates quickly', v1 > 10 && s.forwardSpeed > P.maxSpeed * 0.95, `1s=${kmh(v1)} 3s=${kmh(s.forwardSpeed)}`);
  check('top speed capped', s.forwardSpeed <= P.maxSpeed + 0.01, kmh(s.forwardSpeed));
  // 2. Brake then reverse
  let tStop = 0;
  const st = { t: 0 };
  run(s, { throttle: -1 }, 3, [], () => { st.t += FIXED_DT; if (!tStop && s.forwardSpeed <= 0) tStop = st.t; });
  check('brakes to stop < 1s', tStop > 0 && tStop < 1, `stop in ${tStop.toFixed(2)}s`);
  check('reverses, capped', s.forwardSpeed < -P.maxReverse * 0.9 && s.forwardSpeed >= -P.maxReverse - 0.01, kmh(s.forwardSpeed));
}

// 3. Turning circle at speed
{
  const s = createKartState();
  run(s, { throttle: 1 }, 2);
  const h0 = s.heading;
  run(s, { throttle: 1, steer: 1 }, 1);
  const turned = h0 - s.heading;
  check('steer right turns right (heading decreases)', turned > 1, `${turned.toFixed(2)} rad in 1s`);
}

// 4. Drift: charge levels, boost on release
{
  const s = createKartState();
  run(s, { throttle: 1 }, 2);
  let maxLevel = 0;
  run(s, { throttle: 1, steer: -1, drift: true }, 3.2, [], () => { maxLevel = Math.max(maxLevel, s.driftLevel); });
  check('drift engages and charges to level 3', s.driftDir === -1 && maxLevel === 3, `dir=${s.driftDir} maxLevel=${maxLevel}`);
  const lateral = Math.abs(s.vx * Math.cos(s.heading) - s.vz * Math.sin(s.heading));
  check('drift slides sideways', lateral > 1.5, `lateral ${lateral.toFixed(1)} m/s`);
  check('drift keeps speed', s.forwardSpeed > P.maxSpeed * 0.75, kmh(s.forwardSpeed));
  let boostEvent = 0;
  run(s, { throttle: 1 }, FIXED_DT, [], () => { boostEvent = Math.max(boostEvent, s.boostEvent); });
  check('release grants mini-turbo', boostEvent === 3 && s.boostTime > 1.3, `event=${boostEvent} boost=${s.boostTime.toFixed(2)}s`);
  let vmax = 0;
  run(s, { throttle: 1 }, 1, [], () => { vmax = Math.max(vmax, s.forwardSpeed); });
  check('boost exceeds normal top speed', vmax > P.maxSpeed * 1.25, kmh(vmax));
}

// 5. Short drift (< level 1) gives no boost
{
  const s = createKartState();
  run(s, { throttle: 1 }, 2);
  run(s, { throttle: 1, steer: 1, drift: true }, 0.4);
  run(s, { throttle: 1 }, FIXED_DT);
  check('tap drift gives no boost', s.boostTime === 0, `boost=${s.boostTime}`);
}

// 6. Head-on wall: bounces back, never stuck
{
  const wall: StaticCollider = { kind: 'box', x: 0, z: 20, hx: 10, hz: 0.5, angle: 0 };
  const s = createKartState(0, 0, 0);
  let minGap = Infinity;
  run(s, { throttle: 1 }, 2.5, [wall], () => { minGap = Math.min(minGap, 19.5 - s.z); });
  check('never penetrates wall', minGap > 0.5, `closest front-circle gap ${(minGap - 0.55 - 0.72).toFixed(2)} m`);
  // reverse out
  run(s, { throttle: -1 }, 1.5, [wall]);
  check('can reverse away from wall', s.z < 17, `z=${s.z.toFixed(1)}`);
}

// 7. Glancing wall: slides along, keeps most speed
{
  const wall: StaticCollider = { kind: 'box', x: 5, z: 0, hx: 0.5, hz: 100, angle: 0 };
  const s = createKartState(0, 0, 0.35); // heading slightly toward +x wall
  run(s, { throttle: 1 }, 2, []);
  const before = s.forwardSpeed;
  s.x = 2;
  run(s, { throttle: 1 }, 1.5, [wall]);
  check('glancing hit slides along wall', s.forwardSpeed > before * 0.6 && s.x < 4.5, `speed ${kmh(before)} -> ${kmh(s.forwardSpeed)}, x=${s.x.toFixed(2)}`);
}

// 8. Kart-kart push
{
  const a = createKartState(0, 0, 0);
  const b = createKartState(0, 6, 0);
  const inp: KartInput = { throttle: 1, steer: 0, drift: false, item: false };
  const idle: KartInput = { throttle: 0, steer: 0, drift: false, item: false };
  for (let t = 0; t < 1.5; t += FIXED_DT) {
    stepKart(a, inp, FIXED_DT, P);
    stepKart(b, idle, FIXED_DT, P);
    collideKarts(a, b, P);
  }
  const dist = Math.hypot(a.x - b.x, a.z - b.z);
  check('pushes a parked kart', b.z > 8, `b moved to z=${b.z.toFixed(1)}`);
  check('karts do not overlap', dist > 1.3, `centre distance ${dist.toFixed(2)} m`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll physics checks passed');
process.exit(failures ? 1 : 0);
