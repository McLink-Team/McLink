<script setup lang="ts">
/**
 * 审计日志：按动作前缀筛选 + 分页，detail 是可展开的 JSON。
 * 动作名是 `域.操作` 形式（如 room.force_close），所以前缀筛选比关键字搜索更实用。
 */
import { computed, onMounted, ref } from 'vue';
import { Routes, type AuditEntry } from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { asArray, formatDateTime } from '../../lib/ui.ts';
import Badge from '../../components/Badge.vue';
import type { BadgeTone } from '../../lib/ui.ts';

const ACTION_PREFIXES = [
  { value: '', label: '全部' },
  { value: 'room.', label: 'room.' },
  { value: 'node.', label: 'node.' },
  { value: 'user.', label: 'user.' },
  { value: 'auth.', label: 'auth.' },
  { value: 'relay.', label: 'relay.' },
  { value: 'settings.', label: 'settings.' },
];

const entries = ref<AuditEntry[]>([]);
const total = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const action = ref('');
const limit = 50;
const page = ref(0);
const expanded = ref<Set<number>>(new Set());

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<{ rows: AuditEntry[]; total: number }>(Routes.adminAudit, {
      query: { action: action.value, limit, offset: page.value * limit },
    });
    entries.value = asArray(result.rows);
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

function setAction(value: string): void {
  if (action.value === value) return;
  action.value = value;
  page.value = 0;
  void load();
}

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / limit)));

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

function toggleDetail(id: number): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function detailJson(entry: AuditEntry): string {
  if (!entry.detail) return '（无详情）';
  try {
    return JSON.stringify(entry.detail, null, 2);
  } catch {
    return String(entry.detail);
  }
}

function actorTone(type: AuditEntry['actorType']): BadgeTone {
  switch (type) {
    case 'admin':
      return 'brand';
    case 'user':
      return 'info';
    case 'node':
      return 'neutral';
    default:
      return 'warn';
  }
}

function actorLabel(type: AuditEntry['actorType']): string {
  switch (type) {
    case 'admin':
      return '管理员';
    case 'user':
      return '用户';
    case 'node':
      return '节点';
    default:
      return '系统';
  }
}
</script>

<template>
  <div class="console-page">
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">审计日志</h1>
        <p class="console-head-sub">记录登录、房间、节点、中继与设置变更，共 {{ total }} 条。</p>
      </div>
      <div class="console-head-actions">
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
      </div>
    </header>

    <section class="console-section">
      <div class="filter-row">
        <span class="filter-key">动作前缀</span>
        <div class="seg">
          <button
            v-for="p in ACTION_PREFIXES"
            :key="p.value"
            class="seg-item"
            :class="{ active: action === p.value }"
            type="button"
            @click="setAction(p.value)"
          >
            {{ p.label }}
          </button>
        </div>
      </div>
    </section>

    <section class="console-section">
      <div v-if="loading && entries.length === 0" class="stack-tight">
        <div v-for="i in 6" :key="i" class="skeleton" style="height: 34px" />
      </div>

      <div v-else-if="error" class="console-section-head">
        <div class="console-section-text">
          <div class="console-sub-title">加载失败</div>
          <p class="console-section-note">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>

      <div v-else-if="entries.length === 0" class="empty">没有匹配的审计记录。</div>

      <template v-else>
        <div class="log-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作者类型</th>
                <th>操作者</th>
                <th>动作</th>
                <th>目标</th>
                <th>详情</th>
                <th>来源 IP</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="e in entries" :key="e.id">
                <tr>
                  <td class="mono cell-sub nowrap">{{ formatDateTime(e.ts) }}</td>
                  <td><Badge :tone="actorTone(e.actorType)">{{ actorLabel(e.actorType) }}</Badge></td>
                  <td>
                    <div v-if="e.actorName">{{ e.actorName }}</div>
                    <div v-else class="cell-void">未记录</div>
                    <div v-if="e.actorId" class="cell-sub">{{ e.actorId }}</div>
                  </td>
                  <td class="mono wrap-anywhere">{{ e.action }}</td>
                  <td>
                    <template v-if="e.targetType">
                      <div>{{ e.targetType }}</div>
                      <div v-if="e.targetId" class="cell-sub">{{ e.targetId }}</div>
                    </template>
                    <span v-else class="cell-void">无</span>
                  </td>
                  <td>
                    <button
                      v-if="e.detail"
                      class="btn btn-sm btn-ghost"
                      type="button"
                      @click="toggleDetail(e.id)"
                    >
                      {{ expanded.has(e.id) ? '收起' : '展开 JSON' }}
                    </button>
                    <span v-else class="cell-void">无</span>
                  </td>
                  <td v-if="e.ip" class="mono cell-sub">{{ e.ip }}</td>
                  <td v-else class="cell-void">未记录</td>
                </tr>
                <tr v-if="e.detail && expanded.has(e.id)">
                  <td colspan="7" class="detail-cell">
                    <pre class="code-block code-block-lg">{{ detailJson(e) }}</pre>
                  </td>
                </tr>
              </template>
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
  </div>
</template>

<style scoped>
.filter-row {
  display: flex;
  align-items: center;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.filter-key {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  letter-spacing: 0.02em;
}
.log-scroll {
  overflow-x: auto;
  max-width: 100%;
}
/* 空值占位：用小一号的弱化文字，不用破折号堆满整列 */
.cell-void {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
}
.detail-cell {
  background: var(--ink-850);
  padding: var(--s-2) var(--s-3) var(--s-4);
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
</style>
