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
 * ## 手机真正需要的
 *
 *   1. 我是谁（用户名、**可改的昵称**）—— 确认没登错号，顺手把昵称改掉；
 *   2. 本机名称 —— 房主靠它认出我，注意它和昵称**不是一回事**（见下面两段的说明）；
 *   3. 新消息提醒的开关；
 *   4. 退出登录 —— 换号时的唯一出路。
 *
 * 版本号与三条已知边界（踢人可用但有 2 秒重启代价、带宽限速要重连、IPv6）放在最下面：
 * 和桌面外壳底部那行一样，是排查与"先说清楚"时才看的东西。
 *
 * ## 这里**没有**主控地址
 *
 * 早先这一页有一块只读的「主控」分区（地址 + 是不是本机开发主控）。删掉的理由：
 * 手机上没有"自建主控"这回事 —— 地址是编译期内置的，玩家既看不到也改不了，
 * 展示它只会让人以为"可以换一台服务器"，而我们并不支持那么做
 * （票据只能来自官方主控，见 client/src/lib/api.ts 的说明）。
 * 排查"连不上"要看的是网络，不是这一行；**不要把它加回来**。
 */
import { computed, ref } from 'vue';
import { displayNameProblem } from '@mclink/shared';
import { clientState, logout, setDevice, updateDisplayName } from '../../../client/src/lib/store.ts';
import { friendlyError } from '../../../client/src/lib/api.ts';
import { enableNotifications, notifyEnabled, setNotifyEnabled } from './message-notify.ts';

const user = computed(() => clientState.user);

const device = ref(clientState.deviceName);
const busy = ref(false);
const saved = ref(false);
const error = ref('');

/* ------------------------------------------------------------------ 昵称 */

/**
 * 昵称（显示名）——**这是唯一一处会改到账号本身的操作**。
 *
 * 规则、文案、交互全部照 `client/src/pages/SettingsPage.vue` 那一段来，
 * 不另写一套：两端对"什么名字不能叫"的判断必须是同一个
 * （`@mclink/shared` 的 `displayNameProblem`），否则玩家在手机上能改、
 * 在电脑上被拒，或者反过来 —— 而这类不一致没人会想到去查。
 */
const nickname = ref(clientState.user?.displayName ?? '');
const nickBusy = ref(false);
const nickError = ref('');
const nickSaved = ref(false);

/**
 * 本地先判一次，不用等服务端回 400。
 *
 * `selfDisplayName` 必须传自己**当前**的昵称：服务端有"改回自己原名放行"这条规则，
 * 客户端不跟上的话，一个昵称里恰好含保留词的老用户连保存都点不下去。
 * 服务端仍是强制点 —— 它还会拿库里所有显示名做重名比对，而客户端没有那份名单。
 */
const nicknameIssue = computed(() =>
  nickname.value.trim().length > 0
    ? displayNameProblem(nickname.value.trim(), { selfDisplayName: clientState.user?.displayName ?? null })
    : null,
);

async function saveNickname(): Promise<void> {
  const next = nickname.value.trim();
  if (next.length === 0) {
    nickError.value = '昵称不能为空。';
    return;
  }
  // 按钮 disabled 时点不到，但回车/别处触发要兜底 —— 保证一定有可读的原因
  if (nicknameIssue.value) {
    nickError.value = nicknameIssue.value;
    return;
  }
  nickBusy.value = true;
  nickError.value = '';
  nickSaved.value = false;
  try {
    await updateDisplayName(next);
    // 服务端会 trim + 截到 32 字：以它回来的那一份为准，别让输入框停在一个没生效的值上
    nickname.value = clientState.user?.displayName ?? next;
    nickSaved.value = true;
  } catch (err) {
    /*
     * 服务端可能因为保留词、重名、频率限制等拒绝 —— 它的 message 是**给玩家看的**，
     * 原样显示（`friendlyError` 只把"网络不通"翻译成人话，其余一律透传），
     * 不吞掉、也不自己编一句。（`updateDisplayName` 失败时不会动 `state.user`，
     * 所以界面上的昵称保持旧值，不会出现"输入框变了但账号没变"。）
     */
    nickError.value = friendlyError(err);
  } finally {
    nickBusy.value = false;
  }
}

/* ------------------------------------------------------------------ 本机名称 */

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

/* ------------------------------------------------------------------ 提醒 */

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

/* ------------------------------------------------------------------ 退出 */

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
    <!-- 账号：确认自己没登错号，并改掉昵称 -->
    <section class="card stack">
      <h2 class="mobile-section-title">账号</h2>
      <div class="row-between">
        <span class="faint">用户名</span>
        <span class="mono">{{ user?.username ?? '—' }}</span>
      </div>
      <div class="row-between">
        <span class="faint">显示名</span>
        <!-- .nick-current 是断言用的稳定钩子（保存后这里必须立刻变成新昵称），不加样式 -->
        <span class="nick-current">{{ user?.displayName ?? '—' }}</span>
      </div>

      <!--
        改昵称。窄屏单列：一个输入框 + 一个按钮，不照搬桌面那套"标签在两列"的排法。
        就地报错（.nick-bad）在输入框正下方 —— 每敲一个字都弹一次 alert 会盖住半屏。
      -->
      <div class="field">
        <label class="label" for="nick-input">昵称</label>
        <input
          id="nick-input"
          v-model="nickname"
          class="input"
          maxlength="32"
          placeholder="会显示在房间成员列表与聊天里"
          :disabled="nickBusy"
        />
        <div v-if="nickname.trim().length === 0" class="hint nick-bad">昵称不能为空。</div>
        <!-- 与桌面、与服务端同一条规则（shared 的 displayNameProblem）：在输入时就报 -->
        <div v-else-if="nicknameIssue" class="hint nick-bad">{{ nicknameIssue }}</div>
        <div v-else class="hint">房间成员列表与聊天里显示的就是它；用户名不可修改。「本机名称」是另一回事（只备注这台设备）。</div>
      </div>
      <button
        class="btn btn-primary"
        type="button"
        :disabled="nickBusy || nickname.trim().length === 0 || nicknameIssue !== null"
        @click="saveNickname()"
      >
        保存昵称
      </button>
      <!-- 服务端拒绝时把它的原话显示出来 -->
      <div v-if="nickError" class="alert alert-danger nick-error">{{ nickError }}</div>
      <div v-else-if="nickSaved" class="alert alert-ok">昵称已保存。</div>

      <button class="btn btn-ghost" type="button" :disabled="busy" @click="doLogout">退出登录</button>
    </section>

    <!-- 本机名称：只影响房主看到的名字，不改账号 -->
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

    <!--
      版本与已知边界。
      ⚠️ 这三条是**查证过的实现事实**（依据见 mobile-bridge.ts 的 applyAcl 与
      server/src/easytier/acl.ts），不是保守说法：ACL 里只有「踢人黑名单 + 严格端口模式 +
      包速率限制」，带宽限速落在启动配置里。别为了简短把它们又合并成一句"限速不生效"。
    -->
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
        三条要知道的：<strong>手机做房主时踢人、端口白名单与包速率限制照样生效</strong>，
        但每施加一次规则房主的虚拟网络会重启一次，约 2 秒内房间里连不上房主（房间不解散，也不用重新加入）；
        <strong>带宽限速不在其中</strong> —— 它写在启动配置里，改完要重新连接房间才生效；
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

/*
 * 昵称的就地报错。
 *
 * 桌面的 `.acct-bad` 定义在 SettingsPage.vue 的 `<style scoped>` 里 —— scoped 会把它绑在
 * 那个组件的 data-v 属性上，这边的元素匹配不到，所以只能自己写一条**同义**的规则：
 * 字号沿用 .hint，只换颜色，颜色来自令牌（设计契约：本目录不出现任何颜色字面量）。
 */
.nick-bad {
  color: var(--fault);
}
</style>
