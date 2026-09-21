<script setup lang="ts">
/** 已进入房间时的主界面：联机地址、成员、房主控制、聊天、游戏连接指引与网络状态 */
import { computed, ref } from 'vue';
import { formatBitrate, formatBytes } from '@mclink/shared';
import {
  applyHostAclIfNeeded,
  approveMember,
  clientState,
  closeRoom,
  isHost,
  isOnline,
  kickMember,
  leaveRoom,
  pollPeers,
  refreshRoom,
  rotateSecret,
  shareAddress,
  updateRoomPolicy,
} from '../lib/store.ts';
import { MASTER_URL, friendlyError } from '../lib/api.ts';
import { isFavorite, shortcutsRevision, toggleFavorite } from '../lib/shortcuts.ts';
import ChatPanel from '../components/ChatPanel.vue';
import ConnectionDiagnostic from '../components/ConnectionDiagnostic.vue';
import GameQuickConnect from '../components/GameQuickConnect.vue';

const copied = ref('');
const busy = ref(false);
const error = ref('');
const policyOpen = ref(false);
const inviteOpen = ref(false);
const policy = ref({
  maxPlayers: 8,
  maxBandwidthKbps: 0,
  perMemberKbps: 0,
  rateLimitPps: 0,
  allowedPorts: '',
  strictPorts: false,
  allowP2p: true,
});

const session = computed(() => clientState.session);
const room = computed(() => session.value?.room ?? null);
const members = computed(() => session.value?.members ?? []);
const pending = computed(() => members.value.filter((m) => m.status === 'pending'));

const favorite = computed(() => {
  void shortcutsRevision.value;
  const current = room.value;
  return current ? isFavorite(current.id) : false;
});

/** 一键粘贴到群里的邀请信息（多行纯文本） */
const inviteText = computed(() => {
  const current = room.value;
  let host = MASTER_URL;
  try {
    host = new URL(MASTER_URL).host;
  } catch {
    /* 地址不合法时退化为原样展示 */
  }
  return [
    `【mclink 联机邀请】${current?.name ?? ''}`,
    `加入码：${current?.code ?? ''}`,
    `联机地址：${shareAddress.value ?? '（等待分配）'}`,
    '',
    '怎么进：① 打开 mclink 客户端，用上面的加入码进房间；② 启动游戏 → 多人游戏 → 直接连接 → 粘贴上面的联机地址。',
    `还没装客户端？到 ${host} 下载 Windows 客户端。`,
  ].join('\n');
});

function copy(text: string, tag: string): void {
  void navigator.clipboard.writeText(text).then(
    () => {
      copied.value = tag;
      setTimeout(() => {
        if (copied.value === tag) copied.value = '';
      }, 1800);
    },
    () => {
      error.value = '复制失败，请手动选择文本复制';
    },
  );
}

function openPolicy(): void {
  const p = room.value?.policy;
  if (!p) return;
  policy.value = {
    maxPlayers: p.maxPlayers,
    maxBandwidthKbps: p.maxBandwidthKbps,
    perMemberKbps: p.perMemberKbps,
    rateLimitPps: p.rateLimitPps,
    allowedPorts: p.allowedPorts.join(','),
    strictPorts: p.strictPorts,
    allowP2p: p.allowP2p,
  };
  policyOpen.value = true;
}

/** 收藏 / 取消收藏当前房间（只写本机 localStorage） */
function toggleFav(): void {
  const current = room.value;
  if (!current) return;
  toggleFavorite({
    roomId: current.id,
    code: current.code,
    name: current.name,
    lastAddress: shareAddress.value ?? null,
    lastSeenAt: new Date().toISOString(),
  });
}

/** 打开置顶迷你窗，把联机地址钉在屏幕上 */
async function openMini(): Promise<void> {
  error.value = '';
  const res = await window.mclink.mini.open();
  if (!res.ok) error.value = res.error ?? '迷你窗打开失败';
}

async function savePolicy(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await updateRoomPolicy({
      maxPlayers: policy.value.maxPlayers,
      maxBandwidthKbps: policy.value.maxBandwidthKbps,
      perMemberKbps: policy.value.perMemberKbps,
      rateLimitPps: policy.value.rateLimitPps,
      allowedPorts: policy.value.allowedPorts
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      strictPorts: policy.value.strictPorts,
      allowP2p: policy.value.allowP2p,
    });
    policyOpen.value = false;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function doKick(userId: string, name: string): Promise<void> {
  const ok = await window.mclink.confirm({
    title: '踢出成员',
    message: `确定把「${name}」移出房间吗？`,
    detail: '对方会立即断开虚拟网络。房主的 EasyTier 实例可能需要短暂重连（约 2 秒）才能让规则生效。',
  });
  if (!ok) return;
  busy.value = true;
  error.value = '';
  try {
    await kickMember(userId, '房主移出');
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function doRotate(): Promise<void> {
  const ok = await window.mclink.confirm({
    title: '轮换房间密钥',
    message: '轮换后所有成员（包括你自己）都会断开，需要用新的加入码信息重新进入。',
    detail: '网络名与密钥会一起更换，任何拿到过旧信息的人都将无法再连入。',
  });
  if (!ok) return;
  busy.value = true;
  try {
    await rotateSecret();
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function doClose(): Promise<void> {
  const ok = await window.mclink.confirm({
    title: '关闭房间',
    message: '确定关闭房间吗？所有成员都会被断开。',
  });
  if (!ok) return;
  busy.value = true;
  try {
    await closeRoom();
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="session && room" class="view">
    <div v-if="error" class="alert alert-danger">{{ error }}</div>

    <!-- 房间头 -->
    <div class="card">
      <div class="row-between wrap">
        <div class="grow">
          <div class="row">
            <span style="font-size: var(--fs-xl); font-weight: 680">{{ room.name }}</span>
            <span class="badge badge-brand">加入码 {{ room.code }}</span>
            <span class="badge" :class="isOnline ? 'badge-ok' : 'badge-warn'">
              <span class="dot" :class="isOnline ? 'dot-ok' : 'dot-warn'" />
              {{ isOnline ? '虚拟网络已连接' : '正在建立连接…' }}
            </span>
          </div>
          <div class="hint" style="margin-top: 4px">
            区域 {{ room.zone }} · 网段 <span class="mono">{{ room.subnet }}</span> · 在线
            {{ room.onlineMembers }}/{{ room.policy.maxPlayers }}
          </div>
        </div>
        <div class="row">
          <button class="btn btn-sm" :disabled="busy" @click="pollPeers()">刷新状态</button>
          <button class="btn btn-sm" :disabled="busy" @click="refreshRoom()">刷新成员</button>
          <button class="btn btn-sm" :title="favorite ? '取消收藏' : '收藏这个房间'" @click="toggleFav()">
            {{ favorite ? '★ 已收藏' : '☆ 收藏' }}
          </button>
          <button class="btn btn-sm" title="把联机地址钉在屏幕角落" @click="openMini()">迷你窗</button>
          <button v-if="isHost" class="btn btn-sm" @click="openPolicy()">房间规则</button>
          <button v-if="isHost" class="btn btn-sm" :disabled="busy" @click="doRotate()">轮换密钥</button>
          <button v-if="isHost" class="btn btn-sm btn-danger" :disabled="busy" @click="doClose()">关闭房间</button>
          <button v-else class="btn btn-sm btn-danger" :disabled="busy" @click="leaveRoom()">退出房间</button>
        </div>
      </div>
    </div>

    <!-- 联机地址 -->
    <div class="address">
      <div class="grow">
        <div class="faint" style="font-size: var(--fs-xs)">把下面这个地址发给朋友，让他们在游戏里「多人游戏 → 直接连接」中粘贴</div>
        <div class="address-value">{{ shareAddress ?? '等待分配…' }}</div>
      </div>
      <button class="btn btn-primary" @click="copy(shareAddress ?? '', 'addr')">
        {{ copied === 'addr' ? '已复制' : '复制地址' }}
      </button>
      <button class="btn" @click="inviteOpen = true">邀请信息…</button>
    </div>

    <div class="grid-2">
      <!-- 网络状态 -->
      <div class="card">
        <div class="row-between" style="margin-bottom: 10px">
          <div style="font-weight: 620">我的网络状态</div>
          <span class="badge badge-neutral mono">{{ session.virtualIp }}</span>
        </div>
        <div class="grid-3" style="margin-bottom: 12px">
          <div>
            <div class="faint" style="font-size: var(--fs-xs)">下载</div>
            <div class="mono">{{ formatBitrate(clientState.localRxBps) }}</div>
          </div>
          <div>
            <div class="faint" style="font-size: var(--fs-xs)">上传</div>
            <div class="mono">{{ formatBitrate(clientState.localTxBps) }}</div>
          </div>
          <div>
            <div class="faint" style="font-size: var(--fs-xs)">累计流量</div>
            <div class="mono">{{ formatBytes(clientState.localRxBytes + clientState.localTxBytes) }}</div>
          </div>
        </div>

        <table v-if="clientState.peers.length > 0" class="table">
          <thead>
            <tr>
              <th>节点</th>
              <th>虚拟地址</th>
              <th>链路</th>
              <th class="table-num">延迟</th>
              <th class="table-num">流量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in clientState.peers" :key="p.ipv4 + p.hostname">
              <td class="truncate" style="max-width: 140px">{{ p.hostname || '-' }}</td>
              <td class="mono">{{ p.ipv4 || '-' }}</td>
              <td>
                <span class="badge" :class="p.cost.startsWith('p2p') ? 'badge-ok' : 'badge-neutral'">
                  {{ p.cost.startsWith('p2p') ? 'P2P 直连' : '经中继' }}
                </span>
              </td>
              <td class="table-num">{{ p.latencyMs === null ? '-' : `${p.latencyMs.toFixed(1)} ms` }}</td>
              <td class="table-num">{{ formatBytes(p.rxBytes + p.txBytes) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">还没有发现其它节点。等成员进来后这里会显示他们。</div>
      </div>

      <!-- 成员 -->
      <div class="card">
        <div class="row-between" style="margin-bottom: 10px">
          <div style="font-weight: 620">房间成员（{{ members.length }}）</div>
          <span v-if="pending.length > 0" class="badge badge-warn">{{ pending.length }} 个待审批</span>
        </div>

        <table class="table">
          <thead>
            <tr>
              <th>玩家</th>
              <th>身份</th>
              <th class="table-num">延迟</th>
              <th v-if="isHost" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in members" :key="m.userId">
              <td>
                <div>{{ m.displayName }}</div>
                <div class="faint mono" style="font-size: var(--fs-xs)">{{ m.virtualIp ?? '-' }}</div>
              </td>
              <td>
                <span class="badge badge-neutral">{{ m.role === 'host' ? '房主' : '成员' }}</span>
                <span v-if="m.status === 'pending'" class="badge badge-warn" style="margin-left: 4px">待审批</span>
                <span v-else-if="m.p2p" class="badge badge-ok" style="margin-left: 4px">直连</span>
              </td>
              <td class="table-num">{{ m.latencyMs === null ? '-' : `${m.latencyMs.toFixed(0)} ms` }}</td>
              <td v-if="isHost" style="text-align: right; white-space: nowrap">
                <template v-if="m.status === 'pending'">
                  <button class="btn btn-sm" @click="approveMember(m.userId, true)">通过</button>
                  <button class="btn btn-sm btn-ghost" @click="approveMember(m.userId, false)">拒绝</button>
                </template>
                <button
                  v-else-if="m.role !== 'host'"
                  class="btn btn-sm btn-danger"
                  :disabled="busy"
                  @click="doKick(m.userId, m.displayName)"
                >
                  踢出
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="members.length === 0" class="empty">还没有其他成员</div>

        <div v-if="isHost" class="hint" style="margin-top: 10px">
          踢人后服务端会重算房间 ACL（按被踢成员的虚拟 IP 建丢弃规则），本客户端的 easytier-core 会自动应用。
        </div>
      </div>
    </div>

    <!-- 房间聊天 -->
    <ChatPanel />

    <!-- 按游戏查「房主做什么 / 玩家填什么」 -->
    <GameQuickConnect />

    <!-- 直连还是中继、延迟、NAT 与监听端口 -->
    <ConnectionDiagnostic />

    <!-- 邀请信息弹层：多行文本，可直接粘到群里 -->
    <div v-if="inviteOpen" class="modal-mask">
      <div class="card modal-card stack">
        <div style="font-weight: 650; font-size: var(--fs-lg)">邀请信息</div>
        <div class="hint">下面这段可以直接复制粘贴到 QQ / 微信群里，朋友照着做就能进来。</div>
        <pre class="invite mono">{{ inviteText }}</pre>
        <div class="row">
          <button class="btn btn-primary grow" @click="copy(inviteText, 'invite')">
            {{ copied === 'invite' ? '已复制到剪贴板' : '复制邀请信息' }}
          </button>
          <button class="btn btn-ghost" @click="inviteOpen = false">关闭</button>
        </div>
        <div class="hint">
          加入码可以进房间，联机地址用于游戏内直连；两者都不是长期凭证 ——
          房主轮换密钥或关闭房间后就失效了。
        </div>
      </div>
    </div>

    <!-- 房间规则弹层 -->
    <div v-if="policyOpen" class="modal-mask">
      <div class="card modal-card stack">
        <div style="font-weight: 650; font-size: var(--fs-lg)">房间规则</div>
        <div class="grid-2" style="gap: 12px">
          <div class="field">
            <label class="label">最大人数</label>
            <input v-model.number="policy.maxPlayers" class="input" type="number" min="2" max="64" />
          </div>
          <div class="field">
            <label class="label">允许 P2P 直连</label>
            <select v-model="policy.allowP2p" class="select">
              <option :value="true">允许（延迟更低，省中转带宽）</option>
              <option :value="false">禁止（一律走中继）</option>
            </select>
          </div>
        </div>
        <div class="grid-2" style="gap: 12px">
          <div class="field">
            <label class="label">房间总带宽上限（kbps，0 = 不限）</label>
            <input v-model.number="policy.maxBandwidthKbps" class="input" type="number" min="0" />
            <div class="hint">作用于房主实例的接收限速，约束整个房间的上行入口。</div>
          </div>
          <div class="field">
            <label class="label">单成员接收上限（kbps，0 = 不限）</label>
            <input v-model.number="policy.perMemberKbps" class="input" type="number" min="0" />
            <div class="hint">由各成员本地实例执行；恶意客户端可绕过，仅作正常限速。</div>
          </div>
        </div>
        <div class="grid-2" style="gap: 12px">
          <div class="field">
            <label class="label">包速率上限（包/秒，0 = 不限）</label>
            <input v-model.number="policy.rateLimitPps" class="input" type="number" min="0" />
            <div class="hint">EasyTier 的 ACL 限速单位是包/秒，不是带宽。</div>
          </div>
          <div class="field">
            <label class="label">游戏端口白名单</label>
            <input v-model="policy.allowedPorts" class="input" placeholder="例如 25565 或 25565-25570" />
          </div>
        </div>
        <div class="field">
          <label class="label">严格端口模式</label>
          <select v-model="policy.strictPorts" class="select">
            <option :value="false">关闭（默认放行，只做踢人与限速）</option>
            <option :value="true">开启（默认丢弃，只放行白名单端口与 ICMP）</option>
          </select>
        </div>
        <div class="row">
          <button class="btn btn-primary grow" :disabled="busy" @click="savePolicy">保存并生效</button>
          <button class="btn btn-ghost" @click="policyOpen = false">取消</button>
        </div>
        <div class="hint">
          保存后服务端会重算 ACL 并推送；本客户端优先热更新，若当前 EasyTier 版本不支持则重启实例（约 2 秒）。
        </div>
        <button class="btn btn-ghost btn-sm" @click="applyHostAclIfNeeded(true)">立即重新应用规则</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(2, 4, 10, 0.7);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  padding: var(--s-5);
  z-index: 300;
}
.modal-card {
  width: min(680px, 100%);
  max-height: 88vh;
  overflow: auto;
}
.invite {
  margin: 0;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.32);
  font-size: var(--fs-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
</style>
