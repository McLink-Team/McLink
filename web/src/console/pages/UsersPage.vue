<script setup lang="ts">
/**
 * 用户管理：配额、房间数上限、角色与封禁。
 * 后端会拒绝「封禁自己」「撤销自己的管理员」，前端同样把按钮禁掉，避免无谓的失败请求。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { Routes, formatBytes, formatRelativeTime, type UserSelf } from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { formatDateTime, asArray, reportError, toFloat, toInt } from '../../lib/ui.ts';
import { notifyOk } from '../../lib/toast.ts';
import { currentUser } from '../../lib/session.ts';
import Badge from '../../components/Badge.vue';

interface AdminUser extends UserSelf {
  hostedRooms: number;
}

const users = ref<AdminUser[]>([]);
const total = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const limit = 20;
const page = ref(0);
const busyId = ref<string | null>(null);

const filters = reactive({ search: '' });

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<{ users: AdminUser[]; total: number }>(Routes.adminUsers, {
      query: { search: filters.search.trim(), limit, offset: page.value * limit },
    });
    users.value = asArray(result.users);
    total.value = result.total;
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

function applyFilters(): void {
  page.value = 0;
  void load();
}

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / limit)));
const myId = computed(() => currentUser.value?.id ?? null);

function prevPage(): void {
  if (page.value === 0) return;
  page.value -= 1;
  void load();
}

function nextPage(): void {
  if (page.value + 1 >= pageCount.value) return;
  page.value += 1;
  void load();
}

function isSelf(user: AdminUser): boolean {
  return myId.value !== null && user.id === myId.value;
}

/* ------------------------------------------------------------- 单字段操作 */

async function patchUser(user: AdminUser, patch: Record<string, unknown>, successText: string): Promise<void> {
  busyId.value = user.id;
  try {
    await api.patch<UserSelf>(Routes.adminUser(user.id), patch);
    notifyOk(successText);
    await load();
  } catch (err) {
    reportError(err);
  } finally {
    busyId.value = null;
  }
}

async function toggleBanned(user: AdminUser): Promise<void> {
  const next = !user.banned;
  const text = next
    ? `确定封禁用户「${user.displayName}」？其所有会话会立即失效。`
    : `确定解封用户「${user.displayName}」？`;
  if (!confirm(text)) return;
  await patchUser(user, { banned: next }, next ? '用户已封禁' : '用户已解封');
}

async function toggleRole(user: AdminUser): Promise<void> {
  const next = user.role === 'admin' ? 'user' : 'admin';
  const text = next === 'admin' ? `确定将「${user.displayName}」设为管理员？` : `确定撤销「${user.displayName}」的管理员权限？`;
  if (!confirm(text)) return;
  await patchUser(user, { role: next }, next === 'admin' ? '已设为管理员' : '已撤销管理员');
}

async function resetUsage(user: AdminUser): Promise<void> {
  if (!confirm(`确定重置「${user.displayName}」的本周期已用流量？该操作不可撤销。`)) return;
  await patchUser(user, { resetUsage: true }, '已重置已用流量');
}

/* --------------------------------------------------------- 配额弹窗 */

const editing = ref<AdminUser | null>(null);
const saving = ref(false);
const editError = ref<string | null>(null);
const quotaForm = reactive({ unlimited: true, quotaGb: '100', maxRooms: '', useDefaultMaxRooms: true });

function openQuota(user: AdminUser): void {
  editing.value = user;
  editError.value = null;
  quotaForm.unlimited = user.quotaBytes === null;
  quotaForm.quotaGb = user.quotaBytes === null ? '100' : (user.quotaBytes / 1024 ** 3).toFixed(2);
  quotaForm.useDefaultMaxRooms = user.maxRooms === null;
  quotaForm.maxRooms = user.maxRooms === null ? '3' : String(user.maxRooms);
}

async function saveQuota(): Promise<void> {
  const user = editing.value;
  if (!user || saving.value) return;
  saving.value = true;
  try {
    const quotaBytes = quotaForm.unlimited ? null : Math.max(0, Math.round(toFloat(quotaForm.quotaGb, 0) * 1024 ** 3));
    const maxRooms = quotaForm.useDefaultMaxRooms ? null : Math.max(0, toInt(quotaForm.maxRooms, 0));
    await api.patch<UserSelf>(Routes.adminUser(user.id), { quotaBytes, maxRooms });
    notifyOk('配额已更新');
    editing.value = null;
    await load();
  } catch (err) {
    editError.value = reportError(err);
  } finally {
    saving.value = false;
  }
}

/** 已用 / 配额 的百分比；不限时返回 null */
function usagePercent(user: AdminUser): number | null {
  if (user.quotaBytes === null || user.quotaBytes <= 0) return null;
  return Math.min(100, (user.usedBytes / user.quotaBytes) * 100);
}
</script>

<template>
  <div class="console-page">
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">用户管理</h1>
        <p class="console-head-sub">共 {{ total }} 个账号。配额按自然月计算，重置已用流量不影响其它设置。</p>
      </div>
      <div class="console-head-actions">
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
      </div>
    </header>

    <section class="console-section">
      <div class="filter-bar">
        <div class="field grow">
          <label class="label" for="u-search">搜索</label>
          <input
            id="u-search"
            v-model="filters.search"
            class="input"
            type="search"
            placeholder="用户名 / 显示名 / 邮箱"
            @keyup.enter="applyFilters"
          />
        </div>
        <button class="btn filter-submit" type="button" @click="applyFilters">搜索</button>
      </div>
    </section>

    <section class="console-section">
      <div v-if="loading && users.length === 0" class="stack-tight">
        <div v-for="i in 5" :key="i" class="skeleton" style="height: 36px" />
      </div>

      <div v-else-if="error" class="console-section-head">
        <div class="console-section-text">
          <div class="console-sub-title">加载失败</div>
          <p class="console-section-note">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>

      <div v-else-if="users.length === 0" class="empty">没有匹配的用户。</div>

      <template v-else>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>用户名</th>
                <!--
                  邮箱必须在这里看得到：玩家报问题时给的就是邮箱，公告能发到谁
                  也取决于「有没有绑 + 验没验」。只显示用户名的话，管理员还得去翻库。
                -->
                <th>邮箱</th>
                <th>显示名</th>
                <th>角色</th>
                <th>状态</th>
                <th>月度配额</th>
                <th class="table-num">已用流量</th>
                <th class="table-num">房间</th>
                <th>注册时间</th>
                <th class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td>
                  <div class="mono nowrap">{{ u.username }}</div>
                  <div class="cell-sub nowrap">{{ u.id }}</div>
                </td>
                <td>
                  <template v-if="u.email">
                    <div class="mono cell-mail truncate" :title="u.email">{{ u.email }}</div>
                    <div class="cell-sub">
                      <Badge :tone="u.emailVerified ? 'ok' : 'warn'">{{ u.emailVerified ? '已验证' : '未验证' }}</Badge>
                    </div>
                  </template>
                  <span v-else class="cell-void nowrap">未绑定</span>
                </td>
                <td>
                  <div class="name-line">
                    <span>{{ u.displayName }}</span>
                    <Badge v-if="isSelf(u)" tone="info">我</Badge>
                  </div>
                </td>
                <td>
                  <Badge :tone="u.role === 'admin' ? 'brand' : 'neutral'">{{ u.role === 'admin' ? '管理员' : '玩家' }}</Badge>
                </td>
                <td>
                  <Badge :tone="u.banned ? 'danger' : 'ok'" dot>{{ u.banned ? '已封禁' : '正常' }}</Badge>
                </td>
                <td>
                  <div class="mono quota-line nowrap">{{ u.quotaBytes === null ? '不限' : formatBytes(u.quotaBytes) }}</div>
                  <div class="cell-sub nowrap">最多房间 {{ u.maxRooms === null ? '平台默认' : u.maxRooms }}</div>
                </td>
                <td class="table-num">
                  <div class="mono">{{ formatBytes(u.usedBytes) }}</div>
                  <div v-if="usagePercent(u) !== null" class="bar" :title="`${usagePercent(u)?.toFixed(1)}%`">
                    <span class="bar-fill" :style="{ width: `${usagePercent(u)}%` }" />
                  </div>
                </td>
                <td class="table-num">{{ u.hostedRooms }}</td>
                <td class="cell-sub nowrap">{{ formatDateTime(u.createdAt) }}</td>
                <td>
                  <div class="row-actions">
                    <button class="btn btn-sm" type="button" :disabled="busyId === u.id" @click="openQuota(u)">配额</button>
                    <button
                      class="btn btn-sm"
                      type="button"
                      :disabled="busyId === u.id || isSelf(u)"
                      :title="isSelf(u) ? '不能撤销自己的管理员权限' : ''"
                      @click="toggleRole(u)"
                    >
                      {{ u.role === 'admin' ? '撤销管理员' : '设为管理员' }}
                    </button>
                    <button class="btn btn-sm" type="button" :disabled="busyId === u.id" @click="resetUsage(u)">
                      重置流量
                    </button>
                    <button
                      class="btn btn-sm"
                      :class="u.banned ? '' : 'btn-danger'"
                      type="button"
                      :disabled="busyId === u.id || isSelf(u)"
                      :title="isSelf(u) ? '不能封禁自己' : ''"
                      @click="toggleBanned(u)"
                    >
                      {{ u.banned ? '解封' : '封禁' }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pager">
          <span class="pager-count">第 {{ page + 1 }} / {{ pageCount }} 页 · 共 {{ total }} 条</span>
          <div class="console-toolbar">
            <button class="btn btn-sm" type="button" :disabled="page === 0 || loading" @click="prevPage">上一页</button>
            <button class="btn btn-sm" type="button" :disabled="page + 1 >= pageCount || loading" @click="nextPage">
              下一页
            </button>
          </div>
        </div>
      </template>
    </section>

    <!-- 配额弹窗 -->
    <div v-if="editing" class="modal-mask" @click.self="editing = null">
      <div class="modal-panel quota-panel">
        <div class="modal-head">
          <div class="console-section-text">
            <h2 class="console-sub-title modal-title">配额与房间数</h2>
            <p class="console-section-note">{{ editing.displayName }} · {{ editing.username }}</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" @click="editing = null">关闭</button>
        </div>

        <label class="switch">
          <input v-model="quotaForm.unlimited" type="checkbox" />
          <span>不限制月度流量配额</span>
        </label>

        <div v-if="!quotaForm.unlimited" class="field">
          <label class="label" for="q-gb">月度配额（GB）</label>
          <input id="q-gb" v-model="quotaForm.quotaGb" class="input" type="number" min="0" step="0.5" />
          <span class="hint">
            当前：{{ editing.quotaBytes === null ? '不限' : formatBytes(editing.quotaBytes) }} ·
            已用 {{ formatBytes(editing.usedBytes) }}
          </span>
        </div>

        <label class="switch">
          <input v-model="quotaForm.useDefaultMaxRooms" type="checkbox" />
          <span>同时可创建的房间数使用平台默认</span>
        </label>

        <div v-if="!quotaForm.useDefaultMaxRooms" class="field">
          <label class="label" for="q-rooms">最大同时房间数</label>
          <input id="q-rooms" v-model="quotaForm.maxRooms" class="input" type="number" min="0" max="999" />
          <span class="hint">0 表示禁止创建房间。</span>
        </div>

        <div v-if="editError" class="notice notice-danger">{{ editError }}</div>

        <div class="modal-foot">
          <button class="btn" type="button" @click="editing = null">取消</button>
          <button class="btn btn-primary" type="button" :disabled="saving" @click="saveQuota">
            <span v-if="saving" class="spinner" />
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--s-4);
  align-items: end;
}
.filter-submit {
  margin-bottom: 1px;
}
.name-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.quota-line {
  font-size: var(--fs-sm);
}
/**
 * 邮箱列。
 *
 * 加了这一列之后表格共 10 列，实测 1168px 内容宽时其它列会被挤到换行
 * （用户 id 折成两行、"未绑定"折成"未绑/定"）。地址长了给省略号、
 * 全量在 title 里，列宽就有上限了。
 */
.cell-mail {
  max-width: 14rem;
  font-size: var(--fs-sm);
}
.col-actions {
  text-align: right;
}
.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
  margin-top: var(--s-4);
  padding-top: var(--s-3);
  border-top: 1px solid var(--rule-faint);
}
.pager-count {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.quota-panel {
  max-width: 460px;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
  padding-bottom: var(--s-3);
  border-bottom: 1px solid var(--rule-faint);
}
.modal-title {
  font-family: var(--font-display);
  font-size: var(--fs-lg);
  font-weight: 600;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  padding-top: var(--s-4);
  border-top: 1px solid var(--rule-faint);
}
</style>
