# mclink 排障手册

按「症状 → 原因 → 处置」组织。先看速查表，再跳到对应小节。

---

## 0. 速查表

| 症状 | 最可能原因 | 跳到 |
| --- | --- | --- |
| 主控启动日志里 `easytier-cli 探测失败` | 二进制没下载/路径不对 | §1 |
| 管理台 `easytierVersion` 显示未知 | `easytier-cli` 缺失或不可执行 | §1、§3 |
| 子节点一直 `pending` | agent 没起来 / 心跳失败 / 令牌无效 | §4 |
| 建房报「当前没有可用的中继节点，请联系管理员」 | 没有任何在线可调度的子节点（单机部署没注册本机节点）；或节点 `weight=0` | §5 |
| 客户端能登录、能看到房间，但进不去 | `bind_device`、中继地址不可达、UDP 未放行 | §6、§7 |
| 给节点勾上「只协助打洞」后**房间立刻不通** | 它本来就是该房间唯一能承载数据的节点（勾选还会重启它的核心） | §6.6 |
| 房主踢人后对方仍能连 | ACL 未应用 / 恶意客户端 / ACL 只在本实例生效 | §9 |
| 流量统计恒为 0 | 子节点没上报、P2P 直连绕过了中继 | §8 |
| 端口 11010 被占用 | 残留 easytier-core 进程 | §10 |
| Windows 上 easytier-core panic：`SCM start an error` | 令牌受限 / 无法访问服务控制管理器 | §11 |
| `acl set` 报「不支持的子命令」 | v2.6.4 的 CLI 没有该子命令 | §12 |
| 房间建好后中继列表里有 `127.0.0.1` | 未配置公网地址，按 `Host` 头推导 | §7 |
| 改了 `MCLINK_ADMIN_PASSWORD` 却登录不上 | 该变量只在首次建号时生效 | §13 |
| WebSocket 连上但状态不刷新 | 反代没配 `/ws` 的 Upgrade 与长超时 | §14 |
| `pnpm build:web` 后 `/downloads` 或自定义静态文件消失 | `emptyOutDir` 清空了 `server/public/` | §15 |
| 客户端 `failed to listen` / `os error 10048` / `10013` | 残留 easytier-core 占端口、其它虚拟网络软件、Windows 保留端口段 | §17 |

---

## 1. EasyTier 二进制缺失（`easytier-cli 探测失败`）

**症状**（journald）：

```
[warn] easytier-cli 探测失败：版本信息不可用（/meta 的 easytierVersion 会是未知）
```

**原因**（按概率排序）：

1. 安装时 EasyTier 下载失败（受限网络、GitHub 被阻断、`--skip-easytier`）。
2. **下载成功但解压失败** —— 这个坑很隐蔽：EasyTier 官方只发 **zip**，而 Debian 的
   GNU `tar` **不能解 zip**。2026-09 之前的脚本用 `tar -xf xxx.zip`，于是"下载 24 MB 成功、
   二进制却没落地"，日志里只有一句"压缩包解压失败"。现已改用 `unzip`（并写进依赖），
   缺失时依次退让到 `bsdtar` / `python3 -m zipfile`。
3. `MCLINK_ET_CORE` / `MCLINK_ET_CLI` 指向的路径写错，或与 `--dir` 不匹配。
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
/opt/mclink/app/vendor/easytier/easytier-cli --version
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

注意：**主控已经不跑中继实例**，所以这两个二进制缺失对控制面本身没有影响 ——
管理员仍可登录、建节点、建房。真正受影响的是两件事：

* `GET /api/v1/meta` 的 `easytierVersion` 变成 `null`（版本探测用的就是 `easytier-cli`）；
* 子节点无法从主控取到核心（`GET /agent/easytier-core`），装节点时会退回 GitHub 下载。

---

## 2. 「主控中继启动失败」——已取消

**该概念已取消（2026-09-28）**：主控不再启动自带的中继实例，转发全部由子节点承担，
所以日志里不会再出现 `主控中继启动失败`，`GET /admin/overview` 也不再返回 `relay` 字段。

如果历史上你见过这类报错（`进程退出，退出码 1`、`easytier-core 不存在`、
`配置文件不存在: <路径>`、`启动失败: spawn ... EACCES`），那都是**主控自带中继**实例的问题，
现在这些实例根本不存在了。中继侧的真实问题请按子节点排查：

```bash
# 子节点自己的日志（真正的报错在这里）
journalctl -u mclink-node -f
tail -n 80 /var/log/mclink/easytier-core.log

# 子节点上手工跑一次，把错误直接打出来
sudo -u mclink /opt/mclink-node/app/vendor/easytier/easytier-core \
  -c /etc/mclink/relay.toml \
  -r 127.0.0.1:16010 --rpc-portal-whitelist 127.0.0.1/32

# 确认端口没被别的东西占着
ss -lntup | grep -E '11010|16010'
```

**典型配置错误**：把 `rpc_portal` 写进 TOML。它不是配置文件字段，会被**静默忽略**，
导致实例退回默认 15888，多实例互相抢占（见 §8 与 `security.md` §4.3）。
请只用命令行 `-r`（主控下发的 `launchArgs` 已经带上了）。

---

## 3. `easytier-cli` 不可用

**症状**：启动日志里 `easytier-cli 探测失败：版本信息不可用`；
`GET /admin/overview` 与 `GET /api/v1/meta` 的 `easytierVersion = null`。

**原因**：`MCLINK_ET_CLI` 指向的文件不存在 / 不可执行 / 架构不对；或 CLI 与 core 版本差异过大。

**处置**：

```bash
grep MCLINK_ET_CLI /etc/mclink/mclink.env
/opt/mclink/app/vendor/easytier/easytier-cli --version     # 期望输出 easytier-cli 2.6.4-...
```

补齐后重启主控即可。**影响范围**：只有「版本显示」这一项 ——
主控不再自带中继，所以它既不靠 CLI 采样，也不再拿 CLI 下发 ACL；
**房间联机与流量统计都不受影响**（票据与逐房间用量都是主控自己算的，数据来自子节点心跳）。

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
`relayNodeIds` 为空就报错。2026-09-28 起主控连自带的中继实例也不再启动
（`MCLINK_AUTOSTART_RELAY` 随之废弃、不再写进 env），所以建房能否成功只看一件事：
**有没有可调度的在线子节点**。单机部署就把主控这台机器注册成一台普通子节点
（`deploy/register-self-node.mjs`，见 `deployment.md` §2.3.1）。

**原因与处置**：

1. 一个可调度的在线子节点都没有（单机部署没注册本机节点）→ 至少让一个子节点 `online`。
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

平台已经在两处统一设为 `false`：

* 子节点：`server/src/services/nodes.ts` 的 `renderNodeConfig()` → `bindDevice: false`
* 客户端：`server/src/services/rooms.ts` 的 `ticket()` → `bindDevice: false`
  （客户端 `client/electron/main.cjs` 只把票据里的 TOML 原样落盘）

**验证**：

```bash
# 子节点生成的配置里应当有
grep -n 'bind_device' /etc/mclink/relay.toml
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
「链接端口」）。`MCLINK_RELAY_PUBLIC_HOST` / `install-server.sh --relay-public-host` 现在只用于
「`MCLINK_PUBLIC_BASE_URL` 为空时拼安装/更新指令」，改它**不会**再影响任何票据；
要把主控本身当节点用，得用 `install-node.sh --endpoint <这台机器的公网地址>:11010` 注册。

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

### 6.6 勾上「只协助打洞」后房间立刻不通 ⚠️

**现象**：在控制台给某台节点勾上「只协助打洞（不中继）」之后，**正在玩的房间立刻断**。
MC 的 TCP 会话被打断后**不会自动重连**，所以看起来是"直接不通"——让玩家重新进房
（或重连服务器）通常就能恢复，数据会收敛到另一台能承载的节点上（延迟更高一点）。
只有当这个区域**再没有别的能承载的节点**（另一台也被标了 assist、或玩家到另一台连不上）
时，才会**持续不通**（打洞又没成功的话尤其明显）。

**为什么**（关键前提：**槽位标签不决定选路**）：

1. 勾选会让那台节点的 `configRevision +1` → **它的核心重启一次**（下一次心跳 ≤20 秒内应用，
   重启瞬间所有走它中转的人都断）；
2. 从此它 `disable_relay_data = true`，两层叠加：

   | 层 | 机制 | 效果 |
   | --- | --- | --- |
   | 算路 | `peer_ospf_route.rs`：对端声明 avoid-relay 时，从它出发的每条边 `cost += AVOID_RELAY_COST`（`i32::MAX`） | **有限但天文数字** —— 有别的路时别的路必胜，**没有别的路时它照样会被选**（不是禁止） |
   | 数据面 | `foreign_network_manager.rs` / `peer_manager.rs`：过路数据包 **直接 drop** | 路由表一时还指着它也没用，包到它这里就被丢掉 |

   净效果：它从"最便宜的那条路"变成"**不可用的路**"。
   ⚠️ 但这**不是无损切换**：新标记要等客户端重新握手、路由信息同步后才生效（**秒级**），
   而玩家的 MC 会话在这段空窗里已经断了 —— MC **不会自动重连**，所以玩家看到的是
   "连接已丢失"，而不是"悄悄改走另一台继续玩"。

而 EasyTier 选路只看**路径代价**（谁延迟低走谁）—— 平台把一台标成「打洞节点」
（槽 1）**不代表数据不走它**。恰恰相反：槽 1 那台小管子通常离玩家更近、延迟更低
（实测例：打洞节点 23.6 ms、中继节点 43.3 ms），所以**房间的数据本来就在走它**。
这正是"标着打洞节点却在中继我的数据"的成因。

于是勾上 assist 的后果是：**那条最便宜的路被抽掉** → 立刻断线（MC 的 TCP 会话被打断，
且 MC 不会自动重连，要重新进房/重连服务器）→ 之后 EasyTier 才收敛到槽 2 那台
（能承载、但延迟更高）。如果这个区域**只有**这一台能承载过（另一台也被标了 assist、
或玩家到另一台根本连不上），那就是**持续不通**。

**所以**：这个开关的代价是"牺牲掉那条便宜的路"，**要在没人玩的时候动**，
而且勾之前先想清楚"这台是不是正在当中转"。

**排查**：

```bash
# ① 控制台 →「房间」→ 详情：
#      「建房时调度」看谁在槽 1 / 槽 2，「正在承载」看此刻谁在报流量。
#      注意：两台都被标 assist 时「正在承载」仍会显示它们（那是节点自己的链路计数，
#      打洞协调本来就有收发），但数据其实没人接得住。
# ② 客户端房间页 →「连接路径」：到房主那行写的是 P2P 直连还是经中继；
#      经中继时，那台是不是被标了 assist。
# ③ 节点上确认标记真的生效了（默认路径 /etc/mclink/relay.toml，0600 要 sudo）：
sudo grep -n disable_relay_data /etc/mclink/relay.toml    # 有这行 = 它不承载
```

如果玩家**重进房间后仍然不通**，那就不再是"收敛慢"，而是**替代路径不成立**。数据要走另一台，
前提是**房主和这个玩家都连得上同一台**（房间成员之间没有互相 peer，必须共享至少一台中继）。
两个最常见的成因：

* 房主那侧到槽 2 的链路实际不可达（节点列表里能看到延迟 ≠ UDP 真的通）；
* 这个区域再没有第二台能承载的节点（两台都被标了 assist）。

**修复**（⚠️ 两者不对称，这是关键）：

* **取消**那台的「只协助打洞」→ 它核心重启几秒后**重新能承载** → 房间**自动恢复**
  （不需要重排房间，也不用玩家重进）；
* **新增**标记则相反：**已建房间不会自愈** —— 房间的中继名单是**建房时锁定**的
  （`room.relayNodeIds`），只有「建房 / 房主改区域 / 房间过载交换」三处会重排。
  所以要么让房间里的人**退出重进**，要么让**房主把「区域」改一下再改回来**。

**部署纪律：每个区域只留一台 assist。**

| 节点 | 标记 | 角色 |
| --- | --- | --- |
| 小管子（例如 2 Mbps） | ✅ 只协助打洞 | 槽 1 打洞，不承载数据 |
| 大管子（例如 200 Mbps） | ❌ **不要标** | 槽 2 中继，承载数据 |

把大管子标成 assist = 它退出承载池；**两台都标 = 这个区域没有任何承载者**，
打洞一失败就整片区域不通。另外别忘了：**槽位只是"票据里有哪两台"与界面标签，
EasyTier 选路只认路径代价 + `disable_relay_data`**（见 §6.2 与 `docs/architecture.md`）。

---

## 7. 票据里出现内网/本机地址

见 §6.3。补充说明：票据里的地址**只有**一个来源 —— `relayNodes`（管理台登记的子节点，
`PATCH /admin/nodes/:id` 的 `endpoint`），**它们必须是玩家能访问的公网地址**。
主控自有中继已不进票据（§6.3），所以「内网地址」现在一定是某个子节点 `endpoint` 填错了。

---

## 8. 流量统计恒为 0

**数据来源**：子节点的 agent 每 20 秒上报一次 `roomTraffic`（逐房间网络名 + 字节 + 速率），
主控每 6 秒做一次平台维度的聚合与推送。主控自己**不再**调 `easytier-cli` 采样。

**原因与处置**：

| 原因 | 验证方式 | 处置 |
| --- | --- | --- |
| 没有任何子节点在线 | `GET /api/v1/stats` 的 `nodes.online` 为 0 | 见 §4、§5 |
| 子节点没上报 | 子节点 `rooms` 字段一直是 0 | 子节点上 `easytier-cli` 缺失或 RPC 端口推导不一致（应为 `16000 + endpoint端口 % 1000`） |
| **房间全走 P2P 直连** | 房间内成员显示 `p2p = true` | 这是**正常**的：直连流量不经过中继，中继侧的字节数自然接近 0。想统计到流量就关掉房间策略的 `allowP2p` |
| 只是还没等到第二轮心跳 | — | 子节点首次上报只记录总量不算速率，等 20–40 秒 |
| 速率读数是 0 但累计在涨 | 流量页「今日/本月/累计」在涨 | 正常：账本记的是字节增量，瞬时速率靠相邻两次心跳差分 |

**手工核对**（在子节点机器上执行；RPC 端口 = `16000 + endpoint端口 % 1000`）：

```bash
# 它的 peer 与外来网络（JSON 里字段是 snake_case，数值是人类可读字符串如 "17.33 kB"）
/opt/mclink-node/app/vendor/easytier/easytier-cli -p 127.0.0.1:16010 -o json peer list
/opt/mclink-node/app/vendor/easytier/easytier-cli -p 127.0.0.1:16010 -o json peer list-foreign

# 全局计数器（traffic_bytes_forwarded 才是"转发出去"的字节）
/opt/mclink-node/app/vendor/easytier/easytier-cli -p 127.0.0.1:16010 stats show
```

注意：**数据保留 72 小时**（`app.traffic.pruneBatch(72)`），所以「昨天的曲线」查不到是正常的；
更早的字节量看账本（保留 400 天）。

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

**症状**：子节点日志里 `bind: address already in use` / `进程退出，退出码 1`；
或启动后客户端全连不上（其实连到了别的进程）。
（主控自身不监听 11010，所以这条只在**跑中继的机器**上出现 —— 包括单机部署里
被注册成本机节点的那台。）

**排查**：

```bash
# Linux
ss -lntup | grep -E ':11010|:16010'
sudo lsof -iTCP:11010 -sTCP:LISTEN
sudo lsof -iUDP:11010

# Windows（PowerShell）
Get-NetTCPConnection -LocalPort 11010 -ErrorAction SilentlyContinue
Get-NetUDPEndpoint    -LocalPort 11010 -ErrorAction SilentlyContinue
```

**原因**：上次没退干净的 easytier-core（agent 自带退避重启、systemd 用 `KillMode=mixed`，
但手工 `kill` 可能留下孤儿进程）；或与别的服务（另一个 VPN、别的 EasyTier 实例）冲突。

**处置**：

```bash
# 杀掉残留实例（先确认它就是 easytier-core）
sudo pkill -f 'easytier-core.*relay.toml'
sudo systemctl restart mclink-node
```

或换端口：子节点用 `--listen-port 11011` 重新注册（同时放行新端口的 TCP+UDP），
**并让客户端重新取票据**（票据里的中继地址已变；老房间的票据需重新获取）。
若想改的是**默认值**（影响之后所有新节点与建房默认端口），改主控的
`install-server.sh --relay-port 11011`（`MCLINK_RELAY_PORT`）。

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

**症状**：客户端日志出现「当前 easytier-cli 不支持 acl set，改为重启实例」，
房间设置里点「立即重新应用规则」后房主会断线约 2 秒。

**原因**：`acl set` 是 EasyTier **较新版本**才加入的子命令。v2.6.4 的命令树里只有 `acl stats`：

```
$ easytier-cli acl --help
Commands:
  stats  Show ACL rule hit statistics
```

平台因此做了**能力探测**而不是假定存在：客户端 `client/electron/main.cjs` 的 `supportsAclSet()`。
（服务端侧的 `RelayManager.supportsAclSet()` 随主控中继实例一起停用 —— 房间 ACL 现在只由
房主客户端应用。）

**处置**：

* 这是**预期行为**，不是故障。降级路径是「把 ACL 追加进配置 → 重启实例」，
  管理操作低频、房主断线约 2 秒，可接受。
* 想热更新：升级 EasyTier 到带 `acl set` 的版本，然后
  `node scripts/fetch-easytier.mjs --version vX.Y.Z` 并替换 `vendor/easytier/` 下的二进制，
  重启服务。

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

---

## 21. 控制台签发的安装 / 更新命令里是 `127.0.0.1`

**现象**：控制台点「安装指令 / 更新指令」，复制出来的命令是

```
curl -fsSL http://127.0.0.1:8787/agent/install.sh | sudo bash -s -- …
```

拿到节点上执行必然失败 —— 它连的是**节点自己**的 8787 端口。

**原因**：主控没配对外地址（`MCLINK_PUBLIC_BASE_URL` 为空）。命令里的地址按
「配置 → 请求自带的 proto/host → `http://127.0.0.1:<port>`」三级取，而旧版本的后两级都塌了：
`MCLINK_RELAY_PUBLIC_HOST` 随"主控中继"一起废弃，兜底就只剩写死的本机地址；
直连主控时协议还被默认成 https（生成 `https://127.0.0.1:8787`，更连不上）。

**处置**（改环境变量最省事，旧版本也认）：

```bash
sudo grep -q MCLINK_PUBLIC_BASE_URL /etc/mclink/mclink.env \
  || echo 'MCLINK_PUBLIC_BASE_URL=https://你的域名' | sudo tee -a /etc/mclink/mclink.env
sudo systemctl restart mclink-server
# 然后**重新签发一次**命令 —— 已经复制出去的那条不会自己变
```

或者重跑安装脚本一次写好：`sudo bash deploy/install-server.sh --public-url https://你的域名`。

**新版行为**（本次修复之后）：地址解析是「配置 → 请求头 → 本机兜底」，并且**只要最终地址落在
本机**，控制台就会在命令下方直接显示警告（`⚠️ … 只能在主控本机使用`），不会再默默给出一条
打不通的命令。

**回归检查**：`node scripts/check-node-cmd-origin.mjs` —— 对着跑起来的开发主控**打真接口**
（用 `node:http` 自己造 `Host` / `x-forwarded-*`），验 4 项：直连时是本机地址且带警告、
反代时用公网地址且无警告。
