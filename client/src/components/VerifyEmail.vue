<script setup lang="ts">
/**
 * 验证邮箱面板。
 *
 * 平台开启「要求验证邮箱」后，未验证的账号**不能建房/进房**（服务端硬门禁），
 * 所以这里不是可关的提示，而是登录后的一道关卡：界面直接停在这一页，
 * 把"怎么验证"讲清楚，而不是等玩家点了建房才弹一句 403。
 *
 * 两种入口共用一个组件：
 *   · 注册后（已经有邮箱，码应该刚到）—— 直接显示验证码输入框
 *   · 老账号/换绑（还没有邮箱）—— 先显示邮箱输入框
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { clientState, refreshEmailStatus, startEmailVerification, submitEmailCode } from '../lib/store.ts';
import { friendlyError } from '../lib/api.ts';

const emailInput = ref(clientState.email.email ?? '');
const code = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const cooldown = ref(0);
let timer: number | null = null;

const hasEmail = computed(() => (clientState.email.email ?? '').length > 0);
const verified = computed(() => clientState.email.verified);

/** 重发冷却倒计时：服务端有 60 秒间隔限制，界面必须同步显示，否则玩家会反复点 */
function startCooldown(seconds: number): void {
  cooldown.value = Math.max(0, Math.floor(seconds));
  if (timer !== null) window.clearInterval(timer);
  timer = window.setInterval(() => {
    cooldown.value = Math.max(0, cooldown.value - 1);
    if (cooldown.value === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }, 1000);
}

onMounted(async () => {
  await refreshEmailStatus();
  if (clientState.email.resendAfterSeconds > 0) startCooldown(clientState.email.resendAfterSeconds);
  if (!emailInput.value && clientState.email.email) emailInput.value = clientState.email.email;
});

onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer);
});

async function send(): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await startEmailVerification(emailInput.value.trim());
    notice.value = `验证码已发送到 ${emailInput.value.trim()}，请查收（也看看垃圾邮件）。`;
    startCooldown(60);
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function verify(): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await submitEmailCode(code.value.trim());
    notice.value = '邮箱已验证，可以开始联机了。';
    code.value = '';
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function resend(): Promise<void> {
  if (cooldown.value > 0) return;
  await send();
}
</script>

<template>
  <div class="view verify">
    <div class="card stack">
      <div>
        <div class="verify-title">先验证邮箱</div>
        <p class="hint" style="margin-top: 6px">
          {{ clientState.platform.emailServiceAvailable
            ? '这个平台要求绑定并验证邮箱后才能建房、进房。验证码会发到你的邮箱，15 分钟内有效。'
            : '这个平台要求验证邮箱，但主控还没有配置邮件服务 —— 请联系管理员处理。' }}
        </p>
      </div>

      <div v-if="verified" class="alert alert-ok">
        <span class="grow">邮箱 <span class="mono">{{ clientState.email.email }}</span> 已验证。</span>
      </div>

      <template v-else>
        <div class="stack" style="gap: var(--s-2)">
          <label class="label" for="verify-email">邮箱地址</label>
          <div class="row">
            <input
              id="verify-email"
              v-model="emailInput"
              class="input grow"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              :disabled="busy"
              @keyup.enter="send()"
            />
            <button class="btn" :disabled="busy || cooldown > 0 || emailInput.trim().length === 0" @click="send()">
              {{ cooldown > 0 ? `${cooldown}s 后可重发` : hasEmail ? '重新发送' : '发送验证码' }}
            </button>
          </div>
          <div class="hint">一个邮箱只能绑定一个账号；换邮箱需要重新验证。</div>
        </div>

        <div class="stack" style="gap: var(--s-2)">
          <label class="label" for="verify-code">验证码</label>
          <div class="row">
            <input
              id="verify-code"
              v-model="code"
              class="input mono grow"
              inputmode="numeric"
              maxlength="6"
              placeholder="6 位数字"
              :disabled="busy"
              @keyup.enter="verify()"
            />
            <button class="btn btn-primary" :disabled="busy || code.trim().length === 0" @click="verify()">
              验证
            </button>
          </div>
          <div class="hint">验证成功后本页会自动消失；没收到可以点「重新发送」。</div>
        </div>
      </template>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>
      <div v-if="notice" class="alert alert-ok">{{ notice }}</div>
    </div>
  </div>
</template>

<style scoped>
.verify {
  max-width: 520px;
}
.verify-title {
  font-family: var(--font-display);
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--track-display);
}
</style>
