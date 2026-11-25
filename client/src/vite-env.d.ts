/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  score: number;
  targetScore: number;
  complete: boolean;
  player: {
    position: { x: number; y: number; z: number };
    speed: number;
    lap: number;
    s: number;
    respawns: number;
    heading: number;
    driftLevel: number;
    boostTime: number;
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    dpr: number;
  };
  fps: number;
  audio?: { ready: boolean; quality: string; paused: boolean };
  net?: { mode: string; status: string; id: string; rtt: number; inLobby: boolean; snaps: number; pending: number; lastCorrection: number; myAi: boolean };
  race?: { phase: string; rank: number; raceTime: number; results: boolean; racers: { name: string; lap: number; finished: boolean; dc?: boolean }[] };
  items?: { hazards: { kind: string; x: number; z: number; fall: number }[]; projectiles: number; held: string | null; shield: number };
}

interface ThreeGameTestHooks {
  seed(value: number): void | Promise<void>;
  setState(name: string): { state: string } | Promise<{ state: string }>;
  setPausedForScreenshot(paused: boolean): void | Promise<void>;
  setReducedMotion(enabled: boolean): void | Promise<void>;
  hideDebugUi(hidden: boolean): void | Promise<void>;
  /** Drive the player kart from a script (null = keyboard again). */
  setInput(input: { throttle: number; steer: number; drift: boolean; item: boolean } | null): void;
  teleport(x: number, z: number, heading: number): void;
  autopilot(enabled: boolean): void;
  giveItem(item: string): void;
  skipCountdown(): void;
  simulate(seconds: number): void;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
