#!/usr/bin/env node
/**
 * 下载并自托管网页端与客户端所需的字体。
 *
 * 为什么必须自托管：设计上要求展示字体与数据字体有明确性格，
 * 而「用系统 sans 当展示字体」被 Impeccable 的 craft floor 明确列为失败项
 * （the closest installed font is a failure, not a fallback）。
 * 同时平台要在内网/离线环境下可用，因此不能依赖 fonts.googleapis.com 的运行时请求。
 *
 * 做法：用 Chrome UA 请求 Google Fonts 的 CSS（这样才能拿到 woff2），
 * 解析出 latin 子集的 woff2 地址并下载，然后生成 @font-face 到两个前端。
 *
 * 用法：node scripts/fetch-fonts.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 字体落盘位置：放在各前端的 src 里（而不是 public），
 * 这样 Vite 会把 woff2 当模块资产处理、自动加哈希并改写 URL。
 * 之前放 public 并用 `@import '/fonts/fonts.css'`，构建期不会被打包器分析，
 * 是个容易被忽略的坑。
 */
const TARGETS = [
  { dir: path.join(REPO_ROOT, 'web', 'src', 'assets', 'fonts'), css: path.join(REPO_ROOT, 'web', 'src', 'styles', 'fonts.css'), rel: '../assets/fonts' },
  { dir: path.join(REPO_ROOT, 'client', 'src', 'assets', 'fonts'), css: path.join(REPO_ROOT, 'client', 'src', 'fonts.css'), rel: './assets/fonts' },
];

/** 只取 latin 子集：中文交给系统字体栈，避免几 MB 的 CJK 字体拖慢首屏 */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const FAMILIES = [
  {
    // 展示字体：给标题一层"被设计过"的性格。刻意避开 Inter / Instrument Sans
    // 这类被 Impeccable 的 overused-font 规则点名的字体。
    css: 'family=Bricolage+Grotesque:opsz,wght@12..96,500..700',
    key: 'bricolage-grotesque',
    family: 'Bricolage Grotesque',
  },
  {
    // UI 与正文（拉丁部分）：中性、稳，不与展示字体抢戏
    css: 'family=Archivo:wght@400..600',
    key: 'archivo',
    family: 'Archivo',
  },
  {
    // 数据：IP、端口、延迟、流量都用它，数字清晰、宽度可控
    css: 'family=IBM+Plex+Mono:wght@400;500;600',
    key: 'ibm-plex-mono',
    family: 'IBM Plex Mono',
  },
];

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/css,*/*' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchBinary(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 从 Google Fonts 的 CSS 里挑出 latin 子集的 @font-face 块 */
function parseFaces(css) {
  const faces = [];
  const blocks = css.split('@font-face').slice(1);
  for (const block of blocks) {
    const body = block.slice(0, block.indexOf('}'));
    // 只保留 latin（不含 latin-ext / cyrillic 等），减小体积
    const isLatin = /\/\*\s*latin\s*\*\//.test(block.slice(0, 200)) || /unicode-range:\s*U\+0000/.test(body);
    if (!isLatin) continue;
    const url = /url\((https:[^)]+\.woff2)\)/.exec(body)?.[1];
    if (!url) continue;
    const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '400';
    const style = /font-style:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? 'normal';
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
    faces.push({ url, weight, style, range });
  }
  return faces;
}

function faceCss(family, faces, rel) {
  return faces
    .map(
      (f) => `@font-face {
  font-family: '${family}';
  font-style: ${f.style};
  font-weight: ${f.weight};
  font-display: swap;
  src: url('${rel}/${path.basename(new URL(f.url).pathname)}') format('woff2');
${f.range ? `  unicode-range: ${f.range};\n` : ''}}`,
    )
    .join('\n\n');
}

async function main() {
  /** css 文件路径 → 该文件要写入的 @font-face 块 */
  const faceBlocks = new Map();
  let total = 0;

  for (const fam of FAMILIES) {
    const cssUrl = `https://fonts.googleapis.com/css2?${fam.css}&display=swap`;
    console.log(`获取 ${fam.family} …`);
    const css = await fetchText(cssUrl);
    const faces = parseFaces(css);
    if (faces.length === 0) {
      console.warn(`  ⚠ 没解析到 woff2（可能返回了 ttf），跳过 ${fam.family}`);
      continue;
    }
    for (const face of faces) {
      const buf = await fetchBinary(face.url);
      const name = path.basename(new URL(face.url).pathname);
      for (const target of TARGETS) {
        fs.mkdirSync(target.dir, { recursive: true });
        fs.writeFileSync(path.join(target.dir, name), buf);
      }
      total += buf.length;
      console.log(`  ${name}  ${(buf.length / 1024).toFixed(1)} KB  (${face.style} ${face.weight})`);
    }
    for (const target of TARGETS) {
      faceBlocks.set(
        target.css,
        [...(faceBlocks.get(target.css) ?? []), `/* ${fam.family} —— OFL 许可，见 fonts/ 同目录说明 */\n${faceCss(fam.family, faces, target.rel)}`],
      );
    }
  }

  const header = `/* 由 scripts/fetch-fonts.mjs 生成，请勿手工编辑。
 * 字体自托管的原因：设计上要求展示/数据字体有明确性格（不能用系统 sans 顶替，
 * 那被 craft floor 明确列为失败项），且平台需要在内网与离线环境下可用，
 * 因此不做任何运行时外部请求。
 * 两个前端（web/ 与 client/）共用同一份字体文件。 */\n\n`;

  for (const target of TARGETS) {
    fs.mkdirSync(path.dirname(target.css), { recursive: true });
    fs.writeFileSync(target.css, header + (faceBlocks.get(target.css) ?? []).join('\n\n') + '\n');
  }
  console.log(`\n完成：${(total / 1024).toFixed(1)} KB 字体`);
  for (const t of TARGETS) console.log(`  ${path.relative(REPO_ROOT, t.dir)}  +  ${path.relative(REPO_ROOT, t.css)}`);
}

await main();
