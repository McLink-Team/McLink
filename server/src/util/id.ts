/** ID 生成与令牌工具 */
import { randomBytes, randomUUID, createHash, timingSafeEqual, scrypt as scryptCb, randomInt } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/** 短且可读的资源 ID（房间、节点等）。避免用 uuid 让日志过长。 */
export function shortId(prefix = ''): string {
  const b = randomBytes(8);
  const s = b.toString('base64url').replace(/[-_]/g, '').slice(0, 10);
  return prefix ? `${prefix}_${s}` : s;
}

export function uuid(): string {
  return randomUUID();
}

/** 会话/API 令牌：随机 32 字节，仅在签发时可见一次 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 恒定时间比较，用于令牌/签名校验 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 一次性的 6 位数字验证码/注册密钥用字符集 */
const ENROLL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function enrollKey(): string {
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i += 1) {
    out += ENROLL_ALPHABET[(bytes[i] ?? 0) % ENROLL_ALPHABET.length];
    if (i % 6 === 5 && i !== 23) out += '-';
  }
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password.normalize('NFKC'), salt, 64)) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] ?? '', 'base64url');
  const expected = Buffer.from(parts[2] ?? '', 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = (await scrypt(password.normalize('NFKC'), salt, expected.length)) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** 0..n-1 的密码学安全随机整数 */
export function randInt(maxExclusive: number): number {
  return maxExclusive <= 0 ? 0 : randomInt(maxExclusive);
}

export function randomBytesBuf(n: number): Buffer {
  return randomBytes(n);
}

/**
 * 生成满足校验规则（含字母与数字）的随机密码，用于初始化管理员等场景。
 */
export function generatePassword(length = 16): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const all = lower + upper + digit;
  const pick = (set: string): string => set[randInt(set.length)] ?? 'a';
  const chars = [pick(lower), pick(upper), pick(digit), pick(lower), pick(digit)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher–Yates 打乱，避免固定出现在前几位
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join('');
}
