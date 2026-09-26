/**
 * Android 端的 `window.mclink` 适配层。
 *
 * ## 为什么需要它
 *
 * `client/src` 里那些页面（登录、建房、房间页…）是 Electron 渲染层，它们通过 preload
 * 暴露的 `window.mclink`（接口定义见 `client/src/lib/bridge.ts` 的 `MclinkBridge`）
 * 拿本机能力：版本号、空闲端口、TCP 延迟探测、文件管理器、窗口控制，以及最重要的
 * **EasyTier 内核进程管理**（`core.*`）。
 *
 * Android 上这些都**不存在**。不装这一层，`bootstrap()` 第一句
 * `await window.mclink.info()` 就抛异常，整屏停在「正在初始化…」。
 *
 * ## 设计原则：同名、同形、能实现的真实现，实现不了的老实说
 *
 * 这个模块**不引入任何新接口** —— 它逐字实现 `MclinkBridge`。于是 `client/src` 一行不改，
 * 页面照样跑。做不到的那部分宁可返回一个诚实的结果（比如延迟探测全 null → 界面显示「—」），
 * 也不返回假数据：假延迟会让玩家照着一个不存在的"更快的节点"去建房。
 *
 * ## 与 Electron 的真实差异（这些差异是**能力差异**，不是偷懒）
 *
 * | 能力 | Electron | Android | 差异的后果 |
 * | --- | --- | --- | --- |
 * | `core.start/stop/status` | 真的拉起 easytier-core.exe | `registerPlugin('MclinkVpn')` 拉起 `VpnService`，**真联机** | 与桌面同一条链，只是内核在进程内而不是子进程 |
 * | `freePort()` | 真的 `listen(0)` 探测 | 由安装 ID 推导一个稳定端口 | 只是填给主控的记账值，本机不用它通信 |
 * | `tcping()` | 主进程真连 3 次 | 全部 `null` | 节点延迟显示「—」，**不参与排序** |
 * | `openPath`、`win.*`、`confirm`、提权 | 真实现 | no-op | 移动端外壳不渲染这些入口（没有死按钮） |
 *
 * `core` 这一族换成了真实现，**其余函数一行都不用动** ——
 * 这正是"照 MclinkBridge 实现"而不是"另设计一套移动端接口"的价值。
 *
 * ## 分层：本文件不算路由
 *
 * 从 TOML 到「地址 + 路由 + MTU」的推演全在 `./vpn-plan.ts`（纯函数、可单测），
 * 这里只做三件事：**算计划 → 调插件 → 把 `VpnStatus` 映射成 `CoreStatus`**。
 * 「算错就整机断网」的逻辑不该和"事件订阅、插件是否可用"这类外壳事务混在一起。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { AppInfo, CloseAction, MclinkBridge, ProbeTarget } from '../../../client/src/lib/bridge.ts';
import type { CliResult, CoreLogEntry, CoreStatus } from '../../../client/src/lib/core-types.ts';
import { plan as planVpn } from './vpn-plan.ts';

/* --------------------------------------------------------------- 编译期常量 */

/**
 * 版本号在构建时注入（见 vite.config.ts 的 define）。
 * 为什么不能像 Electron 那样运行时问：Android 那边要拿版本得经过 Capacitor 插件，
 * 而外壳底部那行版本号在**首帧**就要显示，不值得为它多开一条异步通道。
 */
declare const __MCLINK_APP_VERSION__: string;

const APP_VERSION: string = typeof __MCLINK_APP_VERSION__ === 'string' ? __MCLINK_APP_VERSION__ : '0.0.0';

/** 移动端在 bridge.ts 的 AppInfo 里没有新字段，所以平台信息只能塞进既有字段 */
const PLATFORM_LABEL = 'Android';

/* --------------------------------------------------------------- 安装标识 */

const INSTALL_ID_KEY = 'mclink.android.installId';
const DEVICE_NAME_KEY = 'mclink.device';

/**
 * 本机安装标识：32 位十六进制，首次运行生成后落 localStorage。
 *
 * 为什么需要它：Android 上拿不到「本机名称」这种自然标识，而主控侧的
 * `listenPort/rpcPort/listenIp` 需要一个**同一台设备每次启动都相同**的值 ——
 * 每次随机的话，同一个房间的记账值会飘，房主看到的成员信息也跟着变。
 */
function installId(): string {
  try {
    const cached = localStorage.getItem(INSTALL_ID_KEY);
    if (cached && /^[0-9a-f]{32}$/.test(cached)) return cached;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(INSTALL_ID_KEY, id);
    return id;
  } catch {
    // 隐私模式下 localStorage 可能不可写：退化成"每次启动一个新 ID"，
    // 比抛异常好 —— 抛异常会让 bootstrap() 整体失败，连登录都做不了。
    return 'ffffffffffffffffffffffffffffffff';
  }
}

/**
 * 交给主控的监听端口。
 *
 * Electron 上是真的 `listen(0)` 探一个空闲端口；Android 的 WebView **开不了监听 socket**，
 * 所以这里只保证：
 *   · 值稳定（同一设备每次一样，见 installId 的说明）；
 *   · 落在 20000–60000 的非常规段里（不撞常见的 11010/16000 段）；
 *   · 与 rpcPort 不同。
 * 它是**记账值**：主控会把它写进票据的 `listeners`，而安卓侧真正监听的是
 * EasyTier 内核自己（它按 TOML 里那个端口起），本函数不参与。
 * 要做成真探测，得再给 MclinkVpn 加一个原生方法（原生侧 bind(0) 是几行 Java）。
 */
function derivePort(salt: number): number {
  const id = installId();
  // 取 8 位十六进制 → 0..2^32-1，再映射到 20000..59999
  const slice = id.slice(salt, salt + 8);
  const n = Number.parseInt(slice, 16);
  return 20000 + (n % 40000);
}

/* --------------------------------------------------------------- VPN 插件 */

/**
 * 插件契约，逐字照 `docs/android-vpn.md` §3 写。
 *
 * 为什么在 TS 侧**再写一遍**而不是从 Kotlin 那边生成：那边是 Kotlin，没有共享的
 * 类型定义可引。契约的唯一权威是那份文档，这里只要和它对齐；
 * 真写错了，接线测试（`android/scripts/verify-vpn-bridge.mjs`）会在假插件上暴露出来。
 */
export interface VpnStatus {
  running: boolean;
  instanceName: string | null;
  tunFd: number | null;
  /** ISO 字符串 */
  startedAt: string | null;
  /** 给玩家看的中文；null = 没有错误 */
  lastError: string | null;
  /** 错误分类，与 VpnErrorCode 同一套取值；null = 没有错误（或原生侧没给分类） */
  lastErrorCode: VpnErrorCode | null;
  /** `VpnService.prepare()` 返回 null 时为 true */
  vpnAuthorized: boolean;
}

/** §3 的错误码表。**不直接显示给玩家**，由 playerMessage() 翻成可行动的文案 */
export type VpnErrorCode = 'vpn-denied' | 'no-routes' | 'establish-failed' | 'core-failed' | 'busy' | 'internal';

/** 与 `vpn-plan.ts` 的 `VpnCidr` 同形（那边是纯函数模块，这里独立声明以免耦合） */
interface VpnCidrPayload {
  ip: string;
  prefix: number;
}

interface VpnStartPayload {
  instanceName: string;
  configToml: string;
  address: VpnCidrPayload;
  /** 空数组 = 拒绝启动（§4 第 1 条） */
  routes: VpnCidrPayload[];
  mtu: number;
}

interface VpnStartResult {
  ok: boolean;
  code?: VpnErrorCode;
  message?: string;
  /**
   * §3 的形状：状态嵌在 `status` 里。**不是唯一形状**，见 pickVpnStatus()
   * （新契约以平铺为准，这一条留着只是为了不让旧写法炸掉）。
   */
  status?: VpnStatus;
  /** 平铺形状（Kotlin 的实际返回）会把这些字段放在这一层 */
  running?: boolean;
  lastError?: string | null;
  lastErrorCode?: VpnErrorCode | null;
  [key: string]: unknown;
}

interface VpnEventLogPayload {
  line: string;
  at: string;
}

/**
 * `@capacitor/core` 的 `registerPlugin` 在**没有原生实现**时给的是一个会抛异常的代理：
 * 调 `start()` 会抛 `CapacitorException: "MclinkVpn" plugin is not implemented on web`。
 * 所以每次调用前都要先问 `Capacitor.isPluginAvailable()` —— 见 `vpnPlugin()`。
 */
interface MclinkVpnPlugin {
  start(payload: VpnStartPayload): Promise<VpnStartResult>;
  /** 同样是 §3 的 `{ ok, status }` 与 Kotlin 的平铺形状都可能有，见 pickVpnStatus() */
  stop(): Promise<VpnStartResult>;
  /** `status()` 的原样返回（§3 定义的 VpnStatus）；`start`/`stop` 的返回见 pickVpnStatus */
  status(): Promise<VpnStatus>;
  logs(options: { limit?: number }): Promise<{ lines: string[] }>;
  addListener(eventName: 'statusChanged', handler: (status: VpnStatus) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'log', handler: (payload: VpnEventLogPayload) => void): Promise<{ remove: () => Promise<void> }>;
}

/** 注册一次即可；重复注册 Capacitor 会警告并返回同一个代理 */
const MclinkVpn = registerPlugin<MclinkVpnPlugin>('MclinkVpn');

/**
 * 取插件，**拿不到就返回 null**（不抛异常、不假装有）。
 *
 * 什么时候会拿不到：桌面浏览器里跑这份产物（冒烟测试就是这么跑的），
 * 或者原生侧的插件没被打进包（`capacitor.plugins.json` 里少了它）。
 * 两种情况下 `core.start` 都必须回落成"本机网络内核尚未接入"的诚实失败 ——
 * 这是回归点，`android/scripts/verify-vpn-bridge.mjs` 里有一条专门钉它的断言。
 */
function vpnPlugin(): MclinkVpnPlugin | null {
  try {
    return Capacitor.isPluginAvailable('MclinkVpn') ? MclinkVpn : null;
  } catch {
    return null;
  }
}

/**
 * 从 `start()` / `stop()` 的返回值里取出 `VpnStatus`。
 *
 * **契约以平铺为准**（§3）：`start()` / `stop()` 返回的就是 `VpnStatus` 的字段，
 * 外加 `ok` / `code?` / `message?`，**没有**嵌套的 `status` 对象 —— 这是实现决定的
 * （Java 侧 `statusToJs(snapshot)` 之后再 `put("ok", …)`），契约里已经写明并标注了那个
 * 失效模式：按嵌套去读的话 `result.status` 是 `undefined` → 映射成 `stopped` →
 * 隧道明明起来了，房间页却永远显示「正在建立连接…」，而且不报任何错。
 *
 * 之所以仍然**两种形状都认**：这里的输入来自另一门语言的桥，而"多认一种形状"的成本是
 * 一个 `typeof` 判断，收益是哪怕有人把 Java 侧改回嵌套（或者哪个中间层包了一层），
 * 也不会退化成上面那个静默失败。平铺形状用 `running` 这个必填布尔位当判据。
 *
 * 两种形状都被 `android/scripts/verify-vpn-bridge.mjs` 断言过。
 */
function pickVpnStatus(raw: unknown): VpnStatus | null {
  if (raw === null || typeof raw !== 'object') return null;
  const nested = (raw as { status?: unknown }).status;
  if (nested !== null && nested !== undefined && typeof nested === 'object') return nested as VpnStatus;
  if (typeof (raw as { running?: unknown }).running === 'boolean') return raw as VpnStatus;
  return null;
}

/* --------------------------------------------------------------- 状态与文案 */

/**
 * 插件不可用时的那句老实话。
 *
 * 「本机网络内核尚未接入」这半句一字未改 —— 它是回归点（曾长期是这个平台的
 * 唯一行为）。改掉的只有括号里的「（Android 里程碑 1）」：那是内部术语，
 * 而它现在只会出现在**原生插件缺失**这种异常情形里，玩家看到"里程碑"三个字
 * 只会更困惑。
 */
const CORE_UNAVAILABLE_MESSAGE =
  '本机网络内核尚未接入。房间与加入码已经可用，' +
  '但本机还没真正加入虚拟局域网 —— 换台已装客户端的电脑用同样的加入码就能联机。';

/** 安卓端确实做不到、但**不是故障**的那几件事（§3 末尾 / §6） */
const UNSUPPORTED = {
  acl: '安卓端暂不支持在手机上应用房主规则（踢人 / 限速）；联机本身不受影响，这不是故障。',
  peers: '安卓端暂不支持读取节点列表（不是故障）—— 房间能正常联机，这只是桌面端诊断面板里的数据。',
  cli: '安卓端暂不支持命令行诊断（不是故障）—— 房间能正常联机，这是桌面客户端的排查入口。',
} as const;

/**
 * 插件调用本身抛异常时给玩家看的那句。
 *
 * 为什么不直接把异常原文交给 `playerMessage('internal', …)`：那边的原文是 **JS 异常**
 * （`Error: …` 或者桥断了的英文堆栈），不是内核报错 —— 把一段英文堆栈糊到玩家脸上，
 * 比说"服务没有响应"更没用。原文进日志流（`core.logs`），需要排查时看得到。
 */
const PLUGIN_UNREACHABLE_MESSAGE =
  '安卓端的联机服务没有响应。请退出房间后重新加入；如果一直这样，请把这个问题反馈给我们。';

/**
 * **不该被扩大的**一处防御：会被 `client/src/lib/store.ts` 的 `describeCoreError()`
 * 认成「桌面端症状」的英文词。
 *
 * 那个函数是桌面端共用的（本轮不改），它按这些正则把整条 lastError 重写成
 * 「请确认已安装 wintun.dll 并以管理员运行」「请使用『以管理员身份重启』」之类。
 * Android 上既没有 wintun.dll 也没有那个按钮 —— 原文一旦命中，玩家会拿到一条
 * **做不到**的建议，比不给建议更糟。EasyTier 的典型报错（tun device /
 * Permission denied / bind）恰好命中前几条。
 *
 * ⚠️ 这个判断的**归属地是 `describeCoreError`**（它该按平台分支，Android 上不再做这种改写），
 * 契约主人已经认领。这里保留它只是因为那个分支还没落地；**不要再往这个正则里加东西** ——
 * 每加一个词都是在把"平台该管的事"塞进一个移动端模块。
 */
const DESKTOP_REWRITE_TRIGGER =
  /端口被占用|10048|10013|EADDRINUSE|10049|AddrNotAvailable|bind|Access is denied|permission|拒绝访问|not permitted|Operation not permitted|wintun|utun|tun|adapter/i;

/**
 * 原生侧给的原文能不能安全地透传给玩家。
 *
 * §3 希望 `core-failed` 显示 `getLastError()` 的原文；这条规则与
 * `describeCoreError()` 的正则相冲突（见上面的说明）。这里的取舍是：
 * **能安全透传就透传，会命中桌面关键词就不拼进 lastError**，
 * 但仍把它写进日志流（`core.logs` 的记录不会被改写），信息不丢。
 */
function safeNativeDetail(detail: string | null | undefined): string | null {
  const text = typeof detail === 'string' ? detail.trim() : '';
  if (text === '') return null;
  return DESKTOP_REWRITE_TRIGGER.test(text) ? null : text;
}

/**
 * §3 的 code 表 → 玩家可行动的文案。
 *
 * 几条硬性约束（都不是风格问题）：
 *   · **不出现 code 本身**（`vpn-denied` 这种字符串对玩家没有意义）；
 *   · **不命中 `DESKTOP_REWRITE_TRIGGER`**，否则会被 store 改写成 Windows 专属建议；
 *   · **不以「启动失败」开头** —— store 会统一加「虚拟网络启动失败：」前缀。
 *
 * `core-failed` 与 `internal` 按 §3 的原话就是**显示原生给的那句**（`getLastError()` 原文 / `message`），
 * 所以这里能安全透传就直接用原文，只有当原文会被桌面端改写成做不到的建议时才换成我们自己的措辞。
 */
function playerMessage(code: VpnErrorCode, detail?: string | null): string {
  const safe = safeNativeDetail(detail);
  switch (code) {
    case 'vpn-denied':
      return '授权 VPN 是加入虚拟局域网的前提。请重新点『连接』，并在系统弹出的对话框里选『确定』。';
    case 'no-routes':
      return (
        '没能从房间票据里读出房间网段，已放弃启动 —— 这是为了避免把手机的流量全部接管。' +
        '请退出房间后重新加入；如果一直这样，请把这个问题反馈给我们。'
      );
    case 'establish-failed':
      return '系统没能建立虚拟网络通道，通常是手机上另一个 VPN 应用正占着它。请先断开其它 VPN 应用，再回到房间页重试。';
    case 'busy':
      return '本机已经有一个虚拟网络实例在跑。请先退出房间，再重新加入。';
    case 'core-failed':
      return (
        safe ??
        '安卓端网络内核没能启动（多为系统策略限制，或与其它 VPN 应用冲突）。' +
          '请先断开手机上其它 VPN 应用，再回到房间页重试。'
      );
    case 'internal':
    default:
      return (
        safe ??
        '安卓端网络内核报告了一个错误，但没有给出更多信息。请退出房间后重新加入；如果一直这样，请反馈给我们。'
      );
  }
}

/** 所有 `CoreStatus` 上在 Android 上恒为「没有」的那几项（§3.1 的最后一段） */
const NO_PROCESS_FIELDS = {
  /**
   * 没有子进程，所以 pid 恒为 null —— 这是**事实**，不是占位值。
   * 界面上的「进程 PID」会显示 '-'，比编一个数字诚实。
   */
  pid: null,
  configFile: null,
  args: [] as string[],
  rpcPortal: null,
  elevated: false,
  coreBin: '',
  coreBinExists: false,
  cliBinExists: false,
} as const;

function errorStatus(message: string): CoreStatus {
  return { ...NO_PROCESS_FIELDS, state: 'error', startedAt: null, lastError: message };
}

/**
 * 收窄成已知的 `VpnErrorCode`，认不出来返回 `null`。
 *
 * 为什么要有这一步（而不是 `result.code as VpnErrorCode`）：这个值是从**另一门语言**的
 * 桥那边过来的，`switch` 里没有 `default` 就会静默走进"其它"分支；更糟的是如果哪天
 * 原生侧加了一个新 code 而 TS 侧还没跟上，我们宁愿回落成 `core-failed` 的通用文案，
 * 也不要把一个内部字符串显示给玩家。
 */
function asVpnErrorCode(value: unknown): VpnErrorCode | null {
  switch (value) {
    case 'vpn-denied':
    case 'no-routes':
    case 'establish-failed':
    case 'core-failed':
    case 'busy':
    case 'internal':
      return value;
    default:
      return null;
  }
}

/**
 * `running: false` 且 `lastError` 非空时，给玩家看的那句话。
 *
 * 两条路（§3 的 code 表 + §3.1 的映射表）：
 *   · **原生给了分类**（`lastErrorCode`）→ 用 code 表里那句可行动的文案，
 *     这样 `onRevoke`（被别的 VPN 抢占）会得到"先断开其它 VPN 应用"，
 *     而不是一律走 `core-failed` 的"内核没能启动"——后者会让玩家去查一个根本没坏的东西；
 *   · **没给分类** → 原生侧的 `lastError` 按契约就是"给玩家看的中文"，原样透传
 *     （仍过一遍桌面改写关键词的守卫）。
 */
function describeVpnFailure(vpn: VpnStatus | null | undefined): string {
  const raw = typeof vpn?.lastError === 'string' ? vpn.lastError.trim() : '';
  const code = asVpnErrorCode(vpn?.lastErrorCode);
  if (code !== null) return playerMessage(code, raw);
  const safe = safeNativeDetail(raw);
  return safe !== null ? safe : playerMessage('core-failed', raw);
}

/**
 * `VpnStatus` → `CoreStatus`（§3.1 的映射表，逐行照做）。
 *
 * 这里**不做**任何"顺带修一下"的判断：`running` 就是 running，
 * `lastError` 非空就是 error，两者都没有就是 stopped。
 */
function toCoreStatus(vpn: VpnStatus | null | undefined): CoreStatus {
  const running = vpn?.running === true;
  const rawError = typeof vpn?.lastError === 'string' ? vpn.lastError.trim() : '';
  const startedAt = typeof vpn?.startedAt === 'string' && vpn.startedAt !== '' ? vpn.startedAt : null;

  if (running) {
    return { ...NO_PROCESS_FIELDS, state: 'running', startedAt, lastError: null };
  }
  if (rawError !== '') {
    return { ...NO_PROCESS_FIELDS, state: 'error', startedAt: null, lastError: describeVpnFailure(vpn) };
  }
  return { ...NO_PROCESS_FIELDS, state: 'stopped', startedAt: null, lastError: null };
}

/**
 * 插件缺失时的状态。
 *
 * `state` 取 `'error'` 而不是 `'stopped'` 是**刻意的**：
 *   · `'stopped'` 会让房间页一直显示「正在建立连接…」——那是一句假话，玩家会一直等；
 *   · `'error'` 会把 `lastError` 显示出来（store 里 `describeCoreError` 包一层），
 *     玩家立刻知道"这台设备暂时不能当联机节点"，而不是干等。
 * `lastError` 的措辞避开了 `describeCoreError` 里所有正则分支（端口/bind/权限/wintun），
 * 否则会被改写成一句 Windows 专属的建议（例如"请安装 wintun.dll"），在手机上纯属误导
 * —— 这条约束同样适用于上面 `playerMessage()` 的每一条文案。
 */
function unavailableStatus(): CoreStatus {
  return {
    state: 'error',
    pid: null,
    startedAt: null,
    lastError: CORE_UNAVAILABLE_MESSAGE,
    configFile: null,
    args: [],
    rpcPortal: null,
    elevated: false,
    coreBin: '',
    coreBinExists: false,
    cliBinExists: false,
  };
}

/* --------------------------------------------------------------- 实现 */

function deviceName(): string {
  try {
    return localStorage.getItem(DEVICE_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

async function info(): Promise<AppInfo> {
  /**
   * `hostname` 在 Android 上只能用设备名兜底（本来是想让 store 拼出
   * 「<设备名>-PC」的默认本机名称）。不过那个 `-PC` 后缀在手机上很怪，
   * 已经在 installMobileBridge() 里用 seedDeviceName() 抢先把名字写好了 ——
   * 所以这个字段现在只在"localStorage 写不进去"的极端情况下才会被用到。
   */
  return {
    version: APP_VERSION,
    platform: PLATFORM_LABEL,
    arch: 'arm64',
    // 下面这些目录在 Android 上没有对应概念。填空串而不是编一个路径：
    // 一旦界面上出现"打开日志目录"，空串会让它什么也不做，而不是打开一个不存在的地方。
    userData: '',
    dataDir: '',
    logDir: '',
    vendorDir: '',
    coreBin: '',
    cliBin: '',
    // Android 没有 UAC。恒为 false，移动端外壳因此不渲染「提权横幅」。
    elevated: false,
    elevationReason: null,
    autoElevate: false,
    closeAction: 'quit',
    softwareRendering: false,
    hostname: deviceName() || 'Android 手机',
  };
}

/**
 * 首次运行时先替玩家把「本机名称」填好。
 *
 * 为什么必须在这里做：`store.bootstrap()` 里那段默认值是这样写的 ——
 * ```ts
 * if (!state.deviceName) state.deviceName = `${info.hostname || '玩家'}-PC`;
 * ```
 * 那个 `-PC` 后缀是桌面时代的产物。手机上不管 hostname 填什么，玩家看到的都会是
 * 「Android 手机-PC」（实测截图里就是这样），一眼就知道这个包是拿桌面端改的。
 *
 * 改 store.ts 是最直接的做法，但那是一行**桌面端共用的逻辑**，为一个平台的后缀动它不值当。
 * 而 bootstrap() 只在 `!state.deviceName` 时才填默认值 —— 所以只要在它之前把
 * localStorage 里的设备名写好，那段默认值就永远不会执行。
 * 时机是对的：本函数由 install-bridge.ts 调用，而那个模块是整个依赖图的第一个
 * （store.ts 求值更晚，它读到的是我们已经写好的值）。
 */
function seedDeviceName(): void {
  try {
    if ((localStorage.getItem(DEVICE_NAME_KEY) ?? '').trim().length > 0) return;
    localStorage.setItem(DEVICE_NAME_KEY, '我的手机');
  } catch {
    /* 隐私模式下写不进去：那就退回 store 的默认命名，难看但能用 */
  }
}

/**
 * 把所有 Electron 专属能力装到 window 上。
 *
 * **必须在任何 `client/src` 模块被求值之前调用**：`store.bootstrap()` 第一句就是
 * `await window.mclink.info()`，晚一步就是 "Cannot read properties of undefined"。
 * 所以 main.ts 里它是第一个 import 副作用（见该文件的 import 顺序说明）。
 */
export function installMobileBridge(): void {
  seedDeviceName();

  const coreStatusListeners = new Set<(status: CoreStatus) => void>();
  const coreLogListeners = new Set<(entry: CoreLogEntry) => void>();

  /* ------------------------------------------------- 本机监听者的扇出 */

  /**
   * 事件是**扇出**的：插件的 `statusChanged` / `log` 只订阅**一次**，
   * 由这两个函数分发给所有本机监听者。
   *
   * 为什么不是"每个 onStatus 各订阅一次插件"：`MclinkBridge.onStatus` 的签名是
   * **同步**返回取消订阅函数，而 Capacitor 的 `addListener` 是异步的（返回 Promise）。
   * 每个监听者各订阅一次的话，就得在"还没订阅上就被取消"这条路径上做竞态处理；
   * 而扇出只有一个订阅点，`store.bootstrap()` 里那两个订阅就是普通的 Set 增删。
   *
   * 代价是订阅在整个应用生命周期里挂着（插件是单例服务，这本来也无所谓）。
   */
  function emitStatus(status: CoreStatus): CoreStatus {
    for (const fn of coreStatusListeners) fn(status);
    return status;
  }

  function emitLog(entry: CoreLogEntry): void {
    for (const fn of coreLogListeners) fn(entry);
  }

  let statusSubscribed = false;
  let logSubscribed = false;

  /**
   * 惰性订阅插件事件。**订阅失败不让任何调用方失败** ——
   * 拿不到状态推送的后果是"界面不自动刷新"，绝不应该是"点连接就报错"。
   */
  async function ensureVpnEventSubscriptions(): Promise<void> {
    const plugin = vpnPlugin();
    if (plugin === null) return;

    if (!statusSubscribed) {
      statusSubscribed = true; // 先置位：并发调用下重复订阅会变成"每条状态推两遍"
      try {
        await plugin.addListener('statusChanged', (status) => {
          emitStatus(toCoreStatus(status));
        });
      } catch {
        statusSubscribed = false; // 没订上就允许下次再试
      }
    }

    if (!logSubscribed) {
      logSubscribed = true;
      try {
        await plugin.addListener('log', (payload) => {
          const at = typeof payload?.at === 'string' && payload.at !== '' ? payload.at : new Date().toISOString();
          emitLog({ ts: at, stream: 'info', line: String(payload?.line ?? '') });
        });
      } catch {
        logSubscribed = false;
      }
    }
  }

  const bridge: MclinkBridge = {
    /**
     * 平台标识，**同步可读**。
     *
     * 这个字段是桌面端为 macOS 加上的（`client/src/lib/platform.ts` 用它决定提权措辞、
     * 托盘叫什么、窗口按钮画不画）。Android 必须**如实报 `'android'`**，不能图省事报
     * `'win32'`：platform.ts 里 `needsAdmin = isMac || isWindows`，
     * 报 win32 会让它认为"这个平台需要管理员权限"，于是移动端会冒出提权相关的文案与入口 ——
     * 而 Android 上根本没有"以管理员身份运行"这回事。
     *
     * 它在 import 期就被读走（platform.ts 顶层 `globalThis.window?.mclink?.platform`），
     * 所以 install-bridge.ts 必须排在最前面 —— 那份文件里有详细说明。
     */
    platform: 'android',

    info,

    freePort: async () => derivePort(0),

    /**
     * TCP 延迟探测：Android 的 WebView 里**没法开裸 TCP 连接**（fetch 只走 HTTP(S)，
     * WebSocket 也不是"连上就断"的探测语义）。返回全 null 是契约允许的值
     * （见 bridge.ts：`3 次都没连上是 null`），界面会显示「—」，
     * 而 CreateJoin 用它只做**排序偏好**，不会因为全 null 就选不了节点。
     *
     * 想真做要给 MclinkVpn 再加一个原生方法（原生侧开 Socket 是几行 Java）。
     * 现在不做的理由：一个恒为「—」的列，比一个假数字诚实。
     */
    tcping: async (targets: ProbeTarget[]): Promise<Record<string, number | null>> => {
      const out: Record<string, number | null> = {};
      for (const t of targets) out[`${t.host}:${t.port}`] = null;
      return out;
    },

    // Electron 专属：移动端外壳不渲染这些入口，实现成 no-op 而不是抛异常，
    // 因为 client/src 的页面可能在任何路径上顺手调到它们（例如设置页的 onMounted）。
    openPath: async () => 'android:unsupported',
    openExternal: async (url: string) => {
      // 这一个**要真做**：房间页的「更新 / 帮助」会外链。
      // Capacitor 装了 App 插件时用系统浏览器；没装就退化成同 WebView 内打开，
      // 至少不是"点了没反应"。
      window.open(url, '_blank', 'noopener');
    },
    relaunchElevated: async () => ({ ok: false, error: 'Android 端无需提权' }),
    setAutoElevate: async () => ({ ok: false, autoElevate: false }),
    setCloseAction: async (_value: CloseAction) => ({ ok: true, closeAction: 'quit' }),
    onAskClose: () => () => {},
    /**
     * macOS 菜单栏命令（桌面端只有 'settings'，对应 ⌘,）。
     * Android 没有原生菜单栏；这里返回一个空订阅而不是抛异常 ——
     * `client/src/lib/platform.ts` 与桌面外壳会在挂载时订阅它，
     * 抛异常会让整个挂载失败（首屏白屏），代价远大于收益。
     */
    onMenuCommand: () => () => {},
    closeAskOpened: async () => ({ ok: true }),
    closeDecision: async () => ({ ok: true }),

    /**
     * 应用内确认框：Electron 上走主进程原生对话框，这里退化成浏览器 confirm()。
     *
     * 为什么不用 client/src 的 ConfirmDialog（那才是「暖纸台」自己的弹层）：
     * App 外壳那层弹层由 App.vue 挂载，而移动端外壳（MobileApp.vue）**没有挂它**。
     * 会触发确认的动作（退出房间 / 关闭房间）本来就保留着，
     * 用一个系统 confirm 能保证它们不会变成"点了没反应"。
     */
    confirm: async (payload) => window.confirm([payload.title, payload.message, payload.detail].filter(Boolean).join('\n\n')),

    // 窗口控制：Android 是全屏 Activity，没有最小化/最大化。
    // 移动端外壳不渲染 TitleBar，所以这些永远不会被调到。
    win: {
      minimize: async () => null,
      toggleMaximize: async () => null,
      isMaximized: async () => false,
      close: async () => null,
      hide: async () => null,
      onMaximized: () => () => {},
    },

    core: {
      /**
       * 启动本机虚拟网络：**算计划 → 调插件 → 映射状态**。
       *
       * 三段顺序不能换，尤其第一段必须在调插件之前 —— 路由算不出来时**一个字节都不该
       * 发给原生侧**。§4 第 1 条：拿不到网段就返回 `no-routes` 并退出，
       * 宁可连不上，不可整机断网。
       */
      start: async (payload): Promise<CoreStatus> => {
        const configToml = typeof payload?.configToml === 'string' ? payload.configToml : '';
        const instanceName = typeof payload?.instanceName === 'string' ? payload.instanceName : '';

        const planned = planVpn({ configToml, instanceName });
        if (!planned.ok) {
          // 诊断信息进日志流（玩家看不到 code，但排查时它得在）
          emitLog({
            ts: new Date().toISOString(),
            stream: 'stderr',
            line: `虚拟网络未启动：${planned.message}`,
          });
          return emitStatus(errorStatus(playerMessage(planned.code)));
        }

        const plugin = vpnPlugin();
        if (plugin === null) {
          // **诚实降级**：桌面浏览器里没有 MclinkVpn，不许抛异常、不许假装 running。
          return emitStatus(unavailableStatus());
        }

        void ensureVpnEventSubscriptions();

        let result: VpnStartResult;
        try {
          result = await plugin.start({
            // TOML 里的 instance_name 是内核真正注册的名字（见 vpn-plan.ts 的说明）
            instanceName: planned.plan.instanceName,
            configToml,
            address: planned.plan.address,
            routes: planned.plan.routes,
            mtu: planned.plan.mtu,
          });
        } catch (err) {
          /*
           * 插件调用本身抛异常（桥断了、原生侧崩了）必须在这里兜住：
           * 让它冒到 store.startNetwork 就是一个未捕获的 Promise 拒绝 ——
           * 房间页会永远停在「正在建立连接…」，而手机上没有 devtools 可看。
           */
          emitLog({ ts: new Date().toISOString(), stream: 'stderr', line: `调用原生插件失败：${String(err)}` });
          return emitStatus(errorStatus(PLUGIN_UNREACHABLE_MESSAGE));
        }

        if (result?.ok !== true) {
          /*
           * `ok: false` 表示**这次启动没有成功**，所以状态必须是 error，
           * 哪怕插件同时报了 `running: true`（那是上一个没停干净的实例，§3 的 `busy`）：
           * 那种情况下显示「已联机」是对**这个房间**的谎话。
           *
           * 分类优先取显式的 `code`；平铺形状下 `lastErrorCode` 是同一个东西的另一种写法
           * （`statusToJs()` 总会带上它），两个都认；都认不出来就走 `internal`。
           * 附带说明用 `message`，没有就退回 `lastError` —— §3 里它的语义是"给玩家看的中文"。
           */
          const code = asVpnErrorCode(result?.code) ?? asVpnErrorCode(result?.lastErrorCode) ?? 'internal';
          const detail = typeof result?.message === 'string' && result.message.trim() !== ''
            ? result.message
            : typeof result?.lastError === 'string'
              ? result.lastError
              : null;
          return emitStatus(errorStatus(playerMessage(code, detail)));
        }

        return emitStatus(toCoreStatus(pickVpnStatus(result)));
      },

      stop: async (): Promise<CoreStatus> => {
        const plugin = vpnPlugin();
        if (plugin === null) return emitStatus(unavailableStatus());
        try {
          const result = await plugin.stop();
          return emitStatus(toCoreStatus(pickVpnStatus(result)));
        } catch (err) {
          emitLog({ ts: new Date().toISOString(), stream: 'stderr', line: `调用原生插件失败：${String(err)}` });
          return emitStatus(errorStatus(PLUGIN_UNREACHABLE_MESSAGE));
        }
      },

      /**
       * 只读查询，**不推事件**（与桌面端一致）：它由 `bootstrap()` 在订阅者存在之前调用，
       * 推一遍没有任何人听；真正的状态变化由插件的 `statusChanged` 事件负责。
       */
      status: async (): Promise<CoreStatus> => {
        const plugin = vpnPlugin();
        if (plugin === null) return unavailableStatus();
        try {
          return toCoreStatus(await plugin.status());
        } catch {
          return errorStatus(PLUGIN_UNREACHABLE_MESSAGE);
        }
      },

      /**
       * 插件的历史日志只有行文本、**没有逐行时间戳**（§3 的 `logs()` 返回 `{ lines: string[] }`）。
       * 所以这里统一盖上调取时刻：这是本模块唯一一处"近似值"，它只影响日志面板左边那
       * 12 个字符，不影响任何网络行为。实时行走 `log` 事件，那边有原生给的 `at`。
       */
      logs: async (limit?: number): Promise<CoreLogEntry[]> => {
        const plugin = vpnPlugin();
        if (plugin === null) return [];
        try {
          const wanted = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 300;
          const result = await plugin.logs({ limit: wanted });
          const lines = Array.isArray(result?.lines) ? result.lines : [];
          const ts = new Date().toISOString();
          return lines.map((line) => ({ ts, stream: 'info' as const, line: String(line) }));
        } catch {
          // 读日志失败不该影响任何别的事情：返回空数组，界面显示"暂无日志"
          return [];
        }
      },

      /**
       * 资源占用：内核在本进程里，没有"某个子进程的 WorkingSet"可报。
       * 返回 null 是契约允许的（`resourceUsage(): Promise<… | null>`），界面显示「—」。
       */
      resourceUsage: async () => null,

      /**
       * 下面三条是 §3 末尾的**诚实失败**，不是"还没接"：
       * Android 侧的 JNI 路径里没有应用 ACL 的入口（§6），peer 列表要走 `callJsonRpc`（本轮不做）。
       * 措辞刻意写成「暂不支持…不是故障」—— 否则玩家会以为自己的网络坏了，
       * 而事实是房间能正常联机。
       */
      applyAcl: async () => ({ ok: false, error: UNSUPPORTED.acl }),
      /** peers 为空 = 没有节点可显示，连接诊断面板据此显示"无数据"而不是假的节点列表 */
      peers: async (): Promise<CliResult> => ({ ok: false, error: UNSUPPORTED.peers }),
      cli: async (): Promise<CliResult> => ({ ok: false, error: UNSUPPORTED.cli }),

      onStatus: (handler) => {
        coreStatusListeners.add(handler);
        void ensureVpnEventSubscriptions();
        return () => coreStatusListeners.delete(handler);
      },
      onLog: (handler) => {
        coreLogListeners.add(handler);
        void ensureVpnEventSubscriptions();
        return () => coreLogListeners.delete(handler);
      },
    },
  };

  window.mclink = bridge;
}
