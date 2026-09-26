# EasyTier Android 原生库 — 来源记录与取证结论

记录日期：**2026-09-27**
目标 release tag：**v2.6.4**（GitHub: `EasyTier/EasyTier`，published `2026-05-12T15:25:14Z`）
下载前缀：`https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/`

---

## 0. 结论先行（TL;DR）

**官方 v2.6.4 发布物里不存在 `libeasytier_android_jni.so`，也不存在 `libeasytier_ffi.so`。**

两个官方 Android APK 各自只带**一个**原生库 `libapp_lib.so` —— 那是 Tauri GUI 应用自己的 cdylib
（`easytier-gui/src-tauri`），EasyTier 网络核心被**静态链接进它内部**，但它对外导出的是 **Tauri 的 JNI 符号**
（`Java_com_kkrainbow_easytier_*`），**不是** `EasyTierJNI` 那套 API。

因此：

- `android/android/app/src/main/jniLibs/` **本次没有写入任何文件**（目录仍不存在）。按任务硬要求，遇到
  "APK 里根本没有这两个 .so" 的情况立即停止，不自行构建 Rust 库。
- 本文记录的是**可复现的否定结论 + 已核实的发布物指纹**，供后续决策使用。
- 后续若要拿到这两个库，只有"从上游源码交叉编译"一条路（见 §7）。

### 0.1 ABI 范围决定（2026-09-27 更新）：**只入库 arm64-v8a**

> **明确记录：本项目只入库 `arm64-v8a`。`x86_64` 未取、不作为入库目标** ——
> 原因：**不做模拟器验证，Android 侧由人工在真机上自测**，因此不需要 x86_64 那份。
> 后来的维护者请勿把"`jniLibs/` 下没有 `x86_64/` 目录"当成遗漏。
>
> 补充事实（避免误解）：`app-x86_64-release.apk` 已下载并保留在 `.cache/easytier-android/` 内
> （不影响仓库），其 `lib/x86_64/libapp_lib.so` 的取证数据在 §2/§3 中一并留档，**仅为历史取证记录**，
> **不是**入库目标。

⚠️ 这个范围决定**不改变** §0 的结论：**arm64 的 `app-arm64-release.apk` 里同样没有**
`libeasytier_android_jni.so` / `libeasytier_ffi.so`。所以"只入库 arm64-v8a"目前**没有任何文件可入库**，
`jniLibs/arm64-v8a/` 也是空的（目录未创建）。

---

## 1. 已下载并核实的官方资产（可复现）

全部存放于 `F:\mc\.cache\easytier-android\`（`.cache/` 已被 `.gitignore` 忽略，不入库）。

| 资产名 | 字节数 | MiB | SHA-256 |
|---|---|---|---|
| `app-arm64-release.apk` | 31,389,594 | 29.94 | `53444ada74838e91504ae8d3ee2688bc91ee9cf43f36b969c07de6af696f723c` |
| `app-x86_64-release.apk` | 34,537,719 | 32.94 | `a2030241b126132fb34f38667d79287a68e70cf0897f5450e7c5aab03a0c4209` |
| `Easytier-Magisk-v2.6.4.zip` | 14,099,136 | 13.45 | `39a6b4fa21d9fdc83d3b38c90562f610c0986ecc089c4026c3be22a0ab27c5e5` |

下载方式：`Invoke-WebRequest`，HTTP 200，无重定向异常。字节数与官方 Release 资产列表一致
（任务描述中的 "29.94 MB / 32.94 MB" 即以上两个 MiB 值）。

v2.6.4 全部 34 个资产的清单已核对：**没有任何资产是 Android JNI 动态库包**
（其余为 `easytier-<平台>-v2.6.4.zip`、`easytier-gui_*` 安装包、`app-*-release.apk`、Magisk 模块、dashboard）。

---

## 2. APK 内 `lib/` 的真实条目（用 .NET `ZipFile` 只读清单，未整包解压）

用 `System.IO.Compression.ZipFile` 读取中央目录，未使用 `Expand-Archive`。

**`app-arm64-release.apk`**（共 825 个条目，`lib/**` 仅 1 个）：

```
lib/arm64-v8a/libapp_lib.so     raw=28764096   uncompressed=28764096
```

**`app-x86_64-release.apk`**（共 825 个条目，`lib/**` 仅 1 个）：

```
lib/x86_64/libapp_lib.so        raw=31912224   uncompressed=31912224
```

两个 APK 中 `.so` 的**总数各为 1**。**没有** `libeasytier_android_jni.so`，
**没有** `libeasytier_ffi.so`，也没有任何被改名/混淆的候选（x86/armeabi-v7a 目录同样不存在）。

> 注意 `raw == uncompressed`：官方 APK 里 `.so` 是 **stored（不压缩）** 存放的。这与后文 §7 的体积估算相关。

为取证，`libapp_lib.so` 被抽取到 `F:\mc\.cache\easytier-android\extracted\{arm64-v8a,x86_64}\`（**仅取证用，
没有放进 `jniLibs`**，因为它不是我们需要的那个库）：

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `extracted/arm64-v8a/libapp_lib.so` | 28,764,096 | `bac3059e1a99bc837a2bf238b2cf1c8af4bbac95687e42fcb2264b83400305df` |
| `extracted/x86_64/libapp_lib.so` | 31,912,224 | `a7ffcd70f8d3c4ac47828df7fc3e8f2d9eb407ed5f377c0002f21793d3572fe4` |

两者均为**非 0 字节、非 HTML 错误页**（首 4 字节 `7f 45 4c 46`）。

---

## 3. 二进制取证结论（证据）

取证工具（本仓库内、可复现）：

- `.cache/scan-so.mjs` —— 解析 ELF 头/段表/`.dynsym`/`DT_NEEDED`，并对整个文件做**纯字节流 ASCII 扫描**
- `.cache/easytier-strings.mjs` —— 导出全部含 `easytier`（或任意正则）的 ASCII 字符串
- 用 `node .cache/scan-so.mjs <file>` / `node .cache/easytier-strings.mjs <file>` 复跑

本机**没有** `readelf`/`objdump`/`llvm-readelf`/`dumpbin`（NDK 也未安装），因此 ELF 解析由上述脚本自行完成，
不是靠外部工具的输出。

### 3.1 ELF 头判断

| 文件 | 首 20 字节 (hex) | EI_CLASS | EI_DATA | e_type | e_machine |
|---|---|---|---|---|---|
| `arm64-v8a/libapp_lib.so` | `7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00 03 00 b7 00` | 2 = **64-bit** | 1 = LE | 3 = ET_DYN | 183 = **AArch64** |
| `x86_64/libapp_lib.so` | `7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00 03 00 3e 00` | 2 = **64-bit** | 1 = LE | 3 = ET_DYN | 62 = **x86-64** |

`e_machine` 与所在 ABI 目录一致，文件头是合法 ELF（`\x7fELF`）、64-bit、小端。

`DT_NEEDED`（两者相同）：`libandroid.so`, `libc.so`, `libdl.so`, `liblog.so`, `libm.so`
→ 除 bionic 系统库外**无其它 `.so` 依赖**，`DT_SONAME` 为空。

### 3.2 导出符号 / JNI 类名

- `.dynsym` 导出符号共 **22** 个，**全部**是：
  `Java_com_kkrainbow_easytier_WryActivity_*`、`Java_com_kkrainbow_easytier_RustWebView*`、
  `Java_com_kkrainbow_easytier_RustWebChromeClient_*`、`Java_com_kkrainbow_easytier_Ipc_ipc`、
  `Java_app_tauri_plugin_PluginManager_*`
- **未导出** `JNI_OnLoad` / `JNI_OnUnload`
- 未定义符号里**没有**任何 `Java_*` 或 `easytier*`

即：这个 `.so` 提供的是 **Tauri/WRY 的 Android 胶水**，Java 包名是 **`com.kkrainbow.easytier`**
（即 `easytier-gui` 的 Tauri 应用包名），**不是** `com.easytier.jni.EasyTierJNI`。

### 3.3 字符串取证（ASCII，直接按字节搜）

对 `arm64-v8a/libapp_lib.so`（索引到 57,143 条 ≥4 字符 ASCII 串）：

| 模式 | 结果 |
|---|---|
| `JNI_OnLoad` / `JNI_OnUnload` / `RegisterNatives` | **MISS（0）** |
| `EasyTierJNI` | **MISS（0）** |
| `libeasytier_ffi` / `easytier_ffi` / `easytier_ffi_` | **MISS（0）** |
| `libeasytier_android_jni` / `easytier_android_jni` | **MISS（0）** |
| `parseConfig` / `runNetworkInstance` / `setTunFd` / `getLastError` / `callJsonRpc` | **MISS（0）** |
| `retainNetworkInstance` / `deleteNetworkInstance` / `listInstances` | **MISS（0）** |
| `collectNetworkInfos` / `collectNetworkInfosAsMap` / `stopAllInstances` | **MISS（0）** |
| `startConfigServerClient` / `isConfigServerClientConnected` / `ConfigServerEventCallback` | **MISS（0）** |
| `Java_` | HIT 22（即 §3.2 的 Tauri 符号） |

同一套扫描对 `x86_64/libapp_lib.so` 结论相同。

**EasyTier 核心确实被静态链接在里面**，证据（真实出现的字符串）：

```
easytier version: 
easytier-gui/src-tauri/src/lib.rs
/home/runner/work/EasyTier/EasyTier/target/aarch64-linux-android/release/build/easytier-17914734c91cb31d/out/api.instance.rs
/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/boringtun-easytier-0.6.1/src/noise/mod.rs
easytier/src/instance_manager.rs, easytier/src/common/config.rs, easytier/src/peers/acl_filter.rs, ...
plugin:vpnservice|get_vpn_status
com.kkrainbow.easytier
```

→ 官方 GUI 走的是 **Tauri `vpnservice` 插件 + 自己的 Kotlin 服务**（`MainForegroundService` 等），
**不经过 `EasyTierJNI`**。

### 3.4 Java 侧（`classes.dex`）

`classes.dex`（2,021,100 B）中：

- `EasyTierJNI`、`com/easytier`、`parseConfig` 等 —— **全部 MISS**
- 含 easytier 的类只有 `Lcom/kkrainbow/easytier/*`（`MainActivity`, `TauriActivity`, `WryActivity`,
  `RustWebView`, `Ipc`, `Logger`, `PermissionHelper`, `MainForegroundService`, `R$*` 等），另有字符串
  `easytier is available on localhost`、`easytier Running`、`easytier_channel`

→ 连**调用方**（Java/Kotlin `EasyTierJNI` 类）都不存在。可以排除"库在、只是被改名"的可能：
既没有实现，也没有调用者。

### 3.5 上游源码侧的设计（**源码推断，非二进制实测**）

因为二进制不存在，两库之间的依赖关系只能从上游源码读出：

- `v2.6.4` 的 `easytier-android-jni/src/lib.rs` 用 `unsafe extern "C" { fn set_tun_fd(...); fn parse_config(...); fn run_network_instance(...); fn retain_network_instance(...); fn collect_network_infos(...); fn get_error_msg(...); fn free_string(...); }`
  声明外部符号，且其 `Cargo.toml` **没有** 依赖 `easytier-ffi`（只依赖 `jni`/`once_cell`/`log`/`android_logger`/`serde`/`serde_json`/`easytier`）。
  → 这些符号在 `libeasytier_android_jni.so` 里会是**未定义符号**，需要 `libeasytier_ffi.so` 在运行时提供。
- 但 `v2.6.4` 的 Kotlin `EasyTierJNI.kt` 只写了 `System.loadLibrary("easytier_android_jni")`。
  → **谁 load 谁**：上游 v2.6.4 这套"两个 .so"的装法**并不自洽**（JNI 库既没有 `DT_NEEDED` 指向 FFI 库，
  Kotlin 也没先加载 FFI 库），很可能需要宿主先 `System.loadLibrary("easytier_ffi")` 才能 `dlopen` 成功。
  这一点**从未在二进制上验证过**（没有官方二进制可用）。
- 版本 v2.6.4 的 JNI API 实际只有 6 个 native 方法：
  `setTunFd` / `parseConfig` / `runNetworkInstance` / `retainNetworkInstance` / `collectNetworkInfos` / `getLastError`；
  `stopAllInstances`、`retainSingleInstance` 是 **Kotlin 便利方法**（内部转发 `retainNetworkInstance`），
  `collectNetworkInfosAsMap` 在 v2.6.4 **不存在**（README 表格是旧的）。
- 上游 `main`（快照 `.cache/src/EasyTier-main/`，其 workspace 版本是 **2.7.0**，**不是** v2.6.4）
  已改为模块化 `src/lib.rs`，并把 `easytier-ffi` 作为依赖静态链接（`crate-type = ["cdylib","rlib"]`），
  还加了 `build.rs` + `exports.map` 只导出 `Java_com_easytier_jni_EasyTierJNI_*`。
  **编译时必须用 v2.6.4 tag，不能用这个 main 快照**，否则 API 与版本都对不上。

### 3.6 Java 侧链接方式与两库依赖（**源码级确认，⚠️ 本项无二进制可验证**）

对上游 v2.6.4 `easytier-contrib/easytier-android-jni/src/lib.rs`（tag `v2.6.4`，直接读取上游文件）逐条核对：

**✅ 成立（源码级）：采用"名字约定导出"，没有 `JNI_OnLoad`，没有 `RegisterNatives`。**

每个 native 函数都是：

```rust
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_easytier_jni_EasyTierJNI_setTunFd(env: JNIEnv, _class: JClass, ...) -> jint
```

第二个参数是 `JClass`（而非 `JObject`）→ 对应 Java 侧的 **`static native`** 方法。
v2.6.4 的 `lib.rs` 全文里**没有** `JNI_OnLoad`、**没有** `RegisterNatives`、**没有**方法表，
只有 6 个按名字约定导出的函数：

```
Java_com_easytier_jni_EasyTierJNI_setTunFd
Java_com_easytier_jni_EasyTierJNI_parseConfig
Java_com_easytier_jni_EasyTierJNI_runNetworkInstance
Java_com_easytier_jni_EasyTierJNI_retainNetworkInstance
Java_com_easytier_jni_EasyTierJNI_collectNetworkInfos
Java_com_easytier_jni_EasyTierJNI_getLastError
```

→ 因此 Java 侧只要声明同名包与类（`package com.easytier.jni; public final class EasyTierJNI { public static native ... }`）
即可按 JNI 名字约定链接上，**不需要** `JNI_OnLoad`/`RegisterNatives`/方法表。这个判断**成立**。

**❌ 不成立：`libeasytier_android_jni.so` 的 `DT_NEEDED` 里【不会】有 `libeasytier_ffi.so`。**

这是源码层面就能确定的（不需要二进制）：

- v2.6.4 的 `easytier-android-jni/Cargo.toml` 依赖只有
  `jni`, `once_cell`, `log`, `android_logger`, `serde`, `serde_json`, `easytier` —— **没有 `easytier-ffi`**；
- `lib.rs` 里那 7 个 C 函数（`set_tun_fd`/`parse_config`/`run_network_instance`/`retain_network_instance`/
  `collect_network_infos`/`get_error_msg`/`free_string`）声明在 `unsafe extern "C" { ... }` 里，
  **没有 `#[link(name = "easytier_ffi")]`**。

→ 因此链接器**不会**写下指向 `libeasytier_ffi.so` 的 `DT_NEEDED`；这些符号在
`libeasytier_android_jni.so` 里只会是**未定义符号**，只能在运行时由**已经加载**的 `libeasytier_ffi.so`
（且必须是全局可见）提供。而 v2.6.4 的 Kotlin 只 `System.loadLibrary("easytier_android_jni")`，
**没有**先加载 FFI 库 → 这套"两个 .so"的装法**不自洽**，很可能 `dlopen` 就失败（`cannot locate symbol "set_tun_fd"`）。

> 上游 `main`（2.7.0）已经修掉这个问题：把 `easytier-ffi` 变成依赖（`crate-type = ["cdylib","rlib"]`
> 可静态链入），并加 `build.rs` + `exports.map` 只导出 `Java_com_easytier_jni_EasyTierJNI_*`。
> 即"两个 .so"在 2.7.0 里其实退化成"一个 .so 就够"。
> **以上均为源码推断，从未在二进制或运行时验证过 —— 因为官方不发布这两个库。**

**⚠️ 额外发现（会影响 Java 门面写法）：v2.6.4 的 `collectNetworkInfos` 签名上下游不一致。**

| | 签名 |
|---|---|
| v2.6.4 `lib.rs`（.so 里真实导出的那个函数） | `Java_..._collectNetworkInfos(env, _class) -> jstring`（**无 `jint` 参数**，内部 `MAX_INFOS = 100` 写死） |
| v2.6.4 `EasyTierJNI.kt`（Java/Kotlin 侧声明） | `collectNetworkInfos(maxLength: Int): String?`（**带 int**） |
| `main`(2.7.0) `lib.rs` | `collectNetworkInfos(max_length: jint)`（已对齐） |

也就是说 v2.6.4 的 Java 侧声明与 native 导出**不匹配**：JNI 长名 `..._collectNetworkInfos__I` 在 .so 里
不存在，只能靠 JNI 的**短名回退**（short-name fallback）命中无参的那个符号，多传的 `int` 被忽略。
→ 我们写 Java 门面时，**要么**照 `.so` 实际导出（无参 `collectNetworkInfos()`），**要么**照上游 Kotlin
（带 `int`，依赖短名回退、且该参数实际无效）。**这一条未在运行时验证**（无二进制），保守起来建议按 `.so`
的真实导出签名声明。v2.6.4 其余 5 个方法的签名与 Kotlin 声明一致。

### 3.7 附带核实：Magisk 模块是官方 Android 原生可执行文件

`Easytier-Magisk-v2.6.4.zip` 内含（已抽取到 `.cache/easytier-android/extracted/magisk/`）：

| 文件 | 字节数 | SHA-256 | ELF |
|---|---|---|---|
| `easytier-core` | 5,910,252 | `7bd504e87cad52edacb9ea84ece7397d0afb911101de623a3dfc4a4dbd9e6bb6` | ET_EXEC, AArch64, **无 DT_NEEDED（完全静态）** |
| `easytier-cli` | 2,421,856 | `11cd0c957e41057a49e2580ce6490d7bef8bde0a04602e5bd80a4b17cb30b984` | ET_EXEC, AArch64, 静态 |

`module.prop` 声明 `version=v2.6.4`。
两者**都没有** `Java_*`/`JNI_OnLoad`/`libeasytier_ffi` 字符串，是**命令行可执行文件**（不是 JNI 库）。
这是官方唯一面向 Android 的原生二进制，需要一个 Android `aarch64` 上完全静态、无需 root 也能跑的
EasyTier 核心时可作为参考；但它**不提供** JNI 接口，也不能当 `jniLibs` 里的 `.so` 用。

---

## 4. 与桌面端版本的一致性

**桌面端 `client/vendor/easytier/` 确认是 `2.6.4-8428a89d`**（独立复核，非照抄）：

- 直接扫 `client/vendor/easytier/easytier-cli.exe` 的字节流，命中连续字符串
  `kkrainbow` + **`2.6.4-8428a89d`** + `A full meshed p2p VPN, connecting all your devices in one ne…`
  （`easytier-core.exe` 里同样能扫到 `2.6.4-84…` 片段）
- `scripts/fetch-easytier.mjs` 第 25 行默认 `VERSION = 'v2.6.4'`，资产名按 v2.6.4 写死

→ 本次 APK 也取自同一个 **v2.6.4** release tag，**版本一致**（桌面端 build 号 `2.6.4-8428a89d`
与 tag `v2.6.4` 对应）。若将来桌面端升级，Android 侧应同步换同一个 tag。

`client/vendor/easytier/` 的文件（`easytier-cli.exe` 9,973,248 B / `easytier-core.exe` 24,395,776 B /
`Packet.dll` / `WinDivert64.sys` / `wintun.dll`）**不入库**：被根 `.gitignore:31` 的 `client/vendor/` 忽略
（`git ls-files client/vendor/easytier` 为空，`git check-ignore` 命中 `.gitignore:31`），
由 `scripts/fetch-easytier.mjs` 在构建时获取。

---

## 5. 许可证（只写工程事实与该做的事）

**事实核对**：`LICENSE`（仓库根，v2.6.4 tag 与本快照一致）正文是
**GNU Lesser General Public License, Version 3, 29 June 2007（LGPL-3.0）**。

我们使用它的方式（工程事实）：

- **以未经修改的动态库形式使用**：`jniLibs` 下的 `.so` 是上游构建产物原样拷贝，
  不 strip、不改名、不重新链接、不做任何字节改动。
- **替换点**：`android/android/app/src/main/jniLibs/<abi>/*.so`。
  任何人要换用自己编译/修改过的版本，只需替换该目录下的文件重新打包即可，
  不需要改动我们的任何源码（这是 LGPL "可替换库" 的工程前提：不得把库静态链进我们的代码、
  不得阻碍替换）。
- **随包附带**：需要把 LGPL-3.0 全文随 APK 一起提供，并给出上游源码指引
  （`https://github.com/EasyTier/EasyTier`，tag `v2.6.4`；若该库未修改，指向该 tag 即可）。
  常见落点：`android/android/app/src/main/assets/licenses/` 或应用内"开源许可"页面。
- 本节只陈述上述工程事实与待办项，**不给出法律结论**；具体合规判断请另行确认。

---

## 6. 未验证项 / 本次没做到的部分（如实列出）

1. **`libeasytier_android_jni.so` / `libeasytier_ffi.so` 在官方 v2.6.4 发布物中不存在**，
   因此它们的**字节数、SHA-256、导出符号、`JNI_OnLoad`、`RegisterNatives`、真实方法名、
   两库间 `DT_NEEDED` 依赖**——**全部无法从官方二进制取证**。§3.6 只是上游源码推断。
2. `jniLibs/` **未创建、未写入任何文件**；没有做任何 strip / 重命名 / 修改字节的操作。
3. **16 KB page size 兼容性未验证**（Android 15+ / targetSdk 35+ 的 `-Wl,-z,max-page-size=16384` 要求）。
   官方 APK 里的 `libapp_lib.so` 是 stored 且对齐的（`raw == uncompressed`），但这**不能**证明
   上游 JNI 库满足 16 KB 对齐要求。
4. **未在真机或模拟器上跑过**：既没有加载过任何 EasyTier `.so`，也没有建立过 VPN/TUN。
   （按 §0.1，模拟器验证已明确不做，改由人工真机自测。）
5. 未验证 v2.6.4 的 JNI crate **能否成功交叉编译**（NDK/cargo-ndk 均未安装；本机无 Rust Android target）。
6. §3.6 的三条判断**都只有源码级证据，没有二进制/运行时证据**：
   (a) "名字约定导出、无 `JNI_OnLoad`/`RegisterNatives`" —— 源码成立，但**没有 .so 可供核对符号表**；
   (b) "`DT_NEEDED` 里不会有 `libeasytier_ffi.so`、运行时需先加载 FFI 库、否则 `dlopen` 失败" —— 源码推断，未在运行时复现；
   (c) "v2.6.4 `collectNetworkInfos` 的 Java 声明与 native 导出签名不匹配、靠短名回退才命中" —— 源码比对得出，
       未在 ART 上验证短名回退是否真的生效。
7. `Easytier-Magisk` 的 `easytier-core` 未在 Android 上运行验证；未确认它是否依赖 root 或 Magisk 环境
   （`customize.sh`/`service.sh` 未分析）。
8. 桌面端版本号是通过扫描 `easytier-cli.exe` 二进制字符串得到的（`2.6.4-8428a89d`），
   不是通过 `easytier-cli --version` 实跑；`easytier-core.exe` 中该字符串被相邻字节截断，只能看到 `2.6.4-84…`。
9. §0.1 的 arm64-only 范围决定使得 `x86_64` 那份**未被选中入库**，但这只是策略选择；
   本节第 1 条说明**两个 ABI 都没有这两个库**。

---

## 7. 体积影响（因为库不存在，只能给"边界+依据"，不是实测）

**先给事实：**

- 官方 APK 里 `.so` 以 **stored（不压缩）** 方式存放（`raw == uncompressed`），
  所以一个 `.so` 有多大，APK 就涨多少（近似 1:1）。
- 官方 Android GUI 的 `libapp_lib.so`：arm64 **28,764,096 B (27.43 MiB)**，
  x86_64 **31,912,224 B (30.43 MiB)** —— 但它含整个 Tauri GUI + WebView 胶水，**不能**当作 JNI 库的体积。
- 更接近的参照物：官方 Magisk 模块里的 Android AArch64 **`easytier-core` = 5,910,252 B (5.64 MiB)**，
  它是同一个 EasyTier 核心、同样的 release profile（`lto=true`, `codegen-units=1`, `opt-level=3`,
  `strip=true`, `panic="abort"`）编出来的、已 strip 的产物。

**估算（明确是估算）：**

| 项 | 估算 |
|---|---|
| 单个 JNI `.so`（arm64-v8a，strip 后） | 约 **6–10 MB**（以 5.64 MiB 的 `easytier-core` 为下界锚点，另加 `jni`/`serde`/FFI 胶水） |
| 两个 `.so` 合计（**同为 arm64-v8a**，即 §0.1 范围内的唯一组合） | 约 **12–20 MB**（**无法精确给出，因为文件不存在**） |
| 我们的 APK（当前 **4.26 MB**）→ 只带 arm64-v8a 一份 JNI 库 | 约 **10–14 MB** |
| 我们的 APK → arm64-v8a 的两个 `.so` 都塞进去 | 约 **16–24 MB** |

（x86_64 不在范围内，见 §0.1；上表不涉及它。）

**据此的工程建议（供决策，未实施）：**

- **或许只需一个库**：上游 Kotlin 只 `System.loadLibrary("easytier_android_jni")`；
  `libeasytier_ffi.so` 在 main(2.7.0) 里已被静态链进 JNI 库。
  但 **v2.6.4 里必须先加载 FFI 库**（因为 v2.6.4 的 JNI 库没有 `DT_NEEDED`，见 §3.6）——
  这条决定了 v2.6.4 到底要放 1 个还是 2 个 `.so` 进 `jniLibs/arm64-v8a/`，**需要实测才能定**
  （在真机上 `System.loadLibrary` 试一次就知道）。
- 发布包用 `abiFilters` 只留 `arm64-v8a`（与 §0.1 的范围决定一致）。

---

## 8. `.gitignore` 结论（只说明，未改动任何 ignore 文件）

- `android/android/app/src/main/jniLibs/**/*.so` **不会被忽略**：
  `git check-ignore` 对
  `android/android/app/src/main/jniLibs/arm64-v8a/libeasytier_android_jni.so` 与
  `.../x86_64/libeasytier_ffi.so` 均返回 **exit 1（无匹配规则）**。
- 仓库中所有 `.gitignore`（根、`android/`、`android/android/`、`android/android/app/`）里
  **没有** `*.so`、`jniLibs`、`libs/` 之类的规则；唯一相关的是 `android/android/.gitignore` 里的
  `.externalNativeBuild` 与 `.cxx/`（针对 NDK 构建中间产物，不影响 `jniLibs`）。
- 因此一旦把 `.so` 放进 `jniLibs`，`git add` 会**正常入库**，**无需修改任何 `.gitignore`**。
- 需要澄清的一点：`client/vendor/easytier/` **并不入库**（根 `.gitignore:31` 的 `client/vendor/` 命中，
  `git ls-files` 为空，由 `scripts/fetch-easytier.mjs` 构建时下载）。
  所以"照 `client/vendor/easytier/` 的做法"与"我们要入库"其实是**两种不同**策略，
  本次按"要入库"执行评估：**当前 ignore 配置下可以直接入库，无阻碍**。

---

## 9. 从源码构建（本机实录，2026-09-27）

> 这一节替换掉之前的"两库 + 链接参数补 DT_NEEDED"方案 —— 最后采用的是**单库（静态链入）**，
> 理由见 §9.2。命令已固化成脚本：`android/native/build-jni.ps1`（幂等，可重跑）。

### 9.1 工具链（本机实际版本）

| 组件 | 版本 / 位置 |
| --- | --- |
| rustup 工具链 | `1.95-x86_64-pc-windows-gnu`（由上游 `rust-toolchain.toml` 的 `channel = "1.95"` 钉住；**不需要 nightly**） |
| cargo / cargo-ndk | `F:\cargo`（`CARGO_HOME`）、`F:\rustup`（`RUSTUP_HOME`） |
| Android NDK | `27.3.13750724`（`sdkmanager` 装到 `F:\android-sdk\ndk`） |
| MinGW-w64（宿主链接器） | gcc 16.2.0 UCRT POSIX SEH，`F:\mingw64` |
| protoc | 36.2，`F:\protoc`（官方 win64 zip） |
| libclang | 18.1.1（PyPI `libclang` wheel），`F:\libclang\clang\native` |

产物来源：上游 tag **`v2.6.4`**，commit **`8428a89`** —— 与桌面端 `client/vendor/easytier/`
里的 `2.6.4-8428a89d` **同一个 commit**。

### 9.2 相对上游的两处清单改动（源码一行未改）

```toml
# easytier-contrib/easytier-ffi/Cargo.toml
crate-type = ["cdylib", "rlib"]

# easytier-contrib/easytier-android-jni/Cargo.toml
easytier-ffi = { path = "../easytier-ffi" }
```

**为什么**：上游 v2.6.4 的 JNI crate 用 `unsafe extern "C"` 声明外部符号却不依赖 `easytier-ffi`，
编出来的库对外部符号**没有 `DT_NEEDED`**，运行时靠加载顺序碰运气（`cannot locate symbol "set_tun_fd"`）。
改成静态链入后**只需要一个 .so**，没有加载顺序问题 —— 上游 main(2.7.0) 后来做的也是同一件事。

### 9.3 构建这条链上踩到的 5 个坑

1. **宿主工具链要用 GNU，且必须有 MinGW 的 `dlltool.exe`**：本机没有 MSVC，所以 rustup 装的是
   `x86_64-pc-windows-gnu`；但 GNU 宿主编译 `windows-sys` 需要 dlltool，缺了报
   `error calling dlltool 'dlltool.exe': program not found`。
2. **需要 `protoc`**：`prost-wkt-types` 的 build script 找不到 protoc 就 `Could not find 'protoc'`。
3. **需要 `libclang`**：`kcp-sys` 用 bindgen；NDK r27 **不再自带** `libclang.dll`
   （`toolchains\llvm\prebuilt\windows-x86_64\bin` 里没有），要从 PyPI 的 `libclang` wheel 取。
4. **⚠️ 最难查的一个：`BINDGEN_EXTRA_CLANG_ARGS` 里的路径必须用正斜杠。**
   bindgen 用 `shlex::split` 解析这个变量，而 shlex 把**反斜杠当转义符**：`F:\android-sdk\...`
   变成 `F:android-sdk...`，于是 `-resource-dir` 指向不存在的目录，clang 连自己的内置头都找不到，
   报 `fatal error: 'stddef.h' file not found` —— 现象像 sysroot 没配好，实际是反斜杠被吃掉了。
   三个变量名都要设：`BINDGEN_EXTRA_CLANG_ARGS`、`..._aarch64-linux-android`、
   `..._aarch64_linux_android`（bindgen 实际查的是**下划线**那版）。
5. **`github.com:443` 在本机不通**（`api.github.com` / `codeload` / `raw` 都通，唯独它超时），
   而 `Cargo.lock` 钉了 7 个 git 依赖全在 github.com 上 → 必须走本地代理
   （`HTTP(S)_PROXY` + `CARGO_NET_GIT_FETCH_WITH_CLI=true`，让 cargo 用系统 git）。
   另外 **cargo-ndk 的 `-p` 是它自己的 `--platform`**，别当 cargo 的 `--package` 用（会 panic）。

### 9.4 产物与二进制取证

| 项 | 值 |
| --- | --- |
| 文件 | `android/android/app/src/main/jniLibs/arm64-v8a/libeasytier_android_jni.so` |
| 字节数 | **6,291,128 B（6.00 MiB）** |
| SHA-256 | `403da415626528e22d852e704d8af53ca8f187d63e5903d07eef0b8d9bcc533c` |
| ELF | 64-bit / LE / ET_DYN / `e_machine=183 (AArch64)` |
| `DT_NEEDED` | 只有 `liblog.so`、`libc.so`、`libdl.so` —— **不含 `libeasytier_ffi.so`**，即单库自包含 |
| 导出符号 | 6 个，全是 `Java_com_easytier_jni_EasyTierJNI_{setTunFd,parseConfig,runNetworkInstance,retainNetworkInstance,collectNetworkInfos,getLastError}` |
| `JNI_OnLoad` / `RegisterNatives` | **没有**（与上游源码一致：名字约定导出） |
| 未定义的 easytier 符号 | **0 个** |
| 编译耗时 | 首次全量约 20 分钟；`easytier` 核心 crate 单次 7 分 49 秒（增量） |

进包后：APK 从 4.26 MB（无原生库）→ **10.02 MB**，`native-code: 'arm64-v8a'`
（`build.gradle` 里 `abiFilters 'arm64-v8a'` 锁死，别加 x86_64 除非要跑模拟器）。

### 9.5 仍未验证的

**这个 `.so` 从未在 Android 设备上被加载或运行过。** 上面全部是静态取证（ELF 头、符号表、
包内比对）。`dlopen` 是否成功、`setTunFd` 之后隧道是否真的通，只有真机装机才能证明 ——
清单见 `docs/android-vpn.md` §5.1。