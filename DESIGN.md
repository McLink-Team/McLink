# mclink 设计系统

> 完整取舍与理由见 [`docs/design.md`](docs/design.md)。本文件是给设计与代码检查工具
> 读的**契约摘要**：它声明这套界面**故意**长成这样，以及哪些值是唯一合法来源。

设计世界叫 **「信号室 / Signal Room」**：产品本质是一条必须稳住的链路，
所以视觉语言取自**仪器面板**——暖墨底、纸白字、单一琥珀强调色、发丝分隔线。
层级靠留白、字号与发丝线建立，不靠色块和投影堆叠。

## 唯一事实来源

一切颜色、字号、间距、圆角、动效曲线都来自
[`packages/shared/src/design/tokens.css`](packages/shared/src/design/tokens.css)。
网页端与 Electron 客户端共用同一份令牌；页面与组件 CSS 里**不出现十六进制或 `rgba(...)`**。

| 类别 | 令牌 | 值 |
| --- | --- | --- |
| 页面底 / 抬升面 | `--ink-900` / `--ink-800` / `--ink-700` | `#121110` / `#1d1b18` / `#262320` |
| 正文 / 次级 / 说明 / 最弱 | `--paper` `--paper-2` `--paper-dim` `--paper-faint` | `#f5f0e7` `#ddd5c7` `#bdb3a4` `#9b9184` |
| 唯一强调色（琥珀） | `--signal` | `#e9a441` |
| 语义色（低饱和） | `--link` `--warn` `--fault` `--sky` | `#8fbf6a` `#d9a441` `#d9705f` `#86a8c4` |
| 1px 状态描边 | `--signal-line` `--link-line` `--warn-line` `--fault-line` `--sky-line` | 语义色 @ ~0.4 alpha |
| 结构 | `--rule` `--rule-strong` `--rule-faint` | 纸白 @ 0.10 / 0.18 / 0.06 |
| 字体 | `--font-display` `--font-sans` `--font-mono` | Bricolage Grotesque / Archivo / IBM Plex Mono |
| 字号 | `--fs-xs` … `--fs-5xl` | 12.5 → 62px（正文字号不允许小于 12.5px） |
| 动效 | `--ease` `--dur-fast` `--dur` `--dur-slow` | `cubic-bezier(0.16, 1, 0.3, 1)`，120 / 260 / 620ms |

数据（IP、端口、延迟、流量、加入码）一律 `--font-mono` + `tabular-nums`，跳动时数字不抖。

## 刻意不用的写法（请勿"优化"回来）

- 青绿→靛蓝→紫色对角渐变、渐变文字；`--grad-*` 只是实色别名
- 深色底上的青色霓虹字、径向光斑、"极光"背景
- 玻璃拟态：`backdrop-filter` 不作装饰；弹层遮罩用 `--scrim` 压暗，不加模糊
- 卡片左侧 3px 彩色色条、标题上方的 eyebrow/kicker 小标签
- 零偏移发光阴影；投影只给真正浮起来的东西（`--shadow` / `--shadow-lg`）
- 把 sparkline 当内容（只能辅助，不能代替数字）
- 过度使用的字体（Inter / Instrument Sans 等）

## 硬性可读性要求

1. 正文不小于 12.5px（`--fs-xs`）。
2. 「自己有文字 + 有边框或底色」的元素，垂直内边距 ≥4.3px；
   按钮用 `min-height` + 真实 `padding`，不要 `height` + `padding: 0`。
3. 长字符串（hash、ID、URL、配置片段）必须能换行（`overflow-wrap: anywhere`），
   **不要**截断成省略号——它们唯一的价值就是被完整读出来或复制。
4. 客户端是 520px 窄窗单列；宽内容（表格）由容器自己横向滚动，不撑破窗口。

## 已知的产品决定

- **不做置顶迷你悬浮窗**：多一个窗口会挡游戏画面；玩家的真实动作只是把联机地址发出去。
  房间页的地址做成**铭牌**，整块可点即复制（`RoomPage.vue` 的 `.address-hit`）。
- **进房后直接落到房间页**（`App.vue` 的 `watch(hasRoom)`）。
- 复制一律走 `client/src/lib/clipboard.ts` 的 `copyText()`：异步剪贴板失败时
  退到 `execCommand('copy')`，因为无边框窗口失焦时 `clipboard.writeText` 会抛错。
