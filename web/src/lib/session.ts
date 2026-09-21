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

export async function register(username: string, password: string, displayName?: string): Promise<UserSelf> {
  const result = await api.post<{ token: string; user: UserSelf }>(Routes.register, {
    username,
    password,
    displayName,
  });
  setToken(result.token);
  user.value = result.user;
  loaded.value = true;
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
