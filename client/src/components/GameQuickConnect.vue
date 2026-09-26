<script setup lang="ts">
/**
 * 联机帮助的正文：按游戏说清「房主要做什么 / 玩家填什么地址」。
 *
 * 为什么它不再直接铺在房间页上：这份表有 9 个游戏、每个 4~6 行，在 940×580 的
 * 宽窗里会占掉一整屏，而它旁边正是"把联机地址发出去"这条主路径 ——
 * 玩家截图里地址卡被它挤到错位。现在房间页只留一行入口，内容降级收进弹层，
 * 一行没删。
 *
 * 端口为什么要同时写在徽标和步骤里：房间页的地址提示只说「不少游戏要连端口，
 * 写法是 地址:端口」，玩家就是来这里查那个端口到底是几位数的。
 * 所以每个游戏**默认端口与协议**既在右上角徽标里，也出现在房主步骤的句子里；
 * 只显示房间列表的游戏则明确写「不用填地址」。
 *
 * 数据是内置的常见默认值（不联网抓取）：游戏版本更新可能改端口，
 * 因此每条都注明「以游戏内为准」。
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
    playerSteps: '多人游戏 → 直接连接 → 粘贴下面的地址。地址要带端口，形如 25.x.x.x:25565。',
    note: '「对局域网开放」默认给的是随机端口，所以要么手动改成 25565，要么按地址里实际的端口填。',
  },
  {
    id: 'mc-bedrock',
    name: '我的世界（基岩版）',
    ports: ['19132'],
    proto: 'UDP',
    hostSteps: '世界设置 → 游戏 → 打开「对局域网可见」；专用服务器则在 server.properties 里设 server-port=19132。',
    playerSteps: '游戏 → 服务器 → 添加服务器，地址填 25.x.x.x:19132（基岩版走 UDP）。',
    note: '基岩版走 UDP。自动搜不到房间时，手动「添加服务器」最稳。',
  },
  {
    id: 'terraria',
    name: '泰拉瑞亚',
    ports: ['7777'],
    proto: 'TCP',
    hostSteps: '多人游戏 → 开服并玩（Host & Play），端口保持默认 7777。',
    playerSteps: '多人游戏 → 通过 IP 加入 → 粘贴地址（25.x.x.x:7777）。',
  },
  {
    id: 'stardew',
    name: '星露谷物语',
    ports: ['24642'],
    proto: 'UDP',
    hostSteps: '合作 → 邀请朋友 → 主持新农场（Host），端口保持默认 24642。',
    playerSteps: '合作 → 加入局域网游戏（同一房间内通常会自动出现在列表里，不用手填）。想手填就是 25.x.x.x:24642。',
    note: '这个端口的协议在不同资料里标注不一致，连不上时优先用游戏内的局域网列表加入。',
  },
  {
    id: 'dont-starve',
    name: '饥荒联机版',
    ports: ['10999', '27015', '10888'],
    proto: 'UDP',
    hostSteps: '创建世界时选「局域网（LAN）」。游戏主端口 10999，27015 与 10888 分别是 Steam 查询与主服务器端口。',
    playerSteps: '游戏 → 浏览游戏 → 局域网，或直接连接 25.x.x.x:10999（主端口是 10999）。',
  },
  {
    id: 'valheim',
    name: '英灵神殿',
    ports: ['2456'],
    proto: 'TCP+UDP',
    hostSteps: '开服后默认监听 2456（实际会占用 2456-2457），防火墙要同时放行 UDP 与 TCP。',
    playerSteps: '加入游戏 → 通过 IP 加入 → 粘贴地址（25.x.x.x:2456）。',
  },
  {
    id: 'terratech',
    name: '泰拉科技',
    ports: ['14159'],
    proto: 'TCP',
    hostSteps: '游戏内开启多人（Multiplayer），选直接连接模式，端口默认 14159。',
    playerSteps: '多人游戏 → 直接连接 → 粘贴地址（25.x.x.x:14159）。',
    note: '不同版本的端口可能不同，以房主机器上游戏显示/监听的端口为准。',
  },
  {
    id: 'palworld',
    name: '幻兽帕鲁',
    ports: ['8211'],
    proto: 'UDP',
    hostSteps: '开专用服务器（游戏端口 8211，查询端口 27015）。',
    playerSteps: '加入多人游戏（专用服务器）→ 填 25.x.x.x:8211。',
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
    if (!ok) throw new Error('剪贴板不可用');
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
  <!--
    这里是**弹层里**的内容，所以自己不套 .card：弹层本身已经是一张卡，
    再套一层就变成"卡里套卡"（这套设计明确禁止）。游戏之间用发丝线分段。
  -->
  <div class="help">
    <div class="help-bar">
      <input v-model="keyword" class="input grow" placeholder="搜索游戏…" aria-label="搜索游戏" />
      <span class="hint help-count">共 {{ filtered.length }} / {{ PRESETS.length }} 个游戏</span>
    </div>

    <div v-if="copyError" class="alert alert-warn">
      <span class="grow">{{ copyError }}</span>
      <button class="btn btn-ghost btn-sm" @click="copyError = ''">关闭</button>
    </div>

    <!-- 地址还没分配时（卡在连接阶段）就是「空数据」态 -->
    <div v-if="!address" class="alert alert-warn">
      虚拟地址还没分配好，等房间状态变成「虚拟网络已连接」后这里会自动出现可复制的地址。
    </div>

    <ul v-if="filtered.length > 0" class="help-list">
      <li v-for="g in filtered" :key="g.id" class="help-item">
        <div class="help-head">
          <span class="help-name">{{ g.name }}</span>
          <span class="badge badge-neutral">
            {{ g.proto }}<template v-if="g.ports.length > 0"> · {{ g.ports.join(' / ') }}</template>
          </span>
        </div>

        <div class="help-line">
          <span class="help-role">房主</span>
          <span class="help-text">{{ g.hostSteps }}</span>
        </div>
        <div class="help-line">
          <span class="help-role">玩家</span>
          <span class="help-text">{{ g.playerSteps }}</span>
        </div>
        <p v-if="g.note" class="help-note">{{ g.note }}</p>

        <div class="help-addr">
          <!-- 不用端口的游戏（只显示房间列表）给一条完整地址就够 -->
          <template v-if="g.ports.length === 0">
            <div class="help-addr-row">
              <span class="code grow">{{ address ?? '等待分配…' }}</span>
              <button class="btn btn-sm" :disabled="!address" @click="copy(addressFor(g), `ip-${g.id}`)">
                {{ copied === `ip-${g.id}` ? '已复制' : '复制地址' }}
              </button>
            </div>
          </template>
          <template v-else>
            <div v-for="port in g.ports" :key="port" class="help-addr-row">
              <span class="code grow">{{ address ? addressFor(g, port) : '等待分配…' }}</span>
              <button class="btn btn-sm" :disabled="!address" @click="copy(addressFor(g, port), `${g.id}-${port}`)">
                {{ copied === `${g.id}-${port}` ? '已复制' : '复制' }}
              </button>
            </div>
            <div v-if="g.ports.length > 1" class="help-addr-row">
              <button
                class="btn btn-sm btn-ghost"
                :disabled="!address"
                @click="copy(g.ports.map((p) => addressFor(g, p)).join('\n'), `all-${g.id}`)"
              >
                {{ copied === `all-${g.id}` ? '已复制全部端口' : '复制全部端口地址' }}
              </button>
            </div>
          </template>
        </div>
      </li>
    </ul>

    <div v-else class="empty">没有匹配的游戏，换个关键词试试。</div>

    <p class="hint">
      通用说明：有些游戏只显示「局域网房间列表」，这种情况不需要手填地址 ——
      只要大家都进了同一个 McLink 房间，游戏里就能直接看到对方的房间。
      端口如果和游戏里显示的不一致，以游戏内显示的为准。
    </p>
  </div>
</template>

<style scoped>
.help {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  min-width: 0;
}
.help-bar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  min-width: 0;
}
/* 计数不参与换行：它是搜索框的注脚，换行会让搜索框高度跳动 */
.help-count {
  flex: none;
  white-space: nowrap;
}
/* 游戏之间只隔一条发丝线：9 个游戏各占一张卡的话，弹层里会变成一叠盒子 */
.help-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.help-item {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3) 0;
  min-width: 0;
}
.help-item + .help-item {
  border-top: 1px solid var(--line-soft);
}
.help-item:first-child {
  padding-top: 0;
}
.help-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.help-name {
  color: var(--ink);
  font-size: var(--fs-sm);
  font-weight: 650;
}
/* 角色标签固定一列宽：两行步骤的左边缘因此对齐，扫读时不用重新找起点 */
.help-line {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: var(--s-2);
}
.help-role {
  color: var(--ink-2);
  font-size: var(--fs-xs);
  font-weight: 650;
  padding-top: 2px;
}
.help-text {
  color: var(--ink-2);
  font-size: var(--fs-sm);
  line-height: var(--lh-snug);
  overflow-wrap: anywhere;
}
.help-note {
  margin: 0;
  color: var(--warn);
  font-size: var(--fs-xs);
  line-height: var(--lh-snug);
}
.help-addr {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.help-addr-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
</style>
