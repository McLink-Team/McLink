/** 账号服务：注册、登录、会话、改密、邮箱验证 */
import { ErrorCodes, displayNameProblem, emailProblem, normalizeEmailCode, EMAIL_CODE_PATTERN, passwordProblem, USERNAME_PATTERN } from '@mclink/shared';
import { HttpError } from '../util/errors.ts';
import { hashPassword, newToken, randInt, safeEqual, sha256, verifyPassword } from '../util/id.ts';
import { logger } from '../logger.ts';
import { AuditRepo } from '../db/traffic.ts';
import { EmailCodeRepo, UserRepo, type UserRow } from '../db/users.ts';
import { assertEmailVerified } from './email-gate.ts';
import type { ServerConfig } from '../config.ts';
import type { SettingsService } from './settings.ts';
import type { MailAttempt, MailerService } from './mailer.ts';

const log = logger('auth');

/** 同一账号两次要码的最小间隔 / 每小时上限 */
const RESEND_INTERVAL_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 6;
const MAX_ATTEMPTS_PER_CODE = 5;

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: ReturnType<UserRepo['toSelf']>;
  /**
   * 注册时顺带寄验证码的结果。
   * 邮件失败**不会**让注册失败——账号已经建好了，界面提示"重发"比报一个错更有用。
   */
  emailSent?: boolean;
  emailError?: string | null;
  emailCodeExpiresAt?: string | null;
}

export interface EmailStatus {
  email: string | null;
  verified: boolean;
  /** 当前有效验证码的过期时间；没有则为 null */
  codeExpiresAt: string | null;
  /** 还要等多少秒才能重发（0 = 现在就能发） */
  resendAfterSeconds: number;
  /** 平台是否要求验证邮箱才能建房/进房 */
  required: boolean;
}

export class AuthService {
  private readonly config: ServerConfig;
  private readonly users: UserRepo;
  private readonly audit: AuditRepo;
  private readonly settings: SettingsService;
  private readonly codes: EmailCodeRepo;
  private readonly mailer: MailerService;

  constructor(
    config: ServerConfig,
    users: UserRepo,
    audit: AuditRepo,
    settings: SettingsService,
    codes: EmailCodeRepo,
    mailer: MailerService,
  ) {
    this.config = config;
    this.users = users;
    this.audit = audit;
    this.settings = settings;
    this.codes = codes;
    this.mailer = mailer;
  }

  async register(input: {
    username: string;
    password: string;
    displayName?: string;
    email?: string;
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

    const email = (input.email ?? '').trim();
    if (s.requireEmailVerification) {
      if (email.length === 0) {
        throw new HttpError(400, ErrorCodes.EMAIL_REQUIRED, '本平台要求验证邮箱，请填写邮箱地址', {
          email: '请填写邮箱地址',
        });
      }
      // 开关打开却没有邮件服务时，明确告诉管理员去配，而不是让玩家卡在收不到码的死循环里
      if (!this.mailer.configured) {
        throw new HttpError(
          503,
          ErrorCodes.SMTP_NOT_CONFIGURED,
          '平台要求验证邮箱，但主控尚未配置邮件服务，请联系管理员',
        );
      }
    }
    if (email.length > 0) {
      this.assertEmailUsable(email, null);
    }

    /**
     * 显示名与改资料那一侧同一条规则（shared 的 `displayNameProblem`）：
     * 保留词 + 反冒充。注册是**另一个入口**，只堵 PATCH 等于留了扇后门。
     *
     * 只校验用户真的填了昵称的情况：留空时显示名回落到用户名，用户名有自己的
     * 字符集与唯一性规则，不属于本次范围（而且注册表单里那一栏本来就是"可选"）。
     */
    const displayName = input.displayName?.trim() ?? '';
    if (displayName.length > 0) {
      const problem = displayNameProblem(displayName, { takenDisplayNames: this.users.displayNames() });
      if (problem) throw HttpError.badRequest(problem, { displayName: problem });
    }

    const passwordHash = await hashPassword(input.password);
    const isFirstUser = this.users.count() === 0;
    const row = this.users.create({
      username: input.username,
      displayName: displayName || input.username,
      passwordHash,
      role: isFirstUser ? 'admin' : 'user',
      email: email.length > 0 ? email : null,
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
      detail: { email: row.email, emailVerificationRequired: s.requireEmailVerification },
    });
    log.info('新用户注册', { username: row.username, first: isFirstUser, email: row.email });

    const result = this.#issue(row, input.ip, null);
    // 填了邮箱就顺手发码（即使平台不强制验证，也让用户能自己把邮箱验掉）
    if (row.email) {
      const sent = await this.#sendCode(row, input.ip, 'register');
      return { ...result, emailSent: sent.ok, emailError: sent.error, emailCodeExpiresAt: sent.expiresAt };
    }
    return result;
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

  /* ---------------------------------------------------------- 邮箱验证 */

  /**
   * 开始验证：绑定（或换绑）邮箱并寄出验证码。
   * 换绑已有账号的邮箱时同样要求重新验证——邮箱是找回账号的凭据，不能白拿。
   */
  async startEmailVerification(
    userId: string,
    rawEmail: string,
    ip: string,
  ): Promise<{ email: string; expiresAt: string | null; sent: boolean; error: string | null }> {
    const row = this.users.findById(userId);
    if (!row) throw HttpError.unauthorized();

    const email = rawEmail.trim();
    const problem = emailProblem(email);
    if (problem) throw HttpError.badRequest(problem, { email: problem });
    this.assertEmailUsable(email, userId);

    if (!this.mailer.configured) {
      throw new HttpError(
        503,
        ErrorCodes.SMTP_NOT_CONFIGURED,
        '主控尚未配置邮件服务（SMTP），无法发送验证码，请联系管理员',
      );
    }

    // 换绑：先把邮箱写进去并置为未验证，再把码发到新地址
    if (row.email?.toLowerCase() !== email.toLowerCase() || row.email_verified !== 1) {
      this.users.setEmail(userId, email, false);
    }

    const fresh = this.users.findById(userId)!;
    const sent = await this.#sendCode(fresh, ip, 'start');
    return { email, expiresAt: sent.expiresAt, sent: sent.ok, error: sent.error };
  }

  /** 提交验证码 */
  verifyEmail(userId: string, rawCode: string, ip: string): { ok: true; user: ReturnType<UserRepo['toSelf']> } {
    const row = this.users.findById(userId);
    if (!row) throw HttpError.unauthorized();
    if (!row.email) throw HttpError.badRequest('请先填写邮箱地址', { email: '请先填写邮箱地址' });

    const code = normalizeEmailCode(rawCode);
    if (!EMAIL_CODE_PATTERN.test(code)) {
      throw new HttpError(400, ErrorCodes.EMAIL_CODE_INVALID, '验证码是 6 位数字', { code: '验证码是 6 位数字' });
    }

    const active = this.codes.findActive(userId);
    if (!active) {
      const latest = this.codes.findLatest(userId);
      throw new HttpError(
        400,
        ErrorCodes.EMAIL_CODE_INVALID,
        latest ? '验证码已过期，请重新发送' : '还没有发送过验证码，请先获取验证码',
        { code: latest ? '验证码已过期，请重新发送' : '请先获取验证码' },
      );
    }
    if (active.attempts >= MAX_ATTEMPTS_PER_CODE) {
      this.codes.consume(active.id);
      throw new HttpError(429, ErrorCodes.RATE_LIMITED, '尝试次数过多，请重新发送验证码', {
        code: '尝试次数过多，请重新发送',
      });
    }
    // 码是往邮箱里发的，目标地址换了就不能再用旧码
    if (row.email.toLowerCase() !== active.email.toLowerCase()) {
      throw new HttpError(400, ErrorCodes.EMAIL_CODE_INVALID, '邮箱已变更，请重新发送验证码', {
        code: '邮箱已变更，请重新发送',
      });
    }

    const expected = sha256(`${code}:${userId}`);
    if (!safeEqual(expected, active.code_hash)) {
      this.codes.bumpAttempts(active.id);
      const left = MAX_ATTEMPTS_PER_CODE - (active.attempts + 1);
      throw new HttpError(400, ErrorCodes.EMAIL_CODE_INVALID, '验证码不正确', {
        code: left > 0 ? `验证码不正确，还可以试 ${left} 次` : '验证码不正确，请重新发送',
      });
    }

    this.codes.consume(active.id);
    this.users.markEmailVerified(userId);
    this.audit.write({
      actorType: 'user',
      actorId: userId,
      actorName: row.username,
      action: 'auth.email_verified',
      targetType: 'user',
      targetId: userId,
      ip,
      detail: { email: row.email },
    });
    log.info('邮箱验证通过', { username: row.username, email: row.email });
    return { ok: true, user: this.users.toSelf(this.users.findById(userId)!) };
  }

  /** 给界面用的状态：验没验、还能不能重发、码什么时候过期 */
  emailStatus(userId: string): EmailStatus {
    const row = this.users.findById(userId);
    if (!row) throw HttpError.unauthorized();
    const active = this.codes.findActive(userId);
    const latest = active ?? this.codes.findLatest(userId);
    const resendAfter = latest
      ? Math.max(0, RESEND_INTERVAL_SECONDS - Math.floor((Date.now() - Date.parse(latest.created_at)) / 1000))
      : 0;
    return {
      email: row.email,
      verified: row.email_verified === 1,
      codeExpiresAt: active?.expires_at ?? null,
      resendAfterSeconds: resendAfter,
      required: this.settings.current.requireEmailVerification,
    };
  }

  /**
   * 建房/进房前的门禁。
   * 规则本体在 `email-gate.ts`，房间服务用的是同一个函数——避免两处判定漂移。
   */
  assertEmailVerified(userId: string): void {
    const row = this.users.findById(userId);
    if (!row) throw HttpError.unauthorized();
    assertEmailVerified(row, this.settings.current.requireEmailVerification);
  }

  /** 邮箱是否可被这个账号使用（格式之外还有唯一性） */
  private assertEmailUsable(email: string, selfUserId: string | null): void {
    const owner = this.users.findByEmail(email);
    if (owner && owner.id !== selfUserId) {
      throw new HttpError(409, ErrorCodes.EMAIL_TAKEN, '该邮箱已被其它账号绑定', { email: '该邮箱已被其它账号绑定' });
    }
  }

  /** 生成并寄出验证码，附带限流 */
  async #sendCode(
    row: UserRow,
    ip: string,
    reason: 'register' | 'start',
  ): Promise<{ ok: boolean; error: string | null; expiresAt: string | null }> {
    const email = row.email;
    if (!email) return { ok: false, error: '该账号没有邮箱', expiresAt: null };

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const last = this.codes.findLatest(row.id);
    if (last && Date.now() - Date.parse(last.created_at) < RESEND_INTERVAL_SECONDS * 1000) {
      const wait = RESEND_INTERVAL_SECONDS - Math.floor((Date.now() - Date.parse(last.created_at)) / 1000);
      throw new HttpError(429, ErrorCodes.RATE_LIMITED, `请求过于频繁，请 ${wait} 秒后再试`, {
        code: `请 ${wait} 秒后再试`,
      });
    }
    if (this.codes.countSince({ userId: row.id }, hourAgo) >= MAX_SENDS_PER_HOUR) {
      throw new HttpError(429, ErrorCodes.RATE_LIMITED, '本小时发送次数过多，请稍后再试');
    }

    const ttl = this.settings.current.emailCodeTtlMinutes;
    const code = String(randInt(1_000_000)).padStart(6, '0');
    const record = this.codes.issue({
      userId: row.id,
      email,
      codeHash: sha256(`${code}:${row.id}`),
      ttlMinutes: ttl,
    });

    const attempt: MailAttempt = await this.mailer.sendVerificationCode(email, code, ttl);
    this.audit.write({
      actorType: 'user',
      actorId: row.id,
      actorName: row.username,
      action: attempt.ok ? 'auth.email_code_sent' : 'auth.email_code_failed',
      targetType: 'user',
      targetId: row.id,
      ip,
      detail: { email, reason, error: attempt.error },
    });
    if (!attempt.ok) {
      // 发不出去就把这条码作废，免得占着"1 分钟才能重发"的窗口
      this.codes.consume(record.id);
      return { ok: false, error: attempt.error, expiresAt: null };
    }
    return { ok: true, error: null, expiresAt: record.expires_at };
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
