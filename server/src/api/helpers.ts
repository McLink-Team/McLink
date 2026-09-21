/** 路由层共用的小工具：参数读取、鉴权断言、审计封装 */
import { DEFAULT_ROOM_POLICY, type RoomPolicy } from '@mclink/shared';
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
