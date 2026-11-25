import { ITEM_LABELS, ITEM_TYPES, type ItemSlot, type ItemType } from '@shared/items';

/** Draws simple, readable item icons on a canvas (no external art needed). */
export function drawItemIcon(ctx: CanvasRenderingContext2D, item: ItemType, size: number): void {
  const s = size;
  ctx.save();
  ctx.clearRect(0, 0, s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (item) {
    case 'express': {
      // Lightning bolt over a speed arrow.
      ctx.fillStyle = '#2f8cff';
      ctx.beginPath();
      ctx.moveTo(s * 0.12, s * 0.62);
      ctx.lineTo(s * 0.55, s * 0.62);
      ctx.lineTo(s * 0.55, s * 0.5);
      ctx.lineTo(s * 0.9, s * 0.7);
      ctx.lineTo(s * 0.55, s * 0.9);
      ctx.lineTo(s * 0.55, s * 0.78);
      ctx.lineTo(s * 0.12, s * 0.78);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffd23a';
      ctx.strokeStyle = '#7a5300';
      ctx.lineWidth = s * 0.03;
      ctx.beginPath();
      ctx.moveTo(s * 0.58, s * 0.06);
      ctx.lineTo(s * 0.28, s * 0.44);
      ctx.lineTo(s * 0.48, s * 0.44);
      ctx.lineTo(s * 0.36, s * 0.7);
      ctx.lineTo(s * 0.72, s * 0.3);
      ctx.lineTo(s * 0.52, s * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'oil': {
      ctx.fillStyle = '#1a1612';
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.82, s * 0.38, s * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createLinearGradient(s * 0.3, s * 0.1, s * 0.7, s * 0.75);
      g.addColorStop(0, '#5a5048');
      g.addColorStop(1, '#0d0b09');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.08);
      ctx.bezierCurveTo(s * 0.62, s * 0.3, s * 0.78, s * 0.45, s * 0.78, s * 0.58);
      ctx.arc(s * 0.5, s * 0.58, s * 0.28, 0, Math.PI);
      ctx.bezierCurveTo(s * 0.22, s * 0.45, s * 0.38, s * 0.3, s * 0.5, s * 0.08);
      ctx.fill();
      ctx.fillStyle = 'rgba(120,200,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(s * 0.42, s * 0.55, s * 0.05, s * 0.1, -0.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'carton':
    case 'tracked': {
      ctx.fillStyle = '#c49a64';
      ctx.strokeStyle = '#6b4a22';
      ctx.lineWidth = s * 0.03;
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.14);
      ctx.lineTo(s * 0.88, s * 0.32);
      ctx.lineTo(s * 0.88, s * 0.74);
      ctx.lineTo(s * 0.5, s * 0.92);
      ctx.lineTo(s * 0.12, s * 0.74);
      ctx.lineTo(s * 0.12, s * 0.32);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#a77b4b';
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.5);
      ctx.lineTo(s * 0.88, s * 0.32);
      ctx.lineTo(s * 0.88, s * 0.74);
      ctx.lineTo(s * 0.5, s * 0.92);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#6b4a22';
      ctx.beginPath();
      ctx.moveTo(s * 0.12, s * 0.32);
      ctx.lineTo(s * 0.5, s * 0.5);
      ctx.lineTo(s * 0.88, s * 0.32);
      ctx.moveTo(s * 0.5, s * 0.5);
      ctx.lineTo(s * 0.5, s * 0.92);
      ctx.stroke();
      if (item === 'tracked') {
        // Red target reticle.
        ctx.strokeStyle = '#ff2b2b';
        ctx.lineWidth = s * 0.06;
        ctx.beginPath();
        ctx.arc(s * 0.31, s * 0.6, s * 0.14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#ff2b2b';
        ctx.beginPath();
        ctx.arc(s * 0.31, s * 0.6, s * 0.04, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Motion lines.
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = s * 0.04;
        for (const y of [0.45, 0.6, 0.75]) {
          ctx.beginPath();
          ctx.moveTo(s * 0.02, s * y);
          ctx.lineTo(s * 0.09, s * y);
          ctx.stroke();
        }
      }
      break;
    }
    case 'film': {
      // Stretch-film roll.
      ctx.fillStyle = 'rgba(220,235,250,0.9)';
      ctx.strokeStyle = '#7fa6c9';
      ctx.lineWidth = s * 0.03;
      ctx.fillRect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
      ctx.strokeRect(s * 0.2, s * 0.2, s * 0.6, s * 0.6);
      ctx.fillStyle = '#d9c7a4';
      ctx.fillRect(s * 0.44, s * 0.1, s * 0.12, s * 0.8);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      for (const y of [0.3, 0.45, 0.6, 0.72]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.22, s * y);
        ctx.lineTo(s * 0.78, s * (y + 0.04));
        ctx.stroke();
      }
      break;
    }
    case 'pallet': {
      ctx.fillStyle = '#c49a64';
      ctx.fillRect(s * 0.18, s * 0.18, s * 0.64, s * 0.42);
      ctx.fillStyle = '#a77b4b';
      ctx.fillRect(s * 0.1, s * 0.62, s * 0.8, s * 0.08);
      ctx.fillRect(s * 0.1, s * 0.8, s * 0.8, s * 0.08);
      for (const x of [0.12, 0.45, 0.78]) ctx.fillRect(s * x, s * 0.62, s * 0.1, s * 0.26);
      ctx.fillStyle = '#ff2b2b';
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.02);
      ctx.lineTo(s * 0.62, s * 0.14);
      ctx.lineTo(s * 0.38, s * 0.14);
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

/** One item icon canvas with its own roulette animation. */
class ItemIcon {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;
  private shown = '';
  private rouletteIndex = 0;
  private rouletteTimer = 0;

  constructor(canvas: HTMLCanvasElement, fallbackSize: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = Math.round((canvas.clientWidth || fallbackSize) * dpr);
    canvas.width = canvas.height = this.size;
    this.ctx = canvas.getContext('2d')!;
  }

  /** Draws the icon; returns the label text when it changed, otherwise null. */
  update(dt: number, item: ItemType | null, rolling: number): string | null {
    let key: string;
    if (rolling > 0) {
      this.rouletteTimer -= dt;
      if (this.rouletteTimer <= 0) {
        this.rouletteTimer = 0.07 + (1.3 - rolling) * 0.06;
        this.rouletteIndex = (this.rouletteIndex + 1) % ITEM_TYPES.length;
      }
      key = `roll:${this.rouletteIndex}`;
    } else key = item ?? 'empty';
    if (key === this.shown) return null;
    this.shown = key;
    if (key === 'empty') {
      this.ctx.clearRect(0, 0, this.size, this.size);
      return '';
    }
    if (key.startsWith('roll:')) {
      drawItemIcon(this.ctx, ITEM_TYPES[this.rouletteIndex], this.size);
      return '…';
    }
    drawItemIcon(this.ctx, key as ItemType, this.size);
    return ITEM_LABELS[key as ItemType];
  }
}

/** HUD item box (main item) plus the smaller reserve box, each with a roulette while rolling. */
export class ItemSlotUi {
  private readonly main: ItemIcon;
  private readonly reserve: ItemIcon;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly label: HTMLElement,
    private readonly box: HTMLElement,
    reserveCanvas: HTMLCanvasElement,
    private readonly reserveBox: HTMLElement,
  ) {
    this.main = new ItemIcon(canvas, 72);
    this.reserve = new ItemIcon(reserveCanvas, 40);
  }

  update(dt: number, slot: ItemSlot): void {
    this.box.classList.toggle('ready', !!slot.item && slot.rolling <= 0);
    this.box.classList.toggle('shield', slot.shield > 0);
    this.reserveBox.classList.toggle('filled', !!slot.reserve);
    const text = this.main.update(dt, slot.item, slot.rolling);
    if (text !== null) this.label.textContent = text;
    this.reserve.update(dt, slot.reserve, slot.reserveRolling);
  }
}
