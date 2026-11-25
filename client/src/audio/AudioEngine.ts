/**
 * Procedural audio (Web Audio API): every sound is synthesised at runtime, so
 * there are no audio files to license or download.
 *
 *  - one EngineVoice per kart: electric-motor whine + hum, pitch follows speed,
 *    forklift reverse beeper, drift crackle; distance attenuation + stereo pan
 *  - one-shot SFX (pickup, items, impacts, countdown, laps...)
 *  - a small step sequencer for the music (menu / race / final lap)
 */

export type SfxName =
  | 'click'
  | 'countdown'
  | 'go'
  | 'pickup'
  | 'rollTick'
  | 'rolled'
  | 'boost'
  | 'miniTurbo'
  | 'throw'
  | 'tracked'
  | 'oil'
  | 'film'
  | 'palletWhistle'
  | 'palletLand'
  | 'hit'
  | 'shieldBlock'
  | 'bounce'
  | 'impact'
  | 'stall'
  | 'lap'
  | 'finalLap'
  | 'finish'
  | 'warning';

export interface EngineParams {
  speed: number;
  throttle: number;
  boosting: boolean;
  driftLevel: number;
  drifting: boolean;
  reversing: boolean;
  spinning: boolean;
  /** 0..1 loudness after distance attenuation. */
  volume: number;
  /** -1..1 */
  pan: number;
}

class EngineVoice {
  private readonly out: GainNode;
  private readonly pan: StereoPannerNode;
  private readonly hum: OscillatorNode;
  private readonly humSub: OscillatorNode;
  private readonly humFilter: BiquadFilterNode;
  private readonly humGain: GainNode;
  private readonly whine: OscillatorNode;
  private readonly whineHarm: OscillatorNode;
  private readonly whineHarmGain: GainNode;
  private readonly whineFilter: BiquadFilterNode;
  private readonly whineGain: GainNode;
  private readonly roll: AudioBufferSourceNode;
  private readonly rollFilter: BiquadFilterNode;
  private readonly rollGain: GainNode;
  private readonly beep: OscillatorNode;
  private readonly beepGain: GainNode;
  private readonly crackle: AudioBufferSourceNode;
  private readonly crackleFilter: BiquadFilterNode;
  private readonly crackleGain: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    dest: AudioNode,
    noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(dest);

    // Soft low hum: triangle + sine sub-octave through a gentle lowpass (no sawtooth rasp).
    this.humFilter = ctx.createBiquadFilter();
    this.humFilter.type = 'lowpass';
    this.humFilter.frequency.value = 220;
    this.humFilter.Q.value = 0.7;
    this.hum = ctx.createOscillator();
    this.hum.type = 'triangle';
    this.humSub = ctx.createOscillator();
    this.humSub.type = 'sine';
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    this.hum.connect(this.humFilter);
    this.humSub.connect(this.humFilter);
    this.humFilter.connect(this.humGain).connect(this.out);

    // Electric motor whine: one sine plus a faint harmonic, kept in the mid range and lowpassed.
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whineHarm = ctx.createOscillator();
    this.whineHarm.type = 'sine';
    this.whineHarmGain = ctx.createGain();
    this.whineHarmGain.gain.value = 0.25;
    this.whineFilter = ctx.createBiquadFilter();
    this.whineFilter.type = 'lowpass';
    this.whineFilter.frequency.value = 1400;
    this.whineFilter.Q.value = 0.5;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineFilter);
    this.whineHarm.connect(this.whineHarmGain).connect(this.whineFilter);
    this.whineFilter.connect(this.whineGain).connect(this.out);

    // Tyres rolling on concrete: quiet lowpassed noise that grows with speed.
    this.roll = ctx.createBufferSource();
    this.roll.buffer = noise;
    this.roll.loop = true;
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 300;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.roll.connect(this.rollFilter).connect(this.rollGain).connect(this.out);

    // Forklift reverse beeper (classic ~1.1 kHz, 0.5 s on / 0.5 s off).
    this.beep = ctx.createOscillator();
    this.beep.type = 'square';
    this.beep.frequency.value = 1150;
    this.beepGain = ctx.createGain();
    this.beepGain.gain.value = 0;
    const beepFilter = ctx.createBiquadFilter();
    beepFilter.type = 'bandpass';
    beepFilter.frequency.value = 1150;
    beepFilter.Q.value = 3;
    this.beep.connect(beepFilter).connect(this.beepGain).connect(this.pan);

    // Drift crackle: band-passed noise.
    this.crackle = ctx.createBufferSource();
    this.crackle.buffer = noise;
    this.crackle.loop = true;
    this.crackleFilter = ctx.createBiquadFilter();
    this.crackleFilter.type = 'bandpass';
    this.crackleFilter.Q.value = 4;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    this.crackle.connect(this.crackleFilter).connect(this.crackleGain).connect(this.out);

    const now = ctx.currentTime;
    for (const o of [this.hum, this.humSub, this.whine, this.whineHarm, this.beep]) o.start(now);
    this.roll.start(now, Math.random() * 1.5);
    this.crackle.start(now, Math.random() * 1.5);
  }

  update(p: EngineParams): void {
    const t = this.ctx.currentTime;
    const k = 0.09; // slightly slower glide = smoother pitch changes
    const s = Math.min(1.5, Math.abs(p.speed) / 17);
    const thr = Math.abs(p.throttle);
    const boost = p.boosting ? 1 : 0;

    const humF = 38 + s * 42 + boost * 12;
    this.hum.frequency.setTargetAtTime(humF, t, k);
    this.humSub.frequency.setTargetAtTime(humF / 2, t, k);
    this.humFilter.frequency.setTargetAtTime(170 + s * 300 + thr * 80 + boost * 250, t, k);
    this.humGain.gain.setTargetAtTime(0.1 + thr * 0.06 + s * 0.05, t, k);

    const whineF = 220 + s * 620 + boost * 160;
    this.whine.frequency.setTargetAtTime(whineF, t, k);
    this.whineHarm.frequency.setTargetAtTime(whineF * 2, t, k);
    this.whineFilter.frequency.setTargetAtTime(900 + s * 700 + boost * 500, t, k);
    this.whineGain.gain.setTargetAtTime(0.006 + s * 0.022 + Math.max(0, p.throttle) * 0.01 + boost * 0.01, t, k);

    this.rollFilter.frequency.setTargetAtTime(250 + s * 550, t, k);
    this.rollGain.gain.setTargetAtTime(Math.min(0.06, s * 0.05), t, k);

    this.out.gain.setTargetAtTime(p.spinning ? p.volume * 0.5 : p.volume, t, 0.1);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, p.pan)), t, 0.05);

    const beepOn = p.reversing && t % 1 < 0.5;
    this.beepGain.gain.setTargetAtTime(beepOn ? 0.09 * p.volume : 0, t, 0.008);

    const crackleF = [1400, 2200, 3200, 4200][p.driftLevel] ?? 1400;
    this.crackleFilter.frequency.setTargetAtTime(crackleF, t, 0.05);
    this.crackleGain.gain.setTargetAtTime(p.drifting ? 0.18 + p.driftLevel * 0.06 : 0, t, 0.04);
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.05);
    this.beepGain.gain.setTargetAtTime(0, t, 0.02);
    window.setTimeout(() => {
      for (const o of [this.hum, this.humSub, this.whine, this.whineHarm, this.beep]) o.stop();
      this.roll.stop();
      this.crackle.stop();
      this.pan.disconnect();
    }, 300);
  }
}

type MusicMode = 'off' | 'menu' | 'race';

/** Tiny step sequencer: A minor, Am-F-C-G, drums + bass + arpeggio. */
class Music {
  private mode: MusicMode = 'off';
  private timer = 0;
  private nextTime = 0;
  private step = 0;
  private tempo = 124;
  private readonly bus: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    dest: AudioNode,
    private readonly noise: AudioBuffer,
  ) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.55;
    // A little room: feedback delay on the lead/pad.
    this.bus.connect(dest);
  }

  setMode(mode: MusicMode, finalLap = false): void {
    this.tempo = mode === 'menu' ? 100 : finalLap ? 136 : 124;
    if (mode === this.mode) return;
    this.mode = mode;
    window.clearInterval(this.timer);
    if (mode === 'off') return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private schedule(): void {
    const sixteenth = 60 / this.tempo / 4;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime, sixteenth);
      this.nextTime += sixteenth;
      this.step = (this.step + 1) % 64;
    }
  }

  private playStep(step: number, t: number, len: number): void {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const roots = [57, 53, 48, 55]; // A, F, C, G (MIDI)
    const chords = [
      [57, 60, 64],
      [53, 57, 60],
      [48, 52, 55],
      [55, 59, 62],
    ];
    const root = roots[bar];
    const race = this.mode === 'race';
    if (race) {
      if (s % 4 === 0) this.kick(t);
      if (s === 4 || s === 12) this.snare(t);
      if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.05 : 0.025);
      // Driving bass: offbeat octaves.
      if (s % 2 === 0) this.note(root - 24 + (s % 4 === 2 ? 12 : 0), t, len * 1.8, 'sawtooth', 0.09, 700);
      // Arpeggio lead.
      const arp = chords[bar];
      if (s % 2 === 1 || s % 8 === 0) this.note(arp[(s >> 1) % 3] + 12, t, len * 0.9, 'square', 0.035, 2600);
    } else {
      if (s === 0) for (const n of chords[bar]) this.note(n, t, len * 15, 'triangle', 0.04, 1500);
      if (s % 4 === 0) this.note(root - 12, t, len * 3, 'sine', 0.08, 600);
      if (s % 4 === 2) this.hat(t, 0.015);
      if (s === 6 || s === 14) this.note(chords[bar][2] + 12, t, len * 2, 'sine', 0.03, 3000);
    }
  }

  private note(midi: number, t: number, dur: number, type: OscillatorType, gain: number, cutoff: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private kick(t: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.25);
  }

  private snare(t: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t, Math.random());
    src.stop(t + 0.18);
  }

  private hat(t: number, gain: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t, Math.random());
    src.stop(t + 0.06);
  }
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private engineBus!: GainNode;
  /** Player-controlled engine volume (separate from the pause mute on engineBus). */
  private engineLevel!: GainNode;
  private noise!: AudioBuffer;
  private music: Music | null = null;
  private readonly engines = new Map<string, EngineVoice>();
  private musicVolume = 0.6;
  private sfxVolume = 0.8;
  private engineVolume = 0.6;
  private wantedMusic: { mode: MusicMode; finalLap: boolean } = { mode: 'menu', finalLap: false };

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Browsers only allow audio after a user gesture: call from input handlers. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.engineBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.master);
      this.engineLevel = ctx.createGain();
      this.engineBus.connect(this.engineLevel).connect(this.sfxBus);
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
      this.music = new Music(ctx, this.musicBus, this.noise);
      this.applyVolumes();
      this.music.setMode(this.wantedMusic.mode, this.wantedMusic.finalLap);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolumes(music: number, sfx: number, engines = this.engineVolume): void {
    this.musicVolume = music;
    this.sfxVolume = sfx;
    this.engineVolume = engines;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicBus.gain.setTargetAtTime(this.musicVolume * 0.5, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.sfxVolume, t, 0.05);
    this.engineLevel.gain.setTargetAtTime(this.engineVolume, t, 0.05);
  }

  setMusic(mode: MusicMode, finalLap = false): void {
    this.wantedMusic = { mode, finalLap };
    this.music?.setMode(mode, finalLap);
  }

  /** Mute everything quickly (pause) or restore. */
  setPaused(paused: boolean): void {
    if (!this.ctx) return;
    this.engineBus.gain.setTargetAtTime(paused ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  updateEngine(id: string, p: EngineParams): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    let v = this.engines.get(id);
    if (!v) {
      v = new EngineVoice(this.ctx, this.engineBus, this.noise);
      this.engines.set(id, v);
    }
    v.update(p);
  }

  /** Remove engine voices not in `keep`. */
  pruneEngines(keep: Set<string>): void {
    for (const [id, v] of this.engines) {
      if (!keep.has(id)) {
        v.dispose();
        this.engines.delete(id);
      }
    }
  }

  play(name: SfxName, opts: { volume?: number; pan?: number; pitch?: number } = {}): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const vol = opts.volume ?? 1;
    if (vol < 0.02) return;
    const out = ctx.createGain();
    out.gain.value = vol;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0));
    out.connect(pan).connect(this.sfxBus);
    const t = ctx.currentTime + 0.005;
    const p = opts.pitch ?? 1;
    const tone = (f: number, dur: number, type: OscillatorType, g: number, at = 0, slideTo?: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f * p, t + at);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo * p, t + at + dur);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t + at);
      e.gain.exponentialRampToValueAtTime(g, t + at + 0.008);
      e.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(e).connect(out);
      o.start(t + at);
      o.stop(t + at + dur + 0.05);
    };
    const noise = (dur: number, type: BiquadFilterType, f: number, g: number, at = 0, fTo?: number, q = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const filt = ctx.createBiquadFilter();
      filt.type = type;
      filt.Q.value = q;
      filt.frequency.setValueAtTime(f, t + at);
      if (fTo) filt.frequency.exponentialRampToValueAtTime(fTo, t + at + dur);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t + at);
      e.gain.exponentialRampToValueAtTime(g, t + at + 0.01);
      e.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      src.connect(filt).connect(e).connect(out);
      src.start(t + at, Math.random());
      src.stop(t + at + dur + 0.05);
    };
    switch (name) {
      case 'click':
        tone(900, 0.05, 'square', 0.08);
        break;
      case 'countdown':
        tone(523, 0.32, 'square', 0.16);
        tone(1046, 0.32, 'sine', 0.06);
        break;
      case 'go':
        tone(1046, 0.7, 'square', 0.16);
        tone(1568, 0.7, 'sine', 0.08);
        break;
      case 'pickup':
        [880, 1175, 1568, 2093].forEach((f, i) => tone(f, 0.16, 'triangle', 0.12, i * 0.045));
        noise(0.12, 'highpass', 5000, 0.06);
        break;
      case 'rollTick':
        tone(1600, 0.03, 'square', 0.05);
        break;
      case 'rolled':
        tone(1318, 0.12, 'triangle', 0.14);
        tone(1975, 0.22, 'triangle', 0.12, 0.07);
        break;
      case 'boost':
        noise(0.9, 'bandpass', 400, 0.3, 0, 3000, 2);
        tone(120, 0.8, 'sawtooth', 0.12, 0, 340);
        break;
      case 'miniTurbo':
        noise(0.4, 'bandpass', 800, 0.25, 0, 4000, 3);
        tone(300, 0.25, 'square', 0.08, 0, 900);
        break;
      case 'throw':
        noise(0.3, 'bandpass', 600, 0.25, 0, 2400, 2);
        break;
      case 'tracked':
        noise(0.3, 'bandpass', 600, 0.2, 0, 2400, 2);
        [0, 0.18, 0.36].forEach((at) => tone(1400, 0.1, 'square', 0.08, at));
        break;
      case 'oil':
        noise(0.35, 'lowpass', 900, 0.3, 0, 200);
        tone(220, 0.2, 'sine', 0.15, 0, 90);
        break;
      case 'film':
        noise(0.6, 'bandpass', 1500, 0.15, 0, 5000, 6);
        tone(600, 0.5, 'sine', 0.05, 0.05, 1500);
        break;
      case 'palletWhistle':
        tone(2400, 0.85, 'sine', 0.08, 0, 500);
        break;
      case 'palletLand':
        tone(70, 0.5, 'sine', 0.5, 0, 35);
        noise(0.5, 'lowpass', 600, 0.45, 0, 120);
        noise(0.25, 'bandpass', 1800, 0.12, 0.02);
        break;
      case 'hit':
        tone(600, 0.6, 'sawtooth', 0.12, 0, 120);
        noise(0.25, 'lowpass', 1200, 0.35);
        tone(90, 0.3, 'sine', 0.35, 0, 50);
        break;
      case 'shieldBlock':
        tone(1760, 0.5, 'sine', 0.15);
        tone(2637, 0.4, 'sine', 0.08, 0.02);
        noise(0.15, 'highpass', 4000, 0.1);
        break;
      case 'bounce':
        tone(180, 0.12, 'sine', 0.2, 0, 110);
        noise(0.08, 'bandpass', 900, 0.15);
        break;
      case 'impact':
        tone(85, 0.25, 'sine', 0.4, 0, 45);
        noise(0.18, 'lowpass', 1500, 0.35, 0, 300);
        noise(0.12, 'bandpass', 3000, 0.08);
        break;
      case 'stall':
        [0, 0.12, 0.24, 0.4].forEach((at, i) => tone(90 - i * 10, 0.1, 'sawtooth', 0.12, at));
        break;
      case 'lap':
        [784, 988, 1175].forEach((f, i) => tone(f, 0.25, 'triangle', 0.13, i * 0.09));
        break;
      case 'finalLap':
        [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.22, 'square', 0.1, i * 0.1));
        break;
      case 'finish':
        [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.3, 'square', 0.11, i * 0.12));
        [1046, 1318, 1568].forEach((f) => tone(f, 1.2, 'triangle', 0.08, 0.5));
        break;
      case 'warning':
        tone(1900, 0.06, 'square', 0.07);
        break;
    }
    window.setTimeout(() => pan.disconnect(), 3000);
  }
}
