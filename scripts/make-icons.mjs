#!/usr/bin/env node
/**
 * 生成品牌图标：client/build/icon.ico（Windows 安装包与托盘）、web/public/favicon.svg。
 *
 * 为什么手写 PNG 编码：图标是构建产物，引 sharp/canvas 这类原生依赖
 * 会破坏「零原生依赖」这条部署底线。PNG 的编码其实很直白：
 * IHDR + IDAT(zlib deflate) + IEND，再套一层 ICO 头即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素缓冲 → PNG */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前面加一个 filter byte（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- 绘制 */

const SIZE = 256;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 圆角矩形的覆盖率（0..1），用于抗锯齿 */
function roundedRectCoverage(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (x < left || x > right || y < top || y > bottom) return 0;
  if (dist <= radius) return 1;
  return Math.max(0, 1 - (dist - radius));
}

/** 生成 256×256 图标：极光渐变圆角方块 + 白色等距立方体（呼应《我的世界》的方块） */
function drawIcon() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const pad = 18;
  const radius = 56;

  // 立方体几何：等距投影的六个顶点
  const cx = SIZE / 2;
  const top = { x: cx, y: 66 };
  const left = { x: 58, y: 118 };
  const right = { x: 198, y: 118 };
  const center = { x: cx, y: 170 };
  const bottomLeft = { x: 58, y: 170 + 24 };
  const bottomRight = { x: 198, y: 170 + 24 };
  const bottomCenter = { x: cx, y: 170 + 48 };

  const stroke = 9;

  /** 点到线段的距离，用于描边 */
  function distToSegment(px, py, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = px - a.x;
    const wy = py - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
    const projX = a.x + t * vx;
    const projY = a.y + t * vy;
    return Math.hypot(px - projX, py - projY);
  }

  const edges = [
    [top, left],
    [top, right],
    [left, center],
    [right, center],
    [top, center],
    [left, bottomLeft],
    [bottomLeft, bottomCenter],
    [bottomRight, bottomCenter],
    [right, bottomRight],
    [center, bottomCenter],
  ];

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      // 背景：沿对角线的青绿 → 靛蓝 → 紫
      const t = (px + py) / (SIZE * 2);
      let r = t < 0.5 ? lerp(53, 124, t * 2) : lerp(124, 176, (t - 0.5) * 2);
      let g = t < 0.5 ? lerp(224, 140, t * 2) : lerp(140, 124, (t - 0.5) * 2);
      let b = t < 0.5 ? lerp(200, 255, t * 2) : lerp(255, 255, (t - 0.5) * 2);

      // 描边（白色，带一点柔和边缘）
      let ink = 0;
      for (const [a, e] of edges) {
        const d = distToSegment(px, py, a, e);
        if (d < stroke) ink = Math.max(ink, Math.min(1, (stroke - d) / 1.6));
      }
      r = lerp(r, 255, ink);
      g = lerp(g, 255, ink);
      b = lerp(b, 255, ink);

      const alpha = roundedRectCoverage(px, py, pad, pad, SIZE - pad, SIZE - pad, radius);
      const i = (y * SIZE + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/** 把 PNG 包成 ICO（Vista+ 支持 ICO 里直接放 PNG） */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width（256 记作 0）
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

/* ---------------------------------------------------------------- 输出 */

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#35e0c8"/>
      <stop offset="55%" stop-color="#7c8cff"/>
      <stop offset="100%" stop-color="#b07cff"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#g)"/>
  <g fill="none" stroke="#05070f" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.92">
    <path d="M32 17 L15 27 L32 37 L49 27 Z"/>
    <path d="M15 27 L15 40 L32 50 L32 37"/>
    <path d="M49 27 L49 40 L32 50"/>
  </g>
</svg>
`;

function main() {
  const clientBuild = path.join(REPO_ROOT, 'client', 'build');
  const webPublic = path.join(REPO_ROOT, 'web', 'public');
  fs.mkdirSync(clientBuild, { recursive: true });
  fs.mkdirSync(webPublic, { recursive: true });

  const rgba = drawIcon();
  const png = encodePng(SIZE, SIZE, rgba);
  const ico = pngToIco(png, SIZE);

  fs.writeFileSync(path.join(clientBuild, 'icon.ico'), ico);
  fs.writeFileSync(path.join(clientBuild, 'icon.png'), png);
  fs.writeFileSync(path.join(webPublic, 'favicon.svg'), FAVICON_SVG);
  fs.writeFileSync(path.join(webPublic, 'icon-256.png'), png);

  console.log(`icon.ico   ${(ico.length / 1024).toFixed(1)} KB  -> client/build/icon.ico`);
  console.log(`icon.png   ${(png.length / 1024).toFixed(1)} KB  -> client/build/icon.png`);
  console.log('favicon.svg      -> web/public/favicon.svg');
  console.log('icon-256.png     -> web/public/icon-256.png');
}

main();
