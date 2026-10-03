/**
 * 邀请注册（私有化部署用）。
 *
 * 三件事：
 *   1. **生成**邀请码：给人念得出来的码（去掉 0/O/1/I/L 这些抄错率高的字符），
 *      可设可用次数（0 = 不限）与有效期；
 *   2. **核验**：这个码能不能用、还剩几次 —— 一条纯函数 `inviteProblem()`，单测钉死；
 *   3. **消费**：注册成功时把次数扣掉，扣减在 SQL 里做原子自增（见 `InviteRepo.redeem`），
 *      所以两个请求同时用一个"一码一次"的邀请码时只有一个能成。
 *
 * 为什么把规则写成纯函数：它是**唯一**的门（私有实例不再有开放注册兜底），
 * 判定要能被单测穷举（过期 / 次数用完 / 已停用 / 不存在），不能散在 API 层。
 */
import { ErrorCodes, type ErrorCode } from '@mclink/shared';
import type { InviteCode } from '@mclink/shared';
import { InviteRepo, toInvite, type InviteRow } from '../db/invites.ts';
import { HttpError } from '../util/errors.ts';
import { randomBytesBuf } from '../util/id.ts';
import type { AuditRepo } from '../db/traffic.ts';

/** 邀请码字符集：去掉 0 O 1 I L（抄写/念读最容易错的那几个） */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 10;
/** 一次最多同时存在多少个未停用的码（防手滑点出一屏又认不出哪个是哪个） */
export const INVITE_MAX_ACTIVE = 200;

/** 生成一个邀请码（`INVITE_ALPHABET` 里取 10 位，约 49 bit 熵 —— 暴力猜不现实） */
export function generateInviteCode(length = INVITE_CODE_LENGTH): string {
  const bytes = randomBytesBuf(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i += 1) {
    const byte = bytes[i % bytes.length] ?? 0;
    // 取模会带来极轻微的偏好，对"邀请码"这个用途完全无所谓（32 能整除 256，其实没有偏好）
    out += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  }
  return out;
}

/** 规范化用户输入的码：去空格、转大写（码本身不区分大小写） */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase();
}

/**
 * 这个码为什么不能用 —— `null` 表示能用。
 *
 * 返回的是**给玩家看的**中文原因（注册页会把这句话直接显示出来），
 * 同时带上错误码，界面可以据此决定"要不要提示去问管理员"。
 */
export function inviteProblem(
  invite: Pick<InviteRow, 'disabled' | 'expires_at' | 'max_uses' | 'used_count'> | null | undefined,
  now = Date.now(),
): { code: ErrorCode; message: string } | null {
  if (!invite) return { code: ErrorCodes.INVITE_INVALID, message: '邀请码无效，请向邀请你的人确认' };
  if (invite.disabled === 1) return { code: ErrorCodes.INVITE_INVALID, message: '这个邀请码已被停用，请联系管理员' };
  if (invite.expires_at) {
    const at = Date.parse(invite.expires_at);
    if (Number.isFinite(at) && at <= now) return { code: ErrorCodes.INVITE_EXPIRED, message: '这个邀请码已过期，请向邀请你的人要一个新的' };
  }
  if (invite.max_uses > 0 && invite.used_count >= invite.max_uses) {
    return { code: ErrorCodes.INVITE_USED, message: '这个邀请码的使用次数已经用完了' };
  }
  return null;
}

export interface InviteCreateInput {
  note?: string | null;
  /** 可用次数；0 = 不限 */
  maxUses?: number;
  /** 有效天数；0/不填 = 永不过期 */
  expiresInDays?: number;
  actor?: string | null;
}

export class InviteService {
  readonly #repo: InviteRepo;
  readonly #audit: AuditRepo;

  constructor(repo: InviteRepo, audit: AuditRepo) {
    this.#repo = repo;
    this.#audit = audit;
  }

  list(): InviteCode[] {
    return this.#repo.list().map(toInvite);
  }

  /** 生成一个码。撞码概率极低，但仍然重试几次（主键冲突会抛） */
  create(input: InviteCreateInput = {}): InviteCode {
    const active = this.#repo.list(INVITE_MAX_ACTIVE + 1).filter((row) => row.disabled === 0);
    if (active.length >= INVITE_MAX_ACTIVE) {
      throw HttpError.badRequest(`未停用的邀请码太多了（${INVITE_MAX_ACTIVE} 个），先停用一些再生成`);
    }
    const maxUses = Math.max(0, Math.min(input.maxUses ?? 1, 1000));
    const days = Math.max(0, Math.min(input.expiresInDays ?? 0, 3650));
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    const note = (input.note ?? '').toString().trim().slice(0, 200) || null;

    let row: InviteRow | null = null;
    for (let attempt = 0; attempt < 5 && row === null; attempt += 1) {
      const code = generateInviteCode();
      if (this.#repo.find(code)) continue;
      row = this.#repo.create({ code, note, createdBy: input.actor ?? null, expiresAt, maxUses });
    }
    if (row === null) throw new Error('生成邀请码失败（连续撞码），请重试');

    this.#audit.write({
      actorType: 'admin',
      actorId: input.actor ?? null,
      action: 'invite.create',
      targetType: 'invite',
      targetId: row.code,
      detail: { note, maxUses, expiresAt },
    });
    return toInvite(row);
  }

  /** 停用/恢复。停用是默认操作（删掉就查不到"这个码发给过谁"了） */
  setDisabled(code: string, disabled: boolean, actor?: string | null): InviteCode {
    const normalized = normalizeInviteCode(code);
    if (!this.#repo.setDisabled(normalized, disabled)) throw HttpError.notFound('没有这个邀请码');
    this.#audit.write({
      actorType: 'admin',
      actorId: actor ?? null,
      action: disabled ? 'invite.disable' : 'invite.enable',
      targetType: 'invite',
      targetId: normalized,
    });
    const row = this.#repo.find(normalized);
    if (!row) throw HttpError.notFound('没有这个邀请码');
    return toInvite(row);
  }

  remove(code: string, actor?: string | null): void {
    const normalized = normalizeInviteCode(code);
    if (!this.#repo.remove(normalized)) throw HttpError.notFound('没有这个邀请码');
    this.#audit.write({
      actorType: 'admin',
      actorId: actor ?? null,
      action: 'invite.remove',
      targetType: 'invite',
      targetId: normalized,
    });
  }

  /** 注册页用的预检：只回答"能不能用"，不消耗次数 */
  check(code: string): { valid: boolean; codeValue: string; message: string | null; note: string | null } {
    const normalized = normalizeInviteCode(code);
    const row = this.#repo.find(normalized);
    const problem = inviteProblem(row);
    return {
      valid: problem === null,
      codeValue: normalized,
      message: problem?.message ?? null,
      note: problem === null ? (row?.note ?? null) : null,
    };
  }

  /**
   * 校验并**消费**一次。返回消费到的邀请码（用于审计与日志）。
   *
   * 抛 HttpError：码不存在 / 过期 / 用完 / 停用 —— 错误码见 shared 的 `ErrorCodes.INVITE_*`。
   */
  redeem(code: string, username: string): InviteCode {
    const normalized = normalizeInviteCode(code);
    if (normalized.length === 0) {
      throw new HttpError(403, ErrorCodes.INVITE_REQUIRED, '本实例需要邀请码才能注册，请向管理员索取');
    }
    // 先按规则给出**准确**的原因（不要一律报"无效"，玩家会以为自己抄错了）
    const row = this.#repo.find(normalized);
    const problem = inviteProblem(row);
    if (problem) {
      const status = problem.code === ErrorCodes.INVITE_INVALID ? 403 : 403;
      throw new HttpError(status, problem.code, problem.message);
    }
    // 再走原子扣减：并发下只有一个能成
    if (!this.#repo.redeem(normalized, username)) {
      throw new HttpError(403, ErrorCodes.INVITE_USED, '这个邀请码刚刚被用完了，请向邀请人再要一个');
    }
    const used = this.#repo.find(normalized);
    return used ? toInvite(used) : { ...toInvite(row!), usedCount: row!.used_count + 1 };
  }
}
