#!/usr/bin/env node
/**
 * JS ↔ 原生接线验证 —— **在没有手机的情况下，证明 `core.*` 真的接上了插件**。
 *
 * ## 为什么必须验这一层
 *
 * `docs/android-vpn.md` §3 那份插件契约有两个方向的错法，而且都不会在编译期报出来：
 *
 *   · **字段传错**：`start()` 漏传 `routes`、`mtu` 传成字符串 —— Kotlin 侧只能自己兜，
 *     兜不住就是整机断网（空路由）或者大包被丢；
 *   · **事件接错**：`statusChanged` 没接到 `onStatus` 上 —— 玩家点连接之后界面
 *     永远停在「正在建立连接…」，而隧道其实已经起来了。
 *
 * 这两件事在真机上要插 USB、装 APK、一步步点才能发现，而它们的根因全在 JS 这一侧。
 * 所以这里把**原生侧换成一个假的原生桥**，在 Chromium 里跑真实产物，直接问：
 * "你到底把什么交给了原生？原生说 running 的时候你报的是什么？"
 *
 * ## 假插件为什么长得像"原生桥"而不是 `{ start() {} }`
 *
 * 契约里写的是 `window.Capacitor = { Plugins: { MclinkVpn: … } }` 之类的注入方式，
 * 但**那样注入是无效的**：`@capacitor/core` 的 `registerPlugin('MclinkVpn')` 会
 * 拿自己的代理**覆盖**掉 `Plugins.MclinkVpn`（见 dist/index.js 的
 * `Plugins[pluginName] = proxy`），而代理在没有原生实现时调用会直接抛
 * `CapacitorException: "MclinkVpn" plugin is not implemented on web`。
 *
 * 真机上 `window.Capacitor` 是 **native-bridge.js** 注入的：它带 `PluginHeaders`，
 * 并提供 `nativePromise` / `nativeCallback` 两个转发口。所以这里注入的是**那两个口**
 * ——这比模拟 `Plugins` 更接近真机，也顺带把 Capacitor 自己那条调用链走了一遍。
 *
 * ## 用法
 *
 *   node android/scripts/verify-vpn-bridge.mjs
 *
 * 它自己构建一份临时产物（`vite build --outDir <tmp>`），不动仓库里的 android/dist。
 * 退出码 0 = 全部通过。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createReporter, findChromium, launchBrowser, serveDir, sleep } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'ticket-real.toml');
const isWin = process.platform === 'win32';

const r = createReporter('vpn-bridge');
const tmpOut = path.join(os.tmpdir(), `mclink-vpn-bridge-dist-${Date.now()}`);

if (!fs.existsSync(FIXTURE)) {
  console.error(`[vpn-bridge] ✗ 缺少 fixture ${FIXTURE}。先跑 verify-vpn-plan.mjs。`);
  process.exit(2);
}
/** 真实票据（fixture 是主控真的下发过的那一份，见文件头说明） */
const REAL_TOML = fs.readFileSync(FIXTURE, 'utf8');
/** 与 fixture 里的 instance_name 一致；下面还有一条"以 TOML 为准"的断言会故意传别的值 */
const FIXTURE_INSTANCE = /^instance_name\s*=\s*"([^"]+)"/m.exec(REAL_TOML)?.[1] ?? '';
/**
 * 期望的计划**从 fixture 自己算出来**（独立实现，不复用 vpn-plan.ts）：
 * 期望值如果用被测代码算，这条断言就退化成"它等于它自己"。
 */
const REAL_PLAN = (() => {
  const m = /^ipv4\s*=\s*"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})"/m.exec(REAL_TOML);
  if (!m) {
    console.error('[vpn-bridge] ✗ fixture 里没有可解析的 ipv4 行');
    process.exit(2);
  }
  const [, a, b, c, d, prefix] = m;
  return {
    instanceName: FIXTURE_INSTANCE,
    address: { ip: `${Number(a)}.${Number(b)}.${Number(c)}.${Number(d)}`, prefix: Number(prefix) },
    routes: [{ ip: `${Number(a)}.${Number(b)}.${Number(c)}.0`, prefix: 24 }],
    mtu: 1380,
  };
})();

/* --------------------------------------------------- 假原生桥（注入到页面里） */

/**
 * 这一段在**页面里任何脚本之前**执行（`Page.addScriptToEvaluateOnNewDocument`），
 * 所以 `@capacitor/core` 求值时看到的就是"真机上那一套"。
 */
const FAKE_NATIVE_BRIDGE = `
(() => {
  const calls = [];
  const state = { running: false, instanceName: null, tunFd: null, startedAt: null, lastError: null, lastErrorCode: null, vpnAuthorized: true };
  const listeners = { statusChanged: [], log: [] };
  const callbackRecords = new Map();
  let seq = 0;
  let startOverride = null;
  /*
   * 返回形状。契约（§3）以 **flat** 为准 —— 就是 Kotlin 的样子
   * （statusToJs() 的结果平铺，再 put 一个 ok），所以主断言全部跑 flat。
   * 'nested' 只是"旧写法也别炸"的防御性回归。
   */
  let responseShape = 'flat';

  function snapshot() { return Object.assign({}, state); }
  function pushStatus(patch) {
    Object.assign(state, patch || {});
    const payload = snapshot();
    for (const h of listeners.statusChanged.slice()) h(payload);
  }
  function pushLog(line) {
    const at = new Date().toISOString();
    for (const h of listeners.log.slice()) h({ line: line, at: at });
  }
  function envelope(extra) {
    const status = snapshot();
    if (responseShape === 'nested') return Object.assign({ status: status }, extra);
    return Object.assign({}, status, extra);
  }

  window.__mclinkFake = {
    calls: calls,
    state: state,
    pushStatus: pushStatus,
    pushLog: pushLog,
    listenerCount: function (name) { return listeners[name].length; },
    failNextStart: function (result) { startOverride = result; },
    clearCalls: function () { calls.length = 0; },
    setResponseShape: function (shape) { responseShape = shape; }
  };

  function nativePromise(pluginName, methodName, options) {
    calls.push({ pluginName: pluginName, methodName: methodName, options: options });
    if (pluginName !== 'MclinkVpn') return Promise.reject(new Error('未知插件 ' + pluginName));
    if (methodName === 'status') return Promise.resolve(snapshot());
    if (methodName === 'logs') return Promise.resolve({ lines: ['[info] 实例已启动', '[info] 隧道已建立'] });
    if (methodName === 'stop') {
      /*
       * 清掉 lastError 是**必须的**，不是为了让测试好看：
       * §3.1 的映射表是「running:false + lastError → error」，如果服务的 lastError
       * 一旦出错就永不清空，那第三行（running:false 且无错误 → stopped）就**永远不可达**，
       * 界面会一直挂着一个早就过去的错误。一个干净停下来的服务没有"当前错误"。
       */
      state.running = false; state.tunFd = null; state.startedAt = null; state.lastError = null;
      pushStatus({});
      return Promise.resolve(envelope({ ok: true }));
    }
    if (methodName === 'start') {
      if (startOverride) { const o = startOverride; startOverride = null; return Promise.resolve(o); }
      state.running = true;
      state.instanceName = options && options.instanceName ? options.instanceName : null;
      state.tunFd = 42;
      state.startedAt = new Date().toISOString();
      pushStatus({});
      return Promise.resolve(envelope({ ok: true }));
    }
    return Promise.reject(new Error('未知方法 ' + methodName));
  }

  function nativeCallback(pluginName, methodName, options, callback) {
    calls.push({ pluginName: pluginName, methodName: methodName, options: options });
    const id = 'cb' + (++seq);
    if (methodName === 'addListener') {
      callbackRecords.set(id, { eventName: options.eventName, handler: callback });
      listeners[options.eventName].push(callback);
      return id;
    }
    if (methodName === 'removeListener') {
      const rec = callbackRecords.get(options.callbackId);
      if (rec) {
        callbackRecords.delete(options.callbackId);
        const arr = listeners[rec.eventName];
        const i = arr.indexOf(rec.handler);
        if (i >= 0) arr.splice(i, 1);
      }
      return '';
    }
    return '';
  }

  window.Capacitor = {
    Plugins: {},
    PluginHeaders: [
      { name: 'MclinkVpn', methods: [
        { name: 'start', rtype: 'promise' },
        { name: 'stop', rtype: 'promise' },
        { name: 'status', rtype: 'promise' },
        { name: 'logs', rtype: 'promise' },
        { name: 'addListener', rtype: 'callback' },
        { name: 'removeListener', rtype: 'callback' }
      ] }
    ],
    nativePromise: nativePromise,
    nativeCallback: nativeCallback
  };
})();
`;

/* --------------------------------------------------- 构建临时产物 */

r.log(`构建临时产物 → ${tmpOut}`);
const viteBin = path.join(ANDROID_ROOT, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
const build = spawnSync(`"${viteBin}" build --outDir "${tmpOut}"`, {
  cwd: ANDROID_ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env },
});
if (build.status !== 0 || !fs.existsSync(path.join(tmpOut, 'index.html'))) {
  console.error('[vpn-bridge] ✗ 临时产物构建失败');
  process.exit(2);
}

const { server, url } = await serveDir(tmpOut);
const profileDirs = [];
const children = [];

/** 起一个浏览器；`inject` 为真时把假原生桥在页面脚本之前注入 */
async function openPage({ debugPort, inject }) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mclink-vpn-bridge-'));
  profileDirs.push(profileDir);
  const { child, cdp, evaluate } = await launchBrowser({
    chromium: findChromium(),
    debugPort,
    profileDir,
    viewport: { width: 412, height: 915, scale: 2.625 },
    log: () => {},
  });
  children.push(child);
  if (inject) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_NATIVE_BRIDGE });
  }
  await cdp.send('Page.navigate', { url });
  // 与 smoke-mobile.mjs 同一个理由：Vue 挂载与 bootstrap() 都发生在 load 之后
  await sleep(3500);
  return { cdp, evaluate };
}

/** 页内求值，异常当成失败抛出（而不是静默返回 undefined） */
async function waitFor(evaluate, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`!!(${expression})`)) return true;
    await sleep(200);
  }
  return false;
}

/**
 * 页内的断言脚手架：所有 `core.*` 调用都包在 try/catch 里，
 * 把"抛了异常"和"返回了错东西"变成同一条可读的结果，而不是让 evaluate 直接炸掉。
 */
const PAGE_HELPERS = `
window.__t = {
  results: [],
  call: async function (label, fn) {
    try { return { label: label, ok: true, value: await fn() }; }
    catch (e) { return { label: label, ok: false, threw: String((e && e.message) || e) }; }
  },
  isIso: function (s) { return typeof s === 'string' && !Number.isNaN(Date.parse(s)); }
};
`;

let failuresBefore = 0;
function check(label, ok, detail = '') {
  return r.check(label, ok, detail);
}
/* =================================================== 第一段：有插件 */

const withPlugin = await openPage({ debugPort: 9341, inject: true });
const ask1 = withPlugin.evaluate;

if (!(await waitFor(withPlugin.evaluate, `window.mclink && window.mclink.core && window.mclink.core.start`))) {
  check('页面装上了 window.mclink.core', false, '等了 15 秒还是没有');
} else {
  check('页面装上了 window.mclink.core', true);

  const available = await ask1(`(async () => {
    const core = window.Capacitor;
    return { isPluginAvailable: core.isPluginAvailable('MclinkVpn'), platform: core.getPlatform() };
  })()`);
  check(
    '假原生桥被 Capacitor 认成"插件可用"（否则下面的断言测的不是接线而是降级）',
    available.isPluginAvailable === true,
    JSON.stringify(available),
  );

  /* ------------------------------------------------ 订阅：onStatus / onLog */

  await ask1(`${PAGE_HELPERS}
    window.__seenStatus = [];
    window.__seenLog = [];
    window.__offStatus = window.mclink.core.onStatus((s) => window.__seenStatus.push(s));
    window.__offLog = window.mclink.core.onLog((e) => window.__seenLog.push(e));
    true
  `);
  await sleep(400); // 惰性订阅是异步落到插件上的

  const listeners = await ask1(`({ status: window.__mclinkFake.listenerCount('statusChanged'), log: window.__mclinkFake.listenerCount('log') })`);
  check('插件上有且只有一条 statusChanged 订阅（扇出，不是每个监听者订一次）', listeners.status === 1, JSON.stringify(listeners));
  check('插件上有且只有一条 log 订阅', listeners.log === 1, JSON.stringify(listeners));

  const stillOne = await ask1(`(async () => {
    // 再挂三个订阅者：插件侧不该因此多出订阅
    window.mclink.core.onStatus(() => {});
    window.mclink.core.onStatus(() => {});
    window.mclink.core.onLog(() => {});
    await new Promise((r) => setTimeout(r, 300));
    return window.__mclinkFake.listenerCount('statusChanged');
  })()`);
  check('重复订阅不会给插件加订阅（幂等）', stillOne === 1, `实际 ${stillOne}`);

  check(
    'onStatus / onLog 返回的仍是取消订阅函数（签名没变）',
    (await ask1(`typeof window.__offStatus === 'function' && typeof window.__offLog === 'function'`)) === true,
  );

  /* ------------------------------------------------ 组不出计划时：绝不调插件 */

  const badStart = await ask1(`${PAGE_HELPERS}
    window.__mclinkFake.clearCalls();
    window.__t.call('start', async () => {
      const toml = ${JSON.stringify(REAL_TOML)}.split('\\n').filter((l) => !/^ipv4\\s*=/.test(l)).join('\\n');
      const status = await window.mclink.core.start({ configToml: toml, instanceName: ${JSON.stringify(FIXTURE_INSTANCE)} });
      return {
        status: status,
        pluginStartCalls: window.__mclinkFake.calls.filter((c) => c.methodName === 'start').length,
      };
    })
  `);
  check('组不出计划时 core.start 不抛异常', badStart.ok === true, badStart.threw ?? '');
  if (badStart.ok) {
    const v = badStart.value;
    check('没有 ipv4 的票据 → state=error', v.status.state === 'error', JSON.stringify(v.status.state));
    check('错误文案说清了是"算不出房间网段"', /房间网段/.test(v.status.lastError ?? ''), v.status.lastError);
    check('错误文案里不出现内部 code', !/no-routes/.test(v.status.lastError ?? ''), v.status.lastError);
    check('**一个字节都没发给插件**（插件 start 调用次数为 0）', v.pluginStartCalls === 0, `实际 ${v.pluginStartCalls}`);
  }

  /* ------------------------------------------------ 正例：真实票据 → 插件入参 */

  const started = await ask1(`${PAGE_HELPERS}
    window.__mclinkFake.clearCalls();
    window.__t.call('start', async () => {
      const status = await window.mclink.core.start({
        configToml: ${JSON.stringify(REAL_TOML)},
        instanceName: ${JSON.stringify(FIXTURE_INSTANCE)},
        launchArgs: ['--some-desktop-flag'],
      });
      return { status: status, startCall: window.__mclinkFake.calls.find((c) => c.methodName === 'start') };
    })
  `);
  check('core.start 不抛异常', started.ok === true, started.threw ?? '');
  if (started.ok) {
    const { status, startCall } = started.value;
    check('插件收到了 start 调用', !!startCall && startCall.pluginName === 'MclinkVpn', JSON.stringify(startCall));
    const sent = startCall?.options;
    check(
      '传给插件的入参与 vpn-plan 算出的计划逐字一致',
      isDeepStrictEqual(sent, { ...REAL_PLAN, configToml: REAL_TOML }),
      `实际 ${JSON.stringify(sent)}`,
    );
    check('插件入参里有 routes，且只有房间网段', Array.isArray(sent?.routes) && sent.routes.length === 1 && sent.routes[0].ip === '10.200.0.0', JSON.stringify(sent?.routes));
    check('插件入参里没有 0.0.0.0/0', !sent?.routes?.some((x) => x.prefix === 0 && x.ip === '0.0.0.0'));
    check('插件入参里 mtu 是数字 1380（不是字符串）', sent?.mtu === 1380, JSON.stringify(sent?.mtu));
    check('插件入参带了完整 configToml（原生侧要拿它跑 parseConfig）', sent?.configToml === REAL_TOML);

    check('插件报 running → CoreStatus.state = running（**平铺返回形状**：Kotlin 现在的样子）', status.state === 'running', JSON.stringify(status));
    check('pid 为 null（没有子进程，这是事实）', status.pid === null, JSON.stringify(status.pid));
    check('startedAt 是 ISO 时间', await ask1(`window.__t.isIso(${JSON.stringify(status.startedAt)})`), String(status.startedAt));
    check('configFile / args / rpcPortal / elevated / coreBin* 照 §3.1 为空', isDeepStrictEqual(
      { configFile: status.configFile, args: status.args, rpcPortal: status.rpcPortal, elevated: status.elevated, coreBin: status.coreBin, coreBinExists: status.coreBinExists, cliBinExists: status.cliBinExists },
      { configFile: null, args: [], rpcPortal: null, elevated: false, coreBin: '', coreBinExists: false, cliBinExists: false },
    ), JSON.stringify(status));
  }

  /* ------------------------------------------------ 两种返回形状都要认（契约 vs Kotlin 现状） */

  const shapes = await ask1(`${PAGE_HELPERS}
    window.__mclinkFake.clearCalls();
    window.__t.call('shapes', async () => {
      window.__mclinkFake.setResponseShape('nested');
      const nested = await window.mclink.core.start({ configToml: ${JSON.stringify(REAL_TOML)}, instanceName: ${JSON.stringify(FIXTURE_INSTANCE)} });
      window.__mclinkFake.setResponseShape('flat');
      const flat = await window.mclink.core.start({ configToml: ${JSON.stringify(REAL_TOML)}, instanceName: ${JSON.stringify(FIXTURE_INSTANCE)} });
      const stopped = await window.mclink.core.stop();
      return { nested: nested.state, nestedStartedAt: nested.startedAt, flat: flat.state, stopFlat: stopped.state };
    })
  `);
  check('start / stop 不抛异常（两种形状）', shapes.ok === true, shapes.threw ?? '');
  if (shapes.ok) {
    check('§3 的嵌套形状（{ ok, status }）能映射成 running', shapes.value.nested === 'running', JSON.stringify(shapes.value));
    check('  · 嵌套形状下 startedAt 也拿到了', await ask1(`window.__t.isIso(${JSON.stringify(shapes.value.nestedStartedAt)})`), String(shapes.value.nestedStartedAt));
    check('Kotlin 的平铺形状能映射成 running（否则真机上会永远显示"正在建立连接…"）', shapes.value.flat === 'running', JSON.stringify(shapes.value));
    check('  · stop 的平铺形状能映射成 stopped', shapes.value.stopFlat === 'stopped', JSON.stringify(shapes.value));
  }

  /* ------------------------------------------------ instanceName 以 TOML 为准 */

  const nameRule = await ask1(`${PAGE_HELPERS}
    window.__mclinkFake.clearCalls();
    window.__t.call('start', async () => {
      await window.mclink.core.start({ configToml: ${JSON.stringify(REAL_TOML)}, instanceName: 'caller-乱传的名字' });
      const c = window.__mclinkFake.calls.find((x) => x.methodName === 'start');
      return c ? c.options.instanceName : null;
    })
  `);
  check(
    'instanceName 以 TOML 的 instance_name 为准（setTunFd 认的是内核注册的那个名字）',
    nameRule.ok === true && nameRule.value === FIXTURE_INSTANCE,
    `实际 ${JSON.stringify(nameRule.value)}`,
  );

  /* ------------------------------------------------ statusChanged → onStatus */

  const events = await ask1(`${PAGE_HELPERS}
    (async () => {
      window.__seenStatus.length = 0;
      const startedAt = new Date().toISOString();
      window.__mclinkFake.pushStatus({ running: true, instanceName: ${JSON.stringify(FIXTURE_INSTANCE)}, startedAt: startedAt });
      await new Promise((r) => setTimeout(r, 60));
      window.__mclinkFake.pushStatus({ running: false, lastError: '内核在建立隧道时退出了', lastErrorCode: null });
      await new Promise((r) => setTimeout(r, 60));
      window.__mclinkFake.pushStatus({ running: false, lastError: null, lastErrorCode: null });
      await new Promise((r) => setTimeout(r, 60));
      return window.__seenStatus.map((s) => ({ state: s.state, lastError: s.lastError, startedAt: s.startedAt }));
    })()
  `);
  check('statusChanged 推给了 onStatus 订阅者（3 条）', Array.isArray(events) && events.length === 3, JSON.stringify(events));
  check('  · running:true → state=running', events?.[0]?.state === 'running', JSON.stringify(events?.[0]));
  check('  · running:false 无错误 → state=stopped', events?.[2]?.state === 'stopped', JSON.stringify(events?.[2]));
  /*
   * 没有分类（lastErrorCode: null）时，§3.1 就是「把 lastError 原样交给界面」——
   * 而契约里 lastError 的语义正是"给玩家看的中文"，所以这里断言**逐字透传**，
   * 不是被我们再包一层。包一层的话玩家会看到"虚拟网络启动失败：安卓端网络内核没能启动…
   * 内核报错：内核在建立隧道时退出了"这种套娃。
   */
  check(
    '  · lastErrorCode 为 null 时，lastError 逐字透传（不再套一层我们的措辞）',
    events?.[1]?.state === 'error' && events?.[1]?.lastError === '内核在建立隧道时退出了',
    JSON.stringify(events?.[1]),
  );

  /* ------------------------------------------------ lastErrorCode → 分类文案 */

  r.log('lastErrorCode 分类 —— onRevoke 这类"不是内核坏了"的错要给准文案');

  const byCode = await ask1(`${PAGE_HELPERS}
    (async () => {
      const out = {};
      async function push(patch) {
        window.__seenStatus.length = 0;
        window.__mclinkFake.pushStatus(Object.assign({ running: false }, patch));
        await new Promise((resolve) => setTimeout(resolve, 60));
        const s = window.__seenStatus[window.__seenStatus.length - 1];
        return s ? s.lastError : null;
      }
      // onRevoke：被别的 VPN 抢占 → establish-failed
      out.establishFailed = await push({ lastError: '虚拟网络被其它应用抢占', lastErrorCode: 'establish-failed' });
      // 授权被撤销 → vpn-denied
      out.vpnDenied = await push({ lastError: '没有授予 VPN 权限', lastErrorCode: 'vpn-denied' });
      out.busy = await push({ lastError: '已有实例在跑', lastErrorCode: 'busy' });
      // 认不出来的 code：不许把它显示给玩家
      out.unknown = await push({ lastError: '原生那边给的一句中文', lastErrorCode: 'who-knows' });
      return out;
    })()
  `);
  const v = byCode && typeof byCode === 'object' ? byCode : {};
  check(
    '  · establish-failed → "另一个 VPN 应用"这类可行动文案（onRevoke 走这条）',
    /其它 VPN 应用/.test(v.establishFailed ?? '') && !/内核没能启动/.test(v.establishFailed ?? ''),
    String(v.establishFailed),
  );
  check(
    '  · vpn-denied → 授权说明，而不是"内核没能启动"',
    /授权 VPN/.test(v.vpnDenied ?? '') && !/内核没能启动/.test(v.vpnDenied ?? ''),
    String(v.vpnDenied),
  );
  check('  · busy → 先退出房间再重试', /已经有一个虚拟网络实例/.test(v.busy ?? ''), String(v.busy));
  check(
    '  · 认不出来的 code → 不显示 code 本身，退化成"原样交给界面"（§3.1）',
    v.unknown === '原生那边给的一句中文' && !/who-knows/.test(v.unknown ?? ''),
    String(v.unknown),
  );

  /* ------------------------------------------------ 桌面关键词不透传 */

  const desktopLeak = await ask1(`${PAGE_HELPERS}
    (async () => {
      window.__seenStatus.length = 0;
      window.__mclinkFake.pushStatus({ running: false, lastError: 'failed to create tun device: Permission denied (os error 13)', lastErrorCode: null });
      await new Promise((r) => setTimeout(r, 80));
      const s = window.__seenStatus[window.__seenStatus.length - 1];
      return { state: s ? s.state : null, lastError: s ? s.lastError : null };
    })()
  `);
  check(
    '原生报错里的 wintun/tun/permission/bind 不会透传给玩家（否则会被 store 改写成"请安装 wintun.dll / 以管理员重启"）',
    desktopLeak.state === 'error' &&
      typeof desktopLeak.lastError === 'string' &&
      !/wintun|utun|tun|adapter|permission|bind|10049|AddrNotAvailable/i.test(desktopLeak.lastError),
    JSON.stringify(desktopLeak),
  );
  check(
    '  · 但仍然给出一句能行动的安卓文案',
    /安卓端网络内核没能启动/.test(desktopLeak.lastError ?? ''),
    String(desktopLeak.lastError),
  );

  /* ------------------------------------------------ log 事件 → onLog */

  const logEvents = await ask1(`${PAGE_HELPERS}
    (async () => {
      window.__mclinkFake.pushLog('隧道已建立，tunFd=42');
      await new Promise((r) => setTimeout(r, 60));
      return window.__seenLog;
    })()
  `);
  check('log 事件推给了 onLog 订阅者', Array.isArray(logEvents) && logEvents.some((e) => /tunFd=42/.test(e.line)), JSON.stringify(logEvents));
  check('  · 事件的 ts 用的是原生给的 at（ISO）', await ask1(`window.__t.isIso(${JSON.stringify(logEvents?.[0]?.ts ?? '')})`), String(logEvents?.[0]?.ts));

  /* ------------------------------------------------ logs(limit) */

  const logs = await ask1(`${PAGE_HELPERS}
    window.__mclinkFake.clearCalls();
    window.__t.call('logs', async () => {
      const lines = await window.mclink.core.logs(10);
      const call = window.__mclinkFake.calls.find((c) => c.methodName === 'logs');
      return { lines: lines, limit: call ? call.options && call.options.limit : null };
    })
  `);
  check('core.logs() 不抛异常', logs.ok === true, logs.threw ?? '');
  if (logs.ok) {
    check('core.logs(10) 把 limit 传给了插件', logs.value.limit === 10, JSON.stringify(logs.value.limit));
    check(
      'core.logs() 映射成 CoreLogEntry[]（ts/stream/line）',
      Array.isArray(logs.value.lines) &&
        logs.value.lines.length === 2 &&
        logs.value.lines.every((l) => typeof l.line === 'string' && l.stream === 'info'),
      JSON.stringify(logs.value.lines),
    );
  }

  /* ------------------------------------------------ 插件报错 → 中文可行动文案 */

  /*
   * 每个 code 给一句玩家可行动的文案（§3 的 code 表）。
   *
   * `core-failed` 与 `internal` 是**特例**：§3 明说这两个要显示原生给的那句
   * （`getLastError()` 原文 / `message`），所以期望值就是 `原生侧附带的说明` 本身，
   * 不是我们再编一句 —— 这条断言正是用来钉住"别把原文吞掉"。
   */
  const codeCases = [
    ['vpn-denied', /授权 VPN/, 'vpn-denied'],
    ['no-routes', /房间网段/, 'no-routes'],
    ['establish-failed', /另一个 VPN 应用|其它 VPN 应用/, 'establish-failed'],
    ['busy', /已经有一个虚拟网络实例/, 'busy'],
    ['core-failed', /^原生侧附带的说明$/, 'core-failed'],
    ['internal', /^原生侧附带的说明$/, 'internal'],
  ];
  for (const [code, pattern, forbidden] of codeCases) {
    const res = await ask1(`${PAGE_HELPERS}
      window.__mclinkFake.failNextStart({
        ok: false,
        code: ${JSON.stringify(code)},
        message: '原生侧附带的说明',
        running: false, instanceName: null, tunFd: null, startedAt: null,
        lastError: '原生侧附带的说明', lastErrorCode: ${JSON.stringify(code)}, vpnAuthorized: false
      });
      window.__t.call('start', async () => {
        const status = await window.mclink.core.start({ configToml: ${JSON.stringify(REAL_TOML)}, instanceName: ${JSON.stringify(FIXTURE_INSTANCE)} });
        return status;
      })
    `);
    const st = res.ok ? res.value : null;
    check(
      `插件报 ${code} → state=error，且文案是中文可行动的（不含 code 本身）`,
      res.ok === true &&
        st?.state === 'error' &&
        pattern.test(st.lastError ?? '') &&
        !new RegExp(forbidden.replace(/-/g, '\\-')).test(st.lastError ?? ''),
      res.ok ? JSON.stringify(st) : res.threw,
    );
  }

  /*
   * 平铺形状的真实样子：失败结果里**只有 `lastErrorCode`**，没有显式的 `code`
   * （`code` 只有 start 失败那条路径才 put；statusChanged 与 status() 都没有它）。
   * 这条断言钉住"两个字段都认"，否则真机上这类错误会一律掉进 `internal`。
   */
  const codeFromStatusField = await ask1(`${PAGE_HELPERS}
    window.__mclinkFake.failNextStart({
      ok: false,
      running: false, instanceName: null, tunFd: null, startedAt: null,
      lastError: '没有授予 VPN 权限：加入虚拟局域网需要它', lastErrorCode: 'vpn-denied', vpnAuthorized: false
    });
    window.__t.call('start', async () => window.mclink.core.start({ configToml: ${JSON.stringify(REAL_TOML)}, instanceName: ${JSON.stringify(FIXTURE_INSTANCE)} }))
  `);
  check(
    '只有 lastErrorCode、没有 code 时也认分类（平铺形状下 statusChanged 的真实样子）',
    codeFromStatusField.ok === true && /授权 VPN/.test(codeFromStatusField.value?.lastError ?? ''),
    JSON.stringify(codeFromStatusField.value ?? codeFromStatusField.threw),
  );

  /* ------------------------------------------------ stop / status */

  const stopped = await ask1(`${PAGE_HELPERS}
    window.__mclinkFake.clearCalls();
    window.__t.call('stop', async () => window.mclink.core.stop())
  `);
  check('core.stop() 不抛异常', stopped.ok === true, stopped.threw ?? '');
  check('core.stop() 之后 state=stopped', stopped.ok && stopped.value.state === 'stopped', JSON.stringify(stopped.value));

  const statusRead = await ask1(`${PAGE_HELPERS}
    window.__mclinkFake.clearCalls();
    window.__t.call('status', async () => window.mclink.core.status())
  `);
  check('core.status() 反映插件当前状态（stopped）', statusRead.ok === true && statusRead.value.state === 'stopped', JSON.stringify(statusRead.value));

  /* ------------------------------------------------ 诚实失败的三条 */

  const unsupported = await ask1(`${PAGE_HELPERS}
    window.__t.call('unsupported', async () => ({
      acl: await window.mclink.core.applyAcl('[[acl]]'),
      peers: await window.mclink.core.peers(),
      cli: await window.mclink.core.cli(['--help']),
      resource: await window.mclink.core.resourceUsage(),
    }))
  `);
  check('applyAcl / peers / cli / resourceUsage 不抛异常', unsupported.ok === true, unsupported.threw ?? '');
  if (unsupported.ok) {
    const u = unsupported.value;
    for (const [key, method] of [['acl', 'applyAcl'], ['peers', 'peers'], ['cli', 'cli']]) {
      check(
        `core.${method}() 仍是诚实失败，且措辞写明"暂不支持…不是故障"`,
        u[key]?.ok === false && /暂不支持/.test(u[key]?.error ?? '') && /不是故障/.test(u[key]?.error ?? ''),
        JSON.stringify(u[key]),
      );
    }
    check('resourceUsage() 返回 null（没有子进程可测）', u.resource === null, JSON.stringify(u.resource));
  }

  /* ------------------------------------------------ 取消订阅真的生效 */

  const offWorks = await ask1(`${PAGE_HELPERS}
    (async () => {
      window.__seenStatus.length = 0;
      window.__offStatus();
      window.__mclinkFake.pushStatus({ running: true, startedAt: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 60));
      return window.__seenStatus.length;
    })()
  `);
  check('调用取消订阅之后不再收到状态', offWorks === 0, `实际收到 ${offWorks} 条`);
}

withPlugin.cdp.close();

/* =================================================== 第二段：没有插件（回归点） */

r.log('第二段 —— 桌面浏览器里没有 MclinkVpn 时，必须诚实降级');

const noPlugin = await openPage({ debugPort: 9342, inject: false });
const ask2 = noPlugin.evaluate;

if (!(await waitFor(noPlugin.evaluate, `window.mclink && window.mclink.core && window.mclink.core.start`))) {
  check('页面装上了 window.mclink.core（无插件场景）', false, '等了 15 秒还是没有');
} else {
  const probe = await ask2(`({
    hasInjectedBridge: typeof window.Capacitor !== 'undefined' && !!window.Capacitor.PluginHeaders,
    available: window.Capacitor ? window.Capacitor.isPluginAvailable('MclinkVpn') : null
  })`);
  check('这一页确实**没有** MclinkVpn（否则测的不是降级路径）', probe.available === false, JSON.stringify(probe));

  const res = await ask2(`${PAGE_HELPERS}
    window.__t.call('start', async () => window.mclink.core.start({
      configToml: ${JSON.stringify(REAL_TOML)},
      instanceName: ${JSON.stringify(FIXTURE_INSTANCE)},
    }))
  `);
  check('插件缺失时 core.start **不抛异常**（回归点：原来也不抛）', res.ok === true, res.threw ?? '');
  if (res.ok) {
    check('  · 返回 state=error（不假装 running）', res.value.state === 'error', JSON.stringify(res.value));
    check('  · 文案仍是那句"本机网络内核尚未接入"', /本机网络内核尚未接入/.test(res.value.lastError ?? ''), String(res.value.lastError));
    check('  · pid 仍为 null，没有假进程号', res.value.pid === null);
    check(
      '  · 文案里没有内部术语（里程碑 / 里程碑 1 / 里程碑 2）',
      !/里程碑/.test(res.value.lastError ?? ''),
      String(res.value.lastError),
    );
  }

  const st = await ask2(`${PAGE_HELPERS}
    window.__t.call('status', async () => window.mclink.core.status())
  `);
  check('插件缺失时 core.status() 同样返回 error + 那句话', st.ok === true && st.value.state === 'error' && /本机网络内核尚未接入/.test(st.value.lastError ?? ''), JSON.stringify(st.value));

  const sp = await ask2(`${PAGE_HELPERS}
    window.__t.call('stop', async () => window.mclink.core.stop())
  `);
  check('插件缺失时 core.stop() 不抛异常', sp.ok === true, sp.threw ?? '');

  const lg = await ask2(`${PAGE_HELPERS}
    window.__t.call('logs', async () => window.mclink.core.logs(50))
  `);
  check('插件缺失时 core.logs() 返回空数组而不是抛异常', lg.ok === true && Array.isArray(lg.value) && lg.value.length === 0, JSON.stringify(lg.value));
}

noPlugin.cdp.close();

/* =================================================== 收尾 */

console.log('');
r.log(r.failures === 0 ? '全部通过 ✓' : `${r.failures} 项未通过 ✗`);

server.close();
for (const child of children) {
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
}
await sleep(250);
for (const dir of [tmpOut, ...profileDirs]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上文件句柄可能还没释放，留给系统清 */
  }
}
process.exit(r.failures === 0 ? 0 : 1);
