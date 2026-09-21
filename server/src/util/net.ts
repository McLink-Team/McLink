/** 网络相关小工具 */
import type { IncomingMessage } from 'node:http';

/**
 * 解析客户端真实 IP。
 * 只有配置了 trustProxy 时才采信 X-Forwarded-For（主控通常位于 nginx 之后）。
 */
export function clientIp(req: IncomingMessage, trustProxy = true): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
      const first = raw.split(',')[0]?.trim();
      if (first) return normalizeIp(first);
    }
    const real = req.headers['x-real-ip'];
    const realRaw = Array.isArray(real) ? real[0] : real;
    if (realRaw) return normalizeIp(realRaw.trim());
  }
  return normalizeIp(req.socket.remoteAddress ?? '0.0.0.0');
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
