<script setup lang="ts">
/**
 * 平台设置：可持久化的业务参数 + 只读的环境变量来源项。
 *
 * 只读数与可编辑数的边界必须写清楚：端口、中继白名单、注册开关的**初始值**来自环境变量，
 * 改完需要重新部署；这里列出来只是为了让管理员知道「为什么改了没生效」。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { Routes, formatBytes, type PlatformSettings } from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { reportError, toFloat, toInt } from '../../lib/ui.ts';
import { notifyOk } from '../../lib/toast.ts';
import Badge from '../../components/Badge.vue';

interface EnvSettings {
  relayPort: number;
  relayNetworkWhitelist: string[];
  registrationOpen: boolean;
}

interface SettingsResponse {
  settings: PlatformSettings;
  defaults: PlatformSettings;
  env: EnvSettings;
}

const settings = ref<PlatformSettings | null>(null);
const defaults = ref<PlatformSettings | null>(null);
const env = ref<EnvSettings | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
const savedAt = ref<string | null>(null);

const form = reactive({
  siteName: '',
  siteTagline: '',
  clientDownloadUrl: '',
  clientVersion: '',
  clientSha256: '',
  announcement: '',
  registrationOpen: true,
  quotaUnlimited: true,
  quotaGb: '100',
  defaultMaxRooms: '3',
  defaultMaxPlayers: '8',
  roomTtlMinutes: '720',
  defaultCapacityPeers: '500',
  relayBandwidthKbps: '0',
});

function fillFrom(value: PlatformSettings): void {
  form.siteName = value.siteName;
  form.siteTagline = value.siteTagline;
  form.clientDownloadUrl = value.clientDownloadUrl;
  form.clientVersion = value.clientVersion;
  form.clientSha256 = value.clientSha256 ?? '';
  form.announcement = value.announcement ?? '';
  form.registrationOpen = value.registrationOpen;
  form.quotaUnlimited = value.defaultQuotaBytes === null;
  form.quotaGb = value.defaultQuotaBytes === null ? '100' : (value.defaultQuotaBytes / 1024 ** 3).toFixed(2);
  form.defaultMaxRooms = String(value.defaultMaxRooms);
  form.defaultMaxPlayers = String(value.defaultMaxPlayers);
  form.roomTtlMinutes = String(value.roomTtlMinutes);
  form.defaultCapacityPeers = String(value.defaultCapacityPeers);
  form.relayBandwidthKbps = String(value.relayBandwidthKbps);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<SettingsResponse>(Routes.adminSettings);
    settings.value = result.settings;
    defaults.value = result.defaults;
    env.value = result.env;
    fillFrom(result.settings);
    error.value = null;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const updated = await api.patch<PlatformSettings>(Routes.adminSettings, {
      siteName: form.siteName.trim(),
      siteTagline: form.siteTagline.trim(),
      clientDownloadUrl: form.clientDownloadUrl.trim(),
      clientVersion: form.clientVersion.trim(),
      clientSha256: form.clientSha256.trim().length > 0 ? form.clientSha256.trim() : null,
      announcement: form.announcement.trim().length > 0 ? form.announcement.trim() : null,
      registrationOpen: form.registrationOpen,
      defaultQuotaBytes: form.quotaUnlimited ? null : Math.max(0, Math.round(toFloat(form.quotaGb, 0) * 1024 ** 3)),
      defaultMaxRooms: Math.max(0, toInt(form.defaultMaxRooms, 3)),
      defaultMaxPlayers: Math.max(2, toInt(form.defaultMaxPlayers, 8)),
      roomTtlMinutes: Math.max(0, toInt(form.roomTtlMinutes, 720)),
      defaultCapacityPeers: Math.max(10, toInt(form.defaultCapacityPeers, 500)),
      relayBandwidthKbps: Math.max(0, toInt(form.relayBandwidthKbps, 0)),
    });
    settings.value = updated;
    fillFrom(updated);
    savedAt.value = new Date().toISOString();
    notifyOk('平台设置已保存');
  } catch (err) {
    saveError.value = reportError(err);
  } finally {
    saving.value = false;
  }
}

/** 用默认值填充表单（不提交），便于对照后逐项决定是否恢复 */
function restoreDefaults(): void {
  if (!defaults.value) return;
  fillFrom(defaults.value);
  notifyOk('已填入默认值，确认后请点击保存');
}

const currentQuotaText = computed(() => {
  const value = settings.value?.defaultQuotaBytes ?? null;
  return value === null ? '不限' : formatBytes(value);
});

const envWhitelist = computed(() => env.value?.relayNetworkWhitelist ?? []);
</script>

<template>
  <div class="stack" style="gap: var(--s-5)">
    <div class="row-between wrap">
      <div>
        <div class="panel-title">平台设置</div>
        <p class="panel-sub">
          这里的改动会立刻影响落地页与新建房间的默认值；部分项目需要在部署环境里配置才能生效。
        </p>
      </div>
      <div class="row">
        <button class="btn" type="button" :disabled="loading || !defaults" @click="restoreDefaults">恢复默认</button>
        <button class="btn btn-primary" type="button" :disabled="saving || loading" @click="save">
          <span v-if="saving" class="spinner" />
          保存设置
        </button>
      </div>
    </div>

    <div v-if="loading" class="stack">
      <div class="skeleton" style="height: 260px" />
      <div class="skeleton" style="height: 180px" />
    </div>

    <div v-else-if="error" class="card">
      <div class="row-between">
        <div>
          <div class="panel-title" style="font-size: var(--fs-base)">设置加载失败</div>
          <p class="panel-sub">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>
    </div>

    <template v-else>
      <div v-if="saveError" class="err-bar">
        <Badge tone="danger">保存失败</Badge>
        <span>{{ saveError }}</span>
      </div>
      <div v-else-if="savedAt" class="ok-bar">
        <Badge tone="ok">已保存</Badge>
        <span class="faint">设置已写入数据库并刷新缓存。</span>
      </div>

      <!-- 站点信息 -->
      <section class="card stack">
        <div class="panel-title" style="font-size: var(--fs-base)">站点信息</div>
        <div class="grid two">
          <div class="field">
            <label class="label" for="s-name">站点名称</label>
            <input id="s-name" v-model="form.siteName" class="input" maxlength="60" />
            <span class="hint">默认：{{ defaults?.siteName }}</span>
          </div>
          <div class="field">
            <label class="label" for="s-version">客户端版本号</label>
            <input id="s-version" v-model="form.clientVersion" class="input" maxlength="40" placeholder="0.1.0" />
            <span class="hint">展示在落地页与下载页，不等于构建产物版本。</span>
          </div>
        </div>
        <div class="field">
          <label class="label" for="s-tagline">一句话价值主张</label>
          <input id="s-tagline" v-model="form.siteTagline" class="input" maxlength="200" />
          <span class="hint">落地页 Hero 下方的副标题。</span>
        </div>
        <div class="field">
          <label class="label" for="s-announce">平台公告</label>
          <textarea
            id="s-announce"
            v-model="form.announcement"
            class="textarea"
            maxlength="300"
            placeholder="留空表示不显示公告条"
          />
          <span class="hint">非空时会在落地页顶部显示一条公告。</span>
        </div>
        <label class="switch">
          <input v-model="form.registrationOpen" type="checkbox" />
          <span>开放自助注册（关闭后仅管理员可开号；首个账号始终可注册）</span>
        </label>
        <p class="hint">
          注册开关同时受环境变量
          <span class="mono">MCLINK_REGISTRATION_OPEN</span> 约束：环境变量关闭时，这里的开关不会覆盖它（当前环境值：
          {{ env?.registrationOpen ? '开放' : '关闭' }}）。
        </p>
      </section>

      <!-- 客户端下载 -->
      <section class="card stack">
        <div class="panel-title" style="font-size: var(--fs-base)">客户端下载</div>
        <div class="grid two">
          <div class="field">
            <label class="label" for="s-url">下载地址</label>
            <input id="s-url" v-model="form.clientDownloadUrl" class="input mono" maxlength="300" placeholder="/downloads/mclink-client-setup.exe" />
            <span class="hint">可以是站内相对路径（放在下载目录）或外部链接。</span>
          </div>
          <div class="field">
            <label class="label" for="s-sha">安装包 SHA-256</label>
            <input id="s-sha" v-model="form.clientSha256" class="input mono" maxlength="128" placeholder="留空表示不校验" />
            <span class="hint">下载页会把该值展示给玩家用于校验。</span>
          </div>
        </div>
      </section>

      <!-- 默认配额与房间 -->
      <section class="card stack">
        <div class="panel-title" style="font-size: var(--fs-base)">默认配额与房间策略</div>
        <div class="grid two">
          <div class="field">
            <label class="label">新用户默认月度流量配额</label>
            <label class="switch">
              <input v-model="form.quotaUnlimited" type="checkbox" />
              <span>不限制</span>
            </label>
            <div v-if="!form.quotaUnlimited" class="row">
              <input v-model="form.quotaGb" class="input" type="number" min="0" step="0.5" />
              <span class="muted">GB</span>
            </div>
            <span class="hint">当前存储值：{{ currentQuotaText }}</span>
          </div>
          <div class="field">
            <label class="label" for="s-maxrooms">单用户最大同时房间数</label>
            <input id="s-maxrooms" v-model="form.defaultMaxRooms" class="input" type="number" min="0" />
            <span class="hint">0 表示禁止玩家建房（管理员仍可建房）。</span>
          </div>
          <div class="field">
            <label class="label" for="s-maxplayers">每房间默认最大人数</label>
            <input id="s-maxplayers" v-model="form.defaultMaxPlayers" class="input" type="number" min="2" max="64" />
            <span class="hint">房主可在建房时下调（2-64）。</span>
          </div>
          <div class="field">
            <label class="label" for="s-ttl">房间默认存活时长（分钟）</label>
            <input id="s-ttl" v-model="form.roomTtlMinutes" class="input" type="number" min="0" />
            <span class="hint">0 表示不自动过期，仅靠空房回收。</span>
          </div>
          <div class="field">
            <label class="label" for="s-cap">单节点容量（peer）</label>
            <input id="s-cap" v-model="form.defaultCapacityPeers" class="input" type="number" min="10" />
            <span class="hint">新注册子节点的默认容量，用于调度打分与降级判断。</span>
          </div>
          <div class="field">
            <label class="label" for="s-bw">平台级中继出口限速（kbps）</label>
            <input id="s-bw" v-model="form.relayBandwidthKbps" class="input" type="number" min="0" />
            <span class="hint">0 表示不限；会写入中继与子节点的 foreign_relay_bps_limit（按 bit/s 下发）。</span>
          </div>
        </div>
      </section>

      <!-- 环境变量只读项 -->
      <section class="card stack">
        <div class="row-between">
          <div>
            <div class="panel-title" style="font-size: var(--fs-base)">来自环境变量的只读项</div>
            <p class="panel-sub">这些值由部署环境决定，界面上不可修改；改完需要重新部署主控。</p>
          </div>
          <Badge tone="neutral">只读</Badge>
        </div>
        <div class="kv">
          <span class="kv-k">中继端口</span>
          <span class="kv-v mono">
            {{ env?.relayPort ?? '—' }}
            <span class="faint" style="font-size: var(--fs-xs)">MCLINK_RELAY_PORT / easytier.relayPort</span>
          </span>
          <span class="kv-k">中继白名单</span>
          <span class="kv-v mono truncate" :title="envWhitelist.join(', ')">
            {{ envWhitelist.length > 0 ? envWhitelist.join(', ') : '（未配置）' }}
            <span class="faint" style="font-size: var(--fs-xs); font-family: var(--font-sans)">
              只有匹配的网络名才会被中继转发，默认 mclink-room-*
            </span>
          </span>
          <span class="kv-k">注册开关</span>
          <span class="kv-v">
            <Badge :tone="env?.registrationOpen ? 'ok' : 'neutral'">{{ env?.registrationOpen ? '开放' : '关闭' }}</Badge>
            <span class="faint" style="font-size: var(--fs-xs)">MCLINK_REGISTRATION_OPEN</span>
          </span>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.two {
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}
.kv {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: var(--s-2) var(--s-3);
  font-size: var(--fs-sm);
  align-items: baseline;
}
.kv-k {
  color: var(--text-faint);
  font-size: var(--fs-xs);
}
.kv-v {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.err-bar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-md);
  background: var(--danger-bg);
  border: 1px solid rgba(255, 107, 107, 0.3);
  font-size: var(--fs-sm);
}
.ok-bar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-md);
  background: var(--ok-bg);
  border: 1px solid rgba(61, 220, 151, 0.28);
  font-size: var(--fs-sm);
}
</style>
