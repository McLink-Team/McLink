/**
 * 服务端配置：环境变量优先，可选 JSON 配置文件覆盖默认值。
 *
 * 生产环境（Debian）用 systemd 的 EnvironmentFile 注入；本机开发只需环境变量或默认值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/ 目录 */
export const SERVER_ROOT = path.resolve(HERE, '..');
/** 仓库根目录 */
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

export interface ServerConfig {
  /* ---- HTTP ---- */
  host: string;
  port: number;
  /** 对外可访问的基础 URL，用于生成下载链接与回调 */
  publicBaseUrl: string;
  trustProxy: boolean;

  /* ---- 存储 ---- */
  dataDir: string;
  dbFile: string;

  /* ---- 安全 ---- */
  jwtSecret: string;
  /** 访问令牌有效期（秒） */
  tokenTtlSeconds: number;
  /** 单 IP 每分钟的匿名请求上限 */
  anonymousRateLimitPerMinute: number;
  /** 单 IP 每分钟的登录尝试上限 */
  loginRateLimitPerMinute: number;
  corsOrigins: string[];

  /* ---- 初始化管理员 ---- */
  bootstrapAdminUsername: string;
  bootstrapAdminPassword: string;

  /** 主控自身 EasyTier 中继 */ 
  easytier: EasytierConfig;

  /* ---- 运行时行为 ---- */
  nodeOfflineTimeoutSeconds: number;
  nodeHeartbeatIntervalSeconds: number;
  /** 房间在无人心跳后多久判定为「空房」并可回收（秒） */
  roomIdleTimeoutSeconds: number;
  /** 平台是否开放注册 */
  registrationOpen: boolean;
  logLevel: LogLevel;
  /** 是否在启动时自动拉起主控中继实例 */
  autoStartRelay: boolean;
}

export interface EasytierConfig {
  /** easytier-core 可执行文件路径 */
  coreBin: string;
  /** easytier-cli 可执行文件路径 */
  cliBin: string;
  /** 生成配置的存放目录 */
  configDir: string;
  /** 主控中继监听的公共端口（TCP+UDP 同端口） */
  relayPort: number;
  /** 中继实例的 RPC 端口，仅本机访问 */
  relayRpcPortal: string;
  /** 中继所在的管理网络名 */
  relayNetworkName: string;
  relayNetworkSecret: string;
  /**
   * 允许经由主控中继的外来网络，空格分隔的 wildmatch 模式。
   * 默认 `mclink-room-*`：只为我们自己创建的房间中继，避免主控被当成免费公共中继。
   */
  relayNetworkWhitelist: string;
  /** 主控中继上是否创建 TUN 设备（服务端不需要） */
  relayNoTun: boolean;
  /**
   * 主控中继对外的公网主机名/IP，客户端用它连接主控。
   * 留空时依次回退到 MCLINK_PUBLIC_BASE_URL 的主机名、请求的 Host 头。
   */
  relayPublicHost: string;
  /**
   * 主控中继的转发出口限速。
   * ⚠️ 单位是 EasyTier 原生的**字节/秒**（字段名叫 `_bps_` 但语义是字节），
   * 不是比特/秒。管理台的 `relayBandwidthKbps`（kbps）会经
   * `kbpsToBytesPerSecond()` 换算后再下发到子节点。
   * 0 = 不限。
   */
  relayForeignBpsLimit: number;
  /** 中继实例是否启用多线程 */
  relayMultiThread: boolean;
  /** 运行子节点/房间实例时附加的公共参数 */
  extraFlags: string[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function intEnv(name: string, fallback: number, min?: number, max?: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (min !== undefined) out = Math.max(min, out);
  if (max !== undefined) out = Math.min(max, out);
  return out;
}

/** 平台默认端口；与 /packages/shared 的文档保持一致 */
export const DEFAULT_RELAY_PORT = 11010;
export const DEFAULT_HTTP_PORT = 8787;

function detectDefaultCoreBin(): string {
  const candidates = [
    path.join(REPO_ROOT, 'vendor', 'easytier', process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core'),
    path.join(REPO_ROOT, 'bin', process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core'),
    path.join(REPO_ROOT, 'vendor', 'easytier', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 回退：交给 PATH
  return process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core';
}

function detectDefaultCliBin(): string {
  const core = detectDefaultCoreBin();
  const dir = path.dirname(core);
  const name = process.platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli';
  const local = path.join(dir, name);
  return fs.existsSync(local) ? local : name;
}

function pickLogLevel(): LogLevel {
  const v = env('MCLINK_LOG_LEVEL') as LogLevel | undefined;
  if (v && LOG_LEVELS.includes(v)) return v;
  return env('NODE_ENV') === 'production' ? 'info' : 'debug';
}

export function loadConfig(): ServerConfig {
  const dataDir = path.resolve(env('MCLINK_DATA_DIR') ?? path.join(SERVER_ROOT, 'data'));
  const config: ServerConfig = {
    host: env('MCLINK_HOST') ?? '0.0.0.0',
    port: intEnv('MCLINK_PORT', DEFAULT_HTTP_PORT, 1, 65535),
    publicBaseUrl: env('MCLINK_PUBLIC_BASE_URL') ?? '',
    trustProxy: boolEnv('MCLINK_TRUST_PROXY', true),

    dataDir,
    dbFile: path.resolve(env('MCLINK_DB_FILE') ?? path.join(dataDir, 'mclink.sqlite')),

    jwtSecret: env('MCLINK_JWT_SECRET') ?? '',
    tokenTtlSeconds: intEnv('MCLINK_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 14, 300),
    anonymousRateLimitPerMinute: intEnv('MCLINK_RATE_LIMIT', 240, 10),
    loginRateLimitPerMinute: intEnv('MCLINK_LOGIN_RATE_LIMIT', 20, 3),
    corsOrigins: (env('MCLINK_CORS_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),

    bootstrapAdminUsername: env('MCLINK_ADMIN_USER') ?? 'admin',
    bootstrapAdminPassword: env('MCLINK_ADMIN_PASSWORD') ?? '',

    easytier: {
      coreBin: env('MCLINK_ET_CORE') ?? detectDefaultCoreBin(),
      cliBin: env('MCLINK_ET_CLI') ?? detectDefaultCliBin(),
      configDir: path.resolve(env('MCLINK_ET_CONFIG_DIR') ?? path.join(dataDir, 'easytier')),
      relayPort: intEnv('MCLINK_RELAY_PORT', DEFAULT_RELAY_PORT, 1, 65535),
      relayRpcPortal: env('MCLINK_RELAY_RPC') ?? '127.0.0.1:15888',
      relayNetworkName: env('MCLINK_RELAY_NETWORK') ?? 'mclink-master',
      relayNetworkSecret: env('MCLINK_RELAY_SECRET') ?? '',
      relayNetworkWhitelist: env('MCLINK_RELAY_WHITELIST') ?? 'mclink-room-*',
      relayNoTun: boolEnv('MCLINK_RELAY_NO_TUN', true),
      relayPublicHost: env('MCLINK_RELAY_PUBLIC_HOST') ?? '',
      relayForeignBpsLimit: intEnv('MCLINK_RELAY_BPS_LIMIT', 0, 0),
      relayMultiThread: boolEnv('MCLINK_RELAY_MULTITHREAD', true),
      extraFlags: [],
    },

    nodeOfflineTimeoutSeconds: intEnv('MCLINK_NODE_OFFLINE_TIMEOUT', 90, 15),
    nodeHeartbeatIntervalSeconds: intEnv('MCLINK_NODE_HEARTBEAT_INTERVAL', 20, 5),
    roomIdleTimeoutSeconds: intEnv('MCLINK_ROOM_IDLE_TIMEOUT', 600, 60),
    registrationOpen: boolEnv('MCLINK_REGISTRATION_OPEN', true),
    logLevel: pickLogLevel(),
    autoStartRelay: boolEnv('MCLINK_AUTOSTART_RELAY', true),
  };

  return config;
}

/**
 * 校验并「补齐」配置：缺失的密钥落盘生成为持久值，避免每次重启导致令牌/网络身份失效。
 */
export function finalizeConfig(config: ServerConfig): { config: ServerConfig; warnings: string[] } {
  const warnings: string[] = [];
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.easytier.configDir, { recursive: true });

  const secretsFile = path.join(config.dataDir, 'secrets.json');
  let persisted: Record<string, string> = {};
  if (fs.existsSync(secretsFile)) {
    try {
      persisted = JSON.parse(fs.readFileSync(secretsFile, 'utf8')) as Record<string, string>;
    } catch {
      warnings.push(`secrets.json 解析失败，将重新生成必要密钥: ${secretsFile}`);
      persisted = {};
    }
  }

  let dirty = false;
  const ensure = (key: string, generate: () => string): string => {
    const fromEnv = process.env[key];
    if (fromEnv) return fromEnv;
    if (persisted[key]) return persisted[key];
    const value = generate();
    persisted[key] = value;
    dirty = true;
    return value;
  };

  if (!config.jwtSecret) {
    config.jwtSecret = ensure('MCLINK_JWT_SECRET', () => randomSecret(48));
  }
  if (config.jwtSecret.length < 16) {
    warnings.push('MCLINK_JWT_SECRET 长度不足 16 字符，已自动使用落盘密钥替代');
    config.jwtSecret = ensure('MCLINK_JWT_SECRET', () => randomSecret(48));
  }
  if (!config.bootstrapAdminPassword) {
    const generated = ensure('MCLINK_ADMIN_PASSWORD', () => randomSecret(18));
    config.bootstrapAdminPassword = generated;
    warnings.push(
      `未设置 MCLINK_ADMIN_PASSWORD，首次启动将使用自动生成的初始管理员密码（已存入 ${secretsFile}）。` +
        '请在管理台登录后立即修改。',
    );
  }
  if (!config.easytier.relayNetworkSecret) {
    config.easytier.relayNetworkSecret = ensure('MCLINK_RELAY_SECRET', () => randomSecret(32));
  }

  if (dirty) {
    fs.writeFileSync(secretsFile, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  }
  return { config, warnings };
}

function randomSecret(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return out;
}
