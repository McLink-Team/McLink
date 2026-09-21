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
    quotaBytes?: number | null;
    maxRooms?: number | null;
  }): UserRow {
    const id = shortId('u');
    const ts = nowIso();
    this.db.run(
      `insert into users (id, username, display_name, password_hash, role, banned, email,
        quota_bytes, used_bytes, max_rooms, created_at, updated_at)
       values (?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?)`,
      id,
      input.username,
      input.displayName,
      input.passwordHash,
      input.role ?? 'user',
      input.email ?? null,
      input.quotaBytes ?? null,
      input.maxRooms ?? null,
      ts,
      ts,
    );
    const row = this.findById(id);
    if (!row) throw new Error('创建用户后无法读回记录');
    return row;
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
      sets.push('email = ?');
      params.push(fields.email);
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

  list(options: { search?: string; limit?: number; offset?: number } = {}): { rows: UserRow[]; total: number } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const search = options.search?.trim();
    if (search) {
      const like = `%${search}%`;
      const rows = this.db.all<UserRow>(
        'select * from users where username like ? or display_name like ? order by created_at desc limit ? offset ?',
        like,
        like,
        limit,
        offset,
      );
      const total = Number(
        this.db.scalar<number>(
          'select count(*) as c from users where username like ? or display_name like ?',
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

  purgeExpiredSessions(): number {
    const res = this.db.run('delete from sessions where expires_at < ?', nowIso());
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
