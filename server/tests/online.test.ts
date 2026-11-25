// End-to-end multiplayer checks against a real server over WebSockets (run: npm run test:online).
import WebSocket from 'ws';
import { createKartState } from '../../shared/src/kart';
import { packInput, unpackKart, type ClientMessage, type ServerMessage, type Snapshot } from '../../shared/src/net';
import { buildTrack, sampleAtS } from '../../shared/src/track';
import { WAREHOUSE_TRACK } from '../../shared/src/tracks/warehouse';
import { startServer } from '../src/app';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures += 1;
}

const SPEED = 4;
const track = buildTrack(WAREHOUSE_TRACK);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TestClient {
  ws!: WebSocket;
  id = '';
  token = '';
  messages: ServerMessage[] = [];
  lastLobby: Extract<ServerMessage, { t: 'lobby' }> | null = null;
  lastSnap: Snapshot | null = null;
  snaps = 0;
  results: Extract<ServerMessage, { t: 'results' }> | null = null;
  raceStart: Extract<ServerMessage, { t: 'raceStart' }> | null = null;
  errors: string[] = [];
  seq = 0;
  driving = false;

  constructor(
    private readonly url: string,
    readonly name: string,
  ) {}

  async connect(token?: string): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (data) => this.onMessage(JSON.parse(data.toString()) as ServerMessage));
    this.send({ t: 'hello', name: this.name, color: '#e8202a', token });
    await this.waitFor(() => this.id !== '');
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMessage): void {
    this.messages.push(msg);
    if (msg.t === 'welcome') {
      this.id = msg.id;
      this.token = msg.token;
    } else if (msg.t === 'lobby') this.lastLobby = msg;
    else if (msg.t === 'error') this.errors.push(msg.message);
    else if (msg.t === 'raceStart') this.raceStart = msg;
    else if (msg.t === 'results') this.results = msg;
    else if (msg.t === 'snap') {
      this.lastSnap = msg.s;
      this.snaps += 1;
      // Drive with a simple pure-pursuit autopilot: 3 inputs per snapshot (60 Hz / 20 Hz).
      if (this.driving) for (let i = 0; i < 3; i += 1) this.sendDriveInput(msg.s);
    }
  }

  private sendDriveInput(s: Snapshot): void {
    const me = s.racers.find((r) => r.id === this.id);
    if (!me) return;
    const k = unpackKart(me.k, createKartState());
    const target = sampleAtS(track, me.p[7] + 5 + Math.abs(k.forwardSpeed) * 0.35);
    let diff = Math.atan2(target.x - k.x, target.z - k.z) - k.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const throttle = s.phase === 'countdown' ? (s.time > 3.0 ? 1 : 0) : Math.abs(diff) > 0.55 && k.forwardSpeed > 9 ? -0.4 : 1;
    this.seq += 1;
    this.send({ t: 'input', seq: this.seq, i: packInput({ throttle, steer: Math.max(-1, Math.min(1, -diff * 2.8)), drift: false, item: me.i[0] >= 0 }) });
  }

  async waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) return false;
      await sleep(10);
    }
    return true;
  }

  close(): void {
    this.ws.close();
  }
}

const server = await startServer(0, '127.0.0.1', true, SPEED);
const url = `ws://127.0.0.1:${server.port}/ws`;

try {
  // 1. Lobby: create, join, wrong code, host migration.
  const a = new TestClient(url, 'Alice');
  const b = new TestClient(url, 'Bob');
  await a.connect();
  await b.connect();
  check('hello -> welcome with id and token', a.id.length > 0 && a.token.length > 10, `id ${a.id}`);
  a.send({ t: 'create' });
  await a.waitFor(() => !!a.lastLobby);
  const code = a.lastLobby!.code;
  check('create gives a 4-letter room code', /^[A-Z]{4}$/.test(code), code);
  b.send({ t: 'join', code: 'ZZZZ' === code ? 'YYYY' : 'ZZZZ' });
  await b.waitFor(() => b.errors.length > 0);
  check('joining an unknown code is refused', b.errors.length === 1, b.errors[0] ?? '');
  b.send({ t: 'join', code: code.toLowerCase() });
  await a.waitFor(() => a.lastLobby!.players.length === 2);
  check('second player joins (code is case-insensitive)', a.lastLobby!.players.length === 2 && b.lastLobby?.code === code, a.lastLobby!.players.map((p) => `${p.name}${p.isHost ? '*' : ''}`).join(', '));
  b.send({ t: 'start', fillBots: true });
  await b.waitFor(() => b.errors.length > 1);
  check('only the host can start', b.errors[1]?.includes('hôte') ?? false, b.errors[1] ?? '');

  // Host migration in the lobby.
  const c = new TestClient(url, 'Chloé');
  await c.connect();
  c.send({ t: 'join', code });
  await a.waitFor(() => a.lastLobby!.players.length === 3);
  a.close();
  await b.waitFor(() => b.lastLobby!.players.length === 2);
  const host = b.lastLobby!.players.find((p) => p.isHost);
  check('host leaving the lobby hands host to the next player', host?.name === 'Bob', `new host ${host?.name}`);
  c.send({ t: 'leave' });
  await b.waitFor(() => b.lastLobby!.players.length === 1);

  // 2. Race: Bob (host) + Dan, filled with bots.
  const d = new TestClient(url, 'Dan');
  await d.connect();
  d.send({ t: 'join', code });
  await b.waitFor(() => b.lastLobby!.players.length === 2);
  b.driving = true;
  d.driving = true;
  b.send({ t: 'start', fillBots: true });
  await b.waitFor(() => !!b.raceStart && !!d.raceStart);
  check('race starts for both players with 6 racers', b.raceStart?.setups.length === 6 && d.raceStart?.seed === b.raceStart?.seed, `${b.raceStart?.setups.map((s) => s.name).join(', ')}`);
  const late = new TestClient(url, 'Eve');
  await late.connect();
  late.send({ t: 'join', code });
  await late.waitFor(() => late.errors.length > 0);
  check('cannot join a room while racing', late.errors[0]?.includes('cours') ?? false, late.errors[0] ?? '');

  const snapsBefore = b.snaps;
  const t0 = Date.now();
  await sleep(1000);
  const rate = ((b.snaps - snapsBefore) / ((Date.now() - t0) / 1000)) / SPEED;
  check('snapshots at ~20 Hz (sim time)', rate > 16 && rate < 24, `${rate.toFixed(1)} Hz`);
  await b.waitFor(() => b.lastSnap?.phase === 'racing', 5000);
  const me = b.lastSnap!.racers.find((r) => r.id === b.id)!;
  check('server acknowledges input sequence numbers', me.ack > 0 && me.ack <= b.seq, `ack ${me.ack}, sent ${b.seq}`);

  // 3. Disconnect mid-race -> AI drives; reconnect with token -> control is back.
  await b.waitFor(() => (b.lastSnap?.time ?? 0) > 20, 20000);
  const dToken = d.token;
  const dId = d.id;
  d.close();
  await b.waitFor(() => b.lastSnap!.racers.find((r) => r.id === dId)?.dc === 1, 3000);
  const dcState = b.lastSnap!.racers.find((r) => r.id === dId)!;
  check('disconnected player is flagged and driven by the AI', dcState.dc === 1 && dcState.ai === 1, `dc=${dcState.dc} ai=${dcState.ai}`);
  const lobbyDc = b.lastLobby!.players.find((p) => p.id === dId);
  check('lobby shows the player as disconnected', lobbyDc?.connected === false, `connected=${lobbyDc?.connected}`);
  await sleep(1500);
  const d2 = new TestClient(url, 'Dan');
  d2.driving = true;
  await d2.connect(dToken);
  await d2.waitFor(() => !!d2.raceStart && !!d2.lastSnap, 3000);
  const back = d2.lastSnap!.racers.find((r) => r.id === dId);
  check('reconnect with token resumes the same racer', d2.id === dId && !!d2.raceStart && back?.dc === 0, `same id=${d2.id === dId}, dc=${back?.dc}`);
  await d2.waitFor(() => d2.lastSnap!.racers.find((r) => r.id === dId)?.ai === 0, 2000);
  check('control is handed back to the player', d2.lastSnap!.racers.find((r) => r.id === dId)?.ai === 0, `ai=${d2.lastSnap!.racers.find((r) => r.id === dId)?.ai}`);

  // 4. Race completes, everyone gets results.
  const done = await b.waitFor(() => !!b.results && !!d2.results, 60000);
  const table = b.results?.results.map((r) => `${r.position}.${r.name} ${r.time.toFixed(1)}s`).join(' | ') ?? '';
  check('race finishes and both players get the results', done && b.results!.results.length === 6, table);
  const lapsSeen = b.messages.filter((m) => m.t === 'snap').flatMap((m) => (m.t === 'snap' ? m.s.events : [])).filter((e) => e.type === 'lap').length;
  check('race events (laps) are delivered in snapshots', lapsSeen >= 6, `${lapsSeen} lap events`);
  const snapSize = JSON.stringify(b.messages.find((m) => m.t === 'snap')).length;
  check('snapshot size is reasonable', snapSize < 6000, `${snapSize} bytes ≈ ${((snapSize * 20) / 1024).toFixed(0)} KB/s per player`);
  b.send({ t: 'backToLobby' });
  await b.waitFor(() => b.lastLobby?.state === 'waiting');
  check('host can bring everyone back to the lobby', b.lastLobby?.state === 'waiting' && d2.lastLobby?.state === 'waiting', `state ${b.lastLobby?.state}`);

  for (const cl of [b, c, d2, late]) cl.close();
} finally {
  await server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll online checks passed');
process.exit(failures ? 1 : 0);
