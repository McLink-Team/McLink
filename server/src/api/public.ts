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
import { localDay } from '../db/traffic.ts';
import { logger } from '../logger.ts';
import { handleUnsubscribe } from './unsubscribe.ts';

const log = logger('api:public');

export interface DownloadArtifact {
  id: string;
  /** 平台与架构都是**推断出来的**（见 platformOf / archOf），用于官网按平台分组 */
  platform: 'windows' | 'macos' | 'linux' | 'android';
  /**
   * `universal` = **与 CPU 架构无关**。
   *
   * 只有安卓包会是它：APK 是 Capacitor 壳，包内没有 `lib/<abi>/` 本地库
   * （实测 `mclink-android-0.1.0-debug.apk` 的 lib 条目数为 0，WebView 由系统提供），
   * 所以它对 arm64 / x86_64 手机都一样。以前这里没有这一档，`archOf` 落到
   * `'x64'` 兜底 —— 下载页就会对着安卓用户写"x64"。
   */
  arch: 'x64' | 'arm64' | 'universal';
  label: string;
  /** 文件名里第一段 `x.y.z`（取不到为 null）。官网用它显示"这一份是什么版本" */
  version: string | null;
  filename: string;
  size: number;
  sha256: string | null;
  url: string;
}

export function registerPublicRoutes(router: Router, app: App): void {
  /**
   * 全网外来网络数：所有刚心跳过的子节点上报的房间网络，按网络名去重。
   *
   * 这里以前还要并上主控自带中继的那一份；2026-09-28 起主控不再自带中继，
   * 转发全在子节点上，所以只剩一个来源。
   */
  const foreignNetworkCount = (): number =>
    mergeRelayedNetworks([], app.nodeService.relayingNetworks()).length;

  router.get(Routes.meta, () => {
    const s = app.settings.current;
    const nodeCounts = app.nodes.countByStatus();
    const online = (nodeCounts.online ?? 0) + (nodeCounts.degraded ?? 0);
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
      /** 按平台分好的下载入口：官网 Windows / macOS(×2) / Android 各自的按钮指向哪个文件 */
      clientDownloads: buildClientDownloads(app),
      stats: {
        onlineNodes: online,
        totalNodes: app.nodes.count(),
        openRooms: app.rooms.countOpen(),
        onlinePlayers: app.rooms.onlinePlayers(),
        users: app.users.count(),
        /**
         * 中继收发 = **所有在线子节点的聚合**（全网口径，只报主控那一台时这个数字
         * 长期是 0，线上实测）。转发全部由子节点承担，所以 master* 恒为 0 ——
         * 字段保留是为了老前端不白屏，语义没变。
         */
        relayPeers: nodeBps.peers,
        relayRxBps: nodeBps.rxBps,
        relayTxBps: nodeBps.txBps,
        masterRxBps: 0,
        masterTxBps: 0,
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
          /**
           * 「只协助打洞」：建房页的**手动选择**要用它把话说明白 ——
           * 这种节点不承载房间数据（生成配置写 `disable_relay_data`），
           * 玩家挑它时它会落**打洞槽**，中继由平台另补一台
           * （见 services/rooms.ts 的 `assignRelaySlots`）。
           *
           * ⚠️ 这里是 `app.nodes`（**仓储**，NodeRow 行对象，字段是 snake_case），
           * 不是 `app.nodeService` 的 `RelayNode` —— 所以取 `n.assist_only` 而不是
           * `n.assistOnly`（同一个 map 里 `n.capacity_peers` / `n.disabled` 也是同理）。
           */
          assistOnly: n.assist_only === 1,
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
}

export function buildOverview(app: App): PlatformOverview {
  const s = app.settings.current;
  const nodeCounts = app.nodes.countByStatus();
  const nodeBps = app.nodes.totalBps();
  /**
   * 今日累计：读**账本**而不是采样表。
   * 采样表存的是"某来源自启动以来的累计值"，取 `max()` 只能猜，中继一重启就失真；
   * 账本记的是逐分钟增量之和（见 db/schema.ts 的 V22 与 services/traffic-ledger.ts）。
   */
  const today = app.ledger.sum({ scope: 'platform', scopeId: 'all', sinceDay: localDay() });
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
      /** 全网聚合：转发全在子节点上，所以它就是子节点之和 */
      rxBps: nodeBps.rxBps,
      txBps: nodeBps.txBps,
      rxBytesToday: today.rxBytes,
      txBytesToday: today.txBytes,
      /** 主控不再自带中继，这两项恒为 0（字段保留，老前端不白屏） */
      masterRxBps: 0,
      masterTxBps: 0,
      nodesRxBps: nodeBps.rxBps,
      nodesTxBps: nodeBps.txBps,
      onlineRelayNodes: nodeBps.nodes,
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
  /**
   * 安卓包：**没有任何架构关键字**（`mclink-android-0.1.0-debug.apk`）。
   * 它是一个 Capacitor 壳，包内没有本地库，跟手机的 CPU 架构无关，
   * 所以不能像其它产物那样落到 `'x64'` 兜底 —— 那是把一个推断不出来的东西写成了具体值。
   * 显式写了架构的包（比如以后拆 `-arm64.apk`）会被上面两条先接住。
   */
  if (n.endsWith('.apk') || n.includes('android')) return 'universal';
  return 'x64';
}

/**
 * 文件名里第一段 `x.y.z`：`mclink-android-0.1.0-debug.apk` → `0.1.0`。
 * 取不到就返回 null —— 宁可官网不显示版本，也不要凭空造一个。
 */
function versionOf(name: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * 从一组产物里挑**版本最高的那一个**。
 *
 * 下载目录里会同时留着历史版本（没人删），所以不能按字典序取第一个：
 * 字典序会把 `0.10.0` 排在 `0.9.0` 前面、把 `0.1.0` 排在 `1.0.0` 前面 ——
 * 官网就会把过期包挂给玩家（macOS 那边踩过同一个坑，见 preferDmg 的注释）。
 * 同一个版本号同时有正式包与内测包时，正式包优先（内测包不该盖过正式包）。
 */
function latestOf(list: DownloadArtifact[]): DownloadArtifact | null {
  const parts = (v: string | null): number[] => (v ? v.split('.').map(Number) : []);
  return (
    [...list].sort((a, b) => {
      const [pa, pb] = [parts(a.version), parts(b.version)];
      for (let i = 0; i < 3; i += 1) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (diff !== 0) return diff;
      }
      const debug = Number(/debug/i.test(a.filename)) - Number(/debug/i.test(b.filename));
      if (debug !== 0) return debug;
      // 兜底：文件名倒序，让 `-2` 排在 `-1` 前面（localeCompare 保证跨平台稳定）
      return b.filename.localeCompare(a.filename);
    })[0] ?? null
  );
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
      version: versionOf(entry.name),
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
 * 按平台分好的下载入口：官网每个平台按钮该指向哪个文件。
 *
 * Windows 走设置里的主产物（管理员可覆盖）；macOS 直接在下载目录里找
 * —— EasyTier 的核心与 electron-builder 的产物名都带 macos/arm64/x64，能认出来。
 * `macos` 优先 Apple 芯片（现在绝大多数 Mac），`macosIntel` 单独给，
 * 两者都存在时前端会让玩家二选一。
 *
 * `android` 与它们同构，但多一条约束：安卓包**按版本挑最新**（见 latestOf）。
 * 让主控来挑、而不是让官网自己在一堆产物里翻，是因为"哪个文件是最新的"
 * 属于产物语义，只有扫描目录的这一侧说得清。没有 apk 时它是 null ——
 * 官网据此显示占位态，而不是留一个点了 404 的按钮。
 */
export function buildClientDownloads(app: App): {
  version: string;
  windows: DownloadArtifact | null;
  macos: DownloadArtifact | null;
  macosIntel: DownloadArtifact | null;
  android: DownloadArtifact | null;
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
    android: latestOf(artifacts.filter((a) => a.platform === 'android')),
    all: artifacts,
  };
}

function labelFor(name: string): string {
  if (name.includes('setup') || name.endsWith('.exe')) return 'Windows 客户端安装包';
  if (name.includes('easytier-core')) return 'EasyTier 核心（可选，用于自带核心）';
  /**
   * 安卓包以前落到最后一行的"原样返回文件名"：下载页表格里文件名会出现两次，
   * 而且看不出这是个什么包。`debug` 产物单独标出来 —— 它是内测签名，
   * 与下载页那张"测试版"卡片说的是同一件事。
   */
  const n = name.toLowerCase();
  if (n.endsWith('.apk') || n.includes('android')) {
    return /debug/i.test(name) ? 'Android 客户端安装包（测试版）' : 'Android 客户端安装包';
  }
  return name;
}
