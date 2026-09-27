<script setup lang="ts">
/**
 * 应用内确认弹层（单例）—— 「退出房间 / 关闭房间 / 轮换密钥 / 踢出成员 / 删除消息」
 * 共用这一个框，调用口是 lib/confirm.ts 的 `confirmInApp()`。
 *
 * 为什么不再用主进程的原生框：原生框是 Windows 系统样式的浅色对话框配蓝色箭头图标，
 * 和「暖纸台」这套世界（暖纸底、白卡、摩卡强调色、圆角 16/18/20）不是一路；
 * 而且它是原生窗口，自动化测试里 CDP 看不见、截不到图。
 * 做成应用内 DOM 之后：CDP 能点、`Page.captureScreenshot` 能截，样式也由令牌说了算。
 *
 * 挂载位置：App.vue 模板里只出现一次（和 CloseConfirm.vue 并排，同一层），
 * 所以任何一屏、任何组件里 `await confirmInApp(...)` 都能弹出来。
 *
 * 键盘（桌面端必须顺手）：
 *   · 弹层一出现焦点就落在**确定**键上，Enter 就是确定；焦点在取消上时 Enter 是取消
 *     （走"当前焦点那颗按钮"，见下面的 onKeydown）；
 *   · Esc 取消，并且不让这次按键冒泡到 window —— App.vue 的全局 Esc 会切回「联机」屏
 *     （见 App.vue 的 onKeydown），不拦的话会出现"同时取消弹层又切屏"；
 *   · Tab 只在卡片内部循环，跑不到遮罩后面的页面内容上（焦点陷阱）。
 *
 * 刻意不做「点遮罩 = 取消」：CloseConfirm.vue 同样不做（它也是个"必须做个决定"的框）。
 * 这里更实际的原因是双击 —— 玩家连点两下「退出房间」时，第二下会落在刚出现的遮罩上，
 * 弹层会瞬间自己关掉，看起来像按钮失灵。
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { answerConfirm, confirmRequest, setConfirmDialogMounted } from '../lib/confirm.ts';

const card = ref<HTMLElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);

/*
 * 告诉 lib/confirm.ts "应用内弹层是活的"。
 *
 * 这个标志的存在是因为一次真机事故：安卓外壳漏挂了这个组件，于是 confirmInApp 的 Promise
 * 永远不 settle —— 玩家点「踢出」什么都不发生，也不报错。挂了就有统一风格的弹层，
 * 万一哪天又漏挂，confirm.ts 会退回桥上的 confirm，而不是让按钮变哑巴。
 */
onMounted(() => setConfirmDialogMounted(true));
onUnmounted(() => setConfirmDialogMounted(false));

/** 弹层出现就把焦点送到确定键上：Enter = 确定，Tab 从这里开始循环 */
watch(confirmRequest, async (request) => {
  if (!request) return;
  await nextTick();
  confirmButton.value?.focus();
});

/** 卡片内可 Tab 到的元素（顺序就是 DOM 顺序：取消 → 确定） */
function focusables(): HTMLElement[] {
  const root = card.value;
  if (!root) return [];
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    // 别再往上冒：App.vue 的全局 Esc 会把页面切回「联机」屏
    event.stopPropagation();
    answerConfirm(false);
    return;
  }
  if (event.key === 'Enter') {
    /*
     * Enter = **当前焦点那颗按钮**。默认焦点在确定键上，所以"按 Enter 就是确定"；
     * 焦点若在取消上（Tab 过去），Enter 必须是取消 —— 绝不能反过来变成确定。
     *
     * 这里显式接管而不是只靠 button 的原生 click：原生行为在 CDP 派发的按键下
     * 不一定触发（.cache/verify-confirm-inapp.mjs 实测：rawKeyDown 到达了页面、
     * 弹层却没关），而"回车能不能确定"是这条验收里要断言的契约。
     * preventDefault 是为了不让原生 click 再答一次（answerConfirm 重复调用无害，但没必要）。
     */
    event.preventDefault();
    event.stopPropagation();
    answerConfirm(document.activeElement === confirmButton.value);
    return;
  }
  if (event.key !== 'Tab') return;

  const nodes = focusables();
  if (nodes.length === 0) {
    event.preventDefault();
    return;
  }
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  // 焦点跑到卡片外面（或没落进来）时，一律拽回卡片内，遮罩后面的内容 Tab 不到
  if (!active || !nodes.includes(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <div v-if="confirmRequest" class="modal-mask" @keydown="onKeydown">
    <div
      ref="card"
      class="card modal-card stack"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-body"
    >
      <div>
        <div id="confirm-dialog-title" class="popup-title">{{ confirmRequest.title }}</div>
        <div id="confirm-dialog-body" class="message">{{ confirmRequest.message }}</div>
      </div>

      <!-- 补充说明：正文说"会发生什么"，这一行说"为什么问 / 有什么后遗症" -->
      <p v-if="confirmRequest.detail" class="detail">{{ confirmRequest.detail }}</p>

      <div class="actions">
        <button class="btn btn-ghost" type="button" @click="answerConfirm(false)">
          {{ confirmRequest.cancelText }}
        </button>
        <span class="grow" />
        <button
          ref="confirmButton"
          class="btn"
          :class="confirmRequest.danger ? 'btn-danger' : 'btn-primary'"
          type="button"
          @click="answerConfirm(true)"
        >
          {{ confirmRequest.confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与 CloseConfirm / OnboardingWizard / ElevationBanner 同一套 modal 形态，颜色只用令牌 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  padding: var(--s-5);
  /*
   * 压过页面自己的弹层（房间页 300、首启向导 400），但压在
   * 「未提权横幅」420 与「关闭窗口询问」430 之下 —— 那两个是窗口级的决定，
   * 不该被一次页面内的确认盖住。
   */
  z-index: 410;
}
.modal-card {
  width: min(460px, 100%);
  max-height: 88vh;
  overflow: auto;
}
/*
 * 圆角必须显式写回 --r-lg：styles.css 里的 `.app-shell .card`（0,2,0）把卡片圆角
 * 压成 --r-sm（8px），而它在本文件之后加载，于是 `.modal-card` 单独一条盖不过它。
 * 设计契约要求弹层是 var(--r-lg)，所以这里提到两级选择器（0,3,0），不靠加载顺序碰运气。
 * 实测：改之前弹层圆角是 8px。
 */
.modal-mask .modal-card {
  border-radius: var(--r-lg);
}
.popup-title {
  color: var(--ink);
  font-weight: 650;
  font-size: var(--fs-lg);
}
.message {
  margin-top: 6px;
  color: var(--ink-2);
  font-size: var(--fs-sm);
  line-height: var(--lh-snug);
}
.detail {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-snug);
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
