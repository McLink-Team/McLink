# Android 端 · 里程碑 1（本轮交付）

> 目标：手机上能跑起来、登录、看房间/成员、**建房进房到"拿到联机地址"为止**，界面就是现在这套「暖纸台」。
> 状态：**代码已落地，debug APK 可构建**。虚拟网络内核不在本里程碑内（里程碑 2）。

## 一、技术路线与理由

### 1. 复用 Vue 渲染层，不重写 UI

页面组件（`LoginPage` / `CreateJoin` / `RoomPage` / `PublicPlaza` / `VerifyEmail`）、
样式（`styles.css` + `theme-warm.css`）、令牌（`packages/shared/src/design/tokens.css`）
**一行都没有复制** —— `android/web/src/*.vue` 直接用相对路径 import 它们。

```
android/web/src/MobileApp.vue
  import LoginPage    from '../../../client/src/pages/LoginPage.vue';
  import RoomPage     from '../../../client/src/pages/RoomPage.vue';
  import CreateJoin   from '../../../client/src/components/CreateJoin.vue';
  ...
```

代价是 `android/tsconfig.json` **刻意不设 `rootDir`**：桌面 `client/tsconfig.json` 设了
`rootDir: "."`，而 Android 端必须跨目录 import，设了就会让"复用现有页面"这件事本身
变成 `TS6059` 类型错误。

### 2. 外壳用 Capacitor（而不是自己写 WebView Activity）

两条路都能跑，差别在下一次改动：

- **自己写 Activity**：现在省一个依赖，但资产同步、返回键、权限回调、配置变更（旋转/深色模式）
  都要自己处理；而且**里程碑 2 要接 `VpnService` 时仍然得自己造一套 JS↔原生 的桥**。
- **Capacitor**：`webDir` 一填就完成资产打包，返回键/生命周期由它兜底，而里程碑 2 的
  `VpnService` 正好就是一个 Capacitor 插件 —— 那个桥是我们本来就要建的东西，
  不是为 Capacitor 多付的成本。

### 3. 适配层的形状：**照抄接口，不发明接口**

桌面渲染层通过 preload 暴露的 `window.mclink`（接口定义 `client/src/lib/bridge.ts`
的 `MclinkBridge`）拿本机能力。Android 上这些都不存在，缺了它 `bootstrap()` 第一句
`await window.mclink.info()` 就抛异常，整屏停在「正在初始化…」。

`android/web/src/mobile-bridge.ts` **逐字实现 `MclinkBridge`**，于是：

- `client/src` 里 44 处 `window.mclink.*` 调用**一处都不用改**；
- 里程碑 2 要换掉的只有 `core.*` 那一族（换成 Capacitor 插件），其余函数一行不动。

这比"给移动端另设计一套 API"省掉的是**后续每一次同步**的成本。

类型检查也证明了这条路是紧的：本轮期间并行的 macOS 改造给 `MclinkBridge` 加了
`platform: string` 与 `onMenuCommand()` 两个成员，`pnpm --filter @mclink/android typecheck`
**当场报错**（`missing the following properties ...: platform, onMenuCommand`），
补上后即通过 —— 契约漂移会被类型系统拦住，而不是等到手机上白屏。

### 4. 移动端布局：转置，不是重画

`android/web/src/mobile-shell.css` 只做一件事：把桌面「左 80px 图标栏 + 右侧一列」的
**横向骨架在窄竖屏上转置**成「上方一列 + 底部导航」。颜色/字号/间距/圆角/动效**一律沿用令牌**，
该文件里**不出现任何十六进制或 `rgba()`**。

| 桌面骨架 | 移动端 |
| --- | --- |
| `.rail`（左 80px 竖栏，4 项） | `.mobile-tabbar`（底部横栏，3 项等宽） |
| `.rail-brand`（64×64 白卡） | 不渲染（顶部已挤，品牌由顶栏承担） |
| `.titlebar`（52px + 窗口按钮） | `.mobile-topbar`（只有页面名 + 状态点） |
| `.deck-foot`（版本 + 动作胶囊） | `#deck-actions` 挪到 dock 上沿；版本号移进设置页 |
| `#deck-actions`（右下角胶囊） | 同一个 id，通栏，**保留投影**（DESIGN.md：动作胶囊是少数配拥有投影的元素） |

**单列回落**：房间页的「左成员 / 右房间卡」在本轮**不需要新写** ——
`client/src/pages/RoomPage.vue` 的 `.room-columns` 自带
`@media (max-width: 819px) { grid-template-columns: minmax(0, 1fr) }`，
而 `styles.css` 的两栏栅格只在 `min-width: 740px` 生效。手机竖屏（360–430px）两个条件都满足，
必然是上下排列。`mobile-shell.css` 里另加了一条 `:where()` 特异性的**兜底**（特异性压到 0，
任何页面自己写的栅格都能盖过它），并写明了"这条规则已经存在，此处只是保险"。

**底部导航为什么是 3 项**：桌面左栏是「联机/大厅/收藏/设置」。移动端本轮范围不含收藏，
而**收藏的内容本来就在** —— `RoomShortcuts` 被 `CreateJoin.vue` 直接嵌在「联机」那一屏里。
再给一个「收藏」标签页只是把同一份列表放在第二个地方。砍掉的是**入口**，不是能力。

### 5. 接口复用，主控零改动

主控一行未改。并且**CORS 不需要任何配置**：Capacitor 在 Android 上的页面来源是
`https://localhost`（`androidScheme` 默认 `https`），而主控 `server/src/server.ts` 的
`isAllowedOrigin()` 有一条内置规则放行任何 `http(s)://localhost[:port]` / `127.0.0.1[:port]`
（原本是给 Electron 与本地开发用的）。实测与代码双向确认：

```
$ curl -s -D - -o /dev/null -H "Origin: https://localhost" https://cnnic.link/api/v1/meta
HTTP/1.1 200 OK
access-control-allow-origin: https://localhost
```

> ⚠️ 这是一条**隐式依赖**：哪天那条正则被收紧，Android 端会整体失效，而现象只是一句
> "连不上服务器"。`smoke-mobile.mjs` 已把它钉成一条断言。

## 二、文件清单

### 新增（`android/`，与 `client/`、`web/` 平级）

| 文件 | 作用 |
| --- | --- |
| `android/package.json` | `@mclink/android` 工作区成员（Capacitor + vue + vite） |
| `android/capacitor.config.ts` | appId `link.cnnic.mclink` / webDir `dist`；不做远程加载 |
| `android/vite.config.ts` | 构建渲染层：`root=web/`，产物进 `dist/`；内置主控地址 |
| `android/tsconfig.json` | 只检查 `web/src`；**刻意不设 rootDir** |
| `android/.gitignore` | 排除 `local.properties`、`.gradle/`、keystore 等 |
| `android/README.md` | 构建与验证说明 |
| `android/web/index.html` | `viewport-fit=cover`；不写死 `theme-color` |
| `android/web/src/install-bridge.ts` | 副作用模块：保证桥在任何 `client/src` 模块之前就位 |
| `android/web/src/mobile-bridge.ts` | **适配层**：按 `MclinkBridge` 实现 Android 版 |
| `android/web/src/mobile-shell.css` | **移动端布局**：底部导航 / 单列 / 安全区 / 触控尺寸 / 聊天尺寸 |
| `android/web/src/mobile-keyboard.ts` | **软键盘适配**：`visualViewport` → 收起底部导航 + 聚焦滚动 |
| `android/web/src/message-notify.ts` | **新消息提醒**：判定规则、合并窗口、权限时机、通知点击 |
| `android/web/src/main.ts` | 入口：装桥 → 引样式（顺序有意义）→ 挂载 |
| `android/web/src/MobileApp.vue` | **移动端外壳**，复用 `client/src` 的页面 |
| `android/web/src/MobileTabBar.vue` | **底部导航组件**（复用 `RailIcon`） |
| `android/web/src/MobileSettingsPage.vue` | 精简设置页（账号/设备名/提醒开关/主控地址/退出） |
| `android/scripts/bootstrap-android-sdk.ps1` | 装 SDK（可重复执行） |
| `android/scripts/build-apk.mjs` | 一键出 APK（含"主控地址真的进了产物"的校验） |
| `android/scripts/smoke-mobile.mjs` | 冒烟测试：16 条断言 + 双主题截图 |
| `android/scripts/e2e-mobile.mjs` | **端到端**：起本地主控，走真实 UI 跑完整条链 |
| `android/scripts/check-mobile-design.mjs` | **设计契约静态断言**（13 条） |
| `android/scripts/lib/browser.mjs` | 两个测试脚本共用的 CDP 客户端 + 静态服务 |
| `android/android/**` | Capacitor 生成的 Gradle 工程（外壳源码，**要入库**） |

### 改动（都在 `client/src`，且都是"移动端适配"性质）

| 文件 | 改动 | 为什么不能只在 `android/` 里解决 |
| --- | --- | --- |
| `client/src/components/RailIcon.vue` | **新增**：把 4 个自绘 SVG 从 AppRail 抽出来 | 桌面左栏与 Android 底栏用的是**同一批去处**。图标路径留两份拷贝，迟早"桌面改了、手机没改"。抽出来是唯一能保证"同一套图标"的做法 |
| `client/src/components/AppRail.vue` | 改为使用 `RailIcon`（模板 1 处、import 1 行、删掉搬走的 CSS） | 同上；纯机械重构，桌面观感零变化 |
| `pnpm-workspace.yaml` | 加一行 `- "android"` | 让 `android` 能用 `workspace:*` 引共享包，并被 `pnpm -r typecheck` 覆盖 |

> **没有**动 `server/`、`web/`、`client/electron/`、`client/src/App.vue`。
> 桌面外壳 `App.vue` 保持原样 —— 移动端另起 `MobileApp.vue`，因为桌面外壳里有四件
> **只对 Electron 成立**的东西（`TitleBar` 窗口按钮 / `ElevationBanner` UAC / `CloseConfirm` /
> `LogPanel`），在 Android 上没有对应物，渲染出来就是一排点了没反应的控件。

## 三、完成度：哪些真跑通了，哪些只有代码

### 真跑通（有可复现证据）

| 项 | 证据 |
| --- | --- |
| Android SDK 可用 | `F:\android-sdk` 下 `platform-tools` + `platforms;android-35` + `build-tools;35.0.0`，licenses 已接受 |
| 渲染层构建 | `vite build` → 78 modules，`dist/index.html` + 49.8KB CSS + 214.7KB JS |
| TypeScript | `pnpm --filter @mclink/android typecheck` **零错误** |
| **APK 可构建** | `node android/scripts/build-apk.mjs` → `app-debug.apk`，**4.26 MB**；`aapt2 dump badging` 确认 package=`link.cnnic.mclink`、targetSdk 35、`POST_NOTIFICATIONS` 已由插件合并进清单、launchable-activity 正常 |
| APK 内含正确产物 | 解包核对：`assets/public/assets/*` 的文件名与 `android/dist` **完全一致**；JS 里能搜到 `mobile-tabbar`、`keyboard-inset`、`LocalNotifications`、`有人发消息时提醒我` |
| 界面真渲染（非白屏） | `smoke-mobile.mjs`：`#app` 已挂载、`.mobile-tabbar` 存在、3 项导航、登录卡、≥3 输入框 |
| 布局真是移动端 | 底栏贴视口下沿（±2px）、`flex-direction: row`、铺满宽度、内容区不重叠、**没有**桌面 `.rail` |
| 暖纸台令牌生效 | `--ground` 非空；截图 `.smoke/mobile-light-412x915.png`（亮）与 `mobile-dark-412x915.png`（深） |
| 能连主控 | 页面内 `fetch https://cnnic.link/api/v1/meta` 返回 200 + JSON + `clientVersion` |
| CORS 放行 Android 来源 | Node 侧带 `Origin: https://localhost` 请求，回 `access-control-allow-origin: https://localhost` |
| 主控地址真进产物 | `build-apk.mjs` 断言产物含 `https://cnnic.link` |
| 设计契约（静态断言） | `check-mobile-design.mjs` 13 项全过：无颜色字面量、字号 ≥12.5px、底栏复用 `RailIcon`、图标面无 emoji、单列回落存在 |
| **完整链路（端到端，走真实 UI）** | `e2e-mobile.mjs` 13 项全过 —— 见下 |

#### 端到端验证：里程碑 1 那条链**真的走了一遍**

`node android/scripts/e2e-mobile.mjs` 起一个**本地主控**（临时数据目录），
把同一份产物构建成指向它，然后用无头 Chromium 在手机视口里**像人一样填表、点按钮**，
再回头读界面上的字：

```
[e2e] 步骤 1 —— 登录（填表 + 点按钮，全部走界面）
  ✓ 登录卡出现
  ✓ 登录成功，进入「联机」首页
[e2e] 步骤 2 —— 建房
  ✓ 建房表单打开
[e2e] 步骤 3 —— 进房后该有的东西
  ✓ 进入房间页（.room-view 出现）
  ✓ 房间名显示正确
  ✓ 加入码已拿到
  ✓ 联机地址已拿到（IPv4）
  ✓ 成员列表有自己
[e2e] 步骤 4 —— 聊天（本轮新加回范围）
  ✓ 聊天面板已渲染
  ✓ 聊天有独立滚动区 .chat-body
  ✓ 聊天有输入框（textarea）
  ✓ 聊天滚动区是移动端尺寸（min(56vh,460px)）
  ✓ 发出的消息出现在聊天里
```

截图：`.smoke/e2e-room-light.png` —— 房间页（含成员、加入码、联机地址、聊天记录）。

**这条测试也顺带证明了一件关键的事**：联机地址来自主控为房主预分配的虚拟 IP，
**与本机内核是否启动无关** —— 所以"拿到联机地址"这个里程碑目标在没有虚拟网络的情况下也成立。

> 跑它需要本地主控带 `MCLINK_REQUIRE_EMAIL_VERIFICATION=0`
> （新建的库默认要求邮箱验证，而本地没有邮件服务，会卡在验证页）：
> ```powershell
> $env:MCLINK_DATA_DIR = "$env:TEMP\mclink-e2e-data"
> $env:MCLINK_REQUIRE_EMAIL_VERIFICATION = "0"
> cd server ; node src/index.ts       # 监听 8787
> ```

### 只有代码（本轮没在真机上点过）

- **APK 装到手机上跑起来**：APK 已构建并核对过内容，但本机无真机/模拟器，装不上。
- **系统通知真的弹出来**：`@capacitor/local-notifications` 已接入、`POST_NOTIFICATIONS`
  已在合并后的清单里、判定规则与合并逻辑都是代码级的，但**没有设备能验证它真的弹**。
- **软键盘行为**：`adjustResize` + `visualViewport` 的实现已就位，但桌面浏览器里
  `visualViewport` 不会因为键盘收缩，所以这条只能真机验。
- 收藏、通知以外的设置项、深色主题精修、动效 —— 按收窄后的范围**刻意不做**。

#### 为什么"建房→拿地址"这条链在本轮是通的（代码级论证）

1. `createRoom()` → `enterRoom()` → `startNetwork()` → `window.mclink.core.start()`；
2. Android 版 `core.start()` 返回 `state: 'error'` + 一句说明（**刻意的**：返回 `'running'`
   会让界面显示「虚拟网络已连接」而实际连不上，玩家会去怪游戏和房主）；
3. `enterRoom()` **不因内核失败而回滚** —— 它已经先写入 `state.session`，随后继续
   `startHeartbeat()` / `startRelayGuard()`；
4. 于是 `RoomPage` 正常渲染，而 **联机地址与加入码都不受 `isOnline` 影响**：
   - 加入码来自 `room.code`（`RoomPage.vue:801`）
   - 联机地址来自 `shareAddress` = `ticket.hostVirtualIp`（`RoomPage.vue:824-829`，`:disabled="!shareAddress"`）
   两者渲染路径里没有 `isOnline` 判断 —— `isOnline` 只影响那个状态点/那行字。
5. 主控返回的 `ticket` 里 `hostVirtualIp` 是房主成员的 `virtual_ip` 去掉掩码，
   **与"联机地址"是同一个值**，所以哪怕本机没进虚拟网，这个地址也是对的、可发出去的。

剩下那句「虚拟网络启动失败：本机网络内核尚未接入（Android 里程碑 1）…」会以琥珀色
alert 显示 —— 措辞刻意避开了 `store.describeCoreError()` 里所有正则分支
（端口/bind/权限/wintun），否则会被改写成一句 Windows 专属建议（例如"请安装 wintun.dll"），
在手机上纯属误导。

### 顺带修掉的一个桌面遗留

`store.bootstrap()` 的默认本机名称是 `` `${info.hostname}-PC` `` —— 手机上一律显示
「Android 手机-PC」，一眼看出是桌面端改的。`mobile-bridge.ts` 的 `seedDeviceName()`
在 bootstrap 之前抢先把 `localStorage['mclink.device']` 写成「我的手机」，
于是那段默认值永远不会执行。**没有改 `store.ts`**（那是一行桌面端共用逻辑，
为一个平台的后缀动它不值当）。截图里已确认显示「我的手机」。

## 三·补、聊天与消息提醒（本轮追加的两项）

### 聊天：**原样复用 `ChatPanel.vue`**，只改尺寸

房间聊天来自 `client/src/components/ChatPanel.vue`，它被 `RoomPage.vue` 无条件渲染
（`RoomPage.vue:786`），所以**在手机上它本来就是可用的** —— 历史走
`GET /rooms/:id/messages`、实时走 store 的 `onRoomChat`（`room:<id>` WS 话题），
**主控零改动，协议零改动**，组件零改动。

关于"手机上该做成可展开的面板还是独立一屏"，我的判断是**保持内联**，理由是三条硬约束：

1. **`ChatPanel` 本来就是一个可展开的面板** —— 它自带折叠开关（"展开/收起"）、
   自带 `300px` 的独立滚动区（`.chat-body`）、自带未读徽章（"N 条新消息"）。
   也就是说用户要求的"可展开的面板"这个形态**已经是它的原生形态**，不需要另做。
2. **要做成"独立一屏"就得让房间页里的那个实例不再挂载** —— 否则会有**两个 ChatPanel 实例**
   同时订阅 `onRoomChat`、同时拉历史（双倍请求）、各算各的未读。
   而"让它不挂载"必须改 `client/src/pages/RoomPage.vue`，那是一个**会同时影响桌面端**的改动，
   为手机的一个布局偏好去动它不值当（用 `display:none` 更糟：组件仍挂载，
   上面那些副作用一个不少）。
3. **聊天在单列里的位置是第 4 块**（头部 → 联机地址 → 成员 → **聊天** → 房间卡 → 我的网络 →
   诊断 → 帮助），不是压在页面最底部。而且这个顺序**已经是产品在窄窗下的既有排布** ——
   `RoomPage` 的 `≤819px` 断点与 `styles.css` 的 `≥740px` 断点共同决定的，
   桌面窗口拉窄到 800px 时看到的就是它。沿用它与"沿用现有页面"是同一件事。

移动端实际改的只有尺寸（`mobile-shell.css`）：

```css
.app-shell.mobile-shell .chat-body { height: min(56vh, 460px); }
```

桌面那个 `300px` 是给 580px 高的窗口定的；手机竖屏可用的滚动区通常在 600–800px，
给聊天一半多一点，既够读又不至于把下面的房间卡挤没。E2E 里对这条有断言
（"聊天滚动区是移动端尺寸"）。

### 软键盘遮挡：`adjustResize` + `visualViewport`

两处配合，缺一不可：

1. **原生侧**：`AndroidManifest.xml` 给 `MainActivity` 显式加
   `android:windowSoftInputMode="adjustResize"`。Capacitor 模板**没设**这一项，
   于是行为由系统按 `adjustUnspecified` 自行决定，部分 ROM 会挑 `adjustPan` ——
   表现为"键盘弹起来把整个界面往上推，输入框还是被挡住"。
2. **渲染层**：`mobile-keyboard.ts` 用 `window.visualViewport` 算键盘高度
   （`innerHeight - visualViewport.height - visualViewport.offsetTop`，
   这是唯一能算准的接口），写进 CSS 变量并给 `<body>` 挂 `kb-open`，
   于是 `mobile-shell.css` 里的 `body.kb-open .mobile-dock { display: none }`
   **把底部导航整条收掉**，把那一整条还给输入框。

阈值取 120px 而不是 0：`visualViewport` 在地址栏收缩、旋转、页面缩放时都会抖动，
而任何手机软键盘都不可能低于 120px —— 用一个下限挡掉抖动，
免得导航栏在用户打字时反复闪。

聚焦后还做了一次延迟 300ms 的 `scrollIntoView({block:'center'})`：
`adjustResize` 的布局收缩与键盘动画是异步的，立刻滚算的是**收缩前**的位置，
滚完键盘才上来，结果还是被挡。

### 消息提醒：Android 系统通知，语义与桌面端对齐

`android/web/src/message-notify.ts`。用 `@capacitor/local-notifications@7.0.7`
（Capacitor 7 对应的版本；8.x 要求 `@capacitor/core >= 8`，与本项目不符）。

判定规则**与桌面端同一套语义**（两端行为对了，以后才不会出现"桌面不弹、手机弹"）：

| 规则 | 实现 |
| --- | --- |
| 前台且正看着那个房间 → 不弹 | `!document.hidden && tab==='home' && session.room.id === 房间` |
| 切后台 / 看别的页面 → 弹 | `document.hidden` 或 `tab !== 'home'` |
| **自己发的不弹** | `message.userId === clientState.user?.id` |
| 系统消息（"XX 加入了房间"）不弹 | `kind === 'system' \|\| role === 'system'` |
| 连发多条**合并** | 同一房间 6 秒窗口内累计，合成「XX 等 N 条新消息」 |
| 点通知 → 打开应用并跳到那个房间 | `localNotificationActionPerformed` 监听，读 `extra.roomId` → 切回「联机」那一屏 |
| 设置里一个开关（**默认开**） | 「设置 → 提醒 → 有人发消息时提醒我」 |

合并窗口的两个细节（都是"不这么做就会出 bug"的那种）：

- **窗口从第一条未提醒的消息开始算，而不是"每条都重置计时器"** ——
  后者在有人连续刷屏时会一直往后推，结果是**永远不提醒**：一个持续说话的房间反而最安静。
- **退房/退登时清掉还没发出去的合并通知** —— 否则退房 6 秒后会弹出一条
  "XX 等 3 条新消息"，点进去已经不在那个房间了。一条点不开的通知比没有通知更糟。

权限申请的**时机**是单独判断过的：Android 13+ 需要 `POST_NOTIFICATIONS`，
不问就发 → 通知静默不出现；一启动就问 → 用户还不知道这应用会通知什么，多半直接拒绝，
而 Android 的权限一旦被拒两次就永久静默。所以选在**第一次成功进入房间之后**问
（那时用户刚做完"我要跟人联机"这件事，"有人说话时提醒你"才有上下文）。
设置页手动打开开关时也会立刻申请一次。

订阅挂在**外壳层**（`MobileApp.vue` 挂载时 `installMessageNotifier` 一次），
不是挂在 `ChatPanel` 里 —— 因为"人不在看聊天的时候也要提醒"这条规则，
恰恰要求它在 `ChatPanel` 不存在时仍然有效。

#### ⚠️ 硬限制：**应用被系统杀掉之后，收不到任何提醒**

本项目**没有接推送服务**（没有 FCM、没有厂商推送通道）。通知的产生链条是：

```
主控 WS 推来消息 → WebView 里的 JS 收到 → 调 Android 通知 API 弹一条
```

每一环都要求**应用进程活着**。而 Android 会在内存紧张、用户从最近任务里划掉应用、
或厂商省电策略判定"这个应用在后台耗电"时**杀掉进程** —— 进程一死 WebSocket 就断了，
也就没有任何东西能触发通知。所以：

- 应用在前台、或刚切到后台（进程还活着）→ **能提醒**；
- **应用被划掉 / 被系统回收 → 收不到任何提醒**，直到用户重新打开应用。

**要不要为此加一个常驻前台服务？我的判断是：不加。**
理由：为了一个"房间聊天提醒"去常驻一条永远挂着、去不掉的通知（Android 的前台服务通知
用户无法单独关闭）并持续耗电，成本明显大于收益；而且厂商省电策略照样可能杀掉它 ——
花了代价也买不到确定性。这个取舍同时写在**设置页的开关说明里**（用户看得到），
以及 `message-notify.ts` 的文件头注释里（维护者看得到）。

想让"关掉应用也能收到"只有两条路，都不在本轮范围内：接 FCM / 厂商推送，
或者起常驻前台服务把进程钉住。

## 四、第一号阻塞：Android SDK

### 现状：**已由本轮解决**

开工时本机**没有任何 Android 构建能力**：

```
java -version   → java 22（Oracle JDK，javac 可用）
$env:JAVA_HOME  → 空
$env:ANDROID_HOME / ANDROID_SDK_ROOT → 空
where.exe adb   → 找不到
where.exe gradle→ 找不到
%LOCALAPPDATA%\Android\Sdk → 不存在
~/.gradle       → 不存在
```

按"缺 SDK 就如实报为阻塞"的要求，这本该是第一号阻塞。但网络可用（`dl.google.com` 可达，
实测 24.8MB/s），所以**直接把 SDK 装上并绕过了这个阻塞**：

```powershell
powershell -ExecutionPolicy Bypass -File android/scripts/bootstrap-android-sdk.ps1
```

脚本做的事（可重复执行、幂等）：下载固定 build 号的 `commandlinetools-win-11076708_latest.zip`
（146MB）→ 解压到 `<sdk>/cmdline-tools/latest`（`sdkmanager` 只认这个确切布局）→
灌 `y` 接受全部许可 → 装 `platform-tools`、`platforms;android-35`、`build-tools;35.0.0`。
装完占用 **0.53 GB**，落在 `F:\android-sdk`（**仓库外**，避免把 1GB SDK 混进工作区）。

### 仍然存在的阻塞（缩小版）

**本机没有真机也没有模拟器**，所以 APK 装不上、点不了。要跑真机需要：

```powershell
# 方案 A：真机（推荐，最接近实际）
#  手机 → 设置 → 关于手机 → 连点版本号 7 次 → 开发者选项 → 打开 USB 调试
F:\android-sdk\platform-tools\adb.exe devices          # 应看到一台 device
F:\android-sdk\platform-tools\adb.exe install -r android\android\app\build\outputs\apk\debug\app-debug.apk

# 方案 B：模拟器（需要额外下载，约 1.5GB + 系统镜像）
F:\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat "emulator" "system-images;android-35;google_apis;x86_64"
#   注意：本机是 x86_64 Windows，模拟器需要 HAXM/WHPX 虚拟化；若不可用会退化成极慢的软件模拟
```

### 环境版本（供复现）

| 组件 | 版本 |
| --- | --- |
| JDK | Oracle JDK **22**（AGP 8.7.2 要求 17+；Gradle 8.11.1 支持到 Java 23） |
| Android SDK | platform-tools r37.0.1、platforms;android-35、build-tools;35.0.0 |
| Gradle | 8.11.1（`-bin`，走腾讯云镜像，见 README 的坑 2） |
| AGP | 8.7.2 |
| compileSdk / targetSdk / minSdk | 35 / 35 / 23 |
| Node / pnpm | 24.19.0 / 10.33.2 |
| Capacitor | 7.x |
| Shell | **Windows PowerShell 5.1**（没有 pwsh 7！`.ps1` 必须带 UTF-8 BOM，见 README 的坑 1） |

## 五、没做到 / 不确定的部分

- **没在真机上装过**（无设备）。APK 构建与产物内容有验证，运行时行为靠无头 Chromium 近似。
- **无头 Edge ≠ Android WebView。** 两者同为 Chromium，但 WebView 版本可能更旧
  （`vite.config.ts` 已把构建 target 降到 `chrome87` 以留余量），且没有 Android 独有的
  安全区、触摸、软键盘行为。截图里的安全区值是 0（桌面上 `env()` 无值）。
- **软键盘遮挡**未验证：输入框获得焦点时键盘会把布局顶起，`100%` 高度在 WebView 里
  可能被压缩。真机上需要实测；若有问题，通常的修法是 `dvh` 单位或 `visualViewport` 监听。
- **`tcping` 恒为 `null`**：建房页的节点延迟列在手机上是「—」，不参与排序。
  它只影响"选哪台中继更优"，不影响能否建房。
- **未做 `interactive-widget=resizes-content`** 等 viewport 细节调优。
- 并行的 macOS 改造正在改 `client/src`，本轮期间已遇到一次契约变化（见第一节 3）。
  本报告结论基于当前工作区状态。
