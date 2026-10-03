#!/usr/bin/env node
/**
 * Android 渲染层的冒烟测试 —— **在没有手机的情况下，证明产物到底能不能用**。
 *
 * ## 为什么需要它
 *
 * 手机上没法开 devtools（除非插着 USB 用 chrome://inspect），所以"装上去白屏"
 * 这种失败在真机上极难定位。这个脚本把同一份产物（android/dist）放进一个
 * Chromium 引擎里，用**手机的视口尺寸**跑一遍，把三类事情问清楚：
 *
 *   1. **界面真的渲染出来了**：DOM 里有底部导航、有三项去处、有登录卡 ——
 *      而不是一个空 #app（那正是白屏的样子）；
 *   2. **布局真的是移动端的**：底部导航在视口下沿、横排、铺满，内容区在它之上，
 *      而且桌面那个 80px 左栏**没有**被渲染出来；
 *   3. **能连主控**：在页面里 fetch 一次主控的公开接口，并单独验 CORS。
 *
 * 它停在登录页 —— "登录之后"那条链由 `e2e-mobile.mjs` 验证（那个脚本会起本地主控）。
 *
 * ## 用法
 *   node android/scripts/smoke-mobile.mjs [--keep]
 *
 * 产物：android/.smoke/mobile-{light,dark}-<w>x<h>.png，退出码 0 = 全部通过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter, findChromium, launchBrowser, serveDir, sleep } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = path.resolve(HERE, '..');
const DIST = path.join(ANDROID_ROOT, 'dist');
const OUT_DIR = path.join(ANDROID_ROOT, '.smoke');
const KEEP = process.argv.includes('--keep');

/** 手机视口：Pixel 7 的逻辑分辨率，也是这次布局设计的基准宽度 */
const VIEWPORT = { width: 412, height: 915, scale: 2.625 };
/** 内置主控地址：与 vite.config.ts 的默认值一致（**默认不内置**），可用环境变量覆盖 */
const MASTER = (process.env.VITE_MCLINK_MASTER ?? '').trim().replace(/\/+$/, '');
/** 没有内置主控时，首屏应该是"填主控地址"那一步（不是登录表单） */
const EXPECT_FIRST_RUN = MASTER.length === 0;

const r = createReporter('smoke');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`[smoke] 找不到产物 ${DIST}\\index.html。先跑：pnpm --filter @mclink/android build:web`);
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mclink-smoke-'));
const { server, url } = await serveDir(DIST);
r.log(`静态服务 ${url} → ${DIST}`);

const { child, cdp, evaluate } = await launchBrowser({
  chromium: findChromium(),
  debugPort: 9333,
  profileDir,
  viewport: VIEWPORT,
  log: r.log,
});

/*
 * 导航之后不等 loadEventFired，而是**睡够**。
 * 理由是 Vue 的挂载与 bootstrap() 的网络请求都发生在 load 之后：
 * 等到 load 就断言，会稳定地看到一个还没渲染完的 #app（一个假失败）。
 * 4 秒是这里唯一可靠的等待方式 —— 没有别的事件能表示"Vue 已经画完了"。
 */
await cdp.send('Page.navigate', { url });
await sleep(4000);

/* --------------------------------------------------- 断言 1：界面渲染出来了 */

r.log('断言 1 —— 界面渲染（不是白屏）');
const dom = await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const app = q('#app');
  const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
  return {
    appChildren: app ? app.children.length : -1,
    shell: !!q('.app-shell.mobile-shell'),
    tabbar: !!q('.mobile-tabbar'),
    tabs: [...document.querySelectorAll('.mobile-tab')].map((b) => b.textContent.trim()),
    loginCard: !!q('.login-card'),
    inputs: document.querySelectorAll('input').length,
    buttons,
    bodyText: (document.body.textContent ?? '').replace(/\\s+/g, ' '),
  };
})()`);

r.check('#app 已挂载（有子节点）', dom.appChildren > 0, `children=${dom.appChildren}`);
r.check('移动端外壳 .app-shell.mobile-shell 存在', dom.shell);
r.check('底部导航 .mobile-tabbar 存在', dom.tabbar);
r.check('底部导航是三项（联机/大厅/设置）', dom.tabs.length === 3, `实际：${JSON.stringify(dom.tabs)}`);
r.check('首屏卡片已渲染', dom.loginCard);
/**
 * 首屏有两种合法形态（2026-10-03 起）：
 *   · **不内置主控**（现在出包的默认）→ 先让玩家填主控地址，登录表单不该出现；
 *   · 内置了主控 → 直接是登录表单。
 * 断言跟着构建配置走，而不是写死一种 —— 否则"没内置主控"的包会被误判为坏包。
 */
if (EXPECT_FIRST_RUN) {
  r.check('无内置主控 → 首屏引导填主控地址', dom.bodyText.includes('主控地址'), dom.bodyText.slice(0, 120));
  r.check(
    '无内置主控 → 有「连上这台主控」按钮',
    dom.buttons.some((b) => b.includes('连上这台主控')),
    JSON.stringify(dom.buttons.slice(0, 4)),
  );
  r.check('无内置主控 → 不显示用户名/密码表单（避免点了必然失败）', !dom.bodyText.includes('用户名'), '');
} else {
  r.check('内置主控 → 直接是登录表单', dom.bodyText.includes('用户名'), '');
  r.check('有输入框（用户名/密码/本机名称）', dom.inputs >= 3, `inputs=${dom.inputs}`);
}

/* ------------------------------------------------- 断言 2：布局真的是移动端 */

r.log('断言 2 —— 布局是移动端的，不是把桌面外壳照搬过来');
const layout = await evaluate(`(() => {
  const bar = document.querySelector('.mobile-tabbar');
  const scroll = document.querySelector('.mobile-scroll');
  const br = bar.getBoundingClientRect();
  const sr = scroll.getBoundingClientRect();
  return {
    vw: innerWidth, vh: innerHeight,
    barBottom: Math.round(br.bottom), barTop: Math.round(br.top), barWidth: Math.round(br.width),
    barFlexDir: getComputedStyle(bar).flexDirection,
    scrollBottom: Math.round(sr.bottom),
    // 桌面左栏是 80px 竖栏：如果它出现了，说明移动端外壳没生效
    legacyRail: !!document.querySelector('.rail'),
    ground: getComputedStyle(document.documentElement).getPropertyValue('--ground').trim(),
  };
})()`);

r.check('底部导航贴着视口下沿', Math.abs(layout.barBottom - layout.vh) <= 2, `barBottom=${layout.barBottom} vh=${layout.vh}`);
r.check('底部导航是横排（flex-direction: row）', layout.barFlexDir === 'row', layout.barFlexDir);
r.check('底部导航铺满宽度', Math.abs(layout.barWidth - layout.vw) <= 2, `barWidth=${layout.barWidth} vw=${layout.vw}`);
r.check('内容区在导航之上（不重叠）', layout.scrollBottom <= layout.barTop + 1, `scrollBottom=${layout.scrollBottom} barTop=${layout.barTop}`);
r.check('没有渲染桌面左栏 .rail', !layout.legacyRail);
r.check('暖纸台令牌已生效（--ground 非空）', layout.ground.length > 0, `--ground=${layout.ground}`);

/* --------------------------------------------------- 断言 3：能连上主控 */

/**
 * 这一条只在**构建时内置了主控**时才跑。
 *
 * 不内置主控现在是默认产物（官方停服），那时首屏引导玩家自己填地址 ——
 * 没有"内置地址"可测，硬测会得到一个假失败。真实连通性由 `e2e-mobile.mjs` 负责：
 * 它会起一个本地主控、把地址填进客户端再走完整条链。
 */
if (EXPECT_FIRST_RUN) {
  r.log('断言 3 —— 跳过（本包不内置主控地址；连通性由 e2e-mobile.mjs 覆盖）');
} else {
r.log(`断言 3 —— 页面能连主控 ${MASTER}`);
const net = await evaluate(`(async () => {
  try {
    const res = await fetch(${JSON.stringify(`${MASTER}/api/v1/meta`)}, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let code = null;
    try { code = JSON.parse(text).data?.clientVersion ?? null; } catch {}
    return { ok: res.ok, status: res.status, clientVersion: code };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
})()`);

r.check('主控 /api/v1/meta 返回成功', net.ok === true, net.error ?? `HTTP ${net.status}`);
r.check('响应是 JSON 且带版本号', typeof net.clientVersion === 'string', `clientVersion=${net.clientVersion}`);

/*
 * CORS 检查必须**在 Node 侧**发，不能在页面里发。
 *
 * 踩过的坑：一开始我在页面里 `fetch(url, { headers: { origin: 'https://localhost' } })`，
 * 结果 access-control-allow-origin 是 null。不是服务器不允许，而是 **`Origin` 是 fetch 的
 * 禁止头（forbidden header name）**：浏览器会静默丢掉它，然后按页面的真实来源发出去 ——
 * 于是量到的是另一个来源的结果。用 node:http(s) 直接发就没有这层限制。
 *
 * 真机上的来源是 **https://localhost**（Capacitor 的 androidScheme 默认 https）。
 * 主控 server/src/server.ts 的 isAllowedOrigin() 有一条内置规则放行任何
 * `http(s)://localhost[:port]` / `127.0.0.1[:port]`（原本给 Electron 与本地开发用），
 * 所以这条**不需要改主控**。但它是隐式依赖：哪天那条正则被收紧，Android 端会整体失效，
 * 而现象只是一句"连不上服务器"。所以这里把它钉成一条断言。
 */
/**
 * 带重试的 CORS 探测。
 *
 * 为什么要重试：这是唯一一条**只走 Node、不走页面**的外部请求，对跨境链路的一次
 * 抖动没有缓冲。实测遇到过一回单纯超时（同一个测试里页面内的 fetch 反而是成功的），
 * 于是整个冒烟测试红了一条 —— 一条会因为网络抖动静默变红的断言，
 * 比没有这条断言更糟：它会训练人忽略红色。
 */
async function corsProbeOnce(origin) {
  const target = new URL(`${MASTER}/api/v1/meta`);
  const mod = target.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return new Promise((resolve) => {
    const req = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname,
        method: 'GET',
        headers: { origin, accept: 'application/json' },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] ?? null });
      },
    );
    req.on('error', (e) => resolve({ error: String(e) }));
    req.setTimeout(15000, () => req.destroy(new Error('超时')));
    req.end();
  });
}

async function corsProbe(origin) {
  let last = { error: '未尝试' };
  for (let i = 0; i < 3; i += 1) {
    last = await corsProbeOnce(origin);
    if (last.error === undefined) return last;
    await sleep(1500);
  }
  return last;
}

const cors = await corsProbe('https://localhost');
r.check(
  '主控放行 Capacitor 的来源 https://localhost（CORS）',
  cors.acao === 'https://localhost' || cors.acao === '*',
  cors.error ?? `access-control-allow-origin=${cors.acao}`,
);
} // ← 结束"内置了主控才跑"的那一段

/* ------------------------------------------------------------------ 截图 */
/*
 * 两个主题都截一张。
 *
 * 「暖纸台」的 canonical 形态是亮色（页面底 #e6ded6 的暖纸 + 白卡浮在上面，
 * 见 client/DESIGN.md 的世界说明），深色是它的另一档取值（--ground: #1a1816）。
 * 客户端用 applyAutoTheme() 跟随系统，所以在无头浏览器里截到哪一张，取决于
 * 浏览器报的 prefers-color-scheme —— 只截一张很容易让人以为"这套界面是黑的"。
 */
async function shoot(scheme) {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  // 等主题切换重绘（applyAutoTheme 走 media query 监听，切完要一帧）
  await sleep(600);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = path.join(OUT_DIR, `mobile-${scheme}-${VIEWPORT.width}x${VIEWPORT.height}.png`);
  fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
  r.log(`截图（${scheme}）：${p}`);
}

await shoot('light');
await shoot('dark');

/* ------------------------------------------------------------------ 收尾 */

console.log('');
r.log(r.failures === 0 ? '全部通过 ✓' : `${r.failures} 项未通过 ✗`);

cdp.close();
child.kill();
server.close();
if (!KEEP) {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* Windows 上文件句柄可能还没释放，留给系统清 */
  }
}
process.exit(r.failures === 0 ? 0 : 1);
