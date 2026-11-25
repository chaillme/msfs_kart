/**
 * Client-side prediction for the local kart.
 *
 * Each local fixed step the client applies its input immediately (so controls
 * feel instant) and remembers it. When an authoritative snapshot arrives with
 * the last input sequence the server processed (`ack`), we restart from the
 * server state and re-apply every input the server has not seen yet.
 * Other karts are not simulated here (server resolves kart-vs-kart contacts),
 * which only causes small corrections during bumps.
 */
import { collideKartWithStatics, collideKartWithTrack, type StaticCollider } from './collision';
import { copyKartState, createKartState, FIXED_DT, stepKart, type KartInput, type KartParams, type KartState } from './kart';
import { trackHeight, type Track } from './track';

interface PendingInput {
  seq: number;
  input: KartInput;
}

export class Predictor {
  readonly state: KartState;
  private readonly pending: PendingInput[] = [];
  private seq = 0;
  /** Seconds of engine stall left (rocket-start penalty, mirrored from the server). */
  stall = 0;
  private readonly ground: (x: number, z: number) => number;
  private readonly scratch: KartState = createKartState();

  constructor(
    private readonly track: Track,
    initial: KartState,
  ) {
    this.state = createKartState();
    copyKartState(initial, this.state);
    this.ground = (x, z) => trackHeight(track, x, z);
  }

  /** Allocate the next input sequence number. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Apply a local input now and remember it until the server acknowledges it. */
  apply(seq: number, input: KartInput, params: KartParams, statics: readonly StaticCollider[]): void {
    const copy = { ...input };
    this.pending.push({ seq, input: copy });
    if (this.pending.length > 240) this.pending.shift();
    this.simulate(this.state, copy, params, statics, true);
  }

  private simulate(state: KartState, input: KartInput, params: KartParams, statics: readonly StaticCollider[], live: boolean): void {
    let inp = input;
    if (this.stall > 0) {
      inp = { ...input, throttle: 0 };
      if (live) this.stall = Math.max(0, this.stall - FIXED_DT);
    }
    stepKart(state, inp, FIXED_DT, params, this.ground);
    collideKartWithTrack(state, this.track, params);
    collideKartWithStatics(state, statics, params);
    state.y = this.ground(state.x, state.z);
  }

  /**
   * Rebase on an authoritative state. Returns the distance between the old
   * prediction and the corrected one (for visual smoothing / diagnostics).
   */
  reconcile(server: KartState, ack: number, params: KartParams, statics: readonly StaticCollider[]): number {
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
    copyKartState(this.state, this.scratch);
    copyKartState(server, this.state);
    for (const p of this.pending) this.simulate(this.state, p.input, params, statics, false);
    return Math.hypot(this.state.x - this.scratch.x, this.state.z - this.scratch.z);
  }

  /** Hard reset (respawn, teleport, new race). */
  reset(server: KartState): void {
    this.pending.length = 0;
    copyKartState(server, this.state);
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
