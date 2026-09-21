/**
 * 亮色 / 暗色：跟随系统，也可以在设置里手动钉住。
 *
 * 为什么不用纯 CSS 的 `@media (prefers-color-scheme: light)` 覆盖一遍变量：
 * 那样同一套亮色值得写两处（媒体查询里一份、`[data-theme=light]` 一份），迟早会漂。
 * 这里改成**用 JS 把偏好写进 `<html data-theme>`**，CSS 里只有一份亮色定义
 * （见 tokens.css），顺带获得两个好处：
 *   · `?theme=light|dark` 可以强制某个模式 —— 本地核对与设计检查器要用；
 *   · 桌面端（Electron）与网页端共用同一段逻辑。
 *
 * 三种偏好：
 *   auto（默认）—— 跟随系统，系统换了立刻跟着换；
 *   light / dark —— 玩家手动钉住，系统再变也不动。
 * 偏好存在 localStorage 的 `mclink.theme`。**`?theme=` 参数优先级最高**：
 * 它只用于检测与本地核对，不该被玩家的历史偏好盖掉。
 *
 * 这个文件在 `packages/shared` 里，而 shared 同时被**服务端**引用，所以：
 *   · 不假设存在 DOM（用最小结构化类型 + globalThis 取，取不到就静默跳过）；
 *   · 不引 DOM lib，避免整个 shared 包被绑上浏览器类型。
 * 防闪烁：本模块必须在**首屏绘制之前**执行。网页端在 index.html 里内联了同样逻辑的
 * 一小段脚本（模块化加载太晚）；桌面端不需要 —— Electron 窗口是 `show:false` +
 * `ready-to-show`，首帧本来就不显示。
 */

export type ThemePreference = 'light' | 'dark';
/** 玩家的三档选择：跟随系统 / 钉住亮色 / 钉住暗色 */
export type ThemeChoice = 'auto' | ThemePreference;

const THEME_KEY = 'mclink.theme';

/** 只为这个文件服务的最小 DOM 形状（避免给整个 shared 包加 DOM lib） */
interface MinimalDocument {
  documentElement: {
    dataset: Record<string, string | undefined>;
    style: { colorScheme?: string };
  };
}
interface MinimalMediaQueryList {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}
interface MinimalWindow {
  location?: { search?: string };
  matchMedia?: (query: string) => MinimalMediaQueryList;
  localStorage?: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
}

function doc(): MinimalDocument | null {
  return (globalThis as { document?: MinimalDocument }).document ?? null;
}

function win(): MinimalWindow | null {
  return (globalThis as { window?: MinimalWindow }).window ?? null;
}

/** 从 URL 读强制值：?theme=light / ?theme=dark；其它值忽略 */
export function forcedTheme(search?: string): ThemePreference | null {
  const query = search ?? win()?.location?.search ?? '';
  if (!query) return null;
  const value = new URLSearchParams(query).get('theme');
  return value === 'light' || value === 'dark' ? value : null;
}

/** 系统当前偏好（拿不到 matchMedia 时按暗色，与出厂默认一致） */
export function systemTheme(): ThemePreference {
  return win()?.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
}

/** 玩家保存的偏好；没存过或值不合法都按 auto */
export function themeChoice(): ThemeChoice {
  try {
    const raw = win()?.localStorage?.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'auto' ? raw : 'auto';
  } catch {
    // 隐私模式等场景下读 localStorage 会抛，不能因此起不来
    return 'auto';
  }
}

/** 当前应该生效的模式：?theme= 优先，其次玩家偏好，最后系统 */
export function effectiveTheme(choice: ThemeChoice = themeChoice()): ThemePreference {
  return forcedTheme() ?? (choice === 'auto' ? systemTheme() : choice);
}

function paint(theme: ThemePreference): void {
  const root = doc()?.documentElement;
  if (!root) return;
  // 只有变化时才写，避免每次 matchMedia 事件都触发一次样式重算
  if (root.dataset.theme !== theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }
}

/**
 * 应用主题并开始跟随系统变化；返回取消订阅函数。
 * auto 才会订阅系统变化；玩家钉住某个模式后系统再变也不动。
 */
export function applyAutoTheme(): () => void {
  if (!doc()) return () => {};
  paint(effectiveTheme());
  return watchAutoTheme();
}

/** 单独暴露订阅，方便「改完偏好再订阅」的场景 */
export function watchAutoTheme(): () => void {
  if (forcedTheme()) return () => {}; // 强制模式不跟随系统
  const media = win()?.matchMedia?.('(prefers-color-scheme: light)');
  if (!media?.addEventListener || !media.removeEventListener) return () => {};
  const onChange = (): void => {
    if (themeChoice() === 'auto') paint(effectiveTheme('auto'));
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener?.('change', onChange);
}

/**
 * 切换偏好：写盘 + 立刻生效 + 返回取消订阅函数（auto 才需要订阅系统）。
 * 设置页的按钮直接调它，不需要自己去碰 data-theme。
 */
export function setThemeChoice(choice: ThemeChoice): () => void {
  try {
    win()?.localStorage?.setItem(THEME_KEY, choice);
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  paint(effectiveTheme(choice));
  return watchAutoTheme();
}

/** 当前生效的模式（读的是已经写好的 data-theme） */
export function currentTheme(): ThemePreference {
  return doc()?.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
