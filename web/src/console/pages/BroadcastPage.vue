<script setup lang="ts">
/**
 * 邮件公告（群发）。
 *
 * 为什么单独做成一个页面而不是塞在「平台设置」里：
 * 群发是一个**动作**，不是配置项。之前它作为设置页的第 4 张卡存在，
 * 管理员在左侧导航里翻不到，得先想到"它可能在设置里"才找得到 —— 实测定位失败。
 *
 * 发送本身在服务端后台分批跑（每批 5 封、批间 1.2 秒，避免被 SMTP 服务商限流），
 * 这个页面只负责：登记任务、显示进度、必要时中止。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Routes } from '@mclink/shared';
import { formatDateTime } from '../../lib/ui.ts';
import { api, friendlyError } from '../../lib/api.ts';
import { notifyOk, notifyWarn } from '../../lib/toast.ts';
import Badge from '../../components/Badge.vue';

interface BroadcastReport {
  id: string;
  subject: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  sent: number;
  failed: number;
  errors: Array<{ to: string; error: string }>;
  aborted: boolean;
}

interface BroadcastPreview {
  deliverable: number;
  unverified: number;
  banned: number;
  withoutEmail: number;
  running: boolean;
  lastRun: BroadcastReport | null;
}

const data = ref<BroadcastPreview | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const subject = ref('');
const body = ref('');
const busy = ref(false);
const actionError = ref<string | null>(null);
let timer: number | null = null;

/** 进度只在运行中轮询：跑完就停，不白耗控制台的请求 */
function stopPolling(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}
function startPolling(): void {
  stopPolling();
  timer = window.setInterval(() => {
    void load().then(() => {
      if (!data.value?.running) stopPolling();
    });
  }, 2000);
}

async function load(): Promise<void> {
  try {
    data.value = await api.get<BroadcastPreview>(Routes.adminBroadcast);
    loadError.value = null;
  } catch (err) {
    loadError.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

async function send(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  actionError.value = null;
  try {
    await api.post(Routes.adminBroadcast, { subject: subject.value, body: body.value });
    subject.value = '';
    body.value = '';
    await load();
    startPolling();
    notifyOk('已开始群发，进度会在这里更新');
  } catch (err) {
    actionError.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function stop(): Promise<void> {
  try {
    await api.del(Routes.adminBroadcast);
    notifyWarn('已请求中止 —— 已经发出去的收不回，只能停下剩下的');
  } catch (err) {
    actionError.value = friendlyError(err);
  } finally {
    await load();
  }
}

onMounted(() => {
  void load();
});
onUnmounted(stopPolling);

const report = computed(() => data.value?.lastRun ?? null);
const canSend = computed(
  () => !busy.value && data.value !== null && !data.value.running && data.value.deliverable > 0,
);
/** 进度百分比：只在运行时用来给一条进度线 */
const percent = computed(() => {
  const r = data.value?.lastRun;
  if (!r || r.total === 0) return 0;
  return Math.round(((r.sent + r.failed) / r.total) * 100);
});
</script>

<template>
  <div class="console-page">
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">邮件公告</h1>
        <p class="console-head-sub">
          给所有<b>已验证邮箱且未封禁</b>的用户发一封公告。发送在后台分批进行（每批 5 封、批间 1.2 秒，
          避免被 SMTP 服务商限流），这个页面只负责登记与查看进度。
        </p>
      </div>
      <div class="console-head-actions">
        <Badge :tone="data?.running ? 'warn' : 'neutral'" dot :pulse="Boolean(data?.running)">
          {{ data?.running ? '发送中' : '空闲' }}
        </Badge>
      </div>
    </header>

    <section v-if="loading" class="console-section">
      <div class="skeleton" style="height: 20px; width: 30%" />
      <div class="skeleton" style="height: 44px" />
      <div class="skeleton" style="height: 120px" />
    </section>

    <section v-else-if="loadError && !data" class="console-section">
      <div class="notice notice-danger">
        <Badge tone="danger">读取失败</Badge>
        <span class="notice-body">{{ loadError }}</span>
        <button class="btn btn-sm" type="button" @click="load">重试</button>
      </div>
    </section>

    <template v-else-if="data">
      <!-- 收件人构成：先说清"能发给谁、谁收不到"，避免管理员以为漏发 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">收件人</h2>
            <p class="console-section-note">
              未验证与未填邮箱的账号默认跳过：给未验证地址发信会拉高退信率，退信率一高，
              邮件服务商就会限制整个域名发信。
            </p>
          </div>
        </div>
        <div class="kv">
          <span class="kv-k">可发送</span><span class="kv-v mono">{{ data.deliverable }} 人</span>
          <span class="kv-k">未验证邮箱</span><span class="kv-v mono">{{ data.unverified }}</span>
          <span class="kv-k">未填邮箱</span><span class="kv-v mono">{{ data.withoutEmail }}</span>
          <span class="kv-k">已封禁</span><span class="kv-v mono">{{ data.banned }}</span>
        </div>
      </section>

      <!-- 撰写与发送 -->
      <section class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">撰写</h2>
            <p class="console-section-note">
              群发<b>不可撤回</b>。建议先用「平台设置 → 邮件服务」里的 SMTP 测试给自己发一封，确认能收到再群发。
              邮件末尾会自动附上站点名与站点地址。
            </p>
          </div>
        </div>

        <div class="stack">
          <div class="field">
            <label class="label" for="bc-subject">主题</label>
            <input
              id="bc-subject"
              v-model="subject"
              class="input"
              maxlength="80"
              placeholder="例如：McLink 1.0.1 已发布"
            />
          </div>
          <div class="field">
            <label class="label" for="bc-body">正文</label>
            <textarea
              id="bc-body"
              v-model="body"
              class="input"
              rows="8"
              maxlength="4000"
              placeholder="正文……"
            />
          </div>

          <p v-if="actionError" class="notice-body">{{ actionError }}</p>

          <div class="console-toolbar">
            <button class="btn btn-primary" type="button" :disabled="!canSend" @click="send">
              发送给 {{ data.deliverable }} 人
            </button>
            <button v-if="data.running" class="btn btn-ghost" type="button" @click="stop">中止</button>
          </div>
        </div>
      </section>

      <!-- 进度与上一次结果 -->
      <section v-if="report" class="console-section">
        <div class="console-section-head">
          <div class="console-section-text">
            <h2 class="console-section-title">{{ data.running ? '本次进度' : '上一次发送' }}</h2>
            <p class="console-section-note">
              {{ report.subject }} · 开始于 {{ formatDateTime(report.startedAt) }}
              <template v-if="report.finishedAt"> · 结束于 {{ formatDateTime(report.finishedAt) }}</template>
            </p>
          </div>
          <div class="console-toolbar">
            <Badge :tone="report.aborted ? 'warn' : report.failed > 0 ? 'warn' : 'ok'">
              {{ report.aborted ? '已中止' : report.failed > 0 ? '部分失败' : '完成' }}
            </Badge>
          </div>
        </div>

        <div class="kv">
          <span class="kv-k">收件</span><span class="kv-v mono">{{ report.total }}</span>
          <span class="kv-k">成功</span><span class="kv-v mono">{{ report.sent }}</span>
          <span class="kv-k">失败</span><span class="kv-v mono">{{ report.failed }}</span>
        </div>

        <div v-if="data.running" class="progress-track">
          <div class="progress-fill" :style="{ width: `${percent}%` }" />
        </div>

        <div v-if="report.errors.length > 0" class="stack">
          <p class="console-section-note">失败原因（最多显示 3 条）：</p>
          <div v-for="e in report.errors.slice(0, 3)" :key="e.to" class="mono wrap-anywhere">
            {{ e.to }}：{{ e.error }}
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* 进度线：一条细线 + 已完成的填充，不用动画/渐变（设计规则） */
.progress-track {
  height: 3px;
  border-radius: 2px;
  background: var(--ink-700);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--signal);
  transition: width var(--dur) var(--ease);
}
.wrap-anywhere {
  overflow-wrap: anywhere;
}
</style>
