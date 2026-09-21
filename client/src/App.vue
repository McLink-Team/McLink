<script setup lang="ts">
/**
 * 客户端外壳 —— 窄窗口 + 单列子页 + 自绘标题栏 + 底部状态行。
 *
 * 结构参照 MCTier 这类桌面工具，而不是宽屏仪表盘：窗口默认 520×780，
 * 内容一列排下来，不横向铺开。
 *
 * 导航是一个小栈：主页 / 房间 / 设置 / 日志。**返回不会断开房间**——
 * 房间连接是常驻的，返回只是不看那个页面；主页顶部会留一条"正在联机"的窄条。
 * ESC 返回上一页（与 MCTier 的习惯一致）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { copyText } from './lib/clipboard.ts';
import { bootstrap, clearError, clearKicked, clientState, hasRoom, isOnline, mustVerifyEmail } from './lib/store.ts';
import { onboardingVisible } from './lib/onboarding.ts';
import TitleBar from './components/TitleBar.vue';
import LoginPage from './pages/LoginPage.vue';
import CreateJoin from './components/CreateJoin.vue';
import RoomPage from './pages/RoomPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import LogPanel from './components/LogPanel.vue';
import OnboardingWizard from './components/OnboardingWizard.vue';
import VerifyEmail from './components/VerifyEmail.vue';

type View = 'home' | 'room' | 'settings' | 'logs';

const view = ref<View>('home');
const booting = ref(true);
const appVersion = ref('');

const loggedIn = computed(() => clientState.user !== null);
const coreState = computed(() => clientState.coreStatus?.state ?? 'stopped');

/** 标题栏里那一行状态字：玩家最关心"现在通不通" */
const statusLabel = computed(() => {
  if (!clientState.user) return '未登录';
  if (clientState.session) {
    if (coreState.value === 'running') return `已联机 · ${clientState.session.room.name}`;
    if (coreState.value === 'error') return '连接异常';
    return '正在建立连接…';
  }
  if (coreState.value === 'running') return '虚拟网络已就绪';
  return '未联机';
});

/** 底部提示行：只在能返回时提示 ESC，不常驻占地方 */
const escHint = computed(() => (view.value === 'home' ? '' : '按 ESC 返回上一页'));

const navItems: Array<{ key: View; label: string }> = [
  { key: 'home', label: '联机' },
  { key: 'room', label: '房间' },
  { key: 'settings', label: '设置' },
  { key: 'logs', label: '日志' },
];

function goto(next: View): void {
  if (next === 'room' && !hasRoom.value) return;
  view.value = next;
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  // 正在输入框里打字时不拦截 ESC，避免顶掉玩家的输入状态
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  if (event.key === 'Escape' && view.value !== 'home') view.value = 'home';
}

/**
 * 房间进出时的落点：
 *   · 进房 → 直接落到房间页。玩家接下来的动作一定是「把联机地址发给朋友」，
 *     停在主页还要先点一下「返回房间」才能看到地址，是白多一步；
 *   · 退房/被踢 → 若正停在房间页，退回主页，避免留在一个空页面上。
 */
watch(hasRoom, (value) => {
  if (value) view.value = 'room';
  else if (view.value === 'room') view.value = 'home';
});

function copy(text: string): void {
  void copyText(text);
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  const info = await window.mclink.info();
  appVersion.value = info.version;
  await bootstrap();
  booting.value = false;
});

onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="app-shell">
    <TitleBar :state="coreState" :label="statusLabel" />

    <div v-if="booting" class="boot">
      <span class="spinner" />
      <span class="muted">正在初始化…</span>
    </div>

    <LoginPage v-else-if="!loggedIn" :version="appVersion" />

    <!-- 平台要求验证邮箱时先过这一关：服务端会拒绝未验证账号建房/进房 -->
    <VerifyEmail v-else-if="mustVerifyEmail" />

    <template v-else>
      <div class="app-body">
        <!-- 常驻的"正在联机"窄条：返回主页后依然知道自己还在房间里 -->
        <button v-if="hasRoom && view !== 'room'" class="room-strip" type="button" @click="goto('room')">
          <span class="led" :class="isOnline ? 'led-ok led-live' : 'led-signal'" />
          <span class="truncate">{{ clientState.session?.room.name }}</span>
          <span class="mono faint">{{ clientState.session?.room.code }}</span>
          <span class="grow" />
          <span class="faint nowrap">返回房间</span>
        </button>

        <div v-if="clientState.kickedReason" class="alert alert-danger">
          <span class="grow">{{ clientState.kickedReason }}</span>
          <button class="btn btn-sm btn-ghost" type="button" @click="clearKicked()">知道了</button>
        </div>
        <div v-if="clientState.lastError" class="alert alert-warn">
          <span class="grow">{{ clientState.lastError }}</span>
          <button class="btn btn-sm btn-ghost" type="button" @click="clearError()">关闭</button>
        </div>

        <CreateJoin v-if="view === 'home'" :version="appVersion" @open-settings="goto('settings')" />
        <RoomPage v-else-if="view === 'room'" />
        <SettingsPage v-else-if="view === 'settings'" />
        <LogPanel v-else :logs="clientState.coreLogs" @copy="copy" />
      </div>

      <footer class="app-foot">
        <nav class="foot-nav">
          <button
            v-for="item in navItems"
            :key="item.key"
            type="button"
            class="foot-tab"
            :class="{ active: view === item.key }"
            :disabled="item.key === 'room' && !hasRoom"
            @click="goto(item.key)"
          >
            {{ item.label }}
            <span
              v-if="item.key === 'room' && hasRoom"
              class="foot-dot"
              :class="isOnline ? 'dot-ok' : 'dot-warn'"
            />
          </button>
        </nav>
        <div class="foot-meta faint">
          <span class="truncate">{{ escHint || clientState.user?.displayName || '' }}</span>
          <!-- 主屏自己底部居中带一行版本号，这里就不再重复 -->
          <span v-if="view !== 'home'" class="mono nowrap">McLink v{{ appVersion }}</span>
        </div>
      </footer>
    </template>

    <!-- 首次使用向导：整屏遮罩；「不再显示」后可在设置页重新打开 -->
    <OnboardingWizard v-if="!booting && onboardingVisible" />
  </div>
</template>

<style scoped>
.boot {
  flex: 1;
  display: grid;
  place-items: center;
  gap: var(--s-3);
  grid-auto-flow: row;
}

/* 窄窗里内容一列排下来；横向不铺开 */
.app-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--s-3) var(--s-3) var(--s-4);
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

/* 常驻的"正在联机"窄条 */
.room-strip {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  padding: 7px var(--s-3);
  border: 1px solid var(--link-line);
  border-radius: var(--r-sm);
  background: var(--link-wash);
  color: var(--paper);
  font-size: var(--fs-sm);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--dur-fast) var(--ease);
}
.room-strip:hover {
  border-color: var(--link);
}

/* 底部：主导航 + ESC 提示 + 版本号（一行装完） */
.app-foot {
  flex: none;
  border-top: 1px solid var(--rule);
  background: var(--ink-950);
}
.foot-nav {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}
.foot-tab {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 38px;
  border: 0;
  background: transparent;
  color: var(--paper-faint);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.foot-tab:hover:not(:disabled) {
  color: var(--paper);
  background: var(--surface-hair);
}
.foot-tab.active {
  color: var(--signal);
}
/* 当前页用一条顶部细线标记，而不是整块底色 */
.foot-tab.active::before {
  content: '';
  position: absolute;
  top: 0;
  left: 24%;
  right: 24%;
  height: 1px;
  background: var(--signal);
}
.foot-tab:disabled {
  opacity: 0.34;
  cursor: not-allowed;
}
.foot-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}
.foot-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  padding: 0 var(--s-4) 6px;
  font-size: var(--fs-xs);
  min-height: 17px;
}
</style>
