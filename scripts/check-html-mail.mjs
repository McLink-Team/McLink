#!/usr/bin/env node
/**
 * 活体检查：**HTML 群发到底发出去的是什么**。
 *
 * 为什么需要（不能只靠单测）：单测钉的是 `buildMessage` 拼出来的字符串；
 * 而真正会坏的地方在链路上 —— 主控 → SMTP → 收件人看到的正文。
 * 这里起一个**真实的最小 SMTP 服务器**（收到 DATA 就把整封信存下来），
 * 然后走主控公开接口发一封 HTML 公告，最后断言：
 *   1. 信件是 multipart/alternative；
 *   2. 解出来的 text 与 html 两段都在，且中文没坏；
 *   3. 两段都带上了自动追加的站点署名与退订链接（HTML 里是可点的 <a>）；
 *   4. 纯文本模式（不勾 HTML）仍然是单段 text/plain。
 *
 * 用法（需要主控在跑；只发给自己）：
 *   node scripts/check-html-mail.mjs --base http://127.0.0.1:8787 --password <管理员密码>
 *   node scripts/check-html-mail.mjs --help
 *
 * ⚠️ 收件人是**本脚本注册的临时账号**（邮箱随便造，因为 SMTP 就是我们自己起的），
 * 跑完即封禁；SMTP 设置跑完还原。
 */
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法：node scripts/check-html-mail.mjs [--base http://127.0.0.1:8787] [--password <管理员密码>]

需要主控在跑（pnpm dev:server），并且管理员密码通过 --password 或 MCLINK_ADMIN_PASSWORD 给出。
脚本自己起一个最小 SMTP 服务器当"收件服务器"，把主控发出来的原始信件抓下来断言。`);
  process.exit(0);
}
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf('--base', process.env.MCLINK_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const PASSWORD = argOf('--password', process.env.MCLINK_ADMIN_PASSWORD ?? '');
if (!PASSWORD) {
  console.error('缺管理员密码：--password 或 MCLINK_ADMIN_PASSWORD');
  process.exit(1);
}

const RUN = Math.random().toString(36).slice(2, 8);
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
};

/* ------------------------------------------------ 一个够用的 SMTP 收信服务器 */

/** 收到的原始信件（每封一条） */
const captured = [];

function startSmtp() {
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    let raw = '';
    socket.setEncoding('utf8');
    socket.write('220 mclink-check ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            captured.push(raw);
            raw = '';
            socket.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          // 去掉 dot-stuffing（发信端会加，收信端要还回来）
          raw += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-mclink-check\r\n250-AUTH PLAIN LOGIN\r\n250 SMTPUTF8\r\n');
        } else if (upper.startsWith('AUTH')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ 主控调用 */

/** 主控的接口前缀是 `/api/v1`（`packages/shared/src/protocol.ts` 的 API_PREFIX），别漏 */
const API = `${BASE}/api/v1`;

async function api(path, init = {}, token = null) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应（例如 HTML 错误页）就说不出结构化原因了 */
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  // 主控的响应统一包了一层 `{ok, data}`（见 server/src/http 的 reply），这里拆掉
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

/** 把 MIME 信件解成 { headers, parts: [{type, text}] } */
function parseMessage(raw) {
  const [headPart, ...rest] = raw.split('\r\n\r\n');
  const headers = Object.fromEntries(
    headPart.split('\r\n').map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
    }),
  );
  const body = rest.join('\r\n\r\n');
  const ctype = headers['content-type'] ?? '';
  if (!ctype.startsWith('multipart/')) {
    return {
      headers,
      parts: [{ type: ctype, text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') }],
    };
  }
  const boundary = /boundary="?([^";]+)"?/.exec(ctype)?.[1] ?? '';
  const parts = [];
  for (const chunk of body.split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\r\n/, '');
    if (trimmed.startsWith('--') || trimmed.trim().length === 0) continue;
    const [ph, ...pb] = trimmed.split('\r\n\r\n');
    const type = /content-type:\s*([^;\r\n]+)/i.exec(ph)?.[1]?.trim() ?? '';
    const enc = /content-transfer-encoding:\s*(\S+)/i.exec(ph)?.[1]?.trim() ?? '';
    const payload = pb.join('\r\n\r\n').replace(/\r\n$/, '');
    const text = enc === 'base64' ? Buffer.from(payload.replace(/\r\n/g, ''), 'base64').toString('utf8') : payload;
    parts.push({ type, text });
  }
  return { headers, parts };
}

/* ------------------------------------------------------------------------ 跑 */

const { server, port } = await startSmtp();
const created = { adminToken: null, username: null };
try {
  // 1) 管理员登录 → 把 SMTP 指向我们的收信服务器
  created.adminToken = (
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) })
  ).token;

  const before = await api('/admin/settings', {}, created.adminToken);
  const original = before.settings;
  /**
   * ⚠️ `PATCH /admin/settings` 收的是**平铺字段**，不是 `{settings: {...}}`
   * （见 `server/src/api/admin.ts` 的 `'smtpHost' in body`）。包一层的话会 200 但什么都不改 ——
   * 这个坑真的踩过：脚本以为改好了 SMTP，主控其实还在连旧地址，于是"验证码邮件一直收不到"。
   */
  await api(
    '/admin/settings',
    {
      method: 'PATCH',
      body: JSON.stringify({
        smtpHost: '127.0.0.1',
        smtpPort: port,
        smtpSecure: 'none',
        smtpUser: '',
        smtpPassword: null,
        smtpFrom: 'no-reply@mclink.test',
      }),
    },
    created.adminToken,
  );
  const applied = (await api('/admin/settings', {}, created.adminToken)).settings;
  check('SMTP 设置已真的生效（指向本脚本的收信服务器）', applied.smtpPort === port && applied.smtpHost === '127.0.0.1', `现在指向 ${applied.smtpHost}:${applied.smtpPort}`);

  // 2) 造一个临时收件人（邮箱是编的：SMTP 就是我们自己）
  //    验证邮箱这一步**顺便把验证码邮件也抓下来**——等于多验了一次发信链路；
  //    不要去动数据库里的 email_verified，那样就绕过了我们想检查的东西。
  created.username = `htmlmail_${RUN}`;
  const email = `htmlmail_${RUN}@example.test`;
  const userPassword = `Html-${RUN}-pw1`;
  await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: created.username, password: userPassword, email }),
  });
  const { token: userToken } = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: created.username, password: userPassword }),
  });
  // 注册时若没自动寄码，就显式要一封（`/auth/email/start` 要带上邮箱地址）
  for (let i = 0; i < 6 && captured.length === 0; i += 1) {
    if (i > 0) await api('/auth/email/start', { method: 'POST', body: JSON.stringify({ email }) }, userToken);
    for (let w = 0; w < 20 && captured.length === 0; w += 1) await delay(400);
  }
  const codeMail = captured.length > 0 ? parseMessage(captured[0]) : { headers: {}, parts: [] };
  const code = /\b(\d{6})\b/.exec(codeMail.parts[0]?.text ?? '')?.[1] ?? null;
  check('验证码邮件收到且能解出 6 位码', Boolean(code), code ? `码 ${code}` : (codeMail.parts[0]?.text ?? '(没收到)').slice(0, 80));
  if (!code) throw new Error('拿不到验证码，后面的群发检查没法保证收件人可发送');
  await api('/auth/email/verify', { method: 'POST', body: JSON.stringify({ code }) }, userToken);
  check('邮箱验证通过（说明发信链路本来就是通的）', Boolean((await api('/auth/me', {}, userToken)).emailVerified));
  captured.length = 0;

  /* ---------------------------------------------------------- HTML 模式 */
  captured.length = 0;
  const htmlBody =
    '<h2 style="margin:0 0 12px">McLink 1.1.0 来了</h2>' +
    '<p>这一版把<strong>房间中继</strong>收成一台，选路按你本机实测的延迟走。</p>' +
    '<p>更新地址：<a href="https://cnnic.link/download">下载页</a></p>';
  await api(
    '/admin/broadcast',
    {
      method: 'POST',
      body: JSON.stringify({
        subject: `HTML 检查 ${RUN}`,
        body: htmlBody,
        html: true,
        roles: '',
        activeDays: null,
        usernames: created.username,
      }),
    },
    created.adminToken,
  );
  // 群发在后台跑：等到信被我们收到（每批 5 封、批间 1.2 秒，一封通常 1 秒内）
  for (let i = 0; i < 40 && captured.length === 0; i += 1) await delay(500);
  check('HTML 公告真的发出去了', captured.length > 0, `收到 ${captured.length} 封`);

  const mail = captured[0] ? parseMessage(captured[0]) : { headers: {}, parts: [] };
  check(
    '是 multipart/alternative（HTML + 纯文本兜底）',
    String(mail.headers['content-type'] ?? '').startsWith('multipart/alternative'),
    String(mail.headers['content-type'] ?? '(无)'),
  );
  check('主题按 RFC 2047 编码', /=\?UTF-8\?B\?/.test(String(mail.headers.subject ?? '')), String(mail.headers.subject ?? ''));
  const textPart = mail.parts.find((p) => p.type.startsWith('text/plain'));
  const htmlPart = mail.parts.find((p) => p.type.startsWith('text/html'));
  check('两个 part 都在', Boolean(textPart) && Boolean(htmlPart), mail.parts.map((p) => p.type).join(' + '));
  check('HTML 段的内容与正文一致（中文没坏）', Boolean(htmlPart?.text.includes('McLink 1.1.0 来了')));
  check('HTML 段里有可点的下载链接', Boolean(htmlPart?.text.includes('href="https://cnnic.link/download"')));
  check(
    'HTML 段带上了自动追加的退订链接',
    Boolean(htmlPart?.text.includes('点这里退订')),
    (htmlPart?.text ?? '').slice(-90).replace(/\n/g, ' '),
  );
  check(
    '纯文本兜底可读（标签已去、链接留了地址）',
    Boolean(textPart?.text.includes('McLink 1.1.0 来了')) && !(textPart?.text ?? '').includes('<h2'),
    (textPart?.text ?? '').split('\n').slice(0, 2).join(' / '),
  );
  check('纯文本兜底也带退订链接', /不想再收到公告邮件/.test(textPart?.text ?? ''));

  /* ---------------------------------------------------------- 纯文本模式 */
  captured.length = 0;
  await api(
    '/admin/broadcast',
    {
      method: 'POST',
      body: JSON.stringify({
        subject: `纯文本检查 ${RUN}`,
        body: '你好，\n这是纯文本正文。\n第二行。',
        html: false,
        roles: '',
        activeDays: null,
        usernames: created.username,
      }),
    },
    created.adminToken,
  );
  for (let i = 0; i < 40 && captured.length === 0; i += 1) await delay(500);
  const plain = captured[0] ? parseMessage(captured[0]) : { headers: {}, parts: [] };
  check(
    '不勾 HTML 时仍是单段 text/plain（老行为不变）',
    String(plain.headers['content-type'] ?? '').startsWith('text/plain'),
    String(plain.headers['content-type'] ?? '(无)'),
  );
  check('纯文本正文的换行原样保留', Boolean(plain.parts[0]?.text.includes('这是纯文本正文。\n第二行。')));

  // 3) 还原 SMTP 设置（同样是平铺字段；密码只在原来有值时回填）
  await api(
    '/admin/settings',
    {
      method: 'PATCH',
      body: JSON.stringify({
        smtpHost: original.smtpHost ?? '',
        smtpPort: original.smtpPort,
        smtpSecure: original.smtpSecure,
        smtpUser: original.smtpUser ?? '',
        smtpFrom: original.smtpFrom ?? '',
        smtpPassword: original.smtpPassword ?? null,
      }),
    },
    created.adminToken,
  );
  console.log('  （已还原 SMTP 设置）');
} finally {
  server.close();
  // 临时账号一律封禁：这类检查脚本注册的账号不该留在用户列表里
  try {
    if (created.adminToken) {
      const found = await api(`/admin/users?search=${created.username ?? 'htmlmail'}`, {}, created.adminToken);
      for (const u of found.users ?? []) {
        await api(`/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ banned: true }) }, created.adminToken);
      }
    }
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
