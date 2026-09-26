# Android 里程碑 2：把 EasyTier 落到手机上

> 状态：**只写方案，未动手**（本轮范围是里程碑 1 + 聊天 + 消息提醒）。
> 本文件的目标是：**照着做就能做完**，不留需要重新调研的坑。
>
> 结论先行：**里程碑 2 在本机做不完**，缺的不是 Android SDK（本轮已装好），而是
> **Rust 工具链 + Android NDK**，而且官方 JNI 的构建路径要求 Linux/macOS。
> 补齐步骤见 §3。

---

## 1. FCL 方案研究结论

研究对象：`https://github.com/FCL-Team/FoldCraftLauncher`（Fold Craft Launcher，
Android 上的 Minecraft Java 版启动器，4.8k stars）。它确实已经在 Android 上跑通了"联机"。

> **⚠️ 本节经过一次更正，请以更正后的为准。**
> 初版结论写的是"FCL 的联机内核不是 EasyTier"。**这是错的。**
> 更深一层的取证（全库解包 grep + `.so` 二进制字符串取证 + 上游 `burningtnt/Terracotta` 源码）
> 证明：**Terracotta 是 EasyTier 的封装层，用的就是 EasyTier —— 只不过是一个 fork，
> 而且是以 Rust 库的形式静态链接进 `libterracotta.so`。**
> 也就是说 FCL 恰恰走通了"EasyTier 在 Android 上落地"这件事，参考价值比初版判断的**更大**。

### 1.1 一句话结论

**FCL 的联机 = EasyTier（fork 自 `v2.5.0-terracotta.2`）经 Rust 封装成 Terracotta，
在 Android 上通过 JNI 把 EasyTier 静态链接进单个 `libterracotta.so`、在进程内运行 ——
完全不 fork 任何可执行文件。** TUN 由 Java 侧 `VpnService` 建立，native 通过回调拿到 tun fd
塞进 EasyTier。桌面端才走「解包 `easytier-core` 可执行文件 + 子进程」那条完全不同的路。

### 1.2 内核：EasyTier（fork）+ Terracotta 封装

| 证据 | 内容 |
| --- | --- |
| FCL `README.md:79-80` | `[EasyTier]…：局域网联机组网底层` / `[Terracotta]…：基于 EasyTier 的联机方案（Terracotta 模块 JNI 封装）` |
| `Terracotta/Cargo.toml:7-8` | `[package.metadata.easytier]` → `version = "v2.5.0-terracotta.2"` |
| `Terracotta/Cargo.toml:51-58` | `[target.'cfg(target_os = "android")'.dependencies]` `easytier = { git = "https://github.com/burningtnt/EasyTier.git", branch = "main" }` + `jni = "0.21.1"` |
| **二进制实证** | `libterracotta.so` 内含 `/home/runner/.cargo/git/checkouts/easytier-565a25d433b5b5c0/.../easytier/src/{launcher.rs,instance/virtual_nic.rs,connector/udp_hole_punch/*,peers/encrypt/ring_aes_gcm.rs,gateway/tokio_smoltcp/*}` —— EasyTier 源码确实被编进了这个 `.so` |

**注意：是 fork，不是上游主线**（`burningtnt/EasyTier`，branch `main`）。

### 1.3 原生落地方式 —— JNI `.so`，**不是** assets 可执行文件

| 证据 | 内容 |
| --- | --- |
| `Terracotta/build.gradle.kts`（全文 34 行） | 纯 `com.android.library`；**没有** `externalNativeBuild`、**没有** CMake、**没有** `ndkVersion` —— 也就是说**这个 `.so` 不在 FCL 仓库里构建** |
| 4 个 ABI 的预编译二进制直接入库 | `Terracotta/src/main/jniLibs/{arm64-v8a,armeabi-v7a,x86,x86_64}/libterracotta.so`，7,781,192 / 5,556,284 / 9,068,520 / 9,061,792 字节；`.gitattributes` 无 LFS filter |
| 全树穷举 | `FCL/src/main/assets/` 下只有 JRE/JNA/LWJGL/游戏 jar，**没有任何 easytier / et-core / tun2socks / wireguard 可执行文件** |
| `FCL/src/main/jni/CMakeLists.txt` | FCL 自己的 NDK 构建（`ndkVersion = "27.0.12077973"`）是给 Minecraft JVM 用的（`pojavexec`/`bytehook`/`jsound`/`flite`/`androidnsbypass`），**与 EasyTier 无关** —— 别被"FCL 有 CMake"误导 |
| terracotta 包全量 grep | `FCL/src/main/java/com/tungsten/fcl/terracotta/**` 内**零处** `ProcessBuilder` / `Runtime.getRuntime()` |

**JNI 具体形态**（Rust FFI + 标准 JNI，不是 JNA、不是裸 C ABI）：

- `System.loadLibrary("terracotta")` + 先设 system property `net.burningtnt.terracotta.native_location`
- `.so` 里有 `JNI_OnLoad` / `RegisterNatives`，动态注册表（从二进制直接抽出）：
  `start0(Ljava/lang/String;I)I`、`getState0()Ljava/lang/String;`、`setScanning0(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V`、
  `setGuesting0(...)Z`、`verifyRoomCode0(Ljava/lang/String;)I`、`onVpnServiceStateChanged(BBBBSLjava/lang/String;)I` …
- 因为是 `JNI_OnLoad` + 动态注册，**Java 类可以换包名**（上游 Javadoc 原话：
  "Unlike normal JNI bindings, relocating this class to another package is supported."）
- 上游构建方式（`.github/workflows/build.yaml`）：`cargo +nightly ndk build --release --lib --target {aarch64-linux-android|…}`，
  NDK **26.0.10792818**，`-Zbuild-std=core,std,alloc,…`
- **Android 特意用 `panic=unwind`**（桌面是 `panic=abort`），好让 Rust panic 冒泡成 Java `RuntimeException`
  （对应 `GUEST_ET_CRASH` / `HOST_ET_CRASH` 两个异常态）。这是个很细但很关键的取舍。

**Android 与桌面的分叉点**（上游 `src/easytier/mod.rs:10-22`）：

```rust
cfg_if! {
    if #[cfg(not(target_os = "android"))] { mod executable_impl; use executable_impl as inner; }
    else                                  { mod linkage_impl;    use linkage_impl    as inner; }
}
```

- **Android → `linkage_impl.rs`**：`easytier::launcher::NetworkInstance` 在**同进程内**起实例。
- **桌面 → `executable_impl.rs`**：`include_bytes!(env!("TERRACOTTA_ET_ARCHIVE"))` 把 EasyTier 发行包 7z
  **编进二进制**，运行时 `sevenz_rust2::decompress` 解出来、`chmod +x`、再 `Command` 拉起。
  这才是"可执行文件"那条路，且**只用于桌面，也不放 `assets/`**。

**配置传递（Android）：TOML 只在 Rust 内存里生成，不落盘** ——
逐字段拼 `toml::Table` → `TomlConfigLoader::new_from_str` →
`NetworkInstance::new(config, ConfigFileControl::STATIC_CONFIG)` → `instance.start()`，
自己建一个 `tokio` 多线程 runtime。FCL 的 Java 层全量 grep 确认**没有任何配置文件读写**。

### 1.4 VpnService 用法

| 证据 | 内容 |
| --- | --- |
| `TerracottaVPNService.java:24` | `public class TerracottaVPNService extends VpnService`，类上有 `@SuppressLint("VpnServicePolicy")` |
| FCL 主清单 | `<service android:permission="android.permission.BIND_VPN_SERVICE" android:foregroundServiceType="connectedDevice\|dataSync">` + `<action android:name="android.net.VpnService"/>` |
| `Terracotta.java:196-213` | `VpnService.prepare(context)` 非 null → `startActivityForResult`；`RESULT_OK` → `startForegroundService(ACTION_START)`；**用户拒绝 → `getPendingVpnServiceRequest().reject()`** + Toast「请先授予应用 VPN 权限」 |
| `TerracottaVPNService.java:105-113` | `Builder().setSession("Terracotta Connection")` → `addDisallowedApplication(getPackageName())` → **把整个 Builder 交给 native**：`request.startVpnService(vpnBuilder)` |
| `TerracottaAndroidAPI.java:401-415` | native 决定的参数由 Java 落地：`addAddress(...)` / `addDnsServer("223.5.5.5")` / `addDnsServer("114.114.114.114")` / 对 native 给的 cidr 列表 `addRoute(...)` → `builder.establish()` → fd 回传 native |

**反向控制流（关键设计）**：native 每 100ms 轮询 EasyTier 的 `show_node_info` / `list_route`，
地址或 `proxy_cidrs` 变化时回调 Java（`on_vpnservice_change` → `onVpnServiceStateChanged`），
**Java 侧同步循环等 30s**：

```java
if (System.currentTimeMillis() - timestamp >= 30000) {
    Log.wtf("TerracottaAndroidAPI", "VpnService Request hasn't been fulfilled in 30s.");
    throw new IllegalStateException();
}
```

> **⚠️ 这条 30 秒约束必须照抄它的语义**：`startVpnService` 或 `reject` 必须在 30s 内被调用，
> 否则 Terracotta 卡死、EasyTier 无法提交新请求。我们自己写 binding 时，
> 要在"等用户点 VPN 授权对话框"这条路径上把超时考虑清楚 —— 用户盯着对话框发呆 30 秒是很正常的。

**`setMtu`：全库穷举确认 FCL / Terracotta 从不调用**，用 VpnService 的默认 MTU。
（初版文档猜"可能要把 MTU 调到 1280–1400"，那是没有依据的推测，撤回。）

**自己排除自己**：`addDisallowedApplication(getPackageName())` —— 自己的流量不走 VPN。

### 1.5 前台服务与权限

清单（FCL 主清单 + `Terracotta/src/main/AndroidManifest.xml`）：

```
INTERNET · ACCESS_NETWORK_STATE · ACCESS_WIFI_STATE · WAKE_LOCK
FOREGROUND_SERVICE · FOREGROUND_SERVICE_DATA_SYNC · FOREGROUND_SERVICE_CONNECTED_DEVICE
POST_NOTIFICATIONS · CHANGE_NETWORK_STATE · CHANGE_WIFI_STATE · CHANGE_WIFI_MULTICAST_STATE
REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
```

- 前台服务：`startForeground(VPN_NOTIFICATION_ID, notification)`，`IMPORTANCE_LOW` 常驻通知
  （`setOngoing(true)` + `CATEGORY_SERVICE` + `setOnlyAlertOnce`），
  **带 `setDeleteIntent` 做"用户把通知划掉就重新贴回来"**（`ACTION_REPOST` + `EXTRA_FROM_DELETE`）。
- `POST_NOTIFICATIONS` 引导做得比较完整（`MainActivity.kt:981-1013`）：Android 13+ 先弹；
  若 `shouldShowRequestPermissionRationale` 为 false 就去开系统通知设置页，
  兜底再跳应用详情页。触发点两处：启动时一次性、打开联机开关时。
- **电池优化白名单：只声明、代码零引用。** 全库穷举，`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
  只出现在上游 Terracotta 的 Android demo 清单里，**没有任何** `isIgnoringBatteryOptimizations` /
  `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` / 白名单引导 UI。疑似 demo 遗留。
- **`KILL_BACKGROUND_PROCESSES` 完全没有声明。**
- **`WAKE_LOCK` 唯一用途是下载**（`"FCL:download"`）—— **联机链路没有 WakeLock**。

### 1.6 配置与凭据怎么下发：**FCL 没有自建联机服务端**

三层来源：

1. **公共节点列表（外部 HTTP，可变）**：`TerracottaNodeList.java` 里
   `NODE_LIST_URL = "https://terracotta.glavo.site/nodes"`，JSON `[{url, region}]`，
   按 `IS_CHINA_MAINLAND == "CN".equals(region)` 过滤；**拉失败就退化成空列表**，不阻断流程。
2. **内核内嵌兜底公共节点**（上游 `src/easytier/publics.rs`）：
   `tcp://public.easytier.top:11010`、`tcp://public2.easytier.cn:54321`、
   `https://etnode.zkitefly.eu.org/node1|node2` —— 也就是**依赖 EasyTier 的公共服务器**。
3. **凭据 = 邀请码本身，没有独立口令**：房主 `setScanning(null, player, nodeList)` →
   native 返回 `HostOK{room}`（形如 `U/1KB4-30GH-3U1K-9AVB`）；房客 `setGuesting(code, player, nodeList)`。
   邀请码有 3 种格式，客户端本地校验（`verifyRoomCode0`）。

**状态机是这个方案的核心接口形态**（值得借鉴）：native 维持**单一 JSON 状态 + 自增 `index`**，
Java 每 500µs 轮询一次、**只接受 `index` 更大的状态**：

```
waiting / host-scanning / host-starting / host-ok /
guest-connecting / guest-starting / guest-ok / exception
```

`guest-ok` 直接给出可复制的「备用联机地址」`url`。

**对我们的含义：** 我们比 FCL 简单得多 —— 主控已经生成好 `ticket.configToml`
（network name / secret / peers 都在里面），客户端拿到的就是一份可以直接喂给内核的 TOML。
`EasyTierJNI.parseConfig(toml)` + `runNetworkInstance(toml)` 正好吃这个格式，
**凭据下发这一环零改动**，也不需要公共节点列表。

### 1.7 它踩过的坑（这是本节最有价值的部分）

| 坑 | 证据 | 对我们的含义 |
| --- | --- | --- |
| **VPN 建起来的瞬间整机"断网"** | issue [#1429](https://github.com/FCL-Team/FoldCraftLauncher/issues/1429)（open）→ 转上游 [Terracotta#133](https://github.com/burningtnt/Terracotta/issues/133)。日志原文：`Requesting VpnService: ip=my_ip, cidrs: []` / `when i grant vpn permission and it turns on vpn, the network (wifi) becomes internetless (no internet). cidrs is empty.` | **最该记住的一条。** EasyTier 还没算出 `proxy_cidrs` 就把 VPN 建起来了 → `addRoute` 为空 → Android 按默认路由全量接管 → 整机看起来断网。**我们必须在拿到路由表之后才 `establish()`**，宁可晚几秒；若拿不到就 `reject()` 而不是空路由 establish |
| 状态机被锁 18.5 秒 | 同一日志：`AppState has been locked for 18522ms, at src/controller/api.rs:87:17` | 状态机要有超时与恢复，不能"等一个永远不来的回调" |
| **VPN 互相抢占** | `onRevoke()` 注释 `preempted by another VPN or revoked by user; tearing down.`；issue [#1217](https://github.com/FCL-Team/FoldCraftLauncher/issues/1217)「开别的 VPN 导致 FCL 掉线」 | Android 同一时刻只允许一个 VPN；`onRevoke()` 必须实现并回到"未联机"状态 |
| 常驻通知被用户划掉 | `ACTION_REPOST` + `EXTRA_FROM_DELETE` | 部分 ROM 上这会连带影响服务存活；要能重新贴回 |
| 房主按钮永久卡死 | issue [#1800](https://github.com/FCL-Team/FoldCraftLauncher/issues/1800)：按钮被 `setEnabled(false)` 关掉，只有回到 `waiting` 才恢复 | 状态机没回到初始态就会留下一个永远点不动的按钮 |
| 拉节点列表阻塞 UI | `CHANGELOG.md:259`「修复联机对话框节点列表阻塞点击响应（改独立线程获取）」 | 网络请求不要在共享线程池/UI 线程上做 |
| 依赖版本必须钉死 | `Cargo.toml:54` 注释 `# These libraries are the necessities to interact with EasyTier. DO NOT upgrade their version.`（`uuid`/`toml`/`tokio`/`cidr`） | EasyTier 的内部类型直接暴露给封装层 → 这是"必须 fork 而不是依赖上游 release"的直接原因 |
| **厂商省电/后台杀：FCL 基本没做适配** | 无 `KILL_BACKGROUND_PROCESSES`、无电池白名单引导、联机无 WakeLock；仅有的厂商相关原生代码（EMUI linker 挂死规避、MIUI `--X` 映射变通）都在 **JVM 加载**线上，与联机无关 | 它没有可抄的经验，我们得自己面对（见 §4.2）。**"用户实际是否遇到联机被后台杀"未验证** |
| 联机与游戏 Activity 同生共死 | `JVMActivity.onDestroy() { Terracotta.setWaiting(this, true); }` | 这是它的产品取舍（游戏关了房间就关）。我们的模型不同：房间是主控上的实体，不该跟 UI 生命周期绑定 |

### 1.8 许可证 —— 这条直接决定我们能不能用它的东西

| 组件 | License | 证据 |
| --- | --- | --- |
| **FCL 本体** | **GPL-3.0** | 仓库根 `LICENSE` 首行 `GNU GENERAL PUBLIC LICENSE Version 3`；GitHub API `license.spdx_id = GPL-3.0`。它是 **HMCL 的 fork**（源文件头带 `Copyright (C) 2025 huangyuhui`） |
| **Terracotta**（`net.burningtnt.terracotta` 的来源） | **AGPL-3.0** | 上游 `burningtnt/Terracotta` 的 `LICENSE` 首行 `GNU AFFERO GENERAL PUBLIC LICENSE Version 3` |
| **EasyTier** | **LGPL-3.0** | 本地 `.cache/src/EasyTier-main/LICENSE` 首行 `GNU LESSER GENERAL PUBLIC LICENSE Version 3` |

**Terracotta 的 README 里有一条 AGPL 例外条款**，原文大意：

> 1. 您的程序**通过打包的方式包含本作品未经修改的二进制形式，而没有静态或动态地链接到本作品**；或
> 2. 您的程序通过本作品提供的进程间通信接口（如 HTTP API）与**未经修改**的本作品应用程序交互，
>    且在用户界面明显处标识了本作品的版权信息。

**但这条路对我们不成立**，原因有两条：

1. FCL 检入的 `TerracottaAndroidAPI.java` 是上游 `ffi/TerracottaAndroidAPI.java` 的**改写版**
   （SHA256 不同：FCL 版给 `setScanning0`/`setGuesting0` 加了第三参 `extraNodes`）——
   **不是"未经修改的二进制"**；而且 `.so` 里的 `RegisterNatives` 是 3 参数版，
   与上游 master 的 2 参数 Java 不一致，说明 FCL 用的是自己那一支的构建产物。
2. 从我们自己的 Kotlin/Java 代码 `System.loadLibrary("terracotta")` 并调用它，
   性质上就是**动态链接**，落不进例外第 1 条；第 2 条也不适用（不是走 HTTP IPC 的独立进程）。

**结论（工程判断，非法律意见）：**

- **不要复用 Terracotta 的 `.so` 或它的 JNI 封装** —— 一旦动态链接，AGPL-3.0 的传染性会被触发，
  我们要以 AGPL 开放 Android 客户端的完整对应源码，而且 AGPL §13 对"通过网络提供服务"还有额外要求。
  对一个"主控 + 客户端"的产品，这是实质性负担。
- **正确路线：用 EasyTier 官方的 `easytier-contrib/easytier-android-jni`（LGPL-3.0）。**
  LGPL 允许以动态库形式使用，只要不修改它、且用户能替换该库，**不要求我们的应用整体开源**。
  它已经有 `EasyTierJNI.kt` / `EasyTierManager.kt` / `EasyTierVpnService.t.kt` 和 `setTunFd` 的完整范式 ——
  见 §2。这条路比 Terracotta 干净得多。
- **EasyTier 是 LGPL-3.0**：动态链接不传染，但**若我们改了 EasyTier 源码就必须公开那部分改动**。
  （FCL 走的正是 fork，所以它必须开源它的 fork；我们不 fork 就没这个问题。）
- FCL 的 `TerracottaState.java` / `TerracottaNodeList.java` / `ProfileKind.java` 头部都带
  **HMCL 的 GPL-3.0 版权头** —— 同样"看一眼可以、抄就传染"。
- 综上：**本项目的原则（只借鉴方案与接口形态、一行源码都不抄）在这里不只是洁癖，而是有实际法律后果的纪律。**
  本文档里出现的任何 FCL 代码片段都是**摘录用于说明它怎么做的**，不是放进我们代码库的素材。

### 1.9 一个来自上游作者的旁证

上游 Terracotta 作者在 [burningtnt/Terracotta#88](https://github.com/burningtnt/Terracotta/issues/88) 里说：

> 「一方面没法接 ui，另一方面像 vpn service 这种东西没法通过 rust 实现。
> 最后是封装一些关键函数，比如运行 ET 实际，比如 setTunFd，这些函数都得在 java/kt 的 vpnservice 里调用。」

并且提到 EasyTier 官方新出的 Android JNI 封装"那玩意儿就和我做的差不多"。

**这条印证了我们 §2 的路线是对的**：Rust 侧只做内核 + 状态机，
`VpnService` 必须在 Java/Kotlin，tun fd 必须由 Java 交给 native。
FCL/Terracotta 与官方封装在形态上是同构的。


---

## 2. 我们该怎么做：EasyTier 官方 Android JNI

**好消息**：EasyTier 主仓库里**自带** Android JNI 工程，不需要我们从零写 FFI。
本地参考源码：`.cache/src/EasyTier-main/easytier-contrib/easytier-android-jni/`

**为什么用官方这份，而不是照 FCL 抄一套：**

| | FCL / Terracotta | EasyTier 官方 `easytier-android-jni` |
| --- | --- | --- |
| 架构形态 | Rust 内核（EasyTier fork）+ JNI，进程内 | **同构**（`jni` crate + `cdylib` + `setTunFd`） |
| 许可证 | Terracotta **AGPL-3.0**（例外条款不适用，会传染） | **LGPL-3.0**（动态链接不传染，不要求应用整体开源） |
| 与内核版本的关系 | 锁死在一个 fork（`burningtnt/EasyTier`），因为内部类型直接暴露 | 跟着主仓库走，我们自己不 fork |
| 我们要写的量 | 得自己写 binding + 状态机 | 上游已经给了 `EasyTierJNI.kt` / `EasyTierManager.kt` |

**结论：架构抄 FCL 的形态（它印证了这条路走得通），代码用 EasyTier 官方那份（许可证干净）。**

### 2.1 它提供什么

```
Cargo.toml / build.rs / build.sh          # Rust → .so 的构建
exports.map                                # JNI 导出表（控制符号可见性，减小体积）
src/lib.rs · network_api.rs · config_server_api.rs
src/json_rpc_api.rs · callback.rs · logger.rs · strings.rs · error.rs
kotlin/com/easytier/jni/EasyTierJNI.kt           ← Java/Kotlin 门面
kotlin/com/easytier/jni/EasyTierManager.kt       ← 实例管理
kotlin/com/easytier/jni/EasyTierVpnService.t.kt  ← **VpnService 模板**（注意 .t.kt 后缀，不参与编译）
example_config.toml
README.md
```

API（`README.md` 的表格）：

| 方法 | 作用 |
| --- | --- |
| `parseConfig(toml)` | 解析 TOML 配置，0=成功 |
| `runNetworkInstance(toml)` | **启动网络实例** |
| `setTunFd(instanceName, fd)` | **把 VpnService 的 TUN fd 交给内核** |
| `retainNetworkInstance(names)` / `retainSingleInstance(name)` | 保留实例（防止被 GC 式回收） |
| `collectNetworkInfosAsMap(maxLength)` | 取网络信息 |
| `stopAllInstances()` | 停止全部 |
| `getLastError()` | 最后一次错误 |
| `callJsonRpc(service, method, domain, payloadJson)` | 走已有 RPC 服务做查询/管理（不支持 `WebClientService`） |

**它一次构建出两个 `.so`**（`build.sh` 第 78–88 行）：`libeasytier_ffi.so` 与
`libeasytier_android_jni.so` —— 两个都要进 `jniLibs`，少一个就是
`UnsatisfiedLinkError`。

### 2.2 它的 VpnService 模板（`EasyTierVpnService.t.kt`）

流程与 FCL 大同小异，但**分工相反**：

```kotlin
val builder = Builder()
builder.setSession("EasyTier VPN")
       .addAddress(ip, networkLength)          // 来自票据的 virtualIp
       .addDnsServer("223.5.5.5")
       .addDisallowedApplication("com.easytier.easytiervpn")   // ← 要换成我们的包名
proxyCidrs.forEach { builder.addRoute(it.first, it.second) }  // 只路由虚拟网段，不是 0.0.0.0/0
vpnInterface = builder.establish()                            // Kotlin 侧 establish
EasyTierJNI.setTunFd(instanceName, vpnInterface!!.fd)         // 再把 fd 交给原生
```

与 FCL 的差别：**EasyTier 是 Kotlin 侧 establish、把 fd 传下去；Terracotta 是原生侧 establish。**
两种都行，我们用 EasyTier 的就照它的分工。

**模板有三个已知缺口，我们必须自己补：**

1. **没有 `startForeground()`** —— 模板只是个示例，没管进程存活。必须加（骨架见 §1.5）。
2. **`addDisallowedApplication` 的包名写死成它自己的 demo 包名** —— 换成 `link.cnnic.mclink`。
3. **`addDnsServer` 硬编码了 223.5.5.5 / 114.114.114.114** —— 我们的虚拟网不需要劫持 DNS
   （只路由虚拟网段），加不加要单独判断；加了会把玩家的 DNS 解析引到这两台，
   属于"顺手改了用户的上网行为"，不是我们该做的事。

> **⚠️ 模板还有一个更隐蔽的缺口，是从 FCL 的线上事故里学到的（§1.7 第一条）：**
> 模板的顺序是「先 `establish()`、再把 fd 交给内核」——
> 而在那个时候我们**还不知道要 `addRoute` 哪些网段**（路由表要等 EasyTier 把 `proxy_cidrs` 算出来）。
> **空路由的 VPN 会按默认路由接管整机流量，用户看到的是"手机突然没网了"。**
> 所以我们的顺序必须是：
> ```
> 拿到票据（主控已经给了 network/secret/peers，虚拟网段是已知的）
>   → 先 addRoute 全部虚拟网段
>   → 再 establish()
>   → 再 setTunFd()
> ```
> 若确实拿不到网段，就**不要 establish**，直接报错退出 —— 一个"连不上"的错误，
> 远好过一个"整机没网"的错误。

### 2.3 构建要求（这就是本轮做不完的原因）

`easytier-android-jni/README.md` 的"构建要求"：

```
- Rust 1.70+
- Android NDK r21+
- Linux/macOS 开发环境
```

`build.sh` 用的是 `cargo ndk -t <abi> build --release`（`cargo-ndk`），
并且 **`ANDROID_TARGETS=("arm64-v8a")` 是写死的单架构**，其余三个 ABI 被注释掉了
（`build.sh` 第 45–46 行）—— 想多出 ABI 要自己改这一行。

本机现状（本轮实测）：

| 组件 | 状态 |
| --- | --- |
| Android SDK | ✅ 已装（`F:\android-sdk`，platform 35 + build-tools 35） |
| **Android NDK** | ❌ **未装**（`F:\android-sdk\ndk` 不存在；`sdkmanager` 里可选 `ndk;21..27`） |
| **Rust / cargo / cargo-ndk / rustup** | ❌ **全部未装** |
| 构建脚本的运行环境 | ❌ `build.sh` 是 bash，且 README 明写要 Linux/macOS（本机是 Windows + PowerShell 5.1） |

---

## 3. 里程碑 2 可执行清单

> 每一步都给了命令；标 ⚠️ 的是"不做就会卡住或踩坑"的地方。

### 第 0 步：补齐工具链（约 40–60 分钟，约 3–4 GB 磁盘）

```powershell
# (1) Android NDK —— 用已经装好的 sdkmanager 装，别去官网下 zip
F:\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat "ndk;27.2.12479018"
#    装完设一下（cargo-ndk 认这三个变量之一）
$env:ANDROID_NDK_HOME = "F:\android-sdk\ndk\27.2.12479018"

# (2) Rust 工具链（Windows 上用 rustup；需要 MSVC 生成工具或选 gnu 工具链）
#     ⚠️ Windows 上装 Rust 需要 Visual Studio Build Tools 的 C++ 组件（约 2GB），
#        这是本机目前没有的。这是"在 Windows 上做 MI2"的真实前置成本。

# (3) cargo-ndk
cargo install cargo-ndk
```

**⚠️ 关于"在 Windows 上能不能做"：**
`cargo-ndk` 本身有 Windows 支持，但上游的 `build.sh` 是 bash 脚本、README 明写 Linux/macOS。
**推荐走 WSL2**（`wsl --install`，然后在 WSL 里跑 Rust + NDK），理由是：
- 上游脚本可以直接跑，不用自己翻译成 PowerShell；
- Rust 交叉编译到 `*-linux-android` 在 Linux 上是"原生"路径，出问题的概率低得多；
- NDK 的 Windows 版与 Linux 版可以在同一台机器上各装一份（WSL 里装 Linux 版）。

如果不想上 WSL，替代方案是：把 `build.sh` 的三条 `cargo ndk` 命令翻译成 PowerShell
（本质就是三行），NDK 用 Windows 版。**工作量不大，但没人验证过这条路。**

### 第 1 步：产出 `.so`

```bash
cd .cache/src/EasyTier-main/easytier-contrib/easytier-android-jni
# ⚠️ 先改 build.sh 第 46 行：ANDROID_TARGETS=("arm64-v8a" "armeabi-v7a" "x86_64")
#    （只留 arm64 会让 32 位老机与模拟器装不上；全留则构建时间×4、包体变大）
./build.sh
# 产物：target/android/<abi>/{libeasytier_android_jni.so, libeasytier_ffi.so}
```

**产物化决策（要写进文档的）：**
`.so` **入库**（照 FCL 的做法）还是**构建时生成**？
- **入库**：克隆即可构建 APK，CI 简单；代价是仓库多 4×2 个二进制（每个约 5–15MB），
  且升级 EasyTier 时要手动替换。
- **构建时生成**：仓库干净、版本可控；代价是每个构建者都要装 Rust+NDK，
  构建时间 +10 分钟。
> 建议：**入库**，并把"这两个 `.so 是从 EasyTier vX.Y.Z 的哪个 commit 构建的"写进
> 一份 `android/native/README.md`（可复现性靠记录，不靠内存）。
> 参考 `client/vendor/easytier/` 的既有做法 —— 那个目录就是入库的预编译二进制。

### 第 2 步：把 `.so` 与 Kotlin 门面接进 Capacitor 工程

```
android/android/app/src/main/jniLibs/arm64-v8a/libeasytier_android_jni.so
android/android/app/src/main/jniLibs/arm64-v8a/libeasytier_ffi.so
android/android/app/src/main/java/com/easytier/jni/EasyTierJNI.kt      ← 从上游拷（AGPL 兼容）
```
⚠️ **不要**把上游的 `EasyTierVpnService.t.kt` 直接拷进来：`.t.kt` 后缀说明它不参与编译，
它是**示例**，缺前台服务、包名写死（见 §2.2）。

### 第 3 步：写一个 Capacitor 插件把两件事包起来

这是里程碑 2 的**主要工程量**。要暴露的接口正好对上
`client/src/lib/bridge.ts` 的 `core.*`（这是本轮把适配层做成"同名接口"的回报）：

| 插件方法 | 对应 `MclinkBridge` | 里面做什么 |
| --- | --- | --- |
| `start({configToml, instanceName})` | `core.start` | 请求 VPN 授权 → 起前台服务 → `parseConfig` → `runNetworkInstance` → `setTunFd` |
| `stop()` | `core.stop` | `stopAllInstances` → 关 fd → `stopForeground` → `stopSelf` |
| `status()` | `core.status` | 查服务存活 + `collectNetworkInfosAsMap` |
| 事件 `statusChanged` / `log` | `core.onStatus` / `core.onLog` | 插件 `notifyListeners` |

**VPN 授权流程（必须走对，否则 `establish()` 抛 SecurityException）：**

```java
Intent intent = VpnService.prepare(context);   // 返回 null = 已经授权过
if (intent != null) {
    // 必须由 Activity 发起：startActivityForResult(intent, REQUEST_VPN)
    // Capacitor 插件里用 @ActivityCallback 拿回调
}
// 用户同意后（或本来就授权过）才能起服务、才能 establish()
```
⚠️ `VpnService.prepare()` **只能从 Activity 调**，不能在 Service 里调 ——
在插件里用 Capacitor 的 `@ActivityCallback` 接结果。

### 第 4 步：前台服务 + 通知渠道 + 电池优化（照 FCL 的骨架，代码自己写）

- manifest：`<service android:name=".MclinkVpnService" android:permission="android.permission.BIND_VPN_SERVICE" android:foregroundServiceType="connectedDevice|dataSync" android:exported="false" />`
- 通知渠道：一个 `IMPORTANCE_LOW` 的渠道（VPN 常驻通知不该响铃/震动）
- `startForeground()` 在 `establish()` **之前**
- `addDisallowedApplication("link.cnnic.mclink")`
- 实现 `onRevoke()`
- 电池优化：首次开隧道时用 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 引导
  （⚠️ 这个 intent 在 Google Play 上要申报理由，见 §4.1）

### 第 5 步：把 `mobile-bridge.ts` 的 `core.*` 换成真实现

`android/web/src/mobile-bridge.ts` 里那个返回"未接入"的空实现，
换成一个 `registerPlugin('MclinkVpn')` 的调用。**其余函数一行都不用动** ——
这正是本轮把适配层做成"逐字实现 `MclinkBridge`"的收益。

### 第 6 步：验证

- `adb logcat -s EasyTier-JNI` 看 JNI 层日志（README 的调试建议）
- `adb shell dumpsys connectivity | Select-String tun` 确认 TUN 起来了
- 两台设备（一台手机做成员、一台电脑做房主）互 ping 虚拟 IP
- 断网/切 Wi-Fi/切 4G 后隧道是否自愈

---

## 4. 风险清单

### 4.1 Google Play 政策（最容易低估的一条）

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| VpnService 必须申报 | Play 的 **VPNService 政策**要求使用 `VpnService` 的应用在 Play Console 里声明，且**只能用于核心功能**；用于广告拦截、流量重定向、数据采集会被拒 | 我们只用它做虚拟局域网组网（核心功能），在商店描述里写清楚 |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 要申报 | 该权限同样受 Play 政策约束，滥用会被拒 | 只在"开隧道"这个上下文里请求，并在描述里说明理由 |
| 目标 API 级别要求 | Play 每年提高 targetSdk 下限；`foregroundServiceType` 从 targetSdk 34 起是硬要求 | 我们已经是 targetSdk 35，`foregroundServiceType` 必须写 |
| **国内分发不受 Play 约束** | 如果只在自己的官网/应用商店分发（`web/` 的下载页），上面几条不适用 | 本轮官网的 `/downloads` 已支持 `.apk`，可以先走官网分发 |

### 4.2 厂商省电策略（比 Play 政策更现实的问题）

- 国产 ROM（MIUI / EMUI / ColorOS / FuntouchOS…）会在息屏后**冻结或杀掉**后台进程，
  前台服务也未必拦得住。
- 现象：隧道"莫名其妙断了"，而日志里什么都没有（进程被杀，没机会写日志）。
- **参考项目也没解决这个**：FCL 全库穷举下来，`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
  只在清单里声明、**代码零引用**，没有白名单引导 UI；联机链路也没有 WakeLock
  （唯一的 `WAKE_LOCK` 用在下载上）。所以这条**没有现成经验可抄，只能自己做**。
- 对策分层：
  1. 引导用户把应用加入"电池优化白名单"（`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`）；
  2. 引导用户关闭"后台限制 / 省电模式"（各家路径不同，需要按品牌给图文指引 ——
     这是一块**产品工作量**，不是代码工作量）；
  3. 代码上：WS 断线重连 + 隧道自动重建（我们 store 里已有 WS 退避重连，可复用其思路）；
  4. **兜底认知**：接受"某些机型就是会断"，把"重连"做成用户可见的一键动作。

### 4.3 网络与协议

| 风险 | 说明 |
| --- | --- |
| **IPv6 / 双栈** | `VpnService.Builder.addAddress/addRoute` 同时支持 v4/v6。只加 v4 路由的话，IPv6 流量会**绕过隧道**直连出去（既联不通，又是隐私问题）；两个协议族都要显式处理。EasyTier 的票据目前下发的是 `virtualIp`（v4），v6 需要它支持 —— **这点要在 MI2 开工时先确认**，不能假设 |
| MTU | 移动网络路径 MTU 常常比 1500 小；模板示例用 1500，实际可能需要下调到 1280–1400，否则表现为"能连上但大包丢" |
| 蜂窝/Wi-Fi 切换 | 切换会重建底层 socket，TUN fd 通常还在但连接要重协商；需要实测 |
| 运营商 NAT | 对称 NAT 下打洞会失败，必须能回落到中继（我们已有 `forceRelay` / 自动回落机制，可复用） |
| DNS | 不要照抄模板的 `addDnsServer`（理由见 §2.2），除非明确要劫持 DNS |

### 4.4 "手机做房主" vs "手机做成员" 的差异

| | 手机做成员（guest） | 手机做房主（host） |
| --- | --- | --- |
| 虚拟 IP | 主控分配 | 主控分配（房主的地址就是其他人填进游戏的"联机地址"） |
| 监听端口 | 票据里的 `listenPort` | 同样需要，而且**别人要能连上它** |
| 移动网络下的可达性 | 主动出站即可 | **必须能被别人连进来** —— 蜂窝网络下基本不可能，只能靠中继 |
| ACL | 被动接受 | 房主要下发 ACL（`applyAcl`），在手机上做这件事目前没有实现路径 |
| 断线影响 | 自己掉线 | **整房掉线**（所有人都连到房主） |
| 电量 | 相对低 | 明显更高（要转发所有人的流量） |

**结论：手机做房主在移动网络下大概率不可用，可行的是"手机做成员 + 电脑/服务器做房主"。**
这应该写成产品上的明确预期，而不是让用户自己撞。
（本轮 `MobileApp.vue` 里那条"这台手机还没接入虚拟网络内核…把加入码发给装了 Windows 客户端的朋友"
的提示，就是这个预期的一部分；MI2 之后文案要改，但这个"谁能当房主"的问题不会消失。）

---

## 5. 工作量粗估

标准："能自测到能用" —— 包含真机联调、断线重连、至少两台设备互通，不含商店上架。

| 工作项 | 粗估 | 说明 |
| --- | --- | --- |
| 工具链补齐（NDK + Rust + cargo-ndk + WSL） | 0.5–1 天 | 主要成本是下载与踩 Windows/WSL 的坑 |
| 产出 `.so` 并入库（含 4 ABI、可复现记录） | 0.5–1 天 | 改一行 `ANDROID_TARGETS`；首次编译要 20–40 分钟 |
| Capacitor VPN 插件（start/stop/status/事件 + 授权流程） | 2–3 天 | 主要工程量在这里 |
| 前台服务 + 通知渠道 + `onRevoke` + 电池优化引导 | 1–2 天 | 照 §3 第 4 步，坑都比较明确 |
| `mobile-bridge.ts` 换真实现 + 状态机对齐 | 0.5 天 | 接口是同名的，改动集中在一个文件 |
| 真机联调（互通、切网、息屏、重连） | 2–4 天 | **最难估的一段**，取决于手上机型的刁钻程度 |
| 降级路径与提示文案 | 1 天 | 见下 |
| **合计** | **8–13 人天** | 单人全职约 **2–3 周** |

### 最小可用版本可以先砍掉什么

按"砍掉后仍然能完成一次真实联机"排序，从最该砍的开始：

1. **x86 / x86_64 / armeabi-v7a** —— 只出 `arm64-v8a`（现代手机全是它）。
   省下 3 份构建与包体；模拟器用不了，但模拟器本来也测不了联机。
2. **电池优化白名单引导** —— 先不做 UI 引导，只在文档里写。
   代价是部分机型会断，用户会来问；不影响"第一次能不能连上"。
3. **`connectivity` 变化监听与自动重建** —— 先让用户手动重连。
4. **`collectNetworkInfosAsMap` 驱动的连接诊断面板** —— 手机上先不显示诊断信息
   （桌面端有就够排查了）。
5. **IPv6** —— 先只做 v4；但**必须**在 UI 上如实说明，并确认没有 v6 流量绕过隧道（见 §4.3）。
6. **手机做房主** —— 明确不支持，文案写清楚（见 §4.4）。

**最不该砍的**（砍了就等于没做成）：前台服务、`addDisallowedApplication`、
`onRevoke`、`foregroundServiceType`、VPN 授权流程。这五条任何一条缺了，
交出来的都是一个"看起来能连、实际随时断"的东西。

---

## 6. 降级路径：拿不到 TUN / 无法建隧道时怎么办

三种失败的形态不一样，对策也不一样：

| 失败形态 | 现象 | 对策 |
| --- | --- | --- |
| **用户拒绝 VPN 授权** | `VpnService.prepare()` 返回的 intent 被取消；`establish()` 不可用 | 不是错误，是一个合法选择。界面回到"房间可见但本机未联机"，并解释"授权 VPN 是加入虚拟局域网的前提"。**不要反复弹** |
| **另一个 VPN 应用占用了** | Android **同一时刻只允许一个 VPN**；`onRevoke()` 会被调用 | 提示"检测到另一个 VPN 应用正在运行，请先断开它"，并提供重试按钮 |
| **设备/策略禁止 VPN（企业 MDM、部分定制 ROM）** | `prepare()` 一直返回非 null 或直接抛异常 | 这是**真正的降级场景**。可选做法：① 只读模式（能看房间/成员/聊天，不能联机）—— **本轮的里程碑 1 就是这个形态**，所以它天然是一条降级路径；② 若某个游戏支持"端口转发/直连 IP"，可以尝试不用 TUN 的直连（需要 EasyTier 支持，**未验证**） |

**"只读模式"是本轮已经交付的东西**，这一点在编排上很有价值：
MI2 的失败路径不需要从零设计，它就是 MI1 的既有形态。

---

## 7. 附：本文件的事实来源

| 结论 | 来源 |
| --- | --- |
| FCL 许可证 GPL-3.0 | 仓库根 `LICENSE` 首行；`https://api.github.com/repos/FCL-Team/FoldCraftLauncher` 的 `license.spdx_id` |
| FCL 的联机内核是 **EasyTier 的 fork** | FCL `README.md:79-80`；`Terracotta/Cargo.toml:7-8,51-58`（`easytier = { git = "https://github.com/burningtnt/EasyTier.git" }`、`v2.5.0-terracotta.2`）；`libterracotta.so` 内含 `easytier/src/launcher.rs` 等路径字符串 |
| Android 走**进程内 linkage**、桌面才 exec 可执行文件 | 上游 `src/easytier/mod.rs:10-22`（`cfg_if!`）+ `linkage_impl.rs` / `executable_impl.rs` |
| Terracotta 是预编译 `.so`（4 ABI 入库，仓库内不构建） | `Terracotta/build.gradle.kts`（无 externalNativeBuild）+ `Terracotta/src/main/jniLibs/*/libterracotta.so` 四个 blob 的字节数 |
| FCL 的 VpnService 形态 | `TerracottaVPNService.java`、`TerracottaAndroidAPI.java:401-415`、`Terracotta.java:196-213`、FCL 主清单的 `<service … BIND_VPN_SERVICE … foregroundServiceType="connectedDevice\|dataSync">` |
| FCL 申请的权限 | FCL 主清单 + `Terracotta/src/main/AndroidManifest.xml` |
| 电池优化白名单**只声明不调用** | 全库（1648 文件 / 1172 kt+java）穷举：`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 仅出现在上游 demo 清单，代码零引用 |
| **空 cidrs 建 VPN 导致整机断网** | FCL issue #1429（open）→ 上游 Terracotta #133 |
| Terracotta 是 **AGPL-3.0**、EasyTier 是 **LGPL-3.0** | 各自仓库的 `LICENSE` 首行；Terracotta `README.md` 的例外条款 |
| EasyTier 官方 Android JNI | `.cache/src/EasyTier-main/easytier-contrib/easytier-android-jni/README.md`、`build.sh`、`kotlin/.../EasyTierVpnService.t.kt` |
| 本机缺 Rust/NDK | 本轮实测：`where.exe rustc/cargo/cargo-ndk` 全部找不到；`Test-Path F:\android-sdk\ndk` = False |
| 上游作者的形态判断 | burningtnt/Terracotta issue #88（"像 vpn service 这种东西没法通过 rust 实现…这些函数都得在 java/kt 的 vpnservice 里调用"） |

**取证方式的说明（可复现）**：FCL 全树经 GitHub API 缓存到 `.cache/fcl-tree.json`，
全库 tarball 解包到 `.cache/fcl-src/` 做**文本层穷举 grep**，`libterracotta.so` 做了
二进制字符串取证（`RegisterNatives` 表、EasyTier 源码路径）。上游 Terracotta 源码缓存在 `.cache/terracotta/`。

**仍未验证的**（诚实记账，不作为结论依据）：FCL 检入的 4 个 `.so` 具体由哪个 Terracotta commit 构建
（仓库里没有构建脚本或 CI 步骤，是手工提交的二进制）；只看过 `main` 分支；
"国产 ROM 后台杀联机"是否真实发生（搜遍全库与 issue 都没有相关报告，只能说 FCL 没做专门适配）；
`net.burningtnt.terracotta/rs` 目录的用途；**本文档所有结论都来自静态源码与上游 issue 日志，没有跑过真机**。
