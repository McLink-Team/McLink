/** 用户与会话仓储 */
import type { User, UserRole, UserSelf } from '@mclink/shared';
import { Db, boolToInt, nowIso, parseJson, toBool } from './index.ts';
import { shortId, sha256 } from '../util/id.ts';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  banned: number;
  email: string | null;
  email_verified: number;
  /** V10 加的列；旧库/测试夹具可能没有，读的时候按 undefined 处理 */
  email_opt_out?: number;
  quota_bytes: number | null;
  used_bytes: number;
  max_rooms: number | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    banned: toBool(row.banned),
    createdAt: row.created_at,
  };
}

function toUserSelf(row: UserRow): UserSelf {
  return {
    ...toUser(row),
    email: row.email,
    emailVerified: toBool(row.email_verified),
    emailOptOut: toBool(row.email_opt_out),
    quotaBytes: row.quota_bytes,
    usedBytes: row.used_bytes,
    maxRooms: row.max_rooms,
  };
}

export class UserRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  count(): number {
    return Number(this.db.scalar<number>('select count(*) as c from users') ?? 0);
  }

  findById(id: string): UserRow | undefined {
    return this.db.get<UserRow>('select * from users where id = ?', id);
  }

  findByUsername(username: string): UserRow | undefined {
    return this.db.get<UserRow>('select * from users where username = ? collate nocase', username);
  }

  create(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    role?: UserRole;
    email?: string | null;
    /** 显式指定邮箱验证状态；默认 false —— 只有真的验证过才是 true */
    emailVerified?: boolean;
    quotaBytes?: number | null;
    maxRooms?: number | null;
  }): UserRow {
    const id = shortId('u');
    const ts = nowIso();
    const email = input.email ?? null;
    const verified = input.emailVerified ?? false;
    this.db.run(
      `insert into users (id, username, display_name, password_hash, role, banned, email, email_verified,
        quota_bytes, used_bytes, max_rooms, created_at, updated_at)
       values (?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?)`,
      id,
      input.username,
      input.displayName,
      input.passwordHash,
      input.role ?? 'user',
      email,
      boolToInt(verified),
      input.quotaBytes ?? null,
      input.maxRooms ?? null,
      ts,
      ts,
    );
    const row = this.findById(id);
    if (!row) throw new Error('创建用户后无法读回记录');
    return row;
  }

  /** 换绑邮箱：地址变了就重新进入「待验证」，否则老邮箱的验证状态会被新地址白拿 */
  setEmail(id: string, email: string | null, verified: boolean): void {
    this.db.run(
      'update users set email = ?, email_verified = ?, updated_at = ? where id = ?',
      email,
      boolToInt(verified),
      nowIso(),
      id,
    );
  }

  markEmailVerified(id: string): void {
    this.db.run('update users set email_verified = 1, updated_at = ? where id = ?', nowIso(), id);
  }

  findByEmail(email: string): UserRow | undefined {
    return this.db.get<UserRow>('select * from users where email = ? collate nocase', email);
  }

  updatePassword(id: string, passwordHash: string): void {
    this.db.run('update users set password_hash = ?, updated_at = ? where id = ?', passwordHash, nowIso(), id);
  }

  updateProfile(id: string, fields: { displayName?: string; email?: string | null }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(fields.displayName);
    }
    if (fields.email !== undefined) {
      // 换绑邮箱要一起把验证状态打回未验证：否则改个地址就能白拿别人的验证状态
      sets.push('email = ?', 'email_verified = ?');
      params.push(fields.email, 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    this.db.run(`update users set ${sets.join(', ')} where id = ?`, ...params);
  }

  setBanned(id: string, banned: boolean): void {
    this.db.run('update users set banned = ?, updated_at = ? where id = ?', boolToInt(banned), nowIso(), id);
  }

  setRole(id: string, role: UserRole): void {
    this.db.run('update users set role = ?, updated_at = ? where id = ?', role, nowIso(), id);
  }

  setQuota(id: string, quotaBytes: number | null, maxRooms: number | null): void {
    this.db.run(
      'update users set quota_bytes = ?, max_rooms = ?, updated_at = ? where id = ?',
      quotaBytes,
      maxRooms,
      nowIso(),
      id,
    );
  }

  addUsage(id: string, bytes: number): void {
    if (bytes <= 0) return;
    this.db.run('update users set used_bytes = used_bytes + ?, updated_at = ? where id = ?', Math.round(bytes), nowIso(), id);
  }

  resetUsage(id: string): void {
    this.db.run('update users set used_bytes = 0, updated_at = ? where id = ?', nowIso(), id);
  }

  /**
   * 群发公告的收件人：有邮箱 + 已验证 + 未封禁。
   *
   * **刻意不复用 list()**：那个方法有 50 条默认上限（最大 200），
   * 拿来群发会静默地只发给前 50 个人 —— 这种"看起来成功、实际漏发"最坑。
   */
  listBroadcastRecipients(): Array<{ id: string; email: string; displayName: string }> {
    const rows = this.db.all<{ id: string; email: string; display_name: string }>(
      `select id, email, display_name from users
        where email is not null and trim(email) <> ''
          and email_verified = 1 and banned = 0 and email_opt_out = 0
        order by created_at asc`,
    );
    return rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name }));
  }

  /** 群发预览用的分组计数：让管理员明白"为什么人数对不上" */
  /** 邮件退订开关（0/1）。退订链接被点开时调用它。 */
  setEmailOptOut(userId: string, value: boolean): boolean {
    const res = this.db.run('update users set email_opt_out = ? where id = ?', value ? 1 : 0, userId);
    return Number(res.changes ?? 0) > 0;
  }
  broadcastCounts(): { deliverable: number; unverified: number; banned: number; withoutEmail: number; optedOut: number } {
    const row = this.db.get<{ deliverable: number; unverified: number; banned: number; without_email: number; opted_out: number }>(
      `select
         sum(case when email is not null and trim(email) <> '' and email_verified = 1 and banned = 0 and email_opt_out = 0 then 1 else 0 end) as deliverable,
         sum(case when email is not null and trim(email) <> '' and banned = 0 and email_verified = 0 then 1 else 0 end) as unverified,
         sum(case when banned = 1 then 1 else 0 end) as banned,
         sum(case when email is null or trim(email) = '' then 1 else 0 end) as without_email,
         sum(case when email_opt_out = 1 then 1 else 0 end) as opted_out
       from users`,
    );
    return {
      deliverable: Number(row?.deliverable ?? 0),
      unverified: Number(row?.unverified ?? 0),
      banned: Number(row?.banned ?? 0),
      withoutEmail: Number(row?.without_email ?? 0),
      optedOut: Number(row?.opted_out ?? 0),
    };
  }
  list(options: { search?: string; limit?: number; offset?: number } = {}): { rows: UserRow[]; total: number } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const search = options.search?.trim();
    if (search) {
      const like = `%${search}%`;
      /**
       * 搜索也匹配邮箱。
       *
       * 管理员拿到的线索常常就是邮箱（玩家报问题、SMTP 退信、公告退订），
       * 只能按用户名找的话等于白给一条线索。
       */
      const rows = this.db.all<UserRow>(
        'select * from users where username like ? or display_name like ? or email like ? order by created_at desc limit ? offset ?',
        like,
        like,
        like,
        limit,
        offset,
      );
      const total = Number(
        this.db.scalar<number>(
          'select count(*) as c from users where username like ? or display_name like ? or email like ?',
          like,
          like,
          like,
        ) ?? 0,
      );
      return { rows, total };
    }
    const rows = this.db.all<UserRow>('select * from users order by created_at desc limit ? offset ?', limit, offset);
    return { rows, total: this.count() };
  }

  toUser(row: UserRow): User {
    return toUser(row);
  }

  toSelf(row: UserRow): UserSelf {
    return toUserSelf(row);
  }

  /* ------------------------------------------------------------- 会话 */

  createSession(input: {
    userId: string;
    token: string;
    ttlSeconds: number;
    ip: string | null;
    userAgent: string | null;
  }): SessionRow {
    const id = shortId('s');
    const ts = nowIso();
    const expires = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    this.db.run(
      `insert into sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      sha256(input.token),
      ts,
      expires,
      ts,
      input.ip,
      input.userAgent,
    );
    return this.db.get<SessionRow>('select * from sessions where id = ?', id)!;
  }

  findSessionByToken(token: string): SessionRow | undefined {
    return this.db.get<SessionRow>('select * from sessions where token_hash = ?', sha256(token));
  }

  touchSession(id: string): void {
    this.db.run('update sessions set last_seen_at = ? where id = ?', nowIso(), id);
  }

  deleteSession(token: string): void {
    this.db.run('delete from sessions where token_hash = ?', sha256(token));
  }

  deleteSessionsForUser(userId: string): void {
    this.db.run('delete from sessions where user_id = ?', userId);
  }

  /**
   * 分批清理过期会话，返回本批删除的行数。
   *
   * 以前是一条无界的 `delete from sessions where expires_at < ?`：sessions 表一大，
   * 这一条就会在**单次同步调用**里删完所有过期行，事件循环被按住几秒到几十秒 ——
   * 期间主控连新 TCP 连接都排不进 accept 队列，nginx 侧报
   * `upstream timed out (110) while connecting to upstream`（线上实测到过这个现象）。
   * 现在与 traffic/chat 的清理保持一致：调用方循环、批间让出事件循环。
   */
  pruneExpiredSessions(limit = 2000): number {
    const res = this.db.run(
      'delete from sessions where rowid in (select rowid from sessions where expires_at < ? limit ?)',
      nowIso(),
      Math.max(1, Math.trunc(limit)),
    );
    return Number(res.changes ?? 0);
  }
}

export interface EnrollKeyRow {
  key: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  used_at: string | null;
  used_by: string | null;
  revoked: number;
}

export class EnrollKeyRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(key: string, note: string | null, createdBy: string | null): EnrollKeyRow {
    this.db.run(
      'insert into enroll_keys (key, note, created_by, created_at, used_at, used_by, revoked) values (?, ?, ?, ?, null, null, 0)',
      key,
      note,
      createdBy,
      nowIso(),
    );
    return this.db.get<EnrollKeyRow>('select * from enroll_keys where key = ?', key)!;
  }

  find(key: string): EnrollKeyRow | undefined {
    return this.db.get<EnrollKeyRow>('select * from enroll_keys where key = ?', key);
  }

  markUsed(key: string, nodeId: string): void {
    this.db.run('update enroll_keys set used_at = ?, used_by = ? where key = ?', nowIso(), nodeId, key);
  }

  revoke(key: string): void {
    this.db.run('update enroll_keys set revoked = 1 where key = ?', key);
  }

  list(limit = 50): EnrollKeyRow[] {
    return this.db.all<EnrollKeyRow>('select * from enroll_keys order by created_at desc limit ?', limit);
  }
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export class SettingsRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.get<SettingRow>('select * from settings where key = ?', key);
    if (!row) return fallback;
    return parseJson<T>(row.value, fallback);
  }

  set(key: string, value: unknown): void {
    this.db.run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      nowIso(),
    );
  }

  all(): Record<string, unknown> {
    const rows = this.db.all<SettingRow>('select * from settings');
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = parseJson<unknown>(row.value, null);
    return out;
  }
}

export interface EmailCodeRow {
  id: string;
  user_id: string;
  email: string;
  code_hash: string;
  purpose: string;
  attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * 邮箱验证码仓储。
 *
 * 安全约定：
 *   · 只存 `sha256(code + user_id)`，不存明文——库被读走也换不出验证码；
 *   · 校验用时间常量比较（见 AuthService.verifyEmail），避免按比较耗时猜码；
 *   · 每次签发前把该用户旧的未用码标记为作废，保证"同时只有一个有效码"。
 */
export class EmailCodeRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  issue(input: { userId: string; email: string; codeHash: string; ttlMinutes: number }): EmailCodeRow {
    const id = shortId('ec');
    const ts = nowIso();
    const expires = new Date(Date.now() + input.ttlMinutes * 60_000).toISOString();
    // 旧码立刻作废：否则用户拿到两封邮件，两串码都可能被接受
    this.db.run(
      `update email_codes set consumed_at = ? where user_id = ? and consumed_at is null`,
      ts,
      input.userId,
    );
    this.db.run(
      `insert into email_codes (id, user_id, email, code_hash, purpose, attempts, created_at, expires_at, consumed_at)
       values (?, ?, ?, ?, 'verify', 0, ?, ?, null)`,
      id,
      input.userId,
      input.email,
      input.codeHash,
      ts,
      expires,
    );
    const row = this.db.get<EmailCodeRow>('select * from email_codes where id = ?', id);
    if (!row) throw new Error('写入验证码后无法读回记录');
    return row;
  }

  /** 最近一条还有效的验证码（未消费、未过期） */
  findActive(userId: string): EmailCodeRow | undefined {
    return this.db.get<EmailCodeRow>(
      `select * from email_codes
       where user_id = ? and consumed_at is null and expires_at > ?
       order by created_at desc limit 1`,
      userId,
      nowIso(),
    );
  }

  /** 最近一条验证码，不管是否过期/已用（用于告诉用户"码过期了，请重发"） */
  findLatest(userId: string): EmailCodeRow | undefined {
    return this.db.get<EmailCodeRow>(
      'select * from email_codes where user_id = ? order by created_at desc limit 1',
      userId,
    );
  }

  bumpAttempts(id: string): void {
    this.db.run('update email_codes set attempts = attempts + 1 where id = ?', id);
  }

  consume(id: string): void {
    this.db.run('update email_codes set consumed_at = ? where id = ?', nowIso(), id);
  }

  /** 限流用：该用户/该邮箱在时间窗内签发过几次 */
  countSince(by: { userId?: string; email?: string }, sinceIso: string): number {
    if (by.userId) {
      return Number(
        this.db.scalar<number>(
          'select count(*) as c from email_codes where user_id = ? and created_at > ?',
          by.userId,
          sinceIso,
        ) ?? 0,
      );
    }
    return Number(
      this.db.scalar<number>(
        'select count(*) as c from email_codes where email = ? and created_at > ?',
        by.email ?? '',
        sinceIso,
      ) ?? 0,
    );
  }

  /** 清理过期记录，由后台定时器调用 */
  purgeExpired(beforeIso: string): number {
    const before = this.db.scalar<number>('select count(*) as c from email_codes where expires_at < ?', beforeIso) ?? 0;
    this.db.run('delete from email_codes where expires_at < ?', beforeIso);
    return Number(before);
  }
}

export interface MetaRepo {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export class MetaStore implements MetaRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(key: string): string | undefined {
    const row = this.db.get<{ value: string }>('select value from meta where key = ?', key);
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db.run(
      `insert into meta (key, value) values (?, ?)
       on conflict(key) do update set value = excluded.value`,
      key,
      value,
    );
  }
}
