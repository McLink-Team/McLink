<script setup lang="ts">
/**
 * **本地联机（不需要主控）**卡片。
 *
 * 这是官方服务停止之后"还能怎么玩"的答案：不用注册、不用主控，填一个中继节点地址
 * （社区公共服或自建的），客户端自己生成房间身份，把**分享码**发给朋友即可。
 *
 * 放在登录页（未登录首屏）而不是房间页：它本来就是"主控那条路走不通时的另一条路"，
 * 与"填主控地址"并列出现在同一个决策点上。运行中的状态（自己的地址、房主地址、
 * 成员列表）也在这里显示 —— 本地房间没有房间页可跳（房间页是主控那套）。
 *
 * 三条必须如实写在界面上的事：
 *   1. 没有账号、没有加入码、没有审批/踢人/流量统计 —— 那些都在主控上；
 *   2. **分享码就是凭证**，谁拿到谁能进来，别发到公开群里；
 *   3. 中继节点是第三方/自建的，可用性与可信度自己判断。
 */
import { computed, ref } from 'vue';
import {
  clientState,
  forgetLocalRoom,
  localRoomShareCode,
  startLocalRoom,
  stopLocalRoom,
} from '../lib/store.ts';
import { decodeShareCode, normalizeLocalPeers } from '../lib/local-room.ts';
import { copyText } from '../lib/clipboard.ts';

const mode = ref<'create' | 'join'>('create');
const title = ref('周末开黑');
/** 中继节点：一行一个；创建与加入都要（加入方也要，否则它找不到房主） */
const peerText = ref(clientState.extraPeers);
const joinCode = ref('');
const busy = ref(false);
const message = ref('');
const error = ref('');

const parsed = computed(() => normalizeLocalPeers(peerText.value));
const shareCode = computed(() => localRoomShareCode());
const room = computed(() => clientState.localRoom);
const running = computed(() => clientState.coreStatus?.state === 'running' && room.value !== null);

/** 启动内核之后就是房间成员了：成员列表来自本机内核的 peer list（不经过任何服务器） */
const members = computed(() =>
  clientState.peers
    .map((p) => ({ ip: String(p.ipv4 ?? '').split('/')[0] ?? '', name: p.hostname || '—', cost: p.cost }))
    .filter((m) => m.ip.length > 0),
);

async function run(fn: () => Promise<string>): Promise<void> {
  busy.value = true;
  message.value = '';
  error.value = '';
  try {
    const hint = await fn();
    if (clientState.coreStatus?.state === 'error') error.value = hint;
    else message.value = hint;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function create(): Promise<void> {
  if (title.value.trim().length === 0) {
    error.value = '给房间起个名字（朋友会看到它）';
    return;
  }
  if (parsed.value.peers.length === 0) {
    error.value = '至少填一个中继节点地址 —— 没有它，两台机器之间没有牵线的中间人';
    return;
  }
  // 顺手把中继地址记进"自建 / 社区节点"，下次不用再填一遍
  await run(() => startLocalRoom({ title: title.value.trim(), peers: parsed.value.peers }));
}

async function join(): Promise<void> {
  const decoded = decodeShareCode(joinCode.value);
  if (!decoded) {
    error.value = '这段分享码看不懂 —— 让朋友把整段「mclink-local:1:…」发给你，直接粘贴即可';
    return;
  }
  const peers = parsed.value.peers.length > 0 ? parsed.value.peers : decoded.peers;
  await run(() =>
    startLocalRoom({
      title: decoded.title,
      peers,
      join: { networkName: decoded.networkName, secret: decoded.secret },
    }),
  );
}

async function stop(): Promise<void> {
  await run(async () => {
    await stopLocalRoom();
    return '已停止本地房间（记录还在，可以再点「继续上次的房间」）';
  });
}

async function resume(): Promise<void> {
  const current = room.value;
  if (!current) return;
  await run(() =>
    startLocalRoom({
      title: current.title,
      peers: current.peers,
      // 继续 = 用同一套身份重新拉起内核；房主继续当房主，加入方继续用同一个地址
      join: current.isHost ? undefined : { networkName: current.networkName, secret: current.secret, hostIp: current.hostIp },
    }),
  );
}

function forget(): void {
  forgetLocalRoom();
  message.value = '已忘掉上次的房间。';
}
</script>

<template>
  <section class="local card stack">
    <div class="section-head">
      <span class="title">本地联机（不需要主控）</span>
    </div>

    <!-- ---------------------------------------------------------- 运行中 -->
    <template v-if="running && room">
      <dl class="local-facts">
        <div>
          <dt>房间</dt>
          <dd>{{ room.title }}</dd>
        </div>
        <div>
          <dt>{{ room.isHost ? '你的地址（房主）' : '你的地址' }}</dt>
          <dd class="mono">{{ room.selfIp.split('/')[0] }}</dd>
        </div>
        <div v-if="!room.isHost">
          <dt>房主地址（游戏连它）</dt>
          <dd class="mono">{{ room.hostIp.split('/')[0] }}</dd>
        </div>
        <div>
          <dt>中继节点</dt>
          <dd class="mono">{{ room.peers.join('、') }}</dd>
        </div>
      </dl>

      <div class="field">
        <label class="label">分享码（发给朋友，他粘进「用分享码加入」）</label>
        <div class="local-code">
          <code class="mono">{{ shareCode }}</code>
          <button class="btn btn-sm" type="button" @click="copyText(shareCode ?? '')">复制</button>
        </div>
        <div class="hint warn-text">
          分享码里含**网络名与密钥** —— 谁拿到谁能进这个房间，别发到公开群里。
        </div>
      </div>

      <div class="field">
        <label class="label">房间成员（{{ members.length }}）</label>
        <ul class="local-members">
          <li v-for="m in members" :key="m.ip">
            <span class="mono">{{ m.ip }}</span>
            <span class="faint">{{ m.name }}</span>
            <span class="faint">{{ m.cost }}</span>
          </li>
          <li v-if="members.length === 0" class="faint">还没看到别人 —— 房主要先进来，成员才会互相出现。</li>
        </ul>
        <div class="hint">
          游戏里连的就是<strong>房主的地址</strong>（{{ room.isHost ? '你自己这台' : room.hostIp.split('/')[0] }}）
          + 游戏端口。局域网广播直通在本地房间下不生效（那需要房主的房间规则）。
        </div>
      </div>

      <div class="ops">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="stop">停止联机</button>
      </div>
    </template>

    <!-- ------------------------------------------------------ 未运行：创建 / 加入 -->
    <template v-else>
      <div v-if="room" class="notice notice-warn">
        <span class="notice-body">
          上次的房间「{{ room.title }}」还在记录里（当前没运行）。
        </span>
        <button class="btn btn-sm" type="button" :disabled="busy" @click="resume">继续上次的房间</button>
        <button class="btn btn-sm btn-ghost" type="button" @click="forget">删除记录</button>
      </div>

      <div class="tabs">
        <button class="tab" :class="{ active: mode === 'create' }" type="button" @click="mode = 'create'">
          创建房间
        </button>
        <button class="tab" :class="{ active: mode === 'join' }" type="button" @click="mode = 'join'">
          用分享码加入
        </button>
      </div>

      <template v-if="mode === 'create'">
        <div class="field">
          <label class="label">房间名</label>
          <input v-model="title" class="input" maxlength="40" placeholder="例如 周末开黑" />
          <div class="hint">朋友加入后看到的也是它；网络身份由本机随机生成，不需要注册。</div>
        </div>
      </template>
      <template v-else>
        <div class="field">
          <label class="label">分享码</label>
          <textarea
            v-model="joinCode"
            class="textarea"
            rows="3"
            spellcheck="false"
            placeholder="mclink-local:1:……（朋友发你的那一段，整段粘进来即可）"
          />
        </div>
      </template>

      <div class="field">
        <label class="label">中继节点（一行一个，创建与加入都要填）</label>
        <textarea
          v-model="peerText"
          class="textarea"
          rows="3"
          spellcheck="false"
          placeholder="public.easytier.cn:11010"
        />
        <div class="hint">
          社区公共节点列表（第三方，与本项目无关联）：<span class="mono">info.qtet.cn/uptime/easytier</span>。
          只写 <span class="mono">主机:端口</span> 会同时按 tcp 与 udp 各加一条。
          已识别 <strong>{{ parsed.peers.length }}</strong> 个地址<template v-if="parsed.bad.length > 0">
            ，将跳过：<span class="mono">{{ parsed.bad.join('、') }}</span></template
          >。
        </div>
      </div>

      <div class="ops">
        <button v-if="mode === 'create'" class="btn btn-primary" type="button" :disabled="busy" @click="create">
          创建并开始联机
        </button>
        <button v-else class="btn btn-primary" type="button" :disabled="busy" @click="join">加入房间</button>
      </div>

      <p class="hint">
        这条路<strong>没有账号、没有加入码、没有审批与踢人</strong>（那些功能在主控上）。
        房主先进来，成员再进；大家连的都是<strong>房主的地址 + 游戏端口</strong>。
      </p>
    </template>

    <div v-if="message" class="alert alert-ok">{{ message }}</div>
    <div v-if="error" class="alert alert-danger">{{ error }}</div>
  </section>
</template>

<style scoped>
.local-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--s-3) var(--s-4);
  margin: 0;
}
.local-facts dt {
  font-size: var(--fs-xs);
  color: var(--ink-2);
}
.local-facts dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}
.local-code {
  display: flex;
  gap: var(--s-2);
  align-items: flex-start;
}
.local-code code {
  flex: 1;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--rule-strong);
  border-radius: var(--r-sm);
  background: var(--ink-800);
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}
.local-members {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.local-members li {
  display: flex;
  gap: var(--s-3);
  font-size: var(--fs-sm);
}
</style>
