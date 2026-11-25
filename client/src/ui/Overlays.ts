import type { QualityChoice, Settings } from '../settings';

/** Options dialog (quality, volumes, fps counter). */
export class OptionsPanel {
  private readonly root: HTMLElement;
  private onClose: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    settings: Settings,
    private readonly onChange: (s: Settings) => void,
  ) {
    this.root = document.createElement('section');
    this.root.id = 'options';
    this.root.className = 'overlay hidden';
    this.root.innerHTML = `
      <div class="panel small">
        <h2>Options</h2>
        <label class="row"><span>Qualité graphique</span>
          <select id="o-quality">
            <option value="auto">Automatique</option>
            <option value="high">Haute (ombres, halo des néons)</option>
            <option value="low">Basse (PC modeste)</option>
          </select></label>
        <label class="row"><span>Musique</span><input type="range" id="o-music" min="0" max="1" step="0.05" /></label>
        <label class="row"><span>Effets sonores</span><input type="range" id="o-sfx" min="0" max="1" step="0.05" /></label>
        <label class="row"><span>Moteurs</span><input type="range" id="o-engines" min="0" max="1" step="0.05" /></label>
        <label class="row"><span>Afficher les FPS</span><input type="checkbox" id="o-fps" /></label>
        <p class="hint" id="o-quality-note"></p>
        <div class="actions single"><button class="btn primary" id="o-close">Fermer</button></div>
      </div>`;
    parent.appendChild(this.root);
    const q = this.root.querySelector<HTMLSelectElement>('#o-quality')!;
    const m = this.root.querySelector<HTMLInputElement>('#o-music')!;
    const s = this.root.querySelector<HTMLInputElement>('#o-sfx')!;
    const f = this.root.querySelector<HTMLInputElement>('#o-fps')!;
    const e = this.root.querySelector<HTMLInputElement>('#o-engines')!;
    const sync = () => {
      q.value = settings.quality;
      m.value = String(settings.music);
      s.value = String(settings.sfx);
      e.value = String(settings.engines);
      f.checked = settings.showFps;
    };
    sync();
    const changed = () => {
      settings.quality = q.value as QualityChoice;
      settings.music = Number(m.value);
      settings.sfx = Number(s.value);
      settings.engines = Number(e.value);
      settings.showFps = f.checked;
      this.onChange(settings);
    };
    for (const el of [q, m, s, e, f]) {
      el.addEventListener('input', changed);
      el.addEventListener('keydown', (e) => e.stopPropagation());
    }
    this.root.querySelector('#o-close')!.addEventListener('click', () => this.close());
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  setQualityNote(text: string): void {
    this.root.querySelector('#o-quality-note')!.textContent = text;
  }

  open(onClose?: () => void): void {
    this.onClose = onClose ?? null;
    this.root.classList.remove('hidden');
  }

  close(): void {
    this.root.classList.add('hidden');
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }
}

export interface PauseHandlers {
  onResume: () => void;
  onRestart: () => void;
  onOptions: () => void;
  onQuit: () => void;
}

/** Échap menu. In multiplayer the race keeps running behind it. */
export class PauseMenu {
  private readonly root: HTMLElement;

  constructor(parent: HTMLElement, h: PauseHandlers) {
    this.root = document.createElement('section');
    this.root.id = 'pause';
    this.root.className = 'overlay hidden';
    this.root.innerHTML = `
      <div class="panel small">
        <h2 id="p-title">Pause</h2>
        <p class="hint" id="p-sub"></p>
        <div class="stack">
          <button class="btn primary" id="p-resume">Reprendre</button>
          <button class="btn" id="p-restart">Recommencer la course</button>
          <button class="btn" id="p-options">Options</button>
          <button class="btn" id="p-quit">Quitter au menu</button>
        </div>
        <div class="keys">
          <span><kbd>Z</kbd><kbd>Q</kbd><kbd>S</kbd><kbd>D</kbd> / flèches : conduire</span>
          <span><kbd>Espace</kbd> drift · <kbd>E</kbd> / <kbd>Entrée</kbd> bonus · <kbd>R</kbd> se replacer</span>
        </div>
      </div>`;
    parent.appendChild(this.root);
    this.root.querySelector('#p-resume')!.addEventListener('click', h.onResume);
    this.root.querySelector('#p-restart')!.addEventListener('click', h.onRestart);
    this.root.querySelector('#p-options')!.addEventListener('click', h.onOptions);
    this.root.querySelector('#p-quit')!.addEventListener('click', h.onQuit);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(online: boolean): void {
    this.root.querySelector('#p-title')!.textContent = online ? 'Menu' : 'Pause';
    this.root.querySelector('#p-sub')!.textContent = online
      ? 'La course continue en ligne pendant ce menu : votre chariot est à l’arrêt.'
      : '';
    (this.root.querySelector('#p-restart') as HTMLElement).classList.toggle('hidden', online);
    (this.root.querySelector('#p-quit') as HTMLElement).textContent = online ? 'Quitter la course' : 'Quitter au menu';
    this.root.classList.remove('hidden');
    (this.root.querySelector('#p-resume') as HTMLElement).focus();
  }

  close(): void {
    this.root.classList.add('hidden');
  }
}
