/** 平台设置：默认值 + 持久化覆盖 */
import type { PlatformSettings, PublicPlatformSettings } from '@mclink/shared';
import { SettingsRepo } from '../db/users.ts';
import type { ServerConfig } from '../config.ts';

export const SETTINGS_KEY = 'platform';

/**
 * 与 `client/electron-builder.yml` 的 `artifactName` 保持一致。
 *
 * 这两处必须同时改：`clientDownloadUrl` 既决定网页「下载客户端」按钮指向哪个文件，
 * 也决定下载列表里哪个产物排在第一位、能拿到登记好的 sha256。
 * 曾经默认值是 `/downloads/mclink-client-setup.exe`，而构建产物叫
 * `mclink-client-<版本>-x64.exe` —— 全新部署上这个按钮会直接 404。
 */
export function clientArtifactName(version: string, arch = 'x64'): string {
  return `McLink-Setup-${version}-${arch}.exe`;
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  siteName: 'McLink 联机',
  siteTagline: '基于 EasyTier 的局域网联机平台，支持《我的世界》等各类局域网联机游戏',
  // 版本号要与下一行的 clientVersion 一致，改版本时两个一起改
  clientDownloadUrl: `/downloads/${clientArtifactName('1.0.7')}`,
  clientVersion: '1.0.7',
  clientSha256: null,
  defaultQuotaBytes: null,
  defaultMaxRooms: 3,
  defaultMaxPlayers: 8,
  roomTtlMinutes: 720,
  defaultCapacityPeers: 500,
  relayBandwidthKbps: 0,
  registrationOpen: true,
  relayPort: 11010,
  announcement: null,

  requireEmailVerification: true,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: 'ssl',
  smtpUser: '',
  smtpPassword: null,
  smtpFrom: '',
  emailCodeTtlMinutes: 15,
};

/**
 * 抹掉敏感字段后再对外返回。
 * 管理接口一律用它，别直接把 `current` 抛出去——那会把 SMTP 密码带进浏览器。
 */
export function toPublicSettings(settings: PlatformSettings): PublicPlatformSettings {
  const { smtpPassword, ...rest } = settings;
  return { ...rest, smtpPasswordSet: typeof smtpPassword === 'string' && smtpPassword.length > 0 };
}

export class SettingsService {
  #cache: PlatformSettings | null = null;
  private readonly repo: SettingsRepo;
  private readonly config: ServerConfig;

  constructor(repo: SettingsRepo, config: ServerConfig) {
    this.repo = repo;
    this.config = config;
  }

  get current(): PlatformSettings {
    if (this.#cache) return this.#cache;
    const stored = this.repo.get<Partial<PlatformSettings>>(SETTINGS_KEY, {});
    const smtp = this.config.smtp;
    const fromEnv: Partial<PlatformSettings> = {
      ...(smtp.host ? { smtpHost: smtp.host } : {}),
      ...(smtp.user ? { smtpUser: smtp.user } : {}),
      ...(smtp.password ? { smtpPassword: smtp.password } : {}),
      ...(smtp.from ? { smtpFrom: smtp.from } : {}),
      ...(smtp.requireVerification !== null ? { requireEmailVerification: smtp.requireVerification } : {}),
      ...(smtp.codeTtlMinutes !== null ? { emailCodeTtlMinutes: smtp.codeTtlMinutes } : {}),
      // 端口与加密方式只认"环境变量是否显式给过"：否则会盖掉管理台里的选择
      ...(process.env.MCLINK_SMTP_PORT ? { smtpPort: smtp.port } : {}),
      ...(process.env.MCLINK_SMTP_SECURE ? { smtpSecure: smtp.secure } : {}),
    };
    const merged: PlatformSettings = {
      ...DEFAULT_SETTINGS,
      relayPort: this.config.easytier.relayPort,
      registrationOpen: this.config.registrationOpen,
      ...fromEnv,
      ...stored,
    };
    this.#cache = merged;
    return merged;
  }

  update(patch: Partial<PlatformSettings>): PlatformSettings {
    const next = { ...this.current, ...sanitizePatch(patch) };
    this.repo.set(SETTINGS_KEY, next);
    this.#cache = next;
    return next;
  }

  invalidate(): void {
    this.#cache = null;
  }
}

/** 只接受已知键，避免用户往设置里塞任意内容 */
function sanitizePatch(patch: Partial<PlatformSettings>): Partial<PlatformSettings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof PlatformSettings>) {
    if (key in patch) out[key] = patch[key];
  }
  return out as Partial<PlatformSettings>;
}
