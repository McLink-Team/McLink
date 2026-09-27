#!/usr/bin/env node
/**
 * 把**主控这台机器**注册成一台普通子节点 —— 单机部署的一键脚本。
 *
 * 为什么需要它：2026-09-27 起主控不再当中继兜底，票据里的中继**全部**来自 `relay_nodes`
 * 里可调度的子节点；一台都没有时建房直接 503「当前没有可用的中继节点」。
 * 单机（一台服务器）要恢复可玩，就把主控这台机器按普通子节点注册进来 ——
 * 2026-09-28 起主控也不再自带中继实例，所以 11010 默认是空的，直接用它即可。
 *
 * 为什么不用「控制台签发密钥 + 粘贴命令」两条手工步骤：签发密钥是个纯 API 动作，
 * 脚本可以自己带上管理员密码完成，于是整件事收敛成一条命令。
 *
 * 用法（在主控机器上，root）：
 *
 *   sudo node /opt/mclink/app/deploy/register-self-node.mjs --region oversea
 *
 *   # 先看看它会做什么（真登录、真签一把密钥，但不改配置、不装节点）：
 *   sudo node deploy/register-self-node.mjs --region oversea --dry-run
 *
 *   # 11010 已经被别的服务占了时，换一个端口跑节点（防火墙上要放行这个端口）：
 *   sudo node deploy/register-self-node.mjs --region oversea --listen-port 11011
 *
 * 它做的五件事：
 *   1. 读 `/etc/mclink/mclink.env`（端口、管理员密码、公网主机名、中继端口）；
 *   2. 校验：区域合法、endpoint 能推出来、要用的端口没被别的进程占、endpoint 没被已有节点占用；
 *   3. 用管理员密码登录主控（走 127.0.0.1，不依赖 nginx/HTTPS）；
 *   4. 签发一把**一次性**注册密钥；
 *   5. 跑 `deploy/install-node.sh` 在本机装上节点（systemd 单元 `mclink-node`），
 *      轮询 `GET /admin/nodes` 直到这台节点变 `online`，打印结果与善后提示。
 *
 * ⚠️ 一定要知道的几点：
 *   · 这是**新增**一个中继入口，不是改造主控：装完之前一个可调度节点都没有时建房仍然 503，
 *     装完之后这台机器就是一个正常参与调度的子节点。
 *   · `--endpoint` 必须是**外网可达**的 `host:port`（客户端的链接端口）。默认取
 *     `MCLINK_RELAY_PUBLIC_HOST`，为空时取 `MCLINK_PUBLIC_BASE_URL` 的主机名。
 *   · 安全组/防火墙要放行该端口（TCP **和** UDP，EasyTier 两者都用）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_NODE = path.join(HERE, 'install-node.sh');

/** 与 packages/shared/src/regions.ts 保持一致（`auto` 是选择器，不是节点能落的区域） */
const REGION_IDS = [
  'cn-east',
  'cn-south',
  'cn-north',
  'cn-central',
  'cn-southwest',
  'cn-northwest',
  'cn-northeast',
  'hk',
  'oversea',
];

/* --------------------------------------------------------------- 输出 */

const color = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};
const log = (msg) => console.log(`▸ ${msg}`);
const ok = (msg) => console.log(`  ${color.ok('✓')} ${msg}`);
const note = (msg) => console.log(`  ${color.dim(msg)}`);
const warn = (msg) => console.log(`  ${color.warn('!')} ${msg}`);

/**
 * 致命错误：**抛出**而不是 `process.exit()`。
 *
 * 为什么要这样：脚本已经建立过 HTTP 连接（undici 的连接池）与探测用的 socket，
 * 直接 exit 会在句柄还没关干净时终止进程 —— 在 Windows 上实测会多打一行
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`，
 * 把真正的错误信息淹掉。交给 main() 的 catch 统一收尾，让 Node 自己退出。
 */
class Fatal extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
function die(msg, code = 1) {
  throw new Fatal(msg, code);
}

/* --------------------------------------------------------- 参数解析 */

function printUsage() {
  console.log(`把主控这台机器注册成普通子节点。

用法：
  sudo node deploy/register-self-node.mjs --region <区域> [选项]

必填：
  --region <id>            节点区域：${REGION_IDS.join(' / ')}
                           （海外机器用 oversea，香港用 hk）

常用：
  --listen-port <端口>     本机 easytier-core 实际监听端口，默认取 MCLINK_RELAY_PORT（11010）
  --endpoint <host:port>   客户端连接本节点用的公网地址；默认 MCLINK_RELAY_PUBLIC_HOST(:中继端口)，
                           再退到 MCLINK_PUBLIC_BASE_URL 的主机名。NAT 后面要用这个显式指定。
  --connect-port <端口>    链接端口（与运行端口不同时用，如本机 11010、对外只开 21010）
  --name <名称>            节点显示名，默认 <主机名>-self
  --dry-run                只做校验与签发密钥，打印将要执行的命令；不改配置、不装节点

排查用：
  --master <URL>           主控 API 地址，默认 http://127.0.0.1:\${MCLINK_PORT}
  --admin-user <用户名>    默认 admin
  --admin-password <密码>  默认读 env 文件的 MCLINK_ADMIN_PASSWORD
                           （若控制台里改过密码，env 里的值就失效了，用这个传）
  --env-file <路径>        默认 /etc/mclink/mclink.env
  --wait <秒>              等待节点变 online 的上限，默认 120
  -h, --help               显示本帮助
`);
}

function parseArgs(argv) {
  const out = {
    region: '',
    name: '',
    endpoint: '',
    listenPort: null,
    connectPort: null,
    master: '',
    adminUser: 'admin',
    adminPassword: '',
    envFile: '/etc/mclink/mclink.env',
    dryRun: false,
    wait: 120,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = (n = 1) => {
      const v = argv[i + n];
      if (v === undefined || v.startsWith('--')) die(`${arg} 缺少参数`);
      return v;
    };
    switch (arg) {
      case '--region': out.region = need(); i += 1; break;
      case '--name': out.name = need(); i += 1; break;
      case '--endpoint': out.endpoint = need(); i += 1; break;
      case '--listen-port': out.listenPort = Number(need()); i += 1; break;
      case '--connect-port': out.connectPort = Number(need()); i += 1; break;
      case '--master': out.master = need(); i += 1; break;
      case '--admin-user': out.adminUser = need(); i += 1; break;
      case '--admin-password': out.adminPassword = need(); i += 1; break;
      case '--env-file': out.envFile = need(); i += 1; break;
      case '--wait': out.wait = Number(need()); i += 1; break;
      case '--dry-run': out.dryRun = true; break;
      case '-h':
      case '--help': printUsage(); process.exit(0); break;
      default: die(`未知参数：${arg}（-h 看帮助）`);
    }
  }
  return out;
}

/* --------------------------------------------------------- env 文件 */

/**
 * 读 mclink.env。
 *
 * 故意只解析 `KEY=VALUE`：那个文件是给 systemd 的 EnvironmentFile 读的，
 * 里面可能有引号、可能有注释，但不是 shell 脚本 —— 不 source 它（`install-node.sh`
 * 里有同样的说明，理由一致：别让配置文件里的内容被执行）。
 */
function readEnvFile(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

/* ------------------------------------------------------------ HTTP */

async function api(base, pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}/api/v1${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* 非 JSON（反代 502 之类）下面统一报 */
  }
  if (!res.ok || !payload || payload.ok === false) {
    const message = payload?.error?.message ?? payload?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return payload.data;
}

/* ------------------------------------------------------------ 杂项 */

function isPortBusy(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** 从 host:port / http://host:port/path / [v6]:port 里取主机名 */
function hostOf(value) {
  if (!value) return '';
  let v = value.trim();
  if (v.includes('://')) {
    try {
      return new URL(v).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return '';
    }
  }
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']'));
  const idx = v.lastIndexOf(':');
  return idx > 0 ? v.slice(0, idx) : v;
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isWindows = process.platform === 'win32';
  if (typeof process.getuid === 'function' && process.getuid() !== 0 && !args.dryRun) {
    die('请用 root 运行（sudo node deploy/register-self-node.mjs …）；只看计划可加 --dry-run');
  }
  if (!fs.existsSync(INSTALL_NODE)) die(`找不到 ${INSTALL_NODE}（本脚本要和 install-node.sh 放在一起）`);

  /* 1. 读配置 */
  const env = readEnvFile(args.envFile);
  const httpPort = Number(env.get('MCLINK_PORT') ?? 8787);
  const relayPort = Number(env.get('MCLINK_RELAY_PORT') ?? 11010);
  const listenPort = args.listenPort ?? relayPort;
  const connectPort = args.connectPort ?? listenPort;
  const masterBase = (args.master || `http://127.0.0.1:${httpPort}`).replace(/\/+$/, '');
  const adminPassword = args.adminPassword || env.get('MCLINK_ADMIN_PASSWORD') || '';
  const endpointHost =
    hostOf(args.endpoint) || env.get('MCLINK_RELAY_PUBLIC_HOST') || hostOf(env.get('MCLINK_PUBLIC_BASE_URL') || '');
  const endpoint = args.endpoint || (endpointHost ? `${endpointHost}:${connectPort}` : '');
  const name = args.name || `${(os.hostname() || 'master').split('.')[0]}-self`;

  log(`主控 API：${masterBase}${args.dryRun ? color.dim('（--dry-run）') : ''}`);
  note(`配置文件：${args.envFile}${fs.existsSync(args.envFile) ? '' : '（不存在，参数只来自命令行）'}`);
  note(`本机中继端口：${relayPort}（MCLINK_RELAY_PORT）`);

  /* 2. 校验 */
  if (!REGION_IDS.includes(args.region)) {
    die(`--region 必填且必须是：${REGION_IDS.join(' / ')}\n  海外机器用 oversea，香港用 hk`);
  }
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) die(`--listen-port 不合法：${listenPort}`);
  if (!Number.isInteger(connectPort) || connectPort < 1 || connectPort > 65535) die(`--connect-port 不合法：${connectPort}`);
  if (!endpoint) {
    die(
      '推不出节点的对外地址（--endpoint）。\n' +
        '  显式指定：--endpoint <公网域名或IP>:<链接端口>\n' +
        '  或在 env 文件里设 MCLINK_RELAY_PUBLIC_HOST / MCLINK_PUBLIC_BASE_URL',
    );
  }
  if (!adminPassword) die('没有管理员密码：env 文件里没有 MCLINK_ADMIN_PASSWORD，用 --admin-password 传');
  ok(`区域 ${args.region} / 名称 ${name} / 对外地址 ${endpoint}`);
  note(`本机监听端口 ${listenPort}（运行端口），客户端连 ${connectPort}（链接端口）`);

  /* 端口冲突：主控不再自带中继，11010 默认是空的；占着它的只可能是别的进程 */
  if (await isPortBusy(listenPort)) {
    die(
      `端口 ${listenPort} 已被占用。二选一：\n` +
        `  · 加 --listen-port 11011（另开一个端口跑节点，记得放行它 + 用 --endpoint host:11011）\n` +
        `  · 或者先腾出这个端口（ss -lntup | grep ${listenPort}）`,
    );
  }

  /* 3. 登录（先登录再检查 endpoint 冲突，报错信息更准确） */
  let token;
  try {
    const session = await api(masterBase, '/auth/login', {
      method: 'POST',
      body: { username: args.adminUser, password: adminPassword },
    });
    token = session.token;
    ok(`管理员 ${args.adminUser} 登录成功`);
  } catch (err) {
    if (err.status === 401) {
      die(
        '管理员登录失败（401）。\n' +
          '  env 文件里的 MCLINK_ADMIN_PASSWORD 只在**首次建号**时生效；\n' +
          '  若你在控制台改过密码，请用 --admin-password <当前密码> 传。',
      );
    }
    die(`连不上主控 API（${masterBase}）：${err.message}`);
  }

  const nodes = await api(masterBase, '/admin/nodes', { token });
  const taken = nodes.find((n) => n.endpoint === endpoint);
  if (taken) {
    die(
      `对外地址 ${endpoint} 已经被节点占用：${taken.name}（${taken.id}，${taken.status}）\n` +
        '  · 换地址：--endpoint <另一个公网地址>:<端口>\n' +
        `  · 或者先在控制台「节点」里删掉它（DELETE /admin/nodes/${taken.id}）再重跑本脚本`,
    );
  }

  /* 4. 签发一次性注册密钥 */
  const issued = await api(masterBase, '/admin/nodes/enroll-key', {
    method: 'POST',
    token,
    body: {
      note: '主控自身注册为子节点',
      region: args.region,
      name,
      host: hostOf(endpoint),
      listenPort,
      connectPort,
    },
  });
  ok(`已签发注册密钥：${issued.enrollKey}`);

  const installArgs = [
    INSTALL_NODE,
    '--master',
    masterBase,
    '--key',
    issued.enrollKey,
    '--region',
    args.region,
    '--name',
    name,
    '--endpoint',
    endpoint,
    '--listen-port',
    String(listenPort),
  ];
  const installCmd = `sudo bash ${installArgs.join(' ')}`;

  if (args.dryRun) {
    console.log('');
    log('--dry-run：下面这些没有执行');
    note(`1) ${installCmd}`);
    note('2) 轮询 /admin/nodes 等这台节点变 online');
    console.log(`\n去掉 --dry-run 再跑一次即可真正执行（上面那把密钥是一次性的，会随本次作废）。\n`);
    return;
  }

  /* 5. 装节点 */
  log(`安装节点：${installCmd}`);
  const install = spawnSync('bash', installArgs, { stdio: 'inherit' });
  if (install.status !== 0) {
    console.error('');
    console.error(color.err('✗ 节点安装失败（安装脚本已打印原因，常见的是 EasyTier 下载超时或端口未放行）'));
    console.error(`  排查与回滚：journalctl -u mclink-node -n 50；不要了就把本机节点关掉：systemctl disable --now mclink-node`);
    process.exitCode = install.status ?? 1;
    return;
  }

  /* 6. 等它上线 */
  log(`等待节点变 online（最长 ${args.wait} 秒；心跳间隔 20 秒）`);
  let node = null;
  for (let i = 0; i < Math.ceil(args.wait / 3); i += 1) {
    await sleep(3000);
    try {
      const list = await api(masterBase, '/admin/nodes', { token });
      node = list.find((n) => n.endpoint === endpoint) ?? null;
      if (node && (node.status === 'online' || node.status === 'degraded')) break;
      if (node) note(`  当前状态：${node.status}`);
    } catch {
      /* 主控短暂不可用就继续等 */
    }
  }

  console.log('');
  if (node && (node.status === 'online' || node.status === 'degraded')) {
    ok(`节点已上线：${node.name}（${node.id}）区域 ${node.region}，状态 ${node.status}`);
  } else if (node) {
    warn(`节点已注册但状态还是 ${node.status}。查它：journalctl -u mclink-node -n 50`);
    note('常见原因：防火墙/安全组没放行该端口的 TCP+UDP、或本机 node.env 里主控地址填错');
  } else {
    warn('节点还没出现在列表里。查它：journalctl -u mclink-node -n 50');
  }

  console.log(`
${color.ok('完成。')}现在控制台「节点」里能看到这台节点，建房时票据里的中继就来自它。

后续：
  · 建房验证：控制台 →「节点」应显示 online；玩家建房后房间详情里能看到这台的节点 ID。
  · 安全组/防火墙：放行 ${listenPort} 的 TCP 与 UDP（EasyTier 两者都用）。
  · 关掉本机节点：systemctl disable --now mclink-node（主控不受影响，转发会回到其它子节点上）。
  · 这台机器的节点令牌在 /etc/mclink/node-token.json —— 重装节点不会换身份，不用重新注册。
`);
}

main().catch((err) => {
  if (err instanceof Fatal) {
    console.error(`\n${color.err('✗')} ${err.message}\n`);
    process.exitCode = err.exitCode ?? 1;
    return;
  }
  console.error(`\n${color.err('✗ 未预期的错误')}\n${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
