# mclink 生产部署手册

面向 Debian 12 x86_64 的完整运维手册。一键脚本的速查版见 `../deploy/README.md`，
原理见 `architecture.md`，安全边界见 `security.md`，故障处置见 `troubleshooting.md`。

---

## 1. 容量规划

### 1.1 硬件建议

| 规模 | 主控 | 子节点（每个区域） |
| --- | --- | --- |
| 试玩（< 10 房间，< 50 人） | 1 核 / 1 GB / 20 GB SSD | 不需要（主控中继兜底） |
| 小规模（~50 房间，~300 人） | 2 核 / 2 GB / 40 GB SSD | 1 核 / 1 GB / 20 GB |
| 中等（~300 房间，~2000 人） | 4 核 / 4 GB / 80 GB SSD | 2 核 / 2 GB / 40 GB |
| 大（千房级） | 8 核 / 8 GB，SQLite 换独立盘 | 4 核 / 4 GB，多台横向铺开 |

主控本身很轻（Node + SQLite + 每个开放房间一次 `easytier-cli` 采样），开销主要在：

* **中继转发**：CPU 与带宽都吃在中继上。主控中继与子节点中继是同一种进程，转发是单线程
  拷贝 + 加解密，`multi_thread = true` 已开启。
* **SQLite 写入**：每 5 秒一次流量采样 × (1 平台 + N 房间 + M 节点)，WAL 模式下压力很小。

### 1.2 带宽估算（关键）

《我的世界》单人连接**上下行各约 50–200 kbps**（视视野距离与实体数量）。
中继要同时承担「转发所有经过它的流量」，所以：

```
所需带宽 ≈ 同时经该中继中转的玩家数 × 200 kbps × 2（收发各算一次）
```

* 100 人在线且全部走同一中继 → 约 **40 Mbps** 双向。带宽不够时先关闭房间策略里的
  `allowP2p`（开启 P2P 可显著减少中继流量）。
* **UDP 与 TCP 都要放行**：EasyTier 默认 `default_protocol = "tcp"`，但仍会用 UDP 打洞/探测；
  只放行 TCP 会让 P2P 成功率与连通性变差。
* 平台级总出口限速：`MCLINK_RELAY_BPS_LIMIT`（bit/s，0 = 不限），或管理台
  「设置 → 平台级总出口限速（kbps）」（写入中继的 `foreign_relay_bps_limit`）。

### 1.3 端口清单

| 端口 | 协议 | 归属 | 是否公网 |
| --- | --- | --- | --- |
| 8787（`MCLINK_PORT`） | TCP | 主控 HTTP/WS | 建议只对反代开放 |
| 11010（`MCLINK_RELAY_PORT`） | TCP + UDP | 主控共享中继 | **必须公网**（除非用 `--no-relay`） |
| 15888（`MCLINK_RELAY_RPC`） | TCP | 主控中继 RPC | 仅 127.0.0.1 |
| `16000 + 端口 % 1000` | TCP | 子节点/客户端实例的 RPC | 仅 127.0.0.1 |

---

## 2. Debian 从零部署

### 2.1 主控

```bash
# 0) 基础环境（脚本也会自动做这一步）
sudo apt-get update
sudo apt-get install -y ca-certificates curl git

# 1) 取得源码
sudo mkdir -p /opt/src && cd /opt/src
sudo git clone <仓库地址> mclink

# 2) 一键安装（脚本会：装 Node >= 22、装依赖、构建前端、下载 EasyTier、
#    写 /etc/mclink/mclink.env、装 systemd 服务、按需放行 ufw）
cd /opt/src/mclink
sudo bash deploy/install-server.sh \
  --port 8787 \
  --relay-port 11010 \
  --public-url https://cnnic.link

# 3) 记下打印出来的初始管理员密码（只打印一次）
```

安装后的目录布局：

```
/opt/mclink/app/           代码（root 所有，mclink 只读）
  ├─ server/               Node 后端（TS 直接运行，无需构建）
  ├─ server/public/        前端构建产物（主控进程静态托管）
  ├─ packages/shared/      与服务端/客户端共享的协议与类型
  ├─ deploy/               部署脚本与 systemd 单元
  ├─ docs/                 文档
  └─ vendor/easytier/      easytier-core 与 easytier-cli
/opt/mclink/data/          数据（mclink 所有，权限 750）
  ├─ mclink.sqlite         数据库（WAL）
  ├─ secrets.json          自动生成的密钥兜底（600）
  ├─ easytier/relay.toml   主控中继的生成配置
  ├─ logs/relay.log        中继进程日志
  └─ downloads/            客户端安装包
/etc/mclink/mclink.env     环境变量（600，owner mclink）
/etc/systemd/system/mclink-server.service
```

### 2.2 反向代理与证书

```bash
sudo cp /opt/mclink/app/deploy/nginx.conf.example /etc/nginx/conf.d/mclink.conf
sudo nano /etc/nginx/conf.d/mclink.conf          # 改 server_name
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d cnnic.link
sudo nginx -t && sudo systemctl reload nginx
```

* `/ws` 必须带 `proxy_http_version 1.1` + `Upgrade`/`Connection` + `proxy_read_timeout 3600s`。
* 反代后 `MCLINK_TRUST_PROXY=true`（默认）以便按真实 IP 限流与审计。
* 只在反代后面时，不要对公网放行 8787。

### 2.3 子节点

```bash
# 在主控管理台「节点」页签发注册密钥，然后在区域服务器上：
sudo bash deploy/install-node.sh \
  --master https://cnnic.link \
  --key <注册密钥> \
  --region cn-east \
  --endpoint relay-sh.cnnic.link:11010 \
  --name relay-sh
```

* `--endpoint` 必须是**公网可达**的 `host:port`，端口即该节点 EasyTier 监听端口；
  安全组需放行 TCP **与** UDP。
* 注册后先出现为 `pending`，首次心跳（≤20 秒）后变 `online`。
* 令牌落在 `/etc/mclink/node-token.json`（600），之后重启不再需要密钥。

### 2.4 浏览器访问

打开 `https://cnnic.link` → 用 `admin` + 初始密码登录 → 立即在「账号设置」改密
（改密会让所有旧会话失效，这是预期行为）。

---

## 3. systemd 运维

```bash
# 主控
systemctl status mclink-server
systemctl restart mclink-server
systemctl stop mclink-server
journalctl -u mclink-server -f
journalctl -u mclink-server --since "30 min ago" -p warning

# 子节点
systemctl status mclink-node
journalctl -u mclink-node -f

# 重载环境变量（改了 /etc/mclink/mclink.env 之后必须重启）
sudo systemctl restart mclink-server
```

单元文件的关键设计（见 `../deploy/mclink-server.service` 注释）：

* `KillMode=mixed` + `TimeoutStopSec=20`：SIGTERM 交给主进程，由它优雅关闭自己拉起的
  easytier-core；超时后才对整组 SIGKILL，避免留下孤儿进程。
* `ProtectSystem=full` + `ReadWritePaths=/opt/mclink/data`：**不是** `ProtectSystem=strict`，
  因为主控要 spawn 子进程并写数据目录。加固项按「最小必要」给。
* `LimitNOFILE=65535`：每个房间对等体都会占用 fd。
* 不加 `MemoryDenyWriteExecute=yes`：V8 的 JIT 需要可写可执行内存。
* 默认 `MCLINK_RELAY_NO_TUN=true`，中继不建 TUN 设备，因此不需要任何 capability。
  若你把它改成 `false`（需要 TUN），必须去掉 `NoNewPrivileges=yes` 并加
  `AmbientCapabilities=CAP_NET_ADMIN`。

---

## 4. 备份与恢复

### 4.1 数据库（SQLite，WAL 模式）

数据库使用 `journal_mode=WAL`（`server/src/db/index.ts`），因此**不能只拷 `mclink.sqlite`
一个文件**——最新数据可能还在 `-wal` 里。两种正确做法：

```bash
# 做法 1（推荐）：用 sqlite3 的在线备份，自动处理 WAL
sudo apt-get install -y sqlite3
sudo -u mclink sqlite3 /opt/mclink/data/mclink.sqlite \
  ".backup '/opt/mclink/backup/mclink-$(date +%F-%H%M).sqlite'"

# 做法 2：停机拷贝（先停服务，让 WAL 落盘）
sudo systemctl stop mclink-server
sudo cp -a /opt/mclink/data/mclink.sqlite*  /opt/mclink/backup/
sudo systemctl start mclink-server

# 做法 3：不停机整目录打包（含 -wal/-shm，需一致快照）
sudo tar -C /opt/mclink/data -czf /opt/mclink/backup/data-$(date +%F).tgz \
  mclink.sqlite mclink.sqlite-wal mclink.sqlite-shm secrets.json easytier
```

建议用 systemd timer 每天跑一次做法 1，并保留 14 天。

### 4.2 必须一起备份的东西

| 内容 | 路径 | 丢失后果 |
| --- | --- | --- |
| 数据库 | `/opt/mclink/data/mclink.sqlite*` | 用户/房间/节点/审计全部丢失 |
| 密钥兜底 | `/opt/mclink/data/secrets.json` | 可能生成新的 JWT 密钥（所有登录失效）与新中继密钥 |
| 环境变量 | `/etc/mclink/mclink.env` | JWT/中继密钥/管理员初始密码丢失 |
| 子节点令牌 | `/etc/mclink/node-token.json`（各子节点） | 需重新签发注册密钥 |

**恢复**：把数据库与 `secrets.json` 放回原位 → `systemctl start mclink-server`。
密钥一致时，旧令牌与旧票据继续有效。

### 4.3 升级与回滚

```bash
cd /opt/src/mclink
sudo git fetch && sudo git checkout <新版本tag>
sudo bash deploy/install-server.sh        # 同参数，密钥自动保留
```

* 脚本每次都会把旧 env 备份为 `mclink.env.bak.<时间戳>`。
* 回滚：`git checkout <旧tag>` + 重跑脚本；数据库迁移是**向前**的
  （`PRAGMA user_version` 顺序执行），跨大版本回滚前务必先备份数据库。
* 想强制轮换密钥：`--rotate-secrets`（会让所有登录令牌与旧票据失效，谨慎）。

---

## 5. 日志位置

| 日志 | 位置 | 查看方式 |
| --- | --- | --- |
| 主控进程（含启动过程、房间/节点事件、请求日志） | journald | `journalctl -u mclink-server -f` |
| 主控中继 easytier-core 的 stdout/stderr | `/opt/mclink/data/logs/relay.log` | `tail -f` |
| 主控最近 150 行中继日志（内存环形缓冲） | 管理台「中继」页 / `GET /admin/relay` | — |
| 子节点 agent | journald + `/var/log/mclink/agent.log` | `journalctl -u mclink-node -f` |
| 子节点 easytier-core | `/var/log/mclink/easytier-core.log` | `tail -f` |
| 前后端请求日志 | journald（慢请求 ≥1.5s 或状态码 ≥400 会 warn） | `journalctl -u mclink-server \| grep 慢请求` |

日志级别：`MCLINK_LOG_LEVEL=debug|info|warn|error`（生产建议 `info`）。
`MCLINK_LOG_LEVEL` 影响主控自身日志；中继进程的 `console_log_level` 在 `info` 级别下会被压到 `warn`
（`manager.ts` 的 `renderConfig()`），避免刷屏。

---

## 6. 监控

### 6.1 平台自有接口

```bash
# 公开概览：落地页与管理台首屏用的就是它
curl -s http://127.0.0.1:8787/api/v1/stats
# → {"ok":true,"data":{"serverTime":...,"nodes":{...},"rooms":{...},"users":{...},"traffic":{...}}}

# 站点元信息（含 easytierVersion、relayPort、在线节点数）
curl -s http://127.0.0.1:8787/api/v1/meta

# 管理台（需要管理员令牌）
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8787/api/v1/admin/overview
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8787/api/v1/admin/traffic?minutes=60
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8787/api/v1/admin/relay
```

**没有 `/metrics` 端点**：mclink 不提供 Prometheus 格式的 HTTP 接口。
Prometheus 指标请到 EasyTier 层取（这正是 EasyTier 自带的能力）：

```bash
# 主控中继的 Prometheus 文本（RPC 只监听 127.0.0.1，需在服务器上执行）
/opt/mclink/app/vendor/easytier/easytier-cli -p 127.0.0.1:15888 stats prometheus

# 通用计数器（含 traffic_bytes_forwarded，即中继真正转发的字节数）
/opt/mclink/app/vendor/easytier/easytier-cli -p 127.0.0.1:15888 stats show

# 子节点（端口按 16000 + 端口%1000 推导；endpoint 端口 11010 → 16010）
/opt/mclink-node/app/vendor/easytier/easytier-cli -p 127.0.0.1:16010 stats prometheus
```

想接 Prometheus，用 `node_exporter` 的 `textfile` collector，配一个 systemd timer 定时把上面
命令的输出写到 `/var/lib/node_exporter/textfile/mclink_relay.prom` 即可。

### 6.2 建议告警项

| 指标 | 来源 | 阈值建议 |
| --- | --- | --- |
| 主控进程存活 | `systemctl is-active mclink-server` | 非 active 即告警 |
| 主控中继是否 running | `GET /admin/overview` 的 `relay.running` | false 告警 |
| `easytier-cli` 可用性 | `GET /admin/overview` 的 `relay.cliAvailable` | false 告警（流量统计会失效） |
| 在线节点数 | `GET /api/v1/stats` 的 `nodes.online` | 低于预期区域数告警 |
| `nodes.offline` | 同上 | > 0 告警 |
| 中继出口带宽 | `traffic.rxBps/txBps` 或 `foreign_relay_bps_limit` 对比 | 接近限速值告警 |
| 磁盘 | 数据目录所在分区 | > 80% 告警（SQLite + 下载目录） |
| 证书到期 | `certbot certificates` | 剩余 < 15 天告警 |

### 6.3 排障用的自查命令

```bash
ss -lntup | grep -E '8787|11010|15888'         # 端口占用
curl -s http://127.0.0.1:8787/api/v1/meta      # API 是否活着
curl -s http://127.0.0.1:8787/api/v1/regions   # 各区域中继可用性
```

---

## 7. 扩容思路

### 7.1 加子节点（首选，水平扩展）

1. 主控管理台签发注册密钥。
2. 在新区域服务器执行 `install-node.sh`（见 §2.3）。
3. 节点 `online` 后即自动参与调度。**不需要重启主控、不需要改配置**：
   单端口共享中继靠 `relay_network_whitelist = "mclink-room-*"` 覆盖所有房间网络。
4. 想让新节点优先被选中：`PATCH /admin/nodes/:id` 提高 `weight`；
   想停止分配新房间：`weight = 0` 或直接停用。

扩容时的注意点：

* **同一台机器只跑一个 mclink 中继实例**：RPC 端口按「端口 % 1000」推导，同机会撞。
* 中继节点应尽量靠近玩家（区域划分见 `packages/shared/src/regions.ts`）。
* 新节点上线后，**已存在的房间不会自动迁移**（`relayNodeIds` 在创建时定死）；
  需要迁移就改房间区域（`PATCH /rooms/:id` 的 `zone`）触发重新调度，或让房间重建。

### 7.2 多主控

当前架构**不支持多主控共享状态**：

* SQLite 是单机文件数据库（`node:sqlite`），没有跨节点复制；
* 房间/票据/节点表都在本地库，两个主控会各自算出一套 `subnetSlot` 与网络身份；
* 子节点的注册与心跳只指向一个 `--master`。

可行的两种做法：

1. **「一主控 + 多子节点」**（推荐）：主控只承担控制面，把中继全部下沉到子节点
   （主控加 `--no-relay`）。这样主控负载很小，可以长期单实例。
2. **多主控 + 外部共享存储**（需要改代码）：把 SQLite 换成 PostgreSQL/MySQL 并抽象仓储层，
   同时把会话/限流改为外置存储。当前代码没有为这条路径预留抽象。

### 7.3 容量告急的其它手段

* 虚拟网段只有 256 个 slot（`10.200.<slot>.0/24`）：同时开放房间不能超过 256。
  超了要改 `VNET_BASE_PREFIX` 的规划（例如扩成 `10.200.<a>.<b>.0/24`），**属于代码改动**。
* 房间默认 TTL 720 分钟、空房 600 秒回收（`MCLINK_ROOM_IDLE_TIMEOUT`）：
  调小可减少僵尸房间占用 slot。
* 平台级出口限速 `MCLINK_RELAY_BPS_LIMIT` 可防止个别房间吃满出口。

---

## 8. 环境变量参考（`server/src/config.ts`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MCLINK_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `MCLINK_PORT` | `8787` | HTTP 端口 |
| `MCLINK_PUBLIC_BASE_URL` | 空 | 对外基础 URL，用于下载链接与中继地址推导 |
| `MCLINK_TRUST_PROXY` | `true` | 是否信任 `X-Forwarded-For` |
| `MCLINK_DATA_DIR` | `<repo>/server/data` | 数据目录 |
| `MCLINK_DB_FILE` | `<data>/mclink.sqlite` | 数据库文件 |
| `MCLINK_DOWNLOADS_DIR` | `<data>/downloads` | 客户端安装包目录 |
| `MCLINK_WEB_ROOT` | `<repo>/server/public` | 前端构建产物目录 |
| `MCLINK_JWT_SECRET` | 自动生成并落盘 | JWT 签名密钥（≥16 字符） |
| `MCLINK_TOKEN_TTL_SECONDS` | `1209600`（14 天） | 登录令牌有效期，最小 300 |
| `MCLINK_RATE_LIMIT` | `240` | 单 IP 每分钟请求上限，最小 10 |
| `MCLINK_LOGIN_RATE_LIMIT` | `20` | 单 IP 每分钟登录/注册上限，最小 3 |
| `MCLINK_CORS_ORIGINS` | 空 | 逗号分隔的允许来源，`*` 表示全部 |
| `MCLINK_ADMIN_USER` | `admin` | 初始管理员用户名 |
| `MCLINK_ADMIN_PASSWORD` | 自动生成并落盘 | 初始管理员密码（**只在首次建号时生效**） |
| `MCLINK_ET_CORE` | 自动探测 | `easytier-core` 路径 |
| `MCLINK_ET_CLI` | 自动探测 | `easytier-cli` 路径 |
| `MCLINK_ET_CONFIG_DIR` | `<data>/easytier` | 生成配置目录 |
| `MCLINK_RELAY_PORT` | `11010` | 中继公共端口（TCP+UDP） |
| `MCLINK_RELAY_RPC` | `127.0.0.1:15888` | 中继 RPC portal（仅本机） |
| `MCLINK_RELAY_NETWORK` | `mclink-master` | 中继自身网络名（子节点用 `<该值>-node`） |
| `MCLINK_RELAY_SECRET` | 自动生成并落盘 | 中继自身网络密钥 |
| `MCLINK_RELAY_WHITELIST` | `mclink-room-*` | 允许中继的外来网络 wildmatch 白名单 |
| `MCLINK_RELAY_NO_TUN` | `true` | 中继是否创建 TUN |
| `MCLINK_RELAY_PUBLIC_HOST` | 空 | 客户端连接中继的公网主机名（留空时按 `PUBLIC_BASE_URL`→`Host` 回退） |
| `MCLINK_RELAY_BPS_LIMIT` | `0` | 中继出口限速（bit/s，0 = 不限） |
| `MCLINK_RELAY_MULTITHREAD` | `true` | 中继多线程 |
| `MCLINK_AUTOSTART_RELAY` | `true` | 是否随主控启动中继（`--no-relay` 会写 false） |
| `MCLINK_NODE_OFFLINE_TIMEOUT` | `90` | 子节点心跳超时判定离线（秒，最小 15） |
| `MCLINK_NODE_HEARTBEAT_INTERVAL` | `20` | 期望的心跳间隔（秒，最小 5） |
| `MCLINK_ROOM_IDLE_TIMEOUT` | `600` | 空房回收时间（秒，最小 60） |
| `MCLINK_REGISTRATION_OPEN` | `true` | 是否开放注册 |
| `MCLINK_LOG_LEVEL` | `debug`（非生产）/`info`（`NODE_ENV=production`） | 日志级别 |
| `MCLINK_SMTP_HOST` | 空 | SMTP 服务器地址（留空 = 未配置邮件服务） |
| `MCLINK_SMTP_PORT` | `465` | SMTP 端口 |
| `MCLINK_SMTP_SECURE` | `ssl` | `ssl`（465 直连 TLS）/ `starttls`（587）/ `none`（仅内网） |
| `MCLINK_SMTP_USER` | 空 | SMTP 登录账号（留空 = 不认证） |
| `MCLINK_SMTP_PASSWORD` | 空 | SMTP 登录密码 |
| `MCLINK_SMTP_FROM` | 空 | 发件人，可写 `mclink <no-reply@cnnic.link>`；留空则用账号 |
| `MCLINK_REQUIRE_EMAIL_VERIFICATION` | 未设置 | 是否要求验证邮箱才能建房/进房（未设置时用控制台里的值，出厂默认**开启**） |
| `MCLINK_EMAIL_CODE_TTL_MINUTES` | 未设置 | 验证码有效期（分钟，1–1440） |
| `MCLINK_SMTP_HELO` | `mclink.local` | EHLO 时通告的主机名 |

> 邮件相关变量的语义是**初始默认值**：管理台「平台设置 → 邮件服务」里保存过的值优先。
> 所以运维可以先用环境变量注一套能用的配置让平台跑起来，之后再在控制台改。
> 例外的两个是 `MCLINK_SMTP_PORT` 与 `MCLINK_SMTP_SECURE`——只在显式设置时才覆盖控制台的值。

### 邮件服务（SMTP）

主控**自己发信**，不依赖外部服务，也不需要额外进程。上线时要做的只有三件事：

1. 在控制台「平台设置 → 邮件服务」填 SMTP 地址、端口、加密方式、账号密码、发件人；
2. 点「发送测试邮件」——**成功才说明配置可用**（失败会把完整 SMTP 会话显示出来，报错基本都在那段对话里）；
3. 保持「要求验证邮箱」开启（出厂默认开启）。

注意「要求验证邮箱」与邮件服务是**一组开关**：开着验证却没有可用的 SMTP 时，
新用户注册会直接失败（控制台会显示一条红色提示）。此时要么把 SMTP 配好，要么临时关掉验证。

发件域名建议配好 SPF/DKIM，否则验证码邮件大概率进垃圾箱 —— 主控只负责把信交给你的
SMTP 服务器，投递信誉是发件域名的事。

子节点侧变量（`install-node.sh` 写入 `/etc/mclink/node.env`，由 `deploy/agent.mjs` 读取）：
`MCLINK_NODE_MASTER`、`MCLINK_NODE_ENROLL_KEY`、`MCLINK_NODE_REGION`、`MCLINK_NODE_ENDPOINT`、
`MCLINK_NODE_LISTEN_PORT`、`MCLINK_NODE_CONNECT_PORT`、
`MCLINK_NODE_NAME`、`MCLINK_NODE_CAPACITY_PEERS`、`MCLINK_NODE_TAGS`、`MCLINK_NODE_STATE_DIR`、
`MCLINK_NODE_LOG_DIR`、`MCLINK_NODE_LOG_FILE`、`MCLINK_NODE_INTERVAL`、`MCLINK_NODE_PUBLIC_IP`、
`MCLINK_NODE_LOG_LEVEL`、`MCLINK_ET_CORE`、`MCLINK_ET_CLI`。

### 子节点的两个端口：运行端口 vs 链接端口

子节点有**两个独立的端口**，这是为了支持「节点在 NAT / 端口映射后面」这种常见部署：

| 名字 | 变量 / 参数 | 含义 | 谁在用 |
| --- | --- | --- | --- |
| **运行端口** | `--listen-port` / `MCLINK_NODE_LISTEN_PORT` | 节点上 `easytier-core` 实际 bind 的端口 | 节点自己；防火墙/安全组要放行**它**（TCP+UDP） |
| **链接端口** | `--endpoint` 的端口 / `MCLINK_NODE_CONNECT_PORT` | 主控下发给客户端连接用的端口 | 客户端（房间票据里的 `tcp://host:port`） |

多数部署两者相同（都写 11010），此时 `--listen-port` 可以省略。
典型的需要区分的场景：机房只允许 21010 对外，于是本机绑 11010、外部把 21010 映射到 11010，
注册命令写 `--endpoint relay-sh.cnnic.link:21010 --listen-port 11010`。
主控会把「监听配置」按运行端口下发（节点据此 bind），把「客户端票据」按链接端口下发。

控制台「中继节点」列表会分别显示链接端口（Endpoint 列）与运行端口，两者不同时额外标注
`经 NAT：外部 21010 → 本机 11010`，编辑节点时也能单独改（改链接端口会自动同步 endpoint）。

### 一键安装子节点（主控生成的单条命令）

管理台「节点 → 签发注册密钥」填好区域、节点公网地址、运行端口、链接端口后，直接给出一条命令：

```bash
curl -fsSL https://cnnic.link/agent/install.sh | sudo bash -s -- \
  --master https://cnnic.link --key <一次性注册密钥> --region cn-east --name relay-sh \
  --endpoint relay-sh.cnnic.link:21010 --listen-port 11010
```

目标机器粘贴执行即可：脚本与 agent 由主控托管（`GET /agent/install.sh`、`GET /agent/agent.mjs`，
由 `server/src/server.ts` 读取仓库里的 `deploy/` 目录直接返回），无需先拿到本仓库，也不需要 scp。
脚本会装依赖、放好 EasyTier 二进制、注册节点、写 `/etc/mclink/node.env` 并拉起 systemd 服务。

排查：`curl -fsSL https://cnnic.link/agent/install.sh | head -n 3` 应输出 `#!/usr/bin/env bash`；
若输出 `<!doctype html>`，说明反代把 `/agent/` 改写到了前端静态目录。

### 国内节点：EasyTier 二进制的下载顺序与 GitHub 加速

子节点要拿到 Linux 版 `easytier-core` / `easytier-cli`。脚本按这个顺序尝试，越靠前越稳：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 本机已有产物 | `deploy/vendor/linux-x86_64/`（`pnpm fetch:easytier --all` 生成的），或 `--source` 指向的源码目录 |
| 2 | **从主控下载** | `GET /agent/easytier-core`、`GET /agent/easytier-cli`。主控若带着这两个文件（用 `pnpm pack:server` 打的源码包就带），国内节点**完全不需要碰 GitHub** |
| 3 | GitHub Releases | 可加 `--github-proxy <前缀>` 走加速，例如 `--github-proxy https://ghproxy.net/` |

> EasyTier 官方只发 **zip**，而 Debian 的 GNU `tar` **解不了 zip**。脚本现在会安装 `unzip`
> 并用它解包，缺失时依次退让到 `bsdtar` / `python3 -m zipfile`。（2026-09 之前的版本用的是
> `tar -xf xxx.zip`，表现为"下载成功、二进制没落地"，进而"主控中继未运行"。）

主控**自己**装的时候（`install-server.sh`）同样支持 `--github-proxy`，因为主控的中继也依赖这两个二进制——
直连 GitHub 超时的典型后果就是控制台里「主控中继 = 未运行」。

管理台「签发注册密钥」里的**「国内节点」**勾选框做的就是第 3 步：勾上就把
`--github-proxy` 加进那条命令（默认 `https://ghproxy.net/`，可自定义）。

> 这类公益代理会失效——实测 5 个里已有 2 个连不上。所以默认值只是"开箱能用"，
> 装机命令里会把值显式带上，换的时候不用改代码。当前实测可用：
> `https://ghproxy.net/`、`https://gh-proxy.com/`、`https://ghfast.top/`。

给主控补上 Linux 二进制（这样国内节点连代理都不需要）：

```bash
# 开发机
pnpm fetch:easytier --all
pnpm pack:server                      # 生成的包会带上 deploy/vendor/linux-x86_64/
# 或者只补二进制：直接把 deploy/vendor/linux-x86_64/ 拷到主控的同一路径下
```

---

## 9. 上线检查清单

- [ ] `systemctl is-active mclink-server` → active
- [ ] `journalctl -u mclink-server` 中没有 `未找到 easytier-core`
- [ ] `GET /api/v1/meta` 的 `easytierVersion` 非 `null`（说明 `easytier-cli` 可用，流量统计正常）
- [ ] `GET /api/v1/stats` 的 `nodes.online` 符合预期
- [ ] 已从公网验证：`8787` 未被直接暴露（或已加反代），`11010` TCP+UDP 可达
- [ ] 管理员已改掉初始密码
- [ ] `/etc/mclink/mclink.env` 与 `/opt/mclink/data/secrets.json` 权限正确、已纳入备份
- [ ] 数据库备份定时任务已生效（并**实际做过一次恢复演练**）
- [ ] 证书自动续期正常（`certbot renew --dry-run`）
- [ ] 已确认 `MCLINK_REGISTRATION_OPEN` 是否符合运营策略
