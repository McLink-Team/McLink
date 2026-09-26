#!/usr/bin/env node
/**
 * 生成品牌图标：client/build/icon.ico（Windows 安装包 / 任务栏 / 托盘）、
 * web/public/favicon.svg 与 web/public/icon-256.png。
 *
 * 为什么要重写这一版（旧版的问题）：
 *   1. 旧图标是青绿→靛蓝→紫的**渐变**方块，与产品设计语言（暖墨底 + 琥珀强调色，
 *      且设计规则明确禁止渐变）完全不符；应用内的 BrandMark 是琥珀立方体，
 *      两者放在一起像两个产品。
 *   2. 旧 ICO 只装了一个 256×256 条目。Windows 在任务栏/Alt-Tab/资源管理器小图标
 *      等场景要 16/24/32/48 的自有尺寸，缺了就只能靠系统缩放，糊。
 *
 * 现在：几何直接照抄 client/src/components/BrandMark.vue 的 48 单位网格
 * （六边形轮廓 + 中间那个 Y + 只有顶面是实心琥珀 + 顶面三颗由小到大的信号点），
 * 颜色取自设计令牌（暖墨 #1b1917 / 琥珀 #e9a441 / 纸白），
 * 输出 16/24/32/48/64/128/256 七个尺寸，多尺寸打包进 ICO（Vista+ 支持 PNG 条目）。
 *
 * 为什么手写 PNG 编码：图标是构建产物，引 sharp/canvas 这类原生依赖会破坏
 * 「零原生依赖」这条部署底线。PNG 编码其实很直白：IHDR + IDAT(zlib) + IEND，
 * 再套一层 ICO 头即可；抗锯齿用 4× 超采样自己算。
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
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
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

/** 颜色（与 packages/shared/src/design/tokens.css 的暗色主题一致） */
const INK = [0x1b, 0x19, 0x17]; // 暖墨底
const AMBER = [0xe9, 0xa4, 0x41]; // --signal
const PAPER = [0xe8, 0xe2, 0xd6]; // 发丝线用的纸白
const PIPS = [0x1a, 0x12, 0x06]; // 琥珀底上的深墨（--on-signal）

/** BrandMark 的 48 单位几何 —— 与组件里的 points/path 一一对应 */
const ART = {
  viewBox: 48,
  hex: [
    [24, 9],
    [36.99, 16.5],
    [36.99, 31.5],
    [24, 39],
    [11.01, 31.5],
    [11.01, 16.5],
  ],
  topFace: [
    [24, 24],
    [36.99, 16.5],
    [24, 9],
    [11.01, 16.5],
  ],
  yLines: [
    [
      [24, 24],
      [36.99, 16.5],
    ],
    [
      [24, 24],
      [11.01, 16.5],
    ],
    [
      [24, 24],
      [24, 39],
    ],
  ],
  pips: [
    { x: 20.4, y: 18.6, r: 1 },
    { x: 23.4, y: 16.9, r: 1.35 },
    { x: 26.8, y: 14.9, r: 1.75 },
  ],
  strokeWidth: 1.7,
};

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** 点是否在多边形内（射线法） */
function inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 点到线段的距离（用于描边覆盖率） */
function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = px - a[0];
  const wy = py - a[1];
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

/** 圆角矩形的覆盖（0..1），带 1px 抗锯齿 */
function roundedRectCoverage(x, y, left, top, right, bottom, radius) {
  if (x < left - 1 || x > right + 1 || y < top - 1 || y > bottom + 1) return 0;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dist = Math.hypot(x - cx, y - cy);
  if (dist <= radius) return 1;
  return Math.max(0, Math.min(1, radius + 0.5 - dist));
}

/**
 * 画一张 size×size 的图标（RGBA）。
 * 先在 48 单位的艺术坐标系里算覆盖率，再映射到像素；4× 超采样做抗锯齿。
 */
function drawIcon(size) {
  const SS = 4; // 超采样倍数
  const N = size * SS;
  const acc = new Float64Array(size * size * 4);

  // 背景圆角方块：留一点边距，圆角半径取 22%（Windows 11 图标的观感）
  const pad = N * 0.06;
  const radius = N * 0.2;
  // 艺术坐标系 → 像素：把 48 单位映射进 [pad, N-pad]
  const inner = N - pad * 2;
  const scale = inner / ART.viewBox;
  const strokeW = ART.strokeWidth;

  for (let sy = 0; sy < N; sy += 1) {
    for (let sx = 0; sx < N; sx += 1) {
      const px = sx + 0.5;
      const py = sy + 0.5;

      // 背景
      const bgCover = roundedRectCoverage(px, py, pad, pad, N - pad, N - pad, radius);
      let color = INK;
      let alpha = bgCover;

      // 艺术坐标
      const ax = (px - pad) / scale;
      const ay = (py - pad) / scale;

      // 顶面（实心琥珀）
      if (inPolygon(ax, ay, ART.topFace)) color = AMBER;
      // 信号点：由小到大的三颗深墨圆点
      for (const pip of ART.pips) {
        if (Math.hypot(ax - pip.x, ay - pip.y) <= pip.r) color = PIPS;
      }
      // 发丝线：六边形轮廓 + 中间的 Y
      let wire = 0;
      const hexEdges = ART.hex.map((p, i) => [p, ART.hex[(i + 1) % ART.hex.length]]);
      for (const [a, b] of hexEdges) wire = Math.max(wire, Math.min(1, strokeW / 2 + 0.5 - distToSegment(ax, ay, a, b)));
      for (const [a, b] of ART.yLines) wire = Math.max(wire, Math.min(1, strokeW / 2 + 0.5 - distToSegment(ax, ay, a, b)));
      if (wire > 0) {
        color = mix(color, PAPER, wire);
      }

      // 累加到目标像素（因为缩小，所以要按超采样点平均）
      const tx = Math.floor(sx / SS);
      const ty = Math.floor(sy / SS);
      const i = (ty * size + tx) * 4;
      acc[i] += color[0];
      acc[i + 1] += color[1];
      acc[i + 2] += color[2];
      acc[i + 3] += alpha * 255;
    }
  }

  const samples = SS * SS;
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = Math.round(acc[i * 4] / samples);
    rgba[i * 4 + 1] = Math.round(acc[i * 4 + 1] / samples);
    rgba[i * 4 + 2] = Math.round(acc[i * 4 + 2] / samples);
    rgba[i * 4 + 3] = Math.round(acc[i * 4 + 3] / samples);
  }
  return rgba;
}

/**
 * macOS 菜单栏（托盘）用的**模板图**。
 *
 * 为什么不复用 icon.png：菜单栏高度只有 22px，而那个图标是"暖墨底 + 琥珀顶面"的实心方块 ——
 * 缩到 18px 之后就是一块黑方块，深色菜单栏上直接看不见。Apple 的规矩是模板图：
 * **只用 alpha**（纯色剪影），由系统按菜单栏明暗涂黑/涂白，点开菜单时还会反色。
 * 所以这里画的是同一套几何的**线稿**：六边形轮廓 + 中间的 Y + 三颗信号点，
 * 全部不透明黑；线宽按菜单栏尺寸放大（48 单位下 4.2，约等于 18px 上的 1.9px）——
 * 1.7 的图标线宽在这个尺寸下会细到看不见。
 *
 * 尺寸一次出两档：22（1x）与 44（2x）。Electron 认 `xxx@2x.png` 这个命名约定，
 * 会自动为 HiDPI 选 44 那张，所以调用方只需要指向 22 那张。
 */
function drawTrayTemplate(size) {
  const SS = 4;
  const N = size * SS;
  const acc = new Float64Array(size * size); // 只要 alpha（模板图不带颜色）
  // 菜单栏图标四周要留白：22px 的图里图形占 ~19px
  const pad = N * 0.08;
  const inner = N - pad * 2;
  const scale = inner / ART.viewBox;
  const strokeW = 4.2;

  for (let sy = 0; sy < N; sy += 1) {
    for (let sx = 0; sx < N; sx += 1) {
      const ax = (sx + 0.5 - pad) / scale;
      const ay = (sy + 0.5 - pad) / scale;
      let cover = 0;
      const hexEdges = ART.hex.map((p, i) => [p, ART.hex[(i + 1) % ART.hex.length]]);
      for (const [a, b] of hexEdges) cover = Math.max(cover, Math.min(1, strokeW / 2 + 0.5 - distToSegment(ax, ay, a, b)));
      for (const [a, b] of ART.yLines) cover = Math.max(cover, Math.min(1, strokeW / 2 + 0.5 - distToSegment(ax, ay, a, b)));
      // 信号点画成实心：小尺寸下它们是最容易辨认的那三个"信号"
      for (const pip of ART.pips) {
        if (Math.hypot(ax - pip.x, ay - pip.y) <= pip.r + strokeW / 4) cover = 1;
      }
      // 累加到目标像素（超采样点先除以 SS 落到目标像素上，与 drawIcon 同一套做法）
      acc[Math.floor(sy / SS) * size + Math.floor(sx / SS)] += cover * 255;
    }
  }

  const samples = SS * SS;
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = 0;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = Math.round(acc[i] / samples);
  }
  return rgba;
}

/** 多尺寸 PNG 打包成 ICO（每个条目的宽度为 0 表示 256） */
function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = header.length + entries.length * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

/* ---------------------------------------------------------------- 输出 */

/** 站点图标 SVG：同一套几何，浏览器标签页与安装包看起来是同一个标志 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect x="2" y="2" width="44" height="44" rx="10" fill="#1b1917"/>
  <polygon points="24,24 36.99,16.5 24,9 11.01,16.5" fill="#e9a441"/>
  <g fill="#1a1206">
    <circle cx="20.4" cy="18.6" r="1"/>
    <circle cx="23.4" cy="16.9" r="1.35"/>
    <circle cx="26.8" cy="14.9" r="1.75"/>
  </g>
  <g fill="none" stroke="#e8e2d6" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">
    <polygon points="24,9 36.99,16.5 36.99,31.5 24,39 11.01,31.5 11.01,16.5"/>
    <path d="M24 24 36.99 16.5 M24 24 11.01 16.5 M24 24 V39"/>
  </g>
</svg>
`;

/** Windows 需要的尺寸：任务栏 16/24/32，Alt-Tab 48，资源管理器大图标 256 */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * macOS 用的尺寸。electron-builder 从一张 PNG 生成 .icns 时要求**至少 512×512**
 * （256 会被直接拒绝），而 .icns 内部还需要 1024 的 retina 档，所以这两个尺寸单独出，
 * 不进 Windows 的 ICO（ICO 最大值就是 256，塞 512 进去是无效条目）。
 */
const MAC_SIZES = [512, 1024];

function main() {
  const clientBuild = path.join(REPO_ROOT, 'client', 'build');
  const clientElectronAssets = path.join(REPO_ROOT, 'client', 'electron', 'assets');
  const webPublic = path.join(REPO_ROOT, 'web', 'public');
  fs.mkdirSync(clientBuild, { recursive: true });
  fs.mkdirSync(clientElectronAssets, { recursive: true });
  fs.mkdirSync(webPublic, { recursive: true });

  const entries = SIZES.map((size) => ({ size, png: encodePng(size, size, drawIcon(size)) }));
  const ico = packIco(entries);
  const png256 = entries[entries.length - 1].png;
  const macPngs = MAC_SIZES.map((size) => ({ size, png: encodePng(size, size, drawIcon(size)) }));

  // 两处都要写：
  //   · client/build/icon.ico  → electron-builder 用它写进 exe/安装器，也用作安装向导图标
  //   · client/electron/assets/icon.ico → **运行时要读的那份**。buildResources 目录
  //     （build/）会被 electron-builder 自动排除出 app 文件，所以打包后
  //     appIconPath() 找 <asar>/build/icon.ico 是找不到的 —— 托盘会变成空白图标。
  fs.writeFileSync(path.join(clientBuild, 'icon.ico'), ico);
  fs.writeFileSync(path.join(clientBuild, 'icon.png'), png256);
  fs.writeFileSync(path.join(clientElectronAssets, 'icon.ico'), ico);
  // macOS：electron-builder 认 `icon.png` 并自己转 icns，取目录里最大的那张
  fs.writeFileSync(path.join(clientBuild, 'icon-1024.png'), macPngs[macPngs.length - 1].png);
  /**
   * macOS 菜单栏图标（同样只放在 electron/assets/：build/ 不进 app 包，
   * 而托盘图标必须在运行时能读到）。
   * 22 / 44 两档，命名用 Electron 认的 @2x 约定。
   */
  fs.writeFileSync(path.join(clientElectronAssets, 'tray-mac.png'), encodePng(22, 22, drawTrayTemplate(22)));
  fs.writeFileSync(path.join(clientElectronAssets, 'tray-mac@2x.png'), encodePng(44, 44, drawTrayTemplate(44)));
  fs.writeFileSync(path.join(webPublic, 'favicon.svg'), FAVICON_SVG);
  fs.writeFileSync(path.join(webPublic, 'icon-256.png'), png256);

  console.log(`icon.ico   ${(ico.length / 1024).toFixed(1)} KB  ${SIZES.join('/')}  ${entries.length} 个尺寸`);
  console.log('  -> client/build/icon.ico（写进 exe / 安装器）');
  console.log('  -> client/electron/assets/icon.ico（运行时窗口与 Windows 托盘）');
  console.log(`icon.png   ${(png256.length / 1024).toFixed(1)} KB  256x256 -> client/build/icon.png`);
  console.log('icon-1024.png    -> client/build/icon-1024.png（macOS 的 .icns 来源，需 ≥512）');
  console.log('tray-mac.png     -> client/electron/assets/（macOS 菜单栏模板图，22 + 44@2x）');
  console.log('favicon.svg      -> web/public/favicon.svg');
  console.log('icon-256.png     -> web/public/icon-256.png');
}

main();
