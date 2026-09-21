/** 登录态：当前用户与角色，供路由守卫与界面使用 */
import { computed, ref } from 'vue';
import type { UserSelf } from '@mclink/shared';
import { Routes } from '@mclink/shared';
import { api, getToken, setToken } from './api.ts';

const user = ref<UserSelf | null>(null);
const loading = ref(false);
const loaded = ref(false);

export const currentUser = user;
export const authLoading = loading;

export const isLoggedIn = computed(() => user.value !== null);
export const isAdmin = computed(() => user.value?.role === 'admin');

/** 拉取当前用户；未登录返回 null（不抛错） */
export async function loadCurrentUser(): Promise<UserSelf | null> {
  if (!getToken()) {
    user.value = null;
    loaded.value = true;
    return null;
  }
  loading.value = true;
  try {
    user.value = await api.get<UserSelf>(Routes.me, { silentAuth: true });
  } catch {
    user.value = null;
    setToken(null);
  } finally {
    loading.value = false;
    loaded.value = true;
  }
  return user.value;
}

export function isAuthLoaded(): boolean {
  return loaded.value;
}

export async function login(username: string, password: string): Promise<UserSelf> {
  const result = await api.post<{ token: string; user: UserSelf }>(Routes.login, { username, password });
  setToken(result.token);
  user.value = result.user;
  loaded.value = true;
  return result.user;
}

export async function register(
  username: string,
  password: string,
  displayName?: string,
  email?: string,
): Promise<{ user: UserSelf; emailSent: boolean; emailError: string | null }> {
  const result = await api.post<{
    token: string;
    user: UserSelf;
    emailSent?: boolean;
    emailError?: string | null;
  }>(Routes.register, { username, password, displayName, email });
  setToken(result.token);
  user.value = result.user;
  loaded.value = true;
  return { user: result.user, emailSent: result.emailSent === true, emailError: result.emailError ?? null };
}

/** 邮箱验证状态（未登录时抛 401，由调用方处理） */
export async function emailStatus(): Promise<{
  email: string | null;
  verified: boolean;
  codeExpiresAt: string | null;
  resendAfterSeconds: number;
  required: boolean;
}> {
  return api.get('/auth/email');
}

export async function startEmailVerification(email: string): Promise<{ email: string; expiresAt: string | null }> {
  return api.post(Routes.emailStart, { email });
}

export async function submitEmailCode(code: string): Promise<UserSelf> {
  const result = await api.post<{ user: UserSelf }>(Routes.emailVerify, { code });
  user.value = result.user;
  return result.user;
}

export async function logout(): Promise<void> {
  try {
    await api.post(Routes.logout);
  } catch {
    /* 即使服务端失败也要清掉本地登录态 */
  }
  setToken(null);
  user.value = null;
}
