/** 极轻量的全局提示（toast），不引第三方库 */
import { ref } from 'vue';

export type ToastLevel = 'info' | 'ok' | 'warn' | 'error';

export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  /** 毫秒；0 表示不自动消失 */
  duration: number;
}

const items = ref<Toast[]>([]);
let seq = 0;

export const toasts = items;

export function toast(message: string, level: ToastLevel = 'info', duration = 3600): number {
  const id = (seq += 1);
  items.value = [...items.value, { id, level, message, duration }];
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

export function dismissToast(id: number): void {
  items.value = items.value.filter((t) => t.id !== id);
}

export const notifyOk = (m: string): number => toast(m, 'ok');
export const notifyWarn = (m: string): number => toast(m, 'warn');
export const notifyError = (m: string, duration = 6000): number => toast(m, 'error', duration);
