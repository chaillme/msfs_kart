import type { KartInput } from '@shared/kart';

/**
 * Keyboard -> KartInput. Uses physical key codes, so ZQSD on AZERTY and WASD
 * on QWERTY are the same keys (KeyW/KeyA/KeyS/KeyD). Arrows also work.
 */
export class KeyboardInput {
  private readonly keys = new Set<string>();
  private readonly pressedOnce = new Set<string>();
  /** Test / bot override: when set, replaces the keyboard. */
  override: KartInput | null = null;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    // Let menus and text fields work normally.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON')) return;
    if (GAME_KEYS.has(event.code)) event.preventDefault();
    if (!this.keys.has(event.code)) this.pressedOnce.add(event.code);
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = () => this.keys.clear();

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  read(target: KartInput): KartInput {
    if (this.override) return Object.assign(target, this.override);
    const k = this.keys;
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');
    target.throttle = (up ? 1 : 0) - (down ? 1 : 0);
    target.steer = (right ? 1 : 0) - (left ? 1 : 0);
    target.drift = k.has('Space') || k.has('ShiftLeft') || k.has('ShiftRight');
    // Never Ctrl: Ctrl+W (= Ctrl+Z on AZERTY) closes the browser tab.
    target.item = k.has('KeyE') || k.has('Enter') || k.has('NumpadEnter');
    return target;
  }

  /** True once per physical press (for actions such as respawn). */
  consumePress(code: string): boolean {
    const had = this.pressedOnce.has(code);
    this.pressedOnce.delete(code);
    return had;
  }

  endFrame(): void {
    this.pressedOnce.clear();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'KeyE',
  'KeyR',
  'Enter',
  'NumpadEnter',
  'Escape',
]);
