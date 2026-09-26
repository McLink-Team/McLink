<script setup lang="ts">
/**
 * Android 外壳 —— 「暖纸台」横向骨架在窄竖屏上的转置版。
 *
 * ## 为什么另写一个外壳，而不是复用 client/src/App.vue
 *
 * 桌面外壳里有四件**只对 Electron 成立**的东西：
 *   · `TitleBar`  —— 自绘标题栏，带最小化/最大化/关闭三个窗口按钮（Android 是全屏 Activity）；
 *   · `ElevationBanner` —— Windows UAC 提权横幅；
 *   · `CloseConfirm` —— 主进程在关闭窗口时问"退出还是最小化到托盘"；
 *   · `OnboardingWizard` + `LogPanel` —— 桌面首次使用向导与内核日志面板。
 *
 * 这些不是"移动端暂时没接"，而是**在 Android 上不存在对应物**。把它们渲染出来的结果
 * 是一排点了没反应的控件，正好踩中用户要求的反面（"不需要的入口直接不出现"）。
 *
 * 所以这里换掉的**只有外壳**：里面的每一屏都还是 `client/src` 的那些组件
 * （LoginPage / CreateJoin / RoomPage / PublicPlaza / VerifyEmail），
 * 它们读的是同一个 `client/src/lib/store.ts`、用的是同一份令牌 ——
 * 也就是说暖纸台世界、文案、交互**一处都没有第二份实现**。
 *
 * ## 保留 `app-shell` 这个类名（不要改）
 *
 * `client/src/styles.css` 里那套组件样式（房间页、卡片、按钮、输入框、表格…）
 * **大半写成 `.app-shell .xxx` 后代选择器**。App.vue 的注释里记着上一次踩坑：
 * 把它改名会让那些规则全部失效，表现是文字挤成一坨、间距全丢。
 * 这里沿用同一个类名，再挂一个 `.mobile-shell` 承载移动端覆盖（见 mobile-shell.css）。
 *
 * ## 与桌面骨架的对应关系
 *
 *   桌面 .deck（横向：rail + 一列）   → 这里的顶栏 + .mobile-scroll + .mobile-dock
 *   桌面 #deck-actions（页面的主动作）→ 还是同一个 id，只是从右下角挪到 dock 上沿
 *   桌面 .deck-foot（版本号一行）     → 移进「设置」页的「关于」（手机上屏幕高度比版本号金贵）
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  bootstrap,
  clearError,
  clearKicked,
  clientState,
  hasRoom,
  isOnline,
  mustVerifyEmail,
} from '../../../client/src/lib/store.ts';
import LoginPage from '../../../client/src/pages/LoginPage.vue';
import CreateJoin from '../../../client/src/components/CreateJoin.vue';
import RoomPage from '../../../client/src/pages/RoomPage.vue';
import PublicPlaza from '../../../client/src/components/PublicPlaza.vue';
import VerifyEmail from '../../../client/src/components/VerifyEmail.vue';
import MobileTabBar, { type MobileTab } from './MobileTabBar.vue';
import MobileSettingsPage from './MobileSettingsPage.vue';
import { installKeyboardInset } from './mobile-keyboard.ts';
import { installMessageNotifier, maybeAskNotifyPermission, cancelPendingNotifications } from './message-notify.ts';

const tab = ref<MobileTab>('home');
const booting = ref(true);

/** 这一屏的标题 —— 与桌面 App.vue 的 pageTitle 同一条规则，同一些文案 */
const PAGE_TITLE: Record<MobileTab, string> = {
  home: '联机',
  plaza: '公开大厅',
  settings: '设置',
};

const loggedIn = computed(() => clientState.user !== null);
const coreState = computed(() => clientState.coreStatus?.state ?? 'stopped');

const pageTitle = computed(() => {
  // 房间进不去的时候，玩家最想确认的是"我在哪个房" —— 标题直接显示房间名
  if (loggedIn.value && hasRoom.value && tab.value === 'home') return clientState.session?.room.name ?? PAGE_TITLE.home;
  if (!loggedIn.value) return tab.value === 'plaza' ? PAGE_TITLE.plaza : 'McLink';
  return PAGE_TITLE[tab.value];
});

/**
 * 状态点那一行字。
 *
 * 与桌面 App.vue 的 statusLabel 同构，但**多了一档** `'未接入'`：
 * 里程碑 1 的内核是空实现，`coreStatus.state === 'error'` 且房间存在。
 * 桌面那句「连接异常」在手机上说不清"为什么"，而这一档要说清的是
 * "房间是好的，是这台设备还不能联网"——否则玩家会以为是房间坏了。
 */
const statusLabel = computed(() => {
  if (!loggedIn.value) return '未登录';
  if (clientState.session) {
    if (coreState.value === 'running') return `已联机 · ${clientState.session.room.code}`;
    if (coreState.value === 'error') return '本机未接入网络';
    return '正在建立连接…';
  }
  if (coreState.value === 'running') return '虚拟网络已就绪';
  return '未联机';
});

const ledClass = computed(() => {
  if (!loggedIn.value) return 'led-signal';
  if (coreState.value === 'running') return 'led-ok';
  // 房间在但内核没起来：这是"已知的能力缺口"，不是故障 —— 用 signal 而不是 danger，
  // 免得玩家以为客户端坏了，跑去重装。
  if (clientState.session) return 'led-signal';
  return 'led-signal';
});

/* -------------------------------------------------- 「里程碑 1」的诚实话 */

const NOTICE_KEY = 'mclink.android.mi1NoticeDismissed';
const noticeDismissed = ref(true);

function dismissNotice(): void {
  noticeDismissed.value = true;
  try {
    localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    /* 隐私模式下写不进去：那就在本次会话里记住即可 */
  }
}

/**
 * 进房之前就把能力边界说清楚。
 *
 * 为什么值得占一屏顶部的一块：不说的话，玩家会建房 → 拿到地址 → 进游戏 → 连不上，
 * 然后依次怀疑游戏、房主、网络，最后才怀疑客户端。在**做那件事之前**讲清楚，
 * 是这里唯一能省下那段排查时间的地方。可以在「设置」里重新看到这条说明。
 */
const showNotice = computed(() => !noticeDismissed.value && loggedIn.value && hasRoom.value);

/* ---------------------------------------------------------------- 生命周期 */

function onKeydown(event: KeyboardEvent): void {
  // Android 有系统返回键，但它不会发 DOM keydown；这里保留 ESC 是为了
  // 带键盘的平板/模拟器上仍能退回「联机」（与桌面同一手感）。
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  if (event.key === 'Escape' && tab.value !== 'home') tab.value = 'home';
}

/**
 * 房间进出的落点：进房 → 回到「联机」这一屏（房间内容就在那里），
 * 退房/被踢 → 若还停在房间页，也退回同一屏，不留空页面。
 *
 * 顺带管两件与"进出房间"绑在一起的事：
 *   · **进房**时申请一次通知权限（时机理由见 message-notify.ts：刚做完
 *     "我要跟人联机"这件事之后，"有人说话提醒你"才有上下文）；
 *   · **退房**时清掉还在合并窗口里、尚未发出的通知 —— 否则退房几秒后
 *     会弹出一条点进去已经不在那个房间的通知。
 */
watch(hasRoom, (inRoom) => {
  tab.value = 'home';
  if (inRoom) void maybeAskNotifyPermission();
  else cancelPendingNotifications();
});

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);

  /*
   * 软键盘适配：算 --keyboard-inset，并在键入时收起底部导航。
   * 放在 bootstrap() 之前 —— 它先把 visualViewport 的监听挂上，
   * 免得初始化过程中出现的输入框（验证邮箱页）已经聚焦了才开始算。
   */
  installKeyboardInset();

  /*
   * 新消息提醒。**只装一次**（每装一次就多一个 onRoomChat 订阅者，通知会重复发）。
   *
   * 「正看着那个房间」的判据：停在这一屏 + 就是这个房间。
   * 这里刻意只判到"房间这一屏"，不去问聊天面板有没有被折叠 ——
   * 桌面端的规则也是房间级的（"人在看这个房间就不弹"），两端语义保持一致，
   * 以后才不会出现"桌面不弹、手机弹"这种对不上的行为。
   * 应用是否在后台由通知层自己看 document.hidden，这里不重复判。
   */
  installMessageNotifier({
    isViewingRoom: (roomId) => tab.value === 'home' && clientState.session?.room.id === roomId,
    onOpenRoom: () => {
      // 回到房间那一屏（房间内容就铺在「联机」里），与桌面点通知的行为一致
      tab.value = 'home';
    },
  });

  try {
    noticeDismissed.value = localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    noticeDismissed.value = false;
  }
  try {
    await bootstrap();
  } finally {
    // 无论 bootstrap 成败都要撤掉 splash：失败的原因已经落在 clientState.lastError 上，
    // 卡在「正在初始化…」会让玩家永远看不到那句原因。
    booting.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  // 外壳卸载时把还没发出去的合并通知清掉，避免弹出一条点不开的通知
  cancelPendingNotifications();
});
</script>

<template>
  <!--
    `data-platform="android"` 与桌面外壳的 `:data-platform="platform"` 对齐：
    桌面那份从 platform.ts 读（可能是 darwin/win32/linux），这里恒为 android ——
    移动端外壳不存在"在别的平台上跑"的可能，写成字面量比多引一个模块更直白。
    CSS 里目前还没有 [data-platform] 规则，这个属性是留给"某个平台专属微调"的挂钩。
  -->
  <div class="app-shell mobile-shell" data-platform="android">
    <header class="mobile-topbar">
      <h1 class="mobile-topbar-title truncate">{{ pageTitle }}</h1>
      <span class="mobile-topbar-status">
        <span class="led" :class="ledClass" />
        <span>{{ statusLabel }}</span>
      </span>
    </header>

    <div class="mobile-scroll">
      <div v-if="booting" class="mobile-splash">
        <span class="spinner" />
        <span class="hint">正在初始化…</span>
      </div>

      <!-- 未登录：「联机」是登录卡，「大厅」照样能看（/rooms/public 是匿名接口） -->
      <template v-else-if="!loggedIn">
        <section v-if="tab === 'plaza'" class="card stack">
          <PublicPlaza :can-join="false" />
        </section>
        <LoginPage v-else />
      </template>

      <!-- 平台要求验证邮箱时先过这一关：服务端会拒绝未验证账号建房/进房 -->
      <VerifyEmail v-else-if="mustVerifyEmail" />

      <template v-else>
        <div v-if="showNotice" class="alert alert-warn">
          <span class="grow">
            这台手机还没接入虚拟网络内核，<strong>不能直接进游戏联机</strong>。建房、拿加入码与联机地址、
            加入房间、看成员都可用 —— 把加入码发给装了 Windows 客户端的朋友，联机由他们那台承担。
          </span>
          <button class="btn btn-sm btn-ghost" type="button" @click="dismissNotice()">知道了</button>
        </div>

        <div v-if="clientState.kickedReason" class="alert alert-danger">
          <span class="grow">{{ clientState.kickedReason }}</span>
          <button class="btn btn-sm btn-ghost" type="button" @click="clearKicked()">知道了</button>
        </div>
        <div v-if="clientState.lastError" class="alert alert-warn">
          <span class="grow">{{ clientState.lastError }}</span>
          <button class="btn btn-sm btn-ghost" type="button" @click="clearError()">关闭</button>
        </div>

        <!-- 开好房就直接铺房间内容；没房才是"开房前的那一屏"（与桌面同一条规则） -->
        <RoomPage v-if="tab === 'home' && hasRoom" />
        <CreateJoin v-else-if="tab === 'home'" @open-settings="tab = 'settings'" />

        <section v-else-if="tab === 'plaza'" class="card stack">
          <PublicPlaza />
        </section>

        <MobileSettingsPage v-else />
      </template>
    </div>

    <!--
      底部 dock：上沿是「这一屏的主动作」，下面是三项导航。
      #deck-actions 这个 id 必须叫这个 —— CreateJoin.vue 用
      `<Teleport defer to="#deck-actions">` 把「加入 / 创建」胶囊送进来，
      改了名字那个 Teleport 就找不到目标，建房按钮会整块消失。
    -->
    <div class="mobile-dock">
      <div id="deck-actions" class="deck-actions" />
      <MobileTabBar
        :active="tab"
        :signed-in="loggedIn"
        :in-room="hasRoom"
        :online="isOnline"
        @select="tab = $event"
      />
    </div>
  </div>
</template>

<style scoped>
/* 移动端自己的 splash：桌面那份在 App.vue 的 scoped 里，这里够不着，也不该去够
 * （那是桌面外壳的样式）。三行而已，重复的成本低于把它提成全局的成本。 */
.mobile-splash {
  flex: 1;
  display: grid;
  place-items: center;
  gap: var(--s-3);
  min-height: 240px;
}
</style>
