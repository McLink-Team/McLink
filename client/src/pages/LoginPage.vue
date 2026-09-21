<script setup lang="ts">
/**
 * 未登录时的一屏：印记 + 品牌字 + 副标题，然后是登录 / 注册。
 *
 * 刻意不再显示任何服务器信息：玩家不需要知道、也无权修改它连的是哪台机器，
 * 把它摆在表单上方只会制造"我是不是填错了"的疑问。
 */
import { computed, onMounted, ref } from 'vue';
import { clientState, login, register, setDevice } from '../lib/store.ts';
import { friendlyError } from '../lib/api.ts';
import { emailProblem, passwordProblem } from '@mclink/shared';
import BrandLockup from '../components/BrandLockup.vue';
import PublicPlaza from '../components/PublicPlaza.vue';

defineProps<{ version: string }>();

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const password2 = ref('');
const displayName = ref('');
const email = ref('');
const device = ref(clientState.deviceName);
const busy = ref(false);
const error = ref('');
const showPlaza = ref(false);

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
  <div class="home">
    <div class="home-stage">
      <div class="home-main">
        <BrandLockup>登录后建房，或者用朋友的加入码进房</BrandLockup>

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
          </div>
        </template>

        <div class="field">
          <label class="label">本机名称</label>
          <input v-model="device" class="input" placeholder="例如 书房的电脑" />
          <div class="hint">房主靠这个认出你。</div>
        </div>

        <div v-if="error" class="alert alert-danger">{{ error }}</div>

        <button class="btn btn-primary home-cta" :disabled="!canSubmit" @click="submit">
          <span v-if="busy" class="spinner" />
          <span>{{ mode === 'login' ? '登录并开始联机' : '注册新账号' }}</span>
        </button>

        <button class="btn btn-ghost" type="button" @click="showPlaza = !showPlaza">
          {{ showPlaza ? '收起公共房间' : '先看看有哪些公共房间' }}
        </button>

        <!-- 未登录也能看大厅：/rooms/public 是匿名接口，只是不能加入 -->
        <PublicPlaza v-if="showPlaza" :can-join="false" />

        <p class="hint center">登录即表示你同意仅将本平台用于合法的《我的世界》联机用途。</p>
      </div>
    </div>

    <div class="home-foot mono">McLink{{ version ? ` v${version}` : '' }}</div>
  </div>
</template>

<style scoped>
.tabs {
  align-self: center;
}
.warn-text {
  color: var(--fault);
}
</style>
