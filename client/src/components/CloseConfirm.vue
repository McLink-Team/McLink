<script setup lang="ts">
/**
 * 关闭窗口时的询问框：**彻底退出** 还是 **最小化到托盘**，并可记住选择。
 *
 * 为什么要有它（用户反馈）：以前点 X 直接收进托盘、**没有任何提示** ——
 * 玩家以为退出了，其实进程还在后台跑着、房间也没断，下次开机又莫名多一个进程。
 *
 * 为什么用应用内弹窗而不是系统对话框：与"未提权弹窗"同一套形态（同一处设计语言），
 * 而且能被自动化测试真正点到（系统对话框在 CDP 里看不见，只能靠人去点）。
 *
 * 与主进程的约定（见 electron/main.cjs 的 askCloseAction）：
 *   主进程收到 close → preventDefault → 发 `app:ask-close` → 这里弹窗；
 *   弹窗出现后先回一个 `closeAskOpened`（撤掉主进程 8 秒兜底，免得盯久了被收进托盘），
 *   用户选完再回 `closeDecision({action, remember})`。
 */
import { onMounted, onUnmounted, ref } from 'vue';

const visible = ref(false);
const remember = ref(false);
const busy = ref(false);
let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = window.mclink.onAskClose(() => {
    visible.value = true;
    // 界面确实弹出来了：告诉主进程撤掉它的兜底计时器
    void window.mclink.closeAskOpened();
  });
});

onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = null;
});

async function decide(action: 'tray' | 'quit' | 'cancel'): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await window.mclink.closeDecision({ action, remember: remember.value });
    // quit / tray 之后窗口就不在了（或被隐藏），这里只需把弹窗收起来
    visible.value = false;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="visible" class="modal-mask close-confirm">
    <div class="card modal-card stack">
      <div>
        <div class="popup-title">要退出 McLink 吗？</div>
        <div class="hint">
          <b>最小化到托盘</b>：窗口收起来，房间与联机保持不变（托盘图标右键可退出）。<br />
          <b>彻底退出</b>：关闭客户端并断开局域网连接，房间里的朋友会掉线。
        </div>
      </div>

      <label class="remember">
        <input v-model="remember" type="checkbox" />
        <span>记住我的选择，以后不再询问（可在「设置」里改）</span>
      </label>

      <div class="actions">
        <button class="btn" type="button" :disabled="busy" @click="decide('cancel')">取消</button>
        <span class="grow" />
        <button class="btn" type="button" :disabled="busy" @click="decide('quit')">彻底退出</button>
        <button class="btn btn-primary" type="button" :disabled="busy" @click="decide('tray')">
          最小化到托盘
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与 OnboardingWizard / ElevationBanner 同一套 modal 形态，颜色只用令牌 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  padding: var(--s-5);
  z-index: 430;
}
.modal-card {
  width: min(460px, 100%);
  max-height: 88vh;
  overflow: auto;
}
.popup-title {
  font-weight: 650;
  font-size: var(--fs-lg);
}
.remember {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--fs-sm);
  color: var(--paper-dim);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.actions .grow {
  flex: 1;
}
</style>
