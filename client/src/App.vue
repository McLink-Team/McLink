<script setup lang="ts">
/**
 * 客户端外壳：一个窗口、三个视图（房间 / 设置 / 日志）。
 * 未登录时整屏显示登录页。
 * 不做路由：桌面客户端用标签切换比路由更直接，也少一层依赖。
 *
 * 迷你窗（`?mini=1`）复用同一份产物，但只渲染 MiniWindow ——
 * 它不 bootstrap（不需要登录态与本地核心控制），只读 localStorage 里的房间信息。
 */
import { computed, onMounted, ref } from 'vue';
import { clientState, clearError, clearKicked, isOnline, bootstrap, logout } from './lib/store.ts';
import { onboardingVisible } from './lib/onboarding.ts';
import { isMiniRenderer } from './lib/mini.ts';
import LoginPage from './pages/LoginPage.vue';
import RoomsPage from './pages/RoomsPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import LogPanel from './components/LogPanel.vue';
import CoreBadge from './components/CoreBadge.vue';
import MiniWindow from './components/MiniWindow.vue';
import OnboardingWizard from './components/OnboardingWizard.vue';

type View = 'rooms' | 'settings' | 'logs';

const isMini = isMiniRenderer();

const view = ref<View>('rooms');
const booting = ref(true);

const loggedIn = computed(() => clientState.user !== null);
const coreState = computed(() => clientState.coreStatus?.state ?? 'stopped');

onMounted(async () => {
  if (isMini) {
    booting.value = false;
    return;
  }
  await bootstrap();
  booting.value = false;
});

function copy(text: string): void {
  void navigator.clipboard.writeText(text);
}
</script>

<template>
  <MiniWindow v-if="isMini" />

  <template v-else>
    <div v-if="booting" class="aurora login-wrap">
      <div class="row">
        <span class="spinner" />
        <span class="muted">正在初始化…</span>
      </div>
    </div>

    <LoginPage v-else-if="!loggedIn" />

    <div v-else class="app-shell">
      <header class="app-header">
        <div class="brand">
          <span class="brand-mark" />
          <span>mclink</span>
        </div>

        <div class="tabs">
          <button class="tab" :class="{ active: view === 'rooms' }" @click="view = 'rooms'">联机</button>
          <button class="tab" :class="{ active: view === 'settings' }" @click="view = 'settings'">设置</button>
          <button class="tab" :class="{ active: view === 'logs' }" @click="view = 'logs'">日志</button>
        </div>

        <div class="grow" />

        <CoreBadge v-if="isOnline" :state="coreState" :tunnel="clientState.peers.length" />
        <span v-else class="badge badge-neutral"><span class="dot dot-idle" />未连接</span>

        <span class="muted truncate" style="max-width: 180px">{{ clientState.user?.displayName }}</span>
        <button class="btn btn-ghost btn-sm" @click="logout()">退出</button>
      </header>

      <div class="app-body">
        <!-- 全局提示 -->
        <div v-if="clientState.kickedReason" class="alert alert-danger" style="margin-bottom: 12px">
          <span class="grow">{{ clientState.kickedReason }}</span>
          <button class="btn btn-ghost btn-sm" @click="clearKicked()">知道了</button>
        </div>
        <div v-if="clientState.lastError" class="alert alert-warn" style="margin-bottom: 12px">
          <span class="grow">{{ clientState.lastError }}</span>
          <button class="btn btn-ghost btn-sm" @click="clearError()">关闭</button>
        </div>

        <RoomsPage v-if="view === 'rooms'" />
        <SettingsPage v-else-if="view === 'settings'" />
        <LogPanel v-else :logs="clientState.coreLogs" @copy="copy" />
      </div>
    </div>

    <!-- 首次使用向导：整屏遮罩，与标签页无关；「不再显示」后可在设置页重新打开 -->
    <OnboardingWizard v-if="!booting && onboardingVisible" />
  </template>
</template>
