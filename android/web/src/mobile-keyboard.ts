/**
 * 软键盘适配。
 *
 * ## 问题
 *
 * 手机上的聊天输入框一旦获得焦点，系统键盘会从底部升起。Android 上有两种处理方式
 * （见 AndroidManifest 的 `windowSoftInputMode`）：
 *   · `adjustPan` —— 把整个界面往上推。后果是**界面顶部被推出屏幕**，
 *     而且输入框到底有没有露出来全看运气；
 *   · `adjustResize` —— 把键盘占掉的高度从 Activity 里扣掉，WebView 变矮。
 *
 * 我们已经把 Activity 显式设成 `adjustResize`（Capacitor 模板没设，见 manifest 注释）。
 * 但只做那一步还不够：底部导航（`.mobile-dock`，56px + 安全区）会正好卡在
 * 输入框和键盘之间 —— 键盘弹起来了，输入框却还被自己的导航栏挡着。
 *
 * ## 做法
 *
 * `window.visualViewport` 是**唯一**能算准"键盘占了多高"的接口：
 * ```
 * 键盘高度 = window.innerHeight - visualViewport.height - visualViewport.offsetTop
 * ```
 * （`innerHeight` 是布局视口，`visualViewport.height` 是真正还能看见的那块。）
 *
 * 算出来写进 `--keyboard-inset`，并给 `<body>` 加 `kb-open`：
 * mobile-shell.css 据此**收起底部导航**，把那一整条还给输入框。
 *
 * ## 为什么不只用 CSS（`dvh` / `env(keyboard-inset-height)`）
 *
 *   · `dvh` 跟随的是布局视口，在 `adjustResize` 下它**本来就会缩**，等于没帮忙；
 *   · `env(keyboard-inset-height)` 是 Chrome 108+ 的试验特性，而 Android WebView
 *     的版本跨度很大（Capacitor 7 只要求 WebView 60+），不能作为唯一手段。
 *
 * 阈值 120px 而不是 0：`visualViewport` 在地址栏收缩、旋转、缩放时都会抖动，
 * 而任何手机软键盘都不可能低于 120px —— 用一个下限把抖动挡掉，
 * 避免导航栏在用户打字时反复闪。
 */

/** 低于这个高度不算键盘（挡掉地址栏收缩、旋转、页面缩放引起的抖动） */
const KEYBOARD_MIN_PX = 120;

export function installKeyboardInset(): void {
  const vv = window.visualViewport;
  /*
   * 拿不到 visualViewport 就直接不做。
   * 这不是"优雅降级"的客套话：没有它就没有可靠的键盘高度来源，
   * 硬猜一个值只会在某些机型上把界面弄得比不做还糟。
   */
  if (!vv) return;

  const root = document.documentElement;

  const apply = (): void => {
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    document.body.classList.toggle('kb-open', inset > KEYBOARD_MIN_PX);
  };

  vv.addEventListener('resize', apply);
  // scroll 也要听：键盘升起时系统会滚动可视视口，只监听 resize 会漏掉一部分机型
  vv.addEventListener('scroll', apply);
  apply();

  /**
   * 聚焦后把输入框滚进视野中部。
   *
   * 为什么要延迟 300ms：`adjustResize` 的布局收缩与键盘动画是异步的，
   * 立刻 `scrollIntoView` 算的是**收缩前**的位置 —— 滚完键盘才上来，结果还是被挡。
   * 300ms 大致是多数机型键盘动画的时长，是个务实的经验值。
   *
   * 只对 input/textarea 生效：对按钮之类的聚焦做滚动，会在用户点一下按钮时
   * 把界面莫名其妙地晃一下。
   */
  document.addEventListener('focusin', (event) => {
    const el = event.target as HTMLElement | null;
    if (!el) return;
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
    window.setTimeout(() => {
      // 用户可能在 300ms 内就把焦点移走了，这时不该再滚
      if (document.activeElement !== el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 300);
  });
}
