# mclink 视觉设计

这份文档记录 **mclink 的界面为什么长这样**，以及改界面时必须遵守的硬约束。
写它的直接原因是：视觉重做过一轮，而重做之前的默认做法（深蓝底 + 青绿霓虹 + 渐变）
是"AI 味"的主要来源；如果不把结论写下来，下一轮很容易又漂回去。

代码里的唯一事实来源是 `packages/shared/src/design/tokens.css`，本文只解释取舍。

---

## 1. 设计世界：信号室 / Signal Room

产品的本质是**一条必须稳住的链路**。玩家做的事是：建立连接 → 确认对方在线 → 一直在里面。
所以视觉语言取自**仪器面板**，而不是通用的深色 SaaS 落地页。

| 元素 | 取值 | 理由 |
| --- | --- | --- |
| 底色 | 暖墨 `--ink-900: #121110`（页面）、`--ink-800: #1d1b18`（抬升面） | 蓝黑底会让所有界面都像同一个模板 |
| 正文 | 纸白 `--paper: #f5f0e7`，不用纯白 | 纯白在暖底上刺眼且显廉价；实测对比度 17.4:1 |
| 次级文字 | `--paper-2 / --paper-dim / --paper-faint` | 三级足够；每级都按 WCAG AA 校过（最低 5.9:1） |
| 强调色 | **只有一个**：琥珀 `--signal: #e9a441` | 唯一的高饱和色，只用在真正需要指认的地方（主按钮、链接、地址铭牌） |
| 语义色 | `--link` / `--warn` / `--fault` / `--sky` | 刻意压低饱和度，避免变成"红绿灯面板" |
| 结构 | 发丝分隔线 `--rule / --rule-strong / --rule-faint` | 层级靠**留白、字号、发丝线**建立，不靠色块和投影堆叠 |
| 数据 | 一律 `--font-mono` + `tabular-nums` | IP / 端口 / 延迟 / 流量跳动时数字不抖 |
| 圆角 | `--r-xs 3px` ~ `--r-lg 12px` | 仪器不该长成圆润的糖果 |
| 动效 | `--ease: cubic-bezier(0.16, 1, 0.3, 1)`，120/260/620ms | 一条 authored 曲线，指数型 ease-out；不用回弹 |

字体三套（自托管，见 `scripts/fetch-fonts.mjs`）：`--font-display` 标题用 Bricolage Grotesque、
`--font-sans` 界面正文用 Archivo、`--font-mono` 数据用 IBM Plex Mono。
刻意避开 Inter / Instrument Sans —— 它们被设计检查器列为 `overused-font`。
中文交给系统字体栈（CJK 字体动辄数 MB，不适合随包分发）。

---

## 2. 明令禁止的写法

下面这些**都曾是这里的默认做法**，且都被实测判定为减分项。不要再用：

- 青绿 → 靛蓝 → 紫色的对角渐变（`--grad-*` 现在只是实色别名）、渐变文字（`background-clip: text`）
- 深色底上的青色霓虹字、径向模糊光斑、"极光"背景
- 玻璃拟态：把 `backdrop-filter` 当装饰用。**弹层遮罩也不用模糊**，直接用 `--scrim` 压暗
- 卡片左侧 3px 彩色色条
- 标题上方的 eyebrow / kicker 小标签
- 把 sparkline 当内容（它只能做辅助，不能代替数字）
- 零偏移发光阴影；投影只给真正浮起来的东西（`--shadow / --shadow-lg`）

---

## 3. 令牌契约（改界面时必须遵守）

1. **颜色只能来自令牌。** 页面与组件的 CSS 里不允许出现十六进制或 `rgba(...)`；
   需要新档位时，往 `tokens.css` 里加一个**有语义名字**的令牌，而不是就地写死。
   已有档位：`--signal-line / --link-line / --warn-line / --fault-line / --sky-line`（1px 状态描边）、
   `--link-text / --warn-text / --fault-text`（wash 底上的浅色文字）、
   `--surface-hair / --surface-hair-strong`（行级底色）、`--well`（下沉面）、
   `--scrim`（弹层压暗）、`--on-signal`（琥珀底上的深墨文字）、`--rule-hover / --scroll-thumb*`。
2. **字号只能来自 `--fs-*`。** 正文不小于 `--fs-sm`；`--fs-xs` 是 12.5px，
   设计检查器把 <12px 的正文判为 `tiny-text`。
3. **"自己有文字 + 有边框或底色"的元素，垂直内边距 ≥4.3px。**
   典型踩坑：按钮用 `height` + `padding: 0` 居中，肉眼没问题但被判 `cramped-padding`。
   正确写法是 `min-height` + 真实 padding（`base.css` 的 `.btn / .btn-sm / .btn-lg` 已改好）。
4. **长字符串必须能换行。** hash、ID、URL、配置片段不要 `truncate` 成省略号，
   用 `overflow-wrap: anywhere`；它们的价值就在于能被完整读出来/复制。
5. `tokens.css` 里的**兼容别名层**（约 190 个旧名）只是迁移期的过渡。
   改动到的文件应当顺手把旧名换成新名，别名层只保证没改到的地方不会解析成空值。

---

## 4. 验收方式：设计检查器，而不是"我觉得挺好看"

```powershell
$env:IMPECCABLE_BROWSER="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
& "$env:USERPROFILE\.impeccable\bin\0.1.5\impeccable.exe" detect --json http://127.0.0.1:8787/
```

它是**对渲染后的真实页面**判定（computed style + 几何），不是读源码，
所以改完必须先 `pnpm build:web`（产物进 `server/public/`，主控直接托管），再检测。

当前基线（**每条路由都必须是 0**）：

| 路由 | 说明 |
| --- | --- |
| `/` | 落地页 |
| `/login` | 登录 / 注册 |
| `/download` | 客户端下载 |
| `/console/dashboard`、`/console/nodes`、`/console/rooms`、`/console/users`、`/console/traffic`、`/console/relay`、`/console/audit`、`/console/settings` | 管理控制台（需登录态，检测时先把令牌写进 `localStorage['mclink.token']`） |

客户端是 Electron，够不着 URL 检测；它的等价手段是
`.cache/shoot-client2.mjs` / `.cache/verify-room-addr.mjs`：起真实 Electron、
连 CDP、断言元素几何与交互，并落一张截图。

---

## 5. 两条产品决定（别再改回去）

- **不做置顶迷你悬浮窗。** 曾经实现过（主进程 `mini:*` IPC + `MiniWindow.vue` + `?mini=1` 渲染），
  已按产品决定删除：多一个置顶窗口会挡游戏画面，而玩家的真实动作只是"把地址发给朋友"。
  现在 `RoomPage.vue` 把地址做成一块**铭牌**：整块可点即复制，旁边另有「复制地址」按钮，
  主进程不再有任何 `mini:*` 通道。
- **进房后直接落到房间页。** 玩家进房后的下一个动作一定是把地址发出去；
  停在主页还要先点一下「返回房间」才能看到地址，是白多一步（见 `App.vue` 的 `watch(hasRoom)`）。

---

## 6. 客户端特有的布局约束（520px 窄窗）

客户端是**窄窗单列**（默认 520×780，见 `client/electron/main.cjs`），不是宽屏仪表盘。
窄窗下踩过的两个坑，改布局时要留意：

1. **宽表格会被裁切。** 6 列的房间表在 520px 里放不下，右侧列直接看不见。
   做法：表格给一个最小宽度（`.table { min-width: 540px }`），装它的面板自己横向滚动
   （`.card:has(> .table) { overflow-x: auto }`）。
2. **宽度会沿 flex/grid 链一路上传。** 第一版用 `width: max-content` 让表格按内容铺开，
   结果表格的固有宽度把整页撑得比窗口还宽（整页横向滚动、右侧卡片与底部导航被切）。
   做法：所有中间容器的 `min-width` 归零，把"宽"限制在面板内部；横排一律允许换行。

另有一条与视觉无关但同样影响观感的约定：**底部导航 + 「按 ESC 返回上一页」**是客户端的
导航习惯（对齐 MCTier），返回**不会断开房间**——连接是常驻的，返回只是不看那个页面。

---

## 7. 复制这件事的坑（值得单独记一笔）

`navigator.clipboard.writeText` 要求**文档聚焦 + 用户激活**。实测在客户端的无边框窗口里，
只要窗口没拿到焦点（比如玩家刚在别处点过），它就会抛 `NotAllowedError`，界面上变成"复制失败"。
而"把地址发给朋友"是本产品最核心的动作，不能这样。

因此所有复制都走 `client/src/lib/clipboard.ts` 的 `copyText()`：
先试异步剪贴板，失败则退到 `document.execCommand('copy')` 的 textarea 方案（不需要焦点与权限）。
另外地址铭牌的 CSS 显式写了 `user-select: text` —— 按钮里的文字默认选不中，
一旦两条路都失败，玩家至少还能手动选中按 Ctrl+C。
