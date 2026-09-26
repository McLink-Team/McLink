#!/usr/bin/env node
/**
 * 端到端验证：**在没有手机的情况下，把里程碑 1 那条链真的走一遍**。
 *
 *   登录 → 建房 → 拿到加入码与联机地址 → 看到成员 → 看到聊天 → 发一条消息
 *
 * ## 为什么要做这一步（冒烟测试不够）
 *
 * `smoke-mobile.mjs` 只证明了"界面能画出来、能连上主控"，它停在登录页 ——
 * 而里程碑 1 真正要交付的是**登录之后那条链**。要在没有手机的情况下验它，
 * 唯一的办法就是：起一个**本地主控**，让同一份产物连上去，然后用 CDP
 * 像人一样填表、点按钮，再回头读界面上的字。
 *
 * ## 前置：本地主控要先跑起来
 *
 * ```powershell
 * $env:MCLINK_DATA_DIR = "$env:TEMP\mclink-e2e-data"
 * cd server ; node src/index.ts        # 监听 8787，自动建库 + 建 admin
 * ```
 *
 * ## 用法
 *
 * ```powershell
 * node android/scripts/e2e-mobile.mjs
 * # 换主控：$env:MCLINK_E2E_MASTER='http://127.0.0.1:8787'
 * ```
 *
 * 它**不会**动仓库里的 android/dist：为了把主控地址换成 127.0.0.1，
 * 它会单独构建一份到临时目录（`vite build --outDir <tmp>`），跑完删掉。
 * 这样正式产物的内置地址始终是用户指定的那个，不会被测试污染。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter, findChromium, launchBrowser, serveDir, sleep } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = path.resolve(HERE, '..');
const isWin = process.platform === 'win32';

const MASTER = (process.env.MCLINK_E2E_MASTER ?? 'http://127.0.0.1:8787').trim().replace(/\/+$/, '');
const API = `${MASTER}/api/v1`;
/** Pixel 7 的逻辑分辨率：与 smoke-mobile.mjs 同一档，布局结论可比 */
const VIEWPORT = { width: 412, height: 915, scale: 2.625 };

const r = createReporter('e2e');
const tmpOut = path.join(os.tmpdir(), `mclink-e2e-dist-${Date.now()}`);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mclink-e2e-profile-'));
const debugPort = 9334;

/* --------------------------------------------------- 0. 本地主控活着吗 */

try {
  const res = await fetch(`${API}/meta`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  r.log(`本地主控在线：${MASTER}`);
} catch (err) {
  console.error(
    `[e2e] ✗ 连不上本地主控 ${MASTER}（${err.message}）。\n` +
      `      先起一个（会自动建库与 admin 账号）：\n` +
      `        $env:MCLINK_DATA_DIR = "$env:TEMP\\mclink-e2e-data"\n` +
      `        cd server ; node src/index.ts\n`,
  );
  process.exit(2);
}

/* --------------------------------------------------- 1. 建一份指向本地主控的产物 */

r.log(`构建指向 ${MASTER} 的临时产物 → ${tmpOut}`);
const viteBin = path.join(ANDROID_ROOT, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
const build = spawnSync(`"${viteBin}" build --outDir "${tmpOut}"`, {
  cwd: ANDROID_ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_MCLINK_MASTER: MASTER },
});
if (build.status !== 0 || !fs.existsSync(path.join(tmpOut, 'index.html'))) {
  console.error('[e2e] ✗ 临时产物构建失败');
  process.exit(2);
}

/* --------------------------------------------------- 2. 建一个测试账号 */

/**
 * 账号与显示名都用**时间戳后缀**。
 *
 * 踩过的坑：用户名一开始就带了后缀，但 `displayName` 写死成「E2E 测试机」——
 * 本地库不清库反复跑第二次时，主控会以 400 「这个名字已被占用（含相似字符也不行）」
 * 拒绝，而报错只出现在注册那一步，很容易被误读成"建房功能坏了"。
 * 测试脚本必须能重复跑，这是它有没有用的前提。
 */
const stamp = Date.now().toString(36);
const username = `e2e${stamp}`;
const displayName = `E2E 测试机 ${stamp.slice(-4)}`;
const password = 'e2ePassw0rd';
r.log(`注册测试账号 ${username}`);
const reg = await fetch(`${API}/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ username, password, displayName }),
});
if (!reg.ok) {
  console.error(`[e2e] ✗ 注册失败：HTTP ${reg.status} ${await reg.text()}`);
  process.exit(2);
}
r.log('账号已建好，后面全部走界面');

/* --------------------------------------------------- 3. 起浏览器 */

const { server, url } = await serveDir(tmpOut);
const { child, cdp, evaluate } = await launchBrowser({
  chromium: findChromium(),
  debugPort,
  profileDir,
  viewport: VIEWPORT,
  log: r.log,
});

/** 等某个选择器出现，最多等 timeoutMs */
async function waitFor(selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (found) return true;
    await sleep(300);
  }
  return false;
}

/**
 * 往 Vue 的 v-model 输入框里写字。
 *
 * 不能直接 `el.value = 'x'`：v-model 靠监听 input 事件同步，
 * 直接改 value 不会触发事件，Vue 那边看到的还是空字符串 ——
 * 表现是"按钮一直是灰的、点了没反应"，很难判断是页面坏了还是测试写错了。
 * 这里用原型上的 value setter 再手动派发 input 事件，等价于真人输入。
 */
const FILL_HELPER = `
function fill(selector, value) {
  const el = document.querySelector(selector);
  if (!el) throw new Error('找不到元素: ' + selector);
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
function clickByText(text, selector) {
  const nodes = [...document.querySelectorAll(selector || 'button')];
  const hit = nodes.find((b) => (b.textContent || '').trim() === text);
  if (!hit) throw new Error('找不到按钮: ' + text);
  hit.click();
  return true;
}
`;

/* --------------------------------------------------- 4. 登录（走界面） */

await cdp.send('Page.navigate', { url });
await sleep(4000);

r.log('步骤 1 —— 登录（填表 + 点按钮，全部走界面）');
if (!(await waitFor('.login-card'))) {
  r.check('登录卡出现', false, '页面没渲染出登录卡');
} else {
  r.check('登录卡出现', true);
  await evaluate(`${FILL_HELPER}
    fill('input[autocomplete="username"]', ${JSON.stringify(username)});
    fill('input[autocomplete="current-password"]', ${JSON.stringify(password)});
  `);
  await sleep(400);
  await evaluate(`clickByText('登录并开始联机')`);
  const ok = await waitFor('.home', 20000);
  const who = await evaluate(`(document.querySelector('.mobile-topbar-status')||{}).textContent||''`);
  r.check('登录成功，进入「联机」首页', ok, `顶栏状态=${who.trim()}`);
}

/* --------------------------------------------------- 5. 建房（走界面） */

r.log('步骤 2 —— 建房');
await evaluate(`clickByText('创建')`);
await sleep(600);
const hasForm = await evaluate(`!!document.querySelector('.home input')`);
r.check('建房表单打开', hasForm);

const roomName = `E2E 房间 ${Date.now().toString(36).slice(-4)}`;
await evaluate(`${FILL_HELPER}
  const inputs = [...document.querySelectorAll('.home input')];
  const nameInput = inputs[0];
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameInput, ${JSON.stringify(roomName)});
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
`);
await sleep(400);
await evaluate(`clickByText('创建并连接')`);

/* --------------------------------------------------- 6. 断言真的进房了 */

r.log('步骤 3 —— 进房后该有的东西');
const inRoom = await waitFor('.room-view', 30000);
r.check('进入房间页（.room-view 出现）', inRoom);

if (inRoom) {
  await sleep(1500); // 等 members / 聊天历史各拉一次

  const room = await evaluate(`(() => {
    const pick = (s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; };
    return {
      title: pick('.room-title'),
      code: pick('.code-value'),
      addr: pick('.addr-value'),
      memberCount: document.querySelectorAll('.member').length,
      chatPanel: !!document.querySelector('.card.chat'),
      chatBody: !!document.querySelector('.chat-body'),
      chatTextarea: !!document.querySelector('.chat textarea'),
      chatLabel: pick('.card.chat .row div'),
      fullWidthChat: (() => {
        const b = document.querySelector('.chat-body');
        if (!b) return null;
        const rect = b.getBoundingClientRect();
        return { h: Math.round(rect.height), w: Math.round(rect.width) };
      })(),
    };
  })()`);

  r.check('房间名显示正确', room.title === roomName, `实际=${room.title}`);
  // 加入码是 6–8 位大写字母数字（主控生成），这里只断言"有内容且像码"
  r.check('加入码已拿到', typeof room.code === 'string' && room.code.length >= 4, `实际=${room.code}`);
  /*
   * 联机地址 = 票据里的 hostVirtualIp，是本产品的核心产物（玩家要把它粘进游戏）。
   * 断言它是一个 IPv4，而不是空或者「等待分配…」。
   * 注意：**本机没有虚拟网络内核**（里程碑 1 的范围），
   * 但这个地址来自主控为房主预分配的虚拟 IP，与本机内核是否启动无关 ——
   * 这条断言正是在证明这一点。
   */
  r.check(
    '联机地址已拿到（IPv4）',
    typeof room.addr === 'string' && /^\d{1,3}(\.\d{1,3}){3}/.test(room.addr),
    `实际=${room.addr}`,
  );
  r.check('成员列表有自己', room.memberCount >= 1, `memberCount=${room.memberCount}`);

  r.log('步骤 4 —— 聊天（本轮新加回范围）');
  r.check('聊天面板已渲染', room.chatPanel);
  r.check('聊天有独立滚动区 .chat-body', room.chatBody);
  r.check('聊天有输入框（textarea）', room.chatTextarea);
  r.check(
    '聊天滚动区是移动端尺寸（min(56vh,460px)）',
    room.fullWidthChat !== null && room.fullWidthChat.h > 300 && room.fullWidthChat.h <= 460,
    `实际高度=${room.fullWidthChat?.h}px`,
  );

  /* 发一条消息，确认"能看到历史、能发出去"都成立 */
  const text = `e2e 消息 ${Date.now().toString(36).slice(-4)}`;
  await evaluate(`${FILL_HELPER}
    const ta = document.querySelector('.chat textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(400);
  await evaluate(`clickByText('发送')`);
  await sleep(2500);
  const sent = await evaluate(
    `[...document.querySelectorAll('.chat-text')].some((n) => n.textContent.includes(${JSON.stringify(text)}))`,
  );
  r.check('发出的消息出现在聊天里', sent, '未在 .chat-text 中找到刚发的内容');

  /* 截图：房间页（含聊天、加入码、联机地址）—— 这是本轮最该留档的一张 */
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(600);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.join(ANDROID_ROOT, '.smoke'), { recursive: true });
  const shotPath = path.join(ANDROID_ROOT, '.smoke', 'e2e-room-light.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  r.log(`截图：${shotPath}`);
}

/* --------------------------------------------------- 收尾 */

console.log('');
r.log(r.failures === 0 ? '全部通过 ✓' : `${r.failures} 项未通过 ✗`);

cdp.close();
child.kill();
server.close();
try {
  fs.rmSync(tmpOut, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* Windows 上句柄可能还没释放，留给系统清理 */
}
process.exit(r.failures === 0 ? 0 : 1);
