import { normaliseCode, PLAYER_COLORS, sanitiseName, type PlayerInfo, type ServerMessage } from '@shared/net';
import type { NetStatus } from '../net/NetClient';

export interface MenuHandlers {
  onSolo: (bots: number, difficulty: string) => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
  onStart: (fillBots: boolean) => void;
  onLeave: () => void;
  onOptions: () => void;
  onProfile: (name: string, color: string) => void;
}

const PROFILE_KEY = 'msfs-kart-profile';

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function loadProfile(): { name: string; color: string } {
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { name?: string; color?: string };
      return { name: sanitiseName(p.name ?? ''), color: PLAYER_COLORS.includes(p.color ?? '') ? p.color! : PLAYER_COLORS[0] };
    }
  } catch {
    // ignore
  }
  return { name: 'Cariste', color: PLAYER_COLORS[0] };
}

function saveProfile(p: { name: string; color: string }): void {
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

/** Home screen (profile, solo, create / join) and lobby screen. */
export class Menu {
  private profile = loadProfile();
  private readonly home: HTMLElement;
  private readonly lobby: HTMLElement;
  private readonly error: HTMLElement;
  private readonly status: HTMLElement;
  private screen: 'home' | 'lobby' | 'hidden' = 'home';

  constructor(
    private readonly root: HTMLElement,
    private readonly h: MenuHandlers,
  ) {
    root.innerHTML = `
      <div class="menu-card">
        <div class="brand"><span class="logo-chip">MSF</span><h1>MSF Supply <em>Kart</em></h1></div>
        <p class="tagline">Course de chariots élévateurs dans l'entrepôt · 1 à 6 pilotes</p>
        <div class="screen" data-screen="home">
          <label class="field"><span>Pseudo</span><input id="m-name" maxlength="16" autocomplete="off" /></label>
          <div class="field"><span>Couleur</span><div class="swatches" id="m-colors"></div></div>
          <div class="cols">
            <section class="box">
              <h2>Solo</h2>
              <label class="field small"><span>Bots</span>
                <select id="m-bots"><option>0</option><option>1</option><option>2</option><option>3</option><option>4</option><option selected>5</option></select></label>
              <label class="field small"><span>Difficulté</span>
                <select id="m-diff"><option value="facile">Facile</option><option value="normal" selected>Normal</option><option value="difficile">Difficile</option></select></label>
              <button class="btn primary" id="m-solo">Course solo</button>
            </section>
            <section class="box">
              <h2>Multijoueur</h2>
              <button class="btn primary" id="m-create">Créer un salon</button>
              <div class="join-row">
                <input id="m-code" maxlength="4" placeholder="CODE" autocomplete="off" aria-label="Code du salon" />
                <button class="btn" id="m-join">Rejoindre</button>
              </div>
            </section>
          </div>
          <section class="box keys-box">
            <h2>Commandes</h2>
            <ul class="keys-list">
              <li><kbd>Z</kbd><kbd>Q</kbd><kbd>S</kbd><kbd>D</kbd> ou flèches : accélérer, tourner, freiner / reculer</li>
              <li><kbd>Espace</kbd> maintenu en virage : drift, relâcher = mini-turbo (bleu → orange → rouge)</li>
              <li><kbd>E</kbd> ou <kbd>Entrée</kbd> : utiliser le bonus des caisses MSF Supply</li>
              <li>Départ canon : accélérez juste après le « 1 » · <kbd>Échap</kbd> pause / menu</li>
            </ul>
          </section>
          <button class="btn options-btn" id="m-options">Options</button>
        </div>
        <div class="screen hidden" data-screen="lobby"></div>
        <p class="error hidden" id="m-error" role="alert"></p>
        <p class="net-status" id="m-status"></p>
      </div>`;
    this.home = root.querySelector('[data-screen="home"]')!;
    this.lobby = root.querySelector('[data-screen="lobby"]')!;
    this.error = root.querySelector('#m-error')!;
    this.status = root.querySelector('#m-status')!;

    const name = root.querySelector<HTMLInputElement>('#m-name')!;
    name.value = this.profile.name;
    name.addEventListener('change', () => this.setProfile(name.value, this.profile.color));
    const colors = root.querySelector<HTMLElement>('#m-colors')!;
    for (const c of PLAYER_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.dataset.color = c;
      b.setAttribute('aria-label', `Couleur ${c}`);
      b.addEventListener('click', () => this.setProfile(name.value, c));
      colors.appendChild(b);
    }
    this.renderSwatches();

    root.querySelector('#m-options')!.addEventListener('click', () => this.h.onOptions());
    root.querySelector('#m-solo')!.addEventListener('click', () => {
      this.commitName();
      const bots = Number(root.querySelector<HTMLSelectElement>('#m-bots')!.value);
      const diff = root.querySelector<HTMLSelectElement>('#m-diff')!.value;
      this.h.onSolo(bots, diff);
    });
    root.querySelector('#m-create')!.addEventListener('click', () => {
      this.commitName();
      this.h.onCreate();
    });
    const code = root.querySelector<HTMLInputElement>('#m-code')!;
    code.addEventListener('input', () => (code.value = normaliseCode(code.value)));
    const join = () => {
      this.commitName();
      if (code.value.length === 4) this.h.onJoin(code.value);
      else this.showError('Le code du salon fait 4 lettres.');
    };
    root.querySelector('#m-join')!.addEventListener('click', join);
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
      e.stopPropagation();
    });
    name.addEventListener('keydown', (e) => e.stopPropagation());
  }

  get name(): string {
    return this.profile.name;
  }

  get color(): string {
    return this.profile.color;
  }

  private commitName(): void {
    const input = this.root.querySelector<HTMLInputElement>('#m-name')!;
    this.setProfile(input.value, this.profile.color);
  }

  private setProfile(name: string, color: string): void {
    this.profile = { name: sanitiseName(name), color };
    saveProfile(this.profile);
    this.renderSwatches();
    this.h.onProfile(this.profile.name, this.profile.color);
  }

  private renderSwatches(): void {
    this.root.querySelectorAll<HTMLElement>('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.color === this.profile.color));
  }

  showHome(): void {
    this.screen = 'home';
    this.root.classList.remove('hidden');
    this.home.classList.remove('hidden');
    this.lobby.classList.add('hidden');
  }

  showLobby(msg: Extract<ServerMessage, { t: 'lobby' }>, myId: string): void {
    this.screen = 'lobby';
    this.root.classList.remove('hidden');
    this.home.classList.add('hidden');
    this.lobby.classList.remove('hidden');
    this.hideError();
    const me = msg.players.find((p) => p.id === myId);
    const isHost = !!me?.isHost;
    const keepFill = this.lobby.querySelector<HTMLInputElement>('#m-fill')?.checked ?? true;
    const list = msg.players.map((p: PlayerInfo) => `
      <li class="${p.id === myId ? 'me' : ''} ${p.connected ? '' : 'dc'}">
        <i style="background:${p.color}"></i>${esc(p.name)}${p.id === myId ? ' (vous)' : ''}
        ${p.isHost ? '<span class="tag">hôte</span>' : ''}${p.connected ? '' : '<span class="tag dc">déconnecté</span>'}
      </li>`);
    const empty = Array.from({ length: Math.max(0, 6 - msg.players.length) }, () => '<li class="empty">place libre</li>');
    this.lobby.innerHTML = `
      <div class="lobby-head">
        <div><span class="label">Code du salon</span><strong class="code">${esc(msg.code)}</strong></div>
        <button class="btn" id="m-copy">Copier</button>
      </div>
      <p class="hint">Donnez ce code aux autres joueurs : ils le saisissent dans « Rejoindre ».</p>
      <ul class="players">${list.join('')}${empty.join('')}</ul>
      ${
        isHost
          ? `<label class="check"><input type="checkbox" id="m-fill" ${keepFill ? 'checked' : ''}/> Compléter avec des bots jusqu'à 6</label>
             <div class="actions"><button class="btn primary" id="m-start">Lancer la course</button><button class="btn" id="m-leave">Quitter</button></div>`
          : `<p class="hint">En attente de l'hôte…</p><div class="actions"><button class="btn" id="m-leave">Quitter</button></div>`
      }`;
    this.lobby.querySelector('#m-copy')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(msg.code).catch(() => {});
    });
    this.lobby.querySelector('#m-leave')?.addEventListener('click', () => this.h.onLeave());
    const start = this.lobby.querySelector<HTMLButtonElement>('#m-start');
    if (start) {
      const fill = this.lobby.querySelector<HTMLInputElement>('#m-fill')!;
      const update = () => {
        const enough = msg.players.length >= 2 || fill.checked;
        start.disabled = !enough;
        start.title = enough ? '' : 'Il faut au moins 2 pilotes, ou cocher « compléter avec des bots »';
      };
      fill.addEventListener('change', update);
      update();
      start.addEventListener('click', () => this.h.onStart(fill.checked));
    }
  }

  hide(): void {
    this.screen = 'hidden';
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return this.screen !== 'hidden';
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.classList.remove('hidden');
  }

  hideError(): void {
    this.error.classList.add('hidden');
  }

  setStatus(s: NetStatus, rtt: number): void {
    const text: Record<NetStatus, string> = {
      offline: '',
      connecting: 'Connexion au serveur…',
      online: `Connecté au serveur${rtt ? ` · ${Math.round(rtt)} ms` : ''}`,
      reconnecting: 'Serveur injoignable, nouvelle tentative…',
    };
    this.status.textContent = text[s];
    this.status.dataset.state = s;
  }
}
