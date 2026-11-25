/**
 * Network protocol (JSON over WebSocket) and compact state packing shared by
 * the server and the client.
 */
import type { ItemEvent, ItemType } from './items';
import type { KartInput, KartState } from './kart';
import type { RaceEvent, RaceResult, RacePhase } from './session';

export const SNAPSHOT_RATE = 20;
export const MAX_PLAYERS = 6;
export const PLAYER_COLORS = ['#e8202a', '#2f8cff', '#2fa84f', '#f2c230', '#8e5bd6', '#ff8a1e', '#19b5b0', '#f05fa8'];

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  isHost: boolean;
}

export interface RacerSetupWire {
  id: string;
  name: string;
  color: string;
  bot: boolean;
  /** Bot roster index when bot. */
  botIndex?: number;
}

export type ClientMessage =
  | { t: 'hello'; name: string; color: string; token?: string }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'profile'; name: string; color: string }
  | { t: 'start'; fillBots: boolean }
  | { t: 'backToLobby' }
  | { t: 'input'; seq: number; i: PackedInput }
  | { t: 'ping'; ts: number };

export type ServerMessage =
  | { t: 'welcome'; id: string; token: string }
  | { t: 'error'; message: string }
  | { t: 'lobby'; code: string; state: 'waiting' | 'racing' | 'results'; players: PlayerInfo[] }
  | { t: 'left' }
  | { t: 'raceStart'; seed: number; setups: RacerSetupWire[]; you: string }
  | { t: 'snap'; s: Snapshot }
  | { t: 'results'; results: RaceResult[] }
  | { t: 'pong'; ts: number; serverTime: number };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** [throttle, steer, drift(0/1), item(0/1)] */
export type PackedInput = [number, number, number, number];

export function packInput(i: KartInput): PackedInput {
  return [i.throttle, i.steer, i.drift ? 1 : 0, i.item ? 1 : 0];
}

export function unpackInput(p: PackedInput, out: KartInput): KartInput {
  out.throttle = Math.max(-1, Math.min(1, Number(p[0]) || 0));
  out.steer = Math.max(-1, Math.min(1, Number(p[1]) || 0));
  out.drift = p[2] === 1;
  out.item = p[3] === 1;
  return out;
}

// ---------------------------------------------------------------------------
// Kart state packing (full state: the owner needs it to re-run prediction)
// ---------------------------------------------------------------------------

const KART_FIELDS = [
  'x',
  'y',
  'z',
  'heading',
  'vx',
  'vz',
  'steer',
  'driftDir',
  'driftTime',
  'driftCharge',
  'driftLevel',
  'hop',
  'boostTime',
  'stunTime',
  'spinTime',
  'spinDuration',
  'invulnTime',
  'driftHeldPrev',
  'forwardSpeed',
] as const satisfies readonly (keyof KartState)[];

const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

export function packKart(k: KartState): number[] {
  return KART_FIELDS.map((f) => {
    const v = k[f];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return round(v, f === 'heading' ? 5 : 4);
  });
}

export function unpackKart(p: number[], out: KartState): KartState {
  KART_FIELDS.forEach((f, i) => {
    if (f === 'driftHeldPrev') out.driftHeldPrev = p[i] === 1;
    else (out as unknown as Record<string, number>)[f] = p[i];
  });
  return out;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface RacerSnap {
  id: string;
  k: number[];
  /** [lap, rank, finishTime(-1), finishPos(0), bestLap(-1), lapStartTime, wrongWayTime, s, nextGate] */
  p: number[];
  /** Item slot: [item index(-1), rolling, shield, reserve index(-1), reserveRolling] */
  i: [number, number, number, number, number];
  /** Last input sequence processed for this racer (owner reconciles against it). */
  ack: number;
  /** AI is driving (bot, finished human, or disconnected human). */
  ai: 0 | 1;
  /** Human currently disconnected. */
  dc: 0 | 1;
}

export interface Snapshot {
  tick: number;
  time: number;
  phase: RacePhase;
  racers: RacerSnap[];
  /** Crate active flags as a string of 0/1. */
  crates: string;
  projectiles: { id: number; kind: 'carton' | 'tracked'; owner: string; x: number; y: number; z: number; vx: number; vz: number }[];
  hazards: { id: number; kind: 'oil' | 'pallet'; owner: string; x: number; y: number; z: number; angle: number; age: number; fall: number }[];
  /** Events produced since the previous snapshot. */
  events: RaceEvent[];
  itemEvents: ItemEvent[];
}

export const ITEM_INDEX: ItemType[] = ['express', 'oil', 'carton', 'tracked', 'film', 'pallet'];

/** Normalise a 4-letter room code typed by a user. */
export function normaliseCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4);
}

/** Keep player names short and printable. */
export function sanitiseName(name: string): string {
  const clean = String(name ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 16);
  return clean || 'Cariste';
}
