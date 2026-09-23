/**
 * 群发邮件公告。
 *
 * 三条设计约束（都是踩过或可预见的）：
 *
 * 1. **绝不能同步发**。主控有 110 秒请求看门狗，几百封信必然超时；
 *    SMTP 逐封投递本来就慢。所以 start() 只登记任务立刻返回，
 *    真正的发送在后台循环里跑，进度通过 status() 查。
 *
 * 2. **必须分批 + 间隔**。多数 SMTP 服务商对"每分钟连接数/收件人数"限流，
 *    一股脑并发会被临时封禁，甚至把发信域名拉黑。这里每批 5 封、批间 1.2 秒，
 *    并且单次运行有收件人上限（防误点把配额与域名信誉一次性打光）。
 *
 * 3. **只发给有邮箱、已验证、未封禁的用户**。给未验证地址发信除了浪费配额，
 *    还会拉高退信率 —— 退信率一高，服务商就会限制整个域名发信。
 *
 * 依赖是**显式注入**而不是拿整个 App：
 * broadcast 是在 app 组装时构造的，拿 App 会形成循环；而且这样依赖一眼看得清。
 *
 * 状态只存在内存里：公告是"发出去就完了"的一次性动作，重启后没有再查的意义；
 * 但结果写审计日志，"谁在什么时候发了什么、成功多少失败多少"可追溯。
 */

export interface BroadcastCounts {
  /** 可发送：有邮箱 + 已验证 + 未封禁 */
  deliverable: number;
  /** 有邮箱但未验证（默认不发，界面要能解释为什么人数对不上） */
  unverified: number;
  /** 有邮箱但被封禁 */
  banned: number;
  /** 已退订（点过邮件里的退订链接） */
  optedOut: number;
  /** 根本没填邮箱 */
  withoutEmail: number;
}

export interface BroadcastReport {
  id: string;
  subject: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  sent: number;
  failed: number;
  errors: Array<{ to: string; error: string }>;
  aborted: boolean;
}

export interface BroadcastPreview extends BroadcastCounts {
  running: boolean;
  lastRun: BroadcastReport | null;
}

export interface BroadcastDeps {
  mailer: {
    sendAnnouncement(to: string, subject: string, text: string): Promise<{ ok: boolean; error: string | null }>;
  };
  users: {
    /** **不受 list() 分页上限影响**：群发要的是全量收件人 */
    listBroadcastRecipients(): Array<{ id: string; email: string; displayName: string }>;
    broadcastCounts(): BroadcastCounts;
  };
  audit: {
    // 用与 AuditRepo 一致的联合类型：actorType 只能是这几个字面量，
    // 写成 string 会在组装处报类型不兼容（实测）
    write(entry: {
      actorType: 'admin' | 'user' | 'node' | 'system';
      actorId?: string | null;
      action: string;
      targetType?: string | null;
      targetId?: string | null;
      detail?: Record<string, unknown>;
    }): void;
  };
  settings: { current: { siteName: string } };
  /** 邮件正文里附的站点地址（取自安装时的 --public-url） */
  publicBaseUrl: string;
  /**
   * 生成某个收件人的退订链接。
   * 由外部注入而不是在这里做 HMAC：签名密钥属于 API 层的事，
   * 服务保持纯粹（也更好测）。
   */
  unsubscribeUrl(userId: string): string;
}

/** 单次运行的收件人上限：防止误点把配额与域名信誉一次性打光 */
const MAX_RECIPIENTS = Number(process.env.MCLINK_BROADCAST_MAX ?? 2000);
/** 每批封数与批间间隔（对 SMTP 限流的基本尊重） */
const BATCH_SIZE = 5;
const BATCH_GAP_MS = 1200;
/** 主题/正文长度上限：太长会被服务商截断或判定为垃圾邮件 */
const SUBJECT_MAX = 80;
const BODY_MAX = 4000;

export class BroadcastService {
  readonly #deps: BroadcastDeps;
  #running: BroadcastReport | null = null;
  #last: BroadcastReport | null = null;
  #abort = false;

  constructor(deps: BroadcastDeps) {
    this.#deps = deps;
  }

  preview(): BroadcastPreview {
    const counts = this.#deps.users.broadcastCounts();
    return { ...counts, running: this.#running !== null, lastRun: this.#running ?? this.#last };
  }

  status(): BroadcastReport | null {
    return this.#running ?? this.#last;
  }

  /** 中止当前运行：已发出的收不回，只能停下剩下的 */
  stop(): boolean {
    if (this.#running === null) return false;
    this.#abort = true;
    return true;
  }

  #normalize(input: { subject?: unknown; body?: unknown }): { subject: string; body: string } {
    // 主题里的换行会被部分客户端当成头注入的迹象，直接压平
    const subject = String(input.subject ?? '').replace(/[\r\n]+/g, ' ').trim();
    const body = String(input.body ?? '').replace(/\r\n/g, '\n').trim();
    if (subject.length === 0) throw new Error('主题不能为空');
    if (body.length === 0) throw new Error('正文不能为空');
    if (subject.length > SUBJECT_MAX) throw new Error(`主题最长 ${SUBJECT_MAX} 字`);
    if (body.length > BODY_MAX) throw new Error(`正文最长 ${BODY_MAX} 字`);
    return { subject, body };
  }

  /**
   * 登记并启动一次群发，**立刻返回**（发送在后台）。
   * 返回 null = 已有任务在跑，界面要提示等上一次结束（绝不排队，避免误点多次）。
   */
  start(input: { subject?: unknown; body?: unknown; actor?: string }): BroadcastReport | null {
    if (this.#running !== null) return null;
    const { subject, body } = this.#normalize(input);

    const siteName = this.#deps.settings.current.siteName || 'McLink 联机';
    const recipients = this.#deps.users.listBroadcastRecipients().slice(0, MAX_RECIPIENTS);

    const report: BroadcastReport = {
      id: `bc_${Date.now().toString(36)}`,
      subject,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      total: recipients.length,
      sent: 0,
      failed: 0,
      errors: [],
      aborted: false,
    };
    this.#running = report;
    this.#abort = false;

    this.#deps.audit.write({
      actorType: 'admin',
      actorId: input.actor ?? null,
      action: 'mail.broadcast.start',
      targetType: 'platform',
      targetId: report.id,
      detail: { subject, recipients: recipients.length },
    });

    void this.#run(recipients, subject, body, siteName, report);
    return report;
  }

  async #run(
    recipients: Array<{ id: string; email: string; displayName: string }>,
    subject: string,
    body: string,
    siteName: string,
    report: BroadcastReport,
  ): Promise<void> {
    try {
      for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        if (this.#abort) {
          report.aborted = true;
          break;
        }
        const batch = recipients.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (r) => {
            // 尾部附来源 + **退订链接**：合规要求，也直接降低被标记为垃圾邮件的比例
            const unsub = this.#deps.unsubscribeUrl(r.id);
            const tail = this.#deps.publicBaseUrl
              ? `${siteName}\n${this.#deps.publicBaseUrl}`
              : siteName;
            const text = `${body}\n\n——\n${tail}\n不想再收到公告邮件：${unsub}`;
            const res = await this.#deps.mailer.sendAnnouncement(r.email, subject, text);
            return { to: r.email, ok: res.ok, error: res.error };
          }),
        );
        for (const r of results) {
          if (r.ok) report.sent += 1;
          else {
            report.failed += 1;
            // 只留前 20 条：够管理员判断是不是配置问题，又不会把响应撑爆
            if (report.errors.length < 20) report.errors.push({ to: r.to, error: r.error ?? '未知错误' });
          }
        }
        if (i + BATCH_SIZE < recipients.length) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
      }
    } finally {
      report.finishedAt = new Date().toISOString();
      this.#last = report;
      this.#running = null;
      this.#abort = false;
      this.#deps.audit.write({
        actorType: 'system',
        actorId: null,
        action: 'mail.broadcast.finish',
        targetType: 'platform',
        targetId: report.id,
        detail: { sent: report.sent, failed: report.failed, aborted: report.aborted },
      });
    }
  }
}
