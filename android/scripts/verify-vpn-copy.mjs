#!/usr/bin/env node
/**
 * **玩家看到的那几行字**的回归验证。
 *
 * ## 为什么这一类断言值得单独一个脚本
 *
 * `verify-vpn-plan.mjs` 验"算得对不对"，`verify-vpn-bridge.mjs` 验"交给原生什么"，
 * 但这个功能的**交付物**最终是几句话：进房前要告诉玩家"授权 VPN 就进局域网了"，
 * 隧道起来后要告诉他"去 FCL 里添加服务器、地址填联机地址加端口"，以及
 * "手机做房主时踢人/限速不可用"这条边界。
 *
 * 这些话没有任何编译期保护：写错、写旧、留下一句"这台手机还不能联机"，
 * 类型检查全绿、布局检查全绿，只有玩家会撞上。所以这里在真浏览器里、走真实界面
 * （登录 → 建房 → 进房间页 → 切到设置页），把屏幕上实际渲染出来的字读回来断言。
 *
 * ## 两遍，两种世界
 *
 * | | 状态 | 该看到 | 不该看到 |
 * | --- | --- | --- | --- |
 * | A | 没有原生插件（桌面浏览器 / 插件缺失） | 进房前的授权说明、状态「联机失败」 | "下一步"那条 |
 * | B | 注入假原生插件、隧道报 running | 状态「已联机 · 加入码」、**下一步（FCL 里添加服务器）** | 进房前的授权说明 |
 *
 * 两遍都断言页面可见文案里没有"里程碑"这类内部术语 —— 上一轮就是这么漏掉
 * `MobileSettingsPage.vue` 那一句的。
 *
 * 用法：`node android/scripts/verify-vpn-copy.mjs`（`pnpm --filter @mclink/android verify:vpn:copy`）
 * 退出码 0 = 全部通过。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter, findChromium, launchBrowser, serveDir, sleep } from './lib/browser.mjs';
import { ANDROID_ROOT, DEFAULT_MASTER, ensureMaster, purgeRows, resolveDbPath } from './lib/master.mjs';

const isWin = process.platform === 'win32';
const MASTER = (process.env.MCLINK_VPN_MASTER ?? DEFAULT_MASTER).trim().replace(/\/+$/, '');
/** 版本号由 vite.config.ts 从 android/package.json 注入（define __MCLINK_APP_VERSION__） */
const EXPECTED_VERSION = JSON.parse(fs.readFileSync(path.join(ANDROID_ROOT, 'package.json'), 'utf8')).version;
const OUT_DIR = path.join(ANDROID_ROOT, '.smoke');
const r = createReporter('vpn-copy');

/**
 * 假原生桥：**模拟 native-bridge.js 的两个转发口**，而不是往 `Plugins` 里塞一个对象。
 *
 * 理由与 `verify-vpn-bridge.mjs` 里那段一样：`registerPlugin('MclinkVpn')` 会用自己的代理
 * 覆盖 `Plugins.MclinkVpn`，而代理在没有原生实现时调用直接抛异常 —— 只有 `PluginHeaders`
 * + `nativePromise`/`nativeCallback` 这条链才是真机走的路。
 */
const FAKE_NATIVE_BRIDGE = `
(() => {
  const state = { running: false, instanceName: null, tunFd: null, startedAt: null, lastError: null, lastErrorCode: null, vpnAuthorized: true };
  const listeners = { statusChanged: [], log: [] };
  const records = new Map();
  let seq = 0;
  function snapshot() { return Object.assign({}, state); }
  function pushStatus() { const p = snapshot(); for (const h of listeners.statusChanged.slice()) h(p); }
  window.Capacitor = {
    Plugins: {},
    PluginHeaders: [
      { name: 'MclinkVpn', methods: [
        { name: 'start', rtype: 'promise' }, { name: 'stop', rtype: 'promise' },
        { name: 'status', rtype: 'promise' }, { name: 'logs', rtype: 'promise' },
        { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'callback' }
      ] }
    ],
    nativePromise: function (plugin, method, options) {
      if (method === 'status') return Promise.resolve(snapshot());
      if (method === 'logs') return Promise.resolve({ lines: ['[info] 隧道已建立'] });
      if (method === 'stop') { state.running = false; state.startedAt = null; pushStatus(); return Promise.resolve(Object.assign(snapshot(), { ok: true })); }
      if (method === 'start') {
        state.running = true; state.instanceName = options.instanceName; state.tunFd = 42;
        state.startedAt = new Date().toISOString(); pushStatus();
        return Promise.resolve(Object.assign(snapshot(), { ok: true }));
      }
      return Promise.reject(new Error('未知方法 ' + method));
    },
    nativeCallback: function (plugin, method, options, cb) {
      const id = 'cb' + (++seq);
      if (method === 'addListener') { records.set(id, { e: options.eventName, h: cb }); listeners[options.eventName].push(cb); return id; }
      if (method === 'removeListener') { const rec = records.get(options.callbackId); if (rec) { records.delete(options.callbackId); const a = listeners[rec.e]; const i = a.indexOf(rec.h); if (i >= 0) a.splice(i, 1); } return ''; }
      return '';
    }
  };
})();
`;

const tmpOut = path.join(os.tmpdir(), `mclink-vpn-copy-dist-${Date.now()}`);
const profileDirs = [];
const children = [];
let served = null;

const master = await ensureMaster({ base: MASTER, log: r.log });
const createdRooms = [];
let createdUser = null;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (served) served.server.close();
  if (master.owned) {
    await master.stop();
    if (master.dataDir) fs.rmSync(master.dataDir, { recursive: true, force: true });
    r.log('已停掉临时主控并删除临时数据目录');
  } else if (createdRooms.length > 0 || createdUser) {
    await purgeRows(resolveDbPath(), { roomIds: createdRooms, userIds: createdUser ? [createdUser] : [] }, r.log);
  }
}

/** 页内小工具：填 v-model 输入框、按文字点按钮、按文字切底部标签 */
const FILL = `
  function fill(selector, value) {
    const el = document.querySelector(selector);
    if (!el) throw new Error('找不到 ' + selector);
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function clickByText(text) {
    const hit = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === text);
    if (!hit) throw new Error('找不到按钮 ' + text);
    hit.click();
  }
  function clickTab(name) {
    const hit = [...document.querySelectorAll('.mobile-tab')].find((b) => (b.textContent || '').trim() === name);
    if (!hit) throw new Error('找不到底部标签 ' + name);
    hit.click();
  }
  function scrollText() {
    const box = document.querySelector('.mobile-scroll');
    return (box ? box.innerText : document.body.innerText) || '';
  }
  /*
   * 假的 API 拦截：包一层 window.fetch，记录每一次请求，并可以按需把
   * PATCH /auth/profile 换成服务端的拒绝响应。
   *
   * 为什么包 fetch 就够：client/src/lib/api.ts 里是**调用时**才查全局 fetch
   * （函数体里的 \`fetch(...)\`），不是在模块求值时抓一份；所以这里的包装一定生效。
   * 有了它，"保留词不发请求"和"服务端拒绝的原话要显示出来"两件事才能被证伪，
   * 而不是靠读代码相信它。
   */
  function installFetchSpy() {
    if (window.__net) return;
    const real = window.fetch.bind(window);
    window.__net = { calls: [], profileError: null };
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      window.__net.calls.push({ url: url, method: method });
      if (window.__net.profileError && method === 'PATCH' && /\\/auth\\/profile$/.test(url)) {
        const body = JSON.stringify({ error: { code: 'CONFLICT', message: window.__net.profileError } });
        return Promise.resolve(new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }));
      }
      return real(input, init);
    };
  }
  function profileCalls() {
    return window.__net.calls.filter((c) => /\\/auth\\/profile$/.test(c.url));
  }
  function nickCurrent() {
    const el = document.querySelector('.nick-current');
    return el ? el.textContent.trim() : null;
  }
  function nickBad() {
    const el = document.querySelector('.nick-bad');
    return el ? el.textContent.trim() : null;
  }
  function nickServerError() {
    const el = document.querySelector('.nick-error');
    return el ? el.textContent.trim() : null;
  }
  function nickSaveButton() {
    return [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存昵称') || null;
  }
  function clickNickSave() {
    const b = nickSaveButton();
    if (!b) throw new Error('找不到「保存昵称」按钮');
    b.click();
  }
`;

/** 走界面：登录 → 建房并连接 → 收集页面上的可读状态 → 切设置页（含昵称编辑） */
async function runFlow({ label, inject, debugPort, roomName, username, password, newNickname }) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mclink-vpn-copy-'));
  profileDirs.push(profileDir);
  const { child, cdp, evaluate } = await launchBrowser({
    chromium: findChromium(),
    debugPort,
    profileDir,
    viewport: { width: 412, height: 915, scale: 2.625 },
    log: () => {},
  });
  children.push(child);
  if (inject) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_NATIVE_BRIDGE });

  const waitFor = async (selector, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await sleep(250);
    }
    return false;
  };
  const shoot = async (name) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, `vpn-copy-${name}.png`);
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
    r.log(`${label}：截图 ${p}`);
  };

  r.log(`${label} —— 打开产物跑界面`);
  await cdp.send('Page.navigate', { url: served.url });
  await sleep(4000);
  if (!(await waitFor('.login-card'))) throw new Error('登录卡没出现');
  await evaluate(`${FILL}
    fill('input[autocomplete="username"]', ${JSON.stringify(username)});
    fill('input[autocomplete="current-password"]', ${JSON.stringify(password)});
  `);
  await sleep(400);
  await evaluate(`clickByText('登录并开始联机')`);
  if (!(await waitFor('.home'))) throw new Error('登录后没进首页');

  await evaluate(`clickByText('创建')`);
  await sleep(700);
  if (!(await evaluate(`!!document.querySelector('.home input')`))) throw new Error('建房表单没打开');
  await evaluate(`${FILL}
    const input = document.querySelector('.home input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(roomName)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(400);
  await evaluate(`clickByText('创建并连接')`);
  const inRoom = await waitFor('.room-view', 30000);
  r.check(`${label}：建房后进入房间页`, inRoom);
  await sleep(3000); // 等 startNetwork / applyHosAcl 走完并把结果写进状态

  const room = await evaluate(`(() => {
    const text = document.body.innerText;
    const alerts = [...document.querySelectorAll('.alert')].map((a) => ({ cls: a.className, text: (a.textContent || '').trim() }));
    const led = document.querySelector('.mobile-topbar-status .led');
    return {
      status: ((document.querySelector('.mobile-topbar-status') || {}).textContent || '').trim(),
      ledClass: led ? led.className : '',
      alerts: alerts,
      bodyHasMilestone: text.includes('里程碑'),
      milestoneLines: text.split('\\n').filter((l) => l.includes('里程碑')),
    };
  })()`);
  await shoot(inject ? 'connected' : 'noplugin');

  /* 切到「设置」页：那里也有一段玩家可见的能力说明 */
  await evaluate(`${FILL} clickTab('设置')`);
  await sleep(900);
  /*
   * ⚠️ 读的是 `.mobile-scroll` 的 innerText，而它**包含房间页那几条 alert**
   * （showNotice / lastError 挂在标签页之外，切到设置页也还在）。
   * 这正是我们想要的：玩家在设置页看到的字就是这些。
   */
  const settings = await evaluate(`(() => {
    const box = document.querySelector('.mobile-scroll');
    const text = (box ? box.innerText : document.body.innerText) || '';
    const scope = box || document;
    const version = [...scope.querySelectorAll('.mono')].map((n) => (n.textContent || '').trim()).find((t) => /^v\\d/.test(t)) || '';
    // 「主控」那一块删掉之后，这里不该再有任何 h2 是「主控」、也不该有 .code 块
    const headings = [...scope.querySelectorAll('.mobile-section-title')].map((h) => (h.textContent || '').trim());
    return {
      text: text,
      version: version,
      headings: headings,
      codeBlocks: scope.querySelectorAll('.code').length,
      hasMasterUrl: text.includes(${JSON.stringify(MASTER)}),
      masterWordLines: text.split('\\n').filter((l) => l.includes('主控')),
      hasMilestone: text.includes('里程碑'),
      hasOldClaim: text.includes('尚未接入虚拟网络内核') || text.includes('只能"看房间"') || text.includes('只能看房间'),
      milestoneLines: text.split('\\n').filter((l) => l.includes('里程碑')),
    };
  })()`);
  await shoot(inject ? 'settings-connected' : 'settings-noplugin');

  /* ---- 改昵称：本地校验 / 服务端拒绝 / 成功保存 ---- */

  const nick = await evaluate(`${FILL}
    (async () => {
      installFetchSpy();
      const out = { before: nickCurrent() };
      const input = document.querySelector('#nick-input');
      out.inputExists = !!input;
      out.inputDisabled = input ? input.disabled : null;
      out.inputMaxLength = input ? input.maxLength : null;
      out.saveButtonExists = !!nickSaveButton();
      out.saveButtonDisabledInitially = nickSaveButton() ? nickSaveButton().disabled : null;

      // ① 保留词：本地就该拒（shared 的 displayNameProblem），一次请求都不许发
      fill('#nick-input', 'mclink');
      await new Promise((resolve) => setTimeout(resolve, 150));
      out.reservedBad = nickBad();
      out.reservedSaveDisabled = nickSaveButton() ? nickSaveButton().disabled : null;
      const beforeReserved = profileCalls().length;
      clickNickSave();
      await new Promise((resolve) => setTimeout(resolve, 500));
      out.reservedRequests = profileCalls().length - beforeReserved;
      out.reservedServerError = nickServerError();
      out.afterReservedCurrent = nickCurrent();

      /*
       * ①b 把按钮强行 enable 再点一次。
       *
       * 上一条只证明了"disabled 的按钮点不动"——那是**属性**在挡，不是逻辑在挡。
       * 真实浏览器里用户按回车、或将来有人给输入框加个 @keyup.enter，都能绕过 disabled，
       * 所以这里把属性拆掉，验的是 saveNickname() 里那个「nicknameIssue 就 return」的分支。
       */
      const forced = nickSaveButton();
      forced.disabled = false;
      forced.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      out.forcedGuardRequests = profileCalls().length - beforeReserved;
      out.forcedGuardError = nickServerError();

      // ② 合法昵称，但服务端拒绝：必须把主控那句原话显示出来
      window.__net.profileError = '这个名字已被占用（含相似字符也不行），请换一个';
      fill('#nick-input', ${JSON.stringify(newNickname)});
      await new Promise((resolve) => setTimeout(resolve, 150));
      out.legalBad = nickBad();
      out.legalSaveDisabled = nickSaveButton() ? nickSaveButton().disabled : null;
      const beforeReject = profileCalls().length;
      clickNickSave();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      out.rejectedRequests = profileCalls().length - beforeReject;
      out.rejectedServerError = nickServerError();
      out.afterRejectedCurrent = nickCurrent();

      // ③ 真正保存成功
      window.__net.profileError = null;
      clickNickSave();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      out.savedCurrent = nickCurrent();
      out.savedAlert = [...document.querySelectorAll('.alert-ok')].map((a) => (a.textContent || '').trim());
      out.savedServerError = nickServerError();
      out.totalProfileRequests = profileCalls().length;
      return out;
    })()
  `);

  /* 390px 窄屏不该横向溢出（改昵称那块是这一页新增的最宽内容） */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(600);
  const narrow = await evaluate(`({
    vw: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    settingsScrollWidth: (document.querySelector('.mobile-scroll') || {}).scrollWidth || 0,
  })`);
  await shoot(inject ? 'settings-connected-390' : 'settings-noplugin-390');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });

  return { room, settings, nick, narrow };
}

/* --------------------------------------------------- 设置页那两件事的断言 */

/**
 * 「主控」那一块必须没了。
 *
 * ⚠️ 「主控」这两个字**在这一页的提醒说明里仍然出现**（"提醒是靠应用自己收到主控的消息再弹通知的"）——
 * 那是既有文案，与删掉的分区无关，也不该为这次改动去动它。所以这里断言的是**结构性事实**：
 * 没有「主控」这个小标题、没有那块唯一的 `.code` 地址框、没有 masterUrl 字符串，
 * 且凡是出现"主控"二字的行都必须是那句提醒说明（含"通知/推送"）。
 */
function assertMasterBlockGone(tag, settings) {
  r.check(`${tag}/设置页：没有「主控」这个小标题`, !settings.headings.includes('主控'), JSON.stringify(settings.headings));
  r.check(`${tag}/设置页：没有 .code 地址框（那一块唯一用到它的地方）`, settings.codeBlocks === 0, `codeBlocks=${settings.codeBlocks}`);
  r.check(`${tag}/设置页：页面文本里不出现主控地址 ${MASTER}`, settings.hasMasterUrl === false);
  r.check(
    `${tag}/设置页：出现"主控"二字的只剩提醒那段既有说明`,
    settings.masterWordLines.every((l) => /通知|推送/.test(l)),
    JSON.stringify(settings.masterWordLines),
  );
  r.check(
    `${tag}/设置页：开发主控那句提示也没了`,
    !/本机开发主控/.test(settings.text) && !/平台不开放自建主控/.test(settings.text),
  );
}

/** 改昵称：可编辑 → 保留词本地拒绝且不发请求 → 服务端拒绝要显示原话 → 成功后界面立刻变 */
function assertNicknameFlow(tag, nick, expectedNickname) {
  r.check(
    `${tag}/昵称：有可编辑的输入框（未禁用、maxlength=32）`,
    nick.inputExists === true && nick.inputDisabled === false && nick.inputMaxLength === 32,
    JSON.stringify({ exists: nick.inputExists, disabled: nick.inputDisabled, max: nick.inputMaxLength }),
  );
  r.check(`${tag}/昵称：有「保存昵称」按钮，初始可用`, nick.saveButtonExists === true && nick.saveButtonDisabledInitially === false);

  // ① 保留词：本地校验（shared 的规则）当场报，一次请求都不发
  r.check(
    `${tag}/昵称：填 "mclink" 时就地报"与官方身份相近"（shared 的 displayNameProblem 文案）`,
    /与官方身份相近/.test(nick.reservedBad ?? ''),
    String(nick.reservedBad),
  );
  r.check(`${tag}/昵称：这时保存按钮是禁用的`, nick.reservedSaveDisabled === true);
  r.check(`${tag}/昵称：点保存**不发出任何请求**（PATCH /auth/profile 次数为 0）`, nick.reservedRequests === 0, `实际 ${nick.reservedRequests} 次`);
  r.check(`${tag}/昵称：也不会冒出一条服务端错误（压根没到服务端）`, nick.reservedServerError === null, String(nick.reservedServerError));
  r.check(`${tag}/昵称：账号里的显示名没有被改掉`, nick.afterReservedCurrent === nick.before, `${nick.before} → ${nick.afterReservedCurrent}`);
  // ①b 拆掉 disabled 属性再点：拦截必须在**处理器**里也成立
  r.check(
    `${tag}/昵称：强行 enable 按钮再点，依然**不发出请求**（拦截在处理器里，不只是 disabled 属性）`,
    nick.forcedGuardRequests === 0,
    `实际 ${nick.forcedGuardRequests} 次`,
  );
  r.check(
    `${tag}/昵称：强行点击时给出的是同一条本地校验文案`,
    /与官方身份相近/.test(nick.forcedGuardError ?? ''),
    String(nick.forcedGuardError),
  );

  // ② 合法昵称 + 服务端拒绝：必须显示主控那句原话
  r.check(
    `${tag}/昵称：合法昵称本地不报错、按钮可用`,
    nick.legalBad === null && nick.legalSaveDisabled === false,
    JSON.stringify({ bad: nick.legalBad, disabled: nick.legalSaveDisabled }),
  );
  r.check(`${tag}/昵称：真的发出了 PATCH /auth/profile`, nick.rejectedRequests >= 1, `实际 ${nick.rejectedRequests} 次`);
  r.check(
    `${tag}/昵称：服务端拒绝时显示的是主控返回的 message 原文（不吞掉、不编一句）`,
    nick.rejectedServerError === '这个名字已被占用（含相似字符也不行），请换一个',
    String(nick.rejectedServerError),
  );
  r.check(`${tag}/昵称：被拒后显示名仍是旧的（界面不说谎）`, nick.afterRejectedCurrent === nick.before, `${nick.before} → ${nick.afterRejectedCurrent}`);

  // ③ 真正保存成功：state.user 更新 → 界面立刻跟着变
  r.check(
    `${tag}/昵称：保存成功后账号里的显示名立刻变成新昵称`,
    nick.savedCurrent === expectedNickname,
    `期望 ${expectedNickname}，实际 ${nick.savedCurrent}`,
  );
  r.check(`${tag}/昵称：并给出"昵称已保存"的成功提示`, (nick.savedAlert ?? []).some((t) => /昵称已保存/.test(t)), JSON.stringify(nick.savedAlert));
  r.check(`${tag}/昵称：成功后服务端错误消失`, nick.savedServerError === null, String(nick.savedServerError));
}

/** 390px 窄屏不该横向溢出 */
function assertNoHorizontalOverflow(tag, narrow) {
  r.check(
    `${tag}/390px：页面没有横向溢出`,
    narrow.vw === 390 && narrow.scrollWidth <= narrow.vw + 1 && narrow.bodyScrollWidth <= narrow.vw + 1,
    JSON.stringify(narrow),
  );
  r.check(`${tag}/390px：设置页内容区也没有横向溢出`, narrow.settingsScrollWidth <= narrow.vw + 1, JSON.stringify(narrow));
}

try {
  const stamp = Date.now().toString(36);
  const username = `vpncopy${stamp}`;
  const password = 'vpnCopy-2026';
  const reg = await master.api('/auth/register', {
    method: 'POST',
    body: { username, password, displayName: `文案验证 ${stamp.slice(-4)}` },
  });
  createdUser = reg.user?.id ?? null;

  const viteBin = path.join(ANDROID_ROOT, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
  r.log(`构建临时产物（指向 ${MASTER}）`);
  const build = spawnSync(`"${viteBin}" build --outDir "${tmpOut}"`, {
    cwd: ANDROID_ROOT,
    stdio: 'ignore',
    shell: true,
    env: { ...process.env, VITE_MCLINK_MASTER: MASTER },
  });
  if (build.status !== 0) throw new Error('vite build 失败');
  served = await serveDir(tmpOut);

  /* ------------------------------------------------ A. 没有插件 */

  const noPlugin = await runFlow({
    label: 'A(无插件)',
    inject: false,
    debugPort: 9347,
    roomName: `文案验证A ${stamp.slice(-4)}`,
    username,
    password,
    newNickname: `手机昵称A${stamp.slice(-4)}`,
  });

  const notice = noPlugin.room.alerts.find((a) => /VPN 授权/.test(a.text));
  r.check('A：出现"授权 VPN"这条进房前说明', !!notice, JSON.stringify(noPlugin.room.alerts.map((a) => a.text.slice(0, 40))));
  r.check(
    'A：说明写清了"授权后本机就进虚拟局域网"（而不是"换台电脑联机"）',
    !!notice && /虚拟局域网/.test(notice.text) && !/装了 Windows 客户端的朋友/.test(notice.text),
    notice ? notice.text : '',
  );
  r.check('A：还没联机时不显示"下一步（启动器里添加服务器）"', !noPlugin.room.alerts.some((a) => a.cls.includes('alert-ok')));
  r.check('A：状态那一行是「联机失败」', noPlugin.room.status === '联机失败', `实际=${noPlugin.room.status}`);
  r.check('A：状态点是 danger（真实失败才亮红）', /led-danger/.test(noPlugin.room.ledClass), noPlugin.room.ledClass);
  r.check('A：可见文案里没有"里程碑"', noPlugin.room.bodyHasMilestone === false, noPlugin.room.milestoneLines.join(' | '));

  r.check(
    'A/设置页：那条"尚未接入虚拟网络内核 / 只能看房间"的旧说法已消失',
    noPlugin.settings.hasOldClaim === false,
  );
  r.check(
    'A/设置页：写的是"授权后进虚拟局域网 + 在 MC 启动器里添加服务器"',
    /虚拟局域网/.test(noPlugin.settings.text) && /(FCL|启动器)/.test(noPlugin.settings.text) && /添加服务器/.test(noPlugin.settings.text),
    noPlugin.settings.text.slice(0, 200),
  );
  r.check('A/设置页：保留了"手机做房主时踢人 / 限速不可用"这条边界', /踢人/.test(noPlugin.settings.text) && /限速/.test(noPlugin.settings.text));
  r.check('A/设置页：可见文案里没有"里程碑"', noPlugin.settings.hasMilestone === false, noPlugin.settings.milestoneLines.join(' | '));
  r.check(
    `A/设置页：版本号显示 v${EXPECTED_VERSION}（与 android/package.json 一致）`,
    noPlugin.settings.version === `v${EXPECTED_VERSION}`,
    `实际=${noPlugin.settings.version || '(没找到)'}`,
  );

  /* ------------------------------------------------ 设置页：主控那一块必须没了（A） */

  assertMasterBlockGone('A', noPlugin.settings);

  /* ------------------------------------------------ A：改昵称 */

  assertNicknameFlow('A', noPlugin.nick, `手机昵称A${stamp.slice(-4)}`);

  /* ------------------------------------------------ B. 有插件、隧道 running */

  const connected = await runFlow({
    label: 'B(假插件)',
    inject: true,
    debugPort: 9348,
    roomName: `文案验证B ${stamp.slice(-4)}`,
    username,
    password,
    newNickname: `手机昵称B${stamp.slice(-4)}`,
  });

  const nextStep = connected.room.alerts.find((a) => a.cls.includes('alert-ok'));
  r.check('B：隧道 running 后出现"下一步"那条', !!nextStep, JSON.stringify(connected.room.alerts.map((a) => a.text.slice(0, 60))));
  r.check(
    'B：下一步说的是"在 MC 启动器（如 FCL）里添加服务器，填联机地址 + 端口"',
    !!nextStep && /FCL/.test(nextStep.text) && /添加服务器/.test(nextStep.text) && /端口/.test(nextStep.text),
    nextStep ? nextStep.text : '',
  );
  r.check('B：进房前那条说明退场（被下一步取代）', !connected.room.alerts.some((a) => /VPN 授权/.test(a.text)));
  r.check('B：状态那一行是「已联机 · <加入码>」', /^已联机 · [A-Z0-9]{4,}$/.test(connected.room.status), `实际=${connected.room.status}`);
  r.check('B：状态点是 ok（真在跑才亮绿）', /led-ok/.test(connected.room.ledClass), connected.room.ledClass);
  r.check(
    'B：房主在手机上应用 ACL 的诚实失败文案写明了"不是故障"',
    connected.room.alerts.some((a) => /应用房间规则失败/.test(a.text) && /不是故障/.test(a.text)),
    JSON.stringify(connected.room.alerts.map((a) => a.text.slice(0, 80))),
  );
  r.check('B：可见文案里没有"里程碑"', connected.room.bodyHasMilestone === false, connected.room.milestoneLines.join(' | '));
  r.check('B/设置页：可见文案里没有"里程碑"', connected.settings.hasMilestone === false, connected.settings.milestoneLines.join(' | '));
  r.check(
    'B/设置页：同样写清了能联机（文案不因隧道状态而变）',
    /虚拟局域网/.test(connected.settings.text) && connected.settings.hasOldClaim === false,
  );

  /* ------------------------------------------------ 设置页：主控没了 + 改昵称（B） */

  assertMasterBlockGone('B', connected.settings);
  assertNicknameFlow('B', connected.nick, `手机昵称B${stamp.slice(-4)}`);

  /* ------------------------------------------------ 390px 不横向溢出 */

  assertNoHorizontalOverflow('A', noPlugin.narrow);
  assertNoHorizontalOverflow('B', connected.narrow);

  /* ------------------------------------------------ 清理：把界面建的两个房间找出来 */

  const login = await master.api('/auth/login', { method: 'POST', body: { username, password } });
  const mine = await master.api('/rooms', { token: login.token });
  for (const room of [...(mine.hosted ?? []), ...(mine.joined ?? [])]) createdRooms.push(room.id);
  r.log(`界面共建了 ${createdRooms.length} 个房间，将一并清理`);
} catch (err) {
  r.check('脚本没有中途抛异常', false, String(err?.stack ?? err));
} finally {
  await cleanup();
}

console.log('');
r.log(r.failures === 0 ? '全部通过 ✓' : `${r.failures} 项未通过 ✗`);

for (const c of children) {
  try {
    c.kill();
  } catch {
    /* 已退 */
  }
}
await sleep(250);
for (const dir of [tmpOut, ...profileDirs]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄可能还没释放，留给系统清 */
  }
}
process.exit(r.failures === 0 ? 0 : 1);
