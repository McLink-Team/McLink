<script setup lang="ts">
/**
 * 未登录时的「联机」那一屏：登录卡。
 *
 * 两次收窄：
 *   1. 原来这一屏自己带页脚版本号、也自己带"先去大厅看看"的入口 —— 那些现在都归
 *      外壳（底部一行、左侧图标栏），所以这里只剩表单本身；
 *   2. 表单**必须自己限宽**。它是在 940px 的横向窗口里渲染的，铺满整屏时输入框
 *      会长到 900px（实测截图里就是这样，一眼就散了）。
 *
 * 刻意不显示任何服务器信息：玩家不需要知道、也无权修改它连的是哪台机器。
 *
 * ⚠️ 2026-10-03 改了这条：官方服务停止后，玩家**必须**能在这里换主控地址 ——
 * 否则自建实例的用户卡在登录页（还没登录就没法进设置页）。
 * 于是多了一行可展开的「连接的是哪台主控」，默认折叠、只在需要时出现。
 */
import { computed, onMounted, ref } from 'vue';
import { clearAuthNotice, clientState, login, register, setDevice, setMasterUrl } from '../lib/store.ts';
import { customMasterUrl, friendlyError, HAS_BUILT_IN_MASTER, MASTER_URL } from '../lib/api.ts';
import LocalRoomCard from '../components/LocalRoomCard.vue';
import { emailProblem, displayNameProblem, passwordProblem } from '@mclink/shared';

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const password2 = ref('');
const displayName = ref('');
const email = ref('');
const device = ref(clientState.deviceName);
const busy = ref(false);
const error = ref('');

/* ------------------------------------------------ 主控地址（自建实例入口） */

/**
 * 这一行是给"自建实例"的用户准备的：他们拿到的是自己的域名/IP，
 * 而包里的默认地址是官方（已停服）那台 —— 不给他换的地方，他就登录不了。
 *
 * 默认折叠：普通玩家不需要看到它，也不该被诱导去改。
 */
const masterOpen = ref(false);
const masterInput = ref(customMasterUrl() ?? '');
const masterMessage = ref('');
const masterIsCustom = computed(() => customMasterUrl() !== null);
/**
 * **还没有主控**（包内没有内置、玩家也没填过）—— 这时登录表单是点不动的：
 * 账号本来就存在于某台主控上，没有主控就没有账号可登。
 * 于是首屏直接换成"填主控地址"这一步，而不是让玩家对着一个必然失败的按钮。
 */
const needsMaster = computed(() => clientState.masterUrl.length === 0);

function applyMaster(): void {
  masterMessage.value = '';
  const changed = setMasterUrl(masterInput.value);
  masterInput.value = customMasterUrl() ?? '';
  if (!changed) {
    masterMessage.value = `没变，仍是 ${clientState.masterUrl}`;
    return;
  }
  /**
   * 换主控要**重新走一遍初始化**：区域、平台信息、注册开关全部来自那台主控的 /meta。
   * 与其在这里手动重拉一遍，不如让渲染层重载 —— 与 Electron 的 reload 等价，
   * 玩家看到的就是"应用重启了一次"。
   */
  window.location.reload();
}

/** 平台是否要求验证邮箱（来自 /meta）：是的话注册表单把邮箱变成必填 */
const emailRequired = computed(() => clientState.platform.requireEmailVerification);

/**
 * 昵称与服务端同一条规则（shared 的 displayNameProblem）：冒充官方、匿名/占位名在输入时就报。
 *
 * 这里查不到"已有用户的显示名"，所以重名那一类只有服务端能判 —— 界面这份是即时提示，
 * 服务端才是强制点，它回来的 400 文案会显示在下面的 alert 里。
 */
const displayNameIssue = computed(() =>
  displayName.value.trim().length > 0 ? displayNameProblem(displayName.value.trim()) : null,
);

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (!username.value.trim() || !password.value) return false;
  if (mode.value === 'register') {
    if (password.value !== password2.value) return false;
    if (passwordProblem(password.value)) return false;
    if (displayNameIssue.value !== null) return false;
    if (emailRequired.value && email.value.trim().length === 0) return false;
    if (email.value.trim().length > 0 && emailProblem(email.value.trim()) !== null) return false;
  }
  return true;
});

onMounted(() => {
  if (clientState.lastError) error.value = clientState.lastError;
});

async function submit(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    setDevice(device.value.trim() || device.value);
    if (mode.value === 'login') {
      await login(username.value.trim(), password.value);
    } else {
      const res = await register(
        username.value.trim(),
        password.value,
        displayName.value.trim() || undefined,
        email.value.trim() || undefined,
      );
      // 账号已经建好、也登录了；信没寄出去只影响"下一步验证"，不该让注册整体失败
      if (!res.emailSent && res.emailError) {
        error.value = `账号已创建，但验证码没寄出去：${res.emailError}`;
      }
    }
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <div class="card login-card">
      <!-- 品牌印记不再重复：左上的图标栏里那个就是它（用户要求） -->
      <p class="login-lede">
        {{ needsMaster ? '先填一个主控地址，才能登录' : '登录后建房，或者用朋友的加入码进房' }}
      </p>

      <!--
        **还没有主控**时的首屏（2026-10-03）。
        包内不再内置任何主控地址（官方停服，内置一个只会误导），所以第一次打开这一版客户端
        必须让玩家先填一个 —— 否则登录按钮点了必然失败，而原因藏在"连不上服务器"后面。
        这里把整张卡换成"填地址"这一步，填完自动重载进正常登录界面。
      -->
      <template v-if="needsMaster">
        <div class="field">
          <label class="label">主控地址</label>
          <input
            v-model="masterInput"
            class="input"
            spellcheck="false"
            placeholder="https://mclink.example.com 或 http://192.168.1.10:8787"
          />
          <div class="hint">
            这个版本<strong>没有内置</strong>任何主控地址：官方服务已停止，需要你自己有一套实例
            （或使用朋友/社区提供的主控）。自建方式见项目仓库的
            <span class="mono">docs/private-deployment.md</span>。
            <strong>账号密码会发给这台主控</strong>，只填你信任的实例。
          </div>
        </div>
        <button class="btn btn-primary login-submit" type="button" @click="applyMaster">连上这台主控</button>
        <div v-if="masterMessage" class="hint">{{ masterMessage }}</div>
        <p class="hint center">
          只想和固定几个朋友开黑、不想搭主控？往下看<strong>「本地联机」</strong> ——
          填一个中继节点地址就能直接开，不需要注册，也不需要主控。
        </p>
      </template>

      <template v-else>
      <!--
        改密码成功后必须回到这一屏（服务端吊销了全部会话，见 store.ts 的 changePassword），
        所以"密码已更新，请重新登录"这句话只能挂在这里 —— 否则玩家莫名其妙被踢回登录页。
      -->
      <div v-if="clientState.authNotice" class="alert alert-ok">
        <span class="grow">{{ clientState.authNotice }}</span>
        <button class="btn btn-sm btn-ghost" type="button" @click="clearAuthNotice()">知道了</button>
      </div>

      <div class="tabs">
        <button class="tab" :class="{ active: mode === 'login' }" @click="mode = 'login'">登录</button>
        <button class="tab" :class="{ active: mode === 'register' }" @click="mode = 'register'">注册</button>
      </div>

      <div class="field">
        <label class="label">用户名</label>
        <input v-model="username" class="input" autocomplete="username" placeholder="3-24 位字母、数字或下划线" />
      </div>

      <div class="field">
        <label class="label">密码</label>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="current-password"
          placeholder="至少 8 位，含字母与数字"
        />
      </div>

      <template v-if="mode === 'register'">
        <div class="field">
          <label class="label">确认密码</label>
          <input v-model="password2" class="input" type="password" autocomplete="new-password" />
          <div v-if="password2 && password !== password2" class="hint warn-text">两次输入不一致</div>
        </div>
        <div class="field">
          <label class="label">邮箱{{ emailRequired ? '' : '（可选）' }}</label>
          <input v-model="email" class="input" type="email" autocomplete="email" placeholder="you@example.com" />
          <div v-if="email && emailProblem(email.trim())" class="hint warn-text">
            {{ emailProblem(email.trim()) }}
          </div>
          <div v-else-if="emailRequired" class="hint">注册后会把 6 位验证码发到这个邮箱，验证完才能建房、进房。</div>
        </div>
        <div class="field">
          <label class="label">昵称（可选）</label>
          <input v-model="displayName" class="input" placeholder="会显示在房间成员列表里" />
          <!-- 与服务端同一条规则（shared 的 displayNameProblem）：冒充官方/匿名占位名不让提交 -->
          <div v-if="displayNameIssue" class="hint warn-text">{{ displayNameIssue }}</div>
          <div v-else class="hint">留空就用用户名。</div>
        </div>
      </template>

      <div class="field">
        <label class="label">本机名称</label>
        <input v-model="device" class="input" placeholder="例如 书房的电脑" />
        <div class="hint">房主靠这个认出你。</div>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <button class="btn btn-primary login-submit" :disabled="!canSubmit" @click="submit">
        <span v-if="busy" class="spinner" />
        <span>{{ mode === 'login' ? '登录并开始联机' : '注册新账号' }}</span>
      </button>

      <p class="hint center">登录即表示你同意仅将本平台用于合法的联机用途。</p>

      <!--
        自建实例入口（默认折叠）。
        官方服务已停，包里内置的地址未必是你的实例 —— 不给这一行，自建的用户就卡在登录页。
      -->
      <div class="master-row">
        <button class="master-toggle" type="button" @click="masterOpen = !masterOpen">
          {{ masterOpen ? '收起' : '连接的是哪台主控？' }}
        </button>
        <span class="hint mono">{{ clientState.masterUrl }}</span>
      </div>
      <div v-if="masterOpen" class="field">
        <label class="label">主控地址</label>
        <input
          v-model="masterInput"
          class="input"
          spellcheck="false"
          :placeholder="HAS_BUILT_IN_MASTER ? `留空 = 用本包内置的 ${MASTER_URL}` : 'https://mclink.example.com'"
        />
        <div class="hint">
          自建实例就填你自己的地址（<span class="mono">https://mclink.example.com</span> 或
          <span class="mono">http://192.168.1.10:8787</span>）。换完会自动重载应用。
          <b>账号密码会发给这台主控</b>，只填你信任的实例。
          <template v-if="!HAS_BUILT_IN_MASTER">本包<strong>没有内置</strong>任何主控地址，留空就回到"没有主控"。</template>
        </div>
        <div class="ops">
          <button class="btn btn-sm" type="button" @click="applyMaster">保存并重载</button>
          <button
            v-if="masterIsCustom"
            class="btn btn-sm btn-ghost"
            type="button"
            @click="masterInput = ''; applyMaster()"
          >
            恢复默认
          </button>
        </div>
        <div v-if="masterMessage" class="hint">{{ masterMessage }}</div>
      </div>
      </template>

      <!--
        本地联机（不需要主控）——与"填主控地址"并列的第二条路。
        两类玩家都会走到这里：没有主控的人（官方停服）、以及只想和固定几个朋友开黑的人。
      -->
      <LocalRoomCard />
    </div>
  </div>
</template>

<style scoped>
/* 登录卡自己限宽并**垂直居中**：它现在长在 940×580 的横向外壳里，
 * 铺满整屏会散、贴着顶部又会在右下角多出一条滚动条（实测两个都出现过）。 */
.login {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 0;
}
.login-card {
  width: min(420px, 100%);
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-5);
}
.login-lede {
  margin: 0;
  text-align: center;
  color: var(--ink-2);
  font-size: var(--fs-sm);
}
.tabs {
  align-self: center;
}
.login-submit {
  width: 100%;
  min-height: 44px;
}
.warn-text {
  color: var(--fault);
}
/* 自建实例入口：一行小字 + 一个纯文字按钮，权重压到最低（普通玩家不该被它吸引） */
.master-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: center;
  gap: var(--s-2);
  margin-top: var(--s-1);
}
.master-toggle {
  border: none;
  background: none;
  padding: 0;
  color: var(--signal);
  font-size: var(--fs-xs);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.master-row .hint {
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}
</style>
