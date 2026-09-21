<script setup lang="ts">
/**
 * 登录 / 注册页。
 * 两种模式共用一个组件（`/register` 通过路由 props 传入 initialMode），
 * 成功后管理员进控制台，普通玩家回落地页并给一条提示。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { Routes } from '@mclink/shared';
import { ApiError, api, friendlyError } from '../lib/api.ts';
import { currentUser, login, register } from '../lib/session.ts';
import { notifyError, notifyOk, notifyWarn } from '../lib/toast.ts';

const props = withDefaults(defineProps<{ initialMode?: 'login' | 'register' }>(), {
  initialMode: 'login',
});

const route = useRoute();
const router = useRouter();

const mode = ref<'login' | 'register'>(props.initialMode);
const submitting = ref(false);
const formError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const form = reactive({
  username: '',
  password: '',
  confirm: '',
  displayName: '',
});

const siteName = ref('mclink');
const registrationOpen = ref(true);

const isRegister = computed(() => mode.value === 'register');
const title = computed(() => (isRegister.value ? '创建账号' : '登录 mclink'));
const subtitle = computed(() =>
  isRegister.value
    ? '注册后即可创建或加入房间；第一个注册的账号会成为管理员。'
    : '登录后即可创建房间、邀请好友，管理员可进入控制台。',
);

onMounted(() => {
  if (route.query.forbidden === '1') {
    notifyWarn('需要管理员权限才能进入控制台');
  }
  void api
    .get<{ siteName: string; registrationOpen: boolean }>(Routes.meta)
    .then((m) => {
      siteName.value = m.siteName;
      registrationOpen.value = m.registrationOpen;
    })
    .catch(() => {
      /* 元信息拿不到不影响登录，静默降级 */
    });
});

function switchMode(next: 'login' | 'register'): void {
  mode.value = next;
  formError.value = null;
  fieldErrors.value = {};
}

/** 与服务端 passwordProblem 保持一致的本地前置校验，减少一次往返 */
function validate(): string | null {
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(form.username.trim())) {
    return '用户名只能是 3-24 位字母、数字或下划线';
  }
  if (form.password.length < 8) return '密码至少 8 位';
  if (!/[a-zA-Z]/.test(form.password) || !/\d/.test(form.password)) {
    return '密码需要同时包含字母和数字';
  }
  if (isRegister.value && form.password !== form.confirm) return '两次输入的密码不一致';
  return null;
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  formError.value = null;
  fieldErrors.value = {};

  const problem = validate();
  if (problem) {
    formError.value = problem;
    return;
  }

  submitting.value = true;
  try {
    const user = isRegister.value
      ? await register(form.username.trim(), form.password, form.displayName.trim() || undefined)
      : await login(form.username.trim(), form.password);

    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : null;
    if (user.role === 'admin') {
      notifyOk(isRegister.value ? '注册成功，已以管理员身份登录' : '登录成功');
      await router.push(redirect ?? '/console/dashboard');
    } else {
      notifyOk(isRegister.value ? '注册成功，欢迎加入' : '登录成功');
      await router.push(redirect ?? '/');
    }
  } catch (err) {
    if (err instanceof ApiError && err.fields) {
      fieldErrors.value = err.fields;
    }
    formError.value = friendlyError(err);
    notifyError(formError.value);
  } finally {
    submitting.value = false;
  }
}

const displayName = computed(() => currentUser.value?.displayName ?? null);
</script>

<template>
  <div class="auth aurora">
    <div class="auth-glow" aria-hidden="true" />
    <div class="auth-inner">
      <RouterLink class="auth-brand" to="/">
        <span class="brand-mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M4 16.5c0-1.2 1-2.1 2.2-1.9l3.1.5 3-5.4-2.4-2.6 1.6-3.1 3.4 1 1.4 3.2 3.2.7c1.5.3 2.5 1.6 2.5 3.1" />
            <path d="M3 20h18" />
          </svg>
        </span>
        <span class="brand-text">{{ siteName }}</span>
      </RouterLink>

      <div class="card auth-card">
        <div class="auth-head">
          <h1>{{ title }}</h1>
          <p class="muted">{{ subtitle }}</p>
        </div>

        <div v-if="displayName" class="auth-hint">
          <span class="badge badge-ok">已登录</span>
          当前账号 {{ displayName }}，直接去
          <RouterLink to="/console/dashboard">控制台</RouterLink> 或
          <RouterLink to="/">返回首页</RouterLink>。
        </div>

        <div class="tabs">
          <button
            type="button"
            class="tab"
            :class="{ 'tab-active': !isRegister }"
            @click="switchMode('login')"
          >
            登录
          </button>
          <button
            type="button"
            class="tab"
            :class="{ 'tab-active': isRegister }"
            @click="switchMode('register')"
          >
            注册
          </button>
        </div>

        <form class="stack" @submit.prevent="submit">
          <div class="field">
            <label class="label" for="username">用户名</label>
            <input
              id="username"
              v-model="form.username"
              class="input"
              type="text"
              autocomplete="username"
              placeholder="3-24 位字母、数字或下划线"
              :disabled="submitting"
            />
            <span v-if="fieldErrors.username" class="field-error">{{ fieldErrors.username }}</span>
          </div>

          <div v-if="isRegister" class="field">
            <label class="label" for="displayName">显示名（可选）</label>
            <input
              id="displayName"
              v-model="form.displayName"
              class="input"
              type="text"
              maxlength="32"
              placeholder="房间里展示的名字，默认与用户名相同"
              :disabled="submitting"
            />
          </div>

          <div class="field">
            <label class="label" for="password">密码</label>
            <input
              id="password"
              v-model="form.password"
              class="input"
              type="password"
              :autocomplete="isRegister ? 'new-password' : 'current-password'"
              :placeholder="isRegister ? '至少 8 位，需包含字母与数字' : '请输入密码'"
              :disabled="submitting"
            />
            <span v-if="fieldErrors.password" class="field-error">{{ fieldErrors.password }}</span>
            <span v-else-if="isRegister" class="hint">密码规则：至少 8 位，且同时包含字母与数字。</span>
          </div>

          <div v-if="isRegister" class="field">
            <label class="label" for="confirm">确认密码</label>
            <input
              id="confirm"
              v-model="form.confirm"
              class="input"
              type="password"
              autocomplete="new-password"
              placeholder="再输入一次密码"
              :disabled="submitting"
            />
            <span v-if="form.confirm && form.confirm !== form.password" class="field-error">两次输入的密码不一致</span>
          </div>

          <p v-if="formError" class="form-error">{{ formError }}</p>

          <div v-if="isRegister && !registrationOpen" class="warn-inline">
            当前平台已关闭自助注册，请联系管理员开号；若这是全新部署，第一个注册的账号仍然可用。
          </div>

          <button class="btn btn-primary btn-block" type="submit" :disabled="submitting">
            <span v-if="submitting" class="spinner" />
            {{ submitting ? '处理中…' : isRegister ? '注册并登录' : '登录' }}
          </button>
        </form>

        <p class="auth-foot faint">
          <RouterLink to="/">← 返回首页</RouterLink>
          <span>·</span>
          <RouterLink to="/download">下载客户端</RouterLink>
        </p>
      </div>

      <p class="auth-license faint">
        mclink 基于 EasyTier（LGPL-3.0）构建，账号仅用于房间准入与流量统计。
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--s-6) var(--s-4);
}
/* 比落地页收敛：只在卡片附近留一点极光，避免抢焦点 */
.auth-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(600px 320px at 50% 30%, color-mix(in srgb, var(--brand) 14%, transparent), transparent 70%);
  pointer-events: none;
}
.auth-inner {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 440px;
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  align-items: stretch;
}
.auth-brand {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  justify-content: center;
}
.brand-mark {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--grad-brand);
  color: var(--bg-0);
}
.brand-mark svg {
  width: 20px;
  height: 20px;
}
.brand-text {
  font-size: var(--fs-lg);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.auth-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  box-shadow: var(--shadow-lg);
  background: color-mix(in srgb, var(--bg-1) 86%, transparent);
}
.auth-head {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.auth-head h1 {
  font-size: var(--fs-xl);
}
.auth-head p {
  font-size: var(--fs-sm);
}
.auth-hint {
  font-size: var(--fs-sm);
  color: var(--text-dim);
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--border);
}
.auth-hint a {
  color: var(--brand);
}
.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s-1);
  padding: 3px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--border);
}
.tab {
  height: 32px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-sm);
  font-weight: 560;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.tab-active {
  background: var(--surface-strong);
  color: var(--text);
}
.form-error {
  font-size: var(--fs-sm);
  color: var(--danger);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  background: var(--danger-bg);
  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
}
.warn-inline {
  font-size: var(--fs-xs);
  color: var(--warn);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  background: var(--warn-bg);
  border: 1px solid color-mix(in srgb, var(--warn) 24%, transparent);
}
.auth-foot {
  display: flex;
  gap: var(--s-2);
  justify-content: center;
  font-size: var(--fs-xs);
}
.auth-foot a:hover {
  color: var(--brand);
}
.auth-license {
  text-align: center;
  font-size: var(--fs-xs);
}
</style>
