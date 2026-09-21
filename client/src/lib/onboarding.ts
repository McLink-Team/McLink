/**
 * 首次使用向导的可见性状态。
 *
 * 独立成模块是为了让「设置」页也能重新唤起向导 ——
 * 直接在组件里读 localStorage 的话，向导关掉之后就没有入口再打开了。
 */
import { ref } from 'vue';

const ONBOARDING_KEY = 'mclink.onboarding.done';

function hasFinished(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    // 读不到存储时不要反复弹向导，直接当作已完成
    return true;
  }
}

/** 首次启动（未写过标记）时为 true */
export const onboardingVisible = ref(!hasFinished());

/** 关闭向导；persist=true 表示「不再显示」 */
export function closeOnboarding(persist: boolean): void {
  if (persist) {
    try {
      localStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      /* ignore */
    }
  }
  onboardingVisible.value = false;
}

/** 从「设置」页重新打开向导 */
export function reopenOnboarding(): void {
  onboardingVisible.value = true;
}
