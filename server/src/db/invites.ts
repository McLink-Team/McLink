/**
 * 邀请码仓储（V28 的 `invites` 表）。
 *
 * 只做"跟数据库打交道"这一件事：读写行、把 `used_count` 的**原子自增**交给 SQL。
 * 判定"这个码还能不能用"的规则在 `services/invites.ts`（那里是纯逻辑，好单测）。
 */
import type { InviteCode } from '@mclink/shared';
import { Db, nowIso, toBool } from './index.ts';

export interface InviteRow {
  code: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  disabled: number;
  last_used_at: string | null;
  last_used_by: string | null;
}

export function toInvite(row: InviteRow): InviteCode {
  return {
    code: row.code,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    disabled: toBool(row.disabled),
    lastUsedAt: row.last_used_at,
    lastUsedBy: row.last_used_by,
  };
}

export interface CreateInviteRow {
  code: string;
  note: string | null;
  createdBy: string | null;
  expiresAt: string | null;
  maxUses: number;
}

export class InviteRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(input: CreateInviteRow): InviteRow {
    this.db.run(
      `insert into invites (code, note, created_by, created_at, expires_at, max_uses, used_count, disabled)
       values (?, ?, ?, ?, ?, ?, 0, 0)`,
      input.code,
      input.note,
      input.createdBy,
      nowIso(),
      input.expiresAt,
      input.maxUses,
    );
    const row = this.find(input.code);
    if (!row) throw new Error('创建邀请码后无法读回记录');
    return row;
  }

  /** 大小写不敏感：玩家手抄码时大小写几乎一定会写错 */
  find(code: string): InviteRow | undefined {
    return this.db.get<InviteRow>('select * from invites where code = ? collate nocase', code);
  }

  list(limit = 200): InviteRow[] {
    return this.db.all<InviteRow>('select * from invites order by created_at desc limit ?', limit);
  }

  /**
   * 记一次使用：**条件全写在 SQL 里**，靠 `changes` 判断是否真的占到了一次名额。
   * 这样两封请求同时用同一个一码一次邀请码时，只有一封会拿到 1。
   */
  redeem(code: string, username: string): boolean {
    const at = nowIso();
    const changes = this.db.run(
      `update invites
          set used_count = used_count + 1, last_used_at = ?, last_used_by = ?
        where code = ? collate nocase
          and disabled = 0
          and (expires_at is null or expires_at > ?)
          and (max_uses = 0 or used_count < max_uses)`,
      at,
      username,
      code,
      at,
    );
    return Number(changes.changes) > 0;
  }

  /** 停用（不删：留着才知道"这个码发出去过、后来被停了"） */
  setDisabled(code: string, disabled: boolean): boolean {
    const changes = this.db.run('update invites set disabled = ? where code = ? collate nocase', disabled ? 1 : 0, code);
    return Number(changes.changes) > 0;
  }

  /** 真删（只在明显发错、还没人用过时用；界面上默认给的是"停用"） */
  remove(code: string): boolean {
    const changes = this.db.run('delete from invites where code = ? collate nocase', code);
    return Number(changes.changes) > 0;
  }
}
