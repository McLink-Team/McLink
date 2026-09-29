<script setup lang="ts">
/**
 * 平台设置：可持久化的业务参数 + 只读的环境变量来源项。
 *
 * 只读数与可编辑数的边界必须写清楚：端口、中继白名单、注册开关的**初始值**来自环境变量，
 * 改完需要重新部署；这里列出来只是为了让管理员知道「为什么改了没生效」。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { Routes, emailProblem, formatBytes, type PublicPlatformSettings } from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { asPatternList, reportError, toFloat, toInt } from '../../lib/ui.ts';
import { notifyOk } from '../../lib/toast.ts';
import Badge from '../../components/Badge.vue';

interface EnvSettings {
  relayPort: number;
  /** 服务端是空格分隔的字符串（MCLINK_RELAY_WHITELIST），不是数组 */
  relayNetworkWhitelist: string | string[];
  registrationOpen: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: string;
  smtpFrom: string;
  requireEmailVerification: boolean | null;
}

/** 控制台看到的设置：没有 SMTP 明文密码，只有"是否已设置" */
type SettingsView = PublicPlatformSettings;

/** SMTP 排障信息（来自 /admin/mail/status 与测试接口） */
interface MailAttempt {
  at: string;
  to: string;
  kind: 'verify' | 'test';
  ok: boolean;
  error: string | null;
  transcript: string[] | null;
}

interface MailStatus {
  configured: boolean;
  host: string;
  port: number;
  secure: string;
  user: string;
  from: string;
  passwordSet: boolean;
  requireEmailVerification: boolean;
  codeTtlMinutes: number;
  lastAttempt: MailAttempt | null;
  recent?: MailAttempt[];
}

interface SettingsResponse {
  settings: SettingsView;
  defaults: SettingsView;
  mail: MailStatus;
  env: EnvSettings;
}

const settings = ref<SettingsView | null>(null);
const defaults = ref<SettingsView | null>(null);
const env = ref<EnvSettings | null>(null);
const mail = ref<MailStatus | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
const savedAt = ref<string | null>(null);

/* ------------------------------------------------------------ 邮件排障 */

const testTo = ref('');
const testing = ref(false);
const testResult = ref<MailAttempt | null>(null);
const showTranscript = ref(false);


async function sendTestMail(): Promise<void> {
  const to = testTo.value.trim();
  const problem = emailProblem(to);
  if (problem) {
    testResult.value = { at: new Date().toISOString(), to, kind: 'test', ok: false, error: problem, transcript: null };
    return;
  }
  testing.value = true;
  testResult.value = null;
  try {
    // 注意：发失败也返回 200 —— 这接口是"诊断"，失败时最有价值的是 SMTP 会话原文
    testResult.value = await api.post<MailAttempt>(Routes.adminMailTest, { to });
    mail.value = await api.get<MailStatus>(Routes.adminMailStatus);
    if (testResult.value.ok) notifyOk(`测试邮件已投递给 ${to}`);
  } catch (err) {
    testResult.value = {
      at: new Date().toISOString(),
      to,
      kind: 'test',
      ok: false,
      error: friendlyError(err),
      transcript: null,
    };
  } finally {
    testing.value = false;
  }
}

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
  relayBigPipeMbps: '10',
  relayScaleMbps: '8',
  relaySmallShedPercent: '80',
  /* 邮件 */
  requireEmailVerification: true,
  smtpHost: '',
  smtpPort: '465',
  smtpSecure: 'ssl' as 'ssl' | 'starttls' | 'none',
  smtpUser: '',
  smtpFrom: '',
  emailCodeTtlMinutes: '15',
  /**
   * 密码是三态：留空 = 不改（保留已存的），填了 = 改成这个。
   * 不做回显是因为设置接口从不返回明文，界面也无从显示。
   */
  smtpPassword: '',
  clearSmtpPassword: false,
});

function fillFrom(value: SettingsView): void {
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
  // 服务端存的是字节/秒与 Mbps；界面统一按 Mbps 填（与节点编辑里的「带宽上限」同一口径）
  form.relayBigPipeMbps = String(Math.round((value.relayBigPipeBps ?? 0) / 1_000_000));
  form.relayScaleMbps = String(value.relayScaleMbps ?? 0);
  form.relaySmallShedPercent = String(value.relaySmallShedPercent ?? 80);
  form.requireEmailVerification = value.requireEmailVerification;
  form.smtpHost = value.smtpHost;
  form.smtpPort = String(value.smtpPort);
  form.smtpSecure = value.smtpSecure;
  form.smtpUser = value.smtpUser;
  form.smtpFrom = value.smtpFrom;
  form.emailCodeTtlMinutes = String(value.emailCodeTtlMinutes);
  form.smtpPassword = '';
  form.clearSmtpPassword = false;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<SettingsResponse>(Routes.adminSettings);
    settings.value = result.settings;
    defaults.value = result.defaults;
    env.value = result.env;
    mail.value = result.mail;
    fillFrom(result.settings);
    error.value = null;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  // 群发预览（可发送人数 / 上次结果）——与其它设置并行加载，失败不影响页面
  void load();
});

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const payload: Record<string, unknown> = {
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
      relayBigPipeBps: Math.max(0, Math.round(toFloat(form.relayBigPipeMbps, 0) * 1_000_000)),
      relayScaleMbps: Math.max(0, toInt(form.relayScaleMbps, 0)),
      // 封顶 90%：小管子可以更早卸荷，但不该比全局线更晚
      relaySmallShedPercent: Math.min(90, Math.max(1, toInt(form.relaySmallShedPercent, 80))),
      requireEmailVerification: form.requireEmailVerification,
      smtpHost: form.smtpHost.trim(),
      smtpPort: Math.min(65535, Math.max(1, toInt(form.smtpPort, 465))),
      smtpSecure: form.smtpSecure,
      smtpUser: form.smtpUser.trim(),
      smtpFrom: form.smtpFrom.trim(),
      emailCodeTtlMinutes: Math.min(1440, Math.max(1, toInt(form.emailCodeTtlMinutes, 15))),
    };
    // 只有真的动了密码才提交这个字段：不传字段 = 服务端保留原密码
    if (form.clearSmtpPassword) payload.smtpPassword = null;
    else if (form.smtpPassword.trim().length > 0) payload.smtpPassword = form.smtpPassword.trim();

    const updated = await api.patch<{ settings: SettingsView; mail: MailStatus }>(Routes.adminSettings, payload);
    settings.value = updated.settings;
    mail.value = updated.mail;
    fillFrom(updated.settings);
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

/** 白名单：环境变量给的是空格分隔字符串，统一拆成数组再渲染 */
const envWhitelist = computed(() => asPatternList(env.value?.relayNetworkWhitelist));
</script>

<template>
  <div class="console-page">
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">平台设置</h1>
        <p class="console-head-sub">
          这里的改动会立刻影响落地页与新建房间的默认值；部分项目需要在部署环境里配置才能生效。
        </p>
      </div>
      <div class="console-head-actions">
        <button class="btn" type="button" :disabled="loading || !defaults" @click="restoreDefaults">恢复默认</button>
        <button class="btn btn-primary" type="button" :disabled="saving || loading" @click="save">
          <span v-if="saving" class="spinner" />
          保存设置
        </button>
      </div>
    </header>

    <div v-if="loading" class="stack">
      <div class="skeleton" style="height: 240px" />
      <div class="skeleton" style="height: 160px" />
    </div>

    <section v-else-if="error" class="console-section">
      <div class="console-section-head">
        <div class="console-section-text">
          <div class="console-sub-title">设置加载失败</div>
          <p class="console-section-note">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>
    </section>

    <template v-else>
      <div v-if="saveError" class="notice notice-danger">
        <Badge tone="danger">保存失败</Badge>
        <span class="notice-body">{{ saveError }}</span>
      </div>
      <div v-else-if="savedAt" class="notice notice-ok">
        <Badge tone="ok">已保存</Badge>
        <span class="notice-body">设置已写入数据库并刷新缓存。</span>
      </div>

      <!-- 站点信息 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">站点信息</h2>
            <p class="console-section-note">展示在落地页与下载页的对外文案。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label class="label" for="s-name">站点名称</label>
            <input id="s-name" v-model="form.siteName" class="input" maxlength="60" />
            <span class="hint">默认：{{ defaults?.siteName }}</span>
          </div>
          <div class="field">
            <label class="label" for="s-version">客户端版本号</label>
            <input id="s-version" v-model="form.clientVersion" class="input mono" maxlength="40" placeholder="0.1.0" />
            <span class="hint">展示在落地页与下载页，不等于构建产物版本。</span>
          </div>
          <div class="field field-wide">
            <label class="label" for="s-tagline">一句话价值主张</label>
            <input id="s-tagline" v-model="form.siteTagline" class="input" maxlength="200" />
            <span class="hint">落地页 Hero 下方的副标题。</span>
          </div>
          <div class="field field-wide">
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
        </div>
        <label class="switch switch-row">
          <input v-model="form.registrationOpen" type="checkbox" />
          <span>开放自助注册（关闭后仅管理员可开号；首个账号始终可注册）</span>
        </label>
        <p class="hint hint-measure">
          注册开关同时受环境变量
          <span class="mono">MCLINK_REGISTRATION_OPEN</span> 约束：环境变量关闭时，这里的开关不会覆盖它（当前环境值：
          {{ env?.registrationOpen ? '开放' : '关闭' }}）。
        </p>

      <!-- 邮件服务（SMTP） -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">邮件服务（SMTP）</h2>
            <p class="console-section-note">
              主控自己发信，不依赖外部服务。465 端口用 SSL，587 端口用 STARTTLS。
            </p>
          </div>
          <div class="console-section-actions">
            <Badge :tone="mail?.configured ? 'ok' : 'warn'">
              {{ mail?.configured ? '已配置' : '未配置' }}
            </Badge>
          </div>
        </div>

        <div
          v-if="form.requireEmailVerification && !mail?.configured"
          class="notice notice-danger"
        >
          <Badge tone="danger">会挡住注册</Badge>
          <span class="notice-body">
            「要求验证邮箱」已打开，但邮件服务还没配好：新用户注册会直接失败。
            请先填好下面的 SMTP 参数并发一封测试邮件，或者临时关掉这个开关。
          </span>
        </div>

        <label class="switch switch-row">
          <input v-model="form.requireEmailVerification" type="checkbox" />
          <span>要求验证邮箱（未验证的账号不能建房/进房）</span>
        </label>
        <p class="hint hint-measure">
          没绑定邮箱的历史账号与管理员建号不受影响；玩家自己填了邮箱就必须验证。
          验证码 6 位数字，只存哈希，不存明文。
        </p>

        <div class="form-grid">
          <div class="field">
            <label class="label" for="smtp-host">SMTP 服务器</label>
            <input
              id="smtp-host"
              v-model="form.smtpHost"
              class="input mono"
              maxlength="200"
              placeholder="smtp.example.com"
            />
            <span v-if="env?.smtpHost" class="hint">环境变量给了初始值：{{ env.smtpHost }}</span>
          </div>
          <div class="field">
            <label class="label" for="smtp-port">端口</label>
            <input id="smtp-port" v-model="form.smtpPort" class="input mono" inputmode="numeric" placeholder="465" />
            <span class="hint">SSL 一般 465，STARTTLS 一般 587。</span>
          </div>
          <div class="field">
            <label class="label" for="smtp-secure">加密方式</label>
            <select id="smtp-secure" v-model="form.smtpSecure" class="select">
              <option value="ssl">SSL（直连 TLS，465）</option>
              <option value="starttls">STARTTLS（先明文再升级，587）</option>
              <option value="none">不加密（仅限本机/内网中继）</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="smtp-from">发件人</label>
            <input
              id="smtp-from"
              v-model="form.smtpFrom"
              class="input mono"
              maxlength="200"
              placeholder="mclink <no-reply@cnnic.link>"
            />
            <span class="hint">留空则用下面的登录账号当发件人。</span>
          </div>
          <div class="field">
            <label class="label" for="smtp-user">登录账号</label>
            <input
              id="smtp-user"
              v-model="form.smtpUser"
              class="input mono"
              maxlength="120"
              autocomplete="off"
              placeholder="no-reply@cnnic.link"
            />
            <span class="hint">内网中继不需要认证时留空。</span>
          </div>
          <div class="field">
            <label class="label" for="smtp-pass">登录密码</label>
            <input
              id="smtp-pass"
              v-model="form.smtpPassword"
              class="input"
              type="password"
              autocomplete="new-password"
              :placeholder="mail?.passwordSet ? '已设置（留空表示不修改）' : '未设置'"
              :disabled="form.clearSmtpPassword"
            />
            <label class="switch" style="margin-top: 4px">
              <input v-model="form.clearSmtpPassword" type="checkbox" />
              <span class="hint">清空已保存的密码</span>
            </label>
            <span class="hint">只写不读：保存后服务端不会再把它回传给浏览器。</span>
          </div>
          <div class="field">
            <label class="label" for="smtp-ttl">验证码有效期（分钟）</label>
            <input id="smtp-ttl" v-model="form.emailCodeTtlMinutes" class="input mono" inputmode="numeric" />
            <span class="hint">默认 15 分钟；同一账号 60 秒内只能要一次码。</span>
          </div>
        </div>

        <!-- 测试邮件：走的是与验证码完全相同的发送路径 -->
        <div class="console-section-sub">
          <div class="console-section-text">
            <h3 class="console-sub-title">发一封测试邮件</h3>
            <p class="console-section-note">失败时会把完整的 SMTP 会话显示出来 —— 报错基本都在那段对话里。</p>
          </div>
        </div>
        <div class="row wrap" style="gap: var(--s-3); align-items: flex-end">
          <div class="field grow" style="min-width: 240px">
            <label class="label" for="mail-test-to">收件地址</label>
            <input
              id="mail-test-to"
              v-model="testTo"
              class="input"
              type="email"
              placeholder="你自己的邮箱"
              @keyup.enter="sendTestMail()"
            />
          </div>
          <button class="btn" type="button" :disabled="testing" @click="sendTestMail">
            <span v-if="testing" class="spinner" />
            发送测试邮件
          </button>
        </div>

        <div v-if="testResult" class="stack" style="margin-top: var(--s-3)">
          <div :class="testResult.ok ? 'notice notice-ok' : 'notice notice-danger'">
            <Badge :tone="testResult.ok ? 'ok' : 'danger'">{{ testResult.ok ? '已投递' : '失败' }}</Badge>
            <span class="notice-body">
              <template v-if="testResult.ok">
                {{ testResult.to }} 已交给 {{ mail?.host }}:{{ mail?.port }}，请查收（也看看垃圾邮件）。
              </template>
              <template v-else>{{ testResult.error }}</template>
            </span>
            <button
              v-if="testResult.transcript && testResult.transcript.length > 0"
              class="btn btn-sm btn-ghost"
              type="button"
              @click="showTranscript = !showTranscript"
            >
              {{ showTranscript ? '收起会话' : '查看 SMTP 会话' }}
            </button>
          </div>
          <pre v-if="showTranscript && testResult.transcript" class="code-block log-block">{{
            testResult.transcript.join('\n')
          }}</pre>
        </div>

        <div v-if="mail?.lastAttempt" class="hint hint-measure" style="margin-top: var(--s-3)">
          上一次发信：{{ mail.lastAttempt.kind === 'test' ? '测试邮件' : '验证码' }} →
          {{ mail.lastAttempt.to }}，{{ mail.lastAttempt.ok ? '成功' : '失败：' + mail.lastAttempt.error }}
          <span class="mono">（{{ mail.lastAttempt.at }}）</span>
        </div>
      </section>
      </section>

      <!-- 客户端下载 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">客户端下载</h2>
            <p class="console-section-note">下载页的按钮地址与校验值。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label class="label" for="s-url">下载地址</label>
            <input
              id="s-url"
              v-model="form.clientDownloadUrl"
              class="input mono"
              maxlength="300"
              placeholder="/downloads/mclink-client-setup.exe"
            />
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
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">默认配额与房间策略</h2>
            <p class="console-section-note">新注册账号与新建房间的初始值，房主可在建房时下调。</p>
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <span class="label">新用户默认月度流量配额</span>
            <label class="switch">
              <input v-model="form.quotaUnlimited" type="checkbox" />
              <span>不限制</span>
            </label>
            <div v-if="!form.quotaUnlimited" class="quota-row">
              <input v-model="form.quotaGb" class="input" type="number" min="0" step="0.5" />
              <span class="quota-unit">GB</span>
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
            <span class="hint">
              <b>无人活跃</b>这么久之后过期：只要房里还有人（客户端每 10 秒一次心跳），
              到期时间就会一直顺延 —— 正在联机的房间不会被解散。
              0 表示不自动过期，仅靠空房回收。
            </span>
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
          <div class="field">
            <label class="label" for="s-bigpipe">大带宽档门槛（Mbps）</label>
            <input id="s-bigpipe" v-model="form.relayBigPipeMbps" class="input" type="number" min="0" />
            <span class="hint">
              节点的「带宽上限」≥ 它就算大管子（**没填 = 不限，也算大管子**）。
              房间的第二台中继（兜底）优先从大带宽档里选，让每个房间一开局就握着一条大管子。
            </span>
          </div>
          <div class="field">
            <label class="label" for="s-scale">房间中继过载阈值（Mbps）</label>
            <input id="s-scale" v-model="form.relayScaleMbps" class="input" type="number" min="0" />
            <span class="hint">
              某房间的中继速率（收+发）连续 3 分钟超过它，平台会把该房间的**中继槽**换成
              当前最空的大带宽节点，让**之后进房的人**走大管子（房里的人不受影响）；
              流量回落 3 分钟后自动还原。0 = 关闭。
            </span>
          </div>
          <div class="field">
            <label class="label" for="s-small-shed">小带宽节点卸荷线（%）</label>
            <input id="s-small-shed" v-model="form.relaySmallShedPercent" class="input" type="number" min="1" max="90" />
            <span class="hint">
              大带宽节点跑到 90% 才不再接新房间；**小管子**（填了带宽上限、但不到「大带宽档门槛」的节点）
              到这个百分比就停止**新增中继** —— 默认 80%，封顶 90%。
              ⚠️ 只挡新房间：已经在上面跑的房间一个都不动，节点默认仍然正常中继。
            </span>
          </div>
        </div>
      </section>

      <!-- 环境变量只读项 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">来自环境变量的只读项</h2>
            <p class="console-section-note">这些值由部署环境决定，界面上不可修改；改完需要重新部署主控。</p>
          </div>
          <Badge tone="neutral">只读</Badge>
        </div>
        <div class="kv">
          <span class="kv-k">中继端口</span>
          <span class="kv-v">
            <span class="readout">{{ env?.relayPort ?? '未配置' }}</span>
            <span class="cell-sub">MCLINK_RELAY_PORT / easytier.relayPort</span>
          </span>
          <span class="kv-k">中继白名单</span>
          <span class="kv-v">
            <span class="mono wrap-anywhere">
              {{ envWhitelist.length > 0 ? envWhitelist.join(', ') : '（未配置）' }}
            </span>
            <span class="cell-sub">只有匹配的网络名才会被中继转发，默认 mclink-room-*</span>
          </span>
          <span class="kv-k">注册开关</span>
          <span class="kv-v">
            <Badge :tone="env?.registrationOpen ? 'ok' : 'neutral'">{{ env?.registrationOpen ? '开放' : '关闭' }}</Badge>
            <span class="cell-sub">MCLINK_REGISTRATION_OPEN</span>
          </span>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--s-4) var(--s-5);
  align-items: start;
}
.field-wide {
  grid-column: 1 / -1;
}
.switch-row {
  margin-top: var(--s-4);
}
.hint-measure {
  margin-top: 6px;
  max-width: 74ch;
}
.quota-row {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.quota-unit {
  font-size: var(--fs-sm);
  color: var(--paper-dim);
  font-family: var(--font-mono);
}
.notice-body {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
