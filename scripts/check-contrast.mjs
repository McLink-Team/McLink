/**
 * 两个主题的对比度核算 —— 直接从 packages/shared/src/design/tokens.css 取值。
 *
 * 为什么必须有这个脚本：
 *   设计检查器（impeccable detect）是对**渲染后的页面**判定的，跑一轮要构建 + 起浏览器；
 *   而配色的对比度是纯算术。改一个颜色时先在这里算一遍，能在几秒内知道值能不能用，
 *   不必来回"改—构建—检测"好几轮。
 *
 * 为什么不能把颜色抄进脚本里：
 *   之前 .cache 里有一版脚本把候选色写死在代码里（#a1660f 之类），
 *   令牌后来改成了 #96590c，脚本却还在报"未达标"——一个会漂移的检查比没有检查更糟。
 *   所以这里一切数值都从令牌文件解析，脚本里不出现任何颜色字面量。
 *
 * 用法：node scripts/check-contrast.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = path.join(ROOT, 'packages/shared/src/design/tokens.css');

/** 把 `:root { ... }` / `:root[data-theme='light'] { ... }` 里的自定义属性解析出来 */
function readTokenBlocks(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = {};
  const re = /(:root(?:\[data-theme='(light|dark)'\])?)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const key = m[2] ?? 'dark';
    const vars = blocks[key] ?? {};
    for (const line of m[3].split('\n')) {
      const hit = /^\s*(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
      if (hit) vars[hit[1]] = hit[2].trim();
    }
    blocks[key] = vars;
  }
  return blocks;
}

/** 解析 var(--x) 引用（最多 3 层，够用且能挡住循环引用） */
function resolve(vars, name, depth = 0) {
  const raw = vars[name];
  if (raw === undefined) throw new Error(`令牌 ${name} 不存在`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (ref && depth < 3) return resolve(vars, ref[1], depth + 1);
  return raw;
}

const parseColor = (value) => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const s = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16)).concat(1);
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const p = rgba[1].split(',').map((x) => Number.parseFloat(x.trim()));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error(`看不懂的颜色值：${value}`);
};

const lum = (rgb) => {
  const [r, g, b] = rgb.slice(0, 3).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** 把带 alpha 的前景压在底色上，返回合成后的实色 */
const compose = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));

const contrast = (fg, bg) => {
  const solid = fg[3] < 1 ? compose(fg, bg) : fg.slice(0, 3);
  const [a, b] = [lum(solid), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

const blocks = readTokenBlocks(fs.readFileSync(TOKENS, 'utf8'));
let failures = 0;

for (const theme of ['dark', 'light']) {
  const vars = blocks[theme];
  if (!vars) {
    console.log(`\n⚠ 令牌文件里没有 ${theme} 主题的块`);
    failures += 1;
    continue;
  }
  const c = (name) => parseColor(resolve(vars, name));
  const page = c('--ink-900');
  const raised = c('--ink-800');
  const raised2 = c('--ink-850');

  const rows = [
    ['正文 paper / 页面底', '--paper', page],
    ['正文 paper / 抬升面', '--paper', raised],
    ['次级 paper-2 / 页面底', '--paper-2', page],
    ['说明 paper-dim / 页面底', '--paper-dim', page],
    ['说明 paper-dim / 抬升面', '--paper-dim', raised],
    ['最弱 paper-faint / 页面底', '--paper-faint', page],
    ['最弱 paper-faint / 抬升面2', '--paper-faint', raised2],
    ['强调 signal 当文字 / 页面底', '--signal', page],
    ['强调 signal 当文字 / 抬升面', '--signal', raised],
    ['主按钮字 / 主按钮底', '--cta-fg', c('--cta-bg')],
    ['主按钮字 / 主按钮 hover', '--cta-fg', c('--cta-bg-hover')],
    ['旧配对 on-signal / signal 底', '--on-signal', c('--signal')],
    ['link 当文字 / 页面底', '--link', page],
    ['warn 当文字 / 页面底', '--warn', page],
    ['fault 当文字 / 页面底', '--fault', page],
    ['sky 当文字 / 页面底', '--sky', page],
    ['link 文字 / link-wash 压在页面底', '--link', compose(c('--link-wash'), page)],
    ['warn 文字 / warn-wash 压在页面底', '--warn', compose(c('--warn-wash'), page)],
    ['fault 文字 / fault-wash 压在页面底', '--fault', compose(c('--fault-wash'), page)],
    ['sky 文字 / sky-wash 压在页面底', '--sky', compose(c('--sky-wash'), page)],
    ['正文 / signal-wash 压在页面底', '--paper', compose(c('--signal-wash'), page)],
  ];

  console.log(`\n=== ${theme === 'dark' ? '暗色' : '亮色'}（门槛 4.5:1）===`);
  for (const [label, fgName, bg] of rows) {
    const fg = typeof fgName === 'string' ? c(fgName) : fgName;
    const ratio = contrast(fg, bg);
    const ok = ratio >= 4.5;
    if (!ok) failures += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${ratio.toFixed(2)}:1  ${label}`);
  }
  // 亮色页面底不能发黄：设计检查器的 cream-palette 按 R−B 判定
  const [r, , b] = page;
  const drift = r - b;
  const creamOk = theme === 'dark' || drift <= 4;
  if (!creamOk) failures += 1;
  console.log(`  ${creamOk ? '✓' : '✗'} 页面底 R−B = ${drift}（亮色要求 ≤4，否则检测器报 cream-palette）`);
}

console.log(`\n${failures === 0 ? '全部达标' : `${failures} 项未达标，需要调值`}`);
process.exit(failures === 0 ? 0 : 1);
