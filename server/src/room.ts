import { BOT_ROSTER } from '../../shared/src/bot';
import { FIXED_DT, NEUTRAL_INPUT, type KartInput } from '../../shared/src/kart';
import {
  ITEM_INDEX,
  MAX_PLAYERS,
  packKart,
  type PlayerInfo,
  type RacerSetupWire,
  type ServerMessage,
  type Snapshot,
} from '../../shared/src/net';
import { RaceSession, type RaceEvent, type RacerSetup } from '../../shared/src/session';
import type { ItemEvent } from '../../shared/src/items';
import type { Track } from '../../shared/src/track';

const SNAPSHOT_EVERY = 3; // 60 Hz sim / 3 = 20 Hz snapshots
const MAX_QUEUED_INPUTS = 6;
const BOT_COLORS = ['#2f8cff', '#2fa84f', '#f2c230', '#8e5bd6', '#ff8a1e', '#19b5b0'];

export interface Member {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  send: (msg: ServerMessage) => void;
  joinOrder: number;
}

interface InputState {
  queue: { seq: number; input: KartInput }[];
  last: KartInput;
  ack: number;
  /** Ticks since the last input arrived (hidden tab, lag): go neutral after a while. */
  starved: number;
}

const STARVED_TICKS = 30;

/** One lobby / race. Owns the authoritative RaceSession while racing. */
export class Room {
  readonly members = new Map<string, Member>();
  hostId = '';
  state: 'waiting' | 'racing' | 'results' = 'waiting';
  session: RaceSession | null = null;
  setups: RacerSetupWire[] = [];
  seed = 1;
  private tick = 0;
  private joinCounter = 0;
  private readonly inputs = new Map<string, InputState>();
  private pendingEvents: RaceEvent[] = [];
  private pendingItemEvents: ItemEvent[] = [];
  private resultsSent = false;

  constructor(
    readonly code: string,
    private readonly track: Track,
  ) {}

  get humanCount(): number {
    return this.members.size;
  }

  get connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.connected) n += 1;
    return n;
  }

  add(member: Omit<Member, 'joinOrder'>): string | null {
    if (this.state !== 'waiting') return 'Une course est déjà en cours dans ce salon.';
    if (this.members.size >= MAX_PLAYERS) return 'Salon complet (6 joueurs maximum).';
    this.joinCounter += 1;
    this.members.set(member.id, { ...member, joinOrder: this.joinCounter });
    if (!this.hostId) this.hostId = member.id;
    this.broadcastLobby();
    return null;
  }

  /** Remove a member for good (left the lobby, or gone when the race ended). */
  remove(id: string): void {
    this.members.delete(id);
    this.inputs.delete(id);
    if (this.hostId === id) this.hostId = this.pickHost();
    this.broadcastLobby();
  }

  private pickHost(): string {
    const list = [...this.members.values()].filter((m) => m.connected).sort((a, b) => a.joinOrder - b.joinOrder);
    return list[0]?.id ?? [...this.members.keys()][0] ?? '';
  }

  /** Socket dropped. In the lobby the player leaves; in a race the AI takes over. */
  disconnect(id: string): void {
    const m = this.members.get(id);
    if (!m) return;
    if (this.state === 'waiting') {
      this.remove(id);
      return;
    }
    m.connected = false;
    this.session?.setAutoDrive(id, true);
    if (this.hostId === id) this.hostId = this.pickHost();
    this.broadcastLobby();
  }

  /** Same player came back (token) while the race is still on. */
  reconnect(id: string, send: (msg: ServerMessage) => void): void {
    const m = this.members.get(id);
    if (!m) return;
    m.connected = true;
    m.send = send;
    if (!this.hostId || !this.members.get(this.hostId)?.connected) this.hostId = id;
    this.broadcastLobby();
    if (this.session && this.state === 'racing') {
      send({ t: 'raceStart', seed: this.seed, setups: this.setups, you: id });
      const r = this.session.racer(id);
      if (r && r.finishTime === null) this.session.setAutoDrive(id, false);
      const st = this.inputs.get(id);
      if (st) st.queue.length = 0;
    } else if (this.state === 'results' && this.session) {
      send({ t: 'results', results: this.session.results() });
    }
  }

  setProfile(id: string, name: string, color: string): void {
    const m = this.members.get(id);
    if (!m || this.state !== 'waiting') return;
    m.name = name;
    m.color = color;
    this.broadcastLobby();
  }

  lobbyInfo(): PlayerInfo[] {
    return [...this.members.values()]
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((m) => ({ id: m.id, name: m.name, color: m.color, connected: m.connected, isHost: m.id === this.hostId }));
  }

  broadcast(msg: ServerMessage): void {
    for (const m of this.members.values()) if (m.connected) m.send(msg);
  }

  broadcastLobby(): void {
    this.broadcast({ t: 'lobby', code: this.code, state: this.state, players: this.lobbyInfo() });
  }

  start(requester: string, fillBots: boolean): string | null {
    if (requester !== this.hostId) return "Seul l'hôte peut lancer la course.";
    if (this.state !== 'waiting') return 'La course a déjà commencé.';
    const humans = [...this.members.values()].sort((a, b) => a.joinOrder - b.joinOrder);
    const botCount = fillBots ? MAX_PLAYERS - humans.length : 0;
    if (humans.length + botCount < 2) return 'Il faut au moins 2 pilotes (ou cochez « compléter avec des bots »).';

    this.seed = (Date.now() % 100000) + 1;
    // Distinct colours: humans keep theirs, duplicates are nudged.
    const used = new Set<string>();
    const setups: RacerSetupWire[] = [];
    for (let i = 0; i < botCount; i += 1) {
      setups.push({ id: `bot${i}`, name: BOT_ROSTER[i].name, color: BOT_COLORS[i], bot: true, botIndex: i });
    }
    // Humans start behind the bots, in a seed-shuffled order.
    const order = humans.map((h, i) => ({ h, k: ((i + 1) * 9301 + this.seed * 49297) % 233280 })).sort((a, b) => a.k - b.k);
    for (const { h } of order) {
      let color = h.color;
      if (used.has(color)) color = BOT_COLORS.find((c) => !used.has(c)) ?? color;
      used.add(color);
      setups.push({ id: h.id, name: h.name, color, bot: false });
    }
    this.setups = setups;
    const sessionSetups: RacerSetup[] = setups.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      bot: s.bot ? BOT_ROSTER[s.botIndex ?? 0] : undefined,
    }));
    this.session = new RaceSession(this.track, sessionSetups, { seed: this.seed, rubberBand: false });
    this.inputs.clear();
    for (const h of humans) this.inputs.set(h.id, { queue: [], last: { ...NEUTRAL_INPUT }, ack: 0, starved: 0 });
    this.tick = 0;
    this.pendingEvents = [];
    this.pendingItemEvents = [];
    this.resultsSent = false;
    this.state = 'racing';
    for (const m of this.members.values()) {
      if (m.connected) m.send({ t: 'raceStart', seed: this.seed, setups, you: m.id });
    }
    this.broadcastLobby();
    return null;
  }

  backToLobby(requester: string): void {
    if (requester !== this.hostId || this.state === 'waiting') return;
    this.state = 'waiting';
    this.session = null;
    for (const m of [...this.members.values()]) if (!m.connected) this.members.delete(m.id);
    if (!this.members.has(this.hostId)) this.hostId = this.pickHost();
    this.broadcastLobby();
  }

  queueInput(id: string, seq: number, input: KartInput): void {
    const st = this.inputs.get(id);
    if (!st || seq <= st.ack) return;
    st.queue.push({ seq, input });
    // A client running fast (or a lag burst) must not build up latency.
    while (st.queue.length > MAX_QUEUED_INPUTS) st.queue.shift();
  }

  /** Advance the authoritative race by one fixed step. */
  step(): void {
    const session = this.session;
    if (!session || this.state !== 'racing') return;
    for (const [id, st] of this.inputs) {
      const next = st.queue.shift();
      if (next) {
        st.last = next.input;
        st.ack = next.seq;
        st.starved = 0;
      } else if ((st.starved += 1) > STARVED_TICKS) {
        st.last = { ...NEUTRAL_INPUT };
      }
      session.setInput(id, st.last);
    }
    session.step(FIXED_DT);
    this.pendingEvents.push(...session.events);
    this.pendingItemEvents.push(...session.items.events);
    this.tick += 1;
    if (this.tick % SNAPSHOT_EVERY === 0) this.sendSnapshot();
    if (session.phase === 'finished' && !this.resultsSent) {
      this.sendSnapshot();
      this.resultsSent = true;
      this.state = 'results';
      this.broadcast({ t: 'results', results: session.results() });
      this.broadcastLobby();
    }
  }

  buildSnapshot(): Snapshot {
    const session = this.session!;
    const items = session.items;
    return {
      tick: this.tick,
      time: session.time,
      phase: session.phase,
      racers: session.racers.map((r) => {
        const p = r.prog;
        const member = this.members.get(r.id);
        return {
          id: r.id,
          k: packKart(r.kart),
          p: [
            p.lap,
            r.rank,
            r.finishTime ?? -1,
            r.finishPosition ?? 0,
            Number.isFinite(p.bestLap) ? p.bestLap : -1,
            p.lapStartTime,
            p.wrongWayTime,
            p.s,
            p.nextGate,
            Math.max(0, r.stall),
          ],
          i: [
            r.slot.item ? ITEM_INDEX.indexOf(r.slot.item) : -1,
            r.slot.rolling,
            r.slot.shield,
            r.slot.reserve ? ITEM_INDEX.indexOf(r.slot.reserve) : -1,
            r.slot.reserveRolling,
          ],
          ack: this.inputs.get(r.id)?.ack ?? 0,
          ai: r.isBot || r.autoDrive ? 1 : 0,
          dc: member && !member.connected ? 1 : 0,
        };
      }),
      crates: items.crates.map((c) => (c.active ? '1' : '0')).join(''),
      projectiles: items.projectiles.map((p) => ({ id: p.id, kind: p.kind, owner: p.owner, x: p.x, y: p.y, z: p.z, vx: p.vx, vz: p.vz })),
      hazards: items.hazards.map((h) => ({ id: h.id, kind: h.kind, owner: h.owner, x: h.x, y: h.y, z: h.z, angle: h.angle, age: h.age, fall: h.fall })),
      events: this.pendingEvents,
      itemEvents: this.pendingItemEvents,
    };
  }

  private sendSnapshot(): void {
    const s = this.buildSnapshot();
    this.pendingEvents = [];
    this.pendingItemEvents = [];
    this.broadcast({ t: 'snap', s });
  }
}
