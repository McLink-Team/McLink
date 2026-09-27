# mclink 架构

mclink 是一个基于 [EasyTier](https://github.com/EasyTier/EasyTier) 的局域网联机平台，支持《我的世界》等各类局域网联机游戏：
**主控（Master）** 负责账号、房间编排与子节点调度；**子节点（区域中继）** 提供各区域的
公共中继；玩家用 **Windows 客户端** 建房/进房，客户端在本地托管一个 `easytier-core`，
把所有人的 Minecraft 连接拉进同一个虚拟网络。

本文只描述**当前代码真实实现的行为**，并逐条标注证据来源（文件 + 行号）。
安全模型与已知边界见 `security.md`，运维见 `deployment.md`。

---

## 1. 组件图

```
                      ┌───────────────────────────────────────────────┐
                      │                主控 Master                    │
                      │   node server/src/index.ts    (端口 8787)     │
                      │                                               │
   浏览器 / 管理台 ───►│  ┌─────────┐  ┌──────────┐  ┌─────────────┐   │
   HTTP + WebSocket    │  │ REST API│  │  WS Hub  │  │ 静态托管     │   │
   /api/v1/*, /ws      │  │api/*.ts │  │ws/hub.ts │  │server/public│   │
                      │  └────┬────┘  └────┬─────┘  └─────────────┘   │
                      │       │            │                          │
                      │  ┌────▼────────────▼─────┐  ┌──────────────┐  │
                      │  │ 服务层 services/*.ts  │  │ node:sqlite  │  │
                      │  │ auth/rooms/nodes/     │◄─┤ data/        │  │
                      │  │ settings              │  │ mclink.sqlite│  │
                      │  └────┬──────────────────┘  └──────────────┘  │
                      │       │ spawn / easytier-cli (RPC 127.0.0.1:15888)
                      │  ┌────▼──────────────────────────────┐        │
                      │  │ RelayManager easytier/manager.ts  │        │
                      │  └────┬──────────────────────────────┘        │
                      └───────┼───────────────────────────────────────┘
                              │ 一个 easytier-core 实例
                              │ 监听 0.0.0.0:11010 (TCP+UDP)
                              │ network_name = mclink-master
                              │ relay_network_whitelist = "mclink-room-*"
                              │
        ┌─────────────────────┴──────────────────────┐
        │           共享中继（单端口承载多房间）        │
        └───┬──────────────┬──────────────┬──────────┘
            │              │              │
   ┌────────▼───────┐ ┌────▼───────────┐  │   ┌──────────────────────────┐
   │ 子节点 cn-east │ │ 子节点 hk      │  │   │  子节点 agent (agent.mjs) │
   │ easytier-core  │ │ easytier-core  │  └──►│  注册 + 心跳 + 守护核心   │
   │ :11010 TCP+UDP │ │ :11010 TCP+UDP │      │  POST /api/v1/agent/*     │
   └────────┬───────┘ └────┬───────────┘      └──────────────────────────┘
            │              │
            └──────┬───────┘
                   │  客户端各自拉起 easytier-core，加入自己的房间网络
        ┌──────────┴───────────┬────────────────────┐
        │                      │                    │
   ┌────▼─────┐          ┌─────▼────┐         ┌─────▼────┐
   │ 房主客户端│          │ 成员客户端│         │ 成员客户端│
   │ 10.200.7.1│         │10.200.7.2│         │10.200.7.3│
   │ 持 ACL    │          │ 无 ACL   │         │ 无 ACL   │
   └──────────┘          └──────────┘         └──────────┘
        └────────── 同一个 EasyTier 网络（network_name 由房间密钥派生）──────────┘
```

关键点：**房间不是服务端的一种「连接」，而是 EasyTier 的一个独立网络**。主控从不加入房间网络，
它只做三件事：下发票据、维护成员/策略、通过 CLI 采样中继流量。

---

## 2. 单端口多房间隔离：原理与边界

### 2.1 为什么一个端口能承载所有房间

主控只跑**一个** `easytier-core` 实例（`server/src/easytier/manager.ts`），配置里：

```toml
instance_name = "mclink-relay"
listeners     = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010"]
network_name  = "mclink-master"

[flags]
no_tun = true
relay_network_whitelist = "mclink-room-*"
bind_device = false
```

EasyTier 的中继判定只做一件事：**把外来连接声明的网络名拿去和 `relay_network_whitelist`
做 wildmatch 匹配**，命中就为该网络转发。实测源码（`easytier-core/src/peers/whitelist.rs`）：

```rust
pub(crate) fn check_network_in_relay_whitelist(relay_network_whitelist: &str, network_name: &str)
    -> Result<(), anyhow::Error> {
    if relay_network_whitelist.split(' ')
        .map(wildmatch::WildMatch::new)
        .any(|whitelist| whitelist.matches(network_name)) { Ok(()) }
    else { Err(anyhow::anyhow!("network {} not in whitelist", network_name)) }
}
```

于是：

* **通配一次，永久生效**：`mclink-room-*` 覆盖所有房间，新建/关闭房间都不用碰中继进程，
  也不用改配置或重启（`manager.ts` 顶部注释即为此设计）。
* **每个房间 = 一个独立 EasyTier 网络**：网络名与密钥都由主控在创建房间时随机生成
  （`services/rooms.ts` 的 `create()`），因此房间之间既互相发现不了、也无法互访。
* **虚拟地址天然不冲突**：每个房间独占 `10.200.<slot>.0/24`（见第 5 节）。

### 2.2 网络名就是准入凭证（这是本架构最重要的一条事实）

EasyTier 的 `network_secret` **默认不校验**。实测
`easytier-core/src/peers/peer_manager.rs`：

```rust
let foreign_network_allowed = conn.matches_local_network_secret() || trusted_foreign_credential;

if !is_local_network && self.context.flags().private_mode && !foreign_network_allowed {
    return Err(Error::SecretKeyError("private mode is turned on, foreign network secret mismatch"));
}
// ...
} else {
    self.foreign_network_manager.add_peer_conn(conn).await   // private_mode 关闭时直达这里
}
```

也就是说：只有当 `private_mode = true` 时，密钥不符的外来网络才会被拒绝。
而共享中继**不能**开 `private_mode`——中继自己的密钥和任何房间都不同，
一旦打开就会把所有房间一起拒之门外（`services/rooms.ts` 里 `deriveNetworkName()` 的注释记录了
这个踩坑结论）。

**结论：在「单端口共享中继」架构下，网络名是唯一的准入门。** 因此平台把网络名设计为
**由房间密钥派生的 128 bit 不可猜测令牌**（`services/rooms.ts`）：

```ts
export function deriveNetworkName(secret: string): string {
  const digest = createHash('sha256').update(`mclink-net-v1:${secret}`).digest('hex');
  return `mclink-room-${digest.slice(0, 32)}`;   // 32 个 hex 字符 = 128 bit
}
```

由此得到两个重要性质：

1. **不知道网络名的客户端，连中继都不会被转发**——它的握手会收到
   `network ... not in whitelist`，连房间的 peer 网表都进不去。
2. **轮换密钥 = 同时换掉网络名**（`rotateSecret()` 同时更新 `network_name` 与 `network_secret`），
   旧票据、被踢成员手里的名字立刻失效。这比单纯改密码更彻底，且加入码与成员列表保持不变，
   对正常玩家无感。

至于 6 位房间加入码（`generateRoomCode()`，形如 `K7QM2P`）：它**只走主控 HTTP API**
（`POST /api/v1/rooms/join`，需要登录，且受成员/审批/密码校验），
**不参与 EasyTier 网络名**。因此「拿到加入码」不等于「能进虚拟网络」——还得通过主控换票据。

### 2.3 已实测确认的边界（必须当成限制来读）

| 边界 | 说明 | 平台侧仍然有效的控制 |
| --- | --- | --- |
| **已知网络名 + 错误密钥仍会被接入** | EasyTier v2.6.4 在 `private_mode=false` 时不做密钥校验，攻击者只要拿到网络名就会被接入房间的 peer 网表（能看到成员虚拟 IP，路径显示为 `relay(N)`） | ① 主控准入仍有效：票据只在通过成员校验（`ticket()` 会检查成员状态）后才签发；② **轮换密钥可立即移除**（网络名同时变化，旧名字不再被中继转发）；③ 踢人会把该成员虚拟 IP 写进房主实例的 Drop ACL |
| **`instance_recv_bps_limit` 是客户端自制裁剪** | 恶意客户端可以不遵守自己实例的接收限速 | 服务端侧的硬限制只有中继的 `foreign_relay_bps_limit`（平台级，可选配） |
| **ACL 是每个实例自己的** | EasyTier 不会在虚拟网络里同步 ACL | 踢人/限速由主控生成 ACL，推给**房主客户端**在其本地实例应用 |
| **需要更强成员认证时** | 应改用 EasyTier 的 secure mode + credential（`--secure-mode` / `--credential`），并把凭证下发到票据里 | 当前版本**未**实现该模式 |

> 上述源码结论来自仓库内 EasyTier 源码快照（`.cache/src/EasyTier-main`）与发行版
> `easytier-cli 2.6.4-8428a89d` 的实测。**升级 EasyTier 版本后必须重新验证**这三点：
> 中继白名单匹配方式、`private_mode` 的密钥校验语义、ACL 限速单位。

---

## 3. 房主 / 成员体系

| 概念 | 落地方式 |
| --- | --- |
| 房主 | `rooms.host_user_id`；在虚拟网段里固定占 `10.200.<slot>.1`（seat 0） |
| 成员 | `room_members` 表，`seat` 从 1 起（`.2`、`.3`…），状态 `pending`/`active`/`kicked`/`left` |
| 准入模式 | `access`: `open`（凭加入码直接进）/ `password`（房间密码）/ `approval`（房主审批） |
| 可见性 | `visibility`: `public`（大厅可见）/ `hidden`（仅凭加入码） |
| 房间策略 | `RoomPolicy`：`maxPlayers`、`perMemberKbps`、`maxBandwidthKbps`、`rateLimitPps`、`allowP2p`、`allowedPorts`、`strictPorts`、`motd` |
| ACL 版本 | `rooms.acl_revision` 单调递增；房主客户端靠它判断「要不要重新应用 ACL」 |

生命周期与关键动作（都在 `server/src/services/rooms.ts`）：

* **创建**（`create()`）：分配虚拟网段 slot → 生成 `network_secret` → 派生 `network_name` →
  调度中继节点 → 写库 → 房主入座 `.1` → 立即签发房主票据。
* **加入**（`join()`）：校验加入码/密码/人数 → 分配 seat → 生成成员虚拟 IP →
  `approval` 模式先给 `pending`（**并且不发票据**，避免提前拿到网络密钥）→ 审批通过后才给票据。
* **审批**（`approve()`）：pending → active 并 `bumpAcl()`。
* **踢人**（`kick()`）：成员标记 `kicked` → `bumpAcl()` → 返回新 ACL 给房主 →
  房主客户端在本地实例上应用一条 `Drop` 该成员虚拟 IP 的规则。
* **轮换密钥**（`rotateSecret()`）：新 secret + 新 network_name + `acl_revision++`。
* **关闭/过期/空房回收**：`close()` / `findExpired()` / `findIdle()`（默认 600 秒无人心跳即回收，
  `MCLINK_ROOM_IDLE_TIMEOUT`）。
  `expires_at` 是**滑动窗口**而不是硬期限：房间里只要有人心跳（客户端 10 秒一次），
  就会按该房间自己的 `ttl_minutes` 把到期时间往后推（写库有节流，见 `nextRoomExpiry()`），
  所以「存活时长」的真实语义是**无人活跃多久之后过期** —— 正在联机的房间不会被解散。
  存量数据由 V14 回填 `ttl_minutes`；`ttl_minutes` 为 null 或 0 的房间不自动过期。

### 踢人生效的真实链路（容易误解）

协议里定义了 `room.kicked` / `room.acl` 广播事件，但**当前服务端并不发布它们**
（`ws/hub.ts` 的 `sendToUser()` / `disconnectUser()` 目前没有被任何代码调用）。
踢人真正生效的链路是**客户端主动轮询**：

```
房主：POST /api/v1/rooms/:id/kick   → 返回 { aclToml, revision }
客户端心跳（每若干秒）：POST /api/v1/rooms/:id/heartbeat
  ├─ 被踢者：返回 { kicked: true } → 客户端停止本地 easytier-core 并退出房间
  └─ 房主：返回 { aclToml, aclRevision } → ACL 版本变化时 applyAcl() 热应用或重启实例
```

因此**踢人不是瞬时的**：取决于客户端心跳间隔与 ACL 应用耗时（不支持 `acl set` 时会重启实例，
房主短暂断线约 2 秒）。详见 `troubleshooting.md` 的「房主踢人后对方仍能连」。

---

## 4. 票据（RoomTicket）如何驱动客户端拉起 easytier-core

`GET /api/v1/rooms/:id/ticket`（房主创建/加入房间时也会在内层调用 `ticket()`）返回
`RoomTicket`（定义见 `packages/shared/src/types.ts`），核心字段：

| 字段 | 作用 |
| --- | --- |
| `networkName` / `networkSecret` | EasyTier 网络身份（`[network_identity]`） |
| `virtualIp` | 本机地址，带前缀，如 `10.200.7.3/24` |
| `hostVirtualIp` | **房主地址**，玩家在 Minecraft「直接连接」里填的就是它 |
| `relays[]` | 中继入口列表（`tcp://` 与 `udp://` 成对），全部来自子节点调度结果（主中继 + 兜底中继） |
| `configToml` | 服务端生成好的完整 TOML，客户端直接落盘 |
| `launchArgs` | easytier-core 的完整命令行，其中配置文件路径是占位符 **`%CONFIG%`** |
| `aclToml` / `aclRevision` | **仅房主**非空；成员为 `null` |
| `mtu` | 固定 1380 |
| `issuedAt` / `expiresAt` | 票据短时效（24 小时），成员退出/被踢后立即失效 |

客户端流程：

1. 调 `GET .../ticket?listenPort=<本地监听端口>`。
2. 把 `configToml` 写到本地文件（客户端日志目录下的 `relay.toml`）。
3. 把 `launchArgs` 里的 `%CONFIG%` 换成该文件的绝对路径，然后 spawn `easytier-core`。
4. 房主额外把自己实例上的 ACL 应用上去（`acl set`，不支持则写回配置并重启实例）。

**为什么启动参数要由服务端下发**：`rpc_portal` / `rpc_portal_whitelist` **不是 TOML 配置字段**，
只能走命令行 `-r` / `--rpc-portal-whitelist`。如果让每个客户端自己写，同一台机器上多个实例会
全部退回默认的 15888 互相抢占。服务端统一计算 RPC 端口（见下节）后写进 `launchArgs`，
从根上避免冲突。

生成票据时的几个实现细节（`services/rooms.ts` 的 `ticket()`）：

* `listeners` 是 `tcp://0.0.0.0:<listenPort>` + `udp://0.0.0.0:<listenPort>`（客户端之间可直连/打洞）。
* `enable_udp_broadcast_relay = room.policy.allowBroadcast`（**默认 false**）：
  打开后 Minecraft 的局域网广播会跨虚拟网络，玩家在「多人游戏」列表里能直接看到房间。
  之所以默认关闭：Windows 上它靠 **WinDivert 内核网络过滤驱动**抓物理网卡的 UDP 广播，
  等于在每台玩家机器上装一个系统级网络驱动，实测会与部分软件的网络栈冲突
  （见 `troubleshooting.md` §16）。EasyTier 官方默认同样是关的。
* `disable_p2p = !room.policy.allowP2p`：关闭 P2P 后所有流量走中继（可控但更耗带宽）。
* `perMemberKbps > 0` 时写入 `instance_recv_bps_limit`（客户端自制限速）。
* **`bind_device = false`**：三处（主控中继、子节点、票据 TOML）统一关闭。这是踩坑结论——
  默认 `true` 时部分环境会报 `WSAEADDRNOTAVAIL(10049)`，表现为「能登录但进不了房间」。
* 房主票据里带 `acl`，成员票据不带（避免把房间策略泄露给成员）。
* **票据里只有子节点中继**（2026-09-27 起）：`relays[]` 完全等于建房时写进 `room.relayNodeIds`
  的调度结果，自动模式下是 2 个不同节点（主中继 + 兜底中继）。主控自身中继**不再兜底** ——
  `masterRelayEndpoint()` / `masterRelayAvailable()` 仍然保留，但只服务于单机自查与
  「将来把主控注册成一台普通子节点」，不再被追加进票据；一个可调度子节点都没有时建房直接报 503
  （规则与排序键见 §6）。

### 客户端侧的「回落中继」（P2P 质量差时绕开直连）

打洞成功不等于链路可用：P2P 直连走的是两个玩家各自的家宽，中间任何一跳拥塞都表现为**丢包**，
延迟看着正常但游戏里人物回弹。EasyTier 自己一直在算这个数（`loss_rate`，最近 100 次探测的
滑动窗口），`peer list` 里就有这一列 —— 客户端只读它，不自己造探测。

两条路径，**默认都不动作**：

| 路径 | 触发 | 落地 | 代码 |
| --- | --- | --- | --- |
| 手动「强制走中继」 | 玩家在房间页点开关（走应用内确认） | 往票据 TOML 注入 `disable_p2p = true` → 重启本地核心 | `client/src/lib/store.ts` `setForceRelay()` |
| 自动回落（设置项，**默认关**） | 连续 3 个 12 秒窗口里**所有**测得丢包的直连节点都 >5% | 同上，且之后做 A/B 对照与指数退避重试 | `client/src/lib/store.ts` `guardTick()` |

几个刻意的取舍（阈值都给在 `client/src/lib/relay-fallback.ts` 里并写了理由）：

* **注入而不是改票据**：`configToml` 永远是主控下发的原件，`disable_p2p` 只在启动那一刻按开关
  单向注入。关闭 = 用原件（`disable_p2p` 回到主控写的 `false`），**从不做删行** ——
  删行会把房主设的 `disable_p2p = true`（房间规则里关了 P2P）一起删掉，等于本机开关绕过房间规则。
* **触发要求「所有直连都超标」**：`disable_p2p` 是本实例全局开关，一个三人房间里为一个丢包的人
  绕中继会把另外两条好链路一起拖慢。单个人劣化交给玩家手动开关。
* **A/B 对照**：切过去 20 秒后，按**同一个虚拟地址**前后对比（不横向比不同城市的节点）；
  中继自己也在丢（≥2%）或延迟明显绕远（>1.6 倍且差 ≥30ms）就切回直连并冷却 30 分钟。
* **重试退避**：降级后每 15 分钟放一次 P2P 重试（每次要重启核心、断约 3 秒），连续失败翻倍到 1 小时封顶。
* 房主在房间规则里关掉「允许 P2P 直连」时，玩家侧那个开关是**只读**的（全房间已走中继，他改不了）。

回落到中继会让流量走中继，代价是**中转带宽**与**可能更高的延迟** —— 这也是它必须是玩家可选、
并且带 A/B 回退的原因。

### RPC 端口推导规则（服务端与 agent 必须一致）

```ts
// server/src/easytier/config.ts
export function rpcPortalForListenPort(listenPort: number): number {
  return 16000 + (Math.abs(listenPort) % 1000);
}
```

* 主控中继自己用固定值 `MCLINK_RELAY_RPC`（默认 `127.0.0.1:15888`）。
* 子节点/客户端用 `16000 + (监听端口 % 1000)`：监听 11010 → `16010`。
* `deploy/agent.mjs` 实现同一规则（`rpcPortalForListenPort()`），并优先采用
  `launchArgs` 里的 `-r` 值以保证与服务端一致。
* **注意**：该规则是「端口对 1000 取模」，所以 `11010` 与 `12010` 会撞同一个 RPC 端口。
  同一台机器上只会跑一个 mclink 实例，因此当前没有实际问题；若要在一台机器上跑多个实例，
  需要显式指定不同的 `-r`。

---

## 5. 虚拟地址规划

实现在 `packages/shared/src/virtualnet.ts`：

```
房间网段 = 10.200.<slot>.0/24      slot ∈ [0, 255]，共 256 个
房主     = 10.200.<slot>.1         seat 0
成员     = 10.200.<slot>.2 起        seat 1..253 → .2 .. .254（共 253 个地址）
```

* `allocateSlot()`：从当前**未关闭**房间占用的 slot 中取最小可用值（信号量语义）；
  房间关闭后 slot 可再次使用（`rooms.usedSlots()`）。
* `allocateSeat()`：跳过 0（房主），取最小可用成员座位；同一用户重复加入复用原 seat。
* slot 耗尽时创建房间返回 `503 service_unavailable`「虚拟网段已耗尽，请联系管理员扩容」。
* 主控中继自身的 ACL 守卫规则明确禁止 `10.200.0.0/16 → 10.126.0.0/16` 的流量
  （`manager.ts` 的 `#buildRelayAcl()`），即房间网段不得访问主控管理网。

**为什么按 slot 分 /24 而不是按房间随机分配**：所有房间共用同一个中继端口，
如果 IP 平面重叠，中继侧的连接跟踪与 ACL 就会互相干扰；固定 `10.200.<slot>.0/24`
让「一个房间一个 /24」成为结构不变式，也便于 ACL 与排障时一眼看出房间。

MTU 固定 **1380**（`ticket().mtu`，写入票据 `mtu` 字段），为 EasyTier 隧道头留出余量，
避免中文路径/大包场景的分片问题。

---

## 6. 子节点调度策略

实现在 `services/rooms.ts`：先用硬条件筛出候选池，再交给 `scheduleRelays(zone, latencyHints, max = 2)`
里的纯函数 `selectRelays(candidates, hints, max)` 排序（有单测：`test/unit.test.ts` 的
「权重优先调度」一组；回归脚本 `scripts/check-latency-priority.mjs`）。

**中继调度（2026-09-27 起）**：

```
· 排序：硬过滤 → 权重 desc → 延迟 asc（5ms 区间极差算同一档）→ 档内比空余带宽 desc → relayScore → 连接数
· 每房 2 个不同节点：主中继 + 兜底中继（同一套规则、不重复）
· 主控不再自动兜底；要让它参与就注册成普通子节点
· 硬过滤（离线/停用/权重 0/无余量）永远不会被延迟提示绕过
```

**硬条件（提示与权重一条都不放松）**：

* 候选集由 `nodes.listSchedulable()` 给出：`status in ('online','degraded')` **且** `disabled = 0`
  **且** `weight > 0`。
* 带宽利用率 ≥ 90%（`UTIL_SHED`）的节点**这一轮不再接新房间**；只有所有候选都吃紧时才回退全量并打 `warn`
  （宁可挤一点，也别把房间挤没了）。
* `zone` 是硬筛选：只用该区域的节点；**该区域无可用节点时回退到全局**并打 `warn` 日志，
  避免玩家因为某个区域没部署节点而完全无法联机。
* 人数满员（`peers ≥ capacity_peers`）或带宽吃紧（利用率 ≥ 90%）的节点：仍然留在候选池里兜底，
  但它们**既不参与延迟比较、也不能靠 weight 抢到队首** —— 排序的"键 0"就是"真有余量"。
  `weight` 只决定"同样能用时先选谁"，决定不了"一台接不了新房间的节点能不能先上"。

**排序规则（权重优先，权重一致时才比延迟）**：

```ts
// 打分（relayScore，改造前就有）：weight × min(人数余量, 带宽余量) − degraded 罚分
// 排序键（依次比较，前一条能分出胜负就不看后面）：
//   键 0  真有余量（peers < capacity_peers 且利用率 < 90%）的排前面 —— 硬条件的延伸
//   ① weight 降序 —— 主键（运营方的意愿：专线/贵节点调高、顶不住的调低）
//   ② 权重相同才比延迟：有提示且真有余量的按 ms 升序；没提示的排在后面（延迟未知，不优待）
//   ③ 延迟落在并列带内（区间极差 ≤ LATENCY_TIE_BAND_MS = 5ms）→ 先比空余带宽 1 − utilization 降序
//   ④ 仍相同 → relayScore 降序（此时权重已相等，实际比的是"哪台更空、有没有降级"）
//   ⑤ 仍相同 → peers 升序（改造前就有的收尾判据，保证结果稳定）
// 只有「键 0 与权重都相同」的连续区间内才做并列带：区间 max−min ≤ 5ms 视为同一档
// （两两比较不满足传递性，0/4/8 必须让 8 单独成档，所以用"极差"而不是"相邻两两之差"）
// → 档内先比空余带宽、再交回 relayScore 决胜，档间仍按延迟升序。
```

* **为什么权重是主键**：`weight` 是运营方写进控制台的**意图**，必须能压过"几毫秒的体感差异"，
  否则权重形同虚设；延迟只用来在**同一档位**里挑更近的那台 —— 这正是"权重一致时比延迟"的含义。
  反过来的"延迟优先"会让一台运营方并不想用的节点仅凭几毫秒优势抢走流量。
* `latencyHints` 是建房请求（`POST /rooms`）里的**可选**字段（`RelayLatencyHint`）：
  客户端对中继**链接端口**做 tcping（3 次取最快）后按 nodeId 上报。主控自己不下场测延迟，
  所以这是它唯一的延迟来源。
* 并列带取 5ms（2026-09-27 由 20ms 收紧，语义是**区间极差**）**且只在权重相同时生效**：
  客户端测得的抖动有 ±5–15ms（公网路由/家宽调度），同权重的一对节点里"3ms 的优势"不该盖过
  "一台快满、一台很空" —— 所以档内**先比空余带宽 `1 − utilization`**（挑最空的），
  再交回 `relayScore`；跨权重时一律权重说了算，带子不参与（高权重节点慢 90ms 也照样赢）。
* **不传这个字段（老客户端）＝ 权重优先 → 同权重按 relayScore。
  ⚠️ 注意这不再等于改造前的"纯 relayScore"排序**：以前 weight 只是打分里的一个因子，
  "权重更低但更空的节点"可以赢（例：权重 90、几乎全空，打分 89.1，胜过权重 100、已用 400/500 人的 20 分）；
  现在权重是第一判据，那台高权重节点赢。这是用户明确要的语义（权重说了算），不是副作用 ——
  权重相同时新旧行为逐位一致。
  提示里的 nodeId 不在候选池里（被停用、权重 0、离线、别区域）时该条提示自然无效。
* 提示是**建房那一刻**测的值，之后会过时（路由变化、节点换线）；这里**刻意不做**过期逻辑 ——
  过期与否都只影响"先挑谁"，而真正失效的节点由 status/心跳/容量这些硬条件挡住。
* **刻意不做防伪**（用户拍板的取舍）：提示只能决定"选谁"、决定不了"能不能选"，
  谎报最坏就是让自己的房间落到一台更差的节点上；而平台本来就提供自选节点（`nodeIds`），
  真想挑哪台直接指定即可，谎报没有额外收益 —— 加签名/回执/二次探测只会增加复杂度与失败面。
* `create()` 真正写进房间的是「手选节点 + **兜底**」，自动模式下就是 `scheduleRelays(zone, hints, 2)`
  的前两名：1 主中继 + 1 兜底中继，两个**不同**节点。兜底不是"另一套降级规则"，而是同一套规则
  下的第二名；手动模式仍是手选优先，兜底取调度结果里第一个没被手选的。
* 建房的硬守卫：**一个可调度子节点都没有就报错**（`503`「当前没有可用的中继节点，暂时无法建房，
  请稍后再试或联系客服」）。主控自身中继（`masterRelayAvailable()`）**不再**参与判定 ——
  宁可不给建房，也不下发一个连不上的入口。
* 节点状态机（`services/nodes.ts` 的 `heartbeat()`）：
  `pending --首次心跳--> online --peers > 90% 容量--> degraded --peers < 80%--> online`；
  90 秒（`MCLINK_NODE_OFFLINE_TIMEOUT`）没心跳 → `offline`（由 15 秒一次的 `healthCheck()` 标记）。
* 管理员可 `PATCH /admin/nodes/:id` 调 `weight`/`capacityPeers`/`region`，
  或 `POST /admin/nodes/:id/disable` 停用（禁用后 agent 的心跳会收到 `disabled: true`，
  agent 会主动停掉 easytier-core）。

**子节点的网络身份（容易误解）**：子节点自身实例的 `network_name` 是
`<MCLINK_RELAY_NETWORK>-node`（默认 `mclink-master-node`），与主控管理网 `mclink-master`
**不同名**，因此它并不与主控形成同一个网络平面；它对外提供中继靠的是 `relay_network_whitelist`。
子节点与主控之间的「在线」关系完全由 **HTTP 心跳**维持，不依赖 EasyTier 网络。

---

## 7. 流量统计与限速：每条控制落到哪里

### 7.1 统计的数据流

```
easytier-cli -p <rpc> -o json peer list                  → 全量 peer（含 rx/tx 累计字节）
easytier-cli -p <rpc> -o json peer list-foreign          → 按网络名分组的房间 peer
                              │
                        RelayManager.sample()            （每 5 秒轮询一次，manager.ts）
                              │  差分算 bit/s（×8 / dt）
                              ▼
   ┌───────────────────────────────────────────────┐
   │ app.relay.on('sample')  server/src/index.ts    │
   │  ├─ traffic.record(scope='relay', master)      │
   │  ├─ traffic.record(scope='room', roomId, ...)  │  ← 按 network_name 映射回房间
   │  ├─ rooms.incrementUsage(roomId, rx, tx, peers)│  ← 房间用量账本（累计字节）
   │  └─ hub.publish('platform'|'traffic', ...)      │  ← 每 6 秒推一次，避免刷爆浏览器
   └───────────────────────────────────────────────┘

子节点侧（agent.mjs，每 20 秒）：
   easytier-cli peer list-foreign → 按网络名聚合 → POST /api/v1/agent/heartbeat 的 roomTraffic
   → api/agent.ts 把每条按 network_name 反查房间 → traffic.record + rooms.incrementUsage
```

* 字段单位：`rxBps` / `txBps` 一律是 **bit/s**；`rxBytes` / `txBytes` 是**累计字节**
  （不是增量），服务端用 `incrementUsage()` 累加。
* `easytier-cli` 的 JSON 是「展示用表格」序列化，数值字段是人类可读字符串（`"17.33 kB"`、`"-"`），
  所以两边都实现了同一个 `parseHumanNumber()`（`server/src/easytier/manager.ts` 与
  `deploy/agent.mjs`），支持十进制与二进制单位。
* 保留策略：`traffic.prune(72)` 只保留 72 小时样本（每小时执行一次）。
* 查询入口：`/api/v1/stats`（公开概览）、`/api/v1/admin/traffic`（含房间/节点曲线）、
  `/api/v1/admin/overview`。

### 7.2 限速到底写在哪（单位与写法都是踩坑重点）

| 参数 | 真实单位 | 生效位置 | 平台如何下发 |
| --- | --- | --- | --- |
| `rate_limit`（ACL 规则） | **包/秒（pps）**，**不是带宽** | 房主实例的 ACL，`Inbound` 链 | `RoomPolicy.rateLimitPps` → `buildRoomAcl()` |
| `burst_limit` | 包 | 同上 | `max(pps*2, pps+1)` |
| `foreign_relay_bps_limit` | **字节/秒** | **中继**转发外来网络的出口（平台级硬限制） | `MCLINK_RELAY_BPS_LIMIT`（已是字节/秒）/ 平台设置 `relayBandwidthKbps` 经换算 |
| `instance_recv_bps_limit` | **字节/秒** | 本实例**接收**方向（客户端自制） | 票据 TOML：`kbpsToBytesPerSecond(perMemberKbps 或 房主的 maxBandwidthKbps)` |

#### 两个必须记住的写法/单位结论（都是实测得出，不是推断）

**① TOML 里必须写裸数字，不能加引号。**

```
instance_recv_bps_limit = 125000     # ✅ 通过
instance_recv_bps_limit = "125000"   # ❌ easytier-core 直接 panic：
                                     #    invalid type: string "125000", expected u64
```

`easytier-core --check-config` 的实测结果。曾经以为要加引号——依据是
`toml.rs` 里 `flags_diff_from_default` 宏把 u64 序列化成 JSON 字符串，
但那是 **JSON config-patch** 路径的表示法，与 TOML 无关。
这个错误会让**任何设了带宽上限的房间**在客户端启动时崩溃，
现在由两条防线守住：`server/test/unit.test.ts` 的回归断言，
以及两个实验脚本在启动实例前调用 `easytier-core --check-config` 判卷。

**② 单位是字节/秒，不是比特/秒。**

字段名里的 `bps` 容易误读。依据是 EasyTier 自己的测试
（`easytier/src/tests/three_node.rs` 的 `instance_recv_bps_limit_test`）：
配置写 `bps_limit * 1024`，随后把实测吞吐换算成 KiB/s 与 `bps_limit` 比较，
即「配置 1024 → 每秒 1024 字节」。

平台对外仍用玩家熟悉的 **kbps**，换算集中在 `kbpsToBytesPerSecond()`
（`packages/shared/src/format.ts`）。按比特/秒实现会让玩家实际拿到
**8 倍**于界面所配的带宽——这个偏差是靠真实数据面测速才发现的，
见下方 §7.3。

`RoomPolicy.maxBandwidthKbps`（房间总带宽）**已落地**：房主实例接收所有成员的流量，
所以它对应房主实例的 `instance_recv_bps_limit`；成员实例则用 `perMemberKbps`。
两者都设时取较小值。

### 7.3 限速的实测结果（`pnpm lab:dataplane`）

用 EasyTier 自带的端口转发在虚拟网络内部跑真实 TCP（不依赖系统路由表，
因此同机多实例也能得到可信结果）：

| 场景 | 传输量 | 耗时 | 实测吞吐 |
| --- | --- | --- | --- |
| 不限速（基准） | 2 MiB | 11 ms | **1,525,201 kbps**（约 1.5 Gbps） |
| 单成员上限 1000 kbps | 2 MiB | 18,732 ms | **896 kbps** |

换算后的配置值 `125000`（字节/秒）= 1000 kbps ÷ 8，实测 896 kbps 略低于设定值，
与 EasyTier 测试注释一致：限速器统计的是**含内层 IP 与传输头**的数据载荷，
因此应用层有效载荷会略低于配置上限。

---

## 8. 已核实的技术事实（源码 / 实测结论汇总）

以下每条都在本仓库的 EasyTier 源码快照或发行版二进制上核对过，写文档/改代码时不要写错：

1. **中继准入按网络名**：`relay_network_whitelist` 用 wildmatch 匹配 `network_name`，
   空格分隔多模式（`easytier-core/src/peers/whitelist.rs`）。默认 `"*"`。
2. **`network_secret` 只在 `private_mode` 下校验**：`peer_manager.rs` 的
   `foreign_network_allowed = conn.matches_local_network_secret() || trusted_foreign_credential`，
   且仅当 `flags().private_mode` 为真才拒绝外来网络；`private_mode` 默认 `false`
   （`config/toml.rs`）。共享中继场景下**不能**开启它。
3. **`private_mode=false` 时密钥错误也会被接入**：代码直接走
   `foreign_network_manager.add_peer_conn(conn)`，因此「已知网络名 + 错误密钥」能看到
   成员虚拟 IP（路径 `relay(N)`）。平台用票据准入 + 密钥轮换缓解。
4. **ACL 的 `rate_limit` 单位是包/秒**：ACL 规则里是 `rate_limit: u32`
   （`easytier-core/src/peers/acl/processor.rs`），令牌桶按包消费
   （测试注释 `rate_limit: 1, // Allow only 1 packet per second`）。
   想做带宽限速只能用 `foreign_relay_bps_limit` / `instance_recv_bps_limit`。
5. **`rpc_portal` / `rpc_portal_whitelist` 不是 TOML 字段**：
   它们只存在于 `easytier/src/core.rs` 的 clap 参数定义里，`config/toml.rs` 中完全没有。
   写进配置文件会被**静默忽略**，导致所有实例抢默认的 `15888`。
   必须用命令行 `-r` / `--rpc-portal-whitelist`。
6. **`bind_device` 默认 `true`**（`config/toml.rs`），在受限容器/多网卡/Windows 沙箱下会报
   `WSAEADDRNOTAVAIL(10049)`。平台在中继、子节点、客户端票据三处统一设为 `false`。
7. **EasyTier v2.6.4 的 CLI 没有 `acl set`**：`easytier-cli acl --help` 只列出 `stats`。
   因此运行时热替换 ACL 是更新版本的特性。平台做了能力探测
   （`manager.ts` 的 `supportsAclSet()` / 客户端 `main.cjs` 的 `supportsAclSet()`），
   不支持时通过「重载配置 / 重启实例」生效。
8. **`instance_recv_bps_limit` 是客户端自制裁剪**：恶意客户端可以绕过；
   服务端侧唯一硬限制是中继的 `foreign_relay_bps_limit`。
9. **两个 `*_bps_limit` 是 u64，在 TOML 里必须写裸数字**，加引号会让 easytier-core
   在配置解析阶段 panic（`invalid type: string "…", expected u64`）。
   注意 `toml.rs` 的序列化测试里出现的是 `= "18446744073709551614"`，
   那是 **dump / JSON patch** 路径的表示法，与**解析**时接受的格式不同——
   以 `--check-config` 的实测结果为准。
10. **两个 `*_bps_limit` 的单位是字节/秒，不是比特/秒**（依据 `three_node.rs` 的
    `instance_recv_bps_limit_test`：配置 `bps_limit * 1024`，按 KiB/s 校准）。
    平台对外用 kbps，经 `kbpsToBytesPerSecond()` 换算（÷8）。
11. **`peer list` 的 JSON 数值字段是人类可读字符串**（`"17.33 kB"` / `"-"`），
    `peer list-foreign` 返回 `{ "<网络名>": { peers: [ { peer_id, conns: [ { stats: {...} } ] } ] } }`，
    字段为 snake_case，且可能是空对象 `{}`。
12. **`easytier-cli stats prometheus` 存在**（用于对接 Prometheus），
    而 `stats show` 是通用计数器；主控的 `RelayManager.fetchGlobalStats()` 用的是后者。
13. **`--secure-mode` / `--credential` 是更强的成员认证手段**（credential 对等体可被
    `is_existing_credential_pubkey_trusted` 信任），当前平台未使用，是后续可选加固方向。
14. **`easytier-cli port-forward add <tcp|udp> <bind> <dst>` 可用**：转发在 EasyTier
    内部完成，不依赖操作系统路由表。这一点让「同机多实例」也能做可信的数据面测试
    （见 `scripts/lab-dataplane.mjs`）；注意该子命令成功时只打一行人类可读提示、
    不带 JSON，用退出码判成败。
15. **TUN 模式下必须给每个实例不同的 `dev_name`**：否则同机多个实例会去创建
    同名的虚拟网卡而互相冲突，表现为其中一个实例起不来。

---

## 9. 数据与状态落盘

| 路径 | 内容 |
| --- | --- |
| `MCLINK_DATA_DIR`（默认 `server/data`，生产 `/opt/mclink/data`） | 全部运行时数据 |
| `<data>/mclink.sqlite`（+ `-wal` / `-shm`） | SQLite，WAL 模式（用户、房间、成员、节点、会话、流量、审计、设置） |
| `<data>/secrets.json` | 自动生成的 JWT / 中继密钥 / 初始管理员密码兜底（权限 600） |
| `<data>/easytier/relay.toml` | 主控中继实例的生成配置（每次启动/变更重写） |
| `<data>/logs/relay.log` | 主控中继（easytier-core）的 stdout/stderr |
| `<data>/downloads/` | 客户端安装包（`/downloads/<文件名>`，支持 Range 断点续传） |
| `server/public/` | 前端构建产物，由主控进程一并静态托管（`MCLINK_WEB_ROOT` 可覆盖） |
| `/etc/mclink/mclink.env` | 主控环境变量（权限 600） |
| `/etc/mclink/node.env`、`node-token.json`、`relay.toml` | 子节点：环境变量、长期令牌、生成配置 |
| `/var/log/mclink/{agent,easytier-core}.log` | 子节点日志 |

`server/src/app.ts` 的 `resolveWebRoot()` / `resolveDownloadsRoot()` 决定了静态目录的查找顺序，
排查「页面 404」或「下载 404」时先看这两个函数。
