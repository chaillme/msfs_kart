/** Player settings, persisted per browser (localStorage, failures tolerated). */
export type QualityChoice = 'auto' | 'low' | 'high';

export interface Settings {
  quality: QualityChoice;
  music: number;
  sfx: number;
  /** Engine / motor loudness (own slider: easy to tame). */
  engines: number;
  showFps: boolean;
}

const KEY = 'msfs-kart-settings';
const DEFAULTS: Settings = { quality: 'auto', music: 0.5, sfx: 0.8, engines: 0.6, showFps: false };

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      return {
        quality: s.quality === 'low' || s.quality === 'high' || s.quality === 'auto' ? s.quality : DEFAULTS.quality,
        music: typeof s.music === 'number' ? Math.max(0, Math.min(1, s.music)) : DEFAULTS.music,
        sfx: typeof s.sfx === 'number' ? Math.max(0, Math.min(1, s.sfx)) : DEFAULTS.sfx,
        engines: typeof s.engines === 'number' ? Math.max(0, Math.min(1, s.engines)) : DEFAULTS.engines,
        showFps: !!s.showFps,
      };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** What a quality level changes in the renderer. */
export interface QualityPreset {
  shadows: boolean;
  shadowMapSize: number;
  maxDpr: number;
  bloom: boolean;
  sparks: number;
}

export const QUALITY_PRESETS: Record<'low' | 'high', QualityPreset> = {
  low: { shadows: false, shadowMapSize: 1024, maxDpr: 1, bloom: false, sparks: 0.5 },
  high: { shadows: true, shadowMapSize: 2048, maxDpr: 2, bloom: true, sparks: 1 },
};
