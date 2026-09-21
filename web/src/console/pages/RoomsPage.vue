<script setup lang="ts">
/**
 * 房间管理：全量房间列表 + 单房间详情（成员 / 密钥 / ACL / 访问日志）。
 * 强制关闭与 ACL 重算都属于影响面较大的操作，一律二次确认。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import {
  Routes,
  formatBitrate,
  formatBytes,
  formatRelativeTime,
  regionLabel,
  type Room,
  type RoomMember,
} from '@mclink/shared';
import { api, friendlyError } from '../../lib/api.ts';
import { accessLabel, asArray, asStringList, copyText, formatDateTime, memberLabel, memberTone, roomLabel, roomTone } from '../../lib/ui.ts';
import { notifyOk, notifyWarn } from '../../lib/toast.ts';
import Badge from '../../components/Badge.vue';

interface RoomUsage {
  rxBytes: number;
  txBytes: number;
  peers: number;
}

interface RoomWithUsage extends Room {
  usage: RoomUsage;
}

interface AccessLogEntry {
  ts: string;
  user_id: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
}

interface RoomDetail {
  room: Room;
  members: RoomMember[];
  networkSecret: string;
  usage: RoomUsage;
  accessLog: AccessLogEntry[];
  aclToml: string;
}

const rooms = ref<RoomWithUsage[]>([]);
const total = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const limit = 20;
const page = ref(0);

const filters = reactive({ status: '', search: '' });

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<{ rooms: RoomWithUsage[]; total: number }>(Routes.adminRooms, {
      query: {
        status: filters.status,
        search: filters.search.trim(),
        limit,
        offset: page.value * limit,
      },
    });
    rooms.value = asArray(result.rooms);
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

/* ------------------------------------------------------------- 详情 */

const detail = ref<RoomDetail | null>(null);
const detailId = ref<string | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const secretVisible = ref(false);

async function openDetail(roomId: string): Promise<void> {
  detailId.value = roomId;
  detail.value = null;
  detailError.value = null;
  detailLoading.value = true;
  secretVisible.value = false;
  try {
    detail.value = await api.get<RoomDetail>(Routes.adminRoom(roomId));
    if (detail.value) {
      // 成员/日志等数组字段做一次归一化，避免旧版主控缺字段时整页渲染失败
      detail.value = {
        ...detail.value,
        members: asArray(detail.value.members),
        accessLog: asArray(detail.value.accessLog),
      };
    }
  } catch (err) {
    detailError.value = friendlyError(err);
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail(): void {
  detailId.value = null;
  detail.value = null;
  detailError.value = null;
}

const displayedSecret = computed(() => {
  const secret = detail.value?.networkSecret;
  if (!secret) return '—';
  return secretVisible.value ? secret : '•'.repeat(Math.min(secret.length, 32));
});

/* ------------------------------------------------------------- 操作 */

const busy = ref(false);

async function forceClose(room: Room): Promise<void> {
  if (!confirm(`确定强制关闭房间「${room.name}」(${room.code})？所有在线玩家会被断开。`)) return;
  busy.value = true;
  try {
    await api.del(Routes.adminRoom(room.id));
    notifyOk('房间已强制关闭');
    closeDetail();
    await load();
  } catch (err) {
    notifyWarn(friendlyError(err));
  } finally {
    busy.value = false;
  }
}

async function recomputeAcl(): Promise<void> {
  if (!confirm('确定按当前策略重算所有开放房间的 ACL？房主客户端会在下次心跳后重新应用 ACL。')) return;
  busy.value = true;
  try {
    const result = await api.post<{ ok: boolean; count: number }>('/admin/rooms/recompute-acl');
    notifyOk(`已重算 ${result.count} 个房间的 ACL`);
  } catch (err) {
    notifyWarn(friendlyError(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="stack" style="gap: var(--s-5)">
    <div class="row-between wrap">
      <div>
        <div class="panel-title">房间管理</div>
        <p class="panel-sub">共 {{ total }} 个房间。点击任意一行查看成员、网络密钥、ACL 与访问日志。</p>
      </div>
      <div class="row">
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
        <button class="btn btn-danger" type="button" :disabled="busy" @click="recomputeAcl">一键重算 ACL</button>
      </div>
    </div>

    <section class="card filters">
      <div class="field">
        <label class="label" for="r-status">状态</label>
        <select id="r-status" v-model="filters.status" class="select" @change="applyFilters">
          <option value="">全部状态</option>
          <option value="open">开放中</option>
          <option value="closed">已关闭</option>
          <option value="expired">已过期</option>
        </select>
      </div>
      <div class="field grow">
        <label class="label" for="r-search">搜索</label>
        <input
          id="r-search"
          v-model="filters.search"
          class="input"
          type="search"
          placeholder="房间名 / 加入码 / 房主显示名"
          @keyup.enter="applyFilters"
        />
      </div>
      <div class="row" style="align-self: end">
        <button class="btn" type="button" @click="applyFilters">应用筛选</button>
      </div>
    </section>

    <section class="card stack">
      <div v-if="loading && rooms.length === 0" class="stack">
        <div v-for="i in 5" :key="i" class="skeleton" style="height: 40px" />
      </div>

      <div v-else-if="error" class="row-between">
        <div>
          <div class="panel-title" style="font-size: var(--fs-base)">加载失败</div>
          <p class="panel-sub">{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="load">重试</button>
      </div>

      <div v-else-if="rooms.length === 0" class="empty">没有匹配的房间。</div>

      <template v-else>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>房间</th>
                <th>加入码</th>
                <th>房主</th>
                <th>区域</th>
                <th>状态</th>
                <th class="table-num">在线人数</th>
                <th>虚拟网段</th>
                <th class="table-num">累计流量</th>
                <th>创建时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rooms" :key="r.id" class="clickable" @click="openDetail(r.id)">
                <td>
                  <div class="truncate" style="max-width: 200px">{{ r.name }}</div>
                  <div class="faint mono" style="font-size: var(--fs-xs)">{{ r.id }}</div>
                </td>
                <td class="mono">{{ r.code }}</td>
                <td class="truncate" style="max-width: 130px">{{ r.hostDisplayName }}</td>
                <td>{{ regionLabel(r.zone) }}</td>
                <td>
                  <Badge :tone="roomTone(r.status)" dot>{{ roomLabel(r.status) }}</Badge>
                  <div class="faint" style="font-size: var(--fs-xs); margin-top: 2px">{{ accessLabel(r.access) }}</div>
                </td>
                <td class="table-num">{{ r.onlineMembers }} / {{ r.policy.maxPlayers }}</td>
                <td class="mono">{{ r.subnet }}</td>
                <td class="table-num">
                  {{ formatBytes(r.usage.rxBytes + r.usage.txBytes) }}
                  <div class="faint" style="font-size: var(--fs-xs)">
                    收 {{ formatBytes(r.usage.rxBytes) }} · 发 {{ formatBytes(r.usage.txBytes) }}
                  </div>
                </td>
                <td class="muted" style="font-size: var(--fs-xs)">
                  {{ formatRelativeTime(r.createdAt) }}
                  <div v-if="r.expiresAt" class="faint">至 {{ formatDateTime(r.expiresAt) }}</div>
                </td>
                <td style="text-align: right">
                  <button class="btn btn-sm" type="button" @click.stop="openDetail(r.id)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="row-between">
          <span class="faint" style="font-size: var(--fs-xs)">
            第 {{ page + 1 }} / {{ pageCount }} 页 · 共 {{ total }} 条
          </span>
          <div class="row">
            <button class="btn btn-sm" type="button" :disabled="page === 0 || loading" @click="prevPage">上一页</button>
            <button class="btn btn-sm" type="button" :disabled="page + 1 >= pageCount || loading" @click="nextPage">
              下一页
            </button>
          </div>
        </div>
      </template>
    </section>

    <!-- 详情抽屉 -->
    <div v-if="detailId" class="overlay" @click.self="closeDetail">
      <div class="drawer card stack">
        <div class="row-between">
          <div>
            <div class="panel-title">{{ detail?.room.name ?? '房间详情' }}</div>
            <p class="panel-sub mono">{{ detailId }}</p>
          </div>
          <div class="row">
            <button
              v-if="detail"
              class="btn btn-sm btn-danger"
              type="button"
              :disabled="busy || detail.room.status !== 'open'"
              @click="forceClose(detail.room)"
            >
              强制关闭
            </button>
            <button class="btn btn-sm btn-ghost" type="button" @click="closeDetail">关闭</button>
          </div>
        </div>

        <div v-if="detailLoading" class="stack">
          <div v-for="i in 4" :key="i" class="skeleton" style="height: 36px" />
        </div>

        <div v-else-if="detailError" class="row-between">
          <span class="panel-sub">{{ detailError }}</span>
          <button class="btn btn-sm" type="button" @click="detailId && openDetail(detailId)">重试</button>
        </div>

        <template v-else-if="detail">
          <!-- 概要 -->
          <div class="kv">
            <span class="kv-k">加入码</span><span class="kv-v mono">{{ detail.room.code }}</span>
            <span class="kv-k">状态</span>
            <span class="kv-v">
              <Badge :tone="roomTone(detail.room.status)" dot>{{ roomLabel(detail.room.status) }}</Badge>
              <Badge tone="neutral">{{ accessLabel(detail.room.access) }}</Badge>
              <Badge tone="neutral">{{ detail.room.visibility === 'public' ? '大厅可见' : '仅凭加入码' }}</Badge>
            </span>
            <span class="kv-k">房主</span>
            <span class="kv-v">{{ detail.room.hostDisplayName }} <span class="faint mono">{{ detail.room.hostUserId }}</span></span>
            <span class="kv-k">区域</span><span class="kv-v">{{ regionLabel(detail.room.zone) }}</span>
            <span class="kv-k">虚拟网段</span><span class="kv-v mono">{{ detail.room.subnet }}（槽位 {{ detail.room.subnetSlot }}）</span>
            <span class="kv-k">EasyTier 网络</span><span class="kv-v mono truncate" :title="detail.room.networkName">{{ detail.room.networkName }}</span>
            <span class="kv-k">中继节点</span>
            <span class="kv-v mono">
              {{ asStringList(detail.room.relayNodeIds).length > 0 ? asStringList(detail.room.relayNodeIds).join(', ') : '仅主控兜底中继' }}
            </span>
            <span class="kv-k">累计流量</span>
            <span class="kv-v">
              收 {{ formatBytes(detail.usage.rxBytes) }} / 发 {{ formatBytes(detail.usage.txBytes) }} ·
              {{ detail.usage.peers }} peers
            </span>
            <span class="kv-k">限速</span>
            <span class="kv-v">
              房间上限
              {{ detail.room.policy.maxBandwidthKbps > 0 ? formatBitrate(detail.room.policy.maxBandwidthKbps * 1000) : '不限' }}
              · 单成员
              {{ detail.room.policy.perMemberKbps > 0 ? formatBitrate(detail.room.policy.perMemberKbps * 1000) : '不限' }}
              · 包速率
              {{ detail.room.policy.rateLimitPps > 0 ? `${detail.room.policy.rateLimitPps} pps` : '不限' }}
            </span>
            <span class="kv-k">策略</span>
            <span class="kv-v">
              最多 {{ detail.room.policy.maxPlayers }} 人 ·
              {{ detail.room.policy.allowP2p ? '允许 P2P' : '全部走中继' }} ·
              {{ detail.room.policy.strictPorts ? '严格端口' : '宽松端口' }} ·
              端口 {{ asStringList(detail.room.policy.allowedPorts).length > 0 ? asStringList(detail.room.policy.allowedPorts).join(', ') : '不限' }}
            </span>
            <span class="kv-k">创建时间</span><span class="kv-v">{{ formatDateTime(detail.room.createdAt) }}</span>
          </div>

          <!-- 网络密钥 -->
          <div class="secret-box">
            <div class="row-between">
              <span class="label">networkSecret</span>
              <div class="row" style="gap: var(--s-2)">
                <button class="btn btn-sm btn-ghost" type="button" @click="secretVisible = !secretVisible">
                  {{ secretVisible ? '隐藏' : '显示' }}
                </button>
                <button class="btn btn-sm" type="button" @click="copyText(detail.networkSecret, '网络密钥')">复制</button>
              </div>
            </div>
            <div class="mono secret-text">{{ displayedSecret }}</div>
            <p class="hint">
              网络名由该密钥派生，是共享中继下的准入凭证：密钥泄露等于房间可被任意扫描到，必要时让房主轮换密钥。
            </p>
          </div>

          <!-- 成员 -->
          <div class="section-title">成员（{{ detail.members.length }}）</div>
          <div v-if="detail.members.length === 0" class="empty">暂无成员记录。</div>
          <div v-else class="table-wrap" style="max-height: 280px; overflow-y: auto">
            <table class="table">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>虚拟 IP</th>
                  <th>设备</th>
                  <th class="table-num">延迟</th>
                  <th class="table-num">收发</th>
                  <th>加入时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in detail.members" :key="m.userId">
                  <td>
                    <div>{{ m.displayName }}</div>
                    <div class="faint mono" style="font-size: var(--fs-xs)">{{ m.username }}</div>
                  </td>
                  <td>
                    <Badge :tone="m.role === 'host' ? 'brand' : 'neutral'">{{ m.role === 'host' ? '房主' : '成员' }}</Badge>
                  </td>
                  <td><Badge :tone="memberTone(m.status)">{{ memberLabel(m.status) }}</Badge></td>
                  <td class="mono" style="font-size: var(--fs-xs)">{{ m.virtualIp ?? '—' }}</td>
                  <td class="muted" style="font-size: var(--fs-xs)">{{ m.deviceName ?? '—' }}</td>
                  <td class="table-num">
                    {{ m.latencyMs === null ? '—' : `${m.latencyMs} ms` }}
                    <div v-if="m.p2p" class="faint" style="font-size: var(--fs-xs)">P2P</div>
                  </td>
                  <td class="table-num" style="font-size: var(--fs-xs)">
                    {{ formatBitrate(m.rxBps) }} / {{ formatBitrate(m.txBps) }}
                  </td>
                  <td class="muted" style="font-size: var(--fs-xs)">
                    {{ formatRelativeTime(m.joinedAt) }}
                    <div class="faint">心跳 {{ formatRelativeTime(m.lastSeenAt) }}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- ACL -->
          <div class="row-between">
            <div class="section-title">房主 ACL（TOML）</div>
            <button class="btn btn-sm" type="button" @click="copyText(detail.aclToml, 'ACL 文本')">复制</button>
          </div>
          <pre class="code-block">{{ detail.aclToml || '（房间无 ACL 内容）' }}</pre>

          <!-- 访问日志 -->
          <div class="section-title">访问日志（最近 {{ detail.accessLog.length }} 条）</div>
          <div v-if="detail.accessLog.length === 0" class="empty">暂无访问记录。</div>
          <div v-else class="table-wrap" style="max-height: 240px; overflow-y: auto">
            <table class="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>动作</th>
                  <th>用户</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(l, i) in detail.accessLog" :key="i">
                  <td class="muted" style="font-size: var(--fs-xs)">{{ formatDateTime(l.ts) }}</td>
                  <td class="mono">{{ l.action }}</td>
                  <td class="mono" style="font-size: var(--fs-xs)">{{ l.user_id ?? '—' }}</td>
                  <td class="muted" style="font-size: var(--fs-xs)">{{ l.detail ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) auto;
  gap: var(--s-4);
  align-items: end;
}
.table-wrap {
  overflow-x: auto;
}
.clickable {
  cursor: pointer;
}
.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: color-mix(in srgb, var(--bg-0) 68%, transparent);
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: min(880px, 100%);
  height: 100%;
  border-radius: 0;
  border-right: 0;
  background: var(--bg-1);
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
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
.secret-box {
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.secret-text {
  word-break: break-all;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.section-title {
  font-size: var(--fs-sm);
  font-weight: 620;
  color: var(--text-dim);
  margin-top: var(--s-2);
}
.code-block {
  margin: 0;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--bg-0) 60%, transparent);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: var(--fs-xs);
  max-height: 260px;
  overflow: auto;
  white-space: pre;
}
@media (max-width: 720px) {
  .filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
