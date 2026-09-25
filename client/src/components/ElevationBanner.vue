<script setup lang="ts">
/**
 * 「不是管理员」的提示：**启动就弹窗**，关掉后留一条常驻横幅。
 *
 * 为什么从"只挂横幅"改成"先弹窗"（用户实测反馈）
 * ----------------------------------------------
 * 1) 横幅挂在设置页/顶部，玩家不一定会看到；而这件事的后果是**联机完全不可用**；
 * 2) 更糟的是判定曾经会误报：用 `runas /trustlevel:0x20000` 启动时完整性级别仍是
 *    High，界面显示"已以管理员身份运行，虚拟网卡可用"，而令牌其实是受限的 ——
 *    核心建不出虚拟网卡、以退出码 1 挂掉，玩家被引到完全错误的方向。
 * 现在主进程会同时看"受限令牌"这一项，并把原因（elevationReason）交给界面显示。
 *
 * 两个入口都给「以管理员身份重启」：那是复用现成的 relaunchElevated（走系统授权框），
 * 比让玩家自己找右键菜单更省事；弹窗文案里也写明了右键那条路。
 */
import { computed, onMounted, ref } from 'vue';
import { relaunchElevated } from '../lib/store.ts';
import type { AppInfo } from '../lib/bridge.ts';

const info = ref<AppInfo | null>(null);
const popupOpen = ref(false);
const busy = ref(false);

onMounted(async () => {
  try {
    info.value = await window.mclink.info();
    // 只在"确实没权限"时弹：拿不到 info 就当不知道，宁可少提示也不误报
    if (NEEDS_ADMIN.has(info.value.platform) && info.value.elevated === false) popupOpen.value = true;
  } catch {
    /* 拿不到就不显示：宁可少提示，也不要误报"你没提权" */
  }
});

/** 需要管理员才能建虚拟网卡的平台 */
const NEEDS_ADMIN = new Set(['win32', 'darwin']);
const notElevated = computed(
  () => info.value !== null && NEEDS_ADMIN.has(info.value.platform) && info.value.elevated === false,
);
/** 主进程给出的具体原因（受限令牌 / 未提权）；没有就不显示这一行 */
const reason = computed(() => info.value?.elevationReason ?? '');

async function elevate(): Promise<void> {
  busy.value = true;
  try {
    /**
     * 这个 store 函数返回 void：失败时它自己把原因写进 state.lastError，
     * 而 App.vue 顶部的错误条已经在显示它。所以这里不再弹 window.alert
     * （两处提示同一件事只会让人以为出了两个错）。
     */
    await relaunchElevated();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <!-- 启动弹窗：一次启动只弹一次，关掉后由下面的横幅继续提醒 -->
  <div v-if="popupOpen" class="modal-mask elevation-popup">
    <div class="card modal-card stack">
      <div>
        <div class="popup-title">需要管理员权限</div>
        <div class="hint">未以管理员身份运行，建不了虚拟网卡 —— <b>联机不可用</b>（登录、建房都正常）。</div>
      </div>

      <div v-if="reason" class="alert alert-warn">{{ reason }}</div>

      <div class="stack">
        <div><b>怎么解决：</b>右键客户端图标 → 点「以管理员身份运行」。</div>
        <div class="hint">也可以直接点下面的按钮：会弹系统授权框，本窗口退出后以管理员身份重新打开。</div>
      </div>

      <div class="row-between">
        <button class="btn" type="button" :disabled="busy" @click="popupOpen = false">稍后再说</button>
        <button class="btn btn-primary" type="button" :disabled="busy" @click="elevate">
          {{ busy ? '正在重启…' : '以管理员身份重启' }}
        </button>
      </div>
    </div>
  </div>

  <div v-if="notElevated && !popupOpen" class="alert alert-warn elevation-banner">
    <span class="grow">
      未以管理员身份运行：建不了虚拟网卡，<b>联机不可用</b>。请右键客户端图标 →
      「以管理员身份运行」，或点右侧按钮重启（会弹系统授权框）。
      <span v-if="reason" class="hint">{{ reason }}</span>
    </span>
    <button class="btn btn-sm" type="button" :disabled="busy" @click="elevate">
      {{ busy ? '正在重启…' : '以管理员身份重启' }}
    </button>
  </div>
</template>

<style scoped>
/*
 * 颜色/边框/内边距全部走既有令牌与 .card/.alert 的样式，不另起一套。
 * 与 OnboardingWizard 用同一套 modal 形态（同一处设计语言，别再造一个）。
 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  padding: var(--s-5);
  z-index: 420;
}
.modal-card {
  width: min(520px, 100%);
  max-height: 88vh;
  overflow: auto;
}
.popup-title {
  font-weight: 650;
  font-size: var(--fs-lg);
}
/* 让长句在窄窗里正常折行 */
.elevation-banner {
  align-items: flex-start;
}
.elevation-banner .grow {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
