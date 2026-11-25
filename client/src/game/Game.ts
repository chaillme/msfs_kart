import * as THREE from 'three';
import { BOT_ROSTER } from '@shared/bot';
import type { ItemEvent, ItemType } from '@shared/items';
import { createKartState, DEFAULT_KART_PARAMS, FIXED_DT, type KartInput, type KartParams, type KartState } from '@shared/kart';
import { ITEM_INDEX, packInput, unpackKart, type RacerSetupWire, type ServerMessage, type Snapshot } from '@shared/net';
import { Predictor } from '@shared/predict';
import { COUNTDOWN, RaceSession, type RaceEvent, type RaceResult, type RacerSetup, type SessionRacer } from '@shared/session';
import { buildTrack, trackHeight, trackSdf, type Track } from '@shared/track';
import { WAREHOUSE_TRACK } from '@shared/tracks/warehouse';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AudioEngine, type SfxName } from '../audio/AudioEngine';
import { KeyboardInput } from '../core/KeyboardInput';
import { Loop } from '../core/Loop';
import { createRenderer, resizeRenderer } from '../core/Renderer';
import { Kart } from '../entities/Kart';
import { NetClient } from '../net/NetClient';
import { ChaseCamera } from '../systems/ChaseCamera';
import { DebugTools } from '../systems/DebugTools';
import { ItemView } from '../systems/ItemView';
import { KartFx } from '../systems/KartFx';
import { ItemSlotUi } from '../ui/ItemSlotUi';
import { Menu } from '../ui/Menu';
import { Minimap } from '../ui/Minimap';
import { OptionsPanel, PauseMenu } from '../ui/Overlays';
import { loadSettings, QUALITY_PRESETS, saveSettings, type Settings } from '../settings';
import { ResultsUi } from '../ui/ResultsUi';
import { buildWarehouse } from '../world/Warehouse';

const MAX_STEPS_PER_FRAME = 5;
const SOLO_PLAYER = 'player';
const COLORS = ['#e8202a', '#2f8cff', '#2fa84f', '#f2c230', '#8e5bd6', '#ff8a1e'];
const RESULTS_DELAY = 3;
/** Remote karts are drawn this far in the past, between two snapshots. */
const INTERP_DELAY = 0.1;

type Mode = 'demo' | 'solo' | 'online';

export function formatTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '–';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function ordinal(n: number): string {
  return n === 1 ? 'er' : 'e';
}

function nameTag(name: string, color: string, disconnected = false): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 30px "Segoe UI", Arial, sans-serif';
  const label = disconnected ? `${name} · déconnecté` : name;
  const w = Math.min(310, ctx.measureText(label).width + 34);
  ctx.fillStyle = disconnected ? 'rgba(90,20,20,0.85)' : 'rgba(14,17,22,0.75)';
  ctx.beginPath();
  ctx.roundRect((320 - w) / 2, 10, w, 44, 10);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc((320 - w) / 2 + 16, 32, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, (320 - w) / 2 + 28, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  sprite.scale.set(3.0, 0.6, 1);
  sprite.position.y = 2.9;
  sprite.renderOrder = 3;
  return sprite;
}

interface RacerView {
  racer: SessionRacer;
  kart: Kart;
  tag: THREE.Sprite | null;
  disconnected: boolean;
}

interface OnlineState {
  predictor: Predictor;
  input: KartInput;
  snaps: Snapshot[];
  lastRecv: number;
  serverTime: number;
  myAi: boolean;
  correction: THREE.Vector3;
  results: RaceResult[] | null;
  isHost: boolean;
  lastCorrection: number;
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(64, 1, 0.1, 220);
  private readonly input = new KeyboardInput();
  private readonly params: KartParams = { ...DEFAULT_KART_PARAMS };
  private readonly track: Track;
  private readonly ground: (x: number, z: number) => number;
  private readonly fx = new KartFx();
  private readonly chase: ChaseCamera;
  private readonly key: THREE.DirectionalLight;
  private readonly debug: DebugTools;
  private readonly minimap: Minimap;
  private readonly itemUi: ItemSlotUi;
  private readonly results: ResultsUi;
  private readonly menu: Menu;
  private readonly net = new NetClient();
  private readonly startLights: THREE.Mesh[] = [];
  private readonly loop = new Loop(
    (delta) => this.update(delta),
    () => this.render(),
  );

  private mode: Mode = 'demo';
  private readonly audio = new AudioEngine();
  private readonly settings: Settings = loadSettings();
  private readonly options: OptionsPanel;
  private readonly pauseMenu: PauseMenu;
  private composer: EffectComposer | null = null;
  private quality: 'low' | 'high' = 'high';
  private autoFps: number[] = [];
  private autoDecided = false;
  private menuPaused = false;
  private rollTick = 0;
  private trackedBeep = 0;
  private session!: RaceSession;
  private playerId = SOLO_PLAYER;
  private views: RacerView[] = [];
  private player!: RacerView;
  private itemView: ItemView | null = null;
  private online: OnlineState | null = null;
  private inLobby = false;
  private knownId = '';
  private accumulator = 0;
  private frame = 0;
  private paused = false;
  private fps = 60;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private lastFrameTime = performance.now();
  private lapFlashUntil = 0;
  private playerFinishedAt = -1;
  private seed = 1;
  private soloBots = 5;
  private soloSkill = 0;

  private readonly ui = {
    speed: this.el('#speed-value'),
    segs: Array.from(document.querySelectorAll<HTMLElement>('#drift-gauge .seg')),
    boost: this.el('#boost-tag'),
    help: this.el('#help'),
    fps: this.el('#fps'),
    pos: this.el('#pos-value'),
    posSuffix: this.el('#pos-suffix'),
    posTotal: this.el('#pos-total'),
    lap: this.el('#lap-value'),
    lapTotal: this.el('#lap-total'),
    timeTotal: this.el('#time-total'),
    timeLap: this.el('#time-lap'),
    timeBest: this.el('#time-best'),
    banner: this.el('#banner'),
    lapFlash: this.el('#lap-flash'),
    countdown: this.el('#countdown'),
    netBadge: this.el('#net-badge'),
    posBox: this.el('#position'),
    lapBox: this.el('#lap-box'),
    speedlines: this.el('#speedlines'),
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    this.renderer.toneMappingExposure = 1.15;

    const query = new URLSearchParams(window.location.search);
    this.soloBots = Math.max(0, Math.min(5, Number(query.get('bots') ?? 5)));
    this.soloSkill = this.skillFor(query.get('diff') ?? 'normal');

    this.track = buildTrack(WAREHOUSE_TRACK);
    this.ground = (x, z) => trackHeight(this.track, x, z);

    this.scene.background = new THREE.Color('#20252d');
    this.scene.fog = new THREE.Fog('#262b33', 38, 115);
    this.scene.add(new THREE.HemisphereLight('#eef3ff', '#6b6660', 1.55));
    this.scene.add(new THREE.AmbientLight('#ffffff', 0.25));
    this.key = new THREE.DirectionalLight('#fff6e8', 1.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = -26;
    sc.right = 26;
    sc.top = 26;
    sc.bottom = -26;
    sc.near = 1;
    sc.far = 70;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.04;
    this.scene.add(this.key, this.key.target);

    const warehouse = buildWarehouse(this.track);
    this.scene.add(warehouse.group);
    for (let i = 0; i < 3; i += 1) {
      const lamp = warehouse.group.getObjectByName(`start-light-${i}`) as THREE.Mesh | undefined;
      if (lamp) this.startLights.push(lamp);
    }
    this.scene.add(this.fx.group);

    this.chase = new ChaseCamera(this.camera);
    this.chase.wallDistance = (x, z) => trackSdf(this.track, x, z);
    this.minimap = new Minimap(this.el('#minimap') as HTMLCanvasElement, this.track);
    this.itemUi = new ItemSlotUi(
      this.el('#item-icon') as HTMLCanvasElement,
      this.el('#item-label'),
      this.el('#item-box'),
      this.el('#item-reserve-icon') as HTMLCanvasElement,
      this.el('#item-reserve'),
    );
    this.results = new ResultsUi(this.el('#results'));
    this.ui.lapTotal.textContent = String(this.track.def.laps);

    this.menu = new Menu(this.el('#menu'), {
      onSolo: (bots, diff) => this.startSolo(bots, this.skillFor(diff)),
      onCreate: () => this.withServer(() => this.net.send({ t: 'create' })),
      onJoin: (code) => this.withServer(() => this.net.send({ t: 'join', code })),
      onStart: (fillBots) => this.net.send({ t: 'start', fillBots }),
      onOptions: () => this.options.open(),
      onLeave: () => {
        this.net.send({ t: 'leave' });
        this.inLobby = false;
        this.menu.showHome();
      },
      onProfile: (name, color) => {
        if (this.net.status === 'online') this.net.send({ t: 'profile', name, color });
      },
    });
    this.options = new OptionsPanel(this.el('#app'), this.settings, () => this.applySettings());
    this.pauseMenu = new PauseMenu(this.el('#app'), {
      onResume: () => this.resume(),
      onRestart: () => {
        this.resume();
        if (this.mode === 'solo') this.startSolo(this.soloBots, this.soloSkill);
      },
      onOptions: () => this.options.open(),
      onQuit: () => {
        this.resume();
        this.quitToMenu();
      },
    });
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest?.('button')) this.audio.play('click', { volume: 0.6 });
    });
    this.net.on((msg) => this.onServerMessage(msg));
    document.addEventListener('visibilitychange', () => {
      // Hidden tabs stop running frames: tell the server to let go of the controls.
      if (document.hidden && this.online) {
        const seq = this.online.predictor.nextSeq();
        this.net.send({ t: 'input', seq, i: [0, 0, 0, 0] });
      }
    });
    this.net.onStatus((s) => {
      this.menu.setStatus(s, this.net.rtt);
      this.updateNetBadge();
    });

    // Direct links: ?solo starts a solo race straight away, ?join=CODE opens the lobby.
    const joinCode = query.get('join');
    if (query.has('solo')) this.startSolo(this.soloBots, this.soloSkill);
    else {
      this.startDemo();
      this.menu.showHome();
      if (joinCode) this.withServer(() => this.net.send({ t: 'join', code: joinCode }));
    }
    this.debug = new DebugTools(this.params, this.chase);
    this.applySettings();
    resizeRenderer(this.renderer, this.camera, this.maxDpr());
    this.installTestHooks();
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    this.debug.dispose();
    this.net.close();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  private skillFor(diff: string): number {
    return diff === 'facile' ? -0.12 : diff === 'difficile' ? 0.04 : 0;
  }

  /** Connect if needed, then run `action` once the server said hello. */
  private withServer(action: () => void): void {
    if (this.net.status === 'online') {
      action();
      return;
    }
    this.net.connect(this.menu.name, this.menu.color);
    const off = this.net.on((msg) => {
      if (msg.t === 'welcome') {
        off();
        action();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Race setup
  // -------------------------------------------------------------------------

  private clearRace(): void {
    for (const v of this.views) v.kart.object.removeFromParent();
    this.views = [];
    this.itemView?.group.removeFromParent();
    this.itemView = null;
    this.online = null;
    this.accumulator = 0;
    this.playerFinishedAt = -1;
    this.ui.banner.classList.add('hidden');
    this.ui.lapFlash.classList.add('hidden');
    this.ui.countdown.classList.add('hidden');
    this.results.hide();
    this.setStartLights(0, false);
  }

  private soloSetups(bots: number, skillOffset: number, playerName: string, playerColor: string): RacerSetup[] {
    const setups: RacerSetup[] = [];
    for (let i = 0; i < bots; i += 1) {
      const b = BOT_ROSTER[i];
      setups.push({
        id: `bot${i}`,
        name: b.name,
        color: COLORS[i + 1] === playerColor ? COLORS[0] : COLORS[i + 1],
        bot: { ...b, skill: Math.max(0.6, Math.min(1, b.skill + skillOffset)) },
      });
    }
    setups.push({ id: SOLO_PLAYER, name: playerName, color: playerColor });
    return setups;
  }

  /** Attract mode behind the menus: an AI-only race. */
  private startDemo(): void {
    this.clearRace();
    this.mode = 'demo';
    document.body.classList.add('menu-mode');
    this.seed = (this.seed * 7919 + 13) % 100000;
    this.session = new RaceSession(this.track, this.soloSetups(5, 0, 'Démo', COLORS[0]), { seed: this.seed });
    this.session.setAutoDrive(SOLO_PLAYER, true);
    this.playerId = SOLO_PLAYER;
    this.buildViews(null);
  }

  private startSolo(bots: number, skillOffset: number): void {
    this.soloBots = bots;
    this.soloSkill = skillOffset;
    this.clearRace();
    this.mode = 'solo';
    this.menu.hide();
    document.body.classList.remove('menu-mode');
    this.seed = (this.seed * 7919 + 13) % 100000;
    this.session = new RaceSession(this.track, this.soloSetups(bots, skillOffset, this.menu.name, this.menu.color), {
      seed: this.seed,
      params: this.params,
    });
    this.playerId = SOLO_PLAYER;
    this.buildViews(null);
    this.focusGame();
  }

  private startOnline(seed: number, setups: RacerSetupWire[], you: string): void {
    this.clearRace();
    this.mode = 'online';
    this.inLobby = false;
    this.menu.hide();
    document.body.classList.remove('menu-mode');
    const sessionSetups: RacerSetup[] = setups.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      bot: s.bot ? BOT_ROSTER[s.botIndex ?? 0] : undefined,
    }));
    // Mirror of the server's session: same track, racers and crates; its state is overwritten by snapshots.
    this.session = new RaceSession(this.track, sessionSetups, { seed, rubberBand: false });
    this.playerId = you;
    const me = this.session.racer(you)!;
    const predictor = new Predictor(this.track, me.kart);
    this.online = {
      predictor,
      input: { throttle: 0, steer: 0, drift: false, item: false },
      snaps: [],
      lastRecv: performance.now(),
      serverTime: 0,
      myAi: false,
      correction: new THREE.Vector3(),
      results: null,
      isHost: false,
      lastCorrection: 0,
    };
    this.buildViews(predictor.state);
    this.focusGame();
  }

  /** Create kart views. In online mode the local kart renders the predicted state. */
  private buildViews(localState: KartState | null): void {
    this.views = this.session.racers.map((racer) => {
      const isMe = racer.id === this.playerId;
      const state = isMe && localState ? localState : racer.kart;
      const input = isMe && this.online ? this.online.input : racer.input;
      const kart = new Kart(racer.id, racer.color, state, input);
      kart.snap();
      this.scene.add(kart.object);
      const tag = isMe ? null : nameTag(racer.name, racer.color);
      if (tag) kart.object.add(tag);
      return { racer, kart, tag, disconnected: false };
    });
    this.player = this.views.find((v) => v.racer.id === this.playerId)!;
    this.itemView = new ItemView(this.session.items);
    this.scene.add(this.itemView.group);
    this.ui.posTotal.textContent = `/${this.views.length}`;
    this.chase.orbit = this.mode === 'demo' ? 0 : Math.PI;
    this.chase.snap(this.chaseTarget());
  }

  private focusGame(): void {
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.canvas.focus();
  }

  // -------------------------------------------------------------------------
  // Networking
  // -------------------------------------------------------------------------

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        // A different id after a reconnect means the server lost us (restart): back to the menu.
        const lost = this.knownId !== '' && msg.id !== this.knownId && (this.mode === 'online' || this.inLobby);
        this.knownId = msg.id;
        if (lost) {
          this.inLobby = false;
          this.startDemo();
          this.menu.showHome();
          this.menu.showError('Le serveur a redémarré : la partie a été perdue. Créez ou rejoignez un nouveau salon.');
        }
        break;
      }
      case 'error':
        this.menu.showError(msg.message);
        break;
      case 'lobby': {
        const me = msg.players.find((p) => p.id === this.net.id);
        if (this.online) this.online.isHost = !!me?.isHost;
        if (msg.state === 'waiting') {
          // Back in the lobby (new room, or host ended the results screen).
          if (this.mode === 'online') {
            this.startDemo();
          }
          this.inLobby = true;
          this.menu.showLobby(msg, this.net.id);
        }
        this.updateResultsHint();
        break;
      }
      case 'left':
        this.inLobby = false;
        if (this.mode === 'online') this.startDemo();
        this.menu.showHome();
        break;
      case 'raceStart':
        this.startOnline(msg.seed, msg.setups, msg.you);
        break;
      case 'snap':
        if (this.mode === 'online') this.applySnapshot(msg.s);
        break;
      case 'results':
        if (this.online) {
          this.online.results = msg.results;
          this.ui.banner.classList.add('hidden');
          this.results.show(msg.results, this.playerId, true);
          this.updateResultsHint();
        }
        break;
    }
  }

  private updateResultsHint(): void {
    if (this.mode !== 'online' || !this.online?.results) return;
    this.results.setHint(this.online.isHost ? '<kbd>Entrée</kbd> retour au salon' : "En attente de l'hôte pour revenir au salon…");
  }

  private applySnapshot(s: Snapshot): void {
    const o = this.online!;
    const session = this.session;
    o.snaps.push(s);
    if (o.snaps.length > 40) o.snaps.shift();
    o.lastRecv = performance.now();
    if (o.serverTime === 0 || Math.abs(o.serverTime - s.time) > 0.5) o.serverTime = s.time;
    session.phase = s.phase;

    for (const rs of s.racers) {
      const r = session.racer(rs.id);
      if (!r) continue;
      const p = r.prog;
      p.lap = rs.p[0];
      r.rank = rs.p[1];
      r.finishTime = rs.p[2] >= 0 ? rs.p[2] : null;
      r.finishPosition = rs.p[3] || null;
      p.finished = r.finishTime !== null;
      p.bestLap = rs.p[4] >= 0 ? rs.p[4] : Infinity;
      p.lapStartTime = rs.p[5];
      p.wrongWayTime = rs.p[6];
      p.s = rs.p[7];
      p.nextGate = rs.p[8];
      r.slot.item = rs.i[0] >= 0 ? ITEM_INDEX[rs.i[0]] : null;
      r.slot.rolling = rs.i[1];
      r.slot.shield = rs.i[2];
      r.slot.reserve = rs.i[3] >= 0 ? ITEM_INDEX[rs.i[3]] : null;
      r.slot.reserveRolling = rs.i[4];
      const view = this.views.find((v) => v.racer.id === rs.id);
      if (view && view.disconnected !== (rs.dc === 1) && rs.id !== this.playerId) {
        view.disconnected = rs.dc === 1;
        view.tag?.removeFromParent();
        view.tag = nameTag(r.name, r.color, view.disconnected);
        view.kart.object.add(view.tag);
      }
      if (rs.id === this.playerId) {
        const server = unpackKart(rs.k, createKartState());
        const wasAi = o.myAi;
        o.myAi = rs.ai === 1;
        if (o.myAi) {
          o.predictor.reset(server);
        } else {
          o.predictor.stall = rs.p[9];
          const before = new THREE.Vector3(o.predictor.state.x, o.predictor.state.y, o.predictor.state.z);
          const corr = wasAi ? 99 : o.predictor.reconcile(server, rs.ack, this.params, this.statics());
          o.lastCorrection = corr;
          if (corr > 3) {
            // Respawn / teleport / long stall: jump, no smoothing.
            if (wasAi) o.predictor.reset(server);
            o.correction.set(0, 0, 0);
            this.player.kart.snap();
          } else {
            o.correction.x += before.x - o.predictor.state.x;
            o.correction.y += before.y - o.predictor.state.y;
            o.correction.z += before.z - o.predictor.state.z;
          }
        }
      }
    }

    // Items.
    const items = session.items;
    for (let i = 0; i < items.crates.length; i += 1) items.crates[i].active = s.crates[i] === '1';
    items.projectiles.length = 0;
    for (const p of s.projectiles) items.projectiles.push({ ...p, age: 0, bounces: 0, targetId: null, s: 0 });
    items.hazards.length = 0;
    for (const h of s.hazards) items.hazards.push({ ...h });

    this.handleEvents(s.events, s.itemEvents);
  }

  private statics() {
    return [...this.track.def.obstacles, ...this.session.items.colliders()];
  }

  /** Interpolate remote karts between the two snapshots around (server time - delay). */
  private interpolateRemotes(): void {
    const o = this.online!;
    const snaps = o.snaps;
    if (snaps.length === 0) return;
    const renderTime = o.serverTime - INTERP_DELAY;
    let a = snaps[0];
    let b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i > 0; i -= 1) {
      if (snaps[i - 1].time <= renderTime) {
        a = snaps[i - 1];
        b = snaps[i];
        break;
      }
    }
    const span = b.time - a.time;
    const t = span > 0 ? Math.max(0, Math.min(1.2, (renderTime - a.time) / span)) : 1;
    const ka = createKartState();
    const kb = createKartState();
    for (const v of this.views) {
      const isMe = v.racer.id === this.playerId;
      if (isMe && !o.myAi) continue;
      const ra = a.racers.find((r) => r.id === v.racer.id);
      const rb = b.racers.find((r) => r.id === v.racer.id);
      if (!ra || !rb) continue;
      unpackKart(ra.k, ka);
      unpackKart(rb.k, kb);
      const target = isMe ? o.predictor.state : v.racer.kart;
      v.kart.savePrevious();
      Object.assign(target, t < 0.5 ? ka : kb);
      target.x = ka.x + (kb.x - ka.x) * t;
      target.y = ka.y + (kb.y - ka.y) * t;
      target.z = ka.z + (kb.z - ka.z) * t;
      let dh = kb.heading - ka.heading;
      if (dh > Math.PI) dh -= Math.PI * 2;
      else if (dh < -Math.PI) dh += Math.PI * 2;
      target.heading = ka.heading + dh * t;
      target.forwardSpeed = ka.forwardSpeed + (kb.forwardSpeed - ka.forwardSpeed) * t;
      // A respawn between snapshots: don't slide across the map.
      if (Math.hypot(kb.x - ka.x, kb.z - ka.z) > 6) v.kart.snap();
    }
  }

  // -------------------------------------------------------------------------
  // Frame / fixed step
  // -------------------------------------------------------------------------

  private update(delta: number): void {
    this.frame += 1;
    if (resizeRenderer(this.renderer, this.camera, this.maxDpr()) && this.composer) {
      const size = this.renderer.getSize(new THREE.Vector2());
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(size.x, size.y);
    }
    this.trackFps();

    const racing = this.mode === 'solo' || this.mode === 'online';
    if (racing && this.input.consumePress('KeyR') && this.session.phase === 'racing') this.manualRespawn();
    const enter = this.input.consumePress('Enter') || this.input.consumePress('NumpadEnter');
    if (enter && this.results.visible) {
      if (this.mode === 'solo') this.startSolo(this.soloBots, this.soloSkill);
      else if (this.mode === 'online' && this.online?.isHost) this.net.send({ t: 'backToLobby' });
    }
    if (this.input.consumePress('Escape')) {
      if (this.options.visible) this.options.close();
      else if (this.pauseMenu.visible) this.resume();
      else if (racing && !this.results.visible) this.openPause();
      else if (racing && this.results.visible) this.quitToMenu();
    }
    if (this.input.consumePress('KeyH')) this.ui.help.classList.toggle('hidden');

    if (!this.paused && !this.menuPaused) {
      this.accumulator += delta;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        this.fixedStep();
        this.accumulator -= FIXED_DT;
        steps += 1;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    }

    if (this.mode === 'online' && this.online) {
      const o = this.online;
      // Server clock estimate: advance locally, ease toward the latest snapshot.
      o.serverTime += this.paused ? 0 : delta;
      const latest = o.snaps[o.snaps.length - 1];
      if (latest) {
        const target = latest.time + (performance.now() - o.lastRecv) / 1000;
        if (Math.abs(target - o.serverTime) > 0.3) o.serverTime = target;
        else o.serverTime += (target - o.serverTime) * 0.05;
      }
      this.session.time = o.serverTime;
      this.interpolateRemotes();
      for (const p of this.session.items.projectiles) {
        p.x += p.vx * delta;
        p.z += p.vz * delta;
      }
    }

    const alpha = this.paused ? 1 : this.accumulator / FIXED_DT;
    for (const v of this.views) {
      const remote = this.mode === 'online' && (v !== this.player || this.online!.myAi);
      v.kart.render(remote ? 1 : alpha, delta, this.params, this.fx, this.ground);
    }
    if (this.mode === 'online' && this.online && !this.online.myAi) {
      // Smooth out prediction corrections instead of snapping.
      const c = this.online.correction;
      c.multiplyScalar(Math.exp(-12 * delta));
      this.player.kart.object.position.add(c);
    }
    this.itemView?.update(
      delta,
      this.views.map((v) => ({ id: v.racer.id, root: v.kart.object, shield: v.racer.slot.shield })),
    );
    this.itemUi.update(delta, this.player.racer.slot);
    this.fx.update(delta);

    if (this.mode === 'demo') this.chase.orbit = 0;
    else {
      const introT = Math.min(1, this.session.time / (COUNTDOWN - 0.8));
      this.chase.orbit = Math.PI * (1 - introT) ** 3;
    }
    this.chase.update(delta, this.chaseTarget());

    const cam = this.camera.position;
    for (const v of this.views) {
      if (v === this.player) continue;
      const o = v.kart.object.position;
      v.kart.object.visible = (o.x - cam.x) ** 2 + (o.z - cam.z) ** 2 > 2.2 * 2.2 || cam.y > o.y + 2.6;
    }

    const p = this.player.kart.object.position;
    this.key.position.set(p.x - 10, p.y + 30, p.z - 8);
    this.key.target.position.set(p.x, p.y, p.z);

    if (this.mode !== 'demo') this.updateHud();
    this.updateAudio(delta);
    this.autoQuality();
    if (this.mode === 'solo' && this.playerFinishedAt >= 0 && this.session.time - this.playerFinishedAt > RESULTS_DELAY) {
      if (!this.results.visible) this.ui.banner.classList.add('hidden');
      this.results.show(this.session.results(), this.playerId, this.session.phase === 'finished');
    }
    if (this.mode === 'demo' && this.session.phase === 'finished') this.startDemo();
    this.input.endFrame();
    this.publishDiagnostics();
  }

  private fixedStep(): void {
    if (this.mode === 'online') {
      this.onlineStep();
      return;
    }
    for (const v of this.views) v.kart.savePrevious();
    if (this.mode === 'solo') {
      const input = this.input.read({ throttle: 0, steer: 0, drift: false, item: false });
      this.session.setInput(this.playerId, input);
    }
    this.session.step(FIXED_DT);
    if (this.mode === 'solo') this.handleEvents(this.session.events, this.session.items.events);
    else {
      for (const v of this.views) v.kart.collectStepEvents();
      this.itemView?.onEvents(this.fx);
      for (const e of this.session.events) if (e.type === 'respawn') this.views.find((x) => x.racer.id === e.racer)?.kart.snap();
    }
  }

  private onlineStep(): void {
    const o = this.online!;
    this.input.read(o.input);
    if (this.pauseMenu.visible || this.options.visible) Object.assign(o.input, { throttle: 0, steer: 0, drift: false, item: false });
    const seq = o.predictor.nextSeq();
    this.net.send({ t: 'input', seq, i: packInput(o.input) });
    if (this.session.phase === 'racing' && !o.myAi) {
      this.player.kart.savePrevious();
      o.predictor.apply(seq, o.input, this.params, this.statics());
      this.player.kart.collectStepEvents();
    }
  }

  // -------------------------------------------------------------------------
  // Settings, quality, pause
  // -------------------------------------------------------------------------

  private maxDpr(): number {
    return QUALITY_PRESETS[this.quality].maxDpr;
  }

  private applySettings(): void {
    const s = this.settings;
    saveSettings(s);
    this.audio.setVolumes(s.music, s.sfx, s.engines);
    this.ui.fps.classList.toggle('hidden', !s.showFps);
    if (s.quality === 'auto') {
      if (!this.autoDecided) this.applyQuality('high');
      this.options.setQualityNote(
        this.autoDecided
          ? `Mode automatique : qualité ${this.quality === 'high' ? 'haute' : 'basse'} retenue.`
          : 'Mode automatique : la qualité baisse si le jeu descend sous 45 fps.',
      );
    } else {
      this.applyQuality(s.quality);
      this.options.setQualityNote('');
    }
  }

  private applyQuality(level: 'low' | 'high'): void {
    const preset = QUALITY_PRESETS[level];
    const shadowsChanged = this.renderer.shadowMap.enabled !== preset.shadows;
    this.quality = level;
    this.renderer.shadowMap.enabled = preset.shadows;
    this.key.castShadow = preset.shadows;
    if (this.key.shadow.mapSize.x !== preset.shadowMapSize) {
      this.key.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      this.key.shadow.map?.dispose();
      (this.key.shadow as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    if (shadowsChanged) {
      // Materials must recompile with or without shadow sampling.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    this.fx.density = preset.sparks;
    if (preset.bloom && !this.composer) {
      const size = this.renderer.getSize(new THREE.Vector2());
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));
      // Half-resolution bloom: glow on the LED fixtures, beacons and boost flames.
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.5, 0.45, 0.9));
      composer.addPass(new OutputPass());
      this.composer = composer;
    }
    resizeRenderer(this.renderer, this.camera, preset.maxDpr);
    if (this.composer) {
      const size = this.renderer.getSize(new THREE.Vector2());
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(size.x, size.y);
    }
  }

  private lastAutoTime = performance.now();

  /** Auto quality: watch real frame times over ~5 s of racing, drop to low under 45 fps. */
  private autoQuality(): void {
    const now = performance.now();
    const frameMs = now - this.lastAutoTime;
    this.lastAutoTime = now;
    if (this.settings.quality !== 'auto' || this.autoDecided || this.quality === 'low') return;
    if (this.mode === 'demo' || this.session.phase !== 'racing' || this.menuPaused || document.hidden) return;
    if (frameMs > 0 && frameMs < 500) this.autoFps.push(1000 / frameMs);
    if (this.autoFps.length < 300) return;
    const sorted = [...this.autoFps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.autoDecided = true;
    if (median < 45) {
      this.applyQuality('low');
      this.flash(`Qualité basse activée (${Math.round(median)} fps)`);
    }
    this.applySettings();
  }

  private openPause(): void {
    this.pauseMenu.open(this.mode === 'online');
    if (this.mode === 'solo') {
      this.menuPaused = true;
      this.audio.setPaused(true);
    }
  }

  private resume(): void {
    this.pauseMenu.close();
    if (this.options.visible) this.options.close();
    this.menuPaused = false;
    this.audio.setPaused(false);
    this.focusGame();
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  private readonly camRight = new THREE.Vector3();

  /** Volume / pan for a sound at (x, z), heard from the local player. */
  private spatial(x: number, z: number, radius = 50): { volume: number; pan: number } {
    const p = this.player.kart.object.position;
    const d = Math.hypot(x - p.x, z - p.z);
    const volume = d < 1.5 ? 1 : Math.max(0, 1 - d / radius) ** 1.6;
    this.camRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const cam = this.camera.position;
    const rx = x - cam.x;
    const rz = z - cam.z;
    const len = Math.max(1, Math.hypot(rx, rz));
    return { volume, pan: ((rx * this.camRight.x + rz * this.camRight.z) / len) * 0.8 };
  }

  private sfxAt(name: SfxName, x: number, z: number, gain = 1, radius = 50): void {
    const s = this.spatial(x, z, radius);
    this.audio.play(name, { volume: s.volume * gain, pan: s.pan });
  }

  private posOf(id: string): THREE.Vector3 {
    return (this.views.find((v) => v.racer.id === id) ?? this.player).kart.object.position;
  }

  private updateAudio(delta: number): void {
    const racing = this.mode !== 'demo' && !this.results.visible;
    const prog = this.player.racer.prog;
    const finalLap = racing && prog.lap >= this.track.def.laps && !prog.finished;
    this.audio.setMusic(racing && !this.menu.visible ? 'race' : 'menu', finalLap);
    if (!this.audio.ready) return;

    const keep = new Set<string>();
    for (const v of this.views) {
      const isMe = v === this.player;
      const k = isMe ? this.playerKartState() : v.racer.kart;
      const pos = v.kart.object.position;
      const sp = isMe && this.mode !== 'demo' ? { volume: 1, pan: 0 } : this.spatial(pos.x, pos.z, 40);
      if (sp.volume < 0.02 && !isMe) continue;
      keep.add(v.racer.id);
      const input = isMe && this.online ? this.online.input : v.racer.input;
      this.audio.updateEngine(v.racer.id, {
        speed: k.forwardSpeed,
        throttle: input.throttle,
        boosting: k.boostTime > 0,
        driftLevel: k.driftLevel,
        drifting: k.driftDir !== 0,
        reversing: k.forwardSpeed < -0.4,
        spinning: k.spinTime > 0,
        volume: (isMe ? 0.55 : 0.3) * sp.volume * (this.mode === 'demo' ? 0.5 : 1) * (this.menuPaused ? 0 : 1),
        pan: sp.pan,
      });
    }
    this.audio.pruneEngines(keep);

    if (this.mode === 'demo') return;
    // Item roulette ticks.
    if (this.player.racer.slot.rolling > 0 || this.player.racer.slot.reserveRolling > 0) {
      this.rollTick -= delta;
      if (this.rollTick <= 0) {
        this.audio.play('rollTick', { volume: 0.7 });
        this.rollTick = 0.085;
      }
    } else this.rollTick = 0;
    // A tracked parcel closing in: faster and faster beeps.
    const me = this.player.kart.object.position;
    let nearest = Infinity;
    for (const p of this.session.items.projectiles) {
      if (p.kind !== 'tracked' || p.owner === this.playerId) continue;
      nearest = Math.min(nearest, Math.hypot(p.x - me.x, p.z - me.z));
    }
    if (nearest < 35) {
      this.trackedBeep -= delta;
      if (this.trackedBeep <= 0) {
        this.audio.play('warning', { volume: 0.9 });
        this.trackedBeep = 0.08 + (nearest / 35) * 0.45;
      }
    }
  }

  private quitToMenu(): void {
    if (this.mode === 'online') {
      this.net.send({ t: 'leave' });
      this.inLobby = false;
    }
    this.startDemo();
    this.menu.showHome();
  }

  // -------------------------------------------------------------------------
  // Events / HUD
  // -------------------------------------------------------------------------

  private handleEvents(events: readonly RaceEvent[], itemEvents: readonly ItemEvent[]): void {
    const me = this.playerId;
    for (const e of events) {
      switch (e.type) {
        case 'countdown':
          this.showCountdown(e.value);
          this.audio.play(e.value > 0 ? 'countdown' : 'go');
          break;
        case 'respawn': {
          const v = this.views.find((x) => x.racer.id === e.racer);
          if (v && !(this.mode === 'online' && v === this.player)) v.kart.snap();
          if (e.racer === me) this.chase.snap(this.chaseTarget());
          break;
        }
        case 'impact': {
          if (e.racer === me) {
            this.chase.addTrauma(Math.min(0.6, e.strength * 0.05));
            this.audio.play('impact', { volume: Math.min(1, 0.25 + e.strength * 0.06) });
          } else {
            const p = this.posOf(e.racer);
            this.sfxAt('impact', p.x, p.z, Math.min(0.8, e.strength * 0.05), 35);
          }
          break;
        }
        case 'boost':
          if (e.racer === me) {
            this.chase.addTrauma(0.12);
            this.audio.play('miniTurbo', { volume: 0.5 + e.level * 0.15 });
          }
          break;
        case 'startBoost':
          if (e.racer === me) {
            this.flash('Départ canon !');
            this.audio.play('boost');
          }
          break;
        case 'stall':
          if (e.racer === me) {
            this.flash('Calé ! (accéléré trop tôt)');
            this.audio.play('stall');
          }
          break;
        case 'lap':
          if (e.racer === me) {
            const prog = this.player.racer.prog;
            const best = e.lapTime <= prog.bestLap + 1e-6 ? ' · meilleur tour !' : '';
            const laps = this.track.def.laps;
            this.audio.play(e.lap === laps ? 'finalLap' : 'lap');
            this.flash(e.lap === laps ? `DERNIER TOUR ! (${formatTime(e.lapTime)}${best})` : `TOUR ${e.lap} (${formatTime(e.lapTime)}${best})`);
          }
          break;
        case 'finish':
          if (e.racer === me) {
            this.playerFinishedAt = this.session.time;
            this.audio.play('finish');
            this.ui.banner.innerHTML = `ARRIVÉE ! ${e.position}${ordinal(e.position)}<small>${formatTime(e.time)}</small>`;
            this.ui.banner.classList.add('finish');
            this.ui.banner.classList.remove('hidden');
          }
          break;
      }
    }
    if (this.mode === 'solo') for (const v of this.views) v.kart.collectStepEvents();
    const items = this.session.items;
    if (items.events !== itemEvents) {
      items.events.length = 0;
      items.events.push(...itemEvents);
    }
    this.itemView?.onEvents(this.fx);
    this.itemSounds(itemEvents);
    for (const e of itemEvents) {
      if (e.type === 'hit' && e.racer === me) {
        this.chase.addTrauma(0.55);
        const what = { oil: "Flaque d'huile !", carton: 'Carton reçu !', tracked: 'Colis tracké !', pallet: 'Palette !' }[e.cause];
        this.flash(what);
      } else if (e.type === 'blocked' && e.racer === me) {
        this.flash('Film étirable : attaque bloquée');
      } else if (e.type === 'hit' && e.by === me) {
        this.flash(`Touché : ${this.session.racer(e.racer)?.name ?? ''} !`);
      } else if (e.type === 'land') {
        const pk = this.playerKartState();
        const d = Math.hypot(e.x - pk.x, e.z - pk.z);
        if (d < 20) this.chase.addTrauma(Math.max(0, 0.5 - d * 0.025));
      }
    }
  }

  private itemSounds(itemEvents: readonly ItemEvent[]): void {
    const me = this.playerId;
    const useSfx: Record<ItemType, SfxName> = {
      express: 'boost',
      oil: 'oil',
      carton: 'throw',
      tracked: 'tracked',
      film: 'film',
      pallet: 'palletWhistle',
    };
    for (const e of itemEvents) {
      switch (e.type) {
        case 'pickup': {
          const c = this.session.items.crates[e.crate];
          if (e.racer === me) this.audio.play('pickup');
          else if (c) this.sfxAt('pickup', c.x, c.z, 0.5, 30);
          break;
        }
        case 'rolled':
          if (e.racer === me) this.audio.play('rolled');
          break;
        case 'use': {
          if (e.racer === me) this.audio.play(useSfx[e.item]);
          else if (e.item === 'pallet') this.audio.play('palletWhistle', { volume: 0.5 });
          else {
            const p = this.posOf(e.racer);
            this.sfxAt(useSfx[e.item], p.x, p.z, 0.7, 40);
          }
          break;
        }
        case 'hit': {
          if (e.racer === me) this.audio.play('hit');
          else {
            const p = this.posOf(e.racer);
            this.sfxAt('hit', p.x, p.z, 0.7, 45);
          }
          break;
        }
        case 'blocked': {
          const p = this.posOf(e.racer);
          if (e.racer === me) this.audio.play('shieldBlock');
          else this.sfxAt('shieldBlock', p.x, p.z, 0.6, 40);
          break;
        }
        case 'bounce':
          this.sfxAt('bounce', e.x, e.z, 0.6, 30);
          break;
        case 'destroyed':
          this.sfxAt('bounce', e.x, e.z, 0.8, 30);
          break;
        case 'land':
          this.sfxAt('palletLand', e.x, e.z, 1, 70);
          break;
      }
    }
  }

  private showCountdown(value: number): void {
    const el = this.ui.countdown;
    const text = value === 0 ? 'GO !' : String(value);
    el.textContent = text;
    el.classList.remove('hidden', 'pop');
    void el.offsetWidth;
    el.classList.add('pop');
    el.classList.toggle('go', value === 0);
    if (value > 0) this.setStartLights(4 - value, false);
    else this.setStartLights(3, true);
    window.setTimeout(() => {
      if (el.textContent === text) el.classList.add('hidden');
    }, 950);
    if (value === 0) window.setTimeout(() => this.setStartLights(0, false), 2500);
  }

  private setStartLights(count: number, green: boolean): void {
    this.startLights.forEach((lamp, i) => {
      const mat = lamp.material as THREE.MeshStandardMaterial;
      if (green) {
        mat.color.set('#063306');
        mat.emissive.set('#22ff44');
        mat.emissiveIntensity = 3;
      } else {
        mat.color.set('#330606');
        mat.emissive.set('#ff1a1a');
        mat.emissiveIntensity = i < count ? 3.2 : 0.12;
      }
    });
  }

  private manualRespawn(): void {
    if (this.mode === 'solo') this.session.requestRespawn(this.playerId);
    // Online: the server respawns automatically when stuck; R is a solo convenience for now.
  }

  private flash(text: string): void {
    this.ui.lapFlash.textContent = text;
    this.ui.lapFlash.classList.remove('hidden');
    this.lapFlashUntil = performance.now() + 2200;
  }

  /** Kart state shown for the local player (prediction when online). */
  private playerKartState(): KartState {
    if (this.mode === 'online' && this.online) return this.online.predictor.state;
    return this.player.racer.kart;
  }

  private chaseTarget() {
    const s = this.playerKartState();
    const o = this.player.kart.object.position;
    return {
      x: o.x,
      y: o.y,
      z: o.z,
      heading: this.player.kart.object.rotation.y,
      speed: Math.abs(s.forwardSpeed),
      maxSpeed: this.params.maxSpeed,
      boosting: s.boostTime > 0,
      driftDir: s.driftDir,
    };
  }

  private render(): void {
    if (this.composer && this.quality === 'high') this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private updateNetBadge(): void {
    const badge = this.ui.netBadge;
    if (this.mode !== 'online') {
      badge.classList.add('hidden');
      return;
    }
    badge.classList.remove('hidden');
    const s = this.net.status;
    badge.textContent = s === 'online' ? `${Math.round(this.net.rtt)} ms` : 'Connexion perdue – reconnexion…';
    badge.classList.toggle('bad', s !== 'online');
  }

  private updateHud(): void {
    const r = this.player.racer;
    const s = this.playerKartState();
    const prog = r.prog;
    this.ui.speed.textContent = String(Math.round(Math.abs(s.forwardSpeed) * 3.6));
    this.ui.segs.forEach((seg, i) => seg.classList.toggle('on', s.driftDir !== 0 && s.driftLevel > i));
    this.ui.boost.classList.toggle('on', s.boostTime > 0);

    const pos = r.finishPosition ?? r.rank;
    this.ui.pos.textContent = String(pos);
    this.ui.posSuffix.textContent = ordinal(pos);
    this.ui.posBox.dataset.pos = String(Math.min(pos, 4));
    const finalLap = prog.lap >= this.track.def.laps && !prog.finished;
    this.ui.lapBox.classList.toggle('final', finalLap);
    this.ui.speedlines.classList.toggle('on', s.boostTime > 0 && !this.menuPaused);
    const laps = this.track.def.laps;
    this.ui.lap.textContent = String(Math.min(laps, Math.max(1, prog.lap)));
    const raceTime = r.finishTime ?? this.session.raceTime;
    this.ui.timeTotal.textContent = this.session.phase === 'countdown' ? '0:00.000' : formatTime(raceTime);
    this.ui.timeLap.textContent = prog.lap >= 1 && !prog.finished ? formatTime(this.session.time - prog.lapStartTime) : '–';
    this.ui.timeBest.textContent = formatTime(prog.bestLap);

    if (!prog.finished && !this.results.visible) {
      const wrong = prog.wrongWayTime > 1;
      this.ui.banner.classList.toggle('hidden', !wrong);
      if (wrong) {
        this.ui.banner.classList.remove('finish');
        this.ui.banner.innerHTML = 'MAUVAIS SENS<small>Faites demi-tour</small>';
      }
    }
    if (this.lapFlashUntil && performance.now() > this.lapFlashUntil) {
      this.ui.lapFlash.classList.add('hidden');
      this.lapFlashUntil = 0;
    }
    if (this.frame % 2 === 0) {
      this.minimap.draw(
        this.views.map((v) => {
          const k = v === this.player ? s : v.racer.kart;
          return { x: k.x, z: k.z, color: v.racer.color, isPlayer: v === this.player };
        }),
      );
    }
    if (this.frame % 30 === 0) this.updateNetBadge();
  }

  private trackFps(): void {
    const now = performance.now();
    this.fpsAccum += (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      const info = this.renderer.info.render;
      this.ui.fps.textContent = `${this.fps.toFixed(0)} fps · ${info.calls} draw calls · ${(info.triangles / 1000).toFixed(0)}k tris`;
    }
  }

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: () => {},
      setState: (name: string) => {
        if (name !== 'active-play') throw new Error(`Unknown test state: ${name}`);
        this.startSolo(this.soloBots, this.soloSkill);
        return { state: name };
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.paused = paused;
      },
      setReducedMotion: () => {},
      hideDebugUi: (hidden: boolean) => this.debug.setHidden(hidden),
      setInput: (input) => {
        this.input.override = input;
      },
      teleport: (x, z, heading) => {
        this.session.teleport(this.playerId, x, z, heading);
        this.player.kart.snap();
        this.chase.snap(this.chaseTarget());
      },
      autopilot: (enabled: boolean) => {
        this.session.setAutoDrive(this.playerId, enabled);
      },
      giveItem: (item: string) => {
        this.player.racer.slot.item = item as ItemType;
        this.player.racer.slot.rolling = 0;
      },
      skipCountdown: () => {
        while (this.session.phase === 'countdown') this.session.step(FIXED_DT);
        for (const v of this.views) v.kart.snap();
      },
      simulate: (seconds: number) => {
        for (let t = 0; t < seconds; t += FIXED_DT) this.fixedStep();
        for (const v of this.views) v.kart.snap();
        this.chase.snap(this.chaseTarget());
      },
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const r = this.player.racer;
    const s = this.playerKartState();
    const prog = r.prog;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.session.time,
      score: prog.lap,
      targetScore: this.track.def.laps,
      complete: prog.finished,
      player: {
        position: { x: s.x, y: s.y, z: s.z },
        speed: s.forwardSpeed,
        lap: prog.lap,
        s: prog.s,
        respawns: prog.respawns,
        heading: s.heading,
        driftLevel: s.driftLevel,
        boostTime: s.boostTime,
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      },
      fps: this.fps,
      items: {
        hazards: this.session.items.hazards.map((h) => ({ kind: h.kind, x: h.x, z: h.z, fall: h.fall })),
        projectiles: this.session.items.projectiles.length,
        held: r.slot.item,
        shield: r.slot.shield,
      },
      race: {
        phase: this.session.phase,
        rank: r.finishPosition ?? r.rank,
        raceTime: this.session.raceTime,
        results: this.results.visible,
        racers: this.session.racers.map((x) => ({
          name: x.name,
          lap: x.prog.lap,
          finished: x.finishTime !== null,
          dc: this.views.find((v) => v.racer === x)?.disconnected ?? false,
        })),
      },
      net: {
        mode: this.mode,
        status: this.net.status,
        id: this.net.id,
        rtt: this.net.rtt,
        inLobby: this.inLobby,
        snaps: this.online?.snaps.length ?? 0,
        pending: this.online?.predictor.pendingCount ?? 0,
        lastCorrection: this.online?.lastCorrection ?? 0,
        myAi: this.online?.myAi ?? false,
      },
      audio: { ready: this.audio.ready, quality: this.quality, paused: this.menuPaused },
    };
  }

  private el(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  }
}
