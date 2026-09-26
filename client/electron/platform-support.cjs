/**
 * 「只在 Windows 上成立的能力」在别的平台上怎么办 —— 纯逻辑，不依赖 electron，便于离线断言
 * （见 client/scripts/verify-platform.mjs 与 client/scripts/verify-platform-support.mjs）。
 *
 * 为什么要有这个文件
 * ------------------
 * 房间票据里的 EasyTier 配置是**主控生成**的，里面有些 flag 只在 Windows 上有效。
 * 最典型的是 `enable_udp_broadcast_relay`（「局域网广播直通」）：EasyTier 靠
 * **WinDivert** 这个 Windows 内核网络过滤驱动去抓物理网卡的 UDP 广播，
 * macOS 上根本没有这套东西。行为取决于 EasyTier 自己的实现，可能是：
 *   · 起不来（驱动/设备打不开）→ 玩家看到"核心意外退出"，却不知道为什么；
 *   · 或者起来了但广播永远收不到 → 玩家在「多人游戏」列表里干等，**静默失败**。
 * 两种都不能接受：macOS 上必须**明确关掉并说清原因**，而不是让它去撞运气。
 *
 * 为什么在客户端做而不是改主控：主控的配置是**全平台共用**的一份 TOML
 * （同一个房间可能同时有 Windows 与 macOS 成员），而"这台机器能不能用 WinDivert"
 * 只有客户端自己知道。所以：主控照旧下发，客户端在**写入配置文件之前**按平台过滤。
 */

/**
 * 只在 Windows 上有效的配置项。
 *
 * `why` 会作为一行日志写进客户端日志面板 / core 日志，玩家与客服都能看到 ——
 * 这正是"不要静默失败"的落点：功能没了，但原因在界面上写着。
 */
const WINDOWS_ONLY_FLAGS = [
  {
    key: 'enable_udp_broadcast_relay',
    feature: '局域网广播直通',
    why: 'EasyTier 的局域网广播直通依赖 Windows 的 WinDivert 内核驱动，当前平台不支持 —— 已自动关闭。用「直接连接 + 房间地址」照常联机。',
  },
];

/**
 * 按平台过滤配置里的 Windows-only flag。
 *
 * 为什么用「按行替换 true→false」而不是解析 TOML：配置是主控自己生成的固定格式
 * （`key = true|false` 一行一项，见 server/src/easytier/config.ts），
 * 引一个 TOML 解析器只为改一个布尔值是过度工程。这里只在**值恰好是 true** 时替换，
 * 键名用 `^...=` 锚定，不会误伤 `xxx_enable_udp_broadcast_relay` 这类前缀或注释里的同名文本
 * （注释行以 # 开头，锚定 `=` 的键名不会命中）。
 *
 * @param {string} toml 主控下发的配置
 * @param {string} platform process.platform
 * @returns {{ toml: string, disabled: Array<{ key: string, feature: string, why: string }> }}
 */
function stripWindowsOnlyFlags(toml, platform) {
  const text = typeof toml === 'string' ? toml : '';
  // Windows 上原样返回：这条判定必须**只在别的平台**生效，否则会把 Windows 的功能也关掉
  if (platform === 'win32' || text.length === 0) return { toml: text, disabled: [] };

  // 键名进正则前先转义：现在的键都是 [a-z_] 常量，但别让将来加键的人踩到元字符
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text;
  const disabled = [];
  for (const flag of WINDOWS_ONLY_FLAGS) {
    const re = new RegExp(`^(\\s*${escapeRe(flag.key)}\\s*=\\s*)true\\b`, 'm');
    if (!re.test(out)) continue;
    out = out.replace(re, '$1false');
    disabled.push({ ...flag });
  }
  return { toml: out, disabled };
}

/** 「这台机器支持局域网广播直通吗」——渲染层用它决定开关是否可点（与上面同一份事实来源） */
function supportsLanBroadcast(platform) {
  return platform === 'win32';
}

module.exports = { WINDOWS_ONLY_FLAGS, stripWindowsOnlyFlags, supportsLanBroadcast };
