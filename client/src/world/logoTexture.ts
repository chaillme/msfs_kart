import * as THREE from 'three';

/**
 * MSF Supply crate texture. Tries the logo file named in the brief, then the
 * file actually shipped, and falls back to a drawn placeholder if neither loads.
 */
const LOGO_CANDIDATES = ['/assets/logo-msf-supply.svg', '/assets/logo-msfsupply.svg'];
const SIZE = 512;

function drawCrateBase(ctx: CanvasRenderingContext2D): void {
  // Moulded white plastic crate face: soft gradient, bevelled frame, ribs.
  const g = ctx.createLinearGradient(0, 0, 0, SIZE);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#e9ecef');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.strokeStyle = '#c9ced4';
  ctx.lineWidth = 22;
  ctx.strokeRect(11, 11, SIZE - 22, SIZE - 22);
  ctx.strokeStyle = '#dfe3e7';
  ctx.lineWidth = 6;
  ctx.strokeRect(34, 34, SIZE - 68, SIZE - 68);
  ctx.fillStyle = '#d5dade';
  for (const y of [70, SIZE - 82]) ctx.fillRect(60, y, SIZE - 120, 10);
}

function drawPlaceholderLogo(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#e00';
  ctx.fillRect(56, 196, SIZE - 112, 120);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 70px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MSF SUPPLY', SIZE / 2, SIZE / 2 + 4);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
}

/** Finds the first logo SVG that is actually served. */
async function loadLogo(): Promise<HTMLImageElement | null> {
  for (const url of LOGO_CANDIDATES) {
    try {
      // HEAD first so a missing file doesn't spam the console with image errors.
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('svg')) continue;
      return await loadImage(url);
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Wide white wall banner carrying the MSF Supply logo (aspect `width / height`). */
export function createWallLogoTexture(aspect: number): THREE.CanvasTexture {
  const W = 2048;
  const H = Math.round(W / aspect);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const base = () => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  };
  base();
  ctx.fillStyle = '#e00';
  ctx.font = `bold ${Math.round(H * 0.5)}px "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MSF SUPPLY', W / 2, H / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  void loadLogo().then((img) => {
    if (!img) return;
    const logoAspect = (img.naturalWidth || 411) / (img.naturalHeight || 83);
    const pad = H * 0.12;
    let h = H - pad * 2;
    let w = h * logoAspect;
    if (w > W - pad * 2) {
      w = W - pad * 2;
      h = w / logoAspect;
    }
    base();
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    tex.needsUpdate = true;
  });
  return tex;
}

export function createCrateTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  drawCrateBase(ctx);
  drawPlaceholderLogo(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  (async () => {
    for (const url of LOGO_CANDIDATES) {
      try {
        // HEAD first so a missing file doesn't spam the console with image errors.
        const res = await fetch(url, { method: 'HEAD' });
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('svg')) continue;
        const img = await loadImage(url);
        const aspect = (img.naturalWidth || 411) / (img.naturalHeight || 83);
        const w = SIZE - 120;
        const h = w / aspect;
        drawCrateBase(ctx);
        ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        tex.needsUpdate = true;
        return;
      } catch {
        // try next candidate
      }
    }
    console.warn('[MSF Supply Kart] logo introuvable, texture provisoire utilisée');
  })();
  return tex;
}
