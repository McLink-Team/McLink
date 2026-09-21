/**
 * 邮件服务：把平台设置翻译成 SMTP 会话，并记录最近几次发信结果。
 *
 * 它只做三件事：判断"配没配"、拼验证码邮件、把失败原因（含完整会话）留给人看。
 * 真正的协议在 `server/src/mail/smtp.ts`，这里不碰 socket。
 */
import { logger } from '../logger.ts';
import { sendMail, SmtpError, type SmtpConfig } from '../mail/smtp.ts';
import type { SettingsService } from './settings.ts';

const log = logger('mailer');

/** 最近一次发信的结果，控制台用它显示"上次发信为什么失败" */
export interface MailAttempt {
  at: string;
  to: string;
  kind: 'verify' | 'test';
  ok: boolean;
  error: string | null;
  /** 失败时才有：完整 SMTP 会话（已脱敏） */
  transcript: string[] | null;
}

export class MailerService {
  private readonly settings: SettingsService;
  private readonly history: MailAttempt[] = [];
  private static readonly HISTORY_LIMIT = 20;

  constructor(settings: SettingsService) {
    this.settings = settings;
  }

  /** 邮件服务是否可用：地址、端口、发件人齐了才算配置完成 */
  get configured(): boolean {
    const s = this.settings.current;
    return s.smtpHost.trim().length > 0 && s.smtpPort > 0 && resolveFrom(s.smtpFrom, s.smtpUser).address.length > 0;
  }

  /** 给控制台看的概览（不含密码） */
  describe(): {
    configured: boolean;
    host: string;
    port: number;
    secure: string;
    user: string;
    from: string;
    passwordSet: boolean;
    requireEmailVerification: boolean;
    codeTtlMinutes: number;
    lastAttempt: MailAttempt | null;
  } {
    const s = this.settings.current;
    return {
      configured: this.configured,
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpSecure,
      user: s.smtpUser,
      from: resolveFrom(s.smtpFrom, s.smtpUser).display,
      passwordSet: typeof s.smtpPassword === 'string' && s.smtpPassword.length > 0,
      requireEmailVerification: s.requireEmailVerification,
      codeTtlMinutes: s.emailCodeTtlMinutes,
      lastAttempt: this.history.at(-1) ?? null,
    };
  }

  recent(): MailAttempt[] {
    return [...this.history].reverse();
  }

  /**
   * 寄验证码。
   * 失败不抛异常——注册流程不该因为邮件服务器抽风而整个失败，
   * 调用方拿到 `ok:false` 后会把错误显示给用户并允许重发。
   */
  async sendVerificationCode(to: string, code: string, ttlMinutes: number): Promise<MailAttempt> {
    const subject = `${this.settings.current.siteName} 邮箱验证码`;
    const text = [
      `你的验证码是：${code}`,
      '',
      `请在 ${ttlMinutes} 分钟内回到客户端或网页输入它完成验证。`,
      '如果不是你本人操作，忽略这封邮件即可，账号不会有任何变化。',
      '',
      `—— ${this.settings.current.siteName}`,
    ].join('\n');
    return this.#send('verify', to, subject, text);
  }

  /** 管理员在控制台点「发送测试邮件」 */
  async sendTest(to: string): Promise<MailAttempt> {
    const s = this.settings.current;
    const text = [
      '这是一封来自 mclink 主控的测试邮件。',
      '',
      `时间：${new Date().toISOString()}`,
      `服务器：${s.smtpHost}:${s.smtpPort}（${s.smtpSecure}）`,
      `发件人：${resolveFrom(s.smtpFrom, s.smtpUser).display}`,
      '',
      '收到它就说明 SMTP 配置可用；如果没收到，请检查垃圾箱与发件域名的 SPF/DKIM。',
    ].join('\n');
    return this.#send('test', to, `${s.siteName} SMTP 测试邮件`, text);
  }

  async #send(kind: 'verify' | 'test', to: string, subject: string, text: string): Promise<MailAttempt> {
    const s = this.settings.current;
    const from = resolveFrom(s.smtpFrom, s.smtpUser);
    const attempt: MailAttempt = {
      at: new Date().toISOString(),
      to,
      kind,
      ok: false,
      error: null,
      transcript: null,
    };

    if (!this.configured) {
      attempt.error = '邮件服务未配置：请先在控制台「平台设置 → 邮件服务」里填 SMTP 地址与发件人';
      this.#push(attempt);
      return attempt;
    }

    const config: SmtpConfig = {
      host: s.smtpHost.trim(),
      port: s.smtpPort,
      secure: s.smtpSecure,
      user: s.smtpUser.trim() || undefined,
      password: s.smtpPassword ?? undefined,
      from: from.address,
      fromName: from.name || undefined,
      heloName: heloName(),
    };

    try {
      const result = await sendMail(config, { to, subject, text });
      attempt.ok = true;
      log.info('邮件已投递', { kind, to, host: config.host });
      this.#push(attempt);
      return attempt;
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : String(err);
      attempt.transcript = err instanceof SmtpError ? err.transcript : null;
      log.warn('邮件投递失败', { kind, to, host: config.host, error: attempt.error });
      this.#push(attempt);
      return attempt;
    }
  }

  #push(attempt: MailAttempt): void {
    this.history.push(attempt);
    if (this.history.length > MailerService.HISTORY_LIMIT) this.history.shift();
  }
}

/**
 * 把发件人拆成"裸地址 + 显示名"。
 * 允许管理员写成 `mclink <no-reply@cnnic.link>` 或只写 `no-reply@cnnic.link`；
 * 没写发件人时退回 SMTP 账号（很多邮件服务要求两者一致）。
 */
export function resolveFrom(rawFrom: string, user: string): { address: string; name: string; display: string } {
  const raw = rawFrom.trim() || user.trim();
  const angled = /^(.*?)<([^>]+)>\s*$/.exec(raw);
  const name = (angled?.[1] ?? '').trim().replace(/^"|"$/g, '');
  const address = (angled?.[2] ?? raw).trim();
  return { address, name, display: name ? `${name} <${address}>` : address };
}

/** EHLO 里报的主机名：优先用发件域的域名，退到本机名 */
function heloName(): string {
  return process.env.MCLINK_SMTP_HELO ?? 'mclink.local';
}
