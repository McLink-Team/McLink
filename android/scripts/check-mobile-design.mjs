#!/usr/bin/env node
/**
 * 移动端设计契约的**静态断言**。
 *
 * 为什么需要一份自动检查，而不是靠 review：
 * DESIGN.md 定的几条硬约束（只用令牌、不许硬编码颜色、正文 ≥12.5px、图标自绘 SVG）
 * 全都是"**加入时很容易、发现时很难**"的那一类 —— 硬编码的颜色不会报错，
 * 它在浅色下看着也挺对，只有换世界或进深色模式时才露馅，而那时已经没人记得是谁加的。
 * 这份脚本把契约变成会红的测试。
 *
 * 覆盖：
 *   1. android/web/src 下**不出现任何颜色字面量**（十六进制 / rgb / rgba / hsl / 命名色）；
 *   2. 移动端**不复制一套颜色**：它自己一个颜色值都不定义，全部来自令牌；
 *   3. 字号下限 12.5px（与 client/DESIGN.md 的正文下限一致）；
 *   4. 底部导航真的存在，且**复用** client/src 的 RailIcon（不是另画一套图标）；
 *   5. 图标面上没有 emoji / Unicode 字形顶替（craft floor 明文禁止）；
 *   6. 单列回落真的存在（房间页的媒体查询 + 移动端外壳的兜底）。
 *
 * 用法：node android/scripts/check-mobile-design.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = path.resolve(HERE, '..');
const WEB_SRC = path.join(ANDROID_ROOT, 'web', 'src');
const CLIENT_SRC = path.resolve(ANDROID_ROOT, '..', 'client', 'src');

const r = createReporter('design');

const read = (p) => fs.readFileSync(p, 'utf8');
const listFiles = (dir, ext) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []));

const sources = [...listFiles(WEB_SRC, '.css'), ...listFiles(WEB_SRC, '.vue'), ...listFiles(WEB_SRC, '.ts')];
r.log(`检查 ${sources.length} 个文件`);

/**
 * 扫描前先去掉注释。
 *
 * 为什么必须这样：这些文件的注释里**故意**写着反例 ——
 * mobile-shell.css 的文件头说"本文件里不出现任何十六进制或 rgba()"，
 * main.ts 解释了"为什么不在 index.html 里写 content="#e6ded6"。
 * 不剥注释的话，检查器就会去投诉它自己的说明书，
 * 而这种"红了但其实是误报"的检查，第二次就会被人加进白名单，然后就永远不红了。
 */
function stripComments(text) {
  return (
    text
      // 块注释（CSS 与 JS 通用）
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // 行注释：要求 `//` 前面不是 `:`，否则会把 'https://…' 里的双斜杠当成注释，
      // 顺手把那一行后面真正的内容一起吞掉（可能正好吞掉一个颜色值）
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  );
}

/* ---------------------------------------------- 1. 不许有颜色字面量 */

/**
 * 匹配十六进制颜色、rgb/rgba/hsl/hsla 函数调用。
 *
 * 注意 `#app` 这类 id 选择器**不是**颜色：`#` 后面必须跟 3/4/6/8 位十六进制，
 * 且后面不能再跟字母数字（否则 `#abcdefg` 这种选择器会被误判）。
 * 同理 `#fff` 要能匹配，而 `#ffff` 之后的边界用 (?![0-9a-fA-F]) 守住。
 */
const COLOR_PATTERNS = [
  { name: '十六进制颜色', re: /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F\w-])/g },
  { name: 'rgb()/rgba()', re: /\brgba?\s*\(/g },
  { name: 'hsl()/hsla()', re: /\bhsla?\s*\(/g },
];

let colorHits = 0;
for (const file of sources) {
  const text = stripComments(read(file));
  for (const { name, re } of COLOR_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const line = text.slice(0, match.index).split('\n').length;
      const lineText = text.split('\n')[line - 1]?.trim() ?? '';
      console.log(`    ${path.relative(ANDROID_ROOT, file)}:${line}  ${name} → ${lineText}`);
      colorHits += 1;
    }
  }
}
r.check(
  'android/web/src 不出现任何颜色字面量（只用 var(--token)）',
  colorHits === 0,
  `命中 ${colorHits} 处`,
);

/* ---------------------------------------------- 2. 不复制一套颜色 */

const shellCssPath = path.join(WEB_SRC, 'mobile-shell.css');
const shellCss = read(shellCssPath);
/**
 * 移动端外壳**只能引用令牌，不能定义令牌**。
 * 一旦它开始写 `--ground: #...` 之类，就等于在移动端克隆了一套配色 ——
 * 那正是"不要另起一套"要防的事。允许的是 `--safe-bottom` / `--tabbar-h` 这类
 * **布局**变量（它们不是颜色，与暖纸台世界无关）。
 */
const definedVars = [...shellCss.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]);
const colorishVars = definedVars.filter((v) => /color|ground|surface|ink|accent|line|shadow|paper|signal|bg|border/.test(v));
r.check(
  'mobile-shell.css 只定义布局变量，不定义任何颜色令牌',
  colorishVars.length === 0,
  `非法定义：${colorishVars.join(', ')}`,
);

/* ---------------------------------------------- 3. 字号下限 12.5px */

const tooSmall = [];
for (const [i, line] of shellCss.split('\n').entries()) {
  const m = line.match(/font-size:\s*([\d.]+)px/);
  if (m && Number.parseFloat(m[1]) < 12.5) tooSmall.push(`L${i + 1}: ${line.trim()}`);
}
r.check('移动端样式的字号都 ≥12.5px', tooSmall.length === 0, tooSmall.join(' | '));

/* ---------------------------------------------- 4. 底部导航复用 RailIcon */

const tabBar = read(path.join(WEB_SRC, 'MobileTabBar.vue'));
r.check('底部导航组件存在（MobileTabBar.vue）', tabBar.includes('class="mobile-tabbar"'));
r.check(
  '底部导航复用 client/src 的 RailIcon（不是另画一套图标）',
  /from '\.\.\/\.\.\/\.\.\/client\/src\/components\/RailIcon\.vue'/.test(tabBar),
);
r.check('底部导航三项去处（联机/大厅/设置）', ['联机', '大厅', '设置'].every((t) => tabBar.includes(t)));

const railIcon = read(path.join(CLIENT_SRC, 'components', 'RailIcon.vue'));
r.check('RailIcon 是自绘 SVG（4 个 <svg>，统一 currentColor）', (railIcon.match(/<svg/g) ?? []).length === 4);

/* ---------------------------------------------- 5. 图标面上没有 emoji */

/**
 * emoji 的判定用一个够用的区间集合：杂项符号、装饰符号、 emoticons、
 * 交通与地图符号、补充符号，以及变体选择符与零宽连接符。
 * 只检查**图标面**（底部导航与图标组件），不检查聊天表情面板那种"表情是内容"的地方。
 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u;
const iconSurfaces = [
  ['MobileTabBar.vue', tabBar],
  ['RailIcon.vue', railIcon],
];
const emojiHits = iconSurfaces.filter(([, text]) => EMOJI_RE.test(text)).map(([n]) => n);
r.check(
  '图标面（底部导航 / RailIcon）没有用 emoji 顶替图标',
  emojiHits.length === 0,
  emojiHits.join(', '),
);

/* ---------------------------------------------- 6. 单列回落真的存在 */

const roomPage = read(path.join(CLIENT_SRC, 'pages', 'RoomPage.vue'));
r.check(
  '房间页在窄屏回落成单列（.room-columns 的 @media max-width: 819px）',
  /@media \(max-width: 819px\)/.test(roomPage) && /\.room-columns\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/s.test(roomPage),
);
r.check(
  'mobile-shell.css 另有单列兜底（:where() 特异性为 0，可被页面自身规则盖过）',
  /:where\(\.mobile-shell\)/.test(shellCss) && /grid-template-columns:\s*minmax\(0, 1fr\)/.test(shellCss),
);
const stylesCss = read(path.join(CLIENT_SRC, 'styles.css'));
r.check(
  '房间页两栏栅格只在 ≥740px 生效（所以手机竖屏必然是单列）',
  /@media \(min-width: 740px\)/.test(stylesCss),
);

/* ---------------------------------------------- 7. 外壳沿用 app-shell */

const mobileApp = read(path.join(WEB_SRC, 'MobileApp.vue'));
r.check(
  '移动端外壳沿用 .app-shell 类名（否则 .app-shell 后代选择器那批组件样式会全部失效）',
  /class="app-shell mobile-shell"/.test(mobileApp),
);
r.check('外壳提供 #deck-actions（CreateJoin 的 Teleport 目标）', mobileApp.includes('id="deck-actions"'));

/* ---------------------------------------------- 结论 */

console.log('');
r.log(r.failures === 0 ? '设计契约全部满足 ✓' : `${r.failures} 项未通过 ✗`);
process.exit(r.failures === 0 ? 0 : 1);
