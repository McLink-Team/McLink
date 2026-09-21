/**
 * 极简 SMTP 客户端 —— 零依赖，直接用 node:net / node:tls 说协议。
 *
 * 为什么不用 nodemailer：主控至今没有任何发信需求，为了一封验证码邮件引入一个
 * 几十 KB、还在持续追踪协议演进的库不划算；而 SMTP 里真正会被我们用到的部分
 * （EHLO / STARTTLS / AUTH / MAIL / RCPT / DATA / QUIT）加起来不到 200 行。
 * 这与本项目"用 node:sqlite 而不是 better-sqlite3"的取舍是同一个理由。
 *
 * 支持：
 *   · `ssl`      —— 465 端口直连 TLS（implicit TLS）
 *   · `starttls` —— 587 端口明文起手，STARTTLS 升级后再认证
 *   · `none`     —— 不加密（只该用于本机/内网中继）
 *   · AUTH PLAIN / AUTH LOGIN（按服务器 EHLO 广告的能力挑）
 *
 * 刻意不做：DKIM 签名、附件、multipart、退信处理、连接池。
 * 正文一律 base64（见 buildMessage），因此不需要 dot-stuffing 与行长处理。
 *
 * 排障友好：任何一步失败都会抛出带 `transcript` 的错误——完整的收发对话，
 * 控制台的「发送测试邮件」直接把它显示出来。SMTP 的报错几乎全在对话里。
 */
import net from 'node:net';
import tls from 'node:tls';

export type SmtpEncryption = 'ssl' | 'starttls' | 'none';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: SmtpEncryption;
  user?: string;
  password?: string;
  /** 发件人地址（裸地址，不带显示名） */
  from: string;
  /** 发件人显示名，可选 */
  fromName?: string;
  /** EHLO 时用的主机名 */
  heloName?: string;
  timeoutMs?: number;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
}

export interface SmtpResult {
  ok: true;
  /** 完整会话记录（已脱敏：AUTH 的 base64 凭据会被替换掉） */
  transcript: string[];
  /** 服务器最后一句 250 的原文 */
  response: string;
}

export class SmtpError extends Error {
  readonly transcript: string[];
  readonly code: string;
  constructor(message: string, code: string, transcript: string[]) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.transcript = transcript;
  }
}

const CRLF = '\r\n';
const DEFAULT_TIMEOUT = 15_000;

/** 发一封信。任何协议层失败都会抛 SmtpError（带 transcript）。 */
export async function sendMail(config: SmtpConfig, mail: MailInput): Promise<SmtpResult> {
  const session = new Session(config);
  try {
    await session.connect();
    await session.greet();
    await session.ehlo();
    if (config.secure === 'starttls') {
      await session.startTls();
      await session.ehlo();
    }
    await session.authIfNeeded();
    await session.deliver(mail);
    await session.quit();
    return { ok: true, transcript: session.transcript, response: session.lastResponse };
  } catch (err) {
    if (err instanceof SmtpError) throw err;
    throw new SmtpError(
      err instanceof Error ? err.message : String(err),
      'smtp_transport_error',
      session.transcript,
    );
  } finally {
    session.destroy();
  }
}

/* ------------------------------------------------------------------ 会话 */

class Session {
  readonly transcript: string[] = [];
  lastResponse = '';
  private socket: net.Socket | null = null;
  private buffer = '';
  private waiters: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = [];
  private readonly timeoutMs: number;
  private readonly config: SmtpConfig;

  // 注意：不能用构造函数参数属性（`constructor(private readonly x)`）——
  // Node 24 的类型剥离只支持"擦除"，参数属性会直接在加载期抛
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，整个服务起不来。实测踩过两次。
  constructor(config: SmtpConfig) {
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
  }

  /* ---------------------------------------------------------- 连接与收发 */

  async connect(): Promise<void> {
    const { host, port, secure } = this.config;
    this.socket =
      secure === 'ssl'
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
        : net.connect({ host, port });

    this.socket.setEncoding('utf8');
    this.socket.setTimeout(this.timeoutMs);
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (err) => this.failAll(err));
    this.socket.on('timeout', () => this.failAll(new Error(`SMTP 读写超时（${this.timeoutMs}ms）`)));
    this.socket.on('close', () => this.failAll(new Error('SMTP 连接被对方关闭')));

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        this.transcript.push(`[连接] ${host}:${port} (${secure})`);
        resolve();
      };
      const onError = (err: Error) => reject(new Error(`无法连接 ${host}:${port} —— ${err.message}`));
      if (secure === 'ssl') {
        (this.socket as tls.TLSSocket).once('secureConnect', onReady);
      } else {
        this.socket!.once('connect', onReady);
      }
      this.socket!.once('error', onError);
    });
  }

  /** 等服务器问候（220） */
  async greet(): Promise<void> {
    await this.expect([220]);
  }

  async ehlo(): Promise<void> {
    const name = this.config.heloName ?? 'mclink.local';
    this.write(`EHLO ${name}`);
    const reply = await this.expect([250]);
    this.capabilities = parseCapabilities(reply);
    this.transcript.push(`[能力] ${[...this.capabilities.keys()].join(' ') || '(无)'}`);
  }

  capabilities = new Map<string, string>();

  /** STARTTLS：明文连接上升级为 TLS，之后必须重新 EHLO */
  async startTls(): Promise<void> {
    if (!this.capabilities.has('STARTTLS')) {
      throw this.error('服务器未广告 STARTTLS，无法在明文连接上发送凭据', 'starttls_unsupported');
    }
    this.write('STARTTLS');
    await this.expect([220]);
    await this.upgrade();
    this.transcript.push('[STARTTLS] 已升级为 TLS');
  }

  private async upgrade(): Promise<void> {
    const plain = this.socket!;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('timeout');
    plain.removeAllListeners('close');

    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect(
        { socket: plain, servername: this.config.host, rejectUnauthorized: true },
        () => resolve(s),
      );
      s.once('error', reject);
    });

    this.socket = secured;
    secured.setEncoding('utf8');
    secured.setTimeout(this.timeoutMs);
    secured.on('data', (chunk: string) => this.onData(chunk));
    secured.on('error', (err) => this.failAll(err));
    secured.on('timeout', () => this.failAll(new Error(`SMTP 读写超时（${this.timeoutMs}ms）`)));
    secured.on('close', () => this.failAll(new Error('SMTP 连接被对方关闭')));
  }

  async authIfNeeded(): Promise<void> {
    const { user, password } = this.config;
    if (!user || !password) return;
    const advertised = (this.capabilities.get('AUTH') ?? '').toUpperCase();
    // 优先 PLAIN（一次往返）；服务器只认 LOGIN 时退回去
    if (advertised === '' || advertised.includes('PLAIN')) {
      this.write(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64')}`, true);
      await this.expect([235]);
      return;
    }
    if (advertised.includes('LOGIN')) {
      this.write('AUTH LOGIN');
      await this.expect([334]);
      this.write(Buffer.from(user, 'utf8').toString('base64'), true);
      await this.expect([334]);
      this.write(Buffer.from(password, 'utf8').toString('base64'), true);
      await this.expect([235]);
      return;
    }
    throw this.error(`服务器不支持可用的认证方式（广告：${advertised || '无'}）`, 'auth_unsupported');
  }

  async deliver(mail: MailInput): Promise<void> {
    const message = buildMessage(this.config, mail);

    this.write(`MAIL FROM:<${this.config.from}>`);
    await this.expect([250]);

    this.write(`RCPT TO:<${mail.to}>`);
    await this.expect([250, 251]);

    this.write('DATA');
    await this.expect([354]);

    // 正文整体是 base64，因此不会有以 "." 开头的行，也不需要 dot-stuffing
    this.raw(message.endsWith(CRLF) ? `${message}.` : `${message}${CRLF}.`);
    await this.expect([250]);
    this.transcript.push(`[投递] 已交给服务器（${mail.to}）`);
  }

  async quit(): Promise<void> {
    try {
      this.write('QUIT');
      await this.expect([221], 3000);
    } catch {
      /* QUIT 失败不影响"信已投出去"这个事实 */
    }
  }

  destroy(): void {
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  /* -------------------------------------------------------------- 协议细节 */

  /**
   * 等一个期望的状态码。
   * SMTP 的多行响应形如 `250-...` 直到 `250 ...`，解析在 onData 里已拼好。
   */
  private async expect(codes: number[], timeoutMs = this.timeoutMs): Promise<string> {
    const reply = await this.readLine(timeoutMs);
    const code = Number.parseInt(reply.slice(0, 3), 10);
    const last = reply.split(CRLF).filter(Boolean).pop() ?? reply;
    if (!codes.includes(code)) {
      throw this.error(`服务器返回 ${code || '???'}：${last.slice(4).trim() || last}`, `smtp_${code || 'unknown'}`);
    }
    this.lastResponse = last;
    return reply;
  }

  private readLine(timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(this.error(`等待服务器响应超时（${timeoutMs}ms）`, 'smtp_timeout'));
      }, timeoutMs);
      const wrapped = (value: string) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push({ resolve: wrapped, reject });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // 一行响应可能分片到达；只有看到完整行（CRLF 结尾）才算
    let index = this.buffer.indexOf(CRLF);
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + CRLF.length);
      this.record(line);
      if (/^\d{3} /.test(line)) {
        // 末行：把从上一个命令累积的多行响应交给等待者
        const reply = this.pendingLines.length > 0 ? `${this.pendingLines.join(CRLF)}${CRLF}${line}` : line;
        this.pendingLines = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(reply);
      } else {
        this.pendingLines.push(line);
      }
      index = this.buffer.indexOf(CRLF);
    }
  }

  private pendingLines: string[] = [];

  private write(line: string, sensitive = false): void {
    const socket = this.socket;
    if (!socket) throw this.error('连接已关闭', 'smtp_disconnected');
    // 命令里可能含中文（不该有，但别让 UTF-8 撞上 non-ASCII 限制）
    this.transcript.push(sensitive ? `C: ${maskAuthLine(line)}` : `C: ${line}`);
    socket.write(`${line}${CRLF}`);
  }

  /** DATA 之后是正文，按原样写入（不再记进 transcript，避免把信件内容灌进日志） */
  private raw(payload: string): void {
    const socket = this.socket;
    if (!socket) throw this.error('连接已关闭', 'smtp_disconnected');
    this.transcript.push(`C: <${payload.length} 字节正文>`);
    socket.write(payload + CRLF);
  }

  private record(line: string): void {
    this.transcript.push(`S: ${line}`);
    if (this.transcript.length > 200) this.transcript.splice(0, this.transcript.length - 200);
  }

  private failAll(err: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  private error(message: string, code: string): SmtpError {
    return new SmtpError(message, code, this.transcript);
  }
}

/** 把 AUTH 命令里的凭据换成占位符，transcript 会显示给管理员看 */
export function maskAuthLine(line: string): string {
  if (/^AUTH PLAIN /i.test(line)) return 'AUTH PLAIN <已隐藏>';
  if (/^[A-Za-z0-9+/=]{8,}$/.test(line)) return '<已隐藏>';
  return line;
}

/** 解析 EHLO 响应里的能力行：`250-AUTH PLAIN LOGIN` → AUTH -> "PLAIN LOGIN" */
export function parseCapabilities(reply: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of reply.split(CRLF)) {
    if (line.length < 5) continue;
    const body = line.slice(4).trim();
    if (body.length === 0) continue;
    const space = body.indexOf(' ');
    const key = (space === -1 ? body : body.slice(0, space)).toUpperCase();
    const value = space === -1 ? '' : body.slice(space + 1).trim();
    out.set(key, value);
  }
  return out;
}

/* ------------------------------------------------------------------ 组信 */

/**
 * 组装一封最简 MIME 邮件。
 *
 * 两个容易被忽略但会直接坏掉中文邮件的地方，这里都处理了：
 *   1. 主题必须按 RFC 2047 编码（`=?UTF-8?B?...?=`），否则中文主题到客户端就是乱码；
 *   2. 正文用 base64，既避开 998 字节行长限制，也不需要考虑 dot-stuffing。
 */
export function buildMessage(config: SmtpConfig, mail: MailInput): string {
  const subject = encodeHeader(mail.subject);
  const from = config.fromName ? `${encodeHeader(config.fromName)} <${config.from}>` : config.from;
  const body = wrapBase64(Buffer.from(mail.text, 'utf8').toString('base64'));
  const headers = [
    `From: ${from}`,
    `To: <${mail.to}>`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId(config.from)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/** 非 ASCII 头部一律 base64 编码；纯 ASCII 原样返回（可读性更好） */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** base64 正文按 76 字符折行（RFC 2045 要求） */
function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += 76) lines.push(value.slice(i, i + 76));
  return lines.join(CRLF);
}

let messageCounter = 0;
function messageId(from: string): string {
  messageCounter = (messageCounter + 1) % 1_000_000;
  const domain = from.includes('@') ? from.slice(from.indexOf('@') + 1) : 'mclink.local';
  return `${Date.now().toString(36)}.${messageCounter.toString(36)}@${domain}`;
}
