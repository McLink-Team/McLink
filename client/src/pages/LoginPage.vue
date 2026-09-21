<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { clientState, login, register, setDevice, setMaster } from '../lib/store.ts';
import { friendlyError, getMasterUrl } from '../lib/api.ts';
import { passwordProblem } from '@mclink/shared';

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const password2 = ref('');
const displayName = ref('');
const master = ref(getMasterUrl());
const device = ref(clientState.deviceName);
const busy = ref(false);
const error = ref('');

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (!username.value.trim() || !password.value) return false;
  if (mode.value === 'register') {
    if (password.value !== password2.value) return false;
    if (passwordProblem(password.value)) return false;
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
    setMaster(master.value);
    setDevice(device.value.trim() || device.value);
    if (mode.value === 'login') {
      await login(username.value.trim(), password.value);
    } else {
      await register(username.value.trim(), password.value, displayName.value.trim() || undefined);
    }
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="aurora login-wrap">
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
        <label class="label">主控地址</label>
        <input v-model="master" class="input mono" placeholder="http://your-master.example.com" />
        <div class="hint">填写平台官网给出的地址；自建主控则填自己的地址。</div>
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
  </div>
</template>
