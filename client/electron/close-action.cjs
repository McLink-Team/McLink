/**
 * 「关闭窗口时怎么办」的判定（纯逻辑，便于离线断言）。
 *
 * 背景（用户反馈）：以前点 X 直接最小化到托盘，**没有任何提示** ——
 * 玩家以为退出了、其实还在后台跑着（联机也没断），下次开机又莫名其妙多一个进程。
 * 现在三种模式：
 *   · ask  —— 关的时候问一次「彻底退出 / 最小化到托盘」（可勾"记住我的选择"）
 *   · tray —— 直接最小化到托盘（老行为，用户明确选过才用）
 *   · quit —— 直接彻底退出
 * 默认是 ask：从老版本升上来的用户第一次关窗口时会被问一次，之后按自己的选择走。
 */

/** 关闭行为：询问 / 最小化到托盘 / 彻底退出 */
const CLOSE_ACTIONS = ['ask', 'tray', 'quit'];

/** 归一化：非法值或缺失一律回落到 ask（宁可多问一次，也别替用户决定） */
function normalizeCloseAction(value) {
  return CLOSE_ACTIONS.includes(value) ? value : 'ask';
}

/**
 * 用户在弹窗里点了什么 → 该做什么 + 要不要把这个选择记成默认。
 * @param choice 'tray' | 'quit' | 'cancel'
 * @param remember 是否勾了「记住我的选择」
 * @returns {{ action: 'tray' | 'quit' | 'cancel', persist: 'tray' | 'quit' | null }}
 */
function resolveCloseChoice(choice, remember) {
  const action = choice === 'quit' || choice === 'cancel' ? choice : 'tray';
  // 「取消」不是一种默认行为，记不住
  const persist = remember === true && action !== 'cancel' ? action : null;
  return { action, persist };
}

module.exports = { CLOSE_ACTIONS, normalizeCloseAction, resolveCloseChoice };
