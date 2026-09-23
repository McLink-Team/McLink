<script setup lang="ts">
/**
 * 「未以管理员身份运行」的常驻横幅。
 *
 * 为什么需要它（真实事故）
 * ----------------------
 * Windows 上创建 wintun 虚拟网卡必须管理员。客户端本来会在启动时自动请求提权，
 * 但**玩家点过一次「否」之后 7 天内不再自动弹**（避免骚扰）。于是那位玩家以普通
 * 权限启动 → 虚拟网卡建不起来 → 核心直接退出 → 房间页只显示一句「连接异常」，
 * 诊断卡再抛一段 EasyTier 的 Rust 原始报错（`failed to connect 127.0.0.1:52389`,
 * os error 10061）。玩家完全不知道原因是"权限"，客服也得排查半天。
 *
 * 之前唯一的提示藏在「新手引导」和「设置 → 权限」里 —— 找不到就等于没有。
 * 所以这里把它放到**最外层**：不弹窗、不拦截（选的是方案 A，不是硬门禁），
 * 但每一页顶部都看得到，而且一键就能修（复用现成的 relaunchElevated）。
 *
 * 只在自己确实没提权时出现：`app:info` 给的 elevated 是主进程实测值
 * （Windows 查 whoami 的 High Mandatory Level，macOS/Linux 查 getuid）。
 */
import { computed, onMounted, ref } from 'vue';
import { relaunchElevated } from '../lib/store.ts';
import type { AppInfo } from '../lib/bridge.ts';

const info = ref<AppInfo | null>(null);
const busy = ref(false);

onMounted(async () => {
  try {
    info.value = await window.mclink.info();
  } catch {
    /* 拿不到就不显示横幅：宁可少提示，也不要误报"你没提权" */
  }
});

/** 需要管理员才能建虚拟网卡的平台 */
const NEEDS_ADMIN = new Set(['win32', 'darwin']);
const visible = computed(
  () => info.value !== null && NEEDS_ADMIN.has(info.value.platform) && info.value.elevated === false,
);

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
  <div v-if="visible" class="alert alert-warn elevation-banner">
    <span class="grow">
      未以管理员身份运行：建不了虚拟网卡，<b>联机不可用</b>。请点右侧按钮重启（会弹系统授权框）。
    </span>
    <button class="btn btn-sm" type="button" :disabled="busy" @click="elevate">
      {{ busy ? '正在重启…' : '以管理员身份重启' }}
    </button>
  </div>
</template>

<style scoped>
/*
 * 只加一条：让长句在窄窗里正常折行。
 * 颜色/边框/内边距全部走 .alert 与 .alert-warn 的既有令牌，不另起一套。
 */
.elevation-banner {
  align-items: flex-start;
}
.elevation-banner .grow {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
