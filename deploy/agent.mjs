#!/usr/bin/env node
/**
 * mclink 子节点（区域中继）agent —— 纯 Node 实现，零第三方依赖。
 *
 * 职责：
 *   1) 用一次性注册密钥向主控换取长期节点令牌：POST /api/v1/agent/register
 *      body: { enrollKey, name, region, endpoint, capacityPeers, version, tags }
 *      令牌与主控下发的中继配置落盘到状态目录（默认 /etc/mclink，权限 600）。
 *   2) 把 relayConfigToml 写成配置文件，把 launchArgs 里的 %CONFIG% 换成该文件路径，
 *      然后 spawn easytier-core 并守护它（退出则按指数退避重启）。
 *   3) 每 20 秒 POST /api/v1/agent/heartbeat（Authorization: Bearer <nodeToken>），
 *      上报 peers / rooms / rxBps / txBps / version / publicIp 以及 roomTraffic。
 *      roomTraffic 来自本机 easytier-cli 的 `peer list-foreign`，按网络名聚合。
 *   4) 心跳返回 { ok, configToml, configRevision, disabled }：
 *      disabled 为真 → 停止 easytier-core 并告警；configToml 非空 → 写盘并重启核心。
 *   5) SIGTERM/SIGINT → 优雅退出并 kill 子进程。
 *
 * 为什么 spawn 时把 stdout/stderr 重定向到文件（stdio: ['ignore', fd, fd]）而不是管道：
 *   - 受限沙箱（例如本项目的开发/测试环境）禁止子进程使用管道 stdio，默认的 'pipe'
 *     会直接 EPERM；
 *   - 指向真实文件既绕开该限制，也避免管道缓冲区写满导致子进程阻塞。
 *   同理，需要读取 easytier-cli 的输出时，也是把它的输出写到临时文件再读文件，
 *   而不是读管道。
 *
 * 用法：
 *   node deploy/agent.mjs --master https://cnnic.link --key <注册密钥> \
 *     --region cn-east --endpoint relay-sh.cnnic.link:11010 --name relay-sh
 *   node deploy/agent.mjs --help
 *
 * 环境变量（命令行参数优先）：
 *   MCLINK_NODE_MASTER / MCLINK_NODE_ENROLL_KEY / MCLINK_NODE_REGION /
 *   MCLINK_NODE_ENDPOINT / MCLINK_NODE_NAME / MCLINK_NODE_CAPACITY_PEERS /
 *   MCLINK_NODE_TAGS / MCLINK_NODE_STATE_DIR / MCLINK_NODE_LOG_DIR /
 *   MCLINK_NODE_INTERVAL / MCLINK_NODE_PUBLIC_IP / MCLINK_ET_CORE / MCLINK_ET_CLI
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/* ------------------------------------------------------------------ 常量 */

const AGENT_VERSION = '0.1.0';
/** 与服务端 server/src/easytier/config.ts 的 CONFIG_PLACEHOLDER 保持一致 */
const CONFIG_PLACEHOLDER = '%CONFIG%';
const DEFAULT_RELAY_PORT = 11010;
const DEFAULT_INTERVAL_SECONDS = 20;
/** RPC 端口推导规则必须与服务端一致：16000 + (监听端口 % 1000) */
const RPC_PORTAL_BASE = 16000;
const RPC_PORTAL_MODULO = 1000;
const MAX_BACKOFF_MS = 30_000;

const API_REGISTER = '/api/v1/agent/register';
const API_HEARTBEAT = '/api/v1/agent/heartbeat';
const API_CONFIG = '/api/v1/agent/config';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const HELP = `mclink 子节点（区域中继）agent ${AGENT_VERSION}

把本机注册成 mclink 的区域中继：向主控换取节点令牌，托管一个 easytier-core，
并周期性上报负载与逐房间流量。

用法:
  node agent.mjs --master <主控地址> --key <注册密钥> --region <区域> \\
    --endpoint <公网地址> [--name <节点名>] [更多选项]

必填:
  --master <URL>             主控地址，例如 https://cnnic.link
                             或 MCLINK_NODE_MASTER
  --key <注册密钥>            管理台签发的**一次性**注册密钥（首次注册后即可删除）
                             或 MCLINK_NODE_ENROLL_KEY
  --region <区域>            区域标识，必须是主控已知区域之一：
                             cn-east / cn-south / cn-north / cn-central /
                             cn-southwest / cn-northwest / cn-northeast /
                             hk / oversea（auto 仅用于房间调度，不能用于节点）
                             或 MCLINK_NODE_REGION
  --endpoint <host:port>     客户端连接本节点用的公网地址；端口即**链接端口**，
                             例如 relay-sh.cnnic.link:21010，或 MCLINK_NODE_ENDPOINT
  --listen-port <端口>        **运行端口**：本机 easytier-core 实际监听的端口，
                             默认取 --endpoint 的端口，或 MCLINK_NODE_LISTEN_PORT。
                             NAT/端口映射后面时（本机 11010、对外 21010）写这个。
  --connect-port <端口>       **链接端口**：主控下发给客户端用的端口，
                             默认取 --endpoint 的端口，或 MCLINK_NODE_CONNECT_PORT
                             例如 relay-sh.cnnic.link:11010
                             或 MCLINK_NODE_ENDPOINT

可选:
  --name <名称>              节点显示名，默认取主机名
  --capacity-peers <n>       可承载的最大 peer 数，默认 500
  --tags <a,b>               逗号分隔的标签，最多 8 个
  --state-dir <目录>         令牌与配置的落盘目录，默认 /etc/mclink
  --log-dir <目录>           easytier-core 的日志目录，默认 /var/log/mclink
  --log-file <文件>          同时把 agent 日志追加到该文件
  --core-bin <路径>          easytier-core 路径，默认 <脚本目录>/vendor/easytier/easytier-core
  --cli-bin <路径>           easytier-cli 路径，默认与 easytier-core 同目录
  --interval <秒>            心跳间隔，默认 20（主控默认 20 秒判活，超时 90 秒标离线）
  --public-ip <ip>           本机公网 IP；留空则由主控按请求来源记录
  --log-level <级别>         debug / info / warn / error，默认 info
  --once                     只做一次注册 + 心跳后退出（排障用，仍会启动核心做一次采集）
  --no-core                  只注册与心跳，不 spawn easytier-core（排障用）
  -h, --help                 显示本帮助
  --version                  显示 agent 版本

说明:
  * 首次运行必须提供 --key；注册成功后令牌写入 <state-dir>/node-token.json，
    之后重启不需要再提供注册密钥（注册密钥是一次性的，主控会拒绝复用）。
  * 令牌丢失（例如重装系统）时，需要在管理台重新签发注册密钥。
  * 配置文件写入 <state-dir>/relay.toml，权限 600。
`;

/* ------------------------------------------------------------------ 日志 */

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info', file = null) {
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  let fd = null;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fd = fs.openSync(path.resolve(file), 'a');
    } catch {
      fd = null;
      process.stderr.write(`[warn] 无法打开日志文件 ${file}，仅输出到标准输出\n`);
    }
  }
  const write = (lvl, message, extra) => {
    if ((LEVEL_ORDER[lvl] ?? 20) < threshold) return;
    const line = `${new Date().toISOString()} [${lvl}] ${message}${extra ? ' ' + safeJson(extra) : ''}\n`;
    process.stdout.write(line);
    if (fd !== null) {
      try {
        fs.writeSync(fd, line);
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
  };
  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    close: () => {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* 忽略 */
        }
        fd = null;
      }
    },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------- 小工具 / 解析 */

function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj;
  for (const key of keys) {
    if (key in rec) return rec[key];
  }
  return undefined;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 解析 easytier-cli 输出里的人类可读数值，例如 "17.33 kB" / "1.2 MiB" / "-" / "3.452"。
 * 与 server/src/easytier/manager.ts 的 parseHumanNumber 行为保持一致。
 */
function parseHumanNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const text = value.trim();
  if (text.length === 0 || text === '-') return 0;
  const m = /^([\d.]+)\s*([a-zA-Z]*)$/.exec(text);
  if (!m) return 0;
  const base = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(base)) return 0;
  const unit = (m[2] ?? '').toLowerCase();
  const factors = {
    '': 1,
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return base * (factors[unit] ?? 1);
}

/** 宽松 JSON 解析：容忍前面混有人类可读提示行的情况 */
function parseLooseJson(text) {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 往下走 */
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
  return null;
}

function isValidHostPort(value) {
  const m = /^([a-zA-Z0-9._-]+):(\d{1,5})$/.exec(String(value ?? '').trim());
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535;
}

function portOfEndpoint(endpoint) {
  const m = /^[a-zA-Z0-9._-]+:(\d{1,5})$/.exec(String(endpoint ?? '').trim());
  if (!m) return DEFAULT_RELAY_PORT;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : DEFAULT_RELAY_PORT;
}

/** 端口解析：非法或越界当作"没给"（返回 null），让调用方回退 */
function toPort(value) {
  if (value === undefined || value === null || value === '') return null;
  const port = Number.parseInt(String(value), 10);
  return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : null;
}

/** 与服务端 rpcPortalForListenPort() 完全一致的推导规则 */
function rpcPortalForListenPort(listenPort) {
  return `127.0.0.1:${RPC_PORTAL_BASE + (Math.abs(Math.trunc(listenPort)) % RPC_PORTAL_MODULO)}`;
}

/** 从服务端下发的 launchArgs 里取 rpc portal（`-r` / `--rpc-portal`），没有则按规则推导 */
function resolveRpcPortal(launchArgs, listenPort) {
  for (let i = 0; i < launchArgs.length; i += 1) {
    const arg = launchArgs[i];
    if (arg === '-r' || arg === '--rpc-portal') {
      const value = launchArgs[i + 1];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    if (arg.startsWith('--rpc-portal=')) return arg.slice('--rpc-portal='.length);
  }
  return rpcPortalForListenPort(listenPort);
}

/* ------------------------------------------------------------ HTTP 客户端 */

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 调用主控 API 并拆掉统一响应外壳 `{ ok: true, data: ... }`。
 * 注意：mclink 的所有成功响应都被 http 层包在 data 里，业务体在 data 内部。
 */
async function apiFetch(url, options = {}) {
  const { method = 'GET', token = null, body = null, timeoutMs = 20_000 } = options;
  const headers = { accept: 'application/json' };
  if (body !== null) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', `请求 ${url} 失败: ${err?.message ?? err}`);
  }

  const text = await res.text().catch(() => '');
  const json = text.trim().length > 0 ? parseLooseJson(text) : null;

  if (!res.ok) {
    const code = json?.error?.code ?? `http_${res.status}`;
    const message = json?.error?.message ?? text.trim().slice(0, 300) ?? '';
    throw new ApiError(res.status, code, message || `HTTP ${res.status}`);
  }
  if (json && json.ok === true && Object.prototype.hasOwnProperty.call(json, 'data')) return json.data;
  return json;
}

/* -------------------------------------------------- 运行 easytier-cli 取输出 */

let cliSeq = 0;

/**
 * 把 easytier-cli 的输出写到临时文件再读回来。
 * 不用管道的原因见文件头注释（受限沙箱下管道 stdio 会 EPERM）。
 */
async function runCliToFile(cliBin, args, options = {}) {
  const { timeoutMs = 12_000, cwd = null } = options;
  cliSeq += 1;
  const tmp = path.join(os.tmpdir(), `mclink-cli-${process.pid}-${cliSeq.toString(36)}.log`);
  const fd = fs.openSync(tmp, 'w');
  let child;
  try {
    child = spawn(cliBin, args, {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
    });
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略 */
    }
    fs.rmSync(tmp, { force: true });
    throw new Error(`无法启动 easytier-cli(${cliBin}): ${err?.message ?? err}`);
  }

  let timedOut = false;
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 进程可能已退出 */
      }
      resolve(-1);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-2);
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
  });

  try {
    fs.closeSync(fd);
  } catch {
    /* 忽略 */
  }
  let text = '';
  try {
    text = fs.readFileSync(tmp, 'utf8');
  } catch {
    text = '';
  }
  fs.rmSync(tmp, { force: true });

  if (timedOut) throw new Error(`easytier-cli 超时（${timeoutMs}ms）`);
  if (code === -2) throw new Error('easytier-cli 启动失败（ENOENT？请检查 --cli-bin）');
  return { code, text };
}

/**
 * 采集外来网络（= 房间）的 peer 数与累计收发字节。
 * 命令形态与服务端一致：easytier-cli -p <rpc> -o json peer list-foreign
 * 返回结构：`{ "<网络名>": { peers: [ { peer_id, conns: [ { stats: { rx_bytes, tx_bytes } } ] } ] } }`
 * 可能是空对象 `{}`；字段为 snake_case，数值可能是 "17.33 kB" 这类字符串。
 */
async function collectRoomTraffic(cliBin, rpcPortal) {
  const res = await runCliToFile(cliBin, ['-p', rpcPortal, '-o', 'json', 'peer', 'list-foreign']);
  if (res.code !== 0) {
    throw new Error(`easytier-cli 退出码 ${res.code}: ${res.text.trim().slice(0, 200) || '(无输出)'}`);
  }
  const raw = parseLooseJson(res.text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const container = pick(raw, 'foreignNetworks', 'foreign_networks');
  const map = container && typeof container === 'object' && !Array.isArray(container) ? container : raw;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];

  const out = [];
  for (const [networkName, entry] of Object.entries(map)) {
    const peers = asArray(pick(entry, 'peers'));
    if (peers.length === 0 && (!entry || typeof entry !== 'object')) continue;
    let rx = 0;
    let tx = 0;
    for (const peer of peers) {
      const conns = asArray(pick(peer, 'conns'));
      if (conns.length > 0) {
        for (const conn of conns) {
          const stats = pick(conn, 'stats');
          rx += parseHumanNumber(pick(stats, 'rx_bytes', 'rxBytes'));
          tx += parseHumanNumber(pick(stats, 'tx_bytes', 'txBytes'));
        }
      } else {
        // 兼容少数版本把 stats 直接挂在 peer 上的情况
        rx += parseHumanNumber(pick(peer, 'rx_bytes', 'rxBytes'));
        tx += parseHumanNumber(pick(peer, 'tx_bytes', 'txBytes'));
      }
    }
    out.push({
      networkName,
      peerCount: peers.length,
      rxBytes: Math.round(rx),
      txBytes: Math.round(tx),
    });
  }
  return out;
}

/**
 * 由累计字节差算出 bit/s。
 * 注意单位：平台侧的 rxBps/txBps 全部是 **bit/s**（与 server/src/easytier/manager.ts 一致）。
 */
class TrafficTracker {
  #last = new Map();

  update(items, now = Date.now()) {
    const rooms = [];
    let totalRxBps = 0;
    let totalTxBps = 0;
    let totalPeers = 0;

    for (const item of items) {
      const prev = this.#last.get(item.networkName);
      let rxBps = 0;
      let txBps = 0;
      if (prev) {
        const dt = (now - prev.at) / 1000;
        if (dt > 0.5) {
          // 计数器回绕（实例重启）时 count 会变小，用 max(0, ...) 兜底
          rxBps = Math.max(0, Math.round(((item.rxBytes - prev.rx) * 8) / dt));
          txBps = Math.max(0, Math.round(((item.txBytes - prev.tx) * 8) / dt));
        }
      }
      this.#last.set(item.networkName, { rx: item.rxBytes, tx: item.txBytes, at: now });
      rooms.push({ ...item, rxBps, txBps });
      totalRxBps += rxBps;
      totalTxBps += txBps;
      totalPeers += item.peerCount;
    }

    // 已经消失的房间从表里清掉，避免长期运行后内存里堆积陈旧键
    for (const key of [...this.#last.keys()]) {
      if (!rooms.some((r) => r.networkName === key)) this.#last.delete(key);
    }
    return { rooms, totalRxBps, totalTxBps, totalPeers };
  }
}

/* --------------------------------------------------------- 核心进程守护 */

class CoreSupervisor {
  #child = null;
  #stopping = false;
  #disabled = false;
  #restarts = 0;
  #restartTimer = null;
  #logFd = null;

  constructor(options) {
    this.coreBin = options.coreBin;
    this.args = options.args;
    this.configFile = options.configFile;
    this.logFile = options.logFile;
    this.log = options.log;
  }

  get running() {
    return this.#child !== null;
  }

  set disabled(value) {
    this.#disabled = Boolean(value);
  }

  get restarts() {
    return this.#restarts;
  }

  start() {
    if (this.#child) return;
    if (this.#disabled) {
      this.log.warn('节点已被主控禁用，跳过启动 easytier-core');
      return;
    }
    if (!fs.existsSync(this.coreBin)) {
      this.log.error(`找不到 easytier-core: ${this.coreBin}（可用 --core-bin 指定，或重跑 install-node.sh）`);
      return;
    }
    if (!fs.existsSync(this.configFile)) {
      this.log.error(`找不到配置文件: ${this.configFile}`);
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      this.#logFd = fs.openSync(this.logFile, 'a');
    } catch (err) {
      this.#logFd = null;
      this.log.warn(`无法打开 easytier-core 日志 ${this.logFile}: ${err?.message ?? err}`);
    }

    this.#stopping = false;
    const stdio = this.#logFd === null ? 'ignore' : ['ignore', this.#logFd, this.#logFd];
    try {
      this.#child = spawn(this.coreBin, this.args, {
        stdio,
        windowsHide: true,
        cwd: path.dirname(this.configFile),
      });
    } catch (err) {
      this.#child = null;
      this.#closeLogFd();
      this.log.error(`启动 easytier-core 失败: ${err?.message ?? err}`);
      this.#scheduleRestart();
      return;
    }

    const pid = this.#child.pid;
    this.log.info(`easytier-core 已启动 pid=${pid}`, { bin: this.coreBin, args: this.args.join(' ') });

    this.#child.on('error', (err) => {
      this.log.error(`easytier-core 进程错误: ${err.message}`);
    });

    this.#child.on('close', (code) => {
      this.#child = null;
      this.#closeLogFd();
      if (this.#stopping) {
        this.log.info('easytier-core 已停止');
        return;
      }
      this.log.error(`easytier-core 意外退出，退出码 ${code}`);
      this.#scheduleRestart();
    });
  }

  /** 停止并等待子进程退出；必要时升级为 SIGKILL */
  async stop(reason = '停止', timeoutMs = 6000) {
    this.#stopping = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (!child) {
      this.#closeLogFd();
      return;
    }
    this.log.info(`正在停止 easytier-core（${reason}）`);
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 可能已退出 */
        }
        resolve();
      }, timeoutMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        // Windows 上 Node 会把 SIGTERM 映射成 TerminateProcess
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.#child = null;
    this.#closeLogFd();
  }

  async restart(reason) {
    await this.stop(reason);
    this.#stopping = false;
    this.#restarts = 0;
    this.start();
  }

  #scheduleRestart() {
    if (this.#disabled) return;
    // 与服务端 EasytierCore 相同的退避公式：1s,2s,4s,8s,16s,32s→30s 封顶
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.#restarts, 5));
    this.#restarts += 1;
    this.log.warn(`easytier-core 将在 ${backoff}ms 后重启（第 ${this.#restarts} 次）`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.start();
    }, backoff);
  }

  #closeLogFd() {
    if (this.#logFd !== null) {
      try {
        fs.closeSync(this.#logFd);
      } catch {
        /* 忽略 */
      }
      this.#logFd = null;
    }
  }
}

/* ------------------------------------------------------------------ 配置 */

function parseArgv(argv) {
  const opts = {};
  let help = false;
  let version = false;
  // 注意：i 必须声明在循环之外，need()/value() 才能读到它并消费下一个参数
  let i = 0;

  const need = (flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} 缺少参数值`);
  };

  for (i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inlineValue = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 2) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = () => {
      if (inlineValue !== null) return inlineValue;
      need(arg);
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '--version':
        version = true;
        break;
      case '--master':
        opts.master = value();
        break;
      case '--key':
        opts.enrollKey = value();
        break;
      case '--region':
        opts.region = value();
        break;
      case '--endpoint':
        opts.endpoint = value();
        break;
      case '--listen-port':
        opts.listenPort = value();
        break;
      case '--connect-port':
        opts.connectPort = value();
        break;
      case '--name':
        opts.name = value();
        break;
      case '--capacity-peers':
        opts.capacityPeers = Number.parseInt(value(), 10);
        break;
      case '--tags':
        opts.tags = String(value())
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      case '--state-dir':
        opts.stateDir = value();
        break;
      case '--log-dir':
        opts.logDir = value();
        break;
      case '--log-file':
        opts.logFile = value();
        break;
      case '--core-bin':
        opts.coreBin = value();
        break;
      case '--cli-bin':
        opts.cliBin = value();
        break;
      case '--interval':
        opts.interval = Number.parseInt(value(), 10);
        break;
      case '--public-ip':
        opts.publicIp = value();
        break;
      case '--log-level':
        opts.logLevel = value();
        break;
      case '--once':
        opts.once = true;
        break;
      case '--no-core':
        opts.noCore = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }
  return { opts, help, version };
}

function envStr(name) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function resolveConfig(opts) {
  const coreBinDefault = path.join(SCRIPT_DIR, 'vendor', 'easytier', process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core');
  const cliName = process.platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli';

  const coreBin = opts.coreBin ?? envStr('MCLINK_ET_CORE') ?? coreBinDefault;
  const cliBin = opts.cliBin ?? envStr('MCLINK_ET_CLI') ?? path.join(path.dirname(coreBin), cliName);

  const stateDir = path.resolve(opts.stateDir ?? envStr('MCLINK_NODE_STATE_DIR') ?? '/etc/mclink');
  const logDir = path.resolve(opts.logDir ?? envStr('MCLINK_NODE_LOG_DIR') ?? '/var/log/mclink');

  const intervalRaw = opts.interval ?? Number.parseInt(envStr('MCLINK_NODE_INTERVAL') ?? '', 10);
  const interval = Number.isFinite(intervalRaw) && intervalRaw >= 5 ? intervalRaw : DEFAULT_INTERVAL_SECONDS;

  const capacityRaw = opts.capacityPeers ?? Number.parseInt(envStr('MCLINK_NODE_CAPACITY_PEERS') ?? '', 10);
  const capacityPeers = Number.isFinite(capacityRaw) && capacityRaw >= 10 ? capacityRaw : 500;

  const tags = opts.tags ?? (envStr('MCLINK_NODE_TAGS') ? envStr('MCLINK_NODE_TAGS').split(',').map((t) => t.trim()).filter(Boolean) : []);

  return {
    master: (opts.master ?? envStr('MCLINK_NODE_MASTER') ?? '').replace(/\/+$/, ''),
    enrollKey: opts.enrollKey ?? envStr('MCLINK_NODE_ENROLL_KEY') ?? '',
    region: opts.region ?? envStr('MCLINK_NODE_REGION') ?? '',
    endpoint: (opts.endpoint ?? envStr('MCLINK_NODE_ENDPOINT') ?? '').trim(),
    /*
     * 两个端口：
     *   listenPort  —— 本机 easytier-core 实际监听的端口（NAT 后面就是本机那个）
     *   connectPort —— 主控下发给客户端的端口
     * 都没给时回退到 endpoint 里的端口，保持与旧命令兼容。
     */
    listenPort: toPort(opts.listenPort ?? envStr('MCLINK_NODE_LISTEN_PORT')),
    connectPort: toPort(opts.connectPort ?? envStr('MCLINK_NODE_CONNECT_PORT')),
    name: (opts.name ?? envStr('MCLINK_NODE_NAME') ?? os.hostname()).slice(0, 40),
    capacityPeers,
    tags: tags.slice(0, 8).map((t) => String(t).slice(0, 24)),
    stateDir,
    logDir,
    logFile: opts.logFile ?? envStr('MCLINK_NODE_LOG_FILE') ?? path.join(logDir, 'agent.log'),
    coreBin,
    cliBin,
    interval,
    publicIp: opts.publicIp ?? envStr('MCLINK_NODE_PUBLIC_IP') ?? null,
    logLevel: (opts.logLevel ?? envStr('MCLINK_NODE_LOG_LEVEL') ?? 'info').toLowerCase(),
    once: opts.once === true,
    noCore: opts.noCore === true,
    tokenFile: path.join(stateDir, 'node-token.json'),
    configFile: path.join(stateDir, 'relay.toml'),
    coreLogFile: path.join(logDir, 'easytier-core.log'),
  };
}

function validateConfig(cfg) {
  const problems = [];
  if (!cfg.master) problems.push('缺少 --master（主控地址），或 MCLINK_NODE_MASTER');
  else if (!/^https?:\/\//i.test(cfg.master)) problems.push(`--master 必须以 http:// 或 https:// 开头: ${cfg.master}`);
  if (!cfg.region) problems.push('缺少 --region（区域标识），或 MCLINK_NODE_REGION');
  if (!cfg.endpoint) problems.push('缺少 --endpoint（公网地址 host:port），或 MCLINK_NODE_ENDPOINT');
  else if (!isValidHostPort(cfg.endpoint)) problems.push(`--endpoint 格式应为 host:port: ${cfg.endpoint}`);
  if (!['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) problems.push(`--log-level 只能取 debug/info/warn/error: ${cfg.logLevel}`);
  return problems;
}

/* ------------------------------------------------------------------ 状态 */

function loadState(cfg) {
  try {
    const raw = fs.readFileSync(cfg.tokenFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.nodeToken === 'string' && parsed.nodeToken.length > 0) {
      return parsed;
    }
  } catch {
    /* 首次运行或文件损坏 */
  }
  return null;
}

function saveState(cfg, state, log) {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const payload = {
    nodeId: state.nodeId ?? null,
    nodeToken: state.nodeToken,
    master: cfg.master,
    region: cfg.region,
    endpoint: cfg.endpoint,
    launchArgs: state.launchArgs ?? null,
    listenPort: cfg.listenPort ?? portOfEndpoint(cfg.endpoint),
    connectPort: cfg.connectPort ?? portOfEndpoint(cfg.endpoint),
    configRevision: state.configRevision ?? 0,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${cfg.tokenFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, cfg.tokenFile);
  try {
    fs.chmodSync(cfg.tokenFile, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
  log.debug('节点状态已落盘', { file: cfg.tokenFile });
  return payload;
}

function writeRelayConfig(cfg, toml, log) {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${cfg.configFile}.tmp`;
  fs.writeFileSync(tmp, toml, { mode: 0o600 });
  fs.renameSync(tmp, cfg.configFile);
  try {
    fs.chmodSync(cfg.configFile, 0o600);
  } catch {
    /* 忽略 */
  }
  log.debug('中继配置已落盘', { file: cfg.configFile, bytes: toml.length });
}

/** 把 launchArgs 里的 %CONFIG% 换成真实路径；若没有 -c 则补一个 */
function materializeLaunchArgs(launchArgs, configFile) {
  const source = asArray(launchArgs).filter((a) => typeof a === 'string');
  const replaced = source.map((arg) => arg.split(CONFIG_PLACEHOLDER).join(configFile));
  const hasConfig = replaced.some((arg) => arg === configFile) || replaced.includes('-c') || replaced.some((a) => a.startsWith('--config'));
  return hasConfig ? replaced : ['-c', configFile, ...replaced];
}

/* ------------------------------------------------------------------ 注册 */

async function register(cfg, log) {
  if (!cfg.enrollKey) {
    throw new Error(
      `尚未注册且没有可用的注册密钥。请带 --key <注册密钥> 再运行一次（注册密钥在管理台「节点」页签发）。`,
    );
  }
  log.info('向主控注册子节点…', {
    master: cfg.master,
    region: cfg.region,
    endpoint: cfg.endpoint,
    listenPort: cfg.listenPort ?? portOfEndpoint(cfg.endpoint),
  });

  const data = await apiFetch(`${cfg.master}${API_REGISTER}`, {
    method: 'POST',
    body: {
      enrollKey: cfg.enrollKey,
      name: cfg.name,
      region: cfg.region,
      endpoint: cfg.endpoint,
      // 运行端口与链接端口分开上报：主控据此生成监听配置与客户端票据
      listenPort: cfg.listenPort ?? undefined,
      connectPort: cfg.connectPort ?? undefined,
      capacityPeers: cfg.capacityPeers,
      version: AGENT_VERSION,
      tags: cfg.tags,
    },
  });

  // 服务端返回 { node: RelayNode, nodeToken, relayConfigToml, launchArgs }
  // （protocol.ts 的 AgentEnrollResponse 写的是 nodeId，这里两种都兼容）
  const nodeId = data?.node?.id ?? data?.nodeId ?? null;
  const nodeToken = data?.nodeToken ?? data?.token ?? null;
  if (!nodeToken) throw new Error('注册响应里没有 nodeToken，可能是主控版本不匹配');

  const relayConfigToml = typeof data?.relayConfigToml === 'string' ? data.relayConfigToml : '';
  const launchArgs = asArray(data?.launchArgs).filter((a) => typeof a === 'string');

  log.info(`注册成功，节点 ID ${nodeId ?? '(未知)'}`);

  if (relayConfigToml.trim().length > 0) {
    writeRelayConfig(cfg, relayConfigToml, log);
    log.info('已写入中继配置', { file: cfg.configFile });
  } else {
    log.warn('主控未下发 relayConfigToml，将沿用本地已有配置');
  }

  try {
    return saveState(
      cfg,
      {
        nodeId,
        nodeToken,
        launchArgs: launchArgs.length > 0 ? launchArgs : ['-c', CONFIG_PLACEHOLDER],
        configRevision: 0,
      },
      log,
    );
  } catch (err) {
    /*
     * 走到这里是最坏的一种状态：主控那边**注册已经成功、一次性密钥已被消耗**，
     * 但令牌没能落盘。必须把这件事说透 —— 否则下次重启只会看到"密钥已被使用"，
     * 完全看不出"其实注册成功过、只是令牌丢了"。
     */
    const wrapped = new Error(
      `节点令牌写入失败（${err?.code ?? err?.message}）：${cfg.tokenFile}。` +
        `⚠ 注册已经成功、这把一次性密钥已被消耗，但令牌没保存下来。` +
        `请先修好目录归属（sudo chown -R mclink:mclink ${cfg.stateDir}），` +
        `然后到管理台重新签发一把注册密钥再跑。`,
    );
    wrapped.code = 'TOKEN_NOT_PERSISTED';
    throw wrapped;
  }
}

/**
 * 注册前先确认状态目录可写。
 *
 * 为什么必须在**注册之前**检查：注册密钥是一次性的。如果先注册成功、
 * 再发现令牌写不下来，那把密钥就白扔了 —— 而 systemd 之后每次重启都会拿着
 * 同一把废密钥去注册，得到"注册密钥已被使用"，无限重启（实测 restart counter 132）。
 * 与其让它烧掉密钥并陷入循环，不如在动手之前就说清楚。
 */
function assertStateWritable(cfg, log) {
  const probe = path.join(cfg.stateDir, '.mclink-write-probe');
  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
  } catch (err) {
    throw new Error(
      `状态目录不可写：${cfg.stateDir}（${err?.code ?? err?.message}）。` +
        `agent 以当前用户运行，需要能在这里写节点令牌与中继配置。` +
        `请先修好归属：sudo chown -R mclink:mclink ${cfg.stateDir}，再重跑。` +
        `（注册密钥是一次性的，此时还没有被消耗掉。）`,
    );
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      /* 探针文件清不掉不影响判断 */
    }
  }
  log.debug('状态目录可写', { dir: cfg.stateDir });
}

/* ---------------------------------------------------------------- 心跳 */

let lastCliErrorAt = 0;

async function collectTrafficSafely(cfg, tracker, log) {
  try {
    const items = await collectRoomTraffic(cfg.cliBin, cfg.rpcPortal);
    const snapshot = tracker.update(items);
    if (snapshot.rooms.length === 0) log.debug('未发现外来网络（当前没有房间经过本节点）');
    return snapshot;
  } catch (err) {
    // easytier-cli 不可用时不要刷屏：同一类错误最多 5 分钟告警一次
    const now = Date.now();
    if (now - lastCliErrorAt > 300_000) {
      lastCliErrorAt = now;
      log.warn(`采集房间流量失败（将上报 0，直至恢复）: ${err?.message ?? err}`);
    }
    return { rooms: [], totalRxBps: 0, totalTxBps: 0, totalPeers: 0 };
  }
}

function buildHeartbeatBody(cfg, tracker, traffic, state) {
  const body = {
    version: AGENT_VERSION,
    peers: traffic.totalPeers,
    rooms: traffic.rooms.length,
    rxBps: traffic.totalRxBps,
    txBps: traffic.totalTxBps,
    roomTraffic: traffic.rooms.map((r) => ({
      networkName: r.networkName,
      peerCount: r.peerCount,
      // 逐房间的累计字节：主控用它累加房间用量账本
      rxBytes: r.rxBytes,
      txBytes: r.txBytes,
      rxBps: r.rxBps,
      txBps: r.txBps,
    })),
    // 服务端当前不消费该字段（预留），上报便于将来做配置版本收敛
    appliedConfigRevision: state.configRevision ?? 0,
  };
  if (cfg.publicIp) body.publicIp = cfg.publicIp;
  return body;
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.stderr.write('用 --help 查看用法。\n');
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`mclink-agent ${AGENT_VERSION}\n`);
    return 0;
  }

  const cfg = resolveConfig(parsed.opts);
  const problems = validateConfig(cfg);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`[错误] ${problem}\n`);
    process.stderr.write('用 --help 查看完整用法。\n');
    return 2;
  }

  const log = createLogger(cfg.logLevel, cfg.logFile);
  log.info(`mclink 子节点 agent ${AGENT_VERSION} 启动`, {
    master: cfg.master,
    region: cfg.region,
    endpoint: cfg.endpoint,
    name: cfg.name,
    node: process.version,
    stateDir: cfg.stateDir,
    interval: cfg.interval,
  });

  let state = loadState(cfg);
  // 提前声明，保证注册阶段就收到 SIGTERM 时也能优雅收敛
  let shuttingDown = false;
  let core = null;

  if (state) {
    log.info('已加载本地节点令牌', { nodeId: state.nodeId ?? '(未知)', file: cfg.tokenFile });
  } else {
    try {
      // 先确认写不写得下，再去消耗那把一次性密钥
      assertStateWritable(cfg, log);
      state = await register(cfg, log);
      log.info('注册密钥已完成使命，可以从 node.env 中删除 MCLINK_NODE_ENROLL_KEY');
    } catch (err) {
      log.error(`注册失败: ${err?.message ?? err}`);
      if (err instanceof ApiError && err.code === 'forbidden') {
        log.error('注册密钥无效 / 已被使用 / 已被吊销：请在管理台重新签发后重试');
      }
      if (err?.code === 'TOKEN_NOT_PERSISTED') {
        log.error('▲ 注意：这次注册其实**已经成功**，密钥被消耗了，只是令牌没写下来。');
      }
      /*
       * 这类错误是"配置不对"，重试一百次也是同一个结果：
       * 所以返回 3，配合 systemd 单元的 RestartPreventExitCode=3 停掉重启循环 ——
       * 让服务明明白白地处于 failed，而不是每 3 秒重启一次把真正的原因刷没。
       */
      log.close();
      return 3;
    }
  }

  if (shuttingDown) {
    log.info('注册阶段收到退出信号，直接退出');
    log.close();
    return 0;
  }

  const launchArgs = materializeLaunchArgs(state.launchArgs ?? ['-c', CONFIG_PLACEHOLDER], cfg.configFile);
  /*
   * 这里必须用**运行端口**（本机监听的那个），不是链接端口：
   * RPC portal 的推导规则在主控侧（rpcPortalForListenPort）也是按监听端口算的，
   * 两边不一致时同机多节点会撞 RPC 端口。
   */
  const listenPort = cfg.listenPort ?? portOfEndpoint(cfg.endpoint);
  cfg.rpcPortal = resolveRpcPortal(launchArgs, listenPort);
  log.info('本机 EasyTier RPC 端口', { rpcPortal: cfg.rpcPortal, listenPort, rule: `${RPC_PORTAL_BASE} + port % ${RPC_PORTAL_MODULO}` });

  core = new CoreSupervisor({
    coreBin: cfg.coreBin,
    args: launchArgs,
    configFile: cfg.configFile,
    logFile: cfg.coreLogFile,
    log,
  });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，正在优雅退出…`);
    if (core) await core.stop(`收到 ${signal}`);
    log.info('已退出');
    log.close();
  };
  const onSignal = (signal) => {
    // 不要在这里 process.exit()：让 main 的循环自然收敛后退出，
    // 否则 Windows 上可能撞上 libuv 的 async handle 断言（0xC0000409）。
    void shutdown(signal);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  if (!cfg.noCore) {
    core.start();
  } else {
    log.warn('--no-core：不启动 easytier-core，只做注册与心跳');
  }

  const tracker = new TrafficTracker();
  let consecutiveAuthFailures = 0;
  let registeredAt = Date.now();
  let disabledLogged = false;
  let lastTraffic = { rooms: [], totalRxBps: 0, totalTxBps: 0, totalPeers: 0 };

  const beat = async () => {
    const traffic = await collectTrafficSafely(cfg, tracker, log);
    lastTraffic = traffic;
    const body = buildHeartbeatBody(cfg, tracker, traffic, state);

    let result;
    try {
      result = await apiFetch(`${cfg.master}${API_HEARTBEAT}`, { method: 'POST', token: state.nodeToken, body });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        consecutiveAuthFailures += 1;
        log.error(`心跳鉴权失败（第 ${consecutiveAuthFailures} 次）: ${err.message}`);
        if (consecutiveAuthFailures >= 3) {
          // 令牌失效（节点被删除 / 令牌轮换）→ 尝试用注册密钥重新注册，最多每小时一次
          if (cfg.enrollKey && Date.now() - registeredAt > 3_600_000) {
            log.warn('尝试用注册密钥重新注册…');
            try {
              state = await register(cfg, log);
              registeredAt = Date.now();
              consecutiveAuthFailures = 0;
            } catch (reErr) {
              log.error(`重新注册失败: ${reErr?.message ?? reErr}`);
            }
          } else {
            log.error('令牌已失效且无法自动恢复：请在管理台重新签发注册密钥，然后用 --key 重启本服务');
          }
        }
        return;
      }
      log.warn(`心跳失败（下个周期重试）: ${err?.message ?? err}`);
      return;
    }

    consecutiveAuthFailures = 0;

    if (result?.disabled) {
      core.disabled = true;
      if (!disabledLogged) {
        disabledLogged = true;
        log.warn('本节点已被主控禁用：停止 easytier-core，不再参与中继调度（管理台重新启用后自动恢复）');
      }
      if (core.running) {
        await core.stop('被主控禁用');
      }
    } else {
      if (disabledLogged) {
        disabledLogged = false;
        log.info('本节点已恢复启用');
      }
      core.disabled = false;
      if (!cfg.noCore && !core.running) core.start();
    }

    // 主控下发了新配置（ACL / 限速等）→ 写盘并重启核心
    if (typeof result?.configToml === 'string' && result.configToml.trim().length > 0) {
      let current = '';
      try {
        current = fs.readFileSync(cfg.configFile, 'utf8');
      } catch {
        current = '';
      }
      if (current.trim() !== result.configToml.trim()) {
        log.info('主控下发了新的中继配置，重启 easytier-core 以生效', {
          configRevision: result.configRevision,
        });
        writeRelayConfig(cfg, result.configToml, log);
        state = saveState(
          cfg,
          { ...state, configRevision: Number(result.configRevision ?? 0) },
          log,
        );
        if (cfg.noCore) {
          log.warn('--no-core：配置已落盘，但不会重启 easytier-core');
        } else {
          await core.restart('配置变更');
        }
      } else if (Number(result.configRevision ?? 0) !== Number(state.configRevision ?? 0)) {
        state = saveState(cfg, { ...state, configRevision: Number(result.configRevision ?? 0) }, log);
      }
    }

    log.debug('心跳完成', {
      peers: body.peers,
      rooms: body.rooms,
      rxBps: body.rxBps,
      txBps: body.txBps,
    });
  };

  if (cfg.once) {
    log.info('--once：执行一次心跳后退出');
    await beat();
    await core.stop('--once 结束');
    log.info('单次运行完成', {
      rooms: lastTraffic.rooms.length,
      peers: lastTraffic.totalPeers,
      rpcPortal: cfg.rpcPortal,
    });
    log.close();
    return 0;
  }

  log.info(`进入心跳循环（每 ${cfg.interval} 秒一次），Ctrl-C 退出`);
  while (!shuttingDown) {
    await beat();
    // 分段等待，保证 SIGTERM 能及时生效
    const deadline = Date.now() + cfg.interval * 1000;
    while (!shuttingDown && Date.now() < deadline) {
      await sleep(Math.min(1000, Math.max(50, deadline - Date.now())));
    }
  }

  log.close();
  return 0;
}

main()
  .then((code) => {
    // 用 exitCode 而不是 process.exit()：退出时若 undici 的 keep-alive 连接仍在关闭，
    // Windows 上 process.exit() 会触发 libuv 断言（0xC0000409 / STATUS_STACK_BUFFER_OVERRUN）。
    // 设置 exitCode 后进程会在事件循环清空时正常退出（最多多等几秒）。
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`[错误] agent 异常退出: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
