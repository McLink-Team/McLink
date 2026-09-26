/**
 * 平台差异（渲染层）—— **一处判定，一处文案**。
 *
 * 为什么单独抽一个文件：
 *   1. 平台上要改的从来不是逻辑，而是**这句话该怎么说**。
 *      提权这件事在 Windows 上是「UAC / 右键→以管理员身份运行」，在 macOS 上是
 *      「系统授权框 / 输入密码」；托盘在 Windows 上叫托盘、在 macOS 上是菜单栏图标。
 *      散在六七个 .vue 里各写一遍，必然会漏掉一处，然后那句错的话就留在界面上了
 *      （本次改造之前，macOS 用户看到的正是"右键客户端图标 → 以管理员身份运行"）。
 *   2. 判定必须**同步**：这些分支决定首屏画什么，异步 info() 会先闪一帧 Windows 版。
 *      `window.mclink.platform` 由 preload 同步给出。
 *
 * 唯一的例外是「这台机器支不支持局域网广播直通」——那属于主进程的能力清单
 * （`electron/platform-support.cjs` 的 supportsLanBroadcast），两边用的是同一条规则：
 * 只有 win32。这里再写一遍是为了渲染层不改 IPC 契约；规则本身在
 * client/scripts/verify-platform.mjs 里被断言为"两边一致"。
 */

/** preload 给的 `process.platform`；拿不到（例如在浏览器里跑单页调试）时按 Windows 处理 */
export const platform: string = globalThis.window?.mclink?.platform ?? 'win32';

export const isMac = platform === 'darwin';
export const isWindows = platform === 'win32';

/** 虚拟网卡在这两个平台上由核心自己创建，且都需要管理员/root */
export const needsAdmin = isMac || isWindows;

/** 局域网广播直通（EasyTier 的 enable_udp_broadcast_relay）依赖 Windows 的 WinDivert 驱动 */
export const supportsLanBroadcast = isWindows;

/** 虚拟网卡的名字：写进给玩家看的报错里，别在 mac 上提 wintun */
export const tunName = isMac ? 'utun' : 'wintun';

/**
 * 「怎么自己拿到管理员权限」——这句话在 macOS 上完全是另一回事：
 * Windows 是右键菜单里的「以管理员身份运行」，macOS 的右键 → 打开只是绕过 Gatekeeper，
 * 给的是**安全提示**，不是权限。mac 上正确的动作是让应用弹系统授权框、由用户输密码。
 */
export const adminHowTo = isMac
  ? '点下面的按钮：会弹出系统授权框，输入登录密码后本窗口会以管理员身份重新打开。'
  : '右键客户端图标 → 点「以管理员身份运行」。也可以直接点下面的按钮：会弹系统授权框，本窗口退出后以管理员身份重新打开。';

/** 「打开所在文件夹」这件事在两个平台上的说法与落点不同 */
export const revealAppLabel = isMac ? '在访达中显示' : '打开所在文件夹';

/** 收窗口这件事的名字：Windows 叫托盘，macOS 是菜单栏图标 */
export const trayName = isMac ? '菜单栏' : '托盘';

/**
 * 「系统授权的那个框」在设置页里怎么称呼。
 * Windows 是 UAC；macOS 没有 UAC 这个名字（也没有"以管理员身份运行"的右键项），
 * 它是 osascript 弹出来的系统授权框，让用户输登录密码。
 */
export const adminAuthPrompt = isMac ? '系统授权框' : 'UAC 授权框';

/** 关闭窗口的三种偏好：同一个值，两套说法（macOS 上「关闭窗口」本来就不等于退出） */
export const closeActionLabel = (action: 'ask' | 'tray' | 'quit'): string => {
  if (action === 'quit') return '彻底退出';
  if (action === 'ask') return '每次都问我';
  return isMac ? '隐藏窗口（应用继续运行）' : '最小化到托盘';
};

/** 关闭询问框里的两个动作按钮 */
export const closeHideLabel = isMac ? '隐藏窗口' : '最小化到托盘';
export const closeHideHint = isMac
  ? '窗口收起来，房间与联机保持不变（点 Dock 图标或菜单栏图标可以叫回来，⌘Q 才是退出）。'
  : '窗口收起来，房间与联机保持不变（托盘图标右键可退出）。';
