<script setup lang="ts">
/**
 * 客户端外壳 —— 「暖纸台」的横向骨架。
 *
 * 结构取自用户指定的参照（一个 Flutter 桌面启动器）：
 *   左侧 76px 图标栏 ｜ 右侧一列：标题条 → 页面 → 底部一行（版本/系统 + 动作胶囊）
 *
 * 两处按 McLink 的事实做的改动：
 *   · 参照的"服务器"这一栏在我们这里是**公开大厅**（用户明确指的那一项）；
 *   · 图标栏只有四个去处（联机/大厅/收藏/设置）。房间**不是**一栏 —— 开好房就直接
 *     把房间内容铺在「联机」这一屏里（用户的要求），退房再回到开房前的那一屏。
 *
 * 底部那一行右侧留了一个传送点 `#deck-actions`：主页把「创建 / 加入」胶囊送到那里，
 * 于是无论哪个页面在渲染，动作都在同一个位置、同一只手上。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { copyText } from './lib/clipboard.ts';
import {
  bootstrap,
  clearError,
  clearKicked,
  clientState,
  hasRoom,
  isOnline,
  mustVerifyEmail,
} from './lib/store.ts';
import { onboardingVisible } from './lib/onboarding.ts';
import AppRail, { type RailKey } from './components/AppRail.vue';
import TitleBar from './components/TitleBar.vue';
import ElevationBanner from './components/ElevationBanner.vue';
import CloseConfirm from './components/CloseConfirm.vue';
import LoginPage from './pages/LoginPage.vue';
import CreateJoin from './components/CreateJoin.vue';
import RoomPage from './pages/RoomPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import PublicPlaza from './components/PublicPlaza.vue';
import RoomShortcuts from './components/RoomShortcuts.vue';
import LogPanel from './components/LogPanel.vue';
import OnboardingWizard from './components/OnboardingWizard.vue';
import VerifyEmail from './components/VerifyEmail.vue';

type View = RailKey | 'logs';

const view = ref<View>('home');
const booting = ref(true);
const appVersion = ref('');
const osDetail = ref('');

const loggedIn = computed(() => clientState.user !== null);
const coreState = computed(() => clientState.coreStatus?.state ?? 'stopped');

const PAGE_TITLE: Record<View, string> = {
  home: '联机',
  plaza: '公开大厅',
  bookmarks: '收藏',
  settings: '设置',
  logs: '日志',
};

/** 标题条左边那行字：房间在的时候它就是房间名（用户最想确认"我在哪个房"） */
const pageTitle = computed(() =>
  hasRoom.value && view.value === 'home' ? (clientState.session?.room.name ?? '联机') : PAGE_TITLE[view.value],
);

/** 标题条右边那行状态：玩家最关心"现在通不通" */
const statusLabel = computed(() => {
  if (clientState.session) {
    if (coreState.value === 'running') return `已联机 · ${clientState.session.room.code}`;
    if (coreState.value === 'error') return '连接异常';
    return '正在建立连接…';
  }
  if (coreState.value === 'running') return '虚拟网络已就绪';
  return '未联机';
});

/** 底部左侧：版本 + 系统（参照稿那个位置放的就是这两样） */
const bottomMeta = computed(() => {
  const parts = [`McLink v${appVersion.value}`];
  if (osDetail.value) parts.push(osDetail.value);
  return parts.join(' · ');
});

/** 图标栏高亮：日志页挂在「设置」上（它是排查用的，属于设置那一族） */
const railActive = computed<RailKey>(() => (view.value === 'logs' ? 'settings' : view.value));

function goto(next: View): void {
  view.value = next;
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  // 正在输入框里打字时不拦截 ESC，避免顶掉玩家的输入
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  if (event.key === 'Escape' && view.value !== 'home') view.value = 'home';
}

/**
 * 房间进出的落点：进房 → 回到「联机」这一屏（房间内容就在那里），
 * 退房/被踢 → 若还停在房间页，也退回同一屏，不留空页面。
 */
watch(hasRoom, () => {
  view.value = 'home';
});

function copy(text: string): void {
  void copyText(text);
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  const info = await window.mclink.info();
  appVersion.value = info.version;
  osDetail.value = info.osDetail ?? '';
  await bootstrap();
  booting.value = false;
});

onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="app-root">
    <!--
      未提权横幅放在最上面：登录页、验证邮箱页、主界面每一屏都能看到 ——
      玩家没提权时最常停在登录页，放里面等于看不到。
    -->
    <ElevationBanner />

    <div v-if="booting" class="splash">
      <span class="spinner" />
      <span class="hint">正在初始化…</span>
    </div>

    <LoginPage v-else-if="!loggedIn" :version="appVersion" />

    <!-- 平台要求验证邮箱时先过这一关：服务端会拒绝未验证账号建房/进房 -->
    <VerifyEmail v-else-if="mustVerifyEmail" />

    <div v-else class="deck">
      <AppRail
        :active="railActive"
        :in-room="hasRoom"
        :online="isOnline"
        :update-available="Boolean(clientState.update)"
        :user-name="clientState.user?.displayName"
        @select="goto"
      />

      <div class="deck-column">
        <TitleBar :title="pageTitle" :state="coreState" :label="statusLabel" />

        <div class="deck-scroll">
          <!-- 常驻的"正在联机"条：离开「联机」那一屏后依然知道自己还在房间里 -->
          <button
            v-if="hasRoom && view !== 'home'"
            class="room-strip"
            type="button"
            @click="goto('home')"
          >
            <span class="led" :class="isOnline ? 'led-ok' : 'led-signal'" />
            <span class="truncate">{{ clientState.session?.room.name }}</span>
            <span class="mono faint">{{ clientState.session?.room.code }}</span>
            <span class="grow" />
            <span class="faint nowrap">回到房间</span>
          </button>

          <div v-if="clientState.kickedReason" class="alert alert-danger">
            <span class="grow">{{ clientState.kickedReason }}</span>
            <button class="btn btn-sm btn-ghost" type="button" @click="clearKicked()">知道了</button>
          </div>
          <div v-if="clientState.lastError" class="alert alert-warn">
            <span class="grow">{{ clientState.lastError }}</span>
            <button class="btn btn-sm btn-ghost" type="button" @click="clearError()">关闭</button>
          </div>

          <!-- 开好房就直接铺房间内容；没房才是"开房前的那一屏" -->
          <RoomPage v-if="view === 'home' && hasRoom" />
          <CreateJoin v-else-if="view === 'home'" @open-settings="goto('settings')" />

          <section v-else-if="view === 'plaza'" class="card pane stack">
            <PublicPlaza />
          </section>
          <section v-else-if="view === 'bookmarks'" class="card pane stack">
            <RoomShortcuts />
          </section>
          <SettingsPage v-else-if="view === 'settings'" />
          <LogPanel v-else :logs="clientState.coreLogs" @copy="copy" />
        </div>

        <footer class="deck-foot">
          <span class="deck-meta mono">{{ bottomMeta }}</span>
          <button
            v-if="view !== 'logs'"
            class="btn btn-sm btn-ghost deck-logs"
            type="button"
            @click="goto('logs')"
          >
            日志
          </button>
          <!-- 页面的主动作由页面自己 Teleport 到这里（见 CreateJoin.vue） -->
          <div id="deck-actions" class="deck-actions" />
        </footer>
      </div>
    </div>

    <!-- 关闭窗口时问"彻底退出还是最小化"（主进程发 app:ask-close 触发） -->
    <CloseConfirm />
    <!-- 首次使用向导：整屏遮罩；「不再显示」后可在设置页重新打开 -->
    <OnboardingWizard v-if="!booting && onboardingVisible" />
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--ground);
}

.splash {
  flex: 1;
  display: grid;
  place-items: center;
  gap: var(--s-3);
  grid-auto-flow: row;
}

/* 横向骨架：图标栏 + 右侧一列 */
.deck {
  flex: 1;
  display: flex;
  min-height: 0;
}

.deck-column {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 页面区自己滚动；底部那一行永远在 */
.deck-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--s-3) var(--s-5) var(--s-4);
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  min-height: 0;
}

.pane {
  padding: var(--s-5);
}

.room-strip {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  padding: 9px var(--s-3);
  font-size: var(--fs-sm);
  cursor: pointer;
  text-align: left;
}

/* 底部一行：左边版本/系统，右边页面动作 */
.deck-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 0 var(--s-5) var(--s-4);
  min-height: 56px;
}
.deck-meta {
  color: var(--ink-2);
  font-size: var(--fs-xs);
}
.deck-logs {
  margin-left: auto;
}
.deck-actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.deck-logs + .deck-actions {
  margin-left: 0;
}
</style>
