<script setup lang="ts">
/**
 * 游戏快捷连接：把「房主要做什么 + 玩家要填什么地址」摊开写清楚。
 *
 * 端口与联机方式来自各游戏的常见默认值（内置数据，不联网抓取）。
 * 游戏版本更新可能改端口，所以每个卡片都提示「以游戏内设置为准」，
 * 并且强调：只显示局域网房间列表的游戏根本不用手填地址。
 */
import { computed, ref } from 'vue';
import { copyText } from '../lib/clipboard.ts';
import { shareAddress } from '../lib/store.ts';

interface GamePreset {
  id: string;
  name: string;
  /** 用于拼接地址的端口；空数组表示不需要端口（纯虚拟局域网即可见） */
  ports: string[];
  proto: string;
  /** 房主需要做的事 */
  hostSteps: string;
  /** 玩家怎么进 */
  playerSteps: string;
  note?: string;
}

const PRESETS: GamePreset[] = [
  {
    id: 'mc-java',
    name: '我的世界（Java 版）',
    ports: ['25565'],
    proto: 'TCP',
    hostSteps: '单人存档 → Esc → 「对局域网开放」，并把端口手动改成 25565；或者直接用服务端（server.properties 里 server-port=25565）后再开服。',
    playerSteps: '多人游戏 → 直接连接 → 粘贴下面的地址。',
    note: '「对局域网开放」默认给的是随机端口，所以要么手动改成 25565，要么按地址里实际的端口填。',
  },
  {
    id: 'mc-bedrock',
    name: '我的世界（基岩版）',
    ports: ['19132'],
    proto: 'UDP',
    hostSteps: '世界设置 → 游戏 → 打开「对局域网可见」；专用服务器则在 server.properties 里设 server-port=19132。',
    playerSteps: '游戏 → 服务器 → 添加服务器，把地址填进去。',
    note: '基岩版走 UDP。自动搜不到房间时，手动「添加服务器」最稳。',
  },
  {
    id: 'terraria',
    name: '泰拉瑞亚',
    ports: ['7777'],
    proto: 'TCP',
    hostSteps: '多人游戏 → 开服并玩（Host & Play），端口保持默认 7777。',
    playerSteps: '多人游戏 → 通过 IP 加入 → 粘贴地址。',
  },
  {
    id: 'stardew',
    name: '星露谷物语',
    ports: ['24642'],
    proto: 'UDP',
    hostSteps: '合作 → 邀请朋友 → 主持新农场（Host），端口保持默认。',
    playerSteps: '合作 → 加入局域网游戏（同一房间内通常会自动出现在列表里）。',
    note: '这个端口的协议在不同资料里标注不一致，连不上时优先用游戏内的局域网列表加入。',
  },
  {
    id: 'dont-starve',
    name: '饥荒联机版',
    ports: ['10999', '27015', '10888'],
    proto: 'UDP',
    hostSteps: '创建世界时选「局域网（LAN）」。主端口 10999，27015 与 10888 分别是 Steam 查询与主服务器端口。',
    playerSteps: '游戏 → 浏览游戏 → 局域网，或直接连接地址。',
  },
  {
    id: 'valheim',
    name: '英灵神殿',
    ports: ['2456'],
    proto: 'TCP+UDP',
    hostSteps: '开服后默认监听 2456（实际会占用 2456-2457），防火墙要同时放行 UDP 与 TCP。',
    playerSteps: '加入游戏 → 通过 IP 加入 → 粘贴地址。',
  },
  {
    id: 'terratech',
    name: '泰拉科技',
    ports: ['14159'],
    proto: 'TCP',
    hostSteps: '游戏内开启多人（Multiplayer），选直接连接模式，端口默认 14159。',
    playerSteps: '多人游戏 → 直接连接 → 粘贴地址。',
    note: '不同版本的端口可能不同，以房主机器上游戏显示/监听的端口为准。',
  },
  {
    id: 'palworld',
    name: '幻兽帕鲁',
    ports: ['8211'],
    proto: 'UDP',
    hostSteps: '开专用服务器（游戏端口 8211，查询端口 27015）。',
    playerSteps: '加入多人游戏（专用服务器）→ 填地址。',
    note: '地址只填 8211 就够了；27015 只用于服务器列表查询。',
  },
  {
    id: 'nms',
    name: '无人深空',
    ports: [],
    proto: '无需端口',
    hostSteps: '不需要端口：直接在同一个房间（同一虚拟局域网）里开房间就行。',
    playerSteps: '游戏内的房间/好友列表里会直接出现，不需要手填地址。',
    note: '这类游戏只显示房间列表，属于「什么都不用填」的情况。',
  },
];

const keyword = ref('');
const copied = ref('');
const copyError = ref('');

const address = computed(() => shareAddress.value);
const filtered = computed(() => {
  const key = keyword.value.trim().toLowerCase();
  if (key.length === 0) return PRESETS;
  return PRESETS.filter((g) => g.name.toLowerCase().includes(key) || g.proto.toLowerCase().includes(key));
});

function addressFor(preset: GamePreset, port?: string): string {
  if (!address.value) return '';
  if (!port) return address.value;
  return `${address.value}:${port}`;
}

async function copy(text: string, tag: string): Promise<void> {
  copyError.value = '';
  if (text.length === 0) return;
  try {
    const ok = await copyText(text);
    if (!ok) throw new Error("剪贴板不可用");
    copied.value = tag;
    window.setTimeout(() => {
      if (copied.value === tag) copied.value = '';
    }, 1800);
  } catch {
    copyError.value = '复制失败，请手动选中地址复制。';
  }
}
</script>

<template>
  <div class="card">
    <div class="row-between wrap" style="margin-bottom: 10px">
      <div>
        <div style="font-weight: 620">游戏快捷连接</div>
        <div class="hint">按游戏查「房主要做什么、玩家填什么地址」。</div>
      </div>
      <input v-model="keyword" class="input" style="max-width: 200px" placeholder="搜索游戏…" />
    </div>

    <div v-if="copyError" class="alert alert-warn" style="margin-bottom: 10px">
      <span class="grow">{{ copyError }}</span>
      <button class="btn btn-ghost btn-sm" @click="copyError = ''">关闭</button>
    </div>

    <!-- 地址还没分配时（卡在连接阶段）就是「空数据」态 -->
    <div v-if="!address" class="alert alert-warn" style="margin-bottom: 10px">
      <span class="grow">虚拟地址还没分配好，等房间状态变成「虚拟网络已连接」后这里会自动出现可复制的地址。</span>
    </div>

    <div class="grid-2">
      <div v-for="g in filtered" :key="g.id" class="game-card">
        <div class="row-between wrap" style="gap: 6px">
          <div style="font-weight: 600">{{ g.name }}</div>
          <span class="badge badge-neutral">{{ g.proto }}<template v-if="g.ports.length > 0"> · {{ g.ports.join(' / ') }}</template></span>
        </div>

        <div class="hint"><span class="faint">房主：</span>{{ g.hostSteps }}</div>
        <div class="hint"><span class="faint">玩家：</span>{{ g.playerSteps }}</div>
        <div v-if="g.note" class="hint" style="color: var(--warn)">{{ g.note }}</div>

        <div v-if="g.ports.length === 0" class="row" style="gap: 6px; margin-top: 4px">
          <span class="code">{{ address ?? '等待分配…' }}</span>
          <button class="btn btn-sm" :disabled="!address" @click="copy(addressFor(g), `ip-${g.id}`)">
            {{ copied === `ip-${g.id}` ? '已复制' : '复制地址' }}
          </button>
        </div>
        <div v-else class="stack" style="gap: 6px; margin-top: 4px">
          <div v-for="port in g.ports" :key="port" class="row" style="gap: 6px">
            <span class="code grow truncate">{{ address ? addressFor(g, port) : '等待分配…' }}</span>
            <button class="btn btn-sm" :disabled="!address" @click="copy(addressFor(g, port), `${g.id}-${port}`)">
              {{ copied === `${g.id}-${port}` ? '已复制' : '复制' }}
            </button>
          </div>
          <button
            v-if="g.ports.length > 1"
            class="btn btn-sm btn-ghost"
            :disabled="!address"
            @click="copy(g.ports.map((p) => addressFor(g, p)).join('\n'), `all-${g.id}`)"
          >
            {{ copied === `all-${g.id}` ? '已复制全部端口' : '复制全部端口地址' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="filtered.length === 0" class="empty">没有匹配的游戏，换个关键词试试。</div>

    <div class="hint" style="margin-top: 12px">
      通用说明：有些游戏只显示「局域网房间列表」，这种情况不需要手填地址 ——
      只要大家都进了同一个 mclink 房间，游戏里就能直接看到对方的房间。
      端口如果和游戏里显示的不一致，以游戏内显示的为准。
    </div>
  </div>
</template>

<style scoped>
.game-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-hair);
}
.wrap {
  flex-wrap: wrap;
}
</style>
