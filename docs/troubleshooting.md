# mclink 排障手册

按「症状 → 原因 → 处置」组织。先看速查表，再跳到对应小节。

---

## 0. 速查表

| 症状 | 最可能原因 | 跳到 |
| --- | --- | --- |
| 主控日志 `未找到 easytier-core` | 二进制没下载/路径不对 | §1 |
| 主控日志 `主控中继启动失败` / `进程退出，退出码 1` | 端口占用、配置非法、`bind_device`、权限 | §2、§10 |
| 管理台「CLI 不可用」告警，流量一直是 0 | `easytier-cli` 缺失或 RPC portal 不通 | §3、§8 |
| 子节点一直 `pending` | agent 没起来 / 心跳失败 / 令牌无效 | §4 |
| 建房报「当前没有可用的中继节点，请联系管理员」 | 用了 `--no-relay` 且没有在线子节点；或节点 `weight=0` | §5 |
| 客户端能登录、能看到房间，但进不去 | `bind_device`、中继地址不可达、UDP 未放行 | §6、§7 |
| 房主踢人后对方仍能连 | ACL 未应用 / 恶意客户端 / ACL 只在本实例生效 | §9 |
| 流量统计恒为 0 | CLI 缺失、RPC 端口不符、P2P 直连绕过了中继 | §8 |
| 端口 11010 被占用 | 残留 easytier-core 进程 | §10 |
| Windows 上 easytier-core panic：`SCM start an error` | 令牌受限 / 无法访问服务控制管理器 | §11 |
| `acl set` 报「不支持的子命令」 | v2.6.4 的 CLI 没有该子命令 | §12 |
| 房间建好后中继列表里有 `127.0.0.1` | 未配置公网地址，按 `Host` 头推导 | §7 |
| 改了 `MCLINK_ADMIN_PASSWORD` 却登录不上 | 该变量只在首次建号时生效 | §13 |
| WebSocket 连上但状态不刷新 | 反代没配 `/ws` 的 Upgrade 与长超时 | §14 |
| `pnpm build:web` 后 `/downloads` 或自定义静态文件消失 | `emptyOutDir` 清空了 `server/public/` | §15 |

---

## 1. 主控启动报「未找到 easytier-core」

**症状**（journald 或控制台）：

```
[error] 未找到 easytier-core（/opt/mclink/app/vendor/easytier/easytier-core）。
请运行 `pnpm fetch:easytier` 下载，或用 MCLINK_ET_CORE 指定路径。
主控仍在运行，但不会启动中继。
```

**原因**（按概率排序）：

1. 安装时 EasyTier 下载失败（受限网络、GitHub 被阻断、`--skip-easytier`）。
2. `MCLINK_ET_CORE` 指向的路径写错，或与 `--dir` 不匹配。
3. 二进制存在但没有可执行位。
4. 架构不匹配（下成了 arm64 包）。

**处置**：

```bash
# 1) 看路径与实际环境变量是否一致
grep -E 'MCLINK_ET_(CORE|CLI)' /etc/mclink/mclink.env
ls -l /opt/mclink/app/vendor/easytier/

# 2) 缺文件就补：在源码目录重跑安装（不加 --skip-easytier）
sudo bash deploy/install-server.sh

# 3) 或手动放一份并校验
sudo install -m 0755 easytier-core /opt/mclink/app/vendor/easytier/easytier-core
sudo install -m 0755 easytier-cli  /opt/mclink/app/vendor/easytier/easytier-cli
/opt/mclink/app/vendor/easytier/easytier-core --version
sudo systemctl restart mclink-server

# 4) 受限网络：设置代理后重试
export HTTPS_PROXY=http://<代理>:<端口>
sudo -E bash deploy/install-server.sh
```

注意：**只有中继缺失不影响控制面**。管理员仍可登录、建子节点；只是没有主控自带中继，
房间必须依赖子节点（否则见 §5）。

---

## 2. 主控中继启动失败

**症状**：日志出现 `主控中继启动失败`，或 `GET /admin/overview` 的
`relay.running = false`，`relay.lastError` 有内容。
常见 `lastError`：

| `lastError` | 原因 | 处置 |
| --- | --- | --- |
| `easytier-core 不存在: <路径>` | 见 §1 | §1 |
| `进程退出，退出码 1` | 配置非法/端口占用/无权限 | 看 `/opt/mclink/data/logs/relay.log` 尾部真实报错 |
| `配置文件不存在: <路径>` | 数据目录不可写（权限/加固项） | `ls -ld /opt/mclink/data`；确认 `ReadWritePaths` 覆盖它 |
| `启动失败: spawn ... EACCES` | 二进制没有执行权限 | `chmod 755` |

**排查步骤**：

```bash
# 1) 先看生成出来的配置是否合理
cat /opt/mclink/data/easytier/relay.toml

# 2) 看中继进程自己的日志（真正的报错在这里）
tail -n 80 /opt/mclink/data/logs/relay.log

# 3) 手工跑一次，把错误直接打出来
sudo -u mclink /opt/mclink/app/vendor/easytier/easytier-core \
  -c /opt/mclink/data/easytier/relay.toml \
  -r 127.0.0.1:15888 --rpc-portal-whitelist 127.0.0.1/32

# 4) 确认端口没被别的东西占着
ss -lntup | grep -E '11010|15888'
```

**典型配置错误**：把 `rpc_portal` 写进 TOML。它不是配置文件字段，会被**静默忽略**，
导致实例退回默认 15888，多实例互相抢占（见 §8 与 `security.md` §4.3）。
请只用命令行 `-r`。

---

## 3. `easytier-cli` 不可用

**症状**：启动日志里 `easytier-cli 探测失败，流量统计与 ACL 下发将不可用`；
管理台「中继」页显示 `cliAvailable = false`；`GET /admin/overview` 里 `relay.cliVersion = null`。

**原因**：`MCLINK_ET_CLI` 指向的文件不存在 / 不可执行 / 架构不对；或 CLI 与 core 版本差异过大。

**处置**：

```bash
grep MCLINK_ET_CLI /etc/mclink/mclink.env
/opt/mclink/app/vendor/easytier/easytier-cli --version     # 期望输出 easytier-cli 2.6.4-...
```

补齐后重启主控即可。**影响范围**：流量统计、ACL 下发、中继 peer 列表全部失效，
但**房间联机本身不受影响**（票据是主控自己生成的，不依赖 CLI）。

---

## 4. 子节点一直 `pending` 不转在线

**机制**：注册成功后节点状态是 `pending`，**第一次成功心跳**才转为 `online`
（`NodeService.heartbeat()`）。心跳间隔默认 20 秒，90 秒无心跳判定离线。

**原因与处置**：

| 检查点 | 命令 / 位置 | 常见问题 |
| --- | --- | --- |
| 服务是否在跑 | `systemctl status mclink-node` | 端口/路径参数错误导致 ExecStart 失败 |
| agent 日志 | `journalctl -u mclink-node -f` | 看 `注册失败` / `心跳鉴权失败` / `心跳失败` |
| 主控可达性 | `curl -sS -o /dev/null -w '%{http_code}\n' https://cnnic.link/api/v1/meta` | DNS、出网被墙、证书过期 |
| 令牌是否落盘 | `ls -l /etc/mclink/node-token.json` | 目录权限不对（必须 owner mclink:600） |
| 节点是否被禁用 | 管理台节点页 | `disabled: true` 时 agent 会主动停核心 |
| region 是否合法 | 日志里主控返回 `未知区域` | 必须用内置区域 id |

**注册相关的特定错误**：

* `注册密钥无效 / 已被使用 / 已被吊销`：注册密钥是**一次性**的。
  令牌文件还在的话**不要重新注册**；令牌丢了就在管理台重新签发一把。
* `该 endpoint 已被其它节点注册`：`endpoint` 全局唯一。旧的同 endpoint 记录还在
  （换机器、重装系统时很常见）→ 在管理台删掉旧节点，或改 `--endpoint`。
* agent 启动报 `尚未注册且没有可用的注册密钥`：`node.env` 里的 `MCLINK_NODE_ENROLL_KEY`
  被清空了且本地没有令牌 → 重新签发密钥后带 `--key` 跑一次。

**验证心跳是否真的到了主控**：

```bash
# 主控侧看审计日志里的 node.online / node.offline 事件
journalctl -u mclink-server | grep -E 'node\.(online|offline)'
```

---

## 5. 房间创建失败：「当前没有可用的中继节点，请联系管理员」

**判定逻辑**（`RoomService.create()`）：

```
relayNodeIds = scheduleRelays(zone)      # 只从 online/degraded 且 disabled=0 且 weight>0 的节点里挑
if (relayNodeIds.length === 0 && !masterRelayAvailable()) throw 503 当前没有可用的中继节点
```

`masterRelayAvailable()` = `MCLINK_AUTOSTART_RELAY=true` **且** `MCLINK_RELAY_PORT > 0`。

**原因与处置**：

1. 部署时用了 `--no-relay`（`MCLINK_AUTOSTART_RELAY=false`）且没有任何在线子节点
   → 至少让一个子节点 `online`，或删掉该行并重启主控。
2. 有子节点但都在 `pending` / `offline` → 见 §4。
3. 子节点 `weight = 0`（管理员设过）→ 调度器**不会**选它
   （`listSchedulable()` 要求 `weight > 0`）。管理台把它改回 100。
4. 全部子节点被停用（`disabled = 1`）→ 启用或删掉。
5. 指定了区域但该区域没有节点 → **不会报错**，会回退到全局调度并打 `warn`：
   `指定区域没有可用节点，回退到全局调度`。所以「指定区域建房失败」通常还是上面 1–4 条。
6. 虚拟网段耗尽（256 个 `/24` 全被占用）→ 报的是「虚拟网段已耗尽」（不同文案）；
   关掉一些房间即可（`expiresAt`/空房回收会释放）。

---

## 6. 客户端能登录但进不了房间（最高频问题）

### 6.1 先分清三种表现

| 表现 | 大概率原因 |
| --- | --- |
| 点了「进入房间」什么也没发生，客户端核心状态 `error` | 本地 easytier-core 起不来（路径/端口/permission） |
| 核心 `running`，但始终看不到房主、MC 里连不上 | 连不上中继（地址不对 / 端口没放行 / `bind_device`） |
| 核心 `running`，能看到别人但延迟极高/丢包 | P2P 失败走了中继，或中继带宽打满 |

### 6.2 `bind_device` 的坑（**重点**）

EasyTier 的 `bind_device` 默认 `true`，会把隧道的出站套接字绑定到指定网卡。
在受限容器、多网卡、Windows 沙箱等环境会直接报 `WSAEADDRNOTAVAIL (10049)`，
现象就是**能登录主控、但永远进不了房间**。

平台已经在三处统一设为 `false`：

* 主控中继：`server/src/easytier/manager.ts` → `bindDevice: false`
* 子节点：`server/src/services/nodes.ts` 的 `renderNodeConfig()` → `bindDevice: false`
* 客户端：`server/src/services/rooms.ts` 的 `ticket()` → `bindDevice: false`
  （客户端 `client/electron/main.cjs` 只把票据里的 TOML 原样落盘）

**验证**：

```bash
# 主控/子节点生成的配置里应当有
grep -n 'bind_device' /opt/mclink/data/easytier/relay.toml /etc/mclink/relay.toml
# 期望： bind_device = false

# 客户端配置（Windows）
type "%APPDATA%\mclink\easytier\relay.toml" | findstr bind_device
```

**如果是自己手工改过配置**：不要改生成的文件（下次同步会被覆盖）；
请在源码里改或提 issue。临时验证可以手工设 `bind_device = false` 再重启实例。

### 6.3 中继地址不可达

票据里的 `relays[]` 来自「子节点 endpoint」+「主控兜底地址」。主控兜底地址按
`MCLINK_RELAY_PUBLIC_HOST` → `MCLINK_PUBLIC_BASE_URL` → 请求 `Host` 头的顺序推导。
**如果都为空**，就会用请求里的 Host —— 于是用 `http://127.0.0.1:8787` 建的房间，
票据里会出现 `tcp://127.0.0.1:11010`，别的机器当然连不上。

```bash
# 看看票据到底给了什么地址
curl -s -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:8787/api/v1/rooms/<roomId>/ticket" | grep -o 'tcp://[^"]*'
```

**处置**：在 `/etc/mclink/mclink.env` 里显式配置并重启：

```
MCLINK_RELAY_PUBLIC_HOST=relay.cnnic.link
MCLINK_PUBLIC_BASE_URL=https://cnnic.link
```

（`install-server.sh --public-url` / `--relay-public-host` 会自动写入。）
另外管理台上修改节点 `endpoint` 也要确保是公网可达的 `host:port`。

### 6.4 端口没放行

中继同时监听 **TCP 与 UDP** 的同一个端口。只放行 TCP 会导致打洞失败、UDP 探测被丢，
表现为「有时能连、延迟很高」或「完全连不上」。

```bash
sudo ufw status | grep 11010
# 期望同时有 11010/tcp 与 11010/udp
# 云服务器还要检查安全组（两处都要放行）
```

### 6.5 客户端本地问题

* 本地监听端口被占用（客户端默认也是 11010）：换一个 `listenPort`（客户端设置里可改）。
* 客户端找不到 `easytier-core`：`pnpm fetch:easytier` 或重装客户端。
* 客户端 easytier-core panic：见 §11。

---

## 7. 票据里出现内网/本机地址

见 §6.3。补充说明：`relayNodes` 里子节点的地址来自管理台登记（`PATCH /admin/nodes/:id` 的
`endpoint`）；主控兜底地址来自环境变量或 `Host`。**两者都要是玩家能访问的公网地址**。

---

## 8. 流量统计恒为 0

**数据来源**：主控每 5 秒调一次 `easytier-cli -p <rpc> -o json peer list` 与 `peer list-foreign`，
用相邻两次采样的差分算 bit/s。子节点则由 agent 每 20 秒上报 `roomTraffic`。

**原因与处置**：

| 原因 | 验证方式 | 处置 |
| --- | --- | --- |
| `easytier-cli` 不可用 | 见 §3 | 补齐 CLI |
| RPC portal 不通 | `easytier-cli -p 127.0.0.1:15888 peer list` 手工执行 | 确认 `MCLINK_RELAY_RPC` 与实际一致；确认没有多实例抢占 15888 |
| 中继没在跑 | `relay.running = false` | 见 §2 |
| **房间全走 P2P 直连** | 房间内成员显示 `p2p = true` | 这是**正常**的：直连流量不经过中继，中继侧的字节数自然接近 0。想统计到流量就关掉房间策略的 `allowP2p` |
| 子节点没上报 | 子节点 `rooms` 字段一直是 0 | 子节点上 `easytier-cli` 缺失或 RPC 端口推导不一致（应为 `16000 + endpoint端口 % 1000`） |
| 采样被限速/超时 | 日志 `采集主控中继状态失败` | 机器负载过高或 CLI 卡死；看日志里的具体报错 |
| 只是还没等到第二轮采样 | — | 首轮采样只记录总量不算速率，等 5–10 秒 |

**手工核对**：

```bash
# 主控中继的 peer 与外来网络（JSON 里字段是 snake_case，数值是人类可读字符串如 "17.33 kB"）
/opt/mclink/app/vendor/easytier/easytier-cli -p 127.0.0.1:15888 -o json peer list
/opt/mclink/app/vendor/easytier/easytier-cli -p 127.0.0.1:15888 -o json peer list-foreign

# 全局计数器（traffic_bytes_forwarded 才是"转发出去"的字节）
/opt/mclink/app/vendor/easytier/easytier-cli -p 127.0.0.1:15888 stats show
```

注意：**数据保留 72 小时**（`app.traffic.prune(72)`），所以「昨天的曲线」查不到是正常的。

---

## 9. 房主踢人后对方仍能连

**机制**（先搞清楚它能做什么，再看为什么没生效）：

1. `POST /api/v1/rooms/:id/kick` 把成员标成 `kicked`，**递增 ACL 版本**，并返回新的 `aclToml`。
2. **ACL 是每个 EasyTier 实例各自持有的，不会在网络里同步**。这条 Drop 规则只加在
   **房主自己的实例**上（`buildRoomAcl()`：`source_ips = ["<被踢者虚拟IP>/32"]`，action = Drop）。
3. 被踢者自己的客户端在**下一次心跳**时收到 `{ kicked: true }`，然后停止本地 easytier-core。
4. 房主客户端在心跳里发现 `aclRevision` 变化后，把新 ACL 应用到本地实例
   （支持 `acl set` 就热更新，v2.6.4 不支持 → 写回配置并重启实例，约 2 秒断线）。

**所以"仍能连"有四种可能**：

| 可能 | 说明 | 处置 |
| --- | --- | --- |
| 房主客户端还没应用 ACL | 取决于心跳间隔 + 重启耗时，最长几十秒 | 点房间页的「立即重新应用规则」；或等下一轮心跳 |
| 被踢者是**改过的客户端** | 不理会 `kicked`，继续跑自己的 easytier-core | 见下 |
| 被踢者在和其它**成员**通信 | Drop 规则只在房主实例上，成员实例没有这条规则（P2P 直连根本不经过房主） | 见下 |
| 房主实例重启中 | 支持热更新前有约 2 秒窗口 | 正常现象 |

**决定性处置：轮换房间密钥。**

```
房主 → 房间设置 → 「轮换网络密钥」
POST /api/v1/rooms/:id/rotate-secret
```

因为网络名由密钥派生（`deriveNetworkName()`），轮换会**同时换掉网络名**，
被踢者手里的旧网络名在中继上不再命中 `mclink-room-*` 白名单，**立即被中继拒绝**；
所有正常成员重新取票据即可恢复（加入码不变）。这是唯一对恶意客户端有效的手段。

另外注意：被踢成员的**虚拟 IP 不会被回收**（保留在成员表里并进入 ACL 黑名单），
所以真人回头再进来会走新 seat。

---

## 10. 端口 11010 被占用

**症状**：中继日志里 `bind: address already in use` / `进程退出，退出码 1`；
或启动后客户端全连不上（其实连到了别的进程）。

**排查**：

```bash
# Linux
ss -lntup | grep -E ':11010|:15888'
sudo lsof -iTCP:11010 -sTCP:LISTEN
sudo lsof -iUDP:11010

# Windows（PowerShell）
Get-NetTCPConnection -LocalPort 11010 -ErrorAction SilentlyContinue
Get-NetUDPEndpoint    -LocalPort 11010 -ErrorAction SilentlyContinue
```

**原因**：上次没退干净的 easytier-core（`KillMode=mixed` 已尽量规避，但手工 `kill` 主控
可能留下孤儿进程）；或与别的服务（另一个 VPN、别的 EasyTier 实例）冲突。

**处置**：

```bash
# 杀掉残留实例（先确认它就是 easytier-core）
sudo pkill -f 'easytier-core.*relay.toml'
sudo systemctl restart mclink-server
```

或改端口：`--relay-port 11011`（同时放行新端口的 TCP+UDP），
**并让客户端重新取票据**（票据里的中继地址已变；老房间的票据需重新获取）。

---

## 11. Windows 上 easytier-core 因 SCM 报错 panic

**症状**：

* 进程立刻退出，CWD 下生成 `easytier-panic.log`：

  ```
  panic info: SCM start an error: IO error in winapi call
  location: easytier\src\core.rs:1562:17
  os: windows / arch: x86_64 / version: 2.6.4-8428a89d
  ```

* 客户端核心状态 `error`，`coreError` 里带 `SCM`。

**原因**：EasyTier 在 Windows 上启动时**总会**先尝试把自己注册成 Windows 服务：

```rust
// easytier/src/core.rs
match windows_service::service_dispatcher::start(String::new(), ffi_service_main) {
    Ok(_) => std::thread::park(),
    Err(e) => {
        let should_panic = if let windows_service::Error::Winapi(ref io_error) = e {
            io_error.raw_os_error() != Some(0x427)   // ERROR_FAILED_SERVICE_CONTROLLER_CONNECT
        } else { true };
        if should_panic { panic!("SCM start an error: {}", e); }
    }
};
```

* 正常**控制台启动**时，`service_dispatcher::start()` 返回
  `ERROR_FAILED_SERVICE_CONTROLLER_CONNECT (0x427 = 1063)`，这是**预期**的，不会 panic。
* 但如果拿到的是**别的** Winapi 错误（最常见是 `ERROR_ACCESS_DENIED (5)`），就会 panic。
  典型触发场景：**受限令牌**（去特权/低完整性进程）、被服务或沙箱包装启动、
  环境里无法访问服务控制管理器（SCM）。

**处置**：

1. 用**普通交互用户**的正常令牌启动（不要用去特权/受限令牌，不要跑在
   受限作业对象或服务宿主里）。
2. 平台侧：客户端由 Electron **主进程**以当前用户权限启动 easytier-core；
   不要用「以管理员/受限方式运行」的包装脚本去起它。
3. 如果必须在服务/无交互环境里跑 mclink 的**中继**端，请用 Linux（Debian）——
   服务端场景本来就不需要 Windows。
4. 临时验证：在普通 PowerShell 里手工执行

   ```powershell
   & "$env:APPDATA\mclink\vendor\easytier\easytier-core.exe" -c "$env:APPDATA\mclink\easytier\relay.toml" -r 127.0.0.1:16010
   ```

   能正常起来说明就是令牌/启动上下文的问题。

---

## 12. `acl set` 不支持

**症状**：

* `POST /api/v1/admin/relay/acl` 的响应是 `{"mode":"restart"}` 而不是 `"hot"`；
* 或客户端日志出现「当前 easytier-cli 不支持 acl set，改为重启实例」。

**原因**：`acl set` 是 EasyTier **较新版本**才加入的子命令。v2.6.4 的命令树里只有 `acl stats`：

```
$ easytier-cli acl --help
Commands:
  stats  Show ACL rule hit statistics
```

平台因此做了**能力探测**而不是假定存在：

* 服务端：`RelayManager.supportsAclSet()`（跑 `acl --help` 看有没有 `set`）；
* 客户端：`client/electron/main.cjs` 的 `supportsAclSet()`。

**处置**：

* 这是**预期行为**，不是故障。降级路径是「把 ACL 追加进配置 → 重启实例」，
  管理操作低频、房主断线约 2 秒，可接受。
* 想热更新：升级 EasyTier 到带 `acl set` 的版本，然后
  `node scripts/fetch-easytier.mjs --version vX.Y.Z` 并替换 `vendor/easytier/` 下的二进制，
  重启服务。
* 想确认当前能力：`easytier-cli acl --help`，或看管理台「中继」页的提示。

---

## 13. 改了 `MCLINK_ADMIN_PASSWORD` 却登录不上

**原因**：`MCLINK_ADMIN_PASSWORD` **只在首次建号时生效**
（`ensureBootstrapAdmin()`：已存在同名账号就直接返回，不会改密码）。

**处置**（任选）：

1. 用旧密码登录 → 「账号设置」→ 修改密码（改后所有旧会话立即失效）。
2. 其它管理员在管理台重置该用户（`PATCH /admin/users/:id` 只支持封禁/角色/配额，
   **不支持改密码**，所以还是得走 1）。
3. 彻底重置（慎用，会丢掉该账号）：

   ```bash
   sudo systemctl stop mclink-server
   sudo sqlite3 /opt/mclink/data/mclink.sqlite "select id, username, role from users;"
   # 删除 admin 账号后重启，主控会用 MCLINK_ADMIN_PASSWORD 重新建号
   #（只有在"库里没有其它用户"时才会重建，注意先确认）
   sudo systemctl start mclink-server
   ```

   更稳的做法：先用另一个管理员账号登录，把密码改回来。

---

## 14. WebSocket 连上但状态不刷新

**症状**：页面能打开、API 正常，但在线人数/流量不更新；浏览器控制台报
`WebSocket connection failed` 或反复重连。

**原因**：反向代理没有正确透传升级头 / 超时太短：nginx 默认 `proxy_http_version 1.0`
会剥掉 `Upgrade`，默认 `proxy_read_timeout 60s` 会把空闲长连接切断。

**处置**：`/ws` 必须单独配置：

```nginx
location /ws {
    proxy_pass http://mclink_master;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering off;
}
```

完整示例见 `deploy/nginx.conf.example`。改完 `nginx -t && systemctl reload nginx`。

**注意**：即使 WS 断了，房间内的**业务可靠性不依赖它**——心跳、票据、踢出判定都走 HTTP
（见 `architecture.md` §3 的「踢人生效的真实链路」）。

---

## 15. 重新构建前端后静态资源消失

**症状**：`pnpm build:web` 之后，手工放到 `server/public/agent/` 下的安装脚本、
或 `server/public/downloads/` 里的安装包不见了。

**原因**：`web/vite.config.ts` 里 `emptyOutDir: true`，构建会清空输出目录
（`server/public`）。

**处置**：

* 安装包请放 `MCLINK_DATA_DIR/downloads`（即 `/opt/mclink/data/downloads`），
  不要放 `server/public`；
* 手工发布的静态文件（例如 `/agent/install.sh`，见 `deploy/README.md` §7）
  在每次重新构建前端后都要重新 `install` 一次；
* 或者写一条部署后钩子把这两类文件同步回去。

---

## 16. 其它常见小程序问题

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `pnpm dev:web` 打开 5173 但接口 404 | Vite 代理指向了别的主控 | 设 `MCLINK_MASTER=http://127.0.0.1:8787` 后重启 `dev:web` |
| `pnpm test` 报找不到测试文件 | 仓库里还没有 `server/test/` 目录 | 正常现象，见 `development.md` §3 |
| 主控页面显示「检测到前端尚未构建」 | `server/public/index.html` 不存在 | `pnpm build:web` |
| 登录提示「登录尝试过于频繁」 | 触发了 `MCLINK_LOGIN_RATE_LIMIT`（默认 20 次/分钟/IP） | 等待 1 分钟；或排查是否有人在撞库（看审计日志 `auth.login_failed`） |
| 反向代理后所有请求 IP 都是 127.0.0.1 | 反代没传 `X-Forwarded-For`，或 `MCLINK_TRUST_PROXY=false` | 配好 `proxy_set_header X-Forwarded-For` 并保持 `TRUST_PROXY=true` |
| 隐藏房间在大厅看不到 | 这是预期（`visibility=hidden`） | 用加入码进房 |
| 建房提示「最多同时创建 N 个房间」 | `defaultMaxRooms`（默认 3）或用户 `maxRooms` | 关掉旧房间，或调大平台默认值/用户配额 |
| 房间过一段时间自己关闭了 | TTL（默认 720 分钟）或空房回收（默认 600 秒无心跳） | 调整 `roomTtlMinutes` / `MCLINK_ROOM_IDLE_TIMEOUT` |
