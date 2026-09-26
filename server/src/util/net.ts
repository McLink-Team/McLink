/** 网络相关小工具 */
import type { IncomingMessage } from 'node:http';

/* ----------------------------------------------------------- 可信代理 */

/** 一条可信代理网段（v4 用 32 位整数，v6 用 128 位 BigInt） */
export type TrustedNet =
  | { family: 4; base: number; bits: number; text: string }
  | { family: 6; base: bigint; bits: number; text: string };

/**
 * 没有显式配置 `MCLINK_TRUSTED_PROXIES` 时的兼容网段：回环 + 私网。
 *
 * 这是**升级兼容**用的：以前只要对端是内网就采信转发头，直接把默认改成"只信回环"
 * 会让容器里跑反代的部署一夜之间把所有玩家都看成同一个内网 IP（比伪造更难查）。
 * 但兼容模式有它自己的洞（内网客户端本身也落在这些网段里，于是也能伪造），
 * 所以启动时会明确提示去配 `MCLINK_TRUSTED_PROXIES`。
 */
const COMPAT_TRUST = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1/128,fc00::/7,fe80::/10';

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(ip: string): number | null {
  const m = V4_RE.exec(ip);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

/** IPv6 → 128 位整数；不合法返回 null（含 `%zone` 与 `[...]` 的写法都能吃） */
function ipv6ToBigInt(raw: string): bigint | null {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;

  const parts = s.split('::');
  if (parts.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = parse(parts[0] ?? '');
  const tail = parts.length === 2 ? parse(parts[1] ?? '') : null;
  if (!head) return null;
  let groups: number[];
  if (tail === null) {
    // 没有 `::`：必须正好 8 组
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }
  let out = 0n;
  for (const g of groups) out = (out << 16n) | BigInt(g);
  return out;
}

/** 合法 IP 字面量（v4 或 v6，允许带端口的写法由调用方先剥掉） */
export function isIpLiteral(raw: string): boolean {
  const ip = raw.trim();
  return ipv4ToInt(ip) !== null || ipv6ToBigInt(ip) !== null;
}

/**
 * 解析 `MCLINK_TRUSTED_PROXIES`：逗号分隔的 IP 或 CIDR。
 *
 * 不能解析的项收集到 `invalid` 里返回，由调用方**写进启动日志** ——
 * 静默忽略一个写错的网段，等于"配了但没生效"，是最难查的那种部署问题。
 */
export function parseTrustedProxies(raw: string | string[] | undefined): { nets: TrustedNet[]; invalid: string[] } {
  const items = (Array.isArray(raw) ? raw : (raw ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
  const nets: TrustedNet[] = [];
  const invalid: string[] = [];

  for (const item of items) {
    const slash = item.indexOf('/');
    const addr = slash === -1 ? item : item.slice(0, slash);
    const prefixRaw = slash === -1 ? null : item.slice(slash + 1);
    const v4 = ipv4ToInt(addr);
    const v6 = v4 === null ? ipv6ToBigInt(addr) : null;
    const maxBits = v4 !== null ? 32 : v6 !== null ? 128 : 0;
    if (maxBits === 0) {
      invalid.push(item);
      continue;
    }
    const bits = prefixRaw === null ? maxBits : Number.parseInt(prefixRaw, 10);
    if (!Number.isFinite(bits) || bits < 0 || bits > maxBits) {
      invalid.push(item);
      continue;
    }
    if (v4 !== null) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      nets.push({ family: 4, base: (v4 & mask) >>> 0, bits, text: bits === 32 ? addr : `${addr}/${bits}` });
    } else {
      const shift = BigInt(128 - bits);
      const base = bits === 0 ? 0n : ((v6 as bigint) >> shift) << shift;
      nets.push({ family: 6, base, bits, text: bits === 128 ? addr : `${addr}/${bits}` });
    }
  }
  return { nets, invalid };
}

/** 该地址是否落在一个可信代理网段里；`nets` 为空表示兼容模式 */
export function isTrustedProxy(ip: string, nets: TrustedNet[] | null = null): boolean {
  const rules = nets && nets.length > 0 ? nets : COMPAT_NETS;
  const n = normalizeIp(ip);
  const v4 = ipv4ToInt(n);
  const v6 = v4 === null ? ipv6ToBigInt(n) : null;

  for (const rule of rules) {
    if (rule.family === 4) {
      if (v4 === null) continue;
      const mask = rule.bits === 0 ? 0 : (0xffffffff << (32 - rule.bits)) >>> 0;
      if (((v4 & mask) >>> 0) === rule.base) return true;
    } else {
      if (v6 === null) continue;
      const shift = BigInt(128 - rule.bits);
      const mask = rule.bits === 0 ? 0n : (((1n << BigInt(rule.bits)) - 1n) << shift);
      if ((v6 & mask) === rule.base) return true;
    }
  }
  return false;
}

/** 给启动日志用的一句话 */
export function describeTrustedProxies(nets: TrustedNet[] | null): string {
  if (!nets || nets.length === 0) return `兼容模式（回环 + 私网段）：${COMPAT_TRUST}`;
  return nets.map((n) => n.text).join(', ');
}

const COMPAT_NETS = parseTrustedProxies(COMPAT_TRUST).nets;

/* --------------------------------------------------------- 真实 IP */

/** 一条转发链最多看多少跳（防止有人塞一个几万项的 XFF 让主控白烧 CPU） */
const MAX_FORWARDED_HOPS = 32;

/** 剥掉 `1.2.3.4:5678`、`[2001:db8::1]:443` 里的端口（有的代理会这么写） */
function stripPort(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close > 0) return s.slice(1, close);
    return s;
  }
  const idx = s.lastIndexOf(':');
  if (idx > 0 && ipv4ToInt(s.slice(0, idx)) !== null) return s.slice(0, idx);
  return s;
}

/** 从一个头里取出若干跳合法地址（保留原顺序；写法不合法的直接丢掉） */
function hopsFrom(header: string | string[] | undefined): string[] {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const out: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const ip = stripPort(part);
      if (ip === '' || !isIpLiteral(ip)) continue;
      out.push(normalizeIp(ip));
    }
  }
  return out;
}

/**
 * 解析客户端真实 IP。
 *
 * 两条规则，缺一条都不安全（详见 docs/security.md）：
 *
 * 1. **只信可信代理**：转发头可以被任何人伪造，所以只有当"直连对端本身是可信代理"
 *    （默认：回环 + 私网；显式配置时只看 `MCLINK_TRUSTED_PROXIES`）才采信。
 *    主控直连暴露在公网时，伪造的 `X-Forwarded-For` 会被整条忽略。
 *
 * 2. **从右往左取第一个不可信跳**：`$proxy_add_x_forwarded_for` 是**追加**语义，
 *    客户端自己发的那个值会排在**最左边**。以前取最左边 = 取攻击者随手写的值，
 *    于是伪造 IP 就能绕过按 IP 的限流、污染审计，还能冒充子节点上报公网地址。
 *    最右边那个是**我们自己的代理亲手写上**的，客户端改不了。
 *
 * 同一跳被多个可信代理串联（CDN → nginx）时，右侧的 CDN 边缘地址会被跳过，
 * 继续往左找真正的那个人 —— 前提是把 CDN 回源段也写进 `MCLINK_TRUSTED_PROXIES`。
 */
export function clientIp(req: IncomingMessage, trustProxy = true, trustedProxies: TrustedNet[] | null = null): string {
  const direct = normalizeIp(req.socket.remoteAddress ?? '0.0.0.0');
  if (!trustProxy) return direct;
  if (!isTrustedProxy(direct, trustedProxies)) return direct;

  // 只留最后 MAX_FORWARDED_HOPS 跳：我们是从右往左看，砍掉左边不影响结果
  const chain = hopsFrom(req.headers['x-forwarded-for']).slice(-MAX_FORWARDED_HOPS);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const hop = chain[i] as string;
    if (!isTrustedProxy(hop, trustedProxies)) return hop;
  }
  if (chain.length > 0) return chain[0] as string;

  // 只配了 X-Real-IP 的反代（nginx 的默认写法就是 $remote_addr，客户端覆盖不了）
  const real = hopsFrom(req.headers['x-real-ip'])[0];
  return real ?? direct;
}

export function normalizeIp(ip: string): string {
  let out = ip.trim();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  if (out.toLowerCase().startsWith('::ffff:')) out = out.slice(7);
  if (out === '::1') out = '127.0.0.1';
  return out;
}

export function isPrivateIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (n === '127.0.0.1' || n === 'localhost') return true;
  const v4 = ipv4ToInt(n);
  if (v4 === null) return false;
  const a = (v4 >>> 24) & 0xff;
  const b = (v4 >>> 16) & 0xff;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** 把 `host:port` 拆开，端口缺省时用 fallback */
export function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    // IPv6 字面量 [::1]:11010
    const close = trimmed.indexOf(']');
    const host = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    const port = rest.startsWith(':') ? Number.parseInt(rest.slice(1), 10) : fallbackPort;
    return { host, port: Number.isFinite(port) ? port : fallbackPort };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) return { host: trimmed, port: fallbackPort };
  const host = trimmed.slice(0, idx);
  const port = Number.parseInt(trimmed.slice(idx + 1), 10);
  return { host, port: Number.isFinite(port) && port > 0 ? port : fallbackPort };
}

/** 从监听 URI（tcp://0.0.0.0:11010）里取端口 */
export function portFromListenerUri(uri: string): number | null {
  const m = /:\/\/.*:(\d+)$/.exec(uri.trim());
  if (!m) return null;
  const p = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(p) ? p : null;
}
