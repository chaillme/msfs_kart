import type { Track } from '@shared/track';

export interface MinimapDot {
  x: number;
  z: number;
  color: string;
  isPlayer: boolean;
}

/** Top-down track map with kart dots. The static layer is drawn once. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly scale: number;
  private readonly ox: number;
  private readonly oz: number;

  constructor(private readonly canvas: HTMLCanvasElement, track: Track) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 220;
    const cssH = canvas.clientHeight || 150;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    this.ctx = canvas.getContext('2d')!;
    const b = track.def.bounds;
    const pad = 6 * dpr;
    this.scale = Math.min((canvas.width - pad * 2) / (b.maxX - b.minX), (canvas.height - pad * 2) / (b.maxZ - b.minZ));
    this.ox = pad - b.minX * this.scale + (canvas.width - pad * 2 - (b.maxX - b.minX) * this.scale) / 2;
    this.oz = pad - b.minZ * this.scale + (canvas.height - pad * 2 - (b.maxZ - b.minZ) * this.scale) / 2;

    this.base = document.createElement('canvas');
    this.base.width = canvas.width;
    this.base.height = canvas.height;
    const g = this.base.getContext('2d')!;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // Zones.
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (const zn of track.def.zones) {
      g.fillRect(this.px(zn.minX), this.pz(zn.minZ), (zn.maxX - zn.minX) * this.scale, (zn.maxZ - zn.minZ) * this.scale);
    }
    const path = (samples: { x: number; z: number }[], closed: boolean) => {
      g.beginPath();
      samples.forEach((s, i) => (i === 0 ? g.moveTo(this.px(s.x), this.pz(s.z)) : g.lineTo(this.px(s.x), this.pz(s.z))));
      if (closed) g.closePath();
    };
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 9 * dpr;
    path(track.main, true);
    g.stroke();
    g.strokeStyle = '#d9dde2';
    g.lineWidth = 5 * dpr;
    path(track.main, true);
    g.stroke();
    // Mezzanine section in orange.
    g.strokeStyle = '#f07a12';
    g.beginPath();
    let drawing = false;
    for (const s of track.main) {
      if (s.y > 0.5) {
        if (!drawing) g.moveTo(this.px(s.x), this.pz(s.z));
        else g.lineTo(this.px(s.x), this.pz(s.z));
        drawing = true;
      } else drawing = false;
    }
    g.stroke();
    // Shortcuts dashed.
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.strokeStyle = '#7fb4ff';
    g.lineWidth = 2.5 * dpr;
    for (const br of track.branches) {
      path(br, false);
      g.stroke();
    }
    g.setLineDash([]);
    // Start line.
    const s0 = track.main[0];
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.moveTo(this.px(s0.x - s0.tz * 5), this.pz(s0.z + s0.tx * 5));
    g.lineTo(this.px(s0.x + s0.tz * 5), this.pz(s0.z - s0.tx * 5));
    g.stroke();
  }

  private px(x: number): number {
    return this.ox + x * this.scale;
  }

  private pz(z: number): number {
    return this.oz + z * this.scale;
  }

  draw(dots: MinimapDot[]): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    const dpr = this.canvas.width / (this.canvas.clientWidth || 220);
    // Player last so it is on top.
    const sorted = [...dots].sort((a, b) => Number(a.isPlayer) - Number(b.isPlayer));
    for (const d of sorted) {
      ctx.beginPath();
      ctx.arc(this.px(d.x), this.pz(d.z), (d.isPlayer ? 5 : 3.6) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
      ctx.lineWidth = (d.isPlayer ? 2 : 1.2) * dpr;
      ctx.strokeStyle = d.isPlayer ? '#ffffff' : 'rgba(0,0,0,0.7)';
      ctx.stroke();
    }
  }
}
