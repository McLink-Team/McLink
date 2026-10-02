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
  /** 建房时锁定的中继名单（带名字与槽位角色；服务端老版本可能没有这个字段） */
  scheduledRelays?: Array<{
    id: string;
    name: string | null;
    region: string | null;
    status: string | null;
    exists: boolean;
    /** 槽 1 = 打洞节点（不承载数据），槽 2 = 中继节点（真正转发房间流量） */
    role?: 'punch' | 'relay';
    assistOnly?: boolean;
  }>;
  /** 此刻真正在承载这个房间的节点（带名字） */
  relayNodes?: Array<{ id: string; name: string; region: string | null; scheduled: boolean }>;
}

/**
 * 成员票据里那台中继的名字（房主 = 整个集合，成员 = 分到的那一台）。
 *
 * 数据来自 `room_members.relay_node_id`（V25 迁移起落库，见 docs/relay-assignment.md）：
 * 它是**这名成员真正连的那台**，排障时比"房间的调度名单"更直接 ——
 * 用户实测问过"成员到底连了哪台"，答案就在这一列。
 * 名字从 `scheduledRelays` 里取（同一份房间名单）；对不上时退回 ID 并标出来。
 */
function memberRelayLabel(m: RoomMember): string {
  if (m.role === 'host') {
    const count = (detail.value?.scheduledRelays ?? []).length;
    return count > 0 ? `全部 ${count} 台（房主都连）` : '全部（房主都连）';
  }
  const id = m.relayNodeId ?? null;
  if (!id) return '未分配（下次拉票据时分）';
  const hit = (detail.value?.scheduledRelays ?? []).find((r) => r.id === id);
  return hit ? relayLabel(hit) : `${id}（不在房间名单里）`;
}

/** 这一列不是故障态，只有"未分配"才值得标灰 */
function memberRelayAssigned(m: RoomMember): boolean {
  return m.role === 'host' || Boolean(m.relayNodeId);
}

/** 节点名兜底：服务端没解析出名字（节点记录已被删除）时退回 ID，并标明它已经没了 */
function relayLabel(entry: { id: string; name: string | null; exists?: boolean }): string {
  if (entry.name) return entry.name;
  return `${entry.id}（节点记录已删除）`;
}

/**
 * 延迟单元格的副标题：这条链路到底是直连还是经中继。
 *
 * `p2p` 由服务端按 EasyTier 的 `cost` 判定（成员↔房主那一条）。以前服务端把「有延迟」当直连，
 * 于是走中继的成员也显示 P2P —— 玩家一眼就能看出是假的。现在只有真的直连才写 P2P。
 *
 * 房主那一行没有「到房主」的链路：服务端给的是**它看到的最快成员**那一条（见
 * `resolveMemberLink` 的 role === 'host' 分支）。链路类型照样是"直连还是中继"，
 * 只是对端是那个成员 —— 以前这里写「成员最快」，读的人根本不知道那是直连还是走中继，
 * 现在统一成同一套措辞，表头里说明房主那一行的口径。
 */
function linkNote(m: RoomMember): string {
  if (m.latencyMs === null) return '';
  return m.p2p ? 'P2P 直连' : '经中继';
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
  if (!secret) return '未设置网络密钥';
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
  <div class="console-page">
    <header class="console-head">
      <div class="console-head-text">
        <h1 class="console-head-title">房间管理</h1>
        <p class="console-head-sub">共 {{ total }} 个房间。点击任意一行查看成员、网络密钥、ACL 与访问日志。</p>
      </div>
      <div class="console-head-actions">
        <button class="btn" type="button" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
        <button class="btn btn-danger" type="button" :disabled="busy" @click="recomputeAcl">一键重算 ACL</button>
      </div>
    </header>

    <section class="console-section">
      <div class="console-section-head">
        <div class="console-section-text">
          <h2 class="console-section-title">筛选</h2>
          <p class="console-section-note">按状态与关键字缩小范围，回车即应用。</p>
        </div>
      </div>
      <div class="filter-grid">
        <div class="field">
          <label class="label" for="r-status">状态</label>
          <select id="r-status" v-model="filters.status" class="select" @change="applyFilters">
            <option value="">全部状态</option>
            <option value="open">开放中</option>
            <option value="closed">已关闭</option>
            <option value="expired">已过期</option>
          </select>
        </div>
        <div class="field">
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
        <div class="filter-actions">
          <button class="btn" type="button" @click="applyFilters">应用筛选</button>
        </div>
      </div>
    </section>

    <section class="console-section">
      <div v-if="loading && rooms.length === 0" class="stack-tight">
        <div v-for="i in 5" :key="i" class="skeleton" style="height: 36px" />
      </div>

      <div v-else-if="error" class="console-section-head">
        <div class="console-section-text">
          <div class="console-sub-title">加载失败</div>
          <p class="console-section-note">{{ error }}</p>
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
                <th class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rooms" :key="r.id" class="clickable" @click="openDetail(r.id)">
                <td>
                  <div class="wrap-anywhere room-name">{{ r.name }}</div>
                  <div class="cell-sub">{{ r.id }}</div>
                </td>
                <td class="mono">{{ r.code }}</td>
                <td class="wrap-anywhere">{{ r.hostDisplayName }}</td>
                <td>{{ regionLabel(r.zone) }}</td>
                <td>
                  <Badge :tone="roomTone(r.status)" dot>{{ roomLabel(r.status) }}</Badge>
                  <div class="cell-sub access-note">{{ accessLabel(r.access) }}</div>
                </td>
                <td class="table-num">{{ r.onlineMembers }} / {{ r.policy.maxPlayers }}</td>
                <td class="mono">{{ r.subnet }}</td>
                <td class="table-num">
                  <div class="mono">{{ formatBytes(r.usage.rxBytes + r.usage.txBytes) }}</div>
                  <div class="cell-sub">
                    收 {{ formatBytes(r.usage.rxBytes) }} · 发 {{ formatBytes(r.usage.txBytes) }}
                  </div>
                </td>
                <td class="cell-sub">
                  {{ formatRelativeTime(r.createdAt) }}
                  <div v-if="r.expiresAt" class="expire-note">至 {{ formatDateTime(r.expiresAt) }}</div>
                </td>
                <td>
                  <div class="row-actions">
                    <button class="btn btn-sm" type="button" @click.stop="openDetail(r.id)">详情</button>
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

    <!-- 详情抽屉 -->
    <div v-if="detailId" class="modal-mask drawer-mask" @click.self="closeDetail">
      <div class="modal-panel modal-panel-right drawer-panel">
        <div class="drawer-head">
          <div class="console-section-text">
            <h2 class="console-head-title drawer-title">{{ detail?.room.name ?? '房间详情' }}</h2>
            <p class="console-section-note mono wrap-anywhere">{{ detailId }}</p>
          </div>
          <div class="console-toolbar">
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

        <div v-if="detailLoading" class="stack-tight">
          <div v-for="i in 4" :key="i" class="skeleton" style="height: 32px" />
        </div>

        <div v-else-if="detailError" class="console-section-head">
          <p class="console-section-note">{{ detailError }}</p>
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
            <span class="kv-v">
              {{ detail.room.hostDisplayName }}
              <span class="cell-sub">{{ detail.room.hostUserId }}</span>
            </span>
            <span class="kv-k">区域</span><span class="kv-v">{{ regionLabel(detail.room.zone) }}</span>
            <span class="kv-k">虚拟网段</span>
            <span class="kv-v mono">{{ detail.room.subnet }}（槽位 {{ detail.room.subnetSlot }}）</span>
            <span class="kv-k">EasyTier 网络</span>
            <span class="kv-v mono wrap-anywhere">{{ detail.room.networkName }}</span>
            <span class="kv-k">中继节点</span>
            <span class="kv-v wrap-anywhere">
              <!--
                两个槽位有明确分工（服务端 `RoomService.#pickRelays`）：
                  槽 1 = 打洞节点：协助 P2P 打洞，**不承载数据**；
                  槽 2 = 中继节点：真正转发房间流量的那台（大带宽档 + 延迟优先挑出来的）。
                显示**节点名**而不是 n_xxxx：运营要知道的是"哪台机器"，不是一串内部 ID。
              -->
              <template v-if="detail.scheduledRelays && detail.scheduledRelays.length > 0">
                <Badge
                  v-for="r in detail.scheduledRelays"
                  :key="r.id"
                  :tone="r.exists ? (r.role === 'relay' ? 'ok' : 'neutral') : 'warn'"
                >
                  {{ r.role === 'relay' ? '中继' : '打洞' }} · {{ relayLabel(r) }}
                </Badge>
                <span class="cell-sub">建房时调度（打洞节点 + 中继节点）</span>
              </template>
              <template v-else-if="asStringList(detail.room.relayNodeIds).length > 0">
                {{ asStringList(detail.room.relayNodeIds).join(', ') }}
                <span class="cell-sub">旧主控没有节点名，只能显示 ID</span>
              </template>
              <span v-else class="faint">无（建房时没有可用节点）</span>
            </span>
            <span class="kv-k">正在承载</span>
            <span class="kv-v wrap-anywhere">
              <!--
                「调度名单」与「实际在带」是两回事：某台掉了、换节点、手动改过 endpoint
                都会让两份名单不一致。排障要看的是后者。

                ⚠️ 新模型（房主连 ≤3 台、成员各连 1 台，见 docs/relay-assignment.md）下
                "不在房间的 relayNodeIds 里"是**正常**的：成员分到的是房间里那几台之一，
                而这台只要还在转发就会出现在这里 —— 所以文案不再说"正在顶班"（那是旧模型
                的临时状态），只说清"哪几台在带、与房间调度名单是否一致"。
              -->
              <template v-if="(detail.relayNodes ?? []).length > 0">
                <Badge v-for="n in detail.relayNodes" :key="n.id" :tone="n.scheduled ? 'ok' : 'warn'">
                  {{ n.name }}
                </Badge>
                <span class="cell-sub">
                  {{ (detail.relayNodes ?? []).every((n) => n.scheduled) ? '与房间的中继名单一致' : '有节点不在房间的中继名单里（成员可能被分到过它，或刚被换掉）' }}
                </span>
              </template>
              <span v-else class="faint">此刻没有节点在转发这个房间（房间可能没人进来）</span>
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
              {{ detail.room.policy.allowBroadcast ? '局域网广播直通' : '广播直通关闭' }} ·
              端口
              {{ asStringList(detail.room.policy.allowedPorts).length > 0 ? asStringList(detail.room.policy.allowedPorts).join(', ') : '不限' }}
            </span>
            <span class="kv-k">创建时间</span><span class="kv-v">{{ formatDateTime(detail.room.createdAt) }}</span>
          </div>

          <!-- 网络密钥 -->
          <div class="secret-block">
            <div class="secret-head">
              <span class="console-sub-title">networkSecret</span>
              <div class="console-toolbar">
                <button class="btn btn-sm btn-ghost" type="button" @click="secretVisible = !secretVisible">
                  {{ secretVisible ? '隐藏' : '显示' }}
                </button>
                <button class="btn btn-sm" type="button" @click="copyText(detail.networkSecret, '网络密钥')">复制</button>
              </div>
            </div>
            <div class="secret-text">{{ displayedSecret }}</div>
            <p class="hint hint-measure">
              网络名由该密钥派生，是共享中继下的准入凭证：密钥泄露等于房间可被任意扫描到，必要时让房主轮换密钥。
            </p>
          </div>

          <!-- 成员 -->
          <div class="sub-block">
            <div class="sub-head">
              <span class="console-sub-title">成员（{{ detail.members.length }}）</span>
              <span class="cell-sub">
                延迟一列的副标题写的是这条链路**是直连还是经中继**；房主那行没有"到房主"的链路，
                服务端给的是它到**最快成员**那一条，所以措辞一样、含义是"房主 ↔ 那个最快成员"。
              </span>
            </div>
            <div v-if="detail.members.length === 0" class="empty">暂无成员记录。</div>
            <div v-else class="table-wrap member-table">
              <table class="table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>虚拟 IP</th>
                    <!--
                      「走哪台中继」：房主连整个集合，成员只连自己那一台（见 docs/relay-assignment.md）。
                      这一列直接读 room_members.relay_node_id —— 用户实测最常问的就是这一格。
                    -->
                    <th>中继</th>
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
                      <div class="cell-sub">{{ m.username }}</div>
                    </td>
                    <td>
                      <Badge :tone="m.role === 'host' ? 'brand' : 'neutral'">{{ m.role === 'host' ? '房主' : '成员' }}</Badge>
                    </td>
                    <td><Badge :tone="memberTone(m.status)">{{ memberLabel(m.status) }}</Badge></td>
                    <td v-if="m.virtualIp" class="mono cell-sub">{{ m.virtualIp }}</td>
                    <td v-else class="cell-void">未分配</td>
                    <td :class="memberRelayAssigned(m) ? 'cell-sub' : 'cell-void'">{{ memberRelayLabel(m) }}</td>
                    <td v-if="m.deviceName" class="cell-sub">{{ m.deviceName }}</td>
                    <td v-else class="cell-void">未知设备</td>
                    <td class="table-num">
                      {{ m.latencyMs === null ? '未测得' : `${m.latencyMs} ms` }}
                      <div v-if="linkNote(m)" class="cell-sub">{{ linkNote(m) }}</div>
                    </td>
                    <td class="table-num cell-sub">
                      {{ formatBitrate(m.rxBps) }} / {{ formatBitrate(m.txBps) }}
                    </td>
                    <td class="cell-sub">
                      {{ formatRelativeTime(m.joinedAt) }}
                      <div class="seen-note">心跳 {{ formatRelativeTime(m.lastSeenAt) }}</div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- ACL -->
          <div class="sub-block">
            <div class="sub-head">
              <span class="console-sub-title">房主 ACL（TOML）</span>
              <button class="btn btn-sm" type="button" @click="copyText(detail.aclToml, 'ACL 文本')">复制</button>
            </div>
            <pre class="code-block acl-block">{{ detail.aclToml || '（房间无 ACL 内容）' }}</pre>
          </div>

          <!-- 访问日志 -->
          <div class="sub-block">
            <div class="sub-head">
              <span class="console-sub-title">访问日志（最近 {{ detail.accessLog.length }} 条）</span>
            </div>
            <div v-if="detail.accessLog.length === 0" class="empty">暂无访问记录。</div>
            <div v-else class="table-wrap log-table">
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
                    <td class="cell-sub">{{ formatDateTime(l.ts) }}</td>
                    <td class="mono wrap-anywhere">{{ l.action }}</td>
                    <td v-if="l.user_id" class="mono cell-sub">{{ l.user_id }}</td>
                    <td v-else class="cell-void">匿名</td>
                    <td v-if="l.detail" class="cell-sub">{{ l.detail }}</td>
                    <td v-else class="cell-void">无</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-grid {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) auto;
  gap: var(--s-4);
  align-items: end;
}
.filter-actions {
  display: flex;
  align-items: center;
  padding-bottom: 1px;
}
.clickable {
  cursor: pointer;
}
.room-name {
  font-weight: 500;
}
.access-note {
  margin-top: 3px;
  font-family: var(--font-sans);
}
.expire-note {
  margin-top: 3px;
}
.col-actions {
  text-align: right;
}
.row-actions {
  display: flex;
  justify-content: flex-end;
}
.cell-void {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
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
/* 抽屉：贴右侧、通高；遮罩不透明压暗，不做毛玻璃 */
.drawer-mask {
  place-items: stretch end;
  padding: 0;
}
.drawer-panel {
  max-width: min(920px, 100%);
  max-height: 100vh;
  height: 100vh;
  border-radius: 0;
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
  gap: var(--s-5);
}
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
  padding-bottom: var(--s-4);
  border-bottom: 1px solid var(--rule-strong);
}
.drawer-title {
  font-size: var(--fs-lg);
}
.secret-block {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding-top: var(--s-4);
  border-top: 1px solid var(--rule);
}
.secret-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.secret-text {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--paper-2);
  letter-spacing: 0.04em;
  overflow-wrap: anywhere;
}
.hint-measure {
  max-width: 72ch;
}
.sub-block {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding-top: var(--s-4);
  border-top: 1px solid var(--rule);
}
.sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.member-table {
  max-height: 300px;
  overflow-y: auto;
}
.log-table {
  max-height: 260px;
  overflow-y: auto;
}
.acl-block {
  max-height: 280px;
}
.seen-note {
  margin-top: 3px;
}
@media (max-width: 900px) {
  .filter-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
