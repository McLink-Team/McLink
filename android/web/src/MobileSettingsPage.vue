<script setup lang="ts">
/**
 * Android 端的「设置」—— 桌面 SettingsPage 的**取舍版**，不是重写版。
 *
 * ## 为什么不直接复用 client/src/pages/SettingsPage.vue
 *
 * 那一页有 33KB，其中大半是 **Windows 专属能力**：自启提权、wintun 网卡状态、
 * 关闭窗口的行为（托盘/退出）、打开数据/日志目录、重启为管理员、更新检查
 * （下载的是 `.exe` 安装包）……这些在 Android 上**没有对应物**。
 * 直接渲染它的后果不是"少几个功能"，而是满屏控件点了没反应 ——
 * 用户明确要求"不需要的入口直接不出现，而不是留个死按钮"。
 *
 * ## 手机真正需要的只有四件
 *
 *   1. 我是谁（账号、显示名）—— 确认没登错号；
 *   2. 本机名称 —— 房主靠它认出我，是这一页**唯一**会改到服务端的东西；
 *   3. 连的是哪台主控 —— 只读展示。手机上没有"自建主控"这回事（见 api.ts 的注释），
 *      但排查"连不上"时，玩家和客服都需要先确认这一行；
 *   4. 退出登录 —— 换号时的唯一出路。
 *
 * 版本号放在最下面：和桌面外壳底部那行一样，是排查时才看的东西。
 */
import { computed, ref } from 'vue';
import { clientState, logout, setDevice } from '../../../client/src/lib/store.ts';
import { getMasterUrl, USING_DEV_MASTER } from '../../../client/src/lib/api.ts';
import { enableNotifications, notifyEnabled, setNotifyEnabled } from './message-notify.ts';

const device = ref(clientState.deviceName);
const busy = ref(false);
const saved = ref(false);
const error = ref('');

/** 开关状态。关闭是立即生效的；打开要先过系统权限，被拒就把它拨回关闭（不能让开关说谎） */
const notify = ref(notifyEnabled());

async function toggleNotify(): Promise<void> {
  if (!notify.value) {
    setNotifyEnabled(false);
    return;
  }
  const granted = await enableNotifications();
  if (!granted) {
    notify.value = false;
    setNotifyEnabled(false);
  }
}

const masterUrl = getMasterUrl();
const user = computed(() => clientState.user);

async function saveDevice(): Promise<void> {
  error.value = '';
  saved.value = false;
  busy.value = true;
  try {
    setDevice(device.value.trim());
    saved.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function doLogout(): Promise<void> {
  busy.value = true;
  try {
    await logout();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="stack">
    <!-- 账号：确认自己没登错号 -->
    <section class="card stack">
      <h2 class="mobile-section-title">账号</h2>
      <div class="row-between">
        <span class="faint">用户名</span>
        <span class="mono">{{ user?.username ?? '—' }}</span>
      </div>
      <div class="row-between">
        <span class="faint">显示名</span>
        <span>{{ user?.displayName ?? '—' }}</span>
      </div>
      <button class="btn btn-ghost" type="button" :disabled="busy" @click="doLogout">退出登录</button>
    </section>

    <!-- 本机名称：这一页唯一会改到服务端的东西 -->
    <section class="card stack">
      <h2 class="mobile-section-title">本机名称</h2>
      <div class="field">
        <label class="label">房主靠这个认出你</label>
        <input v-model="device" class="input" placeholder="例如 我的手机" />
      </div>
      <div v-if="error" class="alert alert-danger">{{ error }}</div>
      <div v-else-if="saved" class="alert alert-ok">已保存。下次进房时房主看到的就是这个名字。</div>
      <button class="btn btn-primary" type="button" :disabled="busy || device.trim().length === 0" @click="saveDevice">
        保存
      </button>
    </section>

    <!-- 新消息提醒。⚠️ 说明里必须写清楚"应用被杀掉之后收不到" —— 见 message-notify.ts 的硬限制 -->
    <section class="card stack">
      <h2 class="mobile-section-title">提醒</h2>
      <label class="check-row">
        <input v-model="notify" type="checkbox" @change="toggleNotify()" />
        <span>
          有人发消息时提醒我
          <span class="hint" style="display: block">
            只看别的页面、或切到后台时弹系统通知；正看着那个房间时不打扰。自己发的不提醒，
            连发多条会合成一条。
          </span>
        </span>
      </label>
      <p class="hint">
        <strong>必须知道的一条限制：</strong>本应用没有接推送服务（没有 FCM 或厂商推送通道），
        提醒是靠应用自己收到主控的消息再弹通知的。所以<strong>应用被系统杀掉、或被从最近任务里划掉之后，
        收不到任何提醒</strong>，要重新打开应用才会继续。（我们刻意没有为此加一个常驻后台的前台服务 ——
        那会换来一条永远挂着、去不掉的通知和持续的耗电，代价大于收益。）
      </p>
    </section>

    <!-- 主控地址：只读。手机上没有自建主控这回事，但排查时必须能确认这一行 -->
    <section class="card stack">
      <h2 class="mobile-section-title">主控</h2>
      <div class="field">
        <label class="label">地址（编译期内置，不可修改）</label>
        <!-- 用 .code 而不是 .input：它是只读事实，不该长得像一个可以填的框 -->
        <div class="code truncate">{{ masterUrl }}</div>
      </div>
      <p v-if="USING_DEV_MASTER" class="hint">
        这个包连的是本机开发主控（127.0.0.1）。正式包应当在构建时用 VITE_MCLINK_MASTER 指向官方主控。
      </p>
      <p v-else class="hint">平台不开放自建主控：客户端只能连官方主控，这是「票据只能来自官方主控」这条安全前提的一部分。</p>
    </section>

    <!-- 版本与已知边界：能联机了，但"踢人/限速"与 IPv6 这两条要如实写出来，别让玩家自己撞上 -->
    <section class="card stack">
      <h2 class="mobile-section-title">关于</h2>
      <div class="row-between">
        <span class="faint">McLink for Android</span>
        <span class="mono">v{{ clientState.localVersion || '—' }}</span>
      </div>
      <p class="hint">
        联机时系统会问一次 VPN 授权，<strong>点『确定』之后这台手机就进入房间的虚拟局域网了</strong>：
        可以在手机上的 MC 启动器（如 FCL）里「添加服务器」，地址填房间页的联机地址加端口，直接进服
        —— 不需要另一台电脑代劳。
      </p>
      <p class="hint">
        两条已知边界：<strong>手机做房主时踢人与限速不生效</strong>（房间能建、能联，只是房主规则用不上）；
        <strong>只走 IPv4</strong>，IPv6 地址的服务器不在这个局域网里。
      </p>
    </section>
  </div>
</template>

<style scoped>
/* 分区标题：与桌面设置页同一档字号与颜色（--fs-sm / --ink-2），只是这里居中在单列里 */
.mobile-section-title {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-sm);
  font-weight: 600;
}
</style>
