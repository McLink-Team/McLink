/** 路由层共用的小工具：参数读取、鉴权断言、审计封装 */
import { DEFAULT_ROOM_POLICY, type RelayLatencyHint, type RoomPolicy } from '@mclink/shared';
import { HttpError } from '../util/errors.ts';
import type { Ctx } from '../http/kit.ts';
import type { AuthContext } from '../http/kit.ts';

/** 取字符串字段；required 时缺失即报错 */
export function req(body: Record<string, unknown>, key: string, label = key): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw HttpError.badRequest(`${label}不能为空`, { [key]: `${label}不能为空` });
  }
  return v.trim();
}

export function optStr(body: Record<string, unknown>, key: string, max = 200): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

export function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
  }
  return undefined;
}

export function optInt(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 从请求体里解析房间策略。
 * 只接受已知字段并且做范围裁剪，避免客户端塞入任意值影响 ACL 生成。
 */
export function parsePolicy(body: Record<string, unknown>, base?: RoomPolicy): RoomPolicy {
  const current = base ?? DEFAULT_ROOM_POLICY;
  const out: RoomPolicy = { ...current };

  const maxPlayers = optInt(body, 'maxPlayers', 2, 64);
  if (maxPlayers !== undefined) out.maxPlayers = maxPlayers;

  const maxBandwidthKbps = optInt(body, 'maxBandwidthKbps', 0, 10_000_000);
  if (maxBandwidthKbps !== undefined) out.maxBandwidthKbps = maxBandwidthKbps;

  const perMemberKbps = optInt(body, 'perMemberKbps', 0, 10_000_000);
  if (perMemberKbps !== undefined) out.perMemberKbps = perMemberKbps;

  const rateLimitPps = optInt(body, 'rateLimitPps', 0, 1_000_000);
  if (rateLimitPps !== undefined) out.rateLimitPps = rateLimitPps;

  const allowP2p = optBool(body, 'allowP2p');
  if (allowP2p !== undefined) out.allowP2p = allowP2p;

  const allowPublicRelay = optBool(body, 'allowPublicRelay');
  if (allowPublicRelay !== undefined) out.allowPublicRelay = allowPublicRelay;

  // 局域网广播直通：默认关闭，只有房主显式打开才会写进客户端配置
  const allowBroadcast = optBool(body, 'allowBroadcast');
  if (allowBroadcast !== undefined) out.allowBroadcast = allowBroadcast;

  const strictPorts = optBool(body, 'strictPorts');
  if (strictPorts !== undefined) out.strictPorts = strictPorts;

  const rawPorts = body.allowedPorts;
  if (Array.isArray(rawPorts)) {
    out.allowedPorts = rawPorts
      .map((p) => String(p).trim())
      .filter((p) => /^\d{1,5}(-\d{1,5})?$/.test(p))
      .slice(0, 32);
  } else if (typeof rawPorts === 'string') {
    out.allowedPorts = rawPorts
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter((p) => /^\d{1,5}(-\d{1,5})?$/.test(p))
      .slice(0, 32);
  }

  const motd = optStr(body, 'motd', 200);
  if (motd !== undefined) out.motd = motd;
  else if ('motd' in body && body.motd === null) out.motd = null;

  return out;
}

/**
 * 解析建房请求里可选的「节点延迟提示」（见 `RelayLatencyHint`）。
 *
 * 三件事刻意做得**宽松**，因为这只是排序偏好，不该挡住任何人建房：
 *   · 字段缺失 / 不是数组 / 条目形状不对 → 当作"没有提示"，与老客户端完全同路；
 *   · ms 只做范围裁剪（0–60000 的整数），NaN/Infinity/负数/字符串一律丢弃；
 *   · 条数截断到 64 条、同一个 nodeId 出现多次取最小值（与客户端"连打 3 次取最快"一致）。
 *
 * 不校验真伪：谎报延迟只能影响自己房间的选路，而平台本来就允许自选节点
 * （完整理由写在 shared 的 RelayLatencyHint 注释里）。
 */
export function parseLatencyHints(body: Record<string, unknown>): RelayLatencyHint[] {
  const raw = body.latencyHints;
  if (!Array.isArray(raw)) return [];
  const best = new Map<string, number>();
  for (const item of raw.slice(0, 64)) {
    if (!item || typeof item !== 'object') continue;
    const { nodeId, ms } = item as { nodeId?: unknown; ms?: unknown };
    if (typeof nodeId !== 'string' || nodeId.length === 0) continue;
    const value = typeof ms === 'number' ? ms : Number.NaN;
    if (!Number.isFinite(value) || value < 0) continue;
    const rounded = Math.min(60_000, Math.round(value));
    const prev = best.get(nodeId);
    if (prev === undefined || rounded < prev) best.set(nodeId, rounded);
  }
  return [...best].map(([nodeId, ms]) => ({ nodeId, ms }));
}

/** 断言已登录；返回认证上下文 */
export function requireAuth(ctx: Ctx): AuthContext {
  if (!ctx.auth) throw HttpError.unauthorized();
  return ctx.auth;
}

/** 断言管理员 */
export function requireAdmin(ctx: Ctx): AuthContext {
  const auth = requireAuth(ctx);
  if (auth.role !== 'admin') throw HttpError.forbidden('需要管理员权限');
  return auth;
}

/** 从 Authorization: Bearer <token> 中取令牌 */
export function bearerToken(ctx: Ctx): string | null {
  const header = ctx.req.headers.authorization;
  if (!header) {
    const alt = ctx.req.headers['x-mclink-token'];
    const raw = Array.isArray(alt) ? alt[0] : alt;
    return raw?.trim() ?? null;
  }
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? null;
}

/** 分页参数 */
export function paging(ctx: Ctx, defaultLimit = 50): { limit: number; offset: number } {
  const limit = Number.parseInt(ctx.query.get('limit') ?? '', 10);
  const offset = Number.parseInt(ctx.query.get('offset') ?? '', 10);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : defaultLimit,
    offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
  };
}
