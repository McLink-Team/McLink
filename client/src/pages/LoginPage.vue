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
 */
import { computed, onMounted, ref } from 'vue';
import { clearAuthNotice, clientState, login, register, setDevice } from '../lib/store.ts';
import { friendlyError } from '../lib/api.ts';
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
      <p class="login-lede">登录后建房，或者用朋友的加入码进房</p>

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
</style>
