/**
 * 公开接口：落地页所需的元信息、区域列表、公共统计、客户端下载信息。
 * 这些接口不需要登录，落地页首屏直接调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REGIONS, Routes, type PlatformOverview } from '@mclink/shared';
import type { App } from '../app.ts';
import { APP_VERSION } from '../app.ts';
import type { Router } from '../http/kit.ts';

export interface DownloadArtifact {
  id: string;
  platform: string;
  arch: string;
  label: string;
  filename: string;
  size: number;
  sha256: string | null;
  url: string;
}

export function registerPublicRoutes(router: Router, app: App): void {
  router.get(Routes.meta, () => {
    const s = app.settings.current;
    const nodeCounts = app.nodes.countByStatus();
    const online = (nodeCounts.online ?? 0) + (nodeCounts.degraded ?? 0);
    const relaySample = app.relay.latest();
    const nodeBps = app.nodes.totalBps();
    return {
      siteName: s.siteName,
      siteTagline: s.siteTagline,
      version: APP_VERSION,
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - app.startedAt) / 1000),
      registrationOpen: s.registrationOpen,
      /**
       * 是否要求验证邮箱才能建房/进房。
       * 客户端/网页靠它决定"注册后要不要显示验证码界面"——所以必须是公开信息，
       * 但**不能**顺带泄露 SMTP 配置。
       */
      requireEmailVerification: s.requireEmailVerification,
      emailServiceAvailable: app.mailer.configured,
      announcement: s.announcement,
      relayPort: s.relayPort,
      easytierVersion: app.relay.cliVersion,
      clientVersion: s.clientVersion,
      clientDownloadUrl: resolveClientDownloadUrl(app),
      stats: {
        onlineNodes: online,
        totalNodes: app.nodes.count(),
        openRooms: app.rooms.countOpen(),
        onlinePlayers: app.rooms.onlinePlayers(),
        users: app.users.count(),
        /**
         * 中继收发 = **主控中继 + 所有在线子节点**（全网聚合）。
         * 只报主控那一台的话，玩家按区域接入时这个数字会长期是 0（线上实测）。
         * master* 单独留着，方便前端在悬浮说明里拆开讲。
         */
        relayPeers: (relaySample?.peerCount ?? 0) + nodeBps.peers,
        relayRxBps: (relaySample?.rxBps ?? 0) + nodeBps.rxBps,
        relayTxBps: (relaySample?.txBps ?? 0) + nodeBps.txBps,
        masterRxBps: relaySample?.rxBps ?? 0,
        masterTxBps: relaySample?.txBps ?? 0,
        nodesRxBps: nodeBps.rxBps,
        nodesTxBps: nodeBps.txBps,
        onlineRelayNodes: nodeBps.nodes,
        foreignNetworks: relaySample?.foreignNetworks.length ?? 0,
      },
    };
  });

  /**
   * 区域可用性（公开）。
   *
   * 除了按区域汇总的数量，还给出**在线节点的名字**：落地页要能直接告诉玩家
   * 「华东 · 上海一号」这级信息，而不是只给一个数字。这里只暴露名字、区域、
   * 承载人数与容量 —— 端点、令牌、公网 IP 这些一律不出现在公开接口里。
   */
  router.get(Routes.regions, () => {
    const availability = app.nodeService.availableByRegion();
    const byRegion = new Map(availability.map((a) => [a.region, a]));
    const nodes = app.nodes
      .list()
      .filter((n) => n.disabled !== 1 && (n.status === 'online' || n.status === 'degraded'))
      .map((n) => ({ name: n.name, region: n.region, peers: n.peers, capacity: n.capacity_peers }))
      .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
    return REGIONS.map((r) => {
      if (r.id === 'auto') {
        const online = availability.reduce((acc, a) => acc + a.online, 0);
        const peers = availability.reduce((acc, a) => acc + a.peers, 0);
        const capacity = availability.reduce((acc, a) => acc + a.capacity, 0);
        return { id: r.id, label: r.label, hint: r.hint, onlineNodes: online, peers, capacity, nodes };
      }
      const a = byRegion.get(r.id);
      return {
        id: r.id,
        label: r.label,
        hint: r.hint,
        onlineNodes: a?.online ?? 0,
        peers: a?.peers ?? 0,
        capacity: a?.capacity ?? 0,
        nodes: nodes.filter((n) => n.region === r.id),
      };
    });
  });

  router.get(Routes.stats, () => {
    const overview = buildOverview(app);
    return {
      serverTime: overview.serverTime,
      nodes: overview.nodes,
      rooms: overview.rooms,
      users: overview.users,
      traffic: overview.traffic,
    };
  });

  router.get(Routes.downloads, () => {
    const artifacts = listDownloads(app);
    return {
      clientVersion: app.settings.current.clientVersion,
      primary: resolveClientDownloadUrl(app),
      artifacts,
    };
  });

  /** 手动触发一次中继状态采样 */
  router.post('/relay/refresh', async () => {
    const sample = await app.relay.sample();
    return { ok: Boolean(sample), peers: sample?.peerCount ?? 0 };
  }, { auth: true });
}

export function buildOverview(app: App): PlatformOverview {
  const s = app.settings.current;
  const nodeCounts = app.nodes.countByStatus();
  const sample = app.relay.latest();
  const nodeBps = app.nodes.totalBps();
  const today = app.traffic.todayTotals();
  const relay = app.relay.status();
  return {
    serverTime: new Date().toISOString(),
    version: APP_VERSION,
    easytierVersion: app.relay.cliVersion,
    uptimeSeconds: Math.floor((Date.now() - app.startedAt) / 1000),
    nodes: {
      total: app.nodes.count(),
      online: nodeCounts.online ?? 0,
      degraded: nodeCounts.degraded ?? 0,
      offline: nodeCounts.offline ?? 0,
      pending: nodeCounts.pending ?? 0,
    },
    rooms: {
      open: app.rooms.countOpen(),
      total: app.rooms.listAll({ limit: 1 }).total,
      onlinePlayers: app.rooms.onlinePlayers(),
    },
    users: {
      total: app.users.count(),
      online: 0,
    },
    traffic: {
      /** 全网聚合：主控中继 + 所有在线子节点 */
      rxBps: (sample?.rxBps ?? 0) + nodeBps.rxBps,
      txBps: (sample?.txBps ?? 0) + nodeBps.txBps,
      rxBytesToday: today.rxBytes,
      txBytesToday: today.txBytes,
      /** 拆开，界面上要能说清"这些量里主控多少、子节点多少" */
      masterRxBps: sample?.rxBps ?? 0,
      masterTxBps: sample?.txBps ?? 0,
      nodesRxBps: nodeBps.rxBps,
      nodesTxBps: nodeBps.txBps,
      onlineRelayNodes: nodeBps.nodes,
    },
    relay: {
      ...relay,
      // 把平台级限速也暴露出来，管理台要显示
      listen: `${relay.listen}`,
    },
  };
}

/**
 * 「下载客户端」按钮真正应该指向哪个文件。
 *
 * 设置里的 `clientDownloadUrl` 由管理员维护，但有两类情况会让它指向不存在的文件：
 *   1. 客户端换了版本号（产物名里带版本），设置没跟着改；
 *   2. 老部署的库里存着历史默认值（曾经是 `mclink-client-setup.exe`，从来不存在）。
 * 于是：设置里指定的文件**确实在下载目录里**时以它为准；否则退回下载目录里实际
 * 存在的 Windows 产物。这样即使管理员没配，玩家点下载也不会拿到 404。
 */
export function resolveClientDownloadUrl(app: App): string {
  const s = app.settings.current;
  const artifacts = listDownloads(app);
  const wanted = s.clientDownloadUrl ? path.basename(s.clientDownloadUrl) : '';
  if (wanted && artifacts.some((a) => a.filename === wanted)) return s.clientDownloadUrl;
  const windows = artifacts.filter((a) => a.platform === 'windows');
  return windows[0]?.url ?? artifacts[0]?.url ?? s.clientDownloadUrl;
}

/** 扫描下载目录，列出可下载的客户端产物 */
export function listDownloads(app: App): DownloadArtifact[] {
  const root = app.downloads.root;
  if (!fs.existsSync(root)) return [];
  const s = app.settings.current;
  // 已登记 sha256 的主产物：用设置里的值，避免每次请求都对 ~87MB 的文件重新做哈希
  const primaryFile = s.clientDownloadUrl ? path.basename(s.clientDownloadUrl) : '';
  const out: DownloadArtifact[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!['.exe', '.zip', '.msi', '.apk', '.dmg', '.deb', '.appimage'].includes(ext)) continue;
    const full = path.join(root, entry.name);
    const stat = fs.statSync(full);
    out.push({
      id: entry.name,
      platform: entry.name.includes('linux') ? 'linux' : entry.name.includes('android') ? 'android' : 'windows',
      arch: entry.name.includes('arm64') ? 'arm64' : entry.name.includes('x86_64') ? 'x86_64' : 'x64',
      label: labelFor(entry.name),
      filename: entry.name,
      size: stat.size,
      sha256: entry.name === primaryFile ? (s.clientSha256 ?? null) : null,
      url: `/downloads/${encodeURIComponent(entry.name)}`,
    });
  }
  return out.sort((a, b) => {
    // 主产物排在最前，便于前端把主下载按钮指向它
    if (a.filename === primaryFile) return -1;
    if (b.filename === primaryFile) return 1;
    return a.filename.localeCompare(b.filename);
  });
}

function labelFor(name: string): string {
  if (name.includes('setup') || name.endsWith('.exe')) return 'Windows 客户端安装包';
  if (name.includes('easytier-core')) return 'EasyTier 核心（可选，用于自带核心）';
  return name;
}
