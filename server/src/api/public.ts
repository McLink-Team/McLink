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
    return {
      siteName: s.siteName,
      siteTagline: s.siteTagline,
      version: APP_VERSION,
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - app.startedAt) / 1000),
      registrationOpen: s.registrationOpen,
      announcement: s.announcement,
      relayPort: s.relayPort,
      easytierVersion: app.relay.cliVersion,
      clientVersion: s.clientVersion,
      clientDownloadUrl: s.clientDownloadUrl,
      stats: {
        onlineNodes: online,
        totalNodes: app.nodes.count(),
        openRooms: app.rooms.countOpen(),
        onlinePlayers: app.rooms.onlinePlayers(),
        users: app.users.count(),
        relayPeers: relaySample?.peerCount ?? 0,
        relayRxBps: relaySample?.rxBps ?? 0,
        relayTxBps: relaySample?.txBps ?? 0,
        foreignNetworks: relaySample?.foreignNetworks.length ?? 0,
      },
    };
  });

  router.get(Routes.regions, () => {
    const availability = app.nodeService.availableByRegion();
    const byRegion = new Map(availability.map((a) => [a.region, a]));
    return REGIONS.map((r) => {
      if (r.id === 'auto') {
        const online = availability.reduce((acc, a) => acc + a.online, 0);
        const peers = availability.reduce((acc, a) => acc + a.peers, 0);
        const capacity = availability.reduce((acc, a) => acc + a.capacity, 0);
        return { id: r.id, label: r.label, hint: r.hint, onlineNodes: online, peers, capacity };
      }
      const a = byRegion.get(r.id);
      return {
        id: r.id,
        label: r.label,
        hint: r.hint,
        onlineNodes: a?.online ?? 0,
        peers: a?.peers ?? 0,
        capacity: a?.capacity ?? 0,
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
      primary: app.settings.current.clientDownloadUrl,
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
      rxBps: sample?.rxBps ?? 0,
      txBps: sample?.txBps ?? 0,
      rxBytesToday: today.rxBytes,
      txBytesToday: today.txBytes,
    },
    relay: {
      ...relay,
      // 把平台级限速也暴露出来，管理台要显示
      listen: `${relay.listen}`,
    },
  };
}

/** 扫描下载目录，列出可下载的客户端产物 */
export function listDownloads(app: App): DownloadArtifact[] {
  const root = app.downloads.root;
  if (!fs.existsSync(root)) return [];
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
      sha256: null,
      url: `/downloads/${encodeURIComponent(entry.name)}`,
    });
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename));
}

function labelFor(name: string): string {
  if (name.includes('setup') || name.endsWith('.exe')) return 'Windows 客户端安装包';
  if (name.includes('easytier-core')) return 'EasyTier 核心（可选，用于自带核心）';
  return name;
}
