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
 * | 能力 | Electron | Android（本里程碑） | 差异的后果 |
 * | --- | --- | --- | --- |
 * | `core.start/stop/status` | 真的拉起 easytier-core.exe | 空实现，返回 `error` + 说明 | 房间建得出来、地址看得到，但本机**没进**虚拟局域网 |
 * | `freePort()` | 真的 `listen(0)` 探测 | 由安装 ID 推导一个稳定端口 | 只是填给主控的记账值，MI1 不用它通信 |
 * | `tcping()` | 主进程真连 3 次 | 全部 `null` | 节点延迟显示「—」，**不参与排序** |
 * | `openPath`、`win.*`、`confirm`、提权 | 真实现 | no-op | 移动端外壳不渲染这些入口（没有死按钮） |
 *
 * ## 里程碑 2 的接入点
 *
 * 真正要换掉的只有 `core` 这一族：用一个 Capacitor 插件把 `VpnService` +
 * EasyTier 的 `.so`（方案见 `docs/android-milestone2-easytier.md`）包起来，
 * 让 `core.start/stop/onStatus/onLog` 变成真实现。**其余函数一行都不用动** ——
 * 这正是"照 MclinkBridge 实现"而不是"另设计一套移动端接口"的价值。
 */
import type { AppInfo, CloseAction, MclinkBridge, ProbeTarget } from '../../../client/src/lib/bridge.ts';
import type { CliResult, CoreLogEntry, CoreStatus } from '../../../client/src/lib/core-types.ts';

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
 * 而里程碑 1 也没有隧道要监听，所以这里只保证：
 *   · 值稳定（同一设备每次一样，见 installId 的说明）；
 *   · 落在 20000–60000 的非常规段里（不撞常见的 11010/16000 段）；
 *   · 与 rpcPort 不同。
 * 它是**记账值**：主控会把它写进票据的 configToml，MI1 不启动内核所以没人用它通信。
 * 里程碑 2 换成 Capacitor 插件从原生侧真探端口后，这个函数就该删掉。
 */
function derivePort(salt: number): number {
  const id = installId();
  // 取 8 位十六进制 → 0..2^32-1，再映射到 20000..59999
  const slice = id.slice(salt, salt + 8);
  const n = Number.parseInt(slice, 16);
  return 20000 + (n % 40000);
}

/* --------------------------------------------------------------- 内核空实现 */

const CORE_UNAVAILABLE_MESSAGE =
  '本机网络内核尚未接入（Android 里程碑 1）。房间与加入码已经可用，' +
  '但本机还没真正加入虚拟局域网 —— 换台已装客户端的电脑用同样的加入码就能联机。';

/**
 * 空的内核状态。
 *
 * `state` 取 `'error'` 而不是 `'stopped'` 是**刻意的**：
 *   · `'stopped'` 会让房间页一直显示「正在建立连接…」——那是一句假话，玩家会一直等；
 *   · `'error'` 会把 `lastError` 显示出来（store.startNetwork 里 `describeCoreError` 包一层），
 *     玩家立刻知道"这台设备暂时不能当联机节点"，而不是干等。
 * `lastError` 的措辞避开了 describeCoreError 里所有正则分支（端口/bind/权限/wintun），
 * 否则会被改写成一句 Windows 专属的建议（例如"请安装 wintun.dll"），在手机上纯属误导。
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
     * 想真做要等里程碑 2 的 Capacitor 插件（原生侧开 Socket 是几行 Java）。
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
     * 里程碑 1 里会触发确认的动作（退出房间 / 关闭房间）本来就保留着，
     * 用一个系统 confirm 能保证它们不会变成"点了没反应"。
     * 里程碑 2 再把 ConfirmDialog 挂进移动端外壳，把这条换成应用内弹层。
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
       * 里程碑 1 的**核心取舍**：这里不做任何事，直接回报"内核未接入"。
       *
       * 为什么不是"假装成功"：`state: 'running'` 会让界面显示「虚拟网络已连接」，
       * 而实际上游戏根本连不上 —— 玩家会去怪游戏、怪房主，最后才怀疑客户端。
       * 返回 error + 一句能读懂的话，是这里唯一诚实的选择。
       */
      start: async (): Promise<CoreStatus> => {
        const status = unavailableStatus();
        for (const fn of coreStatusListeners) fn(status);
        return status;
      },
      stop: async (): Promise<CoreStatus> => {
        const status = unavailableStatus();
        for (const fn of coreStatusListeners) fn(status);
        return status;
      },
      status: async (): Promise<CoreStatus> => unavailableStatus(),
      logs: async (): Promise<CoreLogEntry[]> => [],

      resourceUsage: async () => null,
      applyAcl: async () => ({ ok: false, error: 'Android 端尚未接入网络内核（里程碑 2）' }),
      /** peers 为空 = 没有节点可显示，连接诊断面板据此显示"无数据"而不是假的节点列表 */
      peers: async (): Promise<CliResult> => ({ ok: false, error: 'Android 端尚未接入网络内核（里程碑 2）' }),
      cli: async (): Promise<CliResult> => ({ ok: false, error: 'Android 端尚未接入网络内核（里程碑 2）' }),

      onStatus: (handler) => {
        coreStatusListeners.add(handler);
        return () => coreStatusListeners.delete(handler);
      },
      onLog: (handler) => {
        coreLogListeners.add(handler);
        return () => coreLogListeners.delete(handler);
      },
    },
  };

  window.mclink = bridge;
}
