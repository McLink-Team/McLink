/**
 * 应用容器：把所有服务装配成一个对象，路由层只依赖它。
 * 这样测试可以构造一个使用临时数据库的 App，而不用起真实 HTTP 服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChatMessage } from '@mclink/shared';
import type { ServerConfig } from './config.ts';
import { finalizeConfig, loadConfig, REPO_ROOT, SERVER_ROOT } from './config.ts';
import { initLogger, logger } from './logger.ts';
import { Db } from './db/index.ts';
import { EnrollKeyRepo, EmailCodeRepo, MetaStore, SettingsRepo, UserRepo } from './db/users.ts';
import { RoomRepo } from './db/rooms.ts';
import { NodeRepo } from './db/nodes.ts';
import { AuditRepo, TrafficRepo } from './db/traffic.ts';
import { MessageRepo } from './db/chat.ts';
import { AuthService } from './services/auth.ts';
import { NodeService } from './services/nodes.ts';
import { NodeUtilization } from './services/node-utilization.ts';
import { RoomService } from './services/rooms.ts';
import { SettingsService } from './services/settings.ts';
import { MailerService } from './services/mailer.ts';
import { BroadcastService } from './services/broadcast.ts';
import { unsubscribeUrl } from './api/unsubscribe.ts';
import { RelayManager } from './easytier/manager.ts';
import { hashPassword } from './util/id.ts';

/**
 * 主控自身的版本。
 *
 * 这是**主控的版本线**，和客户端版本线相互独立（客户端当前 1.0.1，主控本轮发 1.0.0）。
 * 对外出现在 `/meta.version`、控制台「平台版本」，以及 WS `hello.version`。
 * 全仓库只有这一处定义：`ws/hub.ts` 以前自己硬编码了 '0.1.0'，结果握手时宣称的版本
 * 和 `/meta` 长期不一致（docs/api.md 里还写着"与 APP_VERSION 一致"）。
 */
export const APP_VERSION = '1.0.0';

/**
 * 服务内部事件总线。
 *
 * 存在的意义是解耦：房间服务只知道「房间变了」，不依赖 WebSocket 实现；
 * index.ts 订阅这些事件后再决定推给哪些话题。否则服务层就得直接持有 hub，
 * 单测也就必须起一个 WebSocket 服务。
 */
export interface AppEvents {
  /** 房间的成员/状态发生变化，订阅了 room:<id> 的连接应刷新 */
  'room.changed': [roomId: string];
  /** 房间 ACL 已更新，房主客户端需要重新应用 */
  'room.acl': [payload: { roomId: string; revision: number }];
  /** 某成员被移出房间，需要立刻踢掉它的连接 */
  'room.kicked': [payload: { roomId: string; userId: string; reason: string }];
  /** 房间已关闭 */
  'room.closed': [roomId: string];
  /** 房间聊天：有新消息 */
  'room.message': [payload: { roomId: string; message: ChatMessage }];
  /** 房间聊天：某条消息被删除 */
  'room.messageDeleted': [payload: { roomId: string; messageId: number }];
  /** 节点状态变化 */
  'node.changed': [nodeId: string];
}

export type AppEventBus = EventEmitter<AppEvents>;

/** 运行期由 index.ts 注入的访问器 */
export interface AppRuntime {
  /** 当前通过 WebSocket 在线的用户数 */
  onlineUserCount?: () => number;
  /** 当前 WebSocket 连接数 */
  wsClientCount?: () => number;
}

export interface WebAssets {
  root: string;
  available: boolean;
}

export interface DownloadsDir {
  root: string;
  available: boolean;
}

export interface App {
  config: ServerConfig;
  warnings: string[];
  /** 内部事件总线，见 AppEvents 的说明 */
  events: AppEventBus;
  /**
   * 由 index.ts 在 HTTP/WS 起来之后回填的运行时访问器。
   * 这样路由层就能拿到「当前在线用户数」这类信息，而不必反向依赖 hub（会形成循环依赖）。
   */
  runtime: AppRuntime;
  db: Db;
  users: UserRepo;
  rooms: RoomRepo;
  nodes: NodeRepo;
  traffic: TrafficRepo;
  audit: AuditRepo;
  messages: MessageRepo;
  enrollKeys: EnrollKeyRepo;
  settings: SettingsService;
  mailer: MailerService;
  /** 群发邮件公告（后台分批发送 + 进度查询） */
  broadcast: BroadcastService;
  emailCodes: EmailCodeRepo;
  meta: MetaStore;
  auth: AuthService;
  roomService: RoomService;
  nodeService: NodeService;
  relay: RelayManager;
  /** 前端构建产物目录（web 的 dist 会被拷到这里） */
  web: WebAssets;
  /** 客户端安装包目录 */
  downloads: DownloadsDir;
  startedAt: number;
}

export interface CreateAppOptions {
  config?: ServerConfig;
  /** 是否创建中继管理器（单测里可以关掉） */
  withRelay?: boolean;
}

export function createApp(options: CreateAppOptions = {}): App {
  const base = options.config ?? loadConfig();
  const finalized = finalizeConfig(base);
  const config = finalized.config;

  initLogger(config.logLevel, process.env.NODE_ENV === 'production');

  const db = new Db(config.dbFile);
  const events: AppEventBus = new EventEmitter<AppEvents>();
  // 房间/节点事件的监听者在 index.ts 里挂载，数量少但可能多；放开上限避免无用告警
  events.setMaxListeners(50);

  const users = new UserRepo(db);
  const rooms = new RoomRepo(db);
  const nodes = new NodeRepo(db);
  const traffic = new TrafficRepo(db);
  const audit = new AuditRepo(db);
  const messages = new MessageRepo(db);
  const enrollKeys = new EnrollKeyRepo(db);
  const emailCodes = new EmailCodeRepo(db);
  const settingsRepo = new SettingsRepo(db);
  const meta = new MetaStore(db);
  const settings = new SettingsService(settingsRepo, config);
  const mailer = new MailerService(settings);
  /**
   * 群发公告：依赖显式传入（mailer / users / audit / settings / 公开地址）。
   * 不传整个 App —— 它此刻还在组装中，会形成循环。
   */
  const broadcast = new BroadcastService({
    mailer,
    users,
    audit,
    settings,
    publicBaseUrl: config.publicBaseUrl,
    // 签名密钥用 jwtSecret：显式配置或由服务端生成并持久化在 data/secrets.json，
    // 所以邮件里的退订链接重启后依然有效
    unsubscribeUrl: (userId) => unsubscribeUrl({ secret: config.jwtSecret, origin: config.publicBaseUrl }, userId),
  });

  const auth = new AuthService(config, users, audit, settings, emailCodes, mailer);
  /**
   * 带宽利用率：**两个服务共用同一个实例**（写出采样的是 NodeService，
   * 读它做调度的是 RoomService）。让 RoomService 直接依赖 NodeService 会成环，
   * 所以按项目一贯做法，由这里构造并注入。
   */
  const nodeUtil = new NodeUtilization();
  const roomService = new RoomService(config, rooms, nodes, users, audit, settings, events, messages, nodeUtil);
  const nodeService = new NodeService(config, nodes, enrollKeys, audit, settings, nodeUtil);
  const relay = new RelayManager(config);

  const webRoot = resolveWebRoot();
  const downloadsRoot = resolveDownloadsRoot(config);

  return {
    config,
    warnings: finalized.warnings,
    events,
    runtime: {},
    db,
    users,
    rooms,
    nodes,
    traffic,
    audit,
    messages,
    enrollKeys,
    settings,
    mailer,
    broadcast,
    emailCodes,
    meta,
    auth,
    roomService,
    nodeService,
    relay,
    web: { root: webRoot, available: fs.existsSync(path.join(webRoot, 'index.html')) },
    downloads: { root: downloadsRoot, available: fs.existsSync(downloadsRoot) },
    startedAt: Date.now(),
  };
}

function resolveWebRoot(): string {
  const candidates = [
    process.env.MCLINK_WEB_ROOT,
    path.join(SERVER_ROOT, 'public'),
    path.join(REPO_ROOT, 'web', 'dist'),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return candidates[0] ?? path.join(SERVER_ROOT, 'public');
}

function resolveDownloadsRoot(config: ServerConfig): string {
  const candidates = [
    process.env.MCLINK_DOWNLOADS_DIR,
    path.join(config.dataDir, 'downloads'),
    path.join(REPO_ROOT, 'deploy', 'downloads'),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0] ?? path.join(config.dataDir, 'downloads');
}

/**
 * 首次启动时创建管理员账号。
 * 密码优先取环境变量，其次取自动生成并落盘的密钥（finalizeConfig 已保证非空）。
 */
export async function ensureBootstrapAdmin(app: App): Promise<void> {
  const log = logger('bootstrap');
  const existing = app.users.findByUsername(app.config.bootstrapAdminUsername);
  if (existing) {
    if (existing.role !== 'admin') {
      app.users.setRole(existing.id, 'admin');
      log.warn('已存在的同名账号被提升为管理员', { username: existing.username });
    }
    return;
  }
  // 已经有人注册过就不再自动建号，避免在多管理员场景下凭空多出一个账号
  if (app.users.count() > 0) return;

  const passwordHash = await hashPassword(app.config.bootstrapAdminPassword);
  const row = app.users.create({
    username: app.config.bootstrapAdminUsername,
    displayName: '平台管理员',
    passwordHash,
    role: 'admin',
    quotaBytes: null,
    maxRooms: null,
  });
  app.meta.set('bootstrap_admin_created_at', new Date().toISOString());
  log.info('已创建初始管理员账号', { username: row.username });
  app.audit.write({
    actorType: 'system',
    action: 'admin.bootstrap',
    targetType: 'user',
    targetId: row.id,
    detail: { username: row.username },
  });
}

/** 关闭数据库连接等资源 */
export function disposeApp(app: App): void {
  app.relay.stopPolling();
  app.db.close();
}
