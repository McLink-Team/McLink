/** 账号服务：注册、登录、会话、改密 */
import { ErrorCodes, passwordProblem, USERNAME_PATTERN } from '@mclink/shared';
import { HttpError } from '../util/errors.ts';
import { hashPassword, newToken, verifyPassword } from '../util/id.ts';
import { logger } from '../logger.ts';
import { AuditRepo } from '../db/traffic.ts';
import { UserRepo, type UserRow } from '../db/users.ts';
import type { ServerConfig } from '../config.ts';
import type { SettingsService } from './settings.ts';

const log = logger('auth');

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: ReturnType<UserRepo['toSelf']>;
}

export class AuthService {
  private readonly config: ServerConfig;
  private readonly users: UserRepo;
  private readonly audit: AuditRepo;
  private readonly settings: SettingsService;

  constructor(config: ServerConfig, users: UserRepo, audit: AuditRepo, settings: SettingsService) {
    this.config = config;
    this.users = users;
    this.audit = audit;
    this.settings = settings;
  }

  async register(input: {
    username: string;
    password: string;
    displayName?: string;
    ip: string;
  }): Promise<LoginResult> {
    const s = this.settings.current;
    if (!s.registrationOpen && this.users.count() > 0) {
      throw new HttpError(403, ErrorCodes.REGISTRATION_CLOSED, '当前未开放注册，请联系管理员开号');
    }
    if (!USERNAME_PATTERN.test(input.username)) {
      throw HttpError.badRequest('用户名只能是 3-24 位字母、数字或下划线', {
        username: '用户名只能是 3-24 位字母、数字或下划线',
      });
    }
    const pwProblem = passwordProblem(input.password);
    if (pwProblem) throw HttpError.badRequest(pwProblem, { password: pwProblem });

    if (this.users.findByUsername(input.username)) {
      throw new HttpError(409, ErrorCodes.CONFLICT, '该用户名已被占用', { username: '该用户名已被占用' });
    }

    const passwordHash = await hashPassword(input.password);
    const isFirstUser = this.users.count() === 0;
    const row = this.users.create({
      username: input.username,
      displayName: input.displayName?.trim() || input.username,
      passwordHash,
      role: isFirstUser ? 'admin' : 'user',
      quotaBytes: s.defaultQuotaBytes,
      maxRooms: s.defaultMaxRooms,
    });

    this.audit.write({
      actorType: 'user',
      actorId: row.id,
      actorName: row.username,
      action: 'auth.register',
      targetType: 'user',
      targetId: row.id,
      ip: input.ip,
    });
    log.info('新用户注册', { username: row.username, first: isFirstUser });

    return this.#issue(row, input.ip, null);
  }

  async login(input: { username: string; password: string; ip: string; userAgent: string | null }): Promise<LoginResult> {
    const row = this.users.findByUsername(input.username);
    // 用户名不存在时也走一次哈希校验，避免通过响应时间枚举用户
    const stored = row?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(input.password, stored);
    if (!row || !ok) {
      this.audit.write({
        actorType: 'user',
        actorId: row?.id ?? null,
        actorName: input.username,
        action: 'auth.login_failed',
        ip: input.ip,
      });
      throw HttpError.unauthorized('用户名或密码错误');
    }
    if (row.banned === 1) throw HttpError.forbidden('账号已被封禁');

    this.audit.write({
      actorType: 'user',
      actorId: row.id,
      actorName: row.username,
      action: 'auth.login',
      ip: input.ip,
    });
    return this.#issue(row, input.ip, input.userAgent);
  }

  logout(token: string): void {
    this.users.deleteSession(token);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const row = this.users.findById(userId);
    if (!row) throw HttpError.unauthorized();
    if (!(await verifyPassword(oldPassword, row.password_hash))) {
      throw HttpError.badRequest('原密码不正确', { oldPassword: '原密码不正确' });
    }
    const problem = passwordProblem(newPassword);
    if (problem) throw HttpError.badRequest(problem, { newPassword: problem });
    this.users.updatePassword(userId, await hashPassword(newPassword));
    // 改密后强制其它会话下线
    this.users.deleteSessionsForUser(userId);
    this.audit.write({
      actorType: 'user',
      actorId: userId,
      actorName: row.username,
      action: 'auth.change_password',
      ip: null,
    });
  }

  /** 由令牌解析会话所属用户 */
  resolveSession(token: string): { token: string; user: UserRow } | null {
    const session = this.users.findSessionByToken(token);
    if (!session) return null;
    if (session.expires_at < new Date().toISOString()) {
      this.users.deleteSession(token);
      return null;
    }
    const user = this.users.findById(session.user_id);
    if (!user || user.banned === 1) return null;
    return { token, user };
  }

  #issue(row: UserRow, ip: string, userAgent: string | null): LoginResult {
    const token = newToken();
    const session = this.users.createSession({
      userId: row.id,
      token,
      ttlSeconds: this.config.tokenTtlSeconds,
      ip,
      userAgent,
    });
    return {
      token,
      expiresAt: session.expires_at,
      user: this.users.toSelf(row),
    };
  }
}
