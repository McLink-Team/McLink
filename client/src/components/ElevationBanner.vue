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
 *
 * 平台差异（本次补齐）：Windows 的"自己动手"是右键 →「以管理员身份运行」；
 * macOS 上右键 → 打开只是绕过 Gatekeeper，给的是安全提示、**不是权限** ——
 * 那句文案照搬到 mac 上会把玩家引到错误的方向，所以统一走 `lib/platform.ts` 的说法。
 */
import { computed, onMounted, ref } from 'vue';
import { relaunchElevated } from '../lib/store.ts';
import { adminHowTo, revealAppLabel, tunName } from '../lib/platform.ts';
import type { AppInfo } from '../lib/bridge.ts';

const info = ref<AppInfo | null>(null);
const popupOpen = ref(false);
const busy = ref(false);
/** 提权失败的原因：就地显示在弹窗里（用户实测"按了没用"就是因为这里什么都不显示） */
const elevateError = ref<string | null>(null);

onMounted(async () => {
  try {
    info.value = await window.mclink.info();
    // 只在"确实没权限"时弹：拿不到 info 就当不知道，宁可少提示也不误报
    if (NEEDS_ADMIN.has(info.value.platform) && info.value.elevated === false) popupOpen.value = true;
  } catch {
    /* 拿不到就不显示：宁可少提示，也不要误报"你没提权" */
  }
});

/**
 * 需要管理员才能建虚拟网卡的平台。
 *
 * 与 `lib/platform.ts` 的 needsAdmin 是同一条规则，但这里判的是**主进程报的**
 * platform（而不是 preload 那个同步值）：横幅该不该出现属于"主进程说了算"的事实，
 * 用它的答案更不容易因为将来 preload 契约变化而跑偏。
 */
const NEEDS_ADMIN = new Set(['win32', 'darwin']);
const notElevated = computed(
  () => info.value !== null && NEEDS_ADMIN.has(info.value.platform) && info.value.elevated === false,
);
/** 主进程给出的具体原因（受限令牌 / 未提权）；没有就不显示这一行 */
const reason = computed(() => info.value?.elevationReason ?? '');

async function elevate(): Promise<void> {
  busy.value = true;
  elevateError.value = null;
  try {
    const res = await relaunchElevated();
    // ok = 已拉起管理员实例、本进程即将退出；失败时把原因留在这里说清楚
    if (!res.ok) elevateError.value = res.error ?? '提权失败';
  } catch (err) {
    elevateError.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/**
 * 兜底：带用户到客户端所在的文件夹。
 *
 * Windows 上是为了"右键 → 以管理员身份运行"；macOS 上这一步帮不上权限的忙，
 * 但"想知道装在哪 / 想手动打开"仍然成立，所以按钮留着，只是改了说法（在访达中显示）。
 * 自动提权在某些环境里本来就会被拒（例如受限令牌不允许再提权），
 * 这时"带用户到文件所在处"比一句空话有用得多。
 */
function revealApp(): void {
  const dir = info.value?.exeDir;
  if (dir) void window.mclink.openPath(dir);
}
</script>

<template>
  <!-- 启动弹窗：一次启动只弹一次，关掉后由下面的横幅继续提醒 -->
  <div v-if="popupOpen" class="modal-mask elevation-popup">
    <div class="card modal-card stack">
      <div>
        <div class="popup-title">需要管理员权限</div>
        <div class="hint">
          未以管理员身份运行，建不了虚拟网卡（{{ tunName }}）—— <b>联机不可用</b>（登录、建房都正常）。
        </div>
      </div>

      <div v-if="reason" class="alert alert-warn">{{ reason }}</div>

      <div class="stack">
        <div><b>怎么解决：</b>{{ adminHowTo }}</div>
      </div>

      <!-- 提权失败就地说明：不要只把错误丢到顶部错误条（用户实测"按了没用"） -->
      <div v-if="elevateError" class="alert alert-danger">{{ elevateError }}</div>

      <div class="row-between">
        <button class="btn" type="button" :disabled="busy" @click="popupOpen = false">稍后再说</button>
        <div class="row" style="gap: var(--s-2)">
          <button v-if="info?.exeDir" class="btn" type="button" @click="revealApp">{{ revealAppLabel }}</button>
          <button class="btn btn-primary" type="button" :disabled="busy" @click="elevate">
            {{ busy ? '正在重启…' : '以管理员身份重启' }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <div v-if="notElevated && !popupOpen" class="alert alert-warn elevation-banner">
    <span class="grow">
      未以管理员身份运行：建不了虚拟网卡（{{ tunName }}），<b>联机不可用</b>。{{ adminHowTo }}
      <span v-if="reason" class="hint">{{ reason }}</span>
      <span v-if="elevateError" class="hint">{{ elevateError }}</span>
    </span>
    <div class="row" style="gap: var(--s-2)">
      <button v-if="info?.exeDir" class="btn btn-sm" type="button" @click="revealApp">{{ revealAppLabel }}</button>
      <button class="btn btn-sm" type="button" :disabled="busy" @click="elevate">
        {{ busy ? '正在重启…' : '以管理员身份重启' }}
      </button>
    </div>
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
