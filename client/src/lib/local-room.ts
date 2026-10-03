/**
 * **本地联机（不需要主控）**：客户端自己生成房间身份与 EasyTier 配置。
 *
 * 为什么需要它（用户 2026-10-03）：官方服务停止后，"必须有一台主控才能建房"就成了门槛 ——
 * 而 EasyTier 本身只要**一个网络名 + 密钥 + 一个能牵线的中继节点**，两台机器就能组成虚拟局域网。
 * 所以这一版让客户端自己当那台"主控"：玩家填中继节点地址（社区公共服或自建），
 * 房间身份由本机随机生成，房主把一段**分享码**发给朋友，朋友粘进来即同一房间。
 *
 * 与"有主控"那条路的区别（必须如实告诉玩家）：
 *   · 没有账号、没有加入码、没有审批/踢人/流量账本 —— 那些都在主控上；
 *   · 谁能进来取决于**谁知道网络名与密钥**，所以分享码就是凭证，别发到公开群里；
 *   · 中继节点是第三方/自建的，可用性与隐私自己判断。
 *
 * 这个文件只放**纯函数**（配置拼装、分享码编解码、校验），可以脱离 Electron 与网络离线验证：
 * `node client/scripts/verify-local-room.mjs`。
 */
import { normalizePeerUri, splitPeerTokens } from './relay-fallback.ts';

/** 本地房间的默认虚拟网段：`10.126.126.0/24`（与主控给房间分配的网段风格一致，但固定） */
export const LOCAL_ROOM_SUBNET = '10.126.126';
/** 房主固定用 .1，加入方靠 dhcp 从房主那里取（EasyTier 的 dhcp 由有静态 IP 的节点担任） */
export const LOCAL_ROOM_HOST_OCTET = 1;
/** 分享码前缀（带版本号，将来换格式时能识别出旧码） */
export const LOCAL_ROOM_CODE_PREFIX = 'mclink-local:1:';

export interface LocalRoomSpec {
  /** 展示用的房间名（玩家自己起，例如"周末开黑"） */
  title: string;
  /** EasyTier 网络名（由标题派生 + 随机后缀，同一房间必须完全一致） */
  networkName: string;
  /** 网络密钥（32 位十六进制；与网络名一起构成准入凭证） */
  secret: string;
  /** 中继节点地址（至少一个；社区公共服或自建） */
  peers: string[];
  /** 本机是不是房主（房主固定 IPv4 并充当 DHCP；加入方 dhcp = true） */
  isHost: boolean;
  /** 房主的虚拟 IP（加入方用来找游戏服务器） */
  hostIp: string;
}

/** 32 位十六进制密钥（EasyTier 的 network_secret 就是这个形状） */
export function newRoomSecret(): string {
  const bytes = new Uint8Array(16);
  // 优先用 Web Crypto（Electron / Capacitor 都有）；取不到时退回 Math.random（仅用于本地房间）
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 把玩家起的名字压成网络名能用的形态：小写字母数字与连字符，其余丢掉 */
export function slugifyRoomTitle(title: string): string {
  const ascii = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 中文标题转不出 ascii 时退回一个固定词，避免网络名退化成空
  const base = /[a-z0-9]/.test(ascii) ? ascii.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '') : '';
  return base.length > 0 ? base.slice(0, 24) : 'room';
}

/** 生成网络名：`mclink-local-<slug>-<4 位随机>`（随机后缀避免两个同名房间撞在一起） */
export function newNetworkName(title: string): string {
  const rand = newRoomSecret().slice(0, 4);
  return `mclink-local-${slugifyRoomTitle(title)}-${rand}`;
}

/** 房主虚拟 IP（`10.126.126.1/24` 形式，EasyTier 接受带掩码的写法） */
export function hostVirtualIp(): string {
  return `${LOCAL_ROOM_SUBNET}.${LOCAL_ROOM_HOST_OCTET}/24`;
}

/**
 * 给加入方挑一个同网段的地址（2..254，避开房主的 .1）。
 *
 * ⚠️ 为什么不用 EasyTier 的 `dhcp = true`（**实测踩过**，见 `scripts/check-local-room-live.mjs`）：
 * 房主那份配置里写 `ipv4` + 加入方写 `dhcp = true` 时，加入方拿不到地址
 * （`node info` 的 `ipv4_addr` 是空串），两边也就互相看不见 —— 直白地说就是"连不上"。
 * 本地模式没有主控来兜底分配地址，所以这里**由客户端自己挑一个静态地址**：
 * 房间里最多几十个人，随机 2..254 撞车概率低；真撞了，界面会让玩家换一个（`ipv4` 是可见字段）。
 */
export function randomGuestVirtualIp(random = Math.random): string {
  const octet = 2 + Math.floor(random() * 253); // 2..254
  return `${LOCAL_ROOM_SUBNET}.${octet}/24`;
}

/** 地址是否落在本地房间的网段里（界面用来提示"你填的地址不在这个房间的网段"） */
export function isLocalRoomIp(ip: string): boolean {
  return new RegExp(`^${LOCAL_ROOM_SUBNET.replace(/\./g, '\\.')}\\.\\d{1,3}(/\\d{1,2})?$`).test(ip.trim());
}

/** 分享码里携带的全部信息（加入方全靠它，所以字段名要短、含义要稳） */
interface SharePayload {
  /** 房间名（展示用） */
  t: string;
  /** 网络名 */
  n: string;
  /** 网络密钥 */
  s: string;
  /** 中继节点地址（已归一化） */
  p: string[];
}

/**
 * base64 编解码：**只用 `btoa` / `atob`**（Electron、安卓 WebView、Node ≥16 都有）。
 *
 * 这里刻意不写 `Buffer` 兜底：`local-room.ts` 会被**安卓端一起编译**，而那边的 tsconfig
 * 没有 Node 类型（`Buffer` 直接编译不过）。而"没有 btoa 的运行环境"对本项目根本不存在。
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 生成分享码（base64url，UTF-8 安全 —— 中文房间名也能塞进去） */
export function encodeShareCode(spec: Pick<LocalRoomSpec, 'title' | 'networkName' | 'secret' | 'peers'>): string {
  const payload: SharePayload = { t: spec.title, n: spec.networkName, s: spec.secret, p: [...spec.peers] };
  /**
   * `btoa` 只吃 latin1，中文会抛 InvalidCharacterError —— 先按 UTF-8 转成字节再 base64。
   * （刻意不引第三方库：一段 20 行的编解码比多一个依赖划算。）
   */
  const base64 = bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)));
  return LOCAL_ROOM_CODE_PREFIX + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 解析分享码。返回 `null` = 不是一段合法的分享码（界面据此提示"粘贴的码不对"）。
 *
 * 容错：允许前后有空白；允许玩家把整条消息（"来联机：mclink-local:1:xxx 密码在群里"）粘进来 ——
 * 用正则把码抠出来，别让人手工剪。
 */
export function decodeShareCode(text: string): { title: string; networkName: string; secret: string; peers: string[] } | null {
  const raw = text.trim();
  if (raw.length === 0) return null;
  const match = new RegExp(`${LOCAL_ROOM_CODE_PREFIX.replace(/[:]/g, ':')}([A-Za-z0-9_-]+)`).exec(raw);
  if (!match?.[1]) return null;
  const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let json: string;
  try {
    json = new TextDecoder().decode(base64ToBytes(padded));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const payload = parsed as Partial<SharePayload>;
  if (
    typeof payload?.t !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.s !== 'string' ||
    !Array.isArray(payload.p) ||
    payload.n.length === 0 ||
    payload.s.length === 0
  ) {
    return null;
  }
  const peers = payload.p.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (peers.length === 0) return null;
  return { title: payload.t, networkName: payload.n, secret: payload.s, peers };
}

/**
 * 拼出交给 `easytier-core` 的 TOML。
 *
 * 字段与主控生成的那份（`server/src/easytier/config.ts`）保持同一套名字：
 * 安卓的 `vpn-plan.ts` 与桌面端的状态轮询都按这些键名读配置，
 * 名字对不上就会出现"能连上但界面什么都不显示"。
 *
 * 房主与加入方的区别：房主固定 `10.126.126.1/24`；加入方**也是静态地址**，
 * 只是由本机随机挑一个同网段的值（见 `randomGuestVirtualIp` 里那段实测结论：
 * `dhcp = true` 在 2.6.4 上拿不到地址，两边会互相看不见）。
 */
export function renderLocalRoomToml(input: {
  spec: Pick<LocalRoomSpec, 'networkName' | 'secret' | 'peers' | 'isHost'>;
  hostname?: string;
  instanceName?: string;
  listenPort?: number;
  /** 加入方的静态地址；留空就自动挑一个同网段的 */
  ipv4?: string;
}): string {
  const { spec } = input;
  const lines: string[] = [];
  lines.push('# 由 McLink 客户端本地生成（本地联机模式，没有主控参与）');
  lines.push(`instance_name = ${quote(input.instanceName ?? 'mclink-local')}`);
  if (input.hostname) lines.push(`hostname = ${quote(input.hostname)}`);
  if (spec.isHost) {
    lines.push(`ipv4 = ${quote(hostVirtualIp())}`);
  } else {
    lines.push(`ipv4 = ${quote(input.ipv4 ?? randomGuestVirtualIp())}`);
  }
  // 一律不启用 dhcp：本地模式靠静态地址（理由见 randomGuestVirtualIp 的注释）
  lines.push('dhcp = false');
  if (input.listenPort && input.listenPort > 0) {
    lines.push(`listeners = ["tcp://0.0.0.0:${input.listenPort}", "udp://0.0.0.0:${input.listenPort}"]`);
  }

  lines.push('');
  lines.push('[network_identity]');
  lines.push(`network_name = ${quote(spec.networkName)}`);
  lines.push(`network_secret = ${quote(spec.secret)}`);

  const peers = spec.peers.length > 0 ? spec.peers : [];
  if (peers.length > 0) {
    lines.push('');
    for (const peer of peers) {
      lines.push('[[peer]]');
      lines.push(`uri = ${quote(peer)}`);
    }
  }

  /**
   * flags：与主控那份的关键项保持一致（`latency_first` 打开 = 延迟优先选路；
   * `enable_encryption` 默认上；IPv6 关掉，与房间模式一致），
   * 另外**不加** `relay_network_whitelist` 限制 —— 本地模式没有"只转发我们房间"这回事，
   * 中继是否转发由中继自己的白名单决定（社区公共服通常是全放行）。
   */
  lines.push('');
  lines.push('[flags]');
  lines.push('default_protocol = "tcp"');
  lines.push('enable_encryption = true');
  lines.push('enable_ipv6 = false');
  lines.push('mtu = 1380');
  lines.push('latency_first = true');
  lines.push('no_tun = false');
  lines.push('use_smoltcp = false');
  lines.push('private_mode = false');
  return `${lines.join('\n')}\n`;
}

/** TOML 字符串字面量：转义反斜杠与引号（房间名/密钥可能被玩家改出奇怪字符） */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 校验玩家填的一组中继地址：返回归一化后的列表与"被跳过的**原文**"。
 *
 * 界面用 `bad` 把玩家写错的那一段标红，所以这里必须保留他写的原文 ——
 * 不能把 `tcp://https://…` 这种展开后的形态报回去（那只会让人更糊涂）。
 */
export function normalizeLocalPeers(text: string): { peers: string[]; bad: string[] } {
  const peers: string[] = [];
  const bad: string[] = [];
  for (const token of splitPeerTokens(text)) {
    // 与 splitPeerUris 同一条规则：没写协议就 tcp/udp 各来一条
    const candidates = /^(tcp|udp|ws|wss):\/\//i.test(token) ? [token] : [`tcp://${token}`, `udp://${token}`];
    const normalized = candidates.map((c) => normalizePeerUri(c)).filter((u): u is string => u !== null);
    if (normalized.length === 0) {
      bad.push(token);
      continue;
    }
    for (const uri of normalized) if (!peers.includes(uri)) peers.push(uri);
  }
  return { peers, bad };
}

/** 本地房间能不能开工：至少要一个合法中继地址（没有它就只能在同网段内直连） */
export function localRoomProblem(input: { peers: string[]; title?: string }): string | null {
  if (input.peers.length === 0) {
    return '至少填一个中继节点地址（社区公共服或自建的都可以），否则两台机器之间没有牵线的中间人';
  }
  return null;
}
