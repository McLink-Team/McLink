# mclink 安全模型与已知边界

本文只写**当前实现的真实安全属性**，包括做不到的部分。所有"限制"都是可核查的：
要么给出源码位置，要么给出可复现的操作。文档不美化、不省略。

> 阅读顺序建议：§2（隔离基础）→ §3（关键事实）→ §4（已实测边界）→ §5（网络名暴露面）→ §9（弱点清单）。

---

## 1. 威胁模型与信任边界

| 角色 | 能力假设 |
| --- | --- |
| 未登录访客 | 能访问所有公开接口（`/meta`、`/regions`、`/stats`、`/downloads`、`/rooms/public`）与 WebSocket |
| 普通玩家（已登录） | 能建房、凭加入码进房、读任意房间的部分元信息（见 §5.3） |
| 房主 | 对本房间有完全控制权：审批、踢人、改策略、轮换密钥、关闭房间 |
| 管理员 | 平台最高权限：节点/房间/用户/设置/审计/中继控制；能读到房间 `networkSecret` |
| 子节点 agent | 持长期节点令牌，能上报自身与逐房间流量（数据会被写入流量账本） |
| 恶意玩家（本平台最关注的对手） | 能修改自己的客户端、伪造 CLI 输出、直接与 EasyTier 中继通信、重放/篡改上报 |

**信任边界**：

* 客户端与主控之间的所有数据（票据、心跳、上报）都**不可信**：主控只把客户端上报的
  `peers`/`rxBps`/`txBps` 当"参考信息"落地，不做准入判断。
* 中继（主控或子节点）**不参与房间准入判断**，它只看网络名（见 §3）。
* EasyTier 虚拟网络内部的隔离由 EasyTier 自己保证（网络身份 + 加密），主控不加入房间网络。
* 主控的 HTTP 面（8787）是唯一的准入决策点：**票据只在通过成员校验后签发**。

---

## 2. 房间隔离的基础：EasyTier 网络身份

一个房间 = 一个独立 EasyTier 网络，身份由两项组成（`packages/shared/src/types.ts` 的
`network_name` / `network_secret`）：

* `network_name`：`mclink-room-<32 个 hex 字符>`
* `network_secret`：32 位随机字符串（URL 安全字符集，`generateNetworkSecret()`）

网络名**不是**随机独立生成的，而是由密钥派生（`server/src/services/rooms.ts`）：

```ts
export function deriveNetworkName(secret: string): string {
  const digest = createHash('sha256').update(`mclink-net-v1:${secret}`).digest('hex');
  return `mclink-room-${digest.slice(0, 32)}`;   // 128 bit
}
```

设计动机（`deriveNetworkName()` 上方注释原文要点）：EasyTier 的公共中继按**网络名**决定是否为
某个外来网络中继，而 `network_secret` 只在开启 `private_mode` 时才被校验；共享中继又不能开
`private_mode`（中继自身密钥与任何房间都不同，开启会把所有房间一起拒绝）。因此在单端口共享中继
架构下，**网络名就是准入凭证**，所以它被设计成由密钥派生的 128 bit 不可猜测令牌。

由此得到的两个性质：

1. **不知道网络名的客户端连中继都不会被转发**——握手会收到
   `network <名字> not in whitelist`（实测源码 `easytier-core/src/peers/whitelist.rs`）。
2. **轮换密钥 = 同时换掉网络名**：`rotateSecret()` 同时更新 `network_name` 与 `network_secret`，
   旧票据与被踢成员手里的名字**立刻失效**（比单纯换密码更彻底）；加入码与成员列表保持不变，
   对正常玩家无感。

6 位房间加入码（`K7QM2P` 这种）**只走主控 HTTP API**：`POST /api/v1/rooms/join` 需要登录，
并按 `access` 做密码/审批校验。它**不参与 EasyTier 网络名**，因此"拿到加入码"不等于"能进虚拟网络"。

---

## 3. 关键事实（源码级证据）

### 3.1 中继按网络名决定是否中继（wildmatch）

```rust
// easytier-core/src/peers/whitelist.rs
pub(crate) fn check_network_in_relay_whitelist(relay_network_whitelist: &str, network_name: &str)
    -> Result<(), anyhow::Error> {
    if relay_network_whitelist.split(' ')
        .map(wildmatch::WildMatch::new)
        .any(|whitelist| whitelist.matches(network_name)) { Ok(()) }
    else { Err(anyhow::anyhow!("network {} not in whitelist", network_name)) }
}
```

主控默认 `relay_network_whitelist = "mclink-room-*"`，因此它只为我们自己创建的房间做中继，
不会被当成免费公共中继。

### 3.2 `network_secret` 只在 `private_mode` 开启时才被校验

```rust
// easytier-core/src/peers/peer_manager.rs  （建立外来网络连接时）
let foreign_network_allowed =
    conn.matches_local_network_secret() || trusted_foreign_credential;

if !is_local_network && self.context.flags().private_mode && !foreign_network_allowed {
    self.release_reserved_peer_id(&peer_network_name);
    return Err(Error::SecretKeyError(
        "private mode is turned on, foreign network secret mismatch".to_string(),
    ));
}
// ...
} else {
    self.foreign_network_manager.add_peer_conn(conn).await   // private_mode 关闭时直接走到这里
};
```

`private_mode` 默认 `false`（`easytier-core/src/config/toml.rs`）。

### 3.3 为什么不能靠 `private_mode` 做隔离

中继实例有**自己**的网络身份（`MCLINK_RELAY_NETWORK=mclink-master` + `MCLINK_RELAY_SECRET`），
它与任何房间的密钥都不同。一旦打开 `private_mode`，中继会以"密钥不符"为由拒绝**所有**房间——
包括合法房间。所以共享中继架构下 `private_mode` 不可用。

**结论：在单端口共享中继架构下，网络名就是准入凭证。** 平台据此把网络名做成 128 bit 不可猜测的
密钥派生值（§2），并让 6 位加入码完全不参与 EasyTier 身份。

---

## 4. 已实测确认的边界（必须当成限制来读）

### 4.1 拿到网络名 + 错误密钥，仍会被接入房间的 peer 网表

**现象**：如果攻击者**已经拿到网络名**但**密钥是错的**，EasyTier v2.6.4 仍然会把它接入该房间的
peer 网表——攻击者能看到房间成员的虚拟 IP，连接路径显示为 `relay(N)`。
（原因就是 §3.2：`private_mode` 关闭时不做密钥校验，直接
`foreign_network_manager.add_peer_conn()`。）

**仍然有效的控制**：

1. **主控侧准入有效**：票据只在通过成员校验后才签发（`RoomService.ticket()` 会拒绝
   `kicked` / `pending` / 非成员），攻击者拿不到 `network_secret`、票据、以及虚拟网络内的可用通信
   （密钥不匹配无法形成可用的加密对等关系；端到端实验 `pnpm lab` 的结论 3 验证了"密钥错误者
   进不了房间"）。
2. **密钥轮换可立即移除**：轮换后网络名变化，旧名字在中继上不再命中 `mclink-room-*` 白名单，
   攻击者的连接会被直接拒绝。
3. **踢人**：被踢成员的虚拟 IP 会进入房主实例的 Drop ACL（房主客户端应用后生效）。

**建议**：需要更强的成员认证时，改用 EasyTier 的 **secure mode + credential**
（`--secure-mode` / `--credential`），并把凭证随票据下发。当前平台**未实现**该模式，
这是后续可选加固方向。

### 4.2 限速的两条边界

* **ACL 的 `rate_limit` 单位是包/秒（pps），不是带宽。** 想做带宽限速只能用
  `foreign_relay_bps_limit`（中继转发出口）与 `instance_recv_bps_limit`（本实例接收）。
* **这两个 `*_bps_limit` 的单位是「字节/秒」，不是比特/秒**，且在 TOML 里必须写
  **裸数字**（加引号会让 easytier-core 解析配置时 panic）。平台对外用 kbps，
  下发前经 `kbpsToBytesPerSecond()` 换算；实测数据见 `docs/architecture.md` §7.3。
* **`instance_recv_bps_limit` 是客户端自制裁剪**：恶意客户端可以直接不遵守自己实例的接收限速。
  **服务端侧的硬限制只有中继的 `foreign_relay_bps_limit`（平台级）**，即
  `MCLINK_RELAY_BPS_LIMIT` / 管理台的「平台级总出口限速」。

### 4.3 其它已核实的技术事实（踩坑得来）

| 事实 | 后果 | 证据 |
| --- | --- | --- |
| `rpc_portal` / `rpc_portal_whitelist` **不是** TOML 配置字段，只能通过命令行 `-r` 传入 | 写进配置文件会被**静默忽略**，导致所有实例抢默认端口 15888 并互相抢占管理通道 | 两者仅存在于 `easytier/src/core.rs` 的 clap 定义；`easytier-core/src/config/toml.rs` 中完全不存在 |
| `bind_device` 默认 `true` | 在部分环境（受限容器、多网卡、Windows 沙箱）会让 EasyTier 连不上中继（`WSAEADDRNOTAVAIL` / 10049）；平台已在中继、子节点、客户端票据三处统一设为 `false` | `config/toml.rs` 默认值；`manager.ts` / `nodes.ts` / `rooms.ts` 的 `ticket()` |
| EasyTier v2.6.4 的 CLI **没有** `acl set`（只有 `acl stats`） | 运行时热替换 ACL 是更新版本的能力。平台做了能力探测，不支持时通过「重载配置 / 重启实例」生效（房主会有约 2 秒断线） | `easytier-cli acl --help` 实测输出；`manager.ts` 的 `supportsAclSet()`、客户端 `main.cjs` 的 `supportsAclSet()` |

---

## 5. 网络名的暴露面（实测结论，会削弱 §2 的"不可猜测"）

### 5.1 房间 ID 就是网络名后缀

`server/src/db/rooms.ts` 的 `RoomRepo.create()`：

```ts
const id = input.networkName.replace(/^mclink-room-/, '') || input.code.toLowerCase();
```

因此恒有：

```
room.id          = sha256("mclink-net-v1:" + network_secret).slice(0, 32)
room.networkName = "mclink-room-" + room.id
```

**拿到房间 ID 就等于拿到网络名。** 房间 ID 是 128 bit 随机（不可暴力枚举），但它会被接口派发出去。

### 5.2 公开大厅（无需登录）会派发网络名

实测（本机主控，`MCLINK_AUTOSTART_RELAY=false`）：

```
GET /api/v1/rooms/public          （匿名）
→ 200，返回的 Room 对象包含：
   id          = af268afd97981394329ee773e8efddf2
   networkName = mclink-room-af268afd97981394329ee773e8efddf2
   code        = XQVYH9
   subnet      = 10.200.0.0/24
```

也就是说：**对 `visibility = public` 的房间，网络名是公开的**。
"网络名不可猜测"这一保护只对 `visibility = hidden` 的房间、以及已知 ID 尚未泄露的房间成立。

影响评估：结合 §4.1，攻击者拿到网络名后能做到的是"被接入房间 peer 网表、看到成员虚拟 IP"
（而这些虚拟 IP 其实也能从公开的 `subnet` 推出来）；**不能**拿到密钥、票据或建立可用的加密对等关系。
但这条暴露是**没有必要的**——前端只在**管理台**使用 `room.networkName`
（`web/src/console/pages/RoomsPage.vue`），玩家网页端与 Electron 客户端都不使用它
（客户端用的是 `ticket.networkName`；`client/src` 里没有任何 `networkName` 引用）。

**建议修复（未实施）**：把 `networkName` 从 `toRoom()`（`server/src/db/rooms.ts`）移除，
只在管理台响应里附加；或至少从 `/rooms/public`、`/rooms/:id`、`/rooms` 的响应中剔除。

### 5.3 房间详情与成员列表缺少成员校验

`server/src/api/rooms.ts`：

* `GET /rooms/:id` 只要求 `auth`，然后返回 `{ room, members, usage, isHost }` —— **不校验调用者
  是否在该房间内**。
* `GET /rooms/:id/members` 只做 `requireAuth(ctx)`，同样不校验成员身份。

实测：另一个普通登录用户用房间 ID 访问，能拿到 `code`、`networkName`，以及成员列表
（含 `virtualIp`、`deviceName`、`latencyMs`）。

正确的部分（对照）：`GET /rooms/:id/ticket` → `403 forbidden`「你不在该房间中」；
`GET /rooms/:id/acl` → `403 forbidden`「只有房主可以执行该操作」；
`GET /rooms/:id/access-log` → 同样要求房主。

**建议修复（未实施）**：`/rooms/:id` 与 `/members` 增加"房主或 active 成员"校验
（`rooms.findMember()` 已具备该能力）。

### 5.4 管理台会返回 `networkSecret`

`GET /api/v1/admin/rooms/:id` 的响应里含 `networkSecret` 与 `aclToml`（便于管理员排障）。
这是**有意的**，但意味着管理员账号被攻陷 = 所有房间的虚拟网络身份泄露。
请务必给管理员账号设置强密码，不要共享管理员账号。

---

## 6. 平台自身的加固措施

| 措施 | 实现位置 | 说明 |
| --- | --- | --- |
| 口令哈希用 **scrypt** | `server/src/util/id.ts` 的 `hashPassword()` | 16 字节随机盐、64 字节派生键、`NFKC` 归一化、`timingSafeEqual` 比较；存储格式 `scrypt$<salt>$<hash>` |
| 登录不做用户枚举 | `services/auth.ts` | 用户名不存在时也执行一次哈希校验，统一返回「用户名或密码错误」 |
| **会话令牌只存 sha256** | `db/users.ts` 的 `createSession()` | 令牌本体（32 字节随机，`newToken()`）只在签发时返回一次，库里只有 `token_hash` |
| 会话可吊销 | `services/auth.ts` | 改密 → `deleteSessionsForUser()`；封禁 → 同时删除全部会话；管理台可踢会话 |
| 令牌有效期 | `MCLINK_TOKEN_TTL_SECONDS` | 默认 14 天，解析时校验 `expires_at` 并清理过期会话 |
| **按 IP 滑动窗口限流** | `server/src/server.ts` 的 `RateLimiter` | 一般 240 次/分钟；**登录/注册单独限流** 20 次/分钟（`MCLINK_LOGIN_RATE_LIMIT`） |
| 房间准入密码只做 **sha256** | `services/rooms.ts` 的 `hashRoomPassword()` | 固定盐 + 快速哈希。**这是有意为之**：真正的隔离靠 32 位随机的 `network_secret`，房间密码只是"进房暗号"（见 §9 的弱点 9） |
| 审计日志 | `db/traffic.ts` 的 `AuditRepo` | 登录成功/失败、注册、建房、加入、审批、踢人、关房、轮换密钥、管理员所有变更、节点上下线；含 actor/IP/时间 |
| 票据短时效 | `services/rooms.ts` 的 `ticket()` | `expiresAt` 为 24 小时；且**每次取票据都会重新校验成员状态**（`kicked`/`pending` 直接拒绝） |
| 一次性注册密钥 | `util/id.ts` 的 `enrollKey()` | 24 字符、32 字符表（≈120 bit），用后即标记 `used_at`，可吊销 |
| 输入范围裁剪 | `api/helpers.ts` 的 `parsePolicy()` / `optInt()` | 房间策略字段一律裁剪到已知范围，避免客户端影响 ACL 生成 |
| 静态文件路径穿越防护 | `http/kit.ts` 的 `safeJoin()` | 归一化后必须落在根目录内；`..`、`\0` 直接拒绝 |
| 请求体大小限制 | `http/kit.ts` | 1 MiB |
| 安全响应头 | `server.ts` 的 `applySecurityHeaders()` | `nosniff`、`referrer-policy`、`x-frame-options: SAMEORIGIN` |
| 无原生依赖 | `db/index.ts` 用内置 `node:sqlite` | 不需要编译工具链，缩小供应链面 |
| 服务进程加固 | `deploy/*.service` | `NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=full`、`ProtectHome`、精确 `ReadWritePaths`、`RestrictAddressFamilies` |

---

## 7. 部署侧的安全要求（不做就等于没上安全）

1. **不要直接把 8787 暴露到公网**：用 nginx/Caddy 做 TLS 终结，只让反代访问本机 8787。
2. **中继端口 11010 必须开放 TCP+UDP**（它是裸 TCP/UDP，不能走 http 反代）；不要给它加任何
   7 层解析或限速设备，否则会破坏长连接。
3. **`MCLINK_TRUST_PROXY` / `MCLINK_TRUSTED_PROXIES` 要与实际拓扑一致**（控制台
   「平台设置 → 真实 IP 判定」里可改，**那里的值优先**；环境变量只是首次安装的初值）：
   * 在反代后面 → `MCLINK_TRUST_PROXY=true`（默认），并把**反代自己的地址**写进
     `MCLINK_TRUSTED_PROXIES`（同机 nginx 写 `127.0.0.1/8,::1/128`，安装脚本已默认写入）。
     主控只信这些来源发来的 `X-Forwarded-For` / `X-Real-IP`；
   * 主控取的是转发链里**最右侧的非可信跳**，也就是反代亲手追加的那个 `$remote_addr`。
     nginx 示例用的 `$proxy_add_x_forwarded_for` 是**追加**语义，客户端自己发的值排在
     最左边，因此伪造它没有意义（旧实现在这里取最左边，属于"谁都能改"的值，已修）；
   * CDN（Cloudflare 等）→ nginx 两级时，把 CDN 的**回源段**也加进 `MCLINK_TRUSTED_PROXIES`，
     否则拿到的是 CDN 边缘地址（不精确，但至少不可伪造）；
   * 直连暴露 → 必须设 `MCLINK_TRUST_PROXY=false`，否则任何伪造头部都可能被采信；
   * 没配 `MCLINK_TRUSTED_PROXIES` 时是**兼容模式**：信任回环 + 私网来源的转发头
     （容器里跑反代的老部署不至于一夜翻车），启动日志会有一条 warn 提示去显式配置。
     注意兼容模式的残留问题：内网客户端本身也落在私网段里，因此**内网来源**仍可伪造 IP。
4. **显式配置 `MCLINK_PUBLIC_BASE_URL`**：它决定安装/更新指令、下载链接与邮件里的**绝对地址**；
   不配就只能按请求的 `Host` 头猜，反代后面容易猜出内网地址。
   注意票据**不再受影响**：`relays[]` 的地址只来自子节点注册时填的 `--endpoint`
   （2026-09-27 起主控不再兜底），所以伪造 `Host` 已经不能把玩家引到别处。
   `MCLINK_RELAY_PUBLIC_HOST` / `install-server.sh --relay-public-host` 现在只是
   `MCLINK_PUBLIC_BASE_URL` 为空时，拼安装/更新指令用的「主控对外主机名」回退。
5. **给 `/etc/mclink/mclink.env` 和 `/etc/mclink/node.env` 设 600**（安装脚本已做）；
   注意 `MCLINK_ADMIN_PASSWORD` 在该文件里是**明文**，别把它提交进 Git。
6. **备份并保护 `secrets.json`**：它含 JWT 密钥与中继密钥；泄露 = 可伪造登录令牌。
7. **定期轮换中继密钥**：`install-server.sh --rotate-secrets`（会让所有登录令牌与旧票据失效）。
8. **客户端安装包走 HTTPS**：`/downloads/*` 没有内置摘要校验（`sha256` 字段恒为 `null`），
   完整性依赖传输层与下载源。
9. **限制管理台访问**：管理台与玩家端在同一个域名下，可用 nginx 对
   `/console` 路径做 IP 白名单或额外认证（前端路由细节见 `web/src/console/`）。

---

## 8. WebSocket 面的注意点

* 未认证连接可以订阅 `platform` 与 `traffic` 两个话题（实测：`hello` 返回
  `topics: ["platform","traffic"]`）。`traffic.tick` 帧里含**房间名与带宽**，
  `notice` 帧里含平台计数。也就是说**只要网络可达 `/ws`，不登录也能读到房间名与流量概况**。
  `nodes` / `rooms` 需要管理员，`user:<id>` 只能订阅自己，`room:<id>` 需要是该房间成员。
* 令牌通过 `?token=` 传递，会出现在 nginx access log、浏览器历史与 Referer 中。
  生产环境请关闭或缩短访问日志中的查询串记录。
* 服务端 30 秒 ping 一次做保活，未回 pong 的连接会被 terminate。

---

## 9. 已知弱点清单（按建议修复优先级排序）

| # | 弱点 | 位置 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **网络名通过公开接口暴露，且房间 ID 就是网络名后缀** | `db/rooms.ts` 的 `create()`/`toRoom()`，`api/rooms.ts` 的 `/rooms/public` | 削弱"网络名是准入凭证"的前提；攻击者可进入房间 peer 网表看到成员虚拟 IP | 从玩家侧响应中移除 `networkName`；长期方案是把房间 ID 与网络名解耦（ID 用独立随机值） |
| 2 | **`/rooms/:id` 与 `/rooms/:id/members` 缺少成员校验** | `api/rooms.ts` | 任意登录用户知道房间 ID 即可读房间元信息、加入码与成员列表（含虚拟 IP） | 加 `assertMemberOrHost()` 校验 |
| 3 | **节点令牌的熵源不是密码学随机**：`nodeToken = nodeId + "." + sha256(nodeId + ":" + Date.now() + ":" + Math.random())` | `services/nodes.ts` 的 `enroll()` | `Math.random()` 不是 CSPRNG；`nodeId` 与 `Date.now()` 都是低熵/可枚举量，理论上可被预测 | 改为 `crypto.randomBytes(32).toString('base64url')`（与用户会话令牌一致的写法） |
| 4 | **`private_mode` 不可用 → 中继不校验密钥** | EasyTier 行为（§3.2） | 见 §4.1 | 需要强成员认证时改用 secure mode + credential；或为每个房间起独立中继实例（成本高） |
| 5 | ~~`MCLINK_TRUST_PROXY=true` 时完全信任 `X-Forwarded-For`，且取的是第一个值~~ **已修（v1.0.4）** | `util/net.ts` 的 `clientIp()` | 修复前：可伪造 IP 绕过 IP 限流、污染审计、冒充子节点上报公网地址 | 已加可信代理 CIDR 白名单（`MCLINK_TRUSTED_PROXIES`）并改为取最右侧非可信跳；实测见 `.cache/check-real-ip.mjs` |
| 6 | **未认证 WS 可读平台流量与房间名** | `server.ts` 的 `authorizeTopic` | 信息泄露（房间名、节点名、带宽） | 要求登录才能订阅 `traffic`；`platform` 只下发聚合计数 |
| 7 | **限流是单进程内存态** | `server.ts` 的 `RateLimiter` | 重启清零；多进程/多实例不共享；无法做全局封禁 | 大规模部署时换成 Redis 等外部计数 |
| 8 | **房间准入密码是固定盐 sha256** | `services/rooms.ts` 的 `hashRoomPassword()` | 库泄露后可离线快速爆破；不同房间相同密码哈希相同 | 若把房间密码当"真密码"用，应改为 scrypt/argon2 + per-room 盐（当前设计有意从简，因为真正隔离靠 32 位密钥） |
| 9 | **`instance_recv_bps_limit` 可被客户端绕过** | 票据 TOML（客户端自制） | 恶意客户端可无视单成员限速 | 平台级硬限制只能靠中继的 `foreign_relay_bps_limit` |
| 10 | **配额字段未强制**：`quotaBytes` / `maxRooms` 已入库，但 `quota_exceeded` 从未抛出 | `services/rooms.ts`（只用了 `maxRooms`） | 用量配额形同虚设（`maxRooms` 是唯一生效的） | 在流量累加处做配额判定 |
| 11 | **`CORS` 允许 `*`** | `server.ts` 的 `isAllowedOrigin()` | 配置成 `*` 时回显任意 Origin 并带 `credentials: true`；虽然认证靠 Bearer 头（非 Cookie）因而 CSRF 风险低，但仍应避免 | 生产环境显式列出来源 |
| 12 | ~~下载产物无摘要~~ **部分已修（v1.0.4）** | `api/public.ts` 的 `listDownloads()` | 修复前 `sha256` 恒为 `null`，无法校验安装包完整性；主产物还优先用**管理员手工登记**的值，换包忘改时页面会给出对不上的哈希（比不显示更糟） | 主控现在按下载目录里的实际文件懒计算并缓存摘要，登记值与实际不符时**以实际文件为准**并记 warn；同名文件被替换（size/mtime 变化）会自动重算。实测见 `.cache/check-download-sha.mjs`。剩余：摘要只覆盖本机目录，站外镜像仍需人工核对 |
| 13 | **审计日志记录管理员提交的原始 body** | `api/admin.ts` 的 `user.update` 等 | 若管理员误传敏感字段会被落库 | 只记录白名单字段 |
| 14 | **无 2FA / 无账号锁定** | — | 管理员账号弱密码即高危 | 强密码 + 限制管理台来源 IP |

---

## 10. 合规与许可

* **EasyTier 采用 LGPL-3.0**。mclink **通过子进程调用 `easytier-core` / `easytier-cli`**
  （`spawn`），**没有修改、没有链接、也没有再分发其修改版**，因此不触发 LGPL 的衍生作品义务；
  部署时下载的二进制由 EasyTier 官方 Releases 提供，请自行遵守其许可证。
* 本项目自身代码以仓库根 `package.json` 声明的 **AGPL-3.0-or-later** 发布。
* **《我的世界》（Minecraft）相关商标、素材与游戏内容归 Mojang Studios / Microsoft 所有**。
  本项目是独立的第三方联机工具，与 Mojang 无任何关联，也不包含任何游戏资源。
* **仅供合法联机用途**：请勿用于规避游戏授权、绕过服务器规则或任何违法用途；
  使用者需自行遵守所在地区的法律与游戏服务条款。
* 平台会记录账号、IP 与流量审计数据（见 §6），部署方应在隐私政策中告知用户，
  并按当地法规设定保留期限（流量明细默认保留 72 小时，`server/src/index.ts` 的
  `app.traffic.prune(72)`）。
