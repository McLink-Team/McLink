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
import { Routes, type BroadcastAudience } from '@mclink/shared';
import { formatDateTime } from '../../lib/ui.ts';
import { api, friendlyError } from '../../lib/api.ts';
import { notifyOk, notifyWarn } from '../../lib/toast.ts';
import Badge from '../../components/Badge.vue';

interface BroadcastReport {
  id: string;
  subject: string;
  /** 本次的收件人筛选（界面用来回显"那封信发给了谁"） */
  audience?: BroadcastAudience;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  sent: number;
  failed: number;
  errors: Array<{ to: string; error: string }>;
  aborted: boolean;
}

interface BroadcastPreview {
  /** 全平台可发送（不套筛选） */
  deliverable: number;
  unverified: number;
  banned: number;
  withoutEmail: number;
  /** 点过邮件里退订链接的人数 */
  optedOut: number;
  /** 当前筛选条件下的收件人数（按钮上的"发送给 N 人"用它） */
  selected: number;
  /** 手填名单里库里没有的名字 */
  missingUsernames: string[];
  /** 手填名单里存在但不满足发送条件的名字 */
  undeliverableUsernames: string[];
  audience: BroadcastAudience;
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

/* ------------------------------------------------------------ 收件人筛选 */

const roles = ref<'all' | 'admin' | 'user'>('all');
/** '' = 不限；否则是"最近 N 天活跃过" */
const activeDays = ref('');
const usernamesText = ref('');
const manualMode = computed(() => usernamesText.value.trim().length > 0);

/** 把筛选拼成查询串（服务端按它算 selected） */
function audienceQuery(): Record<string, string> {
  const query: Record<string, string> = { roles: roles.value };
  if (activeDays.value !== '') query.activeDays = activeDays.value;
  if (manualMode.value) query.usernames = usernamesText.value.trim();
  return query;
}

/**
 * 筛选改动后延时重算。
 *
 * 不做"点应用才生效"：管理员改的是筛选，期待立刻看到人数变化；
 * 但每敲一个字就打一次接口也没必要，所以 400ms 防抖。
 */
let filterTimer: number | null = null;
function applyFilter(): void {
  if (filterTimer !== null) window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    filterTimer = null;
    void load();
  }, 400);
}

/** 把筛选条件说成一句人话（进度区回显上一次的目标用） */
function audienceLabel(a: BroadcastAudience | undefined): string {
  if (!a) return '全部可发送用户';
  if (a.usernames.length > 0) return `指定名单（${a.usernames.length} 个用户名）`;
  const parts = [a.roles === 'admin' ? '仅管理员' : a.roles === 'user' ? '仅普通用户' : '全部用户'];
  if (a.activeWithinDays !== null) parts.push(`最近 ${a.activeWithinDays} 天活跃`);
  return parts.join(' · ');
}

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
    data.value = await api.get<BroadcastPreview>(Routes.adminBroadcast, { query: audienceQuery() });
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
    // 筛选条件跟着发过去：页面上看到多少人就发给多少人，不在服务端重算另一套
    await api.post(Routes.adminBroadcast, {
      subject: subject.value,
      body: body.value,
      roles: roles.value,
      activeDays: activeDays.value === '' ? null : Number(activeDays.value),
      usernames: manualMode.value ? usernamesText.value.trim() : '',
    });
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
onUnmounted(() => {
  stopPolling();
  if (filterTimer !== null) window.clearTimeout(filterTimer);
});

const report = computed(() => data.value?.lastRun ?? null);
const canSend = computed(
  () => !busy.value && data.value !== null && !data.value.running && data.value.selected > 0,
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
          给<b>已验证邮箱且未封禁</b>的用户发一封公告，可以按角色 / 活跃度 / 指定名单挑人。
          发送在后台分批进行（每批 5 封、批间 1.2 秒，避免被 SMTP 服务商限流），
          这个页面只负责登记与查看进度。
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
              未验证、未填邮箱与<b>已退订</b>的账号都会跳过：给未验证地址发信会拉高退信率，
              退信率一高邮件服务商就会限制整个域名发信。每封信的尾部会自动附上
              该收件人专属的退订链接（点开即退订，不需要登录）。
            </p>
          </div>
        </div>
        <div class="kv">
          <span class="kv-k">本次收件人</span><span class="kv-v mono">{{ data.selected }} 人</span>
          <span class="kv-k">全平台可发送</span><span class="kv-v mono">{{ data.deliverable }} 人</span>
          <span class="kv-k">未验证邮箱</span><span class="kv-v mono">{{ data.unverified }}</span>
          <span class="kv-k">未填邮箱</span><span class="kv-v mono">{{ data.withoutEmail }}</span>
          <span class="kv-k">已封禁</span><span class="kv-v mono">{{ data.banned }}</span>
          <span class="kv-k">已退订</span><span class="kv-v mono">{{ data.optedOut }}</span>
        </div>

        <!--
          筛选：角色 + 活跃度，或者直接手填名单。
          手填时前两个条件被忽略（服务端与这里保持一致），所以把它们置灰 ——
          否则"我明明只选了管理员，为什么发给了名单上的人"是必然的困惑。
        -->
        <div class="filter-bar">
          <div class="field">
            <label class="label" for="bc-roles">角色</label>
            <select id="bc-roles" v-model="roles" class="input" :disabled="manualMode" @change="applyFilter">
              <option value="all">全部</option>
              <option value="user">仅普通用户</option>
              <option value="admin">仅管理员</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="bc-active">活跃度</label>
            <select id="bc-active" v-model="activeDays" class="input" :disabled="manualMode" @change="applyFilter">
              <option value="">不限</option>
              <option value="7">最近 7 天活跃过</option>
              <option value="30">最近 30 天活跃过</option>
              <option value="90">最近 90 天活跃过</option>
              <option value="180">最近 180 天活跃过</option>
            </select>
          </div>
          <div class="field grow">
            <label class="label" for="bc-names">手填用户名（可选）</label>
            <input
              id="bc-names"
              v-model="usernamesText"
              class="input"
              placeholder="逗号 / 空格 / 换行分隔；填了它就只发给这些人"
              @input="applyFilter"
            />
          </div>
        </div>
        <p v-if="manualMode" class="console-section-note">
          已启用指定名单：角色与活跃度不再参与筛选，只发给名单中存在的账号。
        </p>

        <div v-if="data.missingUsernames.length > 0" class="notice notice-warn broadcast-warn">
          <Badge tone="warn">没用上</Badge>
          <span class="notice-body">这些用户名在库里不存在：{{ data.missingUsernames.join('、') }}</span>
        </div>
        <div v-if="data.undeliverableUsernames.length > 0" class="notice notice-warn broadcast-warn">
          <Badge tone="warn">跳过</Badge>
          <span class="notice-body">
            这些账号不满足发送条件（邮箱未验证 / 已封禁 / 已退订）：{{ data.undeliverableUsernames.join('、') }}
          </span>
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
              placeholder="例如：McLink 1.0.4 已发布"
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
              发送给 {{ data.selected }} 人
            </button>
            <button v-if="data.running" class="btn btn-ghost" type="button" @click="stop">中止</button>
          </div>
          <p v-if="data.selected === 0 && !data.running" class="console-section-note">
            当前筛选下没有可发送的收件人 —— 换个条件，或确认这些账号是否都已验证邮箱。
          </p>
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
              <template v-if="report.audience"> · 目标：{{ audienceLabel(report.audience) }}</template>
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
          <!--
            地址与原因分两行：拼成一行时"地址：原因"能长到 80+ 字符，
            一行塞满整屏宽度反而不易读（设计检测器的 line-length 规则也会报）。
          -->
          <div v-for="e in report.errors.slice(0, 3)" :key="e.to" class="broadcast-error">
            <div class="mono wrap-anywhere">{{ e.to }}</div>
            <div class="cell-sub wrap-anywhere">{{ e.error }}</div>
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
/* 名单类提示（有名字没用上/被跳过）与上方区块贴紧一点 */
.broadcast-warn {
  margin-top: var(--s-3);
}
/**
 * 筛选布局：两个短下拉 + 一个可伸缩的名单输入。
 * 不套 UsersPage 那套两列 grid（那是"搜索框 + 按钮"），也不让下拉铺满整行 ——
 * 里面就一个短词，铺满看起来像坏了。窄屏退回单列堆叠。
 */
.filter-bar {
  display: grid;
  grid-template-columns: minmax(8rem, 12rem) minmax(9rem, 13rem) minmax(0, 1fr);
  gap: var(--s-4);
  align-items: end;
}
@media (max-width: 900px) {
  .filter-bar {
    grid-template-columns: 1fr;
  }
}
/* 失败原因：地址一行、原因一行，块之间留一点缝 */
.broadcast-error + .broadcast-error {
  margin-top: var(--s-2);
}
</style>
