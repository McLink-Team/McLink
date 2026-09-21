<script setup lang="ts">
/** 设置：本机名称、监听端口、权限状态与运行路径（主控地址固定，不可改） */
import { computed, onMounted, ref } from 'vue';
import { copyText } from '../lib/clipboard.ts';
import { clientState, relaunchElevated, setDevice, logout } from '../lib/store.ts';
import { MASTER_URL, USING_DEV_MASTER, getMasterUrl } from '../lib/api.ts';
import { reopenOnboarding } from '../lib/onboarding.ts';
import type { AppInfo } from '../lib/bridge.ts';

const info = ref<AppInfo | null>(null);
const device = ref(clientState.deviceName);
const listenPort = ref(clientState.listenPort);
const saved = ref(false);

const master = computed(() => getMasterUrl());
const isDevMaster = USING_DEV_MASTER;
void MASTER_URL;

onMounted(async () => {
  info.value = await window.mclink.info();
});

function save(): void {
  setDevice(device.value.trim());
  clientState.listenPort = Number(listenPort.value) || clientState.listenPort;
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function copy(text: string): Promise<void> {
  await copyText(text);
}

function openLogDir(): void {
  const dir = info.value?.logDir;
  if (dir) void window.mclink.openPath(dir);
}

function openDataDir(): void {
  const dir = info.value?.dataDir;
  if (dir) void window.mclink.openPath(dir);
}
</script>

<template>
  <div class="view">
    <div v-if="saved" class="alert alert-ok">设置已保存。</div>

    <!-- 权限状态：Windows 上创建虚拟网卡必须提权 -->
    <div v-if="info && !info.elevated" class="alert alert-warn">
      <div class="grow">
        <div style="font-weight: 600">当前未以管理员身份运行</div>
        <div class="hint">
          EasyTier 需要管理员权限才能创建虚拟网卡（wintun）。不提权的话可以登录、建房，但成员之间无法真正连通。
        </div>
      </div>
      <button class="btn btn-primary btn-sm" @click="relaunchElevated()">以管理员身份重启</button>
    </div>
    <div v-else-if="info" class="alert alert-ok">已以管理员身份运行，虚拟网卡可用。</div>

    <div class="grid-2">
      <div class="card stack">
        <div style="font-weight: 620">账号与身份</div>
        <div class="field">
          <label class="label">服务器</label>
          <div class="readonly-line mono" :title="master">{{ master }}</div>
          <div v-if="isDevMaster" class="hint" style="color: var(--warn)">
            本地开发地址（打包时未注入 VITE_MCLINK_MASTER）。
          </div>
          <div v-else class="hint">客户端固定连接官方主控，不支持自建主控，也不允许修改。</div>
        </div>
        <div class="field">
          <label class="label">本机名称</label>
          <input v-model="device" class="input" />
          <div class="hint">会出现在房主的成员列表里。</div>
        </div>
        <div class="field">
          <label class="label">本机监听端口</label>
          <input v-model.number="listenPort" class="input" type="number" min="1024" max="65535" />
          <div class="hint">用于其它成员直连你；已在启动时自动选了一个空闲端口，一般不用改。</div>
        </div>
        <div class="row">
          <button class="btn btn-primary" @click="save">保存</button>
          <button class="btn btn-ghost" @click="logout()">退出登录</button>
          <button class="btn btn-ghost" title="重新看一遍 4 步上手指引" @click="reopenOnboarding()">
            新手引导
          </button>
        </div>
      </div>

      <div class="card stack">
        <div style="font-weight: 620">运行环境</div>
        <div v-if="info">
          <div class="row-between">
            <span class="faint">客户端版本</span><span class="mono">{{ info.version }}</span>
          </div>
          <div class="row-between">
            <span class="faint">平台</span><span class="mono">{{ info.platform }}/{{ info.arch }}</span>
          </div>
          <div class="row-between">
            <span class="faint">easytier-core</span>
            <span class="mono truncate" style="max-width: 320px" :title="info.coreBin">{{ info.coreBin }}</span>
          </div>
          <div class="row-between">
            <span class="faint">核心是否就绪</span>
            <span class="badge" :class="clientState.coreStatus?.coreBinExists ? 'badge-ok' : 'badge-danger'">
              {{ clientState.coreStatus?.coreBinExists ? '已找到' : '缺失' }}
            </span>
          </div>
          <div class="row-between">
            <span class="faint">easytier-cli</span>
            <span class="badge" :class="clientState.coreStatus?.cliBinExists ? 'badge-ok' : 'badge-warn'">
              {{ clientState.coreStatus?.cliBinExists ? '已找到' : '缺失' }}
            </span>
          </div>
          <hr class="divider" style="margin: 10px 0" />
          <div class="row-between">
            <span class="faint">数据目录</span>
            <button class="btn btn-sm btn-ghost" @click="openDataDir">打开</button>
          </div>
          <div class="mono faint truncate" style="font-size: var(--fs-xs)">{{ info.dataDir }}</div>
          <div class="row-between" style="margin-top: 8px">
            <span class="faint">日志目录</span>
            <button class="btn btn-sm btn-ghost" @click="openLogDir">打开</button>
          </div>
          <div class="mono faint truncate" style="font-size: var(--fs-xs)">{{ info.logDir }}</div>
        </div>
        <div v-else class="empty">读取中…</div>
      </div>
    </div>

    <div class="card">
      <div style="font-weight: 620; margin-bottom: 8px">关于</div>
      <div class="hint stack">
        <span>
          本客户端通过调用 EasyTier 核心（LGPL-3.0）建立虚拟局域网，不修改其源码；
          每个房间是一个独立网络，房间之间彼此不可见。
        </span>
        <span>
          平台不开放自建主控：服务器地址在打包时已固定写入客户端，
          这样能避免玩家被诱导连接到假冒主控，也保证房间凭证只由官方主控签发。
        </span>
        <span>
          联机小贴士：房主先在游戏里「对局域网开放」，再创建房间；玩家用「直接连接」输入联机地址即可。
          如果延迟高，可以在建房时换个区域，或让房主允许 P2P 直连。
        </span>
        <span>《我的世界》为 Mojang 商标，本平台与 Mojang 无关联，仅供合法联机使用。</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 只读的服务器地址，样式上明确区别于输入框 */
.readonly-line {
  height: 36px;
  display: flex;
  align-items: center;
  padding: 0 var(--s-3);
  border-radius: var(--r-sm);
  border: 1px dashed var(--border-strong);
  background: var(--surface-hair);
  color: var(--text-dim);
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
</style>
