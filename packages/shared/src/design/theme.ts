/**
 * 亮色 / 暗色：跟随系统。
 *
 * 为什么不用纯 CSS 的 `@media (prefers-color-scheme: light)` 覆盖一遍变量：
 * 那样同一套亮色值得写两处（媒体查询里一份、`[data-theme=light]` 一份），迟早会漂。
 * 这里改成**由 JS 把系统偏好写进 `<html data-theme>`**，CSS 里只有一份亮色定义
 * （见 tokens.css），顺带获得两个好处：
 *   · `?theme=light|dark` 可以强制某个模式 —— 本地核对与设计检查器要用；
 *   · 桌面端（Electron）与网页端共用同一段逻辑。
 *
 * 这个文件在 `packages/shared` 里，而 shared 同时被**服务端**引用，所以：
 *   · 不假设存在 DOM（用最小结构化类型 + globalThis 取，取不到就静默跳过）；
 *   · 不引 DOM lib，避免整个 shared 包被绑上浏览器类型。
 *
 * 防闪烁：本模块必须**在首屏绘制之前**执行。网页端在 index.html 里内联了同样逻辑的
 * 一小段脚本（模块化加载太晚）；桌面端不需要 —— Electron 窗口是 `show:false` +
 * `ready-to-show`，首帧本来就不显示。
 */

export type ThemePreference = 'light' | 'dark';

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

/**
 * 应用主题并开始跟随系统变化；返回取消订阅函数。
 * 非浏览器环境（服务端）直接返回空函数，不报错。
 */
export function applyAutoTheme(): () => void {
  const document_ = doc();
  if (!document_) return () => {};

  const forced = forcedTheme();
  const root = document_.documentElement;

  const sync = (): void => {
    const next: ThemePreference = forced ?? systemTheme();
    // 只有变化时才写，避免每次 matchMedia 事件都触发一次样式重算
    if (root.dataset.theme !== next) {
      root.dataset.theme = next;
      root.style.colorScheme = next;
    }
  };
  sync();

  if (forced) return () => {}; // 强制模式不跟随系统

  const media = win()?.matchMedia?.('(prefers-color-scheme: light)');
  if (!media?.addEventListener || !media.removeEventListener) return () => {};
  const onChange = (): void => sync();
  media.addEventListener('change', onChange);
  return () => media.removeEventListener?.('change', onChange);
}

/** 当前生效的模式（读的是已经写好的 data-theme） */
export function currentTheme(): ThemePreference {
  return doc()?.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
