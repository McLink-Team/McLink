<script setup lang="ts">
/**
 * 设置 —— 只放玩家自己能决定的事：本机名称、本机端口、外观、日志、关于。
 *
 * 刻意不放任何服务器/主控信息：客户端连哪台机器不是玩家能改的，
 * 摆在这里只会让人以为自己可以填错。
 */
import { onMounted, ref } from 'vue';
import { currentTheme, setThemeChoice, themeChoice, type ThemeChoice } from '@mclink/shared';
import { clientState, relaunchElevated, setDevice, logout } from '../lib/store.ts';
import { reopenOnboarding } from '../lib/onboarding.ts';
import type { AppInfo } from '../lib/bridge.ts';

const info = ref<AppInfo | null>(null);
const device = ref(clientState.deviceName);
const listenPort = ref(clientState.listenPort);
const saved = ref(false);

/* ------------------------------------------------------------------ 外观 */
const THEME_OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
];
const theme = ref<ThemeChoice>(themeChoice());
const effective = ref(currentTheme());

function pickTheme(choice: ThemeChoice): void {
  theme.value = choice;
  // 共享层负责写盘 + 立刻改 <html data-theme> + 重新订阅系统变化
  setThemeChoice(choice);
  effective.value = currentTheme();
}

onMounted(async () => {
  info.value = await window.mclink.info();
});

function save(): void {
  setDevice(device.value.trim());
  clientState.listenPort = Number(listenPort.value) || clientState.listenPort;
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
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

    <div class="card stack">
      <div class="section-head">
        <span class="title">本机</span>
      </div>
      <div class="field">
        <label class="label">本机名称</label>
        <input v-model="device" class="input" />
        <div class="hint">会出现在房主的成员列表里，方便他认出你。</div>
      </div>
      <div class="field">
        <label class="label">本机监听端口</label>
        <input v-model.number="listenPort" class="input" type="number" min="1024" max="65535" />
        <div class="hint">用于其它成员直连你；已在启动时自动选了一个空闲端口，一般不用改。</div>
      </div>
      <div class="ops">
        <button class="btn btn-primary" type="button" @click="save">保存</button>
        <button class="btn btn-ghost" type="button" @click="logout()">退出登录</button>
        <button class="btn btn-ghost" type="button" title="重新看一遍上手指引" @click="reopenOnboarding()">
          新手引导
        </button>
      </div>
    </div>

    <div class="card stack">
      <div class="section-head">
        <span class="title">外观</span>
      </div>
      <div class="field">
        <label class="label">配色模式</label>
        <!-- 复用登录页 登录/注册 的那套分段控件，窄窗里三档也放得下 -->
        <div class="tabs" role="group" aria-label="配色模式">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.value"
            class="tab"
            :class="{ active: theme === opt.value }"
            type="button"
            :aria-pressed="theme === opt.value"
            @click="pickTheme(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="hint">
          默认跟随系统；钉住某一档后系统再切换也不会变。当前生效：{{ effective === 'light' ? '亮色' : '暗色' }}。
        </div>
      </div>
    </div>

    <div class="card stack">
      <div class="section-head">
        <span class="title">运行环境</span>
      </div>
      <div v-if="info" class="stack">
        <div class="row-between">
          <span class="faint">客户端版本</span><span class="mono">McLink {{ info.version }}</span>
        </div>
        <div class="row-between">
          <span class="faint">平台</span><span class="mono">{{ info.platform }}/{{ info.arch }}</span>
        </div>
        <div class="row-between">
          <span class="faint">联机核心</span>
          <span class="badge" :class="clientState.coreStatus?.coreBinExists ? 'badge-ok' : 'badge-danger'">
            {{ clientState.coreStatus?.coreBinExists ? '已就绪' : '缺失' }}
          </span>
        </div>
        <hr class="divider" />
        <div class="row-between">
          <span class="faint">日志目录</span>
          <button class="btn btn-sm btn-ghost" type="button" @click="openLogDir">打开</button>
        </div>
        <div class="mono faint path">{{ info.logDir }}</div>
        <div class="row-between">
          <span class="faint">数据目录</span>
          <button class="btn btn-sm btn-ghost" type="button" @click="openDataDir">打开</button>
        </div>
        <div class="mono faint path">{{ info.dataDir }}</div>
      </div>
      <div v-else class="empty">读取中…</div>
    </div>

    <div class="card stack">
      <div class="section-head">
        <span class="title">关于</span>
      </div>
      <div class="hint stack">
        <span>
          McLink 通过调用 EasyTier 核心（LGPL-3.0）建立虚拟局域网，不修改其源码；
          每个房间是一个独立网络，房间之间彼此不可见。
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
.path {
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}
</style>
