/** 网络相关小工具 */
import type { IncomingMessage } from 'node:http';

/**
 * 解析客户端真实 IP。
 *
 * 只有当「直连对端本身是内网/回环地址」时才采信 X-Forwarded-For。
 * 这是安全底线：主控通常挂在 nginx 后面，但一旦直接暴露到公网，
 * 无条件信任 XFF 就意味着任何人都能随便伪造 IP，从而绕过按 IP 的限流、
 * 污染审计日志、伪装子节点上报的公网地址。
 */
export function clientIp(req: IncomingMessage, trustProxy = true): string {
  const direct = normalizeIp(req.socket.remoteAddress ?? '0.0.0.0');
  if (trustProxy && isPrivateIp(direct)) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
      // XFF 由客户端到服务端逐跳追加，最左边是「声称的来源」；
      // 有可信代理时最左边才是真实客户端。
      const first = raw.split(',')[0]?.trim();
      if (first) return normalizeIp(first);
    }
    const real = req.headers['x-real-ip'];
    const realRaw = Array.isArray(real) ? real[0] : real;
    if (realRaw) return normalizeIp(realRaw.trim());
  }
  return direct;
}

export function normalizeIp(ip: string): string {
  let out = ip.trim();
  if (out.startsWith('::ffff:')) out = out.slice(7);
  if (out === '::1') out = '127.0.0.1';
  return out;
}

export function isPrivateIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (n === '127.0.0.1' || n === 'localhost') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(n);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
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
