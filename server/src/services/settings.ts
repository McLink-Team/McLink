/** 平台设置：默认值 + 持久化覆盖 */
import type { PlatformSettings } from '@mclink/shared';
import { SettingsRepo } from '../db/users.ts';
import type { ServerConfig } from '../config.ts';

export const SETTINGS_KEY = 'platform';

export const DEFAULT_SETTINGS: PlatformSettings = {
  siteName: 'mclink 联机',
  siteTagline: '基于 EasyTier 的《我的世界》联机平台 —— 单端口、低延迟、开箱即用',
  clientDownloadUrl: '/downloads/mclink-client-setup.exe',
  clientVersion: '0.1.0',
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
};

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
    const merged: PlatformSettings = {
      ...DEFAULT_SETTINGS,
      relayPort: this.config.easytier.relayPort,
      registrationOpen: this.config.registrationOpen,
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
