/**
 * 公开接口：落地页所需的元信息、区域列表、公共统计、客户端下载信息。
 * 这些接口不需要登录，落地页首屏直接调用。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REGIONS, Routes, type PlatformOverview } from '@mclink/shared';
import type { App } from '../app.ts';
import { APP_VERSION } from '../app.ts';
import { mergeRelayedNetworks } from '../services/nodes.ts';
import type { Router } from '../http/kit.ts';
import { endpointHost, nodeConnectPort } from '../db/nodes.ts';
import { logger } from '../logger.ts';
import { handleUnsubscribe } from './unsubscribe.ts';

const log = logger('api:public');

export interface DownloadArtifact {
  id: string;
  /** 平台与架构都是**推断出来的**（见 platformOf / archOf），用于官网按平台分组 */
  platform: 'windows' | 'macos' | 'linux' | 'android';
  arch: 'x64' | 'arm64';
  label: string;
  filename: string;
  size: number;
  sha256: string | null;
  url: string;
}

export function registerPublicRoutes(router: Router, app: App): void {
  /**
   * 全网外来网络数：主控自己 + 所有刚心跳过的子节点，按网络名去重。
   *
   * 只算主控那一台是错的：玩家按区域就近接入，绝大多数房间走在子节点上，
   * 落地页那格读数会长期是 0（用户实测反馈）。
   */
  const foreignNetworkCount = (): number =>
    mergeRelayedNetworks(
      (app.relay.latest()?.foreignNetworks ?? []).map((fn) => ({
        networkName: fn.networkName,
        peers: fn.peerCount,
        rxBps: fn.rxBps,
        txBps: fn.txBps,
        rxBytes: fn.rxBytes,
        txBytes: fn.txBytes,
      })),
      app.nodeService.relayingNetworks(),
    ).length;

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
      /** 双端下载：官网的 Windows / macOS 两个按钮各自该指向哪个文件 */
      clientDownloads: buildClientDownloads(app),
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
        foreignNetworks: foreignNetworkCount(),
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

  /**
   * 客户端可见的中继节点列表（**需登录**）。
   *
   * 和公开的 `/regions` 的区别只有一点：多了探测目标 `host` + `port`。
   * 建房页要自己测延迟，就必须知道往哪儿连；但公开接口里绝不能出现端点，
   * 所以这条单独做成鉴权路由。
   *
   * 端口给的是**链接端口**（`nodeConnectPort`，规则与票据下发的那个端口同一份，
   * 见 db/nodes.ts）：客户端就是用这个端口做 TCP 握手测延迟的，两边必须是同一个端口 ——
   * 给运行端口的话，在 NAT/端口映射后面会测出一个根本连不上的数字。
   * 这不是新增泄露：登录用户拿到的房间票据里本来就有 `host:connectPort`。
   */
  router.get(Routes.clientNodes, () => {
    const relayPort = app.settings.current.relayPort;
    return {
      nodes: app.nodes
        .list()
        .filter((n) => n.disabled !== 1 && (n.status === 'online' || n.status === 'degraded'))
        .map((n) => ({
          id: n.id,
          name: n.name,
          region: n.region,
          /** 只给主机部分：`relay-sh.example.com:21010` → `relay-sh.example.com` */
          host: endpointHost(n.endpoint),
          /** 链接端口：客户端做 TCP 延迟探测、以及真正加入房间时连的都是它 */
          port: nodeConnectPort(n, relayPort),
          peers: n.peers,
          capacity: n.capacity_peers,
          status: n.status,
        })),
    };
  }, { auth: true });
  /**
   * 邮件退订（**免登录**）。
   *
   * 邮件里的链接必须在没登录、没客户端的情况下直接可用 —— 否则退订等于不存在
   * （合规要求，也直接影响域名的送达率）。签名与校验在 api/unsubscribe.ts 里。
   */
  router.get(Routes.unsubscribe, (ctx) => {
    const result = handleUnsubscribe(
      {
        secret: app.config.jwtSecret,
        origin: app.config.publicBaseUrl,
        setOptOut: (userId, value) => {
          const changed = app.users.setEmailOptOut(userId, value);
          if (changed) {
            app.audit.write({
              actorType: 'user',
              actorId: userId,
              action: value ? 'mail.unsubscribe' : 'mail.resubscribe',
              targetType: 'user',
              targetId: userId,
              detail: { via: 'email-link' },
            });
          }
          return changed;
        },
        userExists: (userId) => Boolean(app.users.findById(userId)),
      },
      ctx.url.searchParams,
    );
    ctx.send(result.status, result.html, 'text/html; charset=utf-8');
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

/**
 * 从文件名判断产物属于哪个平台与架构。
 *
 * 之前这里只认 linux/android 两个关键字，其余一律算 windows —— 于是 `.dmg`
 * 会被标成 Windows 产物，官网的"按平台下载"就会把 mac 包挂在 Windows 按钮上。
 */
function platformOf(name: string): DownloadArtifact['platform'] {
  const n = name.toLowerCase();
  if (n.includes('macos') || n.includes('darwin') || n.endsWith('.dmg') || n.includes('mac-')) return 'macos';
  if (n.includes('linux') || n.endsWith('.deb') || n.endsWith('.appimage')) return 'linux';
  if (n.includes('android') || n.endsWith('.apk')) return 'android';
  return 'windows';
}

function archOf(name: string): DownloadArtifact['arch'] {
  const n = name.toLowerCase();
  if (n.includes('arm64') || n.includes('aarch64') || n.includes('apple')) return 'arm64';
  if (n.includes('x86_64') || n.includes('amd64') || n.includes('x64') || n.includes('intel')) return 'x64';
  return 'x64';
}

/**
 * 安装包 sha256 的**懒计算缓存**。
 *
 * 为什么需要：控制台的「安装包 SHA-256」只有一个字段，只对应 Windows 主产物；
 * 下载目录里其它产物（macOS 的 dmg/zip）永远是「未登记」，玩家想校验也没有值。
 * 与其让管理员手贴 4 个哈希（贴错了更糟），不如主控自己算。
 *
 * 为什么不在请求里同步算：单个包 120–145MB，同步哈希会把请求拖住一两秒，
 * 而 /downloads 是下载页每次打开都会调的。所以第一次请求只**登记任务**并返回 null
 * （界面显示「未登记」），算完后缓存，页面刷新一次就有值。
 * 缓存键包含 size + mtime：产物被替换（同名不同内容）时会自动重算。
 */
const shaCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
const shaPending = new Set<string>();

/**
 * 已经报过的"登记值与实际不一致"。
 *
 * 这个 warn 不能每次请求都打：`/meta` 与 `/downloads` 都是打开页面就调的，
 * 每次都写等于用一条已知问题刷满日志。同一种不一致只报一次；
 * 换了包（算出新的摘要）会重新报一条，正好是运维需要知道的那一次。
 */
const shaMismatchWarned = new Set<string>();

export function artifactSha256(app: App, filename: string, size: number, mtimeMs: number): string | null {
  const cached = shaCache.get(filename);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.sha256;
  if (shaPending.has(filename)) return null;
  const abs = path.join(app.downloads.root, filename);
  shaPending.add(filename);
  try {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => shaPending.delete(filename));
    stream.on('end', () => {
      shaCache.set(filename, { size, mtimeMs, sha256: hash.digest('hex') });
      shaPending.delete(filename);
    });
  } catch {
    shaPending.delete(filename);
  }
  return null;
}
/**
 * 主产物的校验值：登记值与实际文件摘要取"实际文件"为准。
 *
 * 三种情形：
 *   · 没登记 → 用算出来的（没算完就是 null，界面显示「未登记」）；
 *   · 登记了、还没算出来 → 先显示登记值（别让页面空着），算完再纠正；
 *   · 登记了、算出来了、两者不同 → 用实际值 + 记一条 warn（换包忘了改登记值时唯一的线索）。
 */
function resolveSha256(
  app: App,
  filename: string,
  primaryFile: string,
  registered: string | null,
  stat: { size: number; mtimeMs: number },
): string | null {
  const computed = artifactSha256(app, filename, stat.size, stat.mtimeMs);
  if (filename !== primaryFile || !registered) return computed;
  if (!computed) return registered;
  if (computed !== registered) {
    const key = `${filename}:${registered}:${computed}`;
    if (!shaMismatchWarned.has(key)) {
      shaMismatchWarned.add(key);
      log.warn('登记的 clientSha256 与实际安装包不一致，已改用实际摘要（换包后忘了更新登记值？）', {
        file: filename,
        registered,
        actual: computed,
      });
    }
    return computed;
  }
  return registered;
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
      platform: platformOf(entry.name),
      arch: archOf(entry.name),
      label: labelFor(entry.name),
      filename: entry.name,
      size: stat.size,
      /**
       * 主产物优先用管理员登记的 clientSha256（自建下载源时可能是站外人工核对过的值）。
       *
       * 但**登记值会比文件旧**：换了新的安装包却忘了改这一项，下载页就会拿着一个
       * 对不上的校验值让玩家核对 —— 比"未登记"更糟（玩家会以为文件被篡改）。
       * 所以一旦算出真实摘要且两者不一致，就以**实际文件**为准，并留一条 warn：
       * 页面上给出的校验值永远等于真正下载到的那个文件。
       */
      sha256: resolveSha256(app, entry.name, primaryFile, s.clientSha256, stat),
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

/**
 * 双端下载入口：官网按平台给按钮用。
 *
 * Windows 走设置里的主产物（管理员可覆盖）；macOS 直接在下载目录里找
 * —— EasyTier 的核心与 electron-builder 的产物名都带 macos/arm64/x64，能认出来。
 * `macos` 优先 Apple 芯片（现在绝大多数 Mac），`macosIntel` 单独给，
 * 两者都存在时前端会让玩家二选一。
 */
export function buildClientDownloads(app: App): {
  version: string;
  windows: DownloadArtifact | null;
  macos: DownloadArtifact | null;
  macosIntel: DownloadArtifact | null;
  all: DownloadArtifact[];
} {
  const artifacts = listDownloads(app);
  const macs = artifacts.filter((a) => a.platform === 'macos');
  /**
   * 同一架构可能同时存在 .dmg 与 .zip（构建会出两份）。**显式优先 dmg**：
   * Mac 玩家的习惯是拖进「应用程序」，而 zip 只是备选。
   * 之前靠 `find` 拿排序里的第一个 —— 而排序是按文件名，`.dmg` 恰好排在 `.zip` 前，
   * 属于运气；文件名一改（比如以后加上 `-app.zip`）就会挑错，所以这里写死优先级。
   */
  const preferDmg = (arch: 'arm64' | 'x64'): DownloadArtifact | null => {
    const same = macs.filter((a) => a.arch === arch);
    /**
     * **先按当前版本筛，再优先 dmg。**
     *
     * 下载目录里通常同时留着旧版本（历史产物没人删）。只按文件名排序的话
     * `McLink-0.1.0-macos-arm64.dmg` 会排在 `McLink-1.0.0-…` 前面，
     * 官网的 macOS 按钮就会把玩家指向**过期包** —— 线上实测踩到
     * （目录里同时有 0.1.0 与 1.0.0 的产物时，卡片会选中 0.1.0）。
     * 版本号取平台设置里的 clientVersion，与客户端「有新版本」提示用的是同一个值。
     */
    const wanted = app.settings.current.clientVersion;
    const sameVersion = wanted ? same.filter((a) => a.filename.includes(wanted)) : [];
    const pool = sameVersion.length > 0 ? sameVersion : same;
    return pool.find((a) => a.filename.toLowerCase().endsWith('.dmg')) ?? pool[0] ?? null;
  };
  const macArm = preferDmg('arm64');
  const macIntel = preferDmg('x64');
  // 只有 Intel 包时也让它出现在主按钮上，别让 Intel Mac 用户找不到入口
  const macPrimary = macArm ?? macIntel;
  return {
    version: app.settings.current.clientVersion,
    windows: artifacts.find((a) => a.platform === 'windows') ?? null,
    macos: macPrimary,
    macosIntel: macArm ? macIntel : null,
    all: artifacts,
  };
}

function labelFor(name: string): string {
  if (name.includes('setup') || name.endsWith('.exe')) return 'Windows 客户端安装包';
  if (name.includes('easytier-core')) return 'EasyTier 核心（可选，用于自带核心）';
  return name;
}
