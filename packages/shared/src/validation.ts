/** 零依赖的输入校验helper：服务端与客户端共用，保证前后端规则一致 */

export class ValidationError extends Error {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(`参数校验失败: ${Object.keys(fields).join(', ')}`);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export interface FieldRule {
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  patternMessage?: string;
  oneOf?: readonly string[];
  label?: string;
}

export type Schema = Record<string, FieldRule>;

export type Validated<T extends Schema> = {
  [K in keyof T]?: string;
};

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
export const ROOM_NAME_MAX = 32;
export const DEVICE_NAME_MAX = 32;

/**
 * 邮箱校验。
 *
 * 刻意不做"完全符合 RFC 5322"的解析——那种正则出了名地长且仍然会放过一堆东西，
 * 而真正的判定标准是"验证码能不能寄到"。这里只挡明显不是邮箱的输入：
 * 必须有且只有一个 @、本地部分与域名都非空、域名至少有一个点且顶级域是纯字母。
 * 最长 120 字符（与 users.email 的截断长度一致）。
 */
export const EMAIL_MAX = 120;
export const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)*\.[a-zA-Z]{2,24}$/;

export function emailProblem(value: string): string | null {
  const email = value.trim();
  if (email.length === 0) return '邮箱不能为空';
  if (email.length > EMAIL_MAX) return `邮箱不能超过 ${EMAIL_MAX} 个字符`;
  if (!EMAIL_PATTERN.test(email)) return '邮箱格式不正确';
  return null;
}

/** 验证码：6 位数字，允许用户带空格输入 */
export const EMAIL_CODE_PATTERN = /^\d{6}$/;

export function normalizeEmailCode(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * 校验一个纯字符串字段字典（来自 JSON body 或 query）。
 * 返回值只包含通过校验的键；数值用 `coerceInt` 另外转换。
 */
export function validate(body: Record<string, unknown>, schema: Schema): Record<string, string> {
  const out: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const [key, rule] of Object.entries(schema)) {
    const label = rule.label ?? key;
    const raw = body[key];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (rule.required) errors[key] = `${label}不能为空`;
      continue;
    }
    if (typeof raw !== 'string') {
      errors[key] = `${label}必须是字符串`;
      continue;
    }
    const value = raw.trim();
    if (value.length === 0) {
      if (rule.required) errors[key] = `${label}不能为空`;
      continue;
    }
    if (rule.min !== undefined && value.length < rule.min) {
      errors[key] = `${label}至少 ${rule.min} 个字符`;
      continue;
    }
    if (rule.max !== undefined && value.length > rule.max) {
      errors[key] = `${label}最多 ${rule.max} 个字符`;
      continue;
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      errors[key] = rule.patternMessage ?? `${label}格式不正确`;
      continue;
    }
    if (rule.oneOf && !rule.oneOf.includes(value)) {
      errors[key] = `${label}必须是以下之一: ${rule.oneOf.join(', ')}`;
      continue;
    }
    out[key] = value;
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return out;
}

/** 宽松取整：非法/缺省返回 fallback */
export function coerceInt(value: unknown, fallback: number, min?: number, max?: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  let out = Number.isFinite(n) ? Math.trunc(n) : fallback;
  if (min !== undefined) out = Math.max(min, out);
  if (max !== undefined) out = Math.min(max, out);
  return out;
}

export function coerceBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/** 密码强度：至少 8 位，且不能是纯数字/纯字母 */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return '密码至少 8 位';
  if (pw.length > 128) return '密码最多 128 位';
  if (!/[a-zA-Z]/.test(pw)) return '密码需包含字母';
  if (!/\d/.test(pw)) return '密码需包含数字';
  return null;
}

/** 生成人类可读的加入码，去掉容易混淆的 0/O/1/I */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateRoomCode(random: (n: number) => Uint8Array): string {
  const bytes = random(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * 生成 EasyTier 网络密钥。
 * 用 URL 安全字符集，避免配置在 TOML/命令行/URL 中出现转义问题。
 */
export function generateNetworkSecret(random: (n: number) => Uint8Array, length = 32): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const bytes = random(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}

export function isValidIpv4(ip: string): boolean {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isValidHostPort(value: string): boolean {
  const m = /^([a-zA-Z0-9._-]+):(\d{1,5})$/.exec(value.trim());
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535;
}
