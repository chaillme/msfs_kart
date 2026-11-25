import * as THREE from 'three';

/** Procedural canvas textures for the warehouse (no external files needed). */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function concreteTexture(): THREE.CanvasTexture {
  const size = 1024;
  const [c, ctx] = canvas(size, size);
  ctx.fillStyle = '#8c8e90';
  ctx.fillRect(0, 0, size, size);
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2600; i += 1) {
    const r = 6 + rand() * 60;
    const shade = 118 + rand() * 44;
    ctx.fillStyle = `rgba(${shade},${shade},${shade + 2},${0.04 + rand() * 0.05})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 22; i += 1) {
    ctx.fillStyle = `rgba(30,30,32,${0.04 + rand() * 0.07})`;
    ctx.beginPath();
    ctx.ellipse(rand() * size, rand() * size, 10 + rand() * 50, 6 + rand() * 30, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(45,45,48,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1, 1, size - 2, size - 2);
  return finish(c, true);
}

export function claddingTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  const g = ctx.createLinearGradient(0, 0, 32, 0);
  g.addColorStop(0, '#d9dcdf');
  g.addColorStop(0.45, '#c6cacd');
  g.addColorStop(0.55, '#e4e6e8');
  g.addColorStop(1, '#d4d7da');
  ctx.fillStyle = g;
  for (let x = 0; x < 256; x += 32) {
    ctx.save();
    ctx.translate(x, 0);
    ctx.fillRect(0, 0, 32, 256);
    ctx.restore();
  }
  return finish(c, true);
}

export function diamondPlateTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#7d8389';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#a4aab0';
  for (let y = 0; y < 128; y += 16) {
    for (let x = 0; x < 128; x += 16) {
      ctx.save();
      ctx.translate(x + ((y / 16) % 2) * 8 + 4, y + 8);
      ctx.rotate(((y / 16) % 2 ? 1 : -1) * 0.8);
      ctx.fillRect(-5, -1.2, 10, 2.4);
      ctx.restore();
    }
  }
  return finish(c, true);
}

export function checkerTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 32);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const t = finish(c, true);
  t.magFilter = THREE.NearestFilter;
  return t;
}

export function doorTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 256);
  ctx.fillStyle = '#c7ccd1';
  ctx.fillRect(0, 0, 128, 256);
  for (let y = 0; y < 256; y += 32) {
    ctx.fillStyle = '#9ea4aa';
    ctx.fillRect(0, y, 128, 3);
    ctx.fillStyle = '#e1e4e7';
    ctx.fillRect(0, y + 3, 128, 2);
  }
  ctx.fillStyle = '#5a7d9a';
  ctx.fillRect(14, 104, 100, 18); // window strip
  return finish(c);
}

export function hazardTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 32);
  ctx.fillStyle = '#161616';
  ctx.fillRect(0, 0, 128, 32);
  ctx.fillStyle = '#f2c230';
  for (let x = -32; x < 160; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 32);
    ctx.lineTo(x + 12, 32);
    ctx.lineTo(x + 24, 0);
    ctx.lineTo(x + 12, 0);
    ctx.fill();
  }
  return finish(c, true);
}

export function chevronTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 64);
  ctx.fillStyle = '#f2c230';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#121212';
  for (let x = 8; x < 256; x += 56) {
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x + 22, 8);
    ctx.lineTo(x + 44, 32);
    ctx.lineTo(x + 22, 56);
    ctx.lineTo(x, 56);
    ctx.lineTo(x + 22, 32);
    ctx.closePath();
    ctx.fill();
  }
  return finish(c);
}

/** Hanging aisle sign: blue board, orange stripe, big white label. */
export function signTexture(label: string, sub = ''): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 160);
  ctx.fillStyle = '#163f86';
  ctx.fillRect(0, 0, 512, 160);
  ctx.fillStyle = '#f07a12';
  ctx.fillRect(0, 130, 512, 30);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 84px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 256, 66);
  if (sub) {
    ctx.fillStyle = '#111';
    ctx.font = 'bold 22px "Segoe UI", Arial, sans-serif';
    ctx.fillText(sub, 256, 146);
  }
  return finish(c);
}

export function bannerTexture(text: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 128);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = '#e8202a';
  ctx.fillRect(0, 0, 1024, 14);
  ctx.fillRect(0, 114, 1024, 14);
  ctx.fillStyle = '#1b1b1b';
  ctx.font = 'italic 900 70px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 66);
  return finish(c);
}

export function dockNumberTexture(n: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 64);
  ctx.fillStyle = '#f2c230';
  ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 44px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Q${n}`, 64, 34);
  return finish(c);
}
