<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { clientState, login, register, setDevice } from '../lib/store.ts';
import { USING_DEV_MASTER, friendlyError, getMasterUrl } from '../lib/api.ts';
import { emailProblem, passwordProblem } from '@mclink/shared';
import PublicPlaza from '../components/PublicPlaza.vue';

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const password2 = ref('');
const displayName = ref('');
const email = ref('');
const device = ref(clientState.deviceName);
const busy = ref(false);
const error = ref('');

/** 主控地址是编译期固定的，只展示不可编辑 */
const master = computed(() => getMasterUrl());
const isDevMaster = USING_DEV_MASTER;

/** 平台是否要求验证邮箱（来自 /meta）：是的话注册表单把邮箱变成必填 */
const emailRequired = computed(() => clientState.platform.requireEmailVerification);

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (!username.value.trim() || !password.value) return false;
  if (mode.value === 'register') {
    if (password.value !== password2.value) return false;
    if (passwordProblem(password.value)) return false;
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
  <div class="aurora login-scroll">
    <div class="login-col">
      <div class="login-card stack">
        <div class="center stack" style="gap: 6px">
          <div class="brand" style="justify-content: center; font-size: 24px">
            <span class="brand-mark" />
            <span>mclink</span>
          </div>
          <div class="muted" style="font-size: var(--fs-sm)">《我的世界》联机客户端 · 选好区域，一键开黑</div>
        </div>

        <div class="tabs" style="align-self: center">
          <button class="tab" :class="{ active: mode === 'login' }" @click="mode = 'login'">登录</button>
          <button class="tab" :class="{ active: mode === 'register' }" @click="mode = 'register'">注册</button>
        </div>

        <div class="field">
          <label class="label">服务器</label>
          <div class="server-line mono" :title="master">{{ master }}</div>
          <div v-if="isDevMaster" class="hint" style="color: var(--warn)">
            当前是本地开发地址（打包时未注入 VITE_MCLINK_MASTER），正式客户端会固定指向官方主控。
          </div>
          <div v-else class="hint">主控地址在客户端中固定，无需也不能修改。</div>
        </div>

        <div class="field">
          <label class="label">用户名</label>
          <input v-model="username" class="input" autocomplete="username" placeholder="3-24 位字母、数字或下划线" />
        </div>

        <div class="field">
          <label class="label">密码</label>
          <input v-model="password" class="input" type="password" autocomplete="current-password" placeholder="至少 8 位，含字母与数字" />
        </div>

        <template v-if="mode === 'register'">
          <div class="field">
            <label class="label">确认密码</label>
            <input v-model="password2" class="input" type="password" autocomplete="new-password" />
            <div v-if="password2 && password !== password2" class="hint" style="color: var(--danger)">两次输入不一致</div>
          </div>
          <div class="field">
            <label class="label">邮箱{{ emailRequired ? '' : '（可选）' }}</label>
            <input
              v-model="email"
              class="input"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
            />
            <div v-if="email && emailProblem(email.trim())" class="hint" style="color: var(--danger)">
              {{ emailProblem(email.trim()) }}
            </div>
            <div v-else-if="emailRequired" class="hint">注册后会把 6 位验证码发到这个邮箱，验证完才能建房、进房。</div>
          </div>
          <div class="field">
            <label class="label">昵称（可选）</label>
            <input v-model="displayName" class="input" placeholder="会显示在房间成员列表里" />
          </div>
        </template>

        <div class="field">
          <label class="label">本机名称</label>
          <input v-model="device" class="input" placeholder="例如 书房的电脑" />
          <div class="hint">房主靠这个认出你。</div>
        </div>

        <div v-if="error" class="alert alert-danger">{{ error }}</div>

        <button class="btn btn-primary btn-lg btn-block" :disabled="!canSubmit" @click="submit">
          <span v-if="busy" class="spinner" />
          <span>{{ mode === 'login' ? '登录并开始联机' : '注册新账号' }}</span>
        </button>

        <div class="hint center">
          登录即表示你同意仅将本平台用于合法的《我的世界》联机用途。
        </div>
      </div>

      <!-- 未登录也能看大厅：/rooms/public 是匿名接口，只是不能加入 -->
      <PublicPlaza :can-join="false" />
    </div>
  </div>
</template>

<style scoped>
/* 登录页现在要放下「登录卡片 + 公共房间广场」，因此整页可滚动（两个类提高优先级） */
.aurora.login-scroll {
  display: block;
  overflow: auto;
  padding: var(--s-5);
}
.login-col {
  width: min(720px, 100%);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

/* 只读的服务器地址：做成"铭牌"的样子，明确它不可编辑 */
.server-line {
  padding: 0 var(--s-3);
  height: 36px;
  display: flex;
  align-items: center;
  border-radius: var(--r-sm);
  border: 1px dashed var(--border-strong);
  background: var(--surface-hair);
  color: var(--text-dim);
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
</style>
