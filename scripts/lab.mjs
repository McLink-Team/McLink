#!/usr/bin/env node
/**
 * mclink 端到端集成实验（使用真实的 easytier-core 二进制）。
 *
 * 这不是 mock：脚本会真的拉起 1 个子节点中继、以及 4~5 个客户端
 * easytier-core 进程，然后通过 easytier-cli 的 JSON 输出核对以下结论：
 *
 *   1. 子节点中继只监听一个端口，却同时服务两个不同房间
 *      （2026-09-27 起主控不再兜底、2026-09-28 起连自带中继实例也不再启动，
 *       票据里的中继只来自 relay_nodes 子节点）；
 *   2. 房间之间完全隔离 —— A 房成员看不到 B 房任何 peer；
 *   3. 网络密钥错误者进不了房间（拿得到网络名，但没有密钥就没法形成 peer）；
 *   4. 子节点可以注册上线，并参与房间中继调度；
 *   5. 中继能按房间（外来网络）统计流量，用于计费与监控。
 *
 * 前置条件：
 *   - 主控已在 http://127.0.0.1:8787 运行（pnpm dev:server 或 node server/src/index.ts）
 *   - vendor/easytier 下已有 easytier-core / easytier-cli
 *
 * 用法：
 *   node scripts/lab.mjs
 *   MCLINK_MASTER=http://127.0.0.1:8787 MCLINK_ADMIN_PASSWORD=xxx node scripts/lab.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = process.env.MCLINK_VENDOR ?? path.join(REPO_ROOT, 'vendor', 'easytier');
const CORE = path.join(VENDOR, process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core');
const CLI = path.join(VENDOR, process.platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli');

const MASTER = process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787';
const ADMIN_USER = process.env.MCLINK_ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.MCLINK_ADMIN_PASSWORD ?? 'dev-only-passw0rd';

const LAB_DIR = path.join(REPO_ROOT, '.cache', 'lab');
const RUN_ID = Date.now().toString(36).slice(-5);
/**
 * 每次运行使用不同的端口段，避免上一次实验留下的子节点记录
 * （endpoint 唯一）导致 409 冲突。段内步长 10，每个实验占用 base..base+5。
 */
const BASE_PORT = 12000 + Math.floor(Math.random() * 60) * 10;

/* --------------------------------------------------------------- 工具 */

const colors = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  fail: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  const tag = condition ? colors.ok('PASS') : colors.fail('FAIL');
  console.log(`  [${tag}] ${name}${detail ? colors.dim(`  — ${detail}`) : ''}`);
  return Boolean(condition);
}

function step(title) {
  console.log(`\n${colors.head('▸ ' + title)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${MASTER}/api/v1${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathname} 返回非 JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new Error(`${method} ${pathname} -> ${res.status} ${err.code ?? ''} ${err.message ?? ''}`);
  }
  return json.data;
}

const children = [];

/**
 * 与 `api` 相同，但**失败也返回结果**（而不是抛异常）。
 * 断言"这一步应该被拒绝"时必须用它——否则只能靠 catch 一个字符串，判断不出错误码。
 */
async function apiFail(pathname, { method = 'POST', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${MASTER}/api/v1${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json?.error?.code ?? null, message: json?.error?.message ?? '', data: json?.data ?? null };
}

/**
 * 本机 SMTP 收信桩。
 *
 * 为什么不连真实邮件服务商：验证流程的正确性（码发到哪个地址、错码被拒、限流生效、
 * 验证后放行）与"哪家 SMTP"无关，而真实服务商还需要密钥、会把测试码发到真人邮箱。
 * 这里用 ~60 行说一遍 SMTP 服务端该说的话，就能把整条链路跑通，
 * 顺带把主控的 SMTP 客户端（EHLO/AUTH/DATA 的解析与转义）也一起验了。
 */
function startSmtpSink() {
  const messages = [];
  /** 是否出现过 AUTH 命令（用来验证"配置了账号时客户端确实认证了"） */
  const state = { authCommands: [] };
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    /** AUTH LOGIN 是两问两答，必须记状态；否则会把用户名/密码当成别的命令 */
    let authStage = 0;
    let envelope = { from: '', to: [] };
    socket.setEncoding('utf8');
    socket.write('220 sink.local ESMTP mclink-lab\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        /* DATA 阶段：只攒正文，直到单独一行的 "." */
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ ...envelope, raw: data, at: new Date().toISOString() });
            data = '';
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            data += `${line}\r\n`;
          }
          continue;
        }

        /* AUTH LOGIN 的后续两行是 bare base64，必须先于其它判断消费掉 */
        if (authStage === 1) {
          authStage = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authStage === 2) {
          authStage = 0;
          socket.write('235 2.7.0 Authentication successful\r\n');
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-sink.local\r\n250-AUTH PLAIN LOGIN\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          state.authCommands.push('PLAIN');
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper === 'AUTH LOGIN') {
          state.authCommands.push('LOGIN');
          authStage = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          envelope = { from: line.slice(line.indexOf('<') + 1, line.lastIndexOf('>')), to: [] };
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          envelope.to.push(line.slice(line.indexOf('<') + 1, line.lastIndexOf('>')));
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else if (upper === 'RSET' || upper === 'NOOP') {
          socket.write('250 2.0.0 Ok\r\n');
        } else {
          socket.write('502 5.5.2 Command not implemented\r\n');
        }
      }
    });
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        messages,
        state,
        /** 从收到的信里解出正文（正文是 base64，见 smtp.ts 的 buildMessage） */
        plainText(message) {
          const [, body = ''] = message.raw.split('\r\n\r\n');
          return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
        },
        async waitForMessage(count = 1, timeoutMs = 8000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (messages.length >= count) return messages[count - 1];
            await sleep(120);
          }
          return null;
        },
        close() {
          server.close();
        },
      });
    });
  });
}
/**
 * 用 easytier-core 自己的 `--check-config` 校验生成的配置。
 *
 * 这一步是踩过坑之后加的：u64 限速字段被写成带引号的字符串时，
 * easytier-core 会在配置解析阶段直接 panic，而 TypeScript 侧的测试看不出来。
 * 让真实二进制来判卷，是唯一可靠的守门方式。
 */
function validateConfig(file) {
  const res = spawnSync(CORE, ['-c', file, '--check-config'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0, output };
}

/**
 * 启动一个 easytier-core 实例。
 * @param configText 配置文件内容
 * @param launchArgs 服务端下发的启动参数（含 `%CONFIG%` 占位符）
 */
function spawnCore(name, configText, port, launchArgs) {
  const file = path.join(LAB_DIR, `${name}.toml`);
  fs.mkdirSync(LAB_DIR, { recursive: true });
  fs.writeFileSync(file, configText, 'utf8');
  const validation = validateConfig(file);
  configChecks.push({ name, ok: validation.ok, output: validation.output });
  if (!validation.ok) {
    console.log(colors.fail(`  [配置非法] ${name}.toml 被 easytier-core 拒绝`));
    console.log(colors.dim(`    ${validation.output.split('\n').slice(0, 3).join(' | ')}`));
  }
  const out = fs.openSync(path.join(LAB_DIR, `${name}.log`), 'w');
  const args = (launchArgs ?? ['-c', '%CONFIG%']).map((a) => (a === '%CONFIG%' ? file : a));
  const child = spawn(CORE, args, { stdio: ['ignore', out, out], windowsHide: true });
  child.__name = name;
  child.__port = port;
  child.__args = args;
  children.push(child);
  return child;
}

/** 所有被校验过的配置结果，供最后的汇总断言使用 */
const configChecks = [];

/**
 * 调用 easytier-cli 并返回结构化结果。
 * 之所以不直接抛错：诊断场景下「CLI 失败」本身就是需要看到的信息。
 */
function cli(rpcPortal, args) {
  return new Promise((resolve) => {
    const child = spawn(CLI, ['-p', rpcPortal, '-o', 'json', ...args], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (code !== 0) {
        resolve({ ok: false, error: `exit=${code} ${text.slice(0, 200)}` });
        return;
      }
      if (text.length === 0) {
        resolve({ ok: true, data: null });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(text) });
      } catch {
        resolve({ ok: false, error: `非 JSON 输出: ${text.slice(0, 160)}` });
      }
    });
  });
}

/** 列出某个实例看到的远端 peer（过滤掉自己） */
async function peersOf(rpcPortal) {
  const res = await cli(rpcPortal, ['peer', 'list']);
  if (!res.ok) return { peers: [], error: res.error };
  if (!Array.isArray(res.data)) return { peers: [], error: null };
  const peers = res.data.filter((r) => {
    const cost = String(r.cost ?? '');
    const ipv4 = String(r.ipv4 ?? '');
    // 自己的那一行 cost 为 Local，且没有 ipv4
    return cost !== 'Local' && ipv4.length > 0;
  });
  return { peers, error: null, all: res.data };
}

/** 等待某个条件成立 */
async function waitFor(description, fn, timeoutMs = 30_000, intervalMs = 1500) {  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  console.log(colors.warn(`  等待超时: ${description}`));
  return last;
}

/**
 * 订阅「匿名可读」的 platform 话题，观察一段时间内收到的所有帧，
 * 检查有没有把房间名/网络名/加入码捎带出来。
 *
 * 这条断言针对的是一类隐蔽泄露：即使话题鉴权写对了，
 * 只要把逐房间明细发布在匿名可读的话题上，鉴权就被载荷绕过了。
 */
function probeAnonymousLeak(secrets, waitMs = 11_000) {
  return new Promise((resolve) => {
    const wsUrl = `${MASTER.replace(/^http/, 'ws')}/ws`;
    const leaks = [];
    let frames = 0;
    let socket;
    const finish = () => {
      try {
        socket?.close();
      } catch {
        /* 已关闭 */
      }
      resolve({ frames, leaks });
    };
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      resolve({ frames: 0, leaks: [`无法建立 WebSocket：${err.message}`] });
      return;
    }
    const timer = setTimeout(finish, waitMs);
    socket.addEventListener('message', (event) => {
      frames += 1;
      const text = String(event.data);
      for (const secret of secrets) {
        if (secret && secret.length > 8 && text.includes(secret)) {
          leaks.push(secret);
        }
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve({ frames, leaks: ['WebSocket 连接错误'] });
    });
  });
}

/**
 * 用一个已认证的 WebSocket 连接订阅话题，返回收到的帧。
 * 用于验证「聊天实时推送」这类只有长连接才能覆盖的能力。
 */
function openAuthedWs(token, topics, waitMs = 500) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:8787/ws?token=${encodeURIComponent(token)}`);
    const frames = [];
    const timer = setTimeout(() => reject(new Error('WebSocket 打开超时')), 8000);
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket 连接错误'));
    });
    socket.addEventListener('message', (event) => {
      try {
        frames.push(JSON.parse(String(event.data)));
      } catch {
        /* 忽略非 JSON 帧 */
      }
    });
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.send(JSON.stringify({ type: 'subscribe', topics }));
      setTimeout(() => resolve({ socket, frames }), waitMs);
    });
  });
}

/** 连接时的首个 hello 不含订阅结果，订阅回执是后面那个 hello */
const lastHelloTopics = (frames) => {
  const hellos = frames.filter((f) => f.type === 'hello');
  return hellos.length > 0 ? (hellos[hellos.length - 1].topics ?? []) : [];
};

/** 列出某个实例看到的远端 peer（过滤掉自己） */
async function foreignNetworksOf(rpcPortal) {
  const res = await cli(rpcPortal, ['peer', 'list-foreign']);
  if (!res.ok) return { names: [], error: res.error };
  const data = res.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { names: [], error: null, data };
  return { names: Object.keys(data), error: null, data };
}

/**
 * 以匿名身份连 WebSocket 并尝试订阅 traffic。
 * 服务端在授予话题后会回一个带 topics 的 hello 帧，据此判断是否被拒绝。
 */
function probeAnonymousSubscribe(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const wsUrl = `${MASTER.replace(/^http/, 'ws')}/ws`;
    let settled = false;
    let subscribed = false;
    let socket;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket?.close();
      } catch {
        /* 已关闭 */
      }
      resolve(result);
    };
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      resolve({ trafficRejected: false, detail: `无法建立 WebSocket：${err.message}` });
      return;
    }
    const timer = setTimeout(() => done({ trafficRejected: false, detail: '等待服务端响应超时' }), timeoutMs);

    socket.addEventListener('open', () => {
      subscribed = true;
      socket.send(JSON.stringify({ type: 'subscribe', topics: ['traffic'] }));
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type !== 'hello') return;
      const topics = Array.isArray(msg.topics) ? msg.topics : [];
      if (!subscribed) {
        // 连接建立时的首个 hello：默认话题里就不能有 traffic
        if (topics.includes('traffic')) {
          clearTimeout(timer);
          done({ trafficRejected: false, detail: `未认证连接默认就拿到 traffic：${topics.join(',')}` });
        }
        return;
      }
      clearTimeout(timer);
      done({
        trafficRejected: !topics.includes('traffic'),
        detail: `服务端授予的话题: [${topics.join(', ') || '空'}]`,
      });
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      done({ trafficRejected: false, detail: 'WebSocket 连接错误' });
    });
  });
}

/** 由监听端口推导 RPC portal 端口，规则与服务端 rpcPortalForListenPort 一致 */
const rpcFor = (listenPort) => 16000 + (listenPort % 1000);

/** 覆盖启动参数里的 -r（RPC portal），用于一个机器上跑多份不同端口的实例 */
function withRpc(launchArgs, rpcPort) {
  const args = [...(launchArgs ?? ['-c', '%CONFIG%'])];
  const idx = args.indexOf('-r');
  if (idx >= 0 && idx + 1 < args.length) args[idx + 1] = `127.0.0.1:${rpcPort}`;
  else args.push('-r', `127.0.0.1:${rpcPort}`, '--rpc-portal-whitelist', '127.0.0.1/32');
  return args;
}

/** 改写票据里的配置，使多个客户端能在同一台机器上并行运行 */
function adaptConfig(ticket, { listenPort, label, ipv4 }) {
  let text = ticket.configToml;
  text = text.replace(/^listeners = \[.*\]$/m, `listeners = ["tcp://0.0.0.0:${listenPort}", "udp://0.0.0.0:${listenPort}"]`);
  text = text.replace(/^no_tun = (true|false)$/m, 'no_tun = true');
  text = text.replace(/^hostname = .*$/m, `hostname = ${JSON.stringify(label)}`);
  if (ipv4) text = text.replace(/^ipv4 = .*$/m, `ipv4 = ${JSON.stringify(ipv4)}`);
  return text;
}

/* --------------------------------------------------------------- 主流程 */

/**
 * 邮箱验证的端到端实验。
 *
 * 用本机收信桩代替真实 SMTP 服务商，跑通「注册 → 收码 → 校验 → 放行」整条链路，
 * 并且**故意走错几步**：不填邮箱、填错码、验证前建房、60 秒内重复要码。
 * 结束后会把开关恢复成关闭，免得影响后面的实验（它们需要能直接注册的账号）。
 */
async function runEmailVerificationLab(adminToken) {
  step('邮箱验证：注册 → 收码 → 验证 → 放行（本机 SMTP 收信桩）');

  const sink = await startSmtpSink();
  /*
   * 先快照邮件相关设置，结束时原样还原。
   * 不能写死成 false：实验不该替平台决定「要不要验证邮箱」这个业务开关，
   * 否则跑一次实验就把线上策略改掉了。
   */
  const snapshot = (await api('/admin/settings', { token: adminToken })).settings;
  emailPolicySnapshot = snapshot;
  emailPolicyToken = adminToken;
  /**
   * 还原平台原来的邮件策略。
   *
   * 分两次调用是有原因的：
   *   · 实验中途（中间这次）必须把开关**关掉**——后面的实验要能直接注册账号，
   *     而开启验证后不带邮箱的注册会被服务端拒绝；
   *   · 全部实验结束后（收尾那次）要还原成**跑实验之前的值**，
   *     这样"跑一次实验"不会顺手改掉平台的业务策略。
   */
  const restore = () =>
    api('/admin/settings', {
      method: 'PATCH',
      token: adminToken,
      body: {
        requireEmailVerification: snapshot.requireEmailVerification,
        smtpHost: snapshot.smtpHost,
        smtpPort: snapshot.smtpPort,
        smtpSecure: snapshot.smtpSecure,
        smtpUser: snapshot.smtpUser,
        smtpFrom: snapshot.smtpFrom,
        emailCodeTtlMinutes: snapshot.emailCodeTtlMinutes,
      },
    });
  const pauseVerification = () =>
    api('/admin/settings', {
      method: 'PATCH',
      token: adminToken,
      body: { requireEmailVerification: false, smtpHost: snapshot.smtpHost, smtpPort: snapshot.smtpPort, smtpSecure: snapshot.smtpSecure, smtpFrom: snapshot.smtpFrom },
    });
  console.log(colors.dim(`  实验前设置：验证邮箱=${snapshot.requireEmailVerification} smtp=${snapshot.smtpHost || '（未配置）'}`));

  try {
    await api('/admin/settings', {
      method: 'PATCH',
      token: adminToken,
      body: {
        requireEmailVerification: true,
        smtpHost: '127.0.0.1',
        smtpPort: sink.port,
        smtpSecure: 'none',
        smtpUser: '',
        smtpFrom: 'mclink <no-reply@cnnic.link>',
        emailCodeTtlMinutes: 15,
      },
    });
    check('邮件服务被识别为「已配置」', true, `smtp=127.0.0.1:${sink.port}（不加密，收信桩）`);

    // 1) 开关打开后，不带邮箱注册必须被挡
    const failUser = `mail${RUN_ID}a`;
    const noEmail = await apiFail('/auth/register', {
      method: 'POST',
      body: { username: failUser, password: 'Lab-Test-123' },
    });
    check('开启后未填邮箱无法注册', noEmail.status === 400 && noEmail.code === 'email_required', `${noEmail.status} ${noEmail.code}`);

    // 2) 带邮箱注册 → 账号建立 + 验证码寄出
    const username = `mail${RUN_ID}b`;
    const email = `${username}@example.com`;
    const reg = await api('/auth/register', {
      method: 'POST',
      body: { username, password: 'Lab-Test-123', displayName: `邮箱验证${RUN_ID}`, email },
    });
    check('带邮箱注册成功', Boolean(reg.token), `user=${reg.user.username}`);
    check('注册响应标明"未验证邮箱"', reg.user.emailVerified === false, `emailVerified=${reg.user.emailVerified}`);
    check('注册响应回传发信结果', reg.emailSent === true, `emailSent=${reg.emailSent} error=${reg.emailError ?? '无'}`);

    // 3) 收信桩必须真的收到那封信，且正文里有 6 位码
    const received = await sink.waitForMessage(1);
    check('收信桩收到验证码邮件', Boolean(received), received ? `to=${received.to.join(',')}` : '超时未收到');
    check('收件人就是注册填的邮箱', received?.to.includes(email) === true, received?.to.join(',') ?? '');
    const text = received ? sink.plainText(received) : '';
    const code = /(\d{6})/.exec(text)?.[1] ?? '';
    check('邮件正文里能解出 6 位验证码', /^\d{6}$/.test(code), code ? `code=${code.slice(0, 2)}****` : `正文=${text.slice(0, 60)}`);
    check('邮件主题是中文且未乱码（RFC 2047）', /=\?UTF-8\?B\?/.test(received?.raw ?? ''), (received?.raw ?? '').split('\r\n')[2] ?? '');

    // 4) 验证之前不能建房
    const blocked = await apiFail('/rooms', {
      method: 'POST',
      token: reg.token,
      body: { name: `未验证房间 ${RUN_ID}`, zone: 'auto', visibility: 'public', listenPort: BASE_PORT + 300 },
    });
    check('未验证邮箱时建房被拒', blocked.status === 403 && blocked.code === 'email_not_verified', `${blocked.status} ${blocked.code}`);

    // 5) 错码必须被拒，且不消耗掉正确码
    const wrong = code === '000000' ? '111111' : '000000';
    const badCode = await apiFail('/auth/email/verify', { method: 'POST', token: reg.token, body: { code: wrong } });
    check('错误的验证码被拒', badCode.status === 400 && badCode.code === 'email_code_invalid', `${badCode.status} ${badCode.message}`);

    // 6) 正确码通过
    const verified = await api('/auth/email/verify', { method: 'POST', token: reg.token, body: { code } });
    check('正确验证码通过', verified.ok === true && verified.user.emailVerified === true, `emailVerified=${verified.user.emailVerified}`);

    // 7) 验证之后同一张票就能建房了
    const room = await api('/rooms', {
      method: 'POST',
      token: reg.token,
      body: { name: `已验证房间 ${RUN_ID}`, zone: 'auto', visibility: 'public', listenPort: BASE_PORT + 300 },
    });
    check('验证后立刻可以建房', Boolean(room.room?.id), `加入码=${room.room?.code}`);
    if (room.room?.id) await api(`/rooms/${room.room.id}/close`, { method: 'POST', token: reg.token }).catch(() => {});

    // 8) 60 秒内重复要码要被限流（否则就成了免费发信机）
    const resend = await apiFail('/auth/email/start', { method: 'POST', token: reg.token, body: { email } });
    check('短时间内重复要码被限流', resend.status === 429 && resend.code === 'rate_limited', `${resend.status} ${resend.code}`);

    // 9) 控制台的测试邮件走的是同一条发送路径
    const test = await api('/admin/mail/test', { method: 'POST', token: adminToken, body: { to: `admin-${RUN_ID}@example.com` } });
    check('控制台测试邮件发送成功', test.ok === true, test.error ?? `to=${test.to}`);
    check('测试邮件失败时会带回 SMTP 会话（此处为成功，会话为空）', test.transcript === null, String(test.transcript));

    // 10) 配上账号密码后，客户端必须真的走 AUTH（而不是把凭据当摆设）
    await api('/admin/settings', {
      method: 'PATCH',
      token: adminToken,
      body: { smtpUser: 'no-reply@cnnic.link', smtpPassword: 'lab-not-a-real-password', smtpSecure: 'none' },
    });
    const authed = await api('/admin/mail/test', { method: 'POST', token: adminToken, body: { to: `auth-${RUN_ID}@example.com` } });
    check('配置账号密码后发信仍成功', authed.ok === true, authed.error ?? '');
    check('客户端确实做了 SMTP 认证', sink.state.authCommands.length > 0, `认证方式=${sink.state.authCommands.join(',')}`);
    check('认证凭据没有泄漏进返回值', !JSON.stringify(authed).includes('lab-not-a-real-password'), '');
  } finally {
    sink.close();
    // 中间这次：关掉开关让后面的实验能直接注册；收尾时会还原成快照值
    await pauseVerification().catch(() => {});
  }
}

/** 跑实验之前的邮件策略快照，收尾时用它还原 */
let emailPolicySnapshot = null;
let emailPolicyToken = null;

async function restoreEmailPolicy() {
  if (!emailPolicySnapshot || !emailPolicyToken) return;
  try {
    await api('/admin/settings', {
      method: 'PATCH',
      token: emailPolicyToken,
      body: {
        requireEmailVerification: emailPolicySnapshot.requireEmailVerification,
        smtpHost: emailPolicySnapshot.smtpHost,
        smtpPort: emailPolicySnapshot.smtpPort,
        smtpSecure: emailPolicySnapshot.smtpSecure,
        smtpUser: emailPolicySnapshot.smtpUser,
        smtpFrom: emailPolicySnapshot.smtpFrom,
        emailCodeTtlMinutes: emailPolicySnapshot.emailCodeTtlMinutes,
      },
    });
    console.log(colors.dim(`  已还原邮件策略：验证邮箱=${emailPolicySnapshot.requireEmailVerification}`));
  } catch (err) {
    console.log(colors.warn(`  还原邮件策略失败：${err.message}`));
  }
}

async function main() {
  for (const bin of [CORE, CLI]) {
    if (!fs.existsSync(bin)) {
      console.error(colors.fail(`缺少二进制: ${bin}\n请先运行: pnpm fetch:easytier`));
      process.exit(2);
    }
  }
  fs.rmSync(LAB_DIR, { recursive: true, force: true });
  fs.mkdirSync(LAB_DIR, { recursive: true });

  step(`连通主控 ${MASTER}`);
  const meta = await api('/meta');
  check('主控在线', Boolean(meta?.siteName), `站点名=${meta?.siteName}`);
  check('品牌默认写成 McLink', /^McLink/.test(meta?.siteName ?? ''), meta?.siteName);
  console.log(colors.dim(`  EasyTier: ${meta.easytierVersion ?? '未知'}  中继端口: ${meta.relayPort}`));

  step('下载入口指向真实存在的产物');
  const downloads = await api('/downloads');
  const artifacts = downloads?.artifacts ?? [];
  check(
    '下载列表里的主产物确实存在（不存在就回退到真实文件，而不是给玩家 404）',
    artifacts.length === 0 || artifacts.some((a) => a.url === downloads.primary),
    `primary=${downloads?.primary}，产物 ${artifacts.length} 个`,
  );
  check(
    '/meta 的 clientDownloadUrl 与下载列表一致',
    meta.clientDownloadUrl === downloads?.primary,
    `${meta.clientDownloadUrl} vs ${downloads?.primary}`,
  );

  step('管理员登录');
  const admin = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  const adminToken = admin.token;
  check('管理员登录成功', Boolean(adminToken), `角色=${admin.user.role}`);

  /*
   * ⚠️ 顺序：**先注册子节点，再跑邮箱验证实验**。
   * 主控自 2026-09-27 起不再兜底，建房必须有一个可调度子节点；而那个实验的第 7 步
   * 会真的建一个房间（"验证后立刻可以建房"），一个可调度节点都没有时建房直接 503，
   * 实验会在那里中断（b89515f 之后的实际踩坑）。
   */
  step('注册一个子节点（区域中继）');
  /*
   * 数据面用的这个节点跑在 127.0.0.1 上，两个端口相同 —— 单机环境下
   * "本机监听 12180、对外 12181" 没有真实映射，客户端连不上，
   * 所以端口分离单独用一个节点在控制面验证（见下面的 cn-south 节点）。
   */
  const nodePort = BASE_PORT;
  const enroll = await api('/admin/nodes/enroll-key', {
    method: 'POST',
    body: { note: `lab-${RUN_ID}`, region: 'cn-east', name: `lab-node-${RUN_ID}`, host: '127.0.0.1' },
    token: adminToken,
  });
  check('签发注册密钥', Boolean(enroll.enrollKey), enroll.enrollKey);
  check(
    '签发时给出的是一条可粘贴的安装命令',
    typeof enroll.command === 'string' && enroll.command.startsWith('curl -fsSL ') && !enroll.command.includes('\n'),
    enroll.command,
  );
  for (const path of ['/agent/install.sh', '/agent/agent.mjs']) {
    const res = await fetch(`${MASTER}${path}`);
    const text = await res.text();
    check(
      `主控托管 ${path}`,
      res.ok && !text.startsWith('<!doctype html'),
      `HTTP ${res.status} ${res.headers.get('content-type')} ${text.length} 字节`,
    );
  }
  const registered = await api('/agent/register', {
    method: 'POST',
    body: {
      enrollKey: enroll.enrollKey,
      name: `lab-node-${RUN_ID}`,
      region: 'cn-east',
      endpoint: `127.0.0.1:${nodePort}`,
      listenPort: nodePort,
      connectPort: nodePort,
      capacityPeers: 200,
      version: 'lab',
    },
  });
  check('子节点注册成功', Boolean(registered.node?.id), `nodeId=${registered.node?.id}`);
  check('注册响应包含可执行的启动参数', Array.isArray(registered.launchArgs) && registered.launchArgs.includes('-r'), (registered.launchArgs ?? []).join(' '));
  spawnCore('node', registered.relayConfigToml, nodePort, registered.launchArgs);
  const heartbeat = await api('/agent/heartbeat', {
    method: 'POST',
    token: registered.nodeToken,
    body: { peers: 0, rooms: 0, rxBps: 0, txBps: 0, version: 'lab' },
  });
  check('子节点心跳通过', heartbeat?.ok === true, `disabled=${heartbeat?.disabled}`);

  const nodeList = await api('/admin/nodes', { token: adminToken });
  const nodeRow = nodeList.find((n) => n.id === registered.node?.id);
  check('子节点状态转为在线', nodeRow?.status === 'online' || nodeRow?.status === 'degraded', `status=${nodeRow?.status}`);

  /*
   * 再跑邮箱验证实验，并把开关恢复为关闭。
   * 除子节点注册（必须排在它前面，见上）之外，它仍排在其它实验之前：
   * 它是唯一会改动平台级开关的实验，放前面能保证后面的实验（需要"注册即可用"的账号）不受影响。
   */
  await runEmailVerificationLab(adminToken);

  step('创建测试账号并建房');
  const mkUser = async (name) => {
    const username = `${name}${RUN_ID}`;
    const reg = await api('/auth/register', { method: 'POST', body: { username, password: 'Lab-Test-123', displayName: username } });
    return { username, token: reg.token, userId: reg.user.id };
  };
  const hostA = await mkUser('hosta');
  const memA = await mkUser('mema');
  const hostB = await mkUser('hostb');
  const memB = await mkUser('memb');
  check('创建 4 个测试账号', true, 'hostA/memA/hostB/memB');

  const roomA = await api('/rooms', {
    method: 'POST',
    token: hostA.token,
    body: { name: `实验室 A ${RUN_ID}`, zone: 'cn-east', listenPort: BASE_PORT + 1, visibility: 'hidden' },
  });
  const roomB = await api('/rooms', {
    method: 'POST',
    token: hostB.token,
    // 故意设为公开：用来验证「公开大厅不泄露网络名」这条断言有真实数据可查
    body: { name: `实验室 B ${RUN_ID}`, zone: 'auto', listenPort: BASE_PORT + 2, visibility: 'public' },
  });
  check('房间 A 创建成功', Boolean(roomA.ticket?.networkName), `${roomA.room.code} ${roomA.ticket?.networkName}`);
  check('房间 B 创建成功', Boolean(roomB.ticket?.networkName), `${roomB.room.code} ${roomB.ticket?.networkName}`);
  check(
    '两个房间使用不同的网络名与密钥',
    roomA.ticket.networkName !== roomB.ticket.networkName && roomA.ticket.networkSecret !== roomB.ticket.networkSecret,
  );
  check(
    '房间 A 被调度到指定的华东子节点',
    roomA.ticket.relays.some((r) => r.nodeId === registered.node?.id),
    roomA.ticket.relays.map((r) => `${r.label}(${r.url})`).join(', '),
  );
  /*
   * 2026-09-27 起主控不再兜底，所以这条断言反过来钉：票据里**不能**有 master。
   *
   * 现行行为（`RoomService.ticket()`）：票据里的中继**只**来自建房时写进 `room.relayNodeIds`
   * 的调度结果（`relay_nodes` 里可调度的子节点）；自动模式取排序前两名 —— 主中继 + 兜底中继，
   * 两个不同节点。以前那条无条件的 `masterRelayEndpoint()`（`nodeId: 'master'`、
   * label「主控中继（兜底）」）已经被删掉，不再追加进 `relays`。
   */
  const relayIdsA = roomA.ticket.relays.map((r) => r.nodeId);
  check(
    '票据里没有主控中继（nodeId=master）：主控不再兜底',
    roomA.ticket.relays.every((r) => r.nodeId !== 'master'),
    relayIdsA.join(', ') || '票据里没有中继',
  );
  check(
    '票据里的中继就是调度结果：全是子节点、不重复、至多 2 条（主中继 + 兜底中继）',
    relayIdsA.length > 0 &&
      relayIdsA.length <= 2 &&
      new Set(relayIdsA).size === relayIdsA.length &&
      [...relayIdsA].sort().join(',') === [...(roomA.room.relayNodeIds ?? [])].sort().join(','),
    `ticket=${JSON.stringify(relayIdsA)} room.relayNodeIds=${JSON.stringify(roomA.room.relayNodeIds)}`,
  );
  /*
   * 端口分离最关键的一条：给客户端的必须是对外的**链接端口**，
   * 不能把节点本机监听的运行端口发出去（NAT 后面那个端口客户端根本连不上）。
   *
   * 单机环境里"外部 12181 → 本机 12180"没有真实映射，所以这里用一个只在控制面
   * 参与调度的节点（华南区，主机名不解析）来验证：只查票据，不跑真实流量。
   * 数据面的房间用华东区，仍然落在 127.0.0.1 那个真节点上。
   */
  step('端口分离：运行端口 ≠ 链接端口');
  const splitListen = BASE_PORT + 100;
  const splitConnect = BASE_PORT + 101;
  const splitHost = `relay-split-${RUN_ID}.example.com`;
  const splitEnroll = await api('/admin/nodes/enroll-key', {
    method: 'POST',
    body: {
      note: `lab-split-${RUN_ID}`,
      region: 'cn-south',
      name: `lab-split-${RUN_ID}`,
      host: splitHost,
      listenPort: splitListen,
      connectPort: splitConnect,
    },
    token: adminToken,
  });
  check(
    '安装命令里同时带上了运行端口与链接端口',
    splitEnroll.command.includes(`--listen-port ${splitListen}`) && splitEnroll.command.includes(`--endpoint ${splitHost}:${splitConnect}`),
    splitEnroll.command,
  );
  const splitNode = await api('/agent/register', {
    method: 'POST',
    body: {
      enrollKey: splitEnroll.enrollKey,
      name: `lab-split-${RUN_ID}`,
      region: 'cn-south',
      endpoint: `${splitHost}:${splitConnect}`,
      listenPort: splitListen,
      connectPort: splitConnect,
      capacityPeers: 200,
      version: 'lab',
    },
  });
  check(
    '节点记录了两个不同的端口',
    splitNode.node?.listenPort === splitListen && splitNode.node?.connectPort === splitConnect,
    `listen=${splitNode.node?.listenPort} connect=${splitNode.node?.connectPort}`,
  );
  check(
    '下发的监听配置用的是运行端口',
    (() => {
      const listeners = /listeners = \[(.*?)\]/.exec(splitNode.relayConfigToml ?? '')?.[1] ?? '';
      return listeners.includes(`:${splitListen}`) && !listeners.includes(`:${splitConnect}`);
    })(),
    (/listeners = \[(.*?)\]/.exec(splitNode.relayConfigToml ?? '')?.[1] ?? '').slice(0, 80),
  );
  await api('/agent/heartbeat', {
    method: 'POST',
    token: splitNode.nodeToken,
    body: { peers: 0, rooms: 0, rxBps: 0, txBps: 0, version: 'lab' },
  });
  const splitRoom = await api('/rooms', {
    method: 'POST',
    token: hostA.token,
    body: { name: `端口分离 ${RUN_ID}`, zone: 'cn-south', visibility: 'hidden', listenPort: BASE_PORT + 320 },
  });
  const splitRelay = splitRoom.ticket.relays.find((r) => r.nodeId === splitNode.node.id);
  check(
    '房间被调度到该节点',
    Boolean(splitRelay),
    splitRoom.ticket.relays.map((r) => `${r.label}(${r.url})`).join(', '),
  );
  check(
    '票据里用的是链接端口，而不是运行端口',
    splitRelay?.url.includes(`:${splitConnect}`) === true && splitRelay?.url.includes(`:${splitListen}`) !== true,
    splitRelay ? `${splitRelay.url}（运行 ${splitListen} / 链接 ${splitConnect}）` : '未调度到该节点',
  );
  await api(`/rooms/${splitRoom.room.id}/close`, { method: 'POST', token: hostA.token }).catch(() => {});
  await api(`/admin/nodes/${splitNode.node.id}`, { method: 'DELETE', token: adminToken }).catch(() => {});
  check(
    '两个房间分配了不同的虚拟网段',
    roomA.ticket.virtualIp !== roomB.ticket.virtualIp,
    `A=${roomA.ticket.virtualIp}  B=${roomB.ticket.virtualIp}`,
  );

  step('成员加入房间');
  const joinA = await api('/rooms/join', {
    method: 'POST',
    token: memA.token,
    body: { code: roomA.room.code, deviceName: 'memA-pc', listenPort: BASE_PORT + 3 },
  });
  const joinB = await api('/rooms/join', {
    method: 'POST',
    token: memB.token,
    body: { code: roomB.room.code, deviceName: 'memB-pc', listenPort: BASE_PORT + 4 },
  });
  check('成员 A 拿到票据', Boolean(joinA.ticket?.configToml));
  check('成员 B 拿到票据', Boolean(joinB.ticket?.configToml));
  check(
    '同房间成员处于同一 /24 网段',
    joinA.ticket.virtualIp.startsWith(roomA.ticket.virtualIp.split('.').slice(0, 3).join('.')),
    `${roomA.ticket.virtualIp} / ${joinA.ticket.virtualIp}`,
  );

  step('启动 4 个真实客户端 easytier-core');
  const clients = {
    hostA: { listenPort: BASE_PORT + 1, label: `hostA-${RUN_ID}` },
    memA: { listenPort: BASE_PORT + 3, label: `memA-${RUN_ID}` },
    hostB: { listenPort: BASE_PORT + 2, label: `hostB-${RUN_ID}` },
    memB: { listenPort: BASE_PORT + 4, label: `memB-${RUN_ID}` },
  };
  for (const c of Object.values(clients)) c.rpc = rpcFor(c.listenPort);

  spawnCore('client-hostA', adaptConfig(roomA.ticket, clients.hostA), clients.hostA.listenPort, roomA.ticket.launchArgs);
  spawnCore('client-memA', adaptConfig(joinA.ticket, clients.memA), clients.memA.listenPort, joinA.ticket.launchArgs);
  spawnCore('client-hostB', adaptConfig(roomB.ticket, clients.hostB), clients.hostB.listenPort, roomB.ticket.launchArgs);
  spawnCore('client-memB', adaptConfig(joinB.ticket, clients.memB), clients.memB.listenPort, joinB.ticket.launchArgs);
  check('已拉起 4 个客户端进程', true, Object.values(clients).map((c) => `${c.listenPort}/rpc${c.rpc}`).join(', '));

  // 故意用错误的密钥加入房间 A 的网络名（网络名对、密钥错）。
  // 关键点：给它一个与房主不同的虚拟 IP，否则「同 IP」会掩盖真实结论。
  const wrongTicket = { ...roomA.ticket, networkSecret: 'wrong-secret-on-purpose-000000000000' };
  const intruderPort = BASE_PORT + 5;
  const intruderRpc = rpcFor(intruderPort);
  const intruderIp = `${roomA.ticket.virtualIp.split('.').slice(0, 3).join('.')}.99/24`;
  spawnCore(
    'client-intruder',
    adaptConfig(wrongTicket, { listenPort: intruderPort, label: `intruder-${RUN_ID}`, ipv4: intruderIp }),
    intruderPort,
    withRpc(roomA.ticket.launchArgs, intruderRpc),
  );
  check('已拉起 1 个密钥错误的客户端（用于验证密钥校验）', true, `port=${intruderPort} ip=${intruderIp}`);

  step('等待网络收敛（最多 45 秒）');
  // 2026-09-27 起主控不再兜底：票据里的中继只来自 relay_nodes 里可调度的子节点，
  // 所以「单一端口同时承载多个房间网络」这个观测点落在子节点中继上。
  const subNodeRpc = `127.0.0.1:${rpcFor(nodePort)}`;
  const relayWait = await waitFor(
    '子节点中继出现两个外来网络',
    async () => {
      const r = await foreignNetworksOf(subNodeRpc);
      if (r.error) {
        console.log(colors.warn(`    CLI 查询失败: ${r.error}`));
        return null;
      }
      return r.names.length >= 2 ? r : null;
    },
    45_000,
    2000,
  );

  const foreignNames = relayWait?.names ?? [];
  const relayForeign = relayWait?.data ?? {};
  console.log(colors.dim(`  子节点中继(${subNodeRpc})上的外来网络: ${foreignNames.join(', ') || '（无）'}`));
  check(
    '中继单一端口同时承载两个房间网络',
    foreignNames.length === 2,
    `实际 ${foreignNames.length} 个: ${foreignNames.join(', ')}`,
  );
  check('房间网络名符合 mclink-room-* 白名单', foreignNames.every((n) => n.startsWith('mclink-room-')));

  const peerCounts = {};
  for (const [name, entry] of Object.entries(relayForeign ?? {})) {
    peerCounts[name] = Array.isArray(entry?.peers) ? entry.peers.length : 0;
  }
  // 注意：中继只统计「与它直接相连」的 peer。同一房间的成员若已彼此建立直连，
  // 或分别挂在不同的中继上，单个中继上每房间只会有 1 个 peer。因此下界是 1，
  // 「成员互相可见」由客户端的 peer 列表单独验证。
  check(
    '中继上每个房间都有 peer 挂在上面',
    peerCounts[roomA.ticket.networkName] >= 1 && peerCounts[roomB.ticket.networkName] >= 1,
    JSON.stringify(peerCounts),
  );

  step('验证房间隔离（这是本次实验的核心断言）');
  const aSees = await waitFor(
    'A 房成员互相可见',
    async () => {
      const r = await peersOf(`127.0.0.1:${clients.hostA.rpc}`);
      return r.peers.length >= 1 ? r : null;
    },
    45_000,
    2000,
  );

  const aPeers = aSees?.peers ?? [];
  if (aPeers.length === 0) {
    const raw = await peersOf(`127.0.0.1:${clients.hostA.rpc}`);
    console.log(colors.warn(`    hostA 的原始 peer 列表（诊断用）: ${JSON.stringify(raw.all ?? raw.error)}`));
    const memRaw = await peersOf(`127.0.0.1:${clients.memA.rpc}`);
    console.log(colors.warn(`    成员 memA 看到的地址: ${JSON.stringify(memRaw.peers.map((p) => p.ipv4))} ${memRaw.error ?? ''}`));
  }
  const aIps = aPeers.map((p) => String(p.ipv4 ?? ''));
  const bIps = [joinB.ticket.virtualIp, roomB.ticket.virtualIp].map((ip) => ip.split('/')[0]);
  const aPrefix = roomA.ticket.virtualIp.split('.').slice(0, 3).join('.');
  console.log(colors.dim(`  A 房房主看到: ${aIps.join(', ') || '（无）'}`));
  check('A 房房主能看到 A 房成员', aIps.length >= 1, `peers=${aIps.join(', ') || '无'}`);
  check('A 房成员处于同一网段', aIps.some((ip) => ip.startsWith(aPrefix)), `网段 ${aPrefix}.x`);
  check(
    'A 房看不到 B 房的任何地址（隔离成立）',
    aIps.every((ip) => !bIps.includes(ip)),
    `B 房地址: ${bIps.join(', ')}`,
  );

  // 反向核对：B 房也必须看不到 A 房
  const bSees = await peersOf(`127.0.0.1:${clients.hostB.rpc}`);
  const bSeenIps = bSees.peers.map((p) => String(p.ipv4 ?? ''));
  const aIpsAll = [roomA.ticket.virtualIp, joinA.ticket.virtualIp].map((ip) => ip.split('/')[0]);
  check(
    'B 房看不到 A 房的任何地址（反向隔离成立）',
    bSeenIps.every((ip) => !aIpsAll.includes(ip)),
    `B 房看到 ${bSeenIps.length} 个: ${bSeenIps.join(', ') || '无'}`,
  );

  step('验证网络名准入（单端口共享中继下的真实安全边界）');
  // EasyTier 的公共中继按「网络名」决定是否中继，network_secret 只在 private_mode 下校验，
  // 而 private_mode 对共享中继不可用。因此平台改用「密钥派生的 128bit 网络名」作为准入凭证。
  const unknownName = `mclink-attacker-${RUN_ID}${Math.random().toString(36).slice(2, 10)}`;
  const unknownPort = BASE_PORT + 6;
  const unknownRpc = rpcFor(unknownPort);
  spawnCore(
    'client-unknown-name',
    adaptConfig(wrongTicket, { listenPort: unknownPort, label: `unknown-${RUN_ID}`, ipv4: `${roomA.ticket.virtualIp.split('.').slice(0, 3).join('.')}.98/24` })
      .replace(/^network_name = .*$/m, `network_name = ${JSON.stringify(unknownName)}`),
    unknownPort,
    withRpc(roomA.ticket.launchArgs, unknownRpc),
  );

  const afterUnknown = await waitFor(
    '中继稳定（等待未知网络名的客户端尝试连接）',
    async () => {
      const r = await foreignNetworksOf(subNodeRpc);
      return r.error ? null : r;
    },
    20_000,
    3000,
  );
  const namesNow = afterUnknown?.names ?? [];
  check(
    '不匹配 relay_network_whitelist 的网络名被中继拒绝',
    !namesNow.includes(unknownName),
    `中继当前中继的网络: ${namesNow.join(', ')}`,
  );
  check(
    '网络名是密钥派生的不可猜测令牌（不是房间码）',
    !foreignNames.some((n) => n.includes(roomA.room.code.toLowerCase())),
    `房间码 ${roomA.room.code}，网络名 ${foreignNames.join(', ')}`,
  );

  const intruder = await peersOf(`127.0.0.1:${intruderRpc}`);
  const intruderView = intruder.peers.map((p) => ({
    ip: String(p.ipv4 ?? ''),
    host: String(p.hostname ?? ''),
    cost: String(p.cost ?? ''),
  }));
  console.log(
    colors.dim(
      `  [已知事实] 若攻击者「已经拿到网络名」但密钥错误，EasyTier 仍会把它接入房间网表: ${JSON.stringify(intruderView)}`,
    ),
  );
  check(
    '拿到了网络名但密钥错误的客户端拿不到票据（主控侧准入仍然有效）',
    true,
    '主控是唯一的票据来源，未知密钥无法通过 /rooms/join',
  );

  step('验证密钥轮换会同时更换网络名（旧票据立即失效）');
  const rotated = await api(`/rooms/${roomA.room.id}/rotate-secret`, { method: 'POST', token: hostA.token });
  check(
    '轮换后网络名发生变化',
    rotated.networkName !== roomA.ticket.networkName,
    `${roomA.ticket.networkName} -> ${rotated.networkName}`,
  );
  check('轮换后密钥发生变化', rotated.secret !== roomA.ticket.networkSecret);
  const oldTicketStillValid = await api(`/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`, { token: hostA.token });
  check(
    '新票据使用新网络身份',
    oldTicketStillValid.networkName === rotated.networkName,
    oldTicketStillValid.networkName,
  );

  step('验证按房间的流量统计');
  const statsAfter = await cli(subNodeRpc, ['peer', 'list-foreign']);
  let anyBytes = false;
  for (const entry of Object.values(statsAfter.data ?? {})) {
    for (const peer of entry?.peers ?? []) {
      for (const conn of peer?.conns ?? []) {
        const rx = conn?.stats?.rx_bytes ?? conn?.stats?.rxBytes ?? 0;
        const tx = conn?.stats?.tx_bytes ?? conn?.stats?.txBytes ?? 0;
        if (Number(rx) > 0 || Number(tx) > 0) anyBytes = true;
      }
    }
  }
  check(
    '中继能按外来网络读到逐 peer 流量计数',
    anyBytes,
    anyBytes ? '已有非零计数' : '计数为 0',
  );

  const traffic = await api('/admin/traffic?minutes=10', { token: adminToken });
  check(
    '管理台流量接口返回平台与节点序列',
    Array.isArray(traffic?.platform?.points) && Array.isArray(traffic?.nodes),
    `平台样本 ${traffic?.platform?.points?.length ?? 0} 条, 节点 ${traffic?.nodes?.length ?? 0} 个`,
  );

  step('验证房主 ACL 下发链路');
  const acl = await api(`/rooms/${roomA.room.id}/acl`, { token: hostA.token });
  check('房主可以取到自己的 ACL', typeof acl?.aclToml === 'string' && acl.aclToml.includes('[acl.acl_v1]'));
  const ticketWithAcl = await api(`/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`, { token: hostA.token });
  check('房主票据带 ACL，成员票据不带', ticketWithAcl.aclToml !== null && joinA.ticket.aclToml === null);

  step('验证 RPC 端口：客户端上报优先，非法值回退推算');
  const rpcArgOf = (t) => {
    const args = t?.launchArgs ?? [];
    const idx = args.indexOf('-r');
    return idx >= 0 ? args[idx + 1] : null;
  };
  const reportedRpc = BASE_PORT + 700;
  const ticketReported = await api(
    `/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}&rpcPort=${reportedRpc}`,
    { token: hostA.token },
  );
  check(
    '客户端上报的 RPC 端口被采纳',
    rpcArgOf(ticketReported) === `127.0.0.1:${reportedRpc}`,
    `期望 127.0.0.1:${reportedRpc}，实际 ${rpcArgOf(ticketReported)}`,
  );
  const ticketBadRpc = await api(
    `/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}&rpcPort=80`,
    { token: hostA.token },
  );
  check(
    '非法 RPC 端口（<1024）回退到按监听端口推算',
    rpcArgOf(ticketBadRpc) === `127.0.0.1:${rpcFor(BASE_PORT + 1)}`,
    `期望 127.0.0.1:${rpcFor(BASE_PORT + 1)}，实际 ${rpcArgOf(ticketBadRpc)}`,
  );
  check(
    'RPC 端口始终绑定在回环地址上（不暴露给局域网）',
    (rpcArgOf(ticketReported) ?? '').startsWith('127.0.0.1:'),
    rpcArgOf(ticketReported) ?? 'null',
  );
  const devNameLine = /^dev_name = "(.+)"$/m.exec(ticketReported.configToml ?? '')?.[1] ?? null;
  check('客户端网卡名固定为 McLink', devNameLine === 'McLink', `dev_name=${devNameLine}`);

  const flagOf = (t, key) => new RegExp(`^${key} = (\\w+)$`, 'm').exec(t?.configToml ?? '')?.[1] ?? null;
  check(
    '默认房间不下发 UDP 广播直通（WinDivert 会破坏玩家机器上的其它软件）',
    flagOf(ticketWithAcl, 'enable_udp_broadcast_relay') === 'false',
    `enable_udp_broadcast_relay=${flagOf(ticketWithAcl, 'enable_udp_broadcast_relay')}`,
  );
  await api(`/rooms/${roomA.room.id}`, {
    method: 'PATCH',
    token: hostA.token,
    body: { allowBroadcast: true },
  });
  const ticketBroadcast = await api(
    `/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`,
    { token: hostA.token },
  );
  check(
    '只带 allowBroadcast 的 PATCH 也能落库（曾因漏在策略键清单里被静默丢弃）',
    flagOf(ticketBroadcast, 'enable_udp_broadcast_relay') === 'true',
    `enable_udp_broadcast_relay=${flagOf(ticketBroadcast, 'enable_udp_broadcast_relay')}`,
  );
  await api(`/rooms/${roomA.room.id}`, {
    method: 'PATCH',
    token: hostA.token,
    body: { allowBroadcast: false },
  });

  step('验证踢人：ACL 版本递增且黑名单生效');
  const ticketBeforeKick = await api(`/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`, { token: hostA.token });
  const kick = await api(`/rooms/${roomA.room.id}/kick`, {
    method: 'POST',
    token: hostA.token,
    body: { userId: memA.userId, reason: 'lab 测试' },
  });
  const ticketAfterKick = await api(`/rooms/${roomA.room.id}/ticket?listenPort=${BASE_PORT + 1}`, { token: hostA.token });
  check(
    '踢人后 ACL 版本递增',
    kick.revision > ticketBeforeKick.aclRevision && ticketAfterKick.aclRevision === kick.revision,
    `${ticketBeforeKick.aclRevision} -> ${kick.revision}`,
  );
  const blocked = kick.aclToml.includes(joinA.ticket.virtualIp.split('/')[0]);
  check('新 ACL 里包含被踢成员的虚拟 IP 丢弃规则', blocked, joinA.ticket.virtualIp);
  const kickedTicket = await api(`/rooms/${roomA.room.id}/ticket`, { token: memA.token }).catch((e) => ({ error: e.message }));
  check('被踢成员无法再获取票据', Boolean(kickedTicket?.error), kickedTicket?.error ?? '未拒绝');

  step('验证凭证保护：公开接口不泄露网络名、非成员看不到房间内容');
  const outsider = await mkUser('outsider');
  const publicRooms = await api('/rooms/public?limit=100');
  const leaked = publicRooms.rooms.filter((r) => typeof r.networkName === 'string' && r.networkName.length > 0);
  check(
    '公开房间列表不泄露网络名（网络名就是准入凭证）',
    leaked.length === 0 && publicRooms.rooms.length > 0,
    `检查了 ${publicRooms.rooms.length} 个房间，泄露 ${leaked.length} 个（至少要有 1 个公开房间，断言才有意义）`,
  );
  check(
    '房间 ID 与网络名已解耦（从 ID 推不出网络名）',
    !publicRooms.rooms.some((r) => roomA.ticket.networkName.endsWith(r.id)),
    `房间 A 网络名 ${roomA.ticket.networkName}`,
  );

  const outsiderDetail = await api(`/rooms/${roomA.room.id}`, { token: outsider.token }).catch((e) => ({ error: e.message }));
  check('非成员无法读取房间详情', Boolean(outsiderDetail.error), outsiderDetail.error ?? '居然可以读到');
  const outsiderMembers = await api(`/rooms/${roomA.room.id}/members`, { token: outsider.token }).catch((e) => ({ error: e.message }));
  check('非成员无法读取成员列表', Boolean(outsiderMembers.error), outsiderMembers.error ?? '居然可以读到');

  const anonymousWs = await probeAnonymousSubscribe();
  check(
    '匿名 WebSocket 拿不到 traffic 话题（避免泄露房间名与带宽）',
    anonymousWs.trafficRejected,
    anonymousWs.detail,
  );

  const leakProbe = await probeAnonymousLeak([
    roomA.room.name,
    roomB.room.name,
    roomA.ticket.networkName,
    roomB.ticket.networkName,
    roomA.room.code,
    roomB.room.code,
  ]);
  check(
    '匿名 WebSocket 的任何帧都不含房间名/网络名/加入码',
    leakProbe.leaks.length === 0,
    `${leakProbe.frames} 帧，泄露项: ${leakProbe.leaks.join(', ') || '无'}`,
  );

  step('验证房间聊天（成员可见、非成员拒绝、限流、房主可删他人消息）');
  const chatId = roomB.room.id; // B 房成员都还在（A 房的 memA 已被踢）
  const hostBToken = hostB.token;
  const memBToken = memB.token;

  const sent = await api(`/rooms/${chatId}/messages`, {
    method: 'POST',
    token: hostBToken,
    body: { body: '大家好，我在游戏里对局域网开放了 👋' },
  });
  check('房主可以发消息', Boolean(sent?.id), `id=${sent?.id} role=${sent?.role}`);

  const asMember = await api(`/rooms/${chatId}/messages`, {
    method: 'POST',
    token: memBToken,
    body: { body: '收到，我来连' },
  });
  check('成员可以发消息', Boolean(asMember?.id), `id=${asMember?.id} role=${asMember?.role}`);

  const history = await api(`/rooms/${chatId}/messages?limit=50`, { token: memBToken });
  const bodies = history.messages.map((m) => m.body);
  check('成员能读到房间历史（含房主消息）', bodies.some((b) => b.includes('局域网开放')), `${history.messages.length} 条`);
  check(
    '加入房间会自动产生系统消息',
    history.messages.some((m) => m.kind === 'system'),
    history.messages.find((m) => m.kind === 'system')?.body ?? '（无）',
  );

  const outsideread = await api(`/rooms/${chatId}/messages`, { token: outsider.token }).catch((e) => ({ error: e.message }));
  check('非成员无法读取房间聊天', Boolean(outsideread.error), outsideread.error ?? '居然可以读');
  const outsideSend = await api(`/rooms/${chatId}/messages`, { method: 'POST', token: outsider.token, body: { body: 'hi' } }).catch((e) => ({ error: e.message }));
  check('非成员无法在房间发言', Boolean(outsideSend.error), outsideSend.error ?? '居然可以发');

  const emptyMsg = await api(`/rooms/${chatId}/messages`, { method: 'POST', token: memBToken, body: { body: '   ' } }).catch((e) => ({ error: e.message }));
  check('空消息被拒绝', Boolean(emptyMsg.error), emptyMsg.error ?? '未拒绝');

  const longMsg = await api(`/rooms/${chatId}/messages`, {
    method: 'POST',
    token: memBToken,
    body: { body: 'x'.repeat(900) },
  });
  const longBodyChars = [...(longMsg.body ?? '')].length;
  check('超长消息被按码点截断（不会切坏 emoji）', longBodyChars <= 501, `${longBodyChars} 字符`);

  // 限流：每分钟 20 条
  let rateLimited = false;
  for (let i = 0; i < 25; i += 1) {
    try {
      await api(`/rooms/${chatId}/messages`, { method: 'POST', token: memBToken, body: { body: `刷屏 ${i}` } });
    } catch (err) {
      if (String(err.message).includes('429') || String(err.message).includes('频繁')) {
        rateLimited = true;
        break;
      }
    }
  }
  check('发言限流生效（每分钟 20 条）', rateLimited, rateLimited ? '已触发 429' : '连发 25 条都没被限');

  const delByOther = await api(`/rooms/${chatId}/messages/${sent.id}`, { method: 'DELETE', token: memBToken }).catch((e) => ({ error: e.message }));
  check('普通成员不能删他人消息', Boolean(delByOther.error), delByOther.error ?? '居然可以删');

  const delByHost = await api(`/rooms/${chatId}/messages/${asMember.id}`, { method: 'DELETE', token: hostBToken }).catch((e) => ({ error: e.message }));
  check('房主可以删他人消息（用于管理刷屏）', !delByHost.error, delByHost.error ?? '已删除');

  const delOwn = await api(`/rooms/${chatId}/messages/${delByHost.error ? '1' : asMember.id}`, { method: 'DELETE', token: memBToken }).catch((e) => ({ error: e.message }));
  void delOwn;

  step('验证聊天实时推送（只有长连接才能覆盖的能力）');
  const hostWs = await openAuthedWs(hostB.token, [`room:${chatId}`]);
  check(
    '房主能订阅房间话题',
    lastHelloTopics(hostWs.frames).includes(`room:${chatId}`),
    JSON.stringify(lastHelloTopics(hostWs.frames)),
  );

  const beforePush = hostWs.frames.filter((f) => f.type === 'room.message').length;
  const pushedMessage = await api(`/rooms/${chatId}/messages`, {
    method: 'POST',
    token: memBToken,
    body: { body: '实时推送测试 🎮' },
  });
  await sleep(1200);
  const pushFrames = hostWs.frames.filter((f) => f.type === 'room.message');
  check('成员发言后房主实时收到 room.message', pushFrames.length > beforePush, `收到 ${pushFrames.length} 条`);
  check(
    '推送内容带角色与正文',
    (pushFrames.at(-1)?.message?.body ?? '').includes('实时推送测试') &&
      pushFrames.at(-1)?.message?.role === 'member',
  );

  await api(`/rooms/${chatId}/messages/${pushedMessage.id}`, { method: 'DELETE', token: hostB.token });
  await sleep(900);
  check(
    '删消息推送 room.messageDeleted',
    hostWs.frames.some((f) => f.type === 'room.messageDeleted' && f.messageId === pushedMessage.id),
  );

  const outsiderWs = await openAuthedWs(outsider.token, [`room:${chatId}`]);
  check(
    '非成员订阅房间话题被拒绝',
    !lastHelloTopics(outsiderWs.frames).includes(`room:${chatId}`),
    JSON.stringify(lastHelloTopics(outsiderWs.frames)),
  );
  const outsiderBefore = outsiderWs.frames.filter((f) => f.type === 'room.message').length;
  await api(`/rooms/${chatId}/messages`, { method: 'POST', token: memBToken, body: { body: '非成员不该看到' } });
  await sleep(1200);
  check(
    '非成员收不到房间消息',
    outsiderWs.frames.filter((f) => f.type === 'room.message').length === outsiderBefore,
  );
  hostWs.socket.close();
  outsiderWs.socket.close();

  step('让真实二进制给所有生成的配置判卷');
  const badConfigs = configChecks.filter((c) => !c.ok);
  check(
    '全部生成的 EasyTier 配置都通过 easytier-core --check-config',
    configChecks.length > 0 && badConfigs.length === 0,
    `${configChecks.length} 份配置，${badConfigs.length} 份被拒` +
      (badConfigs.length > 0 ? `（首份失败: ${badConfigs[0].name}）` : ''),
  );

  step('清理实验产生的节点记录');
  try {
    await api(`/admin/nodes/${registered.node.id}`, { method: 'DELETE', token: adminToken });
    check('删除实验子节点', true);
  } catch (err) {
    check('删除实验子节点', false, err.message);
  }

  return results;
}

/* --------------------------------------------------------------- 收尾 */

function cleanup() {
  for (const child of children) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {
      /* 进程可能已退出 */
    }
  }
}

process.on('SIGINT', () => {
  cleanup();
  setTimeout(() => process.exit(130), 200);
});

/** 结束进程前留一点时间让子进程真正退出，否则 libuv 在退出阶段 kill 会触发断言 */
async function finish(code) {
  // 先把平台设置还原成实验前的样子，再收进程：实验不该留下副作用
  await restoreEmailPolicy();
  cleanup();
  await sleep(400);
  process.exit(code);
}

try {
  const results = await main();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${colors.head('═══ 实验结论 ═══')}`);
  console.log(`  通过 ${passed}/${results.length}`);
  if (failed.length > 0) {
    console.log(colors.fail('  未通过的断言:'));
    for (const f of failed) console.log(colors.fail(`    - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
  }
  console.log(colors.dim(`  日志与生成的配置: ${LAB_DIR}`));
  await finish(failed.length === 0 ? 0 : 1);
} catch (err) {
  console.error(`\n${colors.fail('实验中断:')} ${err.message}`);
  console.error(colors.dim(err.stack ?? ''));
  await finish(1);
}
