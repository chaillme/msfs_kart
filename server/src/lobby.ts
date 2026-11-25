import { randomBytes, randomUUID } from 'node:crypto';
import { NEUTRAL_INPUT } from '../../shared/src/kart';
import { normaliseCode, PLAYER_COLORS, sanitiseName, unpackInput, type ClientMessage, type ServerMessage } from '../../shared/src/net';
import type { Track } from '../../shared/src/track';
import { Room } from './room';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O (confusable)
const TOKEN_TTL_MS = 10 * 60 * 1000;

interface Client {
  id: string;
  token: string;
  name: string;
  color: string;
  room: Room | null;
  send: (msg: ServerMessage) => void;
  connected: boolean;
  lastSeen: number;
}

/** Owns players, rooms and the fixed-rate simulation loop for every room. */
export class Lobby {
  private readonly rooms = new Map<string, Room>();
  private readonly byToken = new Map<string, Client>();
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private acc = 0;

  /** speed > 1 runs the simulation faster than real time (tests only). */
  constructor(
    private readonly track: Track,
    private readonly speed = 1,
  ) {}

  start(): void {
    this.last = performance.now();
    // setInterval granularity on Windows is ~15 ms, so accumulate real time and run fixed 60 Hz steps.
    this.timer = setInterval(() => this.loop(), 4);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  private loop(): void {
    const now = performance.now();
    this.acc += Math.min(0.25, (now - this.last) / 1000) * this.speed;
    this.last = now;
    let steps = 0;
    while (this.acc >= 1 / 60 && steps < 8 * this.speed) {
      for (const room of this.rooms.values()) room.step();
      this.acc -= 1 / 60;
      steps += 1;
    }
    // Forget tokens of players gone for good.
    if (Math.random() < 0.002) {
      const cutoff = Date.now() - TOKEN_TTL_MS;
      for (const [token, c] of this.byToken) if (!c.connected && c.lastSeen < cutoff && !c.room) this.byToken.delete(token);
    }
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const bytes = randomBytes(4);
      let code = '';
      for (let i = 0; i < 4; i += 1) code += CODE_LETTERS[bytes[i] % CODE_LETTERS.length];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('No free room code');
  }

  /** A socket connected; returns handlers for its messages and close. */
  connect(send: (msg: ServerMessage) => void): { onMessage: (raw: string) => void; onClose: () => void } {
    let client: Client | null = null;
    const input = { ...NEUTRAL_INPUT };

    const onMessage = (raw: string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw) as ClientMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'hello') {
        const name = sanitiseName(msg.name);
        const color = PLAYER_COLORS.includes(msg.color) ? msg.color : PLAYER_COLORS[0];
        const existing = typeof msg.token === 'string' ? this.byToken.get(msg.token) : undefined;
        if (existing && !existing.connected) {
          client = existing;
          client.send = send;
          client.connected = true;
          client.lastSeen = Date.now();
          send({ t: 'welcome', id: client.id, token: client.token });
          if (client.room) client.room.reconnect(client.id, send);
        } else {
          client = { id: randomUUID().slice(0, 8), token: randomUUID(), name, color, room: null, send, connected: true, lastSeen: Date.now() };
          this.byToken.set(client.token, client);
          send({ t: 'welcome', id: client.id, token: client.token });
        }
        return;
      }
      if (!client) return;
      const c = client;
      c.lastSeen = Date.now();

      switch (msg.t) {
        case 'ping':
          send({ t: 'pong', ts: msg.ts, serverTime: c.room?.session?.time ?? 0 });
          break;
        case 'profile':
          c.name = sanitiseName(msg.name);
          if (PLAYER_COLORS.includes(msg.color)) c.color = msg.color;
          c.room?.setProfile(c.id, c.name, c.color);
          break;
        case 'create': {
          this.leaveRoom(c);
          const room = new Room(this.newCode(), this.track);
          this.rooms.set(room.code, room);
          room.add({ id: c.id, name: c.name, color: c.color, connected: true, send: (m) => c.send(m) });
          c.room = room;
          break;
        }
        case 'join': {
          const code = normaliseCode(String(msg.code ?? ''));
          const room = this.rooms.get(code);
          if (!room) {
            send({ t: 'error', message: `Aucun salon avec le code ${code || '(vide)'}.` });
            break;
          }
          if (c.room === room) break;
          this.leaveRoom(c);
          const err = room.add({ id: c.id, name: c.name, color: c.color, connected: true, send: (m) => c.send(m) });
          if (err) send({ t: 'error', message: err });
          else c.room = room;
          break;
        }
        case 'leave':
          this.leaveRoom(c);
          send({ t: 'left' });
          break;
        case 'start': {
          const err = c.room?.start(c.id, !!msg.fillBots);
          if (err) send({ t: 'error', message: err });
          break;
        }
        case 'backToLobby':
          c.room?.backToLobby(c.id);
          break;
        case 'input':
          if (c.room && Array.isArray(msg.i) && Number.isInteger(msg.seq)) {
            c.room.queueInput(c.id, msg.seq, { ...unpackInput(msg.i, input) });
          }
          break;
      }
    };

    const onClose = () => {
      if (!client) return;
      client.connected = false;
      client.lastSeen = Date.now();
      const room = client.room;
      if (!room) return;
      room.disconnect(client.id);
      if (!room.members.has(client.id)) client.room = null;
      this.cleanup(room);
    };

    return { onMessage, onClose };
  }

  private leaveRoom(c: Client): void {
    const room = c.room;
    if (!room) return;
    if (room.state === 'waiting') room.remove(c.id);
    else room.disconnect(c.id);
    c.room = null;
    this.cleanup(room);
  }

  private cleanup(room: Room): void {
    if (room.connectedCount === 0) {
      // Keep a racing room briefly so a lone player can reconnect; drop empty lobbies at once.
      if (room.state === 'waiting' || room.members.size === 0) this.rooms.delete(room.code);
      else
        setTimeout(() => {
          if (room.connectedCount === 0) {
            this.rooms.delete(room.code);
            for (const id of room.members.keys()) {
              for (const c of this.byToken.values()) if (c.id === id && c.room === room) c.room = null;
            }
          }
        }, 60_000);
    }
  }
}
