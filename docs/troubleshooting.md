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
| 客户端 `failed to listen` / `os error 10048` / `10013` | 残留 easytier-core 占端口、其它虚拟网络软件、Windows 保留端口段 | §17 |

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
2. **下载成功但解压失败** —— 这个坑很隐蔽：EasyTier 官方只发 **zip**，而 Debian 的
   GNU `tar` **不能解 zip**。2026-09 之前的脚本用 `tar -xf xxx.zip`，于是"下载 24 MB 成功、
   二进制却没落地"，日志里只有一句"压缩包解压失败"。现已改用 `unzip`（并写进依赖），
   缺失时依次退让到 `bsdtar` / `python3 -m zipfile`。
3. `MCLINK_ET_CORE` 指向的路径写错，或与 `--dir` 不匹配。
4. 二进制存在但没有可执行位。
5. 架构不匹配（下成了 arm64 包）。

**处置**：

```bash
# 1) 看路径与实际环境变量是否一致
grep -E 'MCLINK_ET_(CORE|CLI)' /etc/mclink/mclink.env
ls -l /opt/mclink/app/vendor/easytier/

# 2) 缺文件就补：在源码目录重跑安装（不加 --skip-easytier）
#    国内机器建议带加速前缀，否则第 1 步就可能超时
sudo bash deploy/install-server.sh --github-proxy https://ghproxy.net/

# 3) 或手动放一份并校验
sudo install -m 0755 easytier-core /opt/mclink/app/vendor/easytier/easytier-core
sudo install -m 0755 easytier-cli  /opt/mclink/app/vendor/easytier/easytier-cli
/opt/mclink/app/vendor/easytier/easytier-core --version
sudo systemctl restart mclink-server

# 4) 受限网络：设置代理后重试
export HTTPS_PROXY=http://<代理>:<端口>
sudo -E bash deploy/install-server.sh

# 5) 完全不想碰 GitHub：在开发机 pnpm fetch:easytier --all 后
#    把 deploy/vendor/linux-x86_64/ 两个文件拷到上面的目录，再 chmod 0755
```

**自查**（确认新脚本真的能解官方 zip）：

```bash
command -v unzip || sudo apt-get install -y unzip
unzip -l /tmp/et.zip | head    # 能列出内容就说明解压工具没问题
```

注意：**只有中继缺失不影响控制面**。管理员仍可登录、建子节点；只是没有主控自带中继，
房间必须依赖子节点（否则见 §5）。控制台「主控中继」页现在会直接告诉你是"没找到二进制"
还是"没启用中继"（见 `diagnostics`），不用再去翻日志。

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

* **`注册密钥已被使用` + restart counter 一直涨**（实测踩过：查到 132 次）：
  这是最隐蔽的一种 —— **第一次注册其实成功了**，密钥被消耗掉，但 agent 没能把节点令牌
  写到 `/etc/mclink/node-token.json`（早期版本 `install-node.sh` 漏了把 `/etc/mclink`
  归属给 `mclink` 用户，目录是 root:0750，agent 以 `mclink` 身份跑，写不进去）。
  于是每次重启都拿同一把废密钥去注册，systemd 就无限重启。

  ```bash
  # 1) 先确认令牌到底在不在、目录归属对不对
  ls -l /etc/mclink/node-token.json
  ls -ld /etc/mclink
  #   期望 owner 是 mclink:mclink；若是 root:root，就是这个问题

  # 2) 停掉循环、修归属
  sudo systemctl stop mclink-node
  sudo chown -R mclink:mclink /etc/mclink

  # 3) 到管理台「节点」页**重新签发**一把注册密钥（旧的那把已经用掉了），
  #    然后用新命令重跑安装脚本
  ```

  现在的版本不会再把密钥白白烧掉：agent 在注册**之前**会先探测状态目录是否可写，
  不可写就直接报错退出（退出码 3）并明确告诉你"密钥还没被消耗"。
  单元文件也加了 `RestartPreventExitCode=3` 与 `StartLimitBurst=10`，
  配置类错误不会再来一次无限重启。
* `找不到 mclink-node.service（应与 install-node.sh 放在同一目录）`：
  用 `curl | sudo bash` 一键安装时目标机上没有仓库，自然也没有这个文件（2026-09 之前的脚本
  在这个场景下必然失败）。现在脚本会依次找：本机同目录 → `--source`/父目录的 `deploy/` →
  **从主控下载** `${MASTER}/agent/mclink-node.service`。若三条路都不通，手工放一份到脚本同目录即可。
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

## 5. 房间创建失败：「当前没有可用的中继节点，暂时无法建房」

**判定逻辑**（`RoomService.create()`）：

```
relayNodeIds = scheduleRelays(zone)      # 只从 online/degraded 且 disabled=0 且 weight>0 的节点里挑
if (relayNodeIds.length === 0) throw 503 当前没有可用的中继节点
```

2026-09-27 起**主控不再兜底**：以前这里是 `&& !masterRelayAvailable()`，现在只要
`relayNodeIds` 为空就报错（`masterRelayAvailable()` = `MCLINK_AUTOSTART_RELAY=true`
**且** `MCLINK_RELAY_PORT > 0` 仍然保留，但只服务于单机自查与"把主控注册成普通子节点"，
不再影响建房判定）。

**原因与处置**：

1. 一个可调度的在线子节点都没有（`--no-relay` / `MCLINK_AUTOSTART_RELAY=false` 不再有影响：
   主控自己不再兜底）→ 至少让一个子节点 `online`。
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

票据里的 `relays[]` **只**来自子节点（2026-09-27 起主控不再兜底），地址取的是节点
`endpoint` 的**链接端口**（不是本机运行端口，规则在 `db/nodes.ts` 的 `nodeClientEndpoint()`）。
历史上票里还会多一条"主控兜底"地址，它按
`MCLINK_RELAY_PUBLIC_HOST` → `MCLINK_PUBLIC_BASE_URL` → 请求 `Host` 头推导，
用 `http://127.0.0.1:8787` 建房就会下发 `tcp://127.0.0.1:11010`；**这条已经取消** ——
票据里不可能再出现主控端点，所以"地址不可达"现在一定是子节点 `endpoint` 本身的问题。

```bash
# 看看票据到底给了什么地址
curl -s -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:8787/api/v1/rooms/<roomId>/ticket" | grep -o 'tcp://[^"]*'
```

**处置**：管理台上该节点的 `endpoint` 必须是公网可达的 `host:port`（票据下发的就是它，端口取
「链接端口」）。`MCLINK_RELAY_PUBLIC_HOST` / `install-server.sh --relay-public-host` 只在
「把主控注册成一台普通子节点」时才有意义，改它**不会**再影响任何票据。

### 6.4 端口没放行

中继同时监听 **TCP 与 UDP** 的同一个端口。只放行 TCP 会导致打洞失败、UDP 探测被丢，
表现为「有时能连、延迟很高」或「完全连不上」。

```bash
sudo ufw status | grep 11010
# 期望同时有 11010/tcp 与 11010/udp
# 云服务器还要检查安全组（两处都要放行）
```

另外，**客户端建房页那一列的延迟数字就是对中继链接端口做 TCP 握手**
（不是 ICMP，见 `client/electron/tcping.cjs`；每个节点连打 3 次取最快的一次，
所以偶发丢一两个包不会让读数变成「—」）：

* 显示「—」= **连续 3 次握手都没成功**，即这台机器从玩家的网络连不上那个端口
  （安全组/防火墙只放行了 UDP、或域名解析不过去）。这比过去用 ICMP 更有意义 ——
  那时端口被挡着也照样显示「12 ms」。
* 只有个别玩家看到「—」时先怀疑他那一侧的网络；所有玩家都看到「—」时从本节开始查。
* 探测会在中继侧留下「连上就断」的记录（每个节点每次测速 3 条），中继日志里看到属于正常现象。

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

## 16. 连上虚拟网络后，其它软件上不了网（例如网易云音乐）

**症状**：客户端一连上房间，浏览器/音乐软件/游戏启动器里有**部分软件**连不上网
（不是全部断网，这也是它难查的地方）。断开房间后恢复正常。

**原因**：房主的房间策略里打开了「局域网广播直通」（`allowBroadcast`）。
它在 Windows 上依赖 **WinDivert 内核网络过滤驱动**去抓物理网卡的 UDP 广播，
也就是说这台机器被装了一个**系统级网络驱动**，与某些软件的网络栈冲突。

判据（能直接坐实）：

```powershell
sc.exe qc windivert
#   BINARY_PATH_NAME 会指向 mclink 客户端自带的 EasyTier 目录，例如
#   \??\C:\Users\<你>\AppData\...\mclink\...\WinDivert64.sys
sc.exe query windivert        # STATE : RUNNING
```

**处置**：

1. **首选**：房主在客户端「房间规则 → 局域网广播直通」里改成**关闭**（这是默认值），
   然后重新进房一次让核心用新配置重启。MC 联机照常：把房主的虚拟地址发给朋友，
   用「多人游戏 → 直接连接」粘贴即可。
2. 已经装上的驱动不会自动卸载，但**不加载就不影响**：关闭开关后重启客户端即可。
   彻底移除：`sc.exe stop windivert && sc.exe delete windivert`（需要管理员）。
3. 如果确实需要"局域网列表里直接看到房间"，可以接受这个代价再打开；建议只让
   **不装其它网络类软件的机器**当房主。

**为什么默认关闭**：EasyTier 官方默认同样是关的。这个开关买到的是"MC 局域网列表里直接看到房间"
这一条便利，代价是在**每个玩家的机器**上装一个系统级网络驱动 —— 产品上不划算，
所以改成房主按需开启（见 `RoomPolicy.allowBroadcast` 的注释）。

---

## 17. 客户端连不上：`failed to listen` / `os error 10048` / `10013`

**症状**：点了「连接」之后房间页一直停在「正在建立连接」，客户端的核心日志里能看到

```
failed to listen ... os error 10048     （地址已在使用）
failed to listen ... os error 10013     （权限不足 / 落在系统保留端口段）
```

**原因**（按出现频率）：

1. **上一次的 easytier-core 没退干净**。客户端被任务管理器强杀、或自己崩掉时，
   子进程会继续活着，占着虚拟网卡与监听端口。
   现在客户端会在启动 1.2 秒后自动清理**自己的**残留进程
   （只按可执行文件路径匹配自家 `vendor/easytier` 目录，不会动你另外装的 EasyTier）。
   只在单实例锁失效的老版本上才需要手工处理。
2. **机器上还有别的虚拟网络软件**（官方 EasyTier、其它联机工具、Docker/Hyper-V 的端口保留段）
   占着同一个端口，或该端口落在 `netsh int ipv4 show excludedportrange protocol=tcp`
   列出的保留段里 —— 后者会报 **10013** 而不是 10048。
3. 首次绑定失败时客户端会**自动清理并重试一次**；重试仍失败就会明确报
   「监听端口被占用」并停止核心，而**不会**假装已连接。

**处置**：

```powershell
# 1) 看是不是自家残留（路径指向客户端安装目录才算）
Get-CimInstance Win32_Process -Filter "Name='easytier-core.exe'" |
  Select-Object ProcessId, ExecutablePath

# 2) 看端口落在哪些保留段里（Hyper-V / WSL / Docker 会占段）
netsh int ipv4 show excludedportrange protocol=tcp

# 3) 端口被别的软件占着（把 12411 换成日志里的实际端口）
Get-NetTCPConnection -LocalPort 12411 -ErrorAction SilentlyContinue |
  Select-Object OwningProcess, State
```

处置顺序：**完全退出客户端 → 重新打开 → 再连接**（新版会自动清残留）；
仍有问题就关掉其它虚拟网络软件再试。

> 监听端口与 RPC 端口都由客户端在本机探测后上报给主控，所以正常情况下不会
> 撞上保留端口段：`listen(0)` 拿到的端口天然不来自被系统排除的段。
> RPC 端口只绑 `127.0.0.1`，机内可见、局域网不可见。

---

## 18. 客户端/网页报「主控返回了非 JSON 响应（HTTP 502/503/504）」

**症状**：界面弹这句话。它说明**响应根本不是主控发的**——主控永远回 JSON，
这个 HTML 错误页来自反向代理。

| 状态码 | 含义 | 常见原因 |
| --- | --- | --- |
| 502 | 反代连不上主控 | 主控没起来 / 正在重启 / `proxy_pass` 端口写错 |
| 503 | 反代认为后端不可用 | 上游被摘除、连接数打满 |
| 504 | 反代**等到了主控，但主控没在超时内回** | 请求处理过慢，或反代超时设得太小 |

### 18.1 先看 nginx 错误日志里那句话的主语——`connecting` 还是 `reading`

这两类是完全不同的问题，**反代配置要调的地方也不同**：

| 日志原文 | 卡在哪个阶段 | 该调的指令 |
| --- | --- | --- |
| `while **connecting** to upstream` | TCP 握手就没成 → 主控那一瞬间没在 accept | `proxy_connect_timeout`（默认 60s） |
| `while **reading** response header` | 连上了但主控迟迟不回 | `proxy_read_timeout` |

线上真实案例：日志里全是 `while connecting to upstream`，而且**连 `/assets/*.css`、`/favicon.ico`
都超时**（不是某个接口慢，是整站不可达）。这类问题在主控侧有两个已知来源：

1. **主控自己按住了事件循环**（同步 SQLite）。已修：流量采样的定期清理原来是
   一条 `delete from traffic_samples where ts < ?` 删光 72 小时前的数据 ——
   稳定约 30 万行、30 万行一条 DELETE 实测阻塞事件循环 749ms（慢盘上更久），
   期间内核 accept 队列塞满、SYN 被丢，外部看到的就是 connect 超时。
   现在按 rowid 每批 5000 行删、批间让出事件循环（实测最坏阻塞 53ms）。
   **升级到含此修复的版本后这类才不会再出现。**
2. **反代到主控那一跳的网络**（尤其 nginx 与主控不在同一台机器、且走公网 IP）。

### 18.2 三步定位

```bash
# ① 主控这段有没有重启/崩溃（重启能解释"整站不可达"），以及跑的是不是带看门狗的版本
journalctl -u mclink-server --since '6 hours ago' | grep -E '已就绪|收到 SIGTERM|已安全退出' | tail
grep -c '请求仍未返回' /opt/mclink/app/server/src/server.ts    # 0 = 旧代码，日志当然抓不到慢请求

# ② 连接层面的现场（在跑主控的机器上）
ss -s | head -3
cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max
dmesg -T | grep -iE 'conntrack|drop|SYN' | tail
systemctl status mclink-server --no-pager | head -12          # 看有没有 OOM / Restart 计数

# ③ 从 nginx 那台机器持续探测这一跳（这是最直接的判据）
for i in $(seq 1 120); do
  curl -s -o /dev/null -w '%{http_code} connect=%{time_connect}s total=%{time_total}s\n' \
    --max-time 3 http://<主控IP>:8787/api/v1/meta
  sleep 1
done | tee /tmp/probe.log | sort | uniq -c | sort -rn | head
```

判读：出现 `000`（连不上）或 `connect=` 偶发跳到数秒 → **是那一跳的网络**，不是主控；
若全是 `200 connect=0.00x` → 主控侧问题（回到 ②③ 与 §18.1 的第 1 条）。

### 18.3 反代侧的两条硬要求

```nginx
proxy_connect_timeout 5s;    # 别用默认 60s：上游卡住时快速失败（访问日志里变成 502，失败率看得见）
proxy_read_timeout  3600s;   # 要大于主控的 MCLINK_REQUEST_DEADLINE_MS（默认 110s）
```

**nginx 与主控能走内网就别走公网**：`proxy_pass` 指向 `127.0.0.1:8787` 或内网地址，
少一跳跨网链路，这类超时会大幅减少。

> 附带一条与故障无关但很吵的：`sudo: unable to resolve host <主机名>` 是 hostname 没进
> `/etc/hosts`，每次 sudo 都在等 DNS。`echo "127.0.1.1 $(hostname)" >> /etc/hosts` 即可。


**先分清是谁的问题**：

```bash
# 1) 主控自己在不在、快不快（绕开反代直连本机端口）
curl -s -o /dev/null -w 'direct %{http_code} %{time_total}s\n' http://127.0.0.1:8787/api/v1/meta
# 2) 反代超时设了多少（对照 /api/ 与 / 两个 location）
sudo grep -n 'proxy_read_timeout' /etc/nginx/conf.d/*.conf
# 3) 主控日志：慢请求与卡住的请求都会留痕
sudo journalctl -u mclink-server --since '15 min ago' | grep -E '慢请求|请求仍未返回|请求处理超时'
```

第 3 步是关键：主控会在**请求还没返回**时（默认 30 秒）先记一条
「请求仍未返回」，到 110 秒自己回一个 JSON 504（`server_timeout`），
所以日志里能直接看到是哪个 method+path 卡住了，不必靠猜。

**处置**：

1. 若是 502/503：`systemctl status mclink-server`，多半是没启动或正在重启；
   反代 `proxy_pass` 指向 `127.0.0.1:8787`（而不是别的端口）。
2. 若是 504：先看第 3 步日志里卡住的是哪个接口。
   * 下载/安装类（`/downloads/`、`/agent/`）超时 → 反代要单独开长超时并关掉缓冲，
     规则见 `deploy/nginx.conf.example`；这两个路径**默认落在 `location /` 的 120s 里**，
     慢线路上必然 504。
   * 普通接口超时 → 常见是 SMTP 发信慢（主控侧 15s 超时）、或数据库很大时的一次聚合查询。
3. 阈值可调（主控侧，改完重启）：

   | 环境变量 | 默认 | 作用 |
   | --- | --- | --- |
   | `MCLINK_SLOW_REQUEST_MS` | `30000` | 多久没返回就先记一条 warn |
   | `MCLINK_REQUEST_DEADLINE_MS` | `110000` | 多久没返回就由主控主动回 JSON 504 |

   这两个值应当**小于**反代的 `proxy_read_timeout`，这样客户端拿到的是结构化错误
   （带 `server_timeout` 与中文说明），而不是反代那张 HTML 页面。

---

## 19. 有人发消息时没有弹系统通知

**症状**：房间里别人发言，窗口在后台（或收在托盘/菜单栏里），但屏幕上没有提醒。

**先分清"该不该弹"** —— 这是设计上的四条规则，不是故障：

| 情况 | 行为 |
| --- | --- |
| 窗口在前台 **且** 正看着那个房间 | **不弹**（消息就在眼前，弹了是打扰） |
| 窗口在前台但停在别的页面（设置/大厅…） | 弹 |
| 窗口失焦 / 最小化 / 收在托盘（菜单栏） | 弹 |
| 自己发的消息 | 不弹（界面里已经有回显） |
| 系统消息（XX 加入/离开） | 不弹（它不是"有人说话"） |
| 同一房间 3 秒内的连发 | **合并成一条**（「XX 等 3 条新消息」） |
| 设置 →「消息提醒」关掉 | 一条都不弹 |

**如果确实该弹却没弹，按这个顺序查**：

1. **设置页的开关**：设置 → 消息提醒 →「有人发消息时提醒我」是不是被关过（关掉后一条都不弹）。
   这个开关存在 `client-prefs.json`（Windows 在 `%APPDATA%\McLink\`），删掉那个文件即恢复默认（开）。
2. **系统级通知开关**（最常见）：
   - Windows：设置 → 系统 → 通知 → 找到 **McLink**，确认没被关；再确认没开「专注助手/勿扰」，
     并且**「通知与操作」里允许应用发送通知**。
   - macOS：系统设置 → 通知 → **McLink** → 允许通知（首次运行时系统会问一次，点了「不允许」就在这里改回来）。
3. **Windows 的 toast 依赖 AppUserModelId**：客户端启动时会设 `com.mclink.client`
   （与 `electron-builder.yml` 的 `appId` 一致），而 Windows 要求这个 id 与**开始菜单快捷方式**上的
   那个一致才会显示通知。NSIS 安装版会建那条快捷方式，所以：
   **装机版正常；直接跑免安装的 `--win dir` 产物、或从别处拷出来的 exe，通知可能不显示**（不报错，就是没有）。
   排查时请以装机版为准。
4. **看客户端日志里的证据**（「日志」标签页）：主进程会记
   `系统通知发送失败：…`；`notify:state` 里的三个数字说明了一切 ——
   `requested`（渲染层请求了几条）、`shown`（系统报告显示了几条）、`failed`（失败了几条）：

   ```
   requested=3 shown=3 failed=0   → 通知发出去了，问题在系统侧的展示（第 2 条）
   requested=3 shown=0 failed=0   → 系统静默丢弃（第 3 条：没有开始菜单快捷方式 / 被策略拦）
   requested=0                    → 判定没让它弹（第 1 条，或"窗口在前台且看着房间"）
   ```

5. **判定本身**：窗口是否"在前台"取的是渲染进程的 `document.hasFocus()`。
   最小化、被其它窗口盖住、收进托盘都是 false（该弹）；如果怀疑判错了，
   可以在开发者工具里执行 `document.hasFocus()` 对一下。

---

## 20. 其它常见小程序问题

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `pnpm dev:web` 打开 5173 但接口 404 | Vite 代理指向了别的主控 | 设 `MCLINK_MASTER=http://127.0.0.1:8787` 后重启 `dev:web` |
| `pnpm test` 报找不到测试文件 | 仓库里还没有 `server/test/` 目录 | 正常现象，见 `development.md` §3 |
| 主控页面显示「检测到前端尚未构建」 | `server/public/index.html` 不存在 | `pnpm build:web` |
| 登录提示「登录尝试过于频繁」 | 触发了 `MCLINK_LOGIN_RATE_LIMIT`（默认 20 次/分钟/IP） | 等待 1 分钟；或排查是否有人在撞库（看审计日志 `auth.login_failed`） |
| 反向代理后所有请求 IP 都是 127.0.0.1 | 反代没传 `X-Forwarded-For`，或 `MCLINK_TRUST_PROXY=false` | 配好 `proxy_set_header X-Forwarded-For` 并保持 `TRUST_PROXY=true` |
| 反代换了拓扑后 IP 变成网关/容器地址（如 172.17.0.1） | 转发头来源不在可信代理白名单里，被整条忽略 | 把反代地址加进 `MCLINK_TRUSTED_PROXIES`（同机 nginx：`127.0.0.1/8,::1/128`）；启动日志里有一条「真实 IP：…」会写明当前判定依据 |
| 有人伪造 `X-Forwarded-For` 刷接口 / 审计日志里出现奇怪 IP | 兼容模式（未配 `MCLINK_TRUSTED_PROXIES`）会信任私网来源的转发头 | 显式配 `MCLINK_TRUSTED_PROXIES`；确认主控没有直连暴露（或设 `MCLINK_TRUST_PROXY=false`）。危害验证见 `.cache/check-real-ip.mjs` 的限流场景 |
| 隐藏房间在大厅看不到 | 这是预期（`visibility=hidden`） | 用加入码进房 |
| 建房提示「最多同时创建 N 个房间」 | `defaultMaxRooms`（默认 3）或用户 `maxRooms` | 关掉旧房间，或调大平台默认值/用户配额 |
| 房间过一段时间自己关闭了 | TTL（默认 720 分钟）或空房回收（默认 600 秒无心跳） | 调整 `roomTtlMinutes` / `MCLINK_ROOM_IDLE_TIMEOUT` |
