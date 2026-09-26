<script setup lang="ts">
/**
 * 首次使用向导：3 步把「权限 → 房间 → 游戏里怎么连」讲完。
 *
 * 只在第一次启动时自动弹出（localStorage 标记由 lib/onboarding.ts 管理），
 * 「跳过」只关掉本次，「不再显示」才会写标记；设置页里可以重新打开。
 */
import { computed, onMounted, ref } from 'vue';
import { closeOnboarding } from '../lib/onboarding.ts';
import { relaunchElevated } from '../lib/store.ts';
import type { AppInfo } from '../lib/bridge.ts';

const STEP_TITLES = ['管理员权限', '建房 / 进房', '在游戏里怎么连'];

const step = ref(0);
const info = ref<AppInfo | null>(null);

const last = computed(() => step.value === STEP_TITLES.length - 1);

onMounted(async () => {
  info.value = await window.mclink.info().catch(() => null);
});

function finish(persist: boolean): void {
  closeOnboarding(persist);
}
</script>

<template>
  <div class="modal-mask">
    <div class="card modal-card stack">
      <div class="row-between">
        <div>
          <div style="font-weight: 650; font-size: var(--fs-lg)">欢迎使用 McLink</div>
          <div class="hint">第 {{ step + 1 }} / {{ STEP_TITLES.length }} 步 · {{ STEP_TITLES[step] }}</div>
        </div>
        <div class="row" style="gap: 4px">
          <span v-for="(t, i) in STEP_TITLES" :key="t" class="dot" :class="i === step ? 'dot-ok' : 'dot-idle'" />
        </div>
      </div>

      <!-- ① 管理员权限 -->
      <div v-if="step === 0" class="stack">
        <div>
          McLink 会在本机拉起 EasyTier 核心来建一张虚拟局域网。Windows 上创建虚拟网卡（wintun）需要管理员权限，
          没有权限的话你能登录、能建房，但成员之间连不通。
        </div>
        <div v-if="info && info.elevated" class="alert alert-ok">当前已以管理员身份运行，无需额外操作。</div>
        <div v-else-if="info" class="alert alert-warn">
          <div class="grow">
            <div style="font-weight: 600">当前未以管理员身份运行</div>
            <div class="hint">点下面的按钮会重新以管理员身份打开客户端（当前窗口会退出）。</div>
          </div>
          <button class="btn btn-primary btn-sm" @click="relaunchElevated()">以管理员身份重启</button>
        </div>
        <div v-else class="hint">正在读取权限状态…</div>
        <div class="hint">也可以之后在「设置」标签里再提权，随时都来得及。</div>
      </div>

      <!-- ② 建房 / 进房 -->
      <div v-else-if="step === 1" class="stack">
        <div>
          <span style="font-weight: 600">自己开：</span>点「创建房间」，选一个离大家近的区域（不确定就选「自动选择」），
          创建后立刻会得到联机地址和 6 位加入码。
        </div>
        <div>
          <span style="font-weight: 600">加入朋友：</span>把对方给的 6 位加入码填进「加入房间」；
          如果房主设了密码或开了审批，按提示走即可。
        </div>
        <div class="hint">
          房主是流量汇合点，所以房主最好选网络稳定的那台机器；玩家之间默认会尝试 P2P 直连，直连不成才走中继。
        </div>
      </div>

      <!-- ③ 游戏里怎么连 -->
      <div v-else class="stack">
        <div>以《我的世界》Java 版为例（其它支持局域网联机的游戏同理）：房主在游戏里「对局域网开放」（或开好服务端）之后，玩家这样进：</div>
        <div class="steps">
          <div>① 启动游戏 → 主菜单点「多人游戏」</div>
          <div>② 点「直接连接」（基岩版是「服务器 → 添加服务器」）</div>
          <div>③ 把 McLink 房间页上的「联机地址」粘贴进去 → 加入服务器</div>
        </div>
        <div class="hint">
          有些游戏只显示「局域网房间列表」，那种情况什么都不用填，房间里的游戏会自动出现在列表里。
          进房后房间页有「联机帮助」，点开就是按游戏列好的端口和步骤。
        </div>
      </div>

      <div class="row">
        <button class="btn btn-ghost btn-sm" @click="finish(false)">跳过本次</button>
        <span class="grow" />
        <button v-if="step > 0" class="btn btn-sm" @click="step -= 1">上一步</button>
        <button v-if="!last" class="btn btn-primary btn-sm" @click="step += 1">下一步</button>
        <button v-else class="btn btn-primary btn-sm" @click="finish(true)">开始使用</button>
        <button class="btn btn-sm btn-ghost" @click="finish(true)">不再显示</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  padding: var(--s-5);
  z-index: 400;
}
.modal-card {
  width: min(520px, 100%);
  max-height: 88vh;
  overflow: auto;
}
.steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-hair-strong);
  font-size: var(--fs-sm);
}
</style>
