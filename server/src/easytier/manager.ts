/**
 * 主控中继管理器。
 *
 * 设计要点（对应「单端口多用户隔离」这条需求）：
 *  主控只跑 **一个** easytier-core 实例，监听一个 TCP+UDP 端口（默认 11010）。
 *  它属于 `mclink-master` 网络，但对 `relay_network_whitelist` 中匹配的外来网络
 *  （默认 `mclink-room-*`）提供中继与 rendezvous 服务。
 *  每个房间是独立的 network_name + 随机 secret，因此：
 *    - 复用同一个端口；
 *    - 网络平面彼此隔离，无法互相发现；
 *    - 新增/关闭房间都不需要重启中继进程（whitelist 用通配模式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ForeignNetworkInfo, RelayRuntime } from '@mclink/shared';
import type { ServerConfig } from '../config.ts';
import { logger } from '../logger.ts';
import { EasytierCore, type CoreStatus } from './process.ts';
import { cliJson, probeCli, runCli } from './cli.ts';
import { renderEasytierToml } from './config.ts';

const log = logger('relay');

/* ------------------------------------------------------------ 数据结构 */

export interface PeerSnapshot {
  peerId: number;
  hostname: string;
  ipv4: string;
  cost: string;
  latencyMs: number | null;
  lossRate: number | null;
  rxBytes: number;
  txBytes: number;
  tunnelProto: string;
  networkName: string;
}

export interface ForeignNetworkSnapshot {
  networkName: string;
  peerCount: number;
  rxBytes: number;
  txBytes: number;
  peers: Array<{ peerId: number; rxBytes: number; txBytes: number; latencyUs: number | null }>;
}

/* --------------------------------------------------------- 字段兼容取值 */

/**
 * prost + serde 生成的结构在不同版本里可能是 camelCase 或 snake_case，
 * 这里两种都接受，避免因为上游改名而解析失败。
 */
function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in rec) return rec[k];
  }
  return undefined;
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * easytier-cli 的 `peer list -o json` 输出的是「展示用表格」，
 * 数值字段被格式化成人类可读字符串（如 "17.33 kB"、"-"、"3.452"）。
 * 这里统一解析回数字，解析不了就返回 0。
 */
export function parseHumanNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const text = value.trim();
  if (text.length === 0 || text === '-') return 0;

  const m = /^([\d.]+)\s*([a-zA-Z]*)$/.exec(text);
  if (!m) return 0;
  const base = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(base)) return 0;
  const unit = (m[2] ?? '').toLowerCase();

  // 十进制单位（kB/MB…）与二进制单位（KiB/MiB…）都接受
  const factors: Record<string, number> = {
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

/** 解析 `3.452`（毫秒）这类延迟字段；"-" 表示未知 */
export function parseLatencyMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text === '-' || text === '*') return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

/* --------------------------------------------------------------- 管理器 */

export interface RelayEvents {
  state: [RelayRuntime];
  sample: [RelaySample];
}

export interface RelaySample {
  ts: string;
  foreignNetworks: ForeignNetworkInfo[];
  peers: PeerSnapshot[];
  totalRxBytes: number;
  totalTxBytes: number;
  rxBps: number;
  txBps: number;
  peerCount: number;
}

export class RelayManager extends EventEmitter<RelayEvents> {
  readonly #config: ServerConfig;
  #core: EasytierCore | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #lastTotals: { rx: number; tx: number; at: number } | null = null;
  #lastForeign: Map<string, { rx: number; tx: number; at: number; rxBps: number; txBps: number }> = new Map();
  #latest: RelaySample | null = null;
  #cliOk: boolean | null = null;
  #cliVersion: string | null = null;
  #lastError: string | null = null;
  #aclSetSupport: boolean | null = null;
  /** 管理员通过接口下发的 ACL；非 null 时覆盖内置的守卫规则 */
  #customAclToml: string | null = null;

  constructor(config: ServerConfig) {
    super();
    this.#config = config;
  }

  get configFilePath(): string {
    return path.join(this.#config.easytier.configDir, 'relay.toml');
  }

  get logFilePath(): string {
    return path.join(this.#config.dataDir, 'logs', 'relay.log');
  }

  get rpcPortal(): string {
    return this.#config.easytier.relayRpcPortal;
  }

  get core(): EasytierCore | null {
    return this.#core;
  }

  /** 生成中继实例的 TOML 配置 */
  renderConfig(): string {
    const et = this.#config.easytier;
    const listeners = [
      `tcp://0.0.0.0:${et.relayPort}`,
      `udp://0.0.0.0:${et.relayPort}`,
    ];

    const acl = this.#buildRelayAcl();

    return renderEasytierToml({
      instanceName: 'mclink-relay',
      hostname: 'mclink-relay',
      dhcp: true,
      listeners,
      peers: [],
      networkName: et.relayNetworkName,
      networkSecret: et.relayNetworkSecret,
      consoleLogLevel: this.#config.logLevel === 'debug' ? 'info' : 'warn',
      flags: {
        noTun: et.relayNoTun,
        multiThread: et.relayMultiThread,
        enableEncryption: true,
        enableIpv6: true,
        relayNetworkWhitelist: et.relayNetworkWhitelist,
        // 平台级中继出口限速；0 表示不限，此时不下发该字段以沿用 EasyTier 默认（u64::MAX）
        ...(et.relayForeignBpsLimit > 0
          ? { foreignRelayBpsLimit: et.relayForeignBpsLimit }
          : {}),
        // 主控自身不参与 P2P 打洞，专心做中继；减少无谓的探测开销
        disableUdpHolePunching: false,
        defaultProtocol: 'tcp',
        bindDevice: false,
        // 允许 DHCP 分配（主控自己用一个 10.126.x.x 地址即可）
        latencyFirst: false,
      },
      acl,
      extraToml: this.#customAclToml,
      fileLogDir: null,
    });
  }

  /**
   * 中继自身的 ACL：把「来自某个房间虚拟网段的流量」挡在管理网之外。
   * 主控中继的 tun 已关闭（no_tun = true），所以这里主要是防御性配置，
   * 用来明确表达「房间流量只走中转，不得访问主控管理面」。
   */
  #buildRelayAcl() {
    return {
      chains: [
        {
          name: 'mclink_relay_guard',
          chainType: 1,
          description: '禁止房间虚拟网段访问主控管理网',
          enabled: true,
          defaultAction: 1,
          rules: [
            {
              name: 'block_room_subnets_to_master',
              description: '房间网段 10.200.0.0/16 到主控管理网的流量一律丢弃',
              priority: 20000,
              protocol: 5,
              sourceIps: ['10.200.0.0/16'],
              destinationIps: ['10.126.0.0/16'],
              action: 2,
              enabled: true,
              stateful: false,
            },
          ],
        },
      ],
    };
  }

  /** 写入配置并启动（若已在运行则重启） */
  async start(): Promise<RelayRuntime> {
    const et = this.#config.easytier;
    fs.mkdirSync(et.configDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
    fs.writeFileSync(this.configFilePath, this.renderConfig(), 'utf8');

    if (this.#core?.running) {
      await this.#core.restart();
      return this.status();
    }

    this.#core = new EasytierCore({
      coreBin: et.coreBin,
      configFile: this.configFilePath,
      // rpc_portal 不是配置文件字段，必须走命令行
      rpcPortal: et.relayRpcPortal,
      rpcPortalWhitelist: ['127.0.0.1/32'],
      logFile: this.logFilePath,
      autoRestart: true,
    });
    const core = this.#core;
    // 先挂上就绪等待，再启动：否则可能错过 'state' 事件
    const ready = waitForCoreSettled(core, 10_000);
    core.on('state', () => this.#emitState());
    await core.start();
    await ready;
    this.#emitState();
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopPolling();
    await this.#core?.stop();
    this.#emitState();
  }

  async restart(): Promise<RelayRuntime> {
    return this.start();
  }

  /** 校验 CLI 可用性；返回 false 时管理台会给出明确告警 */
  async ensureCli(): Promise<boolean> {
    if (this.#cliOk !== null) return this.#cliOk;
    const probe = await probeCli(this.#config.easytier.cliBin);
    this.#cliOk = probe.ok;
    this.#cliVersion = probe.version;
    if (!probe.ok) {
      this.#lastError = `easytier-cli 不可用: ${probe.error}`;
      log.warn('easytier-cli 探测失败，流量统计与 ACL 下发将不可用', { error: probe.error });
    } else {
      log.info('easytier-cli 就绪', { version: probe.version });
    }
    return probe.ok;
  }

  get cliVersion(): string | null {
    return this.#cliVersion;
  }

  status(): RelayRuntime {
    const et = this.#config.easytier;
    const core = this.#core?.status;
    const sample = this.#latest;
    return {
      running: core?.state === 'running',
      listen: `0.0.0.0:${et.relayPort}`,
      networkName: et.relayNetworkName,
      peerId: sample ? String(sample.peerCount) : null,
      peerCount: sample?.peerCount ?? 0,
      foreignNetworks: sample?.foreignNetworks ?? [],
      rxBytes: sample?.totalRxBytes ?? 0,
      txBytes: sample?.totalTxBytes ?? 0,
      startedAt: core?.startedAt ?? null,
      lastError: core?.lastError ?? this.#lastError,
    };
  }

  /** 拉取一次全量样本（peers + 外来网络），供轮询与手动刷新使用 */
  async sample(): Promise<RelaySample | null> {
    if (!(await this.ensureCli())) return null;
    const core = this.#core;
    if (!core?.running) return null;

    try {
      const [peers, foreign] = await Promise.all([this.#fetchPeers(), this.#fetchForeignNetworks()]);
      const now = Date.now();
      const ts = new Date(now).toISOString();

      const totalRx = peers.reduce((acc, p) => acc + p.rxBytes, 0);
      const totalTx = peers.reduce((acc, p) => acc + p.txBytes, 0);
      let rxBps = 0;
      let txBps = 0;
      if (this.#lastTotals) {
        const dt = (now - this.#lastTotals.at) / 1000;
        if (dt > 0.5) {
          rxBps = Math.max(0, Math.round(((totalRx - this.#lastTotals.rx) * 8) / dt));
          txBps = Math.max(0, Math.round(((totalTx - this.#lastTotals.tx) * 8) / dt));
        }
      }
      this.#lastTotals = { rx: totalRx, tx: totalTx, at: now };

      const foreignNetworks: ForeignNetworkInfo[] = foreign.map((fn) => {
        const prev = this.#lastForeign.get(fn.networkName);
        let frxBps = 0;
        let ftxBps = 0;
        if (prev) {
          const dt = (now - prev.at) / 1000;
          if (dt > 0.5) {
            frxBps = Math.max(0, Math.round(((fn.rxBytes - prev.rx) * 8) / dt));
            ftxBps = Math.max(0, Math.round(((fn.txBytes - prev.tx) * 8) / dt));
          }
        }
        this.#lastForeign.set(fn.networkName, {
          rx: fn.rxBytes,
          tx: fn.txBytes,
          at: now,
          rxBps: frxBps,
          txBps: ftxBps,
        });
        return {
          networkName: fn.networkName,
          roomId: null,
          peerCount: fn.peerCount,
          rxBytes: fn.rxBytes,
          txBytes: fn.txBytes,
          rxBps: frxBps,
          txBps: ftxBps,
          lastSeenAt: ts,
        };
      });

      const result: RelaySample = {
        ts,
        foreignNetworks,
        peers,
        totalRxBytes: totalRx,
        totalTxBytes: totalTx,
        rxBps,
        txBps,
        peerCount: peers.length,
      };
      this.#latest = result;
      this.#lastError = null;
      this.emit('sample', result);
      return result;
    } catch (err) {
      this.#lastError = (err as Error).message;
      log.warn('采集主控中继状态失败', { error: (err as Error).message });
      return null;
    }
  }

  latest(): RelaySample | null {
    return this.#latest;
  }

  startPolling(intervalMs = 5000): void {
    this.stopPolling();
    void this.sample();
    this.#pollTimer = setInterval(() => {
      void this.sample();
    }, intervalMs);
    // 轮询不应阻止进程退出
    this.#pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  /** 取主控中继的最近日志 */
  recentLogs(limit = 200): string[] {
    return this.#core?.recentLogs(limit) ?? [];
  }

  /**
   * 探测 easytier-cli 是否支持运行时热替换 ACL（`acl set`）。
   * 该子命令是 EasyTier 较新版本才加入的：v2.6.4 的命令树里只有 `acl stats`，
   * 因此必须做能力探测，而不是假定存在。
   */
  async supportsAclSet(): Promise<boolean> {
    if (this.#aclSetSupport !== null) return this.#aclSetSupport;
    try {
      const res = await runCli({
        cliBin: this.#config.easytier.cliBin,
        rpcPortal: this.rpcPortal,
        args: ['acl', '--help'],
        timeoutMs: 8000,
      });
      const text = `${res.stdout}\n${res.stderr}`;
      this.#aclSetSupport = /\bset\b/.test(text);
    } catch {
      this.#aclSetSupport = false;
    }
    if (!this.#aclSetSupport) {
      log.info('当前 easytier-cli 不支持 acl set，ACL 变更将通过重载配置生效');
    }
    return this.#aclSetSupport;
  }

  /**
   * 应用 ACL 到主控中继。
   * - 支持 `acl set` 时走热替换，不中断任何连接；
   * - 否则把 ACL 记入配置并重启中继（管理操作，低频，可接受）。
   */
  async applyAcl(aclToml: string): Promise<{ mode: 'hot' | 'restart' }> {
    if (!(await this.ensureCli())) throw new Error('easytier-cli 不可用');
    this.#customAclToml = aclToml;
    fs.writeFileSync(this.configFilePath, this.renderConfig(), 'utf8');

    if (await this.supportsAclSet()) {
      const tmp = path.join(this.#config.easytier.configDir, `acl-${Date.now()}.toml`);
      fs.writeFileSync(tmp, aclToml, 'utf8');
      try {
        const res = await runCli({
          cliBin: this.#config.easytier.cliBin,
          rpcPortal: this.rpcPortal,
          args: ['acl', 'set', `@${tmp}`],
          timeoutMs: 15_000,
        });
        if (res.code !== 0) {
          throw new Error(`acl set 失败: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
        }
        log.info('ACL 已热更新（未中断连接）');
        return { mode: 'hot' };
      } finally {
        fs.rm(tmp, { force: true }, () => {});
      }
    }

    await this.restart();
    log.info('ACL 已随中继重启生效');
    return { mode: 'restart' };
  }

  /* ------------------------------------------------------------- 内部实现 */

  async #fetchPeers(): Promise<PeerSnapshot[]> {
    const raw = await cliJson<unknown>({
      cliBin: this.#config.easytier.cliBin,
      rpcPortal: this.rpcPortal,
      // 注意：2.6.4 的命令树是 `peer list`，顶层没有 `peer` 这个叶子命令
      args: ['peer', 'list'],
      timeoutMs: 12_000,
    });

    // JSON 模式下输出的是展示表格：一行一个 peer，字段为 snake_case，
    // 数值被格式化成 "17.33 kB" / "-" 这样的字符串。
    const rows = Array.isArray(raw) ? raw : asArray(pick(raw, 'peerInfos', 'peer_infos'));
    const out: PeerSnapshot[] = [];
    for (const row of rows) {
      const lossRaw = pick(row, 'loss_rate', 'lossRate');
      out.push({
        peerId: num(pick(row, 'id', 'peerId', 'peer_id')),
        hostname: str(pick(row, 'hostname')),
        ipv4: str(pick(row, 'ipv4')),
        cost: str(pick(row, 'cost')),
        latencyMs: parseLatencyMs(pick(row, 'lat_ms', 'latMs', 'latencyMs')),
        lossRate: typeof lossRaw === 'string' && (lossRaw === '-' || lossRaw === '*') ? null : num(lossRaw),
        rxBytes: parseHumanNumber(pick(row, 'rx_bytes', 'rxBytes')),
        txBytes: parseHumanNumber(pick(row, 'tx_bytes', 'txBytes')),
        tunnelProto: str(pick(row, 'tunnel_proto', 'tunnelProto')),
        networkName: str(pick(row, 'network_name', 'networkName')),
      });
    }
    return out;
  }

  /**
   * 全局计数器（`stats show`）。
   * 关注 `traffic_bytes_forwarded`——它正是中继真正转发的字节数，
   * 是「这个中继为我们转了多少数据」最直接的度量。
   */
  async fetchGlobalStats(): Promise<Map<string, number>> {
    const raw = await cliJson<unknown>({
      cliBin: this.#config.easytier.cliBin,
      rpcPortal: this.rpcPortal,
      args: ['stats', 'show'],
      timeoutMs: 12_000,
    });
    const map = new Map<string, number>();
    for (const item of asArray(raw)) {
      const name = str(pick(item, 'name'));
      if (!name) continue;
      map.set(name, (map.get(name) ?? 0) + num(pick(item, 'value')));
    }
    return map;
  }

  async #fetchForeignNetworks(): Promise<ForeignNetworkSnapshot[]> {
    const raw = await cliJson<unknown>({
      cliBin: this.#config.easytier.cliBin,
      rpcPortal: this.rpcPortal,
      args: ['peer', 'list-foreign'],
      timeoutMs: 12_000,
    });

    // 形如 { "<network_name>": { peers: [ { peer_id, conns: [ { stats: { rx_bytes, tx_bytes } } ] } ] } }
    const map = pick(raw, 'foreignNetworks', 'foreign_networks') ?? raw;
    const out: ForeignNetworkSnapshot[] = [];
    if (!map || typeof map !== 'object' || Array.isArray(map)) return out;

    for (const [networkName, entry] of Object.entries(map as Record<string, unknown>)) {
      const peers = asArray(pick(entry, 'peers'));
      let rx = 0;
      let tx = 0;
      const peerBriefs: ForeignNetworkSnapshot['peers'] = [];
      for (const peer of peers) {
        let prx = 0;
        let ptx = 0;
        let latUs: number | null = null;
        for (const conn of asArray(pick(peer, 'conns'))) {
          const stats = pick(conn, 'stats');
          prx += parseHumanNumber(pick(stats, 'rx_bytes', 'rxBytes'));
          ptx += parseHumanNumber(pick(stats, 'tx_bytes', 'txBytes'));
          const v = parseHumanNumber(pick(stats, 'latency_us', 'latencyUs'));
          if (v > 0) latUs = v;
        }
        rx += prx;
        tx += ptx;
        peerBriefs.push({
          peerId: num(pick(peer, 'peer_id', 'peerId')),
          rxBytes: prx,
          txBytes: ptx,
          latencyUs: latUs,
        });
      }
      out.push({ networkName, peerCount: peers.length, rxBytes: rx, txBytes: tx, peers: peerBriefs });
    }
    return out;
  }

  #emitState(): void {
    this.emit('state', this.status());
  }
}

/**
 * 等待 easytier-core 进程进入 running 或 error。
 * EasyTier 没有「就绪」通知，所以 EasytierCore 用一个短延迟把「能起来」和
 * 「起来后立刻崩溃」区分开；这里就是等那个判断结果落地。
 */
function waitForCoreSettled(core: EasytierCore, timeoutMs: number): Promise<void> {
  // 注意：不能用 'stopped' 作为「已落定」——调用方在 start() 之前就开始等待，
  // 此时状态本来就是 stopped，会导致立即返回、误判为启动失败。
  const settled = () => {
    const state = core.status.state;
    return state === 'running' || state === 'error';
  };
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      core.off('state', onState);
      resolve();
    };
    const onState = () => {
      if (settled()) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    core.on('state', onState);
  });
}
