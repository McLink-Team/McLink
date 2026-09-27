# Android 联机（里程碑 2）实现契约

> 状态：**实现中**。本文件是 Kotlin 侧与 TypeScript 侧的**唯一契约**，
> 两侧并行开发都照它写；任何一侧想改接口，先改这里。
>
> 与 `docs/android-milestone2-easytier.md` 的关系：那份是**调研与方案**（含 FCL/Terracotta
> 取证、许可证分析、风险清单），这份是**施工图**。方案里"本机做不完（缺 Rust + NDK）"的
> 结论已被推翻 —— 见 §1。

---

## 1. 原生库来源：从源码交叉编译

> **⚠️ 本节原来的结论已被推翻，记在这里免得后人再走一遍。**
> 最初的判断是"EasyTier 官方 v2.6.4 的 `app-arm64-release.apk` 里装着
> `libeasytier_android_jni.so` + `libeasytier_ffi.so`，直接抠出来就能用"。
> **这是错的。** 完整取证在 `android/native/README.md`，结论如下：

| 事实 | 证据 |
| --- | --- |
| 官方 APK 里 `lib/**` 只有 **1 个** `.so`：`libapp_lib.so`（arm64 28,764,096 B） | 读 APK 中央目录，`lib/**` 条目数 = 1 |
| 那是 **Tauri GUI 自己的 cdylib**（EasyTier 内核静态链在里面，但对外导出的是 Tauri/WRY 的 JNI 符号 `Java_com_kkrainbow_easytier_*`） | `.dynsym` 22 个导出符号全是 Tauri 的 |
| `EasyTierJNI`、`parseConfig`、`setTunFd`、`libeasytier_ffi` **一个都搜不到** | 全文件 ASCII 扫描 0 命中 |
| `classes.dex` 里连 `com.easytier.jni.EasyTierJNI` 这个类都不存在 | 既无实现也无调用方 → 排除"改名/混淆" |
| v2.6.4 的 34 个 release 资产里**没有任何 Android JNI 动态库** | 逐个核对资产名 |

官方 Android 应用走的是 **Tauri 的 `vpnservice` 插件 + 它自己的 Kotlin 前台服务**，
**不经过** `easytier-android-jni`。所以唯一路径是**自己交叉编译**：

- 源码：`EasyTier/EasyTier` **tag `v2.6.4`**（与桌面端 `client/vendor/easytier/` 的 `2.6.4-8428a89d` 同一 tag；
  手机是房客，要跟主控中继和桌面房主说同一版协议，所以不对齐 main）
- 工具链：stable Rust（**不需要 nightly / 不需要 `-Zbuild-std`**，我读过 v2.6.4 的 `build.sh`）+ Android NDK + `cargo-ndk`
- 产物：`libeasytier_ffi.so` 与 `libeasytier_android_jni.so`（**两个都要**：JNI 库只是薄薄一层包装，
  实现在 ffi 库里；`src/network_api.rs` 调的就是 `easytier_ffi::*`）
- 落位：`android/android/app/src/main/jniLibs/arm64-v8a/`
- 命令与实录：`android/native/build-jni.ps1` + `android/native/README.md` §9

**只出 arm64-v8a**：用户明确真机自测、不做模拟器验证，所以不编 x86_64（省一半包体与构建时间）。

### 1.1 上游 JNI 接口（v2.6.4 只有 6 个方法）

上游 `src/lib.rs` 用的是**名字约定导出**：
`#[unsafe(no_mangle)] pub extern "system" fn Java_com_easytier_jni_EasyTierJNI_<方法>` ——
**没有 `JNI_OnLoad`、没有 `RegisterNatives`、没有方法表**。
这意味着类名/包名/方法名/签名必须完全一致，否则运行时 `UnsatisfiedLinkError`；
也意味着 Java 侧**不必**写 `JNI_OnLoad`，一个 `public final class EasyTierJNI { public static native ... }` 就够。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `setTunFd` | `(String, int) → int` | 把 VpnService 的 TUN fd 交给内核 |
| `parseConfig` | `(String) → int` | 只校验 TOML |
| `runNetworkInstance` | `(String) → int` | 同进程启动实例 |
| `retainNetworkInstance` | `(String[]) → int` | 保留数组里的、停掉其余；`null` = 全停 |
| `collectNetworkInfos` | `() → String` | ⚠️ **v2.6.4 是无参的** |
| `getLastError` | `() → String` | **必须先查它再拼错误信息** |

**⚠️ 三个会让人踩坑的不一致（都以 `.so` 的真实导出为准，不是以上游 Kotlin 门面为准）：**

1. 上游 `kotlin/com/easytier/jni/EasyTierJNI.kt` 里还有 `deleteNetworkInstance` / `listInstances` /
   `callJsonRpc` / `startConfigServerClient` / `stopConfigServerClient` / `isConfigServerClientConnected`
   —— **这些在 v2.6.4 的 .so 里不存在**（是 main/2.7.0 才加的）。照抄那份 Kotlin = 声明了不存在的方法。
   我们只声明真实存在的 6 个（见 `EasyTierJNI.java`）。
2. `collectNetworkInfos` 在 v2.6.4 是**无参**导出，而 Kotlin 门面写成 `collectNetworkInfos(maxLength: Int)`。
   JNI 的短名回退能让带参声明"碰巧"命中无参实现（多传的 int 被忽略），但那是未定义行为 —— 我们按真实导出声明无参。
3. 上游那份同目录 `README.md` 里的 API 表格是**旧的**（比如 `collectNetworkInfosAsMap` 在 v2.6.4 根本没有）。
   别照抄，以 `src/lib.rs` 为准。

### 1.2 为什么最后只产出一个 `.so`（上游 v2.6.4 的"两库"装法有缺陷）

v2.6.4 的 JNI crate 用 `unsafe extern "C" { fn set_tun_fd(...) ... }` 声明外部符号，
但它的 `Cargo.toml` **没有依赖 `easytier-ffi`**，extern 块里也**没有 `#[link(name = ...)]`** ——
所以编出来的 JNI 库**不带**指向 `libeasytier_ffi.so` 的 `DT_NEEDED`，那些符号只能是**未定义符号**，
运行时得靠"已经加载且全局可见的 FFI 库"来补。而上游那套 Kotlin 门面只
`System.loadLibrary("easytier_android_jni")` —— 这套装法**是坏的**（`cannot locate symbol "set_tun_fd"`），
只是上游自己没走这条路（官方 Android 应用用的是 Tauri 插件，见 §1 的取证），所以没人踩到。

我们试过两条修法，最后选了第二条：

| 修法 | 做法 | 为什么没选 / 选了 |
| --- | --- | --- |
| ① 补链接参数 | 构建时加 `-C link-arg=-Wl,--no-as-needed -C link-arg=-leasytier_ffi`，让 JNI 库自己带上 `DT_NEEDED` | 依赖链接器行为、还给 Java 侧留下"加载顺序"这个隐含前提。**没选** |
| ② 改成静态链入 | `easytier-ffi` 的 `crate-type` 加 `rlib`，并让 JNI crate 依赖它 | **选了**：只产出一个自包含的 `.so`，没有任何加载顺序问题（这也正是上游 main/2.7.0 后来做的同一件事） |

**改动是两处构建清单 + 一行 `extern crate`，EasyTier 的业务源码一行没动**：

```toml
# easytier-contrib/easytier-ffi/Cargo.toml
crate-type = ["cdylib", "rlib"]

# easytier-contrib/easytier-android-jni/Cargo.toml
easytier-ffi = { path = "../easytier-ffi" }
```

```rust
// easytier-contrib/easytier-android-jni/src/lib.rs
extern crate easytier_ffi;   // ← 少了这一行，编出来的 .so 是个空壳
```

> **⚠️ 这第三处是 APK 0.2.0 的真机事故换来的，别删。**
> 只把那两处写进 Cargo.toml 时，`easytier-ffi` 是个**没有任何 Rust 代码使用的依赖**，
> rustc 于是不把它的 rlib 交给链接器；而 cdylib 的 `-shared` 又允许未定义符号，
> 所以**编译成功**、装机后 `dlopen` 立刻失败：
> `cannot locate symbol "collect_network_infos"`。
> 识别信号：**.so 体积异常小**（空壳 6.29 MB vs 真链上 19.93 MB）。
> 门禁：`android/scripts/check-undefined-symbols.mjs`（按符号名清单判定），
> 并被 `verify-android-apk.ps1` 第 5 组检查从 **APK 内的 .so** 上再跑一遍。

代价与收益要一起说清楚：
- **收益**：APK 里只有一个 `.so`；没有 `dlopen` 顺序问题；`libeasytier_ffi.so` 根本不需要进包。
- **代价**：我们交付的二进制是从"上游源码 + 两行清单改动"构建的，所以**构建实录必须公开**
  （`android/native/README.md` §9 + `android/native/build-jni.ps1`），LGPL 的"未经修改"这句话
  要精确到"源码未改、只改了两处 crate 配置"。这一点不能含糊。

Java 侧 `EasyTierJNI` 的静态块仍然**先尝试** `System.loadLibrary("easytier_ffi")`（失败不抛）：
单库方案下这一步是多余的，留着是为了将来有人换回"两库"构建时不至于又踩加载顺序的坑。

**fd 的时序语义（源码实证，很关键）**：`easytier/src/instance/runtime_host/tun_mobile.rs`
里 `prepare()` 起了一个 tokio 任务，**在 mpsc 上一直等 fd**（`fd = tun_fds.recv()`，
`fd <= 0` 直接忽略）。也就是说 `setTunFd` **可以在实例启动之后任意时刻调用**，不会因为
"fd 还没到"而启动失败。

反过来有个**必须知道的坑**：`install_mobile_tun()` 失败时只打一行
`tracing::error!("failed to attach mobile TUN fd")`，**不会回传给 Java**。
所以 `setTunFd` 返回 0 **不等于**隧道真的建好了 —— 这个"静默失败"必须靠
连通性验证（§5）来发现，不能靠返回值。

---

## 2. 分层：谁算什么

```
client/src/lib/store.ts  startNetwork()
        │  core.start({ configToml, launchArgs, instanceName })      ← 桌面/移动共用，一行不改
        ▼
android/web/src/mobile-bridge.ts                                     ← 本轮改这里（core.* 换真实现）
        │  ① vpn-plan.ts：从 TOML 算出「地址 + 路由 + MTU」——纯函数，可单测
        ▼
Capacitor 插件 MclinkVpn（Java）                                        ← 本轮新增
        │  ② VPN 授权（必须由 Activity 发起）→ 前台服务
        ▼
MclinkVpnService（Java，VpnService + FGS）                              ← 本轮新增
        │  ③ startForeground → parseConfig → runNetworkInstance → establish → setTunFd
        ▼
libeasytier_android_jni.so + libeasytier_ffi.so                       ← 官方预编译，未经修改
```

**为什么"算路由"放在 TS 而不是 Java**：它是本轮唯一有"算错就整机断网"后果的逻辑，
放在 TypeScript 里能用 Node 单元测试覆盖（含真实票据），而 Java 那侧没有测试运行环境。
Java 仍然**独立校验一遍**（§4 的硬规则），不盲信入参。

---

## 3. 插件接口（Java 实现，TS 消费）

插件名：`MclinkVpn`。

```ts
interface VpnStatus {
  running: boolean;
  instanceName: string | null;
  tunFd: number | null;
  startedAt: string | null;   // ISO
  lastError: string | null;   // 给玩家看的中文；null = 没有错误
  /** 错误分类，与下面 VpnErrorCode 同一套取值；null = 没有错误 */
  lastErrorCode: VpnErrorCode | null;
  vpnAuthorized: boolean;     // VpnService.prepare() 返回 null 时为 true
}

/**
 * ⚠️ start/stop 的返回值是 **VpnStatus 的字段平铺** + ok/code/message，**没有嵌套的 `status` 对象**。
 *
 * 这是实现决定的（`MclinkVpnPlugin.java` 里就是 `statusToJs(snapshot)` 之后再 `put("ok", …)`），
 * 而不是设计偏好。之所以特意写在这里：如果按"嵌套 status"去读，`result.status` 是 undefined，
 * 映射出来就是 `stopped` —— 隧道明明起来了，房间页却永远显示"正在建立连接…"，而且不报任何错。
 * TS 侧的 `pickVpnStatus()` 两种形状都认（防御），但**契约以平铺为准**。
 */
start(payload: {
  instanceName: string;
  configToml: string;
  address: { ip: string; prefix: number };   // 本机虚拟地址（来自 TOML 的 ipv4）
  routes: { ip: string; prefix: number }[];  // 只含房间网段；空数组 = 拒绝启动
  mtu: number;
}): Promise<VpnStatus & { ok: boolean; code?: VpnErrorCode; message?: string }>

stop(): Promise<VpnStatus & { ok: boolean }>
status(): Promise<VpnStatus>
logs(options: { limit?: number }): Promise<{ lines: string[] }>

/**
 * 施加房主的房间规则（踢人/封禁）。**平铺形状**，与 start/stop 一致。
 *
 * `mode` 目前恒为 `'restart'`：v2.6.4 没有 ACL 热更新（`easytier-cli acl set` 在 2.6.4 里不存在，
 * 桌面端 `main.cjs:961` 的注释就写着这件事），所以两端都是"把 ACL 合并进配置 → 重启内核实例"。
 * 代价是**房主自己会短暂断线约 2 秒**；对方被踢是立刻生效的。
 */
applyAcl(payload: { aclToml: string }): Promise<{ ok: boolean; mode?: 'hot' | 'restart'; error?: string }>
```

`logs()` 的 `limit` 目前**只在前端生效**：原生侧总是返回全部（最多 200 行环形缓冲），
而且历史行没有逐行时间戳（契约就只有 `lines: string[]`）—— 这一条是已知的近似，不算违约但要知道。

> **⚠️ 失败有两条通道，TS 侧两条都要接（真机上踩过）。**
>
> 1. **平铺 `{ ok: false, code?, message? }`** —— 异步流程跑完之后失败（建隧道失败、施加规则失败）。
> 2. **`call.reject(message, code)`（Promise reject）** —— **早退**：参数不全、还没联机、
>    **以及玩家在系统对话框里点了「拒绝」VPN 授权**（`MclinkVpnPlugin` 里 `code='vpn-denied'`）。
>
> 只处理第 1 条的话，玩家点「拒绝」会看到"联机服务没有响应，请退出房间后重新加入" ——
> 一句让人去重装应用的话，而正确的话是"授权 VPN 是加入虚拟局域网的前提，请重新点『连接』"。
> TS 侧的判定口径：**异常的 `code` 是不是字符串**（Capacitor 框架自己的 `UNIMPLEMENTED`/`UNAVAILABLE`
> 要排除在外）——是，就是原生拒绝，按 `code` 走 §3 的文案表；不是，才是真的桥断了。

事件：

| 事件 | 载荷 | 触发时机 |
| --- | --- | --- |
| `statusChanged` | `VpnStatus` | 服务起来 / 隧道建立 / `onRevoke` / 停止 / 出错 |
| `log` | `{ line: string; at: string }` | 服务侧每一行日志（供房间页日志面板） |

`VpnErrorCode`（TS 侧按它给玩家可行动的文案，**不要**把 code 直接显示给玩家）：

| code | 含义 | 玩家该做什么 |
| --- | --- | --- |
| `vpn-denied` | 用户在系统对话框里拒绝了 VPN 授权 | 说明"授权 VPN 是加入虚拟局域网的前提"，**不重复弹** |
| `no-routes` | 算不出房间网段（TOML 里没有 `ipv4` 或格式不认识） | 重新拉一次票据；持续失败就是客户端 bug |
| `establish-failed` | `Builder.establish()` 返回 null（被别的 VPN 占用 / 策略禁止） | 提示先断开其它 VPN |
| `core-failed` | `parseConfig` / `runNetworkInstance` 抛异常 | 显示 `getLastError()` 的原文（**不要**用桌面那套端口/提权措辞） |
| `busy` | 已有实例在跑且没停干净 | 先停止再重试 |
| `internal` | 其它 | 显示 message |

### 3.1 与 `CoreStatus` 的映射（TS 侧）

| VpnStatus | `CoreStatus` |
| --- | --- |
| `running: true` | `state: 'running'`，`pid: null`（**没有子进程**，这就是事实），`startedAt` |
| `running: false` + `lastError` | `state: 'error'`，`lastError` |
| `running: false`、无错误 | `state: 'stopped'` |

`configFile: null`、`args: []`、`coreBin: ''`、`coreBinExists: false`、`cliBinExists: false`、
`rpcPortal: null`、`elevated: false`。其余字段照 `client/src/lib/core-types.ts` 的定义，别猜。

`core.peers()` / `core.cli()` （诊断面板）：本轮**仍是诚实的失败**
（`{ ok: false, error: '…暂不支持…' }`），UI 显示"无数据"是既定行为；
真要做得走 `callJsonRpc`，不在本轮范围。

---

## 4. 硬规则（写错任何一条都会造成真实伤害，不许"以后再补"）

1. **路由为空就不许 `establish()`。** 空路由的 VPN 按默认路由接管整机流量 ——
   玩家看到的是"手机突然没网了"（FCL 线上事故 #1429，见方案文档 §1.7）。
   拿不到网段就返回 `no-routes` 并退出，**宁可连不上，不可整机断网**。
2. **永远不许 `addRoute("0.0.0.0", 0)`。** 只路由房间网段：
   `10.200.<slot>.0/24`（见 `packages/shared/src/virtualnet.ts`）。
   校验：**地址前缀 8 ≤ prefix ≤ 24、路由前缀 8 ≤ prefix ≤ 24**，且网段必须落在 `10.200.0.0/16` 里。
   上界 24 是两边都实现的（`vpn-plan.ts` 与 `MclinkVpnService.Payload#problem()`）——
   一个放行一个拒绝的话，玩家会看到一句没头没尾的"网络前缀不合法"。
3. `addDisallowedApplication("link.cnnic.mclink")` —— 自己的流量不走隧道
   （否则 EasyTier 连中继的包会绕回自己，死锁）。
4. **不加 `addDnsServer`。** 模板里硬编码的 223.5.5.5 / 114.114.114.114 会把玩家的 DNS
   解析改到那两台机器上 —— 那是"顺手改了用户的上网行为"，我们不该做，也不需要
   （只路由一个 /24，不劫持解析）。
5. `startForeground()` 必须在 `establish()` **之前**（Android 要求 5 秒内进入前台，
   而 `establish()` 可能弹系统确认）。
6. `setMtu(ticket.mtu)` = 1380，与票据里 EasyTier 的 `mtu` 一致：VpnService 的 MTU 大于
   EasyTier 的 MTU 时，游戏会发出内核处理不了的大包。
7. `onRevoke()` 必须实现：Android 同一时刻只允许一个 VPN，被抢占时要回到"未联机"而不是
   留一个假装在跑的界面。
8. 服务被系统重启（`onStartCommand` 拿到 `null` intent）时从 `SharedPreferences`
   恢复上次的启动参数；**恢复不到就 `stopSelf()`**，不要用一个空配置起隧道。

---

## 5. 验证：本机验到哪一层，真机由谁测

**分工（用户明确要求）**：本机只做能自证的部分；**真机联机由用户自己测，我们不跑模拟器**
（本机 `HypervisorPresent = False`，没有硬件虚拟化，x86_64 镜像根本起不来；arm64 镜像只能 QEMU TCG
纯软件模拟，慢且不稳，不值得为它花 1GB 下载和半小时启动）。

| 层次 | 手段 | 谁做 |
| --- | --- | --- |
| 路由/MTU 计算正确 | `vpn-plan` 的 Node 单元测试，**喂真实票据**（起本机主控 → 注册 → 建房 → 取 ticket） | 本机 ✅ |
| 拒绝危险输入 | 空路由、`0.0.0.0/0`、越界网段、缺 `ipv4` 的 TOML —— 必须都返回 `no-routes` | 本机 ✅ |
| Java 能编译、清单能合并 | `gradlew assembleDebug` | 本机 ✅ |
| `.so` 真的打进包 | 解包 APK 断言 `lib/arm64-v8a/` 下两个 `.so` 都在、字节数与构建产物一致 | 本机 ✅ |
| 清单正确 | 解包 APK 用 `aapt2 dump xmltree` 断言：service + `BIND_VPN_SERVICE` + `foregroundServiceType="specialUse"` + 四条权限 | 本机 ✅ |
| 原生库自洽 | `.cache/scan-so.mjs` 解析 `DT_NEEDED` 含 `libeasytier_ffi.so`、导出符号是 `Java_com_easytier_jni_EasyTierJNI_*` | 本机 ✅ |
| JS↔原生接线 | 浏览器里注入**假插件**，断言 `core.start` 的入参、事件映射、插件缺失时的诚实降级 | 本机 ✅ |
| **隧道真的通** | 真机：装 APK → 授权 VPN → ping 房主虚拟 IP → 游戏里连上 | **用户**（本机没有设备） |

### 5.1 用户真机自测清单

装 APK 前先确认它是 arm64 的机器（现在几乎所有手机都是）。步骤与**预期现象**：

1. **装包**：`mclink-android-*-debug.apk`。Android 会要求"允许安装未知来源的应用"（debug 签名，正常）。
2. **登录 + 建房/加入**：随便用一个加入码**加入一个有 Windows 房主的房间**（手机做房主见 §6，能连但不建议）。
3. **第一次点"连接"**：应该弹**系统 VPN 授权对话框**（标题类似"连接请求"，显示 McLink）。
   - 点"允许" → 通知栏出现常驻通知「McLink 联机 · 已联机 · mclink-xxxx」
   - 点"拒绝" → 房间页应显示"没有授予 VPN 权限：加入虚拟局域网需要它"，**不应该反复弹**
4. **看状态**：房间页应显示"已联机"，`连接诊断` 里能看到虚拟地址。
5. **连通性**（这一步是关键，也是只有真机能做的）：
   - 手机浏览器访问 `http://10.200.<slot>.1:<房主MC端口>` 之类不方便的话，
     最直接的验证是**在手机上的 MC 启动器（FCL / PojavLauncher）里「添加服务器」**，
     地址填房间页显示的**联机地址 + 房主在 MC 里看到的端口**（MC 开局域网时聊天栏会打印 `Local game hosted on port xxxxx`）。
   - 同时**整机不能断网**：授权 VPN 后立刻试一下刷网页/微信 —— 如果手机没网了，说明路由算错了，
     这是**最高优先级的 bug**，请立刻反馈（现象 + `adb logcat` 里 McLink 的行）。
6. **断开**：通知上的「断开」按钮，或房间页退出房间 → 通知消失、隧道关闭。
7. **常见异常**（都设计过，看到这些是预期行为不是崩溃）：
   - "另一个 VPN 应用占用了本机" → 先断开那个 VPN
   - "联机参数已丢失，请回到房间页重新连接" → 服务被系统杀掉后重启但落盘参数没了
   - 息屏一段时间后掉线 → 厂商省电策略（§6 已记账，本轮不做白名单引导）

**反馈时请带上**：`adb logcat -s MclinkVpnService:V EasyTier-JNI:V AndroidRuntime:E` 的输出，
以及房间页的截图（哪一步、什么现象）。

---

## 6. 已知不做 / 明确不支持（诚实边界）

| 项 | 为什么 |
| --- | --- |
| ~~手机做房主时的 **ACL**（踢人）~~ **已实现**（见 §3 的 `applyAcl`） | 原判断"Android JNI 侧没有施加 ACL 的路径"**只对了一半**：JNI 里确实没有 ACL 方法，但桌面端在 2.6.4 上也没有热更新（`acl set` 子命令不存在），走的是"合并进配置 → 重启内核实例"这条回退路径 —— 而这条路径在 Android 上完全可以用 `stopAllInstances` + `runNetworkInstance` + 重新 `setTunFd` 复现。代价是**施加时房主自己断线约 2 秒**（两端一样） |
| 连接诊断面板的节点列表 | 需要 `callJsonRpc` 拉 peer 列表，本轮不做（桌面端有，够排查） |
| IPv6 | 票据里 `enable_ipv6 = false`，只加 v4 路由。**v6 流量不走隧道**（直连出去），这点要在 UI 上如实说明 |
| 电池优化白名单引导 | 部分国产 ROM 会在息屏后冻结进程；本轮只在文档写，不做引导 UI |
| 订阅制/Play 上架相关申报 | 我们走官网分发（`/downloads` 已支持 `.apk`），不涉及 |
