# mclink REST / WebSocket API 参考

本文由 `packages/shared/src/protocol.ts`（路由常量与错误码）、`server/src/api/*.ts`（真实路由与
请求/响应体）、`server/src/server.ts`（中间件、限流、静态资源）、`server/src/ws/hub.ts`
（WebSocket）逐条核对后写成。**凡是与实现不符的地方都在文末「与实现不一致的已知点」列出。**

---

## 1. 通用约定

| 项目 | 约定 |
| --- | --- |
| 基础路径 | `/api/v1`（常量 `API_PREFIX`），前缀 `/api` 也进入 API 分支 |
| 传输 | JSON，`content-type: application/json`；请求体上限 **1 MiB**（超出返回 `bad_request`） |
| 时间格式 | ISO-8601 UTC 字符串，例如 `2026-01-01T08:00:00.000Z` |
| 成功响应 | 统一包装：`{"ok": true, "data": <业务体>}` |
| 失败响应 | `{"error": {"code": "<错误码>", "message": "中文说明", "fields": {"<字段>": "说明"}}}`；`fields` 仅参数校验类错误出现 |
| 鉴权 | `Authorization: Bearer <token>`；也接受 `x-mclink-token: <token>`，以及查询串 `?token=<token>`（WebSocket 与下载链接用） |
| 子节点鉴权 | 节点令牌同样是 `Authorization: Bearer <nodeToken>` |
| CORS | 仅放行 `MCLINK_CORS_ORIGINS` 中的来源；另外默认放行 `http://localhost[:port]`、`http://127.0.0.1[:port]`、`file://`、`null`（Electron） |
| 安全响应头 | `x-content-type-options: nosniff`、`referrer-policy: strict-origin-when-cross-origin`、`x-frame-options: SAMEORIGIN` |
| 未匹配路由 | `404` + `{"error":{"code":"not_found","message":"接口不存在"}}` |

### 限流（按客户端 IP 的滑动窗口，窗口 60 秒）

| 范围 | 变量 | 默认值 |
| --- | --- | --- |
| 一般接口 | `MCLINK_RATE_LIMIT` | 240 次/分钟 |
| `POST /auth/login`、`POST /auth/register` | `MCLINK_LOGIN_RATE_LIMIT` | 20 次/分钟 |

超限返回 `429` + `rate_limited`。IP 判定遵循 `MCLINK_TRUST_PROXY`（默认 `true`，取
`X-Forwarded-For` 第一跳）。

### 错误码表（`ErrorCodes`，`packages/shared/src/protocol.ts`）

| code | HTTP | 含义 | 当前是否会被抛出 |
| --- | --- | --- | --- |
| `bad_request` | 400 | 参数缺失/非法（含字段级 `fields`） | ✅ |
| `unauthorized` | 401 | 未登录 / 令牌失效 / 用户名密码错误 | ✅ |
| `forbidden` | 403 | 无权限（非房主、节点被禁用、注册密钥无效等） | ✅ |
| `not_found` | 404 | 资源不存在 | ✅ |
| `conflict` | 409 | 冲突（用户名被占用、申请已处理、endpoint 已被注册） | ✅ |
| `rate_limited` | 429 | 触发限流 | ✅ |
| `room_full` | 409 | 房间人数/座位已满 | ✅ |
| `room_closed` | 400 | 房间已关闭或已过期 | ✅ |
| `room_password_required` | 401 | 需要房间密码 / 密码错误 | ✅ |
| `room_approval_pending` | — | 待房主审批 | ❌ **已定义但当前未使用**（票据接口用 `forbidden` + 文案「等待房主审批」） |
| `quota_exceeded` | — | 超出流量配额 | ❌ **已定义但当前未使用**（配额字段已入库，尚未在流量路径上强制） |
| `registration_closed` | 403 | 平台关闭了注册 | ✅ |
| `internal_error` | 500 | 服务器内部错误 | ✅ |
| `service_unavailable` | 503 | 依赖不可用（如 `easytier-cli` 失败、虚拟网段耗尽、无可用中继） | ✅ |

---

## 2. 路由总表

「鉴权」列：`—` 公开；`U` 需登录；`A` 需管理员；`N` 需子节点令牌；`房主` 表示需登录且仅房主可操作
（由服务层 `assertHost()` 强制，返回 `403 forbidden`）。

### 公开接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/meta` | — | 站点元信息 + 平台概览（落地页首屏） |
| GET | `/api/v1/regions` | — | 区域列表与各区域可用中继统计 |
| GET | `/api/v1/stats` | — | 平台统计（节点/房间/用户/流量） |
| GET | `/api/v1/downloads` | — | 客户端下载产物列表 |
| POST | `/api/v1/relay/refresh` | U | 手动触发一次主控中继采样 |

### 账号

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/register` | — | 注册（受登录限流；`registrationOpen=false` 且已有用户时返回 `registration_closed`） |
| POST | `/api/v1/auth/login` | — | 登录（受登录限流） |
| POST | `/api/v1/auth/logout` | U | 注销当前令牌 |
| GET | `/api/v1/auth/me` | U | 当前账号信息（`UserSelf`） |
| POST | `/api/v1/auth/password` | U | 改密（成功后**所有会话失效**） |
| PATCH | `/api/v1/auth/profile` | U | 修改自己的 `displayName` / `email` |

### 房间（玩家侧）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/rooms` | U | 创建房间（创建者即房主，返回票据） |
| GET | `/api/v1/rooms` | U | 我的房间：`{ hosted, joined }` |
| GET | `/api/v1/rooms/public` | — | 公开房间大厅（`zone`/`search`/`limit`/`offset`） |
| POST | `/api/v1/rooms/join` | U | 凭 6 位加入码进房 |
| GET | `/api/v1/rooms/:id` | U | 房间详情 + 成员 + 用量 |
| GET | `/api/v1/rooms/:id/ticket` | U | **获取启动 EasyTier 所需的票据**（`RoomTicket`） |
| GET | `/api/v1/rooms/:id/acl` | 房主 | 房主实例需要热应用的 ACL + 版本号 |
| POST | `/api/v1/rooms/:id/heartbeat` | U | 成员心跳：上报虚拟 IP/延迟/流量，取回踢出标记与 ACL |
| GET | `/api/v1/rooms/:id/members` | U | 成员列表 |
| POST | `/api/v1/rooms/:id/members/approve` | 房主 | 审批加入申请 |
| POST | `/api/v1/rooms/:id/kick` | 房主 | 踢人（返回新 ACL） |
| PATCH | `/api/v1/rooms/:id` | 房主 | 修改房间设置与策略（返回新 ACL） |
| POST | `/api/v1/rooms/:id/close` | 房主 | 关闭房间 |
| POST | `/api/v1/rooms/:id/rotate-secret` | 房主 | **轮换网络密钥（同时换掉网络名）** |
| POST | `/api/v1/rooms/:id/leave` | U | 主动退出（房主退出 = 关闭房间） |
| GET | `/api/v1/rooms/:id/access-log` | 房主 | 房间访问日志（最近 100 条） |

### 子节点 agent

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/agent/register` | — | 用一次性 `enrollKey` 换长期 `nodeToken` + 中继配置 |
| POST | `/api/v1/agent/heartbeat` | N | 心跳 + 逐房间流量上报 |
| GET | `/api/v1/agent/config` | N | 拉取当前应使用的配置与启动参数 |

### 管理台（全部要求 `auth + admin`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/admin/overview` | 仪表盘总览（含 `system`、`recentAudit`、`warnings`） |
| GET | `/api/v1/admin/nodes` | 节点列表（`region`/`status`/`search` 过滤） |
| GET | `/api/v1/admin/nodes/regions` | 各区域可用统计 |
| POST | `/api/v1/admin/nodes/enroll-key` | 签发一次性注册密钥（并返回一键安装命令文本） |
| GET | `/api/v1/admin/nodes/enroll-keys` | 密钥列表（含已使用/已吊销） |
| PATCH | `/api/v1/admin/nodes/:id` | 修改节点 `name`/`region`/`endpoint`/`weight`/`capacityPeers`/`tags` |
| POST | `/api/v1/admin/nodes/:id/disable` | 停用/启用节点（`{"disabled": true}`） |
| DELETE | `/api/v1/admin/nodes/:id` | 删除节点 |
| GET | `/api/v1/admin/rooms` | 房间列表（含用量） |
| GET | `/api/v1/admin/rooms/:id` | 房间详情（含 `networkSecret`、`aclToml`、访问日志） |
| DELETE | `/api/v1/admin/rooms/:id` | 强制关闭房间 |
| GET | `/api/v1/admin/users` | 用户列表（含 `hostedRooms`） |
| PATCH | `/api/v1/admin/users/:id` | 封禁/解封、改角色、配额、重置用量 |
| GET | `/api/v1/admin/traffic` | 流量时序（平台/房间/节点，`minutes`、`scope`、`scopeId`） |
| GET | `/api/v1/admin/audit` | 审计日志（`action`/`actorId`/`limit`/`offset`） |
| GET | `/api/v1/admin/settings` | 平台设置 + 默认值 + 受环境变量约束的项 |
| PATCH | `/api/v1/admin/settings` | 修改平台设置 |
| GET | `/api/v1/admin/relay` | 主控中继运行时、生成的 TOML、日志尾部、peer 列表、白名单 |
| POST | `/api/v1/admin/relay/restart` | 重启主控中继 |
| POST | `/api/v1/admin/relay/acl` | 下发 ACL（`{"aclToml": "...[acl.acl_v1]..."}`） |
| POST | `/api/v1/admin/relay/refresh` | 手动采样一次中继 |
| POST | `/api/v1/admin/rooms/recompute-acl` | 按当前策略重算所有开放房间的 ACL 版本（排障用） |

### 静态资源（非 API）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/HEAD | `/downloads/<文件名>` | 客户端安装包，**支持 Range 断点续传**（206 + `content-range`），`cache-control: public, max-age=300` |
| GET | `/` 及其它非 API 路径 | 前端构建产物；未命中时回退 `index.html`（SPA）。前端未构建时返回内置提示页 |

---

## 3. 公开接口

### GET /api/v1/meta

```json
{
  "ok": true,
  "data": {
    "siteName": "mclink 联机",
    "siteTagline": "基于 EasyTier 的《我的世界》联机平台 —— 单端口、低延迟、开箱即用",
    "version": "0.1.0",
    "serverTime": "2026-01-01T08:00:00.000Z",
    "uptimeSeconds": 3600,
    "registrationOpen": true,
    "announcement": null,
    "relayPort": 11010,
    "easytierVersion": "easytier-cli 2.6.4-8428a89d",
    "clientVersion": "0.1.0",
    "clientDownloadUrl": "/downloads/mclink-client-setup.exe",
    "stats": {
      "onlineNodes": 2,
      "totalNodes": 3,
      "openRooms": 4,
      "onlinePlayers": 11,
      "users": 42,
      "relayPeers": 9,
      "relayRxBps": 1450000,
      "relayTxBps": 2380000,
      "foreignNetworks": 4
    }
  }
}
```

### GET /api/v1/regions

`data` 是数组，每项含 `id`、`label`、`hint`、`onlineNodes`、`peers`、`capacity`。
内置区域 id（`packages/shared/src/regions.ts`）：`auto`、`cn-east`、`cn-south`、`cn-north`、
`cn-central`、`cn-southwest`、`cn-northwest`、`cn-northeast`、`hk`、`oversea`。
`auto` 的统计是所有区域的汇总。

### GET /api/v1/stats

```json
{
  "ok": true,
  "data": {
    "serverTime": "2026-01-01T08:00:00.000Z",
    "nodes": { "total": 3, "online": 2, "degraded": 0, "offline": 1, "pending": 0 },
    "rooms": { "open": 4, "total": 128, "onlinePlayers": 11 },
    "users": { "total": 42, "online": 0 },
    "traffic": { "rxBps": 1450000, "txBps": 2380000, "rxBytesToday": 98765432100, "txBytesToday": 123456789000 }
  }
}
```

说明：`users.online` 当前恒为 `0`（在线用户数由 WebSocket 连接统计，尚未接入该接口）。

### GET /api/v1/downloads

`data.clientVersion`、`data.primary`（设置里的主下载地址）、`data.artifacts[]`：
`{ id, platform, arch, label, filename, size, sha256, url }`。
`sha256` 当前恒为 `null`（未做产物摘要），扫描的扩展名是
`.exe .zip .msi .apk .dmg .deb .appimage`。

---

## 4. 账号接口

### POST /api/v1/auth/register

请求：

```json
{ "username": "steve", "password": "P@ssw0rd123", "displayName": "史蒂夫" }
```

约束：用户名 3–24 位字母/数字/下划线（`USERNAME_PATTERN`）；密码 8–128 位且**必须同时含字母与数字**。

响应（同时完成登录）：

```json
{
  "ok": true,
  "data": {
    "token": "请替换为真实令牌",
    "expiresAt": "2026-01-15T08:00:00.000Z",
    "user": {
      "id": "u_ab12cd", "username": "steve", "displayName": "史蒂夫",
      "role": "user", "banned": false, "createdAt": "2026-01-01T08:00:00.000Z",
      "email": null, "quotaBytes": null, "usedBytes": 0, "maxRooms": null
    }
  }
}
```

* 平台第一个注册的用户会被自动提升为管理员（`role: "admin"`）。
* 失败：`409 conflict`（用户名占用，带 `fields.username`）、`403 registration_closed`。

### POST /api/v1/auth/login

请求 `{ "username": "...", "password": "..." }`，响应结构与注册相同。
失败统一为 `401 unauthorized`「用户名或密码错误」（用户名不存在时也会做一次哈希校验，避免时序枚举）。
被封禁返回 `403 forbidden`「账号已被封禁」。

### GET /api/v1/auth/me

响应 `data` 为 `UserSelf`（同上面的 `user` 对象）。

### POST /api/v1/auth/password

请求 `{ "oldPassword": "...", "newPassword": "..." }`，
成功响应 `{"ok":true,"data":{"ok":true,"message":"密码已更新，请重新登录"}}`。
原密码错误返回 `400 bad_request`（带 `fields.oldPassword`）。
**成功后该用户所有会话（含其他设备）立即失效**。

### PATCH /api/v1/auth/profile

请求 `{ "displayName": "新名字", "email": "a@b.c" }`（`email` 可为 `null` 以清空）。
响应 `data` 为更新后的 `UserSelf`。

### POST /api/v1/auth/logout

响应 `{"ok":true,"data":{"ok":true}}`。该路由要求有效令牌，**没有有效令牌时返回 `401 unauthorized`**。

---

## 5. 房间接口

### Room 对象

```json
{
  "id": "af268afd97981394329ee773e8efddf2",
  "code": "K7QM2P",
  "name": "李四的生存服",
  "hostUserId": "u_ab12cd",
  "hostDisplayName": "史蒂夫",
  "status": "open",
  "access": "open",
  "visibility": "public",
  "zone": "cn-east",
  "relayNodeIds": ["n_abc123"],
  "policy": {
    "maxPlayers": 8, "maxBandwidthKbps": 0, "perMemberKbps": 0, "rateLimitPps": 0,
    "allowP2p": true, "allowPublicRelay": false, "allowedPorts": [], "strictPorts": false, "motd": null
  },
  "networkName": "mclink-room-af268afd97981394329ee773e8efddf2",
  "subnet": "10.200.7.0/24",
  "onlineMembers": 3,
  "memberCount": 3,
  "createdAt": "2026-01-01T08:00:00.000Z",
  "expiresAt": "2026-01-01T20:00:00.000Z",
  "closedAt": null,
  "subnetSlot": 7
}
```

> **`id` 与 `networkName` 的关系（实现细节，容易误用）**：房间 ID **不是**随机短 ID，
> 而是「网络名的后半段」——`RoomRepo.create()` 里
> `const id = input.networkName.replace(/^mclink-room-/, '')`（`server/src/db/rooms.ts`），
> 因此恒有 `networkName === "mclink-room-" + id`，且 `id` 就是
> `sha256("mclink-net-v1:" + networkSecret)` 的前 32 个 hex 字符。
> **含义**：拿到房间 ID 就等于拿到该房间的 EasyTier 网络名。
> 详见 `security.md` 的「网络名的暴露面」。

### POST /api/v1/rooms（创建房间）

请求：

```json
{
  "name": "李四的生存服",
  "zone": "cn-east",
  "access": "open",
  "visibility": "public",
  "password": null,
  "maxPlayers": 8,
  "perMemberKbps": 0,
  "rateLimitPps": 0,
  "allowP2p": true,
  "allowedPorts": ["25565"],
  "strictPorts": false,
  "motd": "晚上 8 点开黑",
  "listenPort": 11010,
  "ttlMinutes": 720
}
```

* `name` 必填（截断到 32 字符）；`zone` 必须是已知区域；`access ∈ {open,password,approval}`；
  `visibility ∈ {public,hidden}`；`access=password` 时必须给 `password`。
* `maxPlayers`（2–64）、`maxBandwidthKbps`/`perMemberKbps`/`rateLimitPps`（0–10,000,000）、
  `allowedPorts`（最多 32 项，形如 `25565` 或 `25565-25570`）会被裁剪。
* `listenPort` 是**客户端本地的 EasyTier 监听端口**（用于生成配置与推导 RPC 端口），默认取平台 `relayPort`。
* `ttlMinutes` 省略时用平台默认值（`roomTtlMinutes`，默认 720）；显式传 `0` 表示不过期。

响应：`data` = `{ room, member, ticket, pending }`（`pending` 恒为 `false`）。

失败：`503 service_unavailable`「虚拟网段已耗尽，请联系管理员扩容」/
「当前没有可用的中继节点，请联系管理员」；`409 conflict`「最多同时创建 N 个房间」。

### GET /api/v1/rooms（我的房间）

```json
{ "ok": true, "data": { "hosted": [ /* Room */ ], "joined": [ /* Room */ ] } }
```

### GET /api/v1/rooms/public（大厅）

查询参数：`zone`、`search`、`limit`（最终被裁剪到 **1–100**，默认 40）、`offset`。
响应 `data` = `{ rooms: [Room], total: 128 }`。只返回 `status=open` 且 `visibility=public` 的房间；
`zone=auto` 等同于不按区域过滤；`search` 同时匹配房间名与加入码。

### POST /api/v1/rooms/join（凭加入码进房）

请求：

```json
{ "code": "K7QM2P", "password": null, "deviceName": "我的电脑", "listenPort": 11010 }
```

响应 `data` = `{ room, member, ticket, pending }`：

* `access=approval` 时 `pending: true` 且 **`ticket: null`**（审批通过后再调 `/ticket`）。
* 失败：`404 not_found`「加入码无效」；`400 room_closed`；`409 room_full`；
  `401 room_password_required`（缺密码或密码错误）；`403 forbidden`「你已被房主移出该房间」。

### GET /api/v1/rooms/:id

响应 `data` = `{ room, members: [RoomMember], usage: { rxBytes, txBytes, peers }, isHost: boolean }`。

### GET /api/v1/rooms/:id/ticket（核心接口）

查询参数：`listenPort`（> 1024 才生效，否则用平台默认）。

响应 `data` 为 `RoomTicket`：

```json
{
  "roomId": "r_9x8y7z",
  "roomCode": "K7QM2P",
  "roomName": "李四的生存服",
  "networkName": "mclink-room-3f1a9c...",
  "networkSecret": "请替换为 32 位随机密钥",
  "virtualIp": "10.200.7.3/24",
  "hostVirtualIp": "10.200.7.1",
  "instanceName": "mclink-k7qm2p",
  "mtu": 1380,
  "relays": [
    { "nodeId": "n_abc123", "region": "cn-east", "label": "relay-sh",
      "url": "tcp://relay-sh.example.com:11010", "udpUrl": "udp://relay-sh.example.com:11010", "latencyMs": null },
    { "nodeId": "master", "region": "master", "label": "主控中继（兜底）",
      "url": "tcp://master.example.com:11010", "udpUrl": "udp://master.example.com:11010", "latencyMs": null }
  ],
  "configToml": "# 由 mclink 主控自动生成，请勿手工编辑 —— 下次同步会被覆盖\ninstance_name = \"mclink-k7qm2p\"\n...",
  "launchArgs": ["-c", "%CONFIG%", "-r", "127.0.0.1:16010", "--rpc-portal-whitelist", "127.0.0.1/32"],
  "aclToml": null,
  "aclRevision": 3,
  "issuedAt": "2026-01-01T08:00:00.000Z",
  "expiresAt": "2026-01-02T08:00:00.000Z"
}
```

* `%CONFIG%` 需由调用方替换为自己落盘配置文件的绝对路径。
* **只有房主**会拿到非 `null` 的 `aclToml`；成员恒为 `null`。
* 失败：`403 forbidden`「你不在该房间中」/「等待房主审批」。

### POST /api/v1/rooms/:id/heartbeat

请求：

```json
{
  "virtualIp": "10.200.7.3",
  "deviceName": "我的电脑",
  "peers": [{ "ipv4": "10.200.7.1", "cost": "p2p", "latencyMs": 23 }],
  "rxBps": 120000,
  "txBps": 45000
}
```

响应：

```json
{ "ok": true, "data": { "kicked": false, "aclToml": null, "aclRevision": 3 } }
```

* 被踢/已被移出：`{ "kicked": true, "aclToml": null, "aclRevision": 0 }`。
* 房主每次心跳都会拿到**最新 ACL 文本**，成员恒为 `null`。
* `peers` 最多取前 64 条，只保留 `ipv4`/`cost`/`latencyMs`。

### GET /api/v1/rooms/:id/members

响应 `data` 为 `RoomMember[]`：

```json
[{
  "roomId": "r_9x8y7z", "userId": "u_ab12cd", "username": "steve", "displayName": "史蒂夫",
  "role": "host", "status": "active", "virtualIp": "10.200.7.1", "deviceName": "我的电脑",
  "latencyMs": 23, "p2p": true, "rxBps": 120000, "txBps": 45000,
  "joinedAt": "2026-01-01T08:00:00.000Z", "lastSeenAt": "2026-01-01T08:10:00.000Z"
}]
```

### POST /api/v1/rooms/:id/members/approve

请求 `{ "userId": "u_xyz789", "approve": true }`（`approve` 非 `false` 即视为同意）。
响应 `data` 为被处理成员的 `RoomMember`。失败：`403`（非房主）、`404`（不在申请列表）、
`409 conflict`「该申请已被处理」。

### POST /api/v1/rooms/:id/kick

请求 `{ "userId": "u_xyz789", "reason": "房主移出" }`。

响应：`data` = `{ aclToml: "<TOML>", revision: 4 }` —— **调用方（房主客户端）必须把 `aclToml`
应用到自己本地实例**，否则踢人不生效。

失败：`400`（不能踢自己）、`404`（不在房间内）、`403`（非房主）。

### PATCH /api/v1/rooms/:id（房主改设置/策略）

请求同创建接口的子集：`name`、`access`、`visibility`、`zone`、`password` 以及策略字段。
`zone` 变更会**重新调度中继节点**。

响应：`data` = `{ room, aclToml, revision }`。

### POST /api/v1/rooms/:id/close / leave

响应均为 `{"ok":true,"data":{"ok":true}}`。房主调用 `leave` 等同于 `close`。

### POST /api/v1/rooms/:id/rotate-secret（轮换网络身份）

响应：

```json
{
  "ok": true,
  "data": {
    "networkName": "mclink-room-9f2c...",
    "secret": "请替换为新的 32 位随机密钥",
    "ticket": { /* 新的 RoomTicket，房主用 */ }
  }
}
```

效果：**网络名与密钥同时更换**，旧票据、被踢成员手里的网络名立即失效（中继不再为其转发）。
加入码与成员列表不变，其他成员需要重新获取票据。

### GET /api/v1/rooms/:id/access-log

响应 `data` 为数组，每项
`{ ts, user_id, action, detail, ip }`；`action` 取值包括
`join`、`join_pending`、`approved`、`rejected`、`kicked`、`left`、`close`、
`password_fail`、`rotate_secret`。

---

## 6. 子节点 agent 接口

### POST /api/v1/agent/register

请求：

```json
{
  "enrollKey": "请替换为管理台签发的一次性密钥",
  "name": "relay-sh",
  "region": "cn-east",
  "endpoint": "relay-sh.example.com:11010",
  "capacityPeers": 500,
  "version": "0.1.0",
  "tags": ["bgp", "cn2"]
}
```

约束：`enrollKey` 必填；`region` 必须是已知区域（`auto` 不合法）；`endpoint` 必须形如 `host:port`
（正则 `^[a-zA-Z0-9._-]+:\d{1,5}$`）且**全局唯一**；`capacityPeers` 最小 10。

响应：

```json
{
  "ok": true,
  "data": {
    "node": { "id": "n_abc123", "name": "relay-sh", "region": "cn-east",
              "endpoint": "relay-sh.example.com:11010", "status": "pending",
              "capacityPeers": 500, "peers": 0, "rooms": 0, "weight": 100, "tags": ["bgp"] },
    "nodeToken": "n_abc123.<sha256>",
    "relayConfigToml": "instance_name = \"mclink-node-n_abc123\"\n...",
    "launchArgs": ["-c", "%CONFIG%", "-r", "127.0.0.1:16010", "--rpc-portal-whitelist", "127.0.0.1/32"]
  }
}
```

失败：`403 forbidden`（密钥无效/已吊销/**已被使用**）、`400 bad_request`（endpoint 或 region 非法）、
`409 conflict`（endpoint 已被其它节点注册）。

> 注意：响应里字段是 `node`（完整 `RelayNode`），而不是 `protocol.ts` 里 `AgentEnrollResponse`
> 写的 `nodeId`；`deploy/agent.mjs` 两种都兼容。详见文末不一致清单。

### POST /api/v1/agent/heartbeat

请求头：`Authorization: Bearer <nodeToken>`。

```json
{
  "version": "0.1.0",
  "publicIp": "203.0.113.10",
  "peers": 37,
  "rooms": 4,
  "rxBps": 1450000,
  "txBps": 2380000,
  "roomTraffic": [
    { "networkName": "mclink-room-3f1a9c...", "peerCount": 3,
      "rxBytes": 12345678, "txBytes": 87654321, "rxBps": 400000, "txBps": 200000 }
  ],
  "appliedConfigRevision": 0
}
```

* `roomTraffic` 的第 1–512 项会被处理：按 `networkName` 反查房间 → 写流量账本 + 累加房间用量。
  查不到房间时以 `networkName` 作为 `scopeId` 记录（`roomId: null`）。
* `rxBytes` / `txBytes` 是**累计字节**，`rxBps` / `txBps` 是 **bit/s**。
* `publicIp` 省略时服务端用请求来源 IP。
* `appliedConfigRevision` **当前服务端未消费**（预留字段）。

响应：

```json
{ "ok": true, "data": { "ok": true, "configToml": null, "configRevision": 0, "disabled": false } }
```

* `disabled: true` → 节点被管理员停用，agent 应停止 easytier-core。
* `configToml` 非 `null` → 需要热应用的新配置。
  当前实现恒为 `null`（`NodeService.heartbeat()` 里 `renderNodeConfig` 的推送路径尚未接上，
  见文末不一致清单）。

### GET /api/v1/agent/config

响应：

```json
{
  "ok": true,
  "data": {
    "configToml": "instance_name = \"mclink-node-n_abc123\"\n...",
    "launchArgs": ["-c", "%CONFIG%", "-r", "127.0.0.1:16010", "--rpc-portal-whitelist", "127.0.0.1/32"],
    "configRevision": 0,
    "heartbeatIntervalSeconds": 20
  }
}
```

---

## 7. 管理台接口要点

只列容易踩坑的字段；完整字段以 `server/src/api/admin.ts` 为准。

* `POST /admin/nodes/enroll-key`：请求可带 `{"note": "华东-上海"}`，
  响应 `{ enrollKey, note, createdAt, command }`，其中 `command` 是给管理员复制的一键安装命令
  （注意其可用性说明见 `deploy/README.md` 第 7 节）。
* `GET /admin/rooms/:id`：**会返回 `networkSecret` 与 `aclToml`**，属于敏感信息，只给管理员。
  响应还含 `accessLog`（最近 50 条）。
* `PATCH /admin/users/:id`：`{ banned?, role?, quotaBytes?, maxRooms?, resetUsage? }`。
  不能封禁自己、不能撤销自己的管理员权限。封禁会同时删除该用户全部会话。
* `GET /admin/traffic`：`minutes` 会被裁剪到 5–10080（7 天），`scope=room|node|platform`；
  响应含 `platform.points`、`foreignNetworks`、`rooms[]`、`nodes[]`、`totals`。
* `POST /admin/relay/acl`：`aclToml` 必须包含 `[acl.acl_v1]`，否则 `400 bad_request`。
  响应 `{ ok: true, mode: "hot" | "restart" }`：`hot` 表示走 `easytier-cli acl set` 热更新，
  `restart` 表示当前 CLI 不支持，已通过重启中继生效。
* `PATCH /admin/settings`：只要请求里出现策略类键（如 `defaultMaxPlayers`）就会更新；
  `registrationOpen`、`announcement`、`clientSha256`、`defaultQuotaBytes` 支持显式 `null`。
  注意 `relayPort`、`registrationOpen`、`relayNetworkWhitelist` 的**环境变量优先级更高**
  （`GET /admin/settings` 的 `env` 字段会告诉你哪些被环境变量固定）。

---

## 8. WebSocket 协议

### 连接

```
ws(s)://<host>/ws?token=<登录令牌>
```

* 路径固定 `/ws`（常量 `WS_PATH`）。**令牌只能通过查询串传**（`?token=`）；
  未带令牌或令牌无效时连接仍会建立，但 `auth = null`，只能订阅公开话题。
* 连接建立后服务端立即下发 `hello`。
* 服务端每 30 秒发一次 WebSocket ping；上一轮 ping 没有 pong 的连接会被 terminate。
  客户端可自行发 `ping` 帧做应用层保活。

### 握手后的帧

服务端 → 客户端：

```json
{ "type": "hello", "serverTime": "2026-01-01T08:00:00.000Z", "version": "0.1.0", "topics": ["user:u_ab12cd", "platform"] }
```

说明：`hello` 里的 `version` 目前是硬编码的 `"0.1.0"`（与 `APP_VERSION` 一致）。

客户端 → 服务端：

| 帧 | 说明 |
| --- | --- |
| `{ "type": "subscribe", "topics": ["room:r_9x8y7z", "platform"] }` | 订阅；**服务端对每个话题单独鉴权**，未通过的话题被静默忽略，随后**再回一个 `hello`**（`topics` 是当前实际订阅集合） |
| `{ "type": "unsubscribe", "topics": ["platform"] }` | 退订，无回包 |
| `{ "type": "ping", "ts": 1735689600000 }` | 回 `{ "type": "pong", "ts": <原样回传>, "serverTime": "..." }` |
| 其它 `type` | 回 `{ "type": "error", "code": "bad_request", "message": "未知事件类型: xxx" }` |
| 非法 JSON | 回 `{ "type": "error", "code": "bad_request", "message": "消息不是合法 JSON" }` |

> `ClientEvent` 里还定义了 `room.heartbeat`，但 **hub 的 switch 未实现该分支**，
> 发送会收到 `未知事件类型` 错误。心跳请走 HTTP `POST /api/v1/rooms/:id/heartbeat`。

### 话题命名与权限

| 话题 | 命名 | 订阅权限（`server/src/server.ts` 的 `authorizeTopic`） |
| --- | --- | --- |
| `platform` | 固定 | 任何人（含未登录连接） |
| `traffic` | 固定 | 任何人 |
| `nodes` | 固定 | **仅管理员** |
| `rooms` | 固定 | **仅管理员** |
| `user:<userId>` | 用户私有通知 | 只能订阅自己的（`user:<自己的 id>`）；连接建立时**自动订阅** |
| `room:<roomId>` | 单个房间 | 需登录；房主**或**该房间 `status = 'active'` 的成员 |
| 其它 | — | 一律拒绝（静默不加） |

连接建立时自动订阅的话题：已登录 → `user:<自己>` + `platform`；未登录 → 无。

### ServerEvent 类型

| `type` | 载荷 | 当前是否由服务端发出 |
| --- | --- | --- |
| `hello` | `serverTime`、`version`、`topics` | ✅ 连接时与每次 `subscribe` 后 |
| `pong` | `ts`、`serverTime` | ✅ |
| `error` | `code`、`message` | ✅ |
| `traffic.tick` | `report`（`{ts,totalRxBps,totalTxBps,totalRxBytes,totalTxBytes,byRoom[],byNode[]}`） | ✅ 发到 `platform`，**最多每 6 秒一次** |
| `relay.update` | `relay`（`RelayRuntime` + `foreignNetworks`） | ✅ 发到 `traffic` |
| `node.update` | `node`（`RelayNode`） | ✅ 发到 `nodes`（节点掉线时） |
| `room.update` | `roomId`、`room` | ✅ 发到 `rooms`（房间过期/被回收时） |
| `notice` | `level`、`message`（内容是 JSON 字符串） | ✅ 发到 `platform`，每 20 秒一次的平台概览 |
| `room.members` | `roomId`、`members` | ❌ 已定义未发送 |
| `room.kicked` | `roomId`、`reason` | ❌ 已定义未发送（踢人靠 HTTP 心跳轮询，见 `architecture.md`） |
| `room.acl` | `roomId`、`aclToml`、`revision` | ❌ 已定义未发送 |
| `room.joinRequest` | `roomId`、`userId`、`displayName` | ❌ 已定义未发送 |

实现实时 UI 时，对「房间成员/审批/踢人/ACL」应以 **HTTP 轮询为主**（客户端已在心跳里覆盖），
WebSocket 只用于平台概览、流量与节点状态。

---

## 9. 与实现不一致的已知点

1. **`AgentEnrollResponse.nodeId`**：`protocol.ts` 声明注册返回 `nodeId`，服务端实际返回的是
   `node`（完整 `RelayNode`）对象，没有顶层 `nodeId`。`deploy/agent.mjs` 已同时兼容
   `data.node?.id ?? data.nodeId`。
2. **`AgentEnrollResponse.heartbeatIntervalSeconds`**：注册响应里没有该字段（只有
   `GET /agent/config` 会返回它）。agent 因此使用本地默认值 20 秒。
3. **心跳响应 `configToml` 恒为 `null`**：`NodeService.heartbeat()` 直接返回
   `configToml: null`，且 `NodeRepo.bumpConfigRevision()` 没有任何调用方，
   所以 `configRevision` 也恒为 `0`。「主控下发新配置让子节点热应用」这条链路在协议与 agent 侧
   都已实现，但**服务端还没有触发点**。
4. **`appliedConfigRevision` 未被服务端消费**（`api/agent.ts` 没读该字段）。
5. **WebSocket 事件 `room.members` / `room.kicked` / `room.acl` / `room.joinRequest` 从未发布**：
   `WsHub.sendToUser()`、`disconnectUser()`、`broadcast()` 三个方法目前也没有调用方。
6. **`ClientEvent` 的 `room.heartbeat` 未实现**（hub 只处理
   `subscribe`/`unsubscribe`/`ping`）。
7. **`Routes.agentEnroll`（`/agent/enroll`）、`Routes.agentReport`（`/agent/report`）、
   `Routes.adminRoomsLive`（`/admin/rooms/live`）已定义但未注册路由**，
   请求会得到 `404 not_found`。
8. **管理台一键安装命令指向不存在的静态文件**：`api/admin.ts` 的 `buildAgentCommand()`
   生成 `curl -fsSL <base>/agent/install.sh | ...`，但服务端只静态托管 `/downloads/` 与前端产物。
   处置办法见 `deploy/README.md` 第 7 节。
9. **`GET /api/v1/stats` 的 `users.online` 恒为 0**：`buildOverview()` 里写死
   （`WsHub.onlineUserIds()` 已实现但未接入）。
10. **`routes.stats` 无 Prometheus 端点**：`/api/v1/stats` 是平台自有的 JSON 概览；
    Prometheus 格式需要调用 EasyTier 自己的 CLI：`easytier-cli -p <rpc> stats prometheus`。
11. **`RoomPolicy.maxBandwidthKbps` 与 `allowedPorts` 的落地范围**：
    `maxBandwidthKbps` 目前在票据生成里没有对应实现（只有 `perMemberKbps` 会写入
    `instance_recv_bps_limit`）；`allowedPorts` 只在 `strictPorts = true` 时才进入 ACL 放行规则。
12. **`room_password_required` 用了 401**：语义上更接近 403，但实现是
    `new HttpError(401, ErrorCodes.ROOM_PASSWORD, ...)`，客户端应按 `code` 而不是状态码判断。
13. **`toRoom()` 会返回 `networkName`，而公开大厅是匿名可读的**：
    `GET /api/v1/rooms/public`（无需登录）返回的每个房间都带 `networkName` 与 `id`，
    而 `id` 就是网络名后缀。前端只在管理台用到 `room.networkName`，玩家端与客户端都不使用它
    （客户端用的是 `ticket.networkName`）。这是**不必要的暴露面**，建议把 `networkName`
    从 `toRoom()` 移除或只在管理台响应里附加。
14. **`GET /rooms/:id` 与 `GET /rooms/:id/members` 只校验「已登录」**，不校验成员身份：
    任何登录用户知道房间 ID 就能读到房间元信息、加入码与成员列表（含 `virtualIp`）。
    `/ticket` 与 `/acl` 是正确的（分别返回 403「你不在该房间中」/「只有房主可以执行该操作」）。
15. **主控中继兜底地址取自请求的 `Host` 头**：票据里 `nodeId: "master"` 的那条中继记录，
    在没有配置 `MCLINK_RELAY_PUBLIC_HOST` / `MCLINK_PUBLIC_BASE_URL` 时由请求 `Host` 推导，
    因此用 `http://127.0.0.1:8787` 建的房间会得到 `tcp://127.0.0.1:11010`。
    生产环境请显式配置 `MCLINK_RELAY_PUBLIC_HOST`。
