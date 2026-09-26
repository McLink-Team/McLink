# McLink for Android

「暖纸台」的 Android 端。**不是第二套前端** —— 页面、样式与令牌全部来自 `client/src`，
这里只提供三样东西：一个 WebView 外壳（Capacitor）、一层 `window.mclink` 适配、一份移动端布局。

```
android/
├── capacitor.config.ts          # 外壳配置（appId / appName / webDir）
├── vite.config.ts               # 构建 Android 端的渲染层（root=web/，产物进 dist/）
├── tsconfig.json                # 只检查 web/src（理由见文件内注释）
├── web/                         # 移动端专属代码 —— 全部加起来不到 1200 行
│   ├── index.html
│   └── src/
│       ├── install-bridge.ts    # 副作用模块：把 window.mclink 装上去（必须第一个 import）
│       ├── mobile-bridge.ts     # ★ 适配层：按 MclinkBridge 接口实现 Android 版
│       ├── mobile-shell.css     # ★ 移动端布局：底部导航 + 单列 + 安全区 + 触控尺寸
│       ├── mobile-keyboard.ts   # 软键盘适配（visualViewport → 收起底部导航）
│       ├── message-notify.ts    # 新消息提醒（⚠️ 应用被杀掉后收不到，见文件头）
│       ├── main.ts              # 入口：装桥 → 引样式 → 挂载
│       ├── MobileApp.vue        # ★ 移动端外壳（复用 client/src 的页面组件）
│       ├── MobileTabBar.vue     # ★ 底部导航（复用 client/src 的 RailIcon）
│       └── MobileSettingsPage.vue  # 精简设置页（桌面版大半是 Windows 专属）
├── scripts/
│   ├── bootstrap-android-sdk.ps1   # 装 Android SDK（本机没有时跑一次）
│   ├── build-apk.mjs               # 一键出 APK
│   ├── smoke-mobile.mjs            # 冒烟：无头浏览器渲染 + 布局 + 连主控（16 条断言）
│   ├── e2e-mobile.mjs              # 端到端：起本地主控，走真实 UI 跑完整条链（13 条断言）
│   ├── check-mobile-design.mjs     # 设计契约静态断言（13 条）
│   └── lib/browser.mjs             # 两个测试脚本共用的 CDP 客户端 + 静态服务
└── android/                     # Capacitor 生成的原生工程（**要入库**，它是外壳的源码）
```

## 快速开始

```powershell
# 0. 前置：JDK 17+（本机是 Oracle JDK 22）。只需要 java + javac 在 PATH 上。
java -version ; javac -version

# 1. 装 Android SDK（约 550MB，默认装到 F:\android-sdk，仓库外）
powershell -ExecutionPolicy Bypass -File android/scripts/bootstrap-android-sdk.ps1
#    换位置：... -SdkRoot D:\android-sdk
#    之后把 ANDROID_HOME 指过去也行；build-apk.mjs 会以此写 local.properties

# 2. 装依赖（在仓库根；android 是 pnpm workspace 成员）
pnpm install

# 3. 出 APK
node android/scripts/build-apk.mjs
#    → android/android/app/build/outputs/apk/debug/app-debug.apk
#    指定主控：$env:VITE_MCLINK_MASTER='https://cnnic.link'; node android/scripts/build-apk.mjs

# 4. 装到手机（先开 USB 调试）
F:\android-sdk\platform-tools\adb.exe install -r android\android\app\build\outputs\apk\debug\app-debug.apk
```

## 没有手机时怎么验证

三层，从便宜到贵：

```powershell
# 1. 设计契约（静态，1 秒）：无硬编码颜色 / 字号下限 / 底栏复用 RailIcon / 单列回落存在
pnpm --filter @mclink/android verify:design

# 2. 冒烟（约 20 秒）：把同一份产物放进无头 Edge，用 Pixel 7 视口跑一遍
pnpm --filter @mclink/android build:web
pnpm --filter @mclink/android verify:smoke
#    → android/.smoke/mobile-light-412x915.png / mobile-dark-412x915.png
#    断言 16 件：界面真渲染出来了（不是白屏）／布局真是移动端的（底栏贴下沿、横排、
#    铺满、内容区不重叠、没有桌面 .rail）／能连主控（含 CORS）

# 3. 端到端（约 1 分钟）：起本地主控，走真实 UI 把里程碑 1 那条链跑一遍
$env:MCLINK_DATA_DIR = "$env:TEMP\mclink-e2e-data"
$env:MCLINK_REQUIRE_EMAIL_VERIFICATION = "0"   # 本地没邮件服务，否则会卡在验证邮箱页
cd server ; node src/index.ts                  # 监听 8787，窗口别关
# 另开一个窗口：
pnpm --filter @mclink/android verify:e2e
#    → 登录 → 建房 → 拿到加入码与联机地址 → 看成员 → 看聊天 → 发消息，13 条断言
#    → android/.smoke/e2e-room-light.png
```

调试真机上的界面：debug 包开着 WebView 调试，`chrome://inspect` 可以直接连上去看 DOM 与控制台
（见 `capacitor.config.ts` 的 `webContentsDebuggingEnabled`）。

## 与桌面的差异

后端接口**完全复用**（`/api/v1/...`），主控零改动。差异只在"本机能力"这一层，
逐条对照表在 `web/src/mobile-bridge.ts` 的文件头注释里。要点：

| 能力 | 桌面 | Android 现状 |
| --- | --- | --- |
| 登录 / 房间 / 成员 / 聊天 | 可用 | **可用**（同一批 API 与页面，端到端验证过） |
| 新消息提醒（系统通知） | 桌面通知 | **可用，但只在应用进程存活期间** —— 见下 |
| EasyTier 虚拟网络内核 | 可用 | **未接入** —— 见 `docs/android-milestone2-easytier.md` |
| 节点延迟探测（tcping） | 真连 3 次 | 全部 `null`（界面显示「—」，不参与排序） |
| 提权 / 托盘 / 窗口按钮 | 可用 | 无对应物，移动端壳不渲染这些入口 |

### ⚠️ 提醒功能的一条硬限制

**没有接推送服务（FCM / 厂商推送），所以应用被系统杀掉之后收不到任何提醒。**

通知的产生链条是「主控 WS 推来消息 → WebView 里的 JS 收到 → 调 Android 通知 API」，
每一环都要求应用进程活着。应用被划掉、或被厂商省电策略杀掉之后 WebSocket 就断了，
也就没有任何东西能触发通知，直到用户重新打开应用。

我们**刻意没有**为此加常驻前台服务：那会换来一条用户去不掉的常驻通知和持续耗电，
而厂商省电策略照样可能杀掉它 —— 花了代价也买不到确定性。
（这条限制也写在 App 的「设置 → 提醒」里，用户看得到。）

## 两条踩过的坑（别再踩一遍）

1. **`.ps1` 必须带 UTF-8 BOM。** 本机是 Windows PowerShell 5.1，它读无 BOM 的 `.ps1` 时按
   系统 ANSI 码页（这里是 GBK）解码，中文注释会被解成乱码，然后以"语法错误"的形式炸在
   注释所在的下一行 —— 报错信息完全指不到真正的原因。
2. **Gradle 发行版走镜像。** 官方 `services.gradle.org` 会 307 跳到 GitHub Releases，
   而 GitHub Releases 在部分网络环境下不可达；wrapper 只会报 `timeout (10000ms)`，
   不提 GitHub。`android/gradle/wrapper/gradle-wrapper.properties` 里已换成腾讯云镜像
   （并注明怎么换回去）。
