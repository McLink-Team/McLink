# mclink 部署速查

面向运维的**最短路径**文档。原理、边界与安全讨论见 `../docs/architecture.md`、`../docs/security.md`；
完整生产手册见 `../docs/deployment.md`。

本目录文件一览：

| 文件 | 用途 |
| --- | --- |
| `install-server.sh` | 主控一键安装 / 升级（Debian 12 x86_64） |
| `mclink-server.service` | 主控 systemd 单元（由脚本安装到 `/etc/systemd/system/`） |
| `install-node.sh` | 子节点（区域中继）一键安装 |
| `mclink-node.service` | 子节点 systemd 单元 |
| `agent.mjs` | 子节点 agent：注册 + 守护 easytier-core + 心跳上报（纯 Node，零依赖） |
| `nginx.conf.example` | TLS 反代示例（含 `/ws` 的必需配置与证书申请提示） |
| `vendor/` | 已被 gitignore 的 EasyTier 产物缓存目录，脚本会优先复用 |

---

## 0. 端口与前置条件

| 端口 | 协议 | 用途 | 是否要对公网开放 |
| --- | --- | --- | --- |
| 8787（`--port`） | TCP | 主控 HTTP/WebSocket + 控制台 | **建议只给反代**，不要直接暴露 |
| 11010（`--relay-port`） | TCP **和** UDP | 主控共享中继（单端口承载所有房间） | **必须开放 TCP+UDP** |
| 15888 | TCP（仅本机） | 主控中继实例的 RPC portal | 不要开放 |
| `16000 + 端口 % 1000` | TCP（仅本机） | 子节点 / 客户端实例的 RPC portal | 不要开放 |

前置：Debian 12 x86_64、root 权限、能访问 GitHub Releases（下载 EasyTier）与 deb.nodesource.com（装 Node）。

---

## 1. 单机最小部署（主控自带中继，不需要子节点）

```bash
# 1) 在目标机上取得源码
git clone <仓库地址> /opt/src/mclink && cd /opt/src/mclink

# 2) 一键安装（会自动装 Node、装依赖、构建前端、下载 EasyTier、写 env、装服务）
sudo bash deploy/install-server.sh --port 8787 --relay-port 11010

# 3) 记下脚本打印的初始管理员密码（只打印一次），然后打开控制台
#    http://<服务器IP>:8787
```

要点：

* 单机就能开房。房间创建时会自动把**主控自身中继**作为兜底入口（`masterRelayEndpoint()`），
  所以「一台主控 + 没有子节点」也能正常联机。
* 中继只监听一个端口，靠 `relay_network_whitelist = "mclink-room-*"` 为所有房间网络转发，
  新增/关闭房间**不需要重启中继**。
* 若只想跑控制面、房间流量全走子节点：加 `--no-relay`（写入 `MCLINK_AUTOSTART_RELAY=false`）。
  此时没有子节点就会建房失败并提示「当前没有可用的中继节点」。

## 2. 主控 + 多区域子节点

```bash
# 步骤 1：在主控管理台 →「节点」→「签发注册密钥」，复制返回的一键命令
#         （或只复制 enrollKey）

# 步骤 2：在区域服务器上执行（把仓库的 deploy/ 目录拷过去，或整仓 clone）
sudo bash deploy/install-node.sh \
  --master https://master.example.com \
  --key <注册密钥> \
  --region cn-east \
  --endpoint relay-sh.example.com:11010 \
  --name relay-sh
```

要点：

* `--endpoint` 是**客户端连接该节点用的公网地址**，端口就是该节点的 EasyTier 监听端口；
  安全组/防火墙必须同时放行该端口的 **TCP 与 UDP**。
* 节点注册后状态是 `pending`，**首次心跳成功**才转为 `online`（心跳间隔默认 20 秒，
  服务端 90 秒无心跳判定离线）。
* 注册密钥是一次性的。装好后可以把 `MCLINK_NODE_ENROLL_KEY` 从 `/etc/mclink/node.env` 清空：
  ```bash
  sudo sed -i 's/^MCLINK_NODE_ENROLL_KEY=.*/MCLINK_NODE_ENROLL_KEY=/' /etc/mclink/node.env
  sudo systemctl restart mclink-node
  ```
* 房间调度按区域取节点：`auto` 时按「权重 × 剩余容量」排序取前 2 个做冗余；
  指定区域无可用节点时会回退到全局（并打 `warn` 日志）。

## 3. 反向代理与 TLS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/mclink.conf
sudo nano /etc/nginx/conf.d/mclink.conf     # 改 server_name 与证书路径
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mclink.example.com
sudo nginx -t && sudo systemctl reload nginx
```

* **`/ws` 必须单独配置**：`proxy_http_version 1.1` + `Upgrade`/`Connection` 头 +
  `proxy_read_timeout 3600s`，否则实时状态不刷新（原因见示例文件顶部注释）。
* 只走反代时不要对公网放行 8787；**中继端口 11010 仍要开放 TCP+UDP**（它不是 HTTP，无法走 http 反代），
  或者用 `nginx.conf.example` 末尾的 `stream {}` 示例代理 TCP 与 UDP。
* 记得给系统环境变量补上对外地址，否则下载链接与客户端中继地址会推导错：
  `MCLINK_PUBLIC_BASE_URL=https://mclink.example.com`（`install-server.sh --public-url` 会自动写入）。

## 4. 升级流程（重点：别把密钥弄丢）

```bash
cd /opt/src/mclink && git pull            # 或重新上传源码
sudo bash deploy/install-server.sh        # 不带参数即沿用上次的默认端口
```

* 升级脚本会**保留** `/etc/mclink/mclink.env` 里已有的 `MCLINK_JWT_SECRET`、
  `MCLINK_RELAY_SECRET`（以及未显式指定的 `MCLINK_ADMIN_PASSWORD`），只更新路径/端口类变量。
  每次写文件前都会备份成 `mclink.env.bak.<时间戳>`。
* 想强制轮换密钥：`--rotate-secrets`（**所有登录令牌与旧房间票据立即失效**，谨慎使用）。
* `MCLINK_ADMIN_PASSWORD` 只在**首次建号**时生效；改了它**不会**改已存在账号的密码。
  忘记密码请参考 `../docs/troubleshooting.md`。
* 绝对不要手工删除 `/opt/mclink/data/secrets.json`：JWT / 中继密钥 / 初始管理员密码的落盘兜底在那里。
* 子节点升级：重新在源码目录执行 `install-node.sh`（同参数），令牌文件 `/etc/mclink/node-token.json`
  会被保留，**不需要重新签发注册密钥**。

## 5. 常见故障速查

| 症状 | 最可能原因 | 处置 |
| --- | --- | --- |
| 主控日志 `未找到 easytier-core` | 下载失败或路径不对 | 检查 `/opt/mclink/app/vendor/easytier/`；重跑 `install-server.sh`（不加 `--skip-easytier`），或设置 `MCLINK_ET_CORE` |
| 房间创建报「当前没有可用的中继节点」 | 用了 `--no-relay` 且没有在线子节点 | 让至少一个子节点 `online`，或去掉 `--no-relay` 重启主控 |
| 子节点一直 `pending` | agent 起不来 / 心跳失败 / 令牌无效 | `journalctl -u mclink-node -f`；确认 `--master` 可达、`--endpoint` 格式正确 |
| 子节点 `offline` | 90 秒内没收到心跳 | 看 agent 日志里的心跳报错（网络/DNS/防火墙） |
| 客户端能登录但进不了房间 | `bind_device`、中继端口未放行 UDP、票据过期 | 见下一节与 `../docs/troubleshooting.md` |
| 端口 11010 被占用 | 与其它服务或历史 easytier-core 冲突 | `ss -lntup \| grep 11010`；换 `--relay-port` 或杀掉旧进程 |
| 流量统计为 0 | `easytier-cli` 不存在或 RPC portal 不通 | 确认 `vendor/easytier/easytier-cli` 存在且 `MCLINK_RELAY_RPC=127.0.0.1:15888` |
| 启用了严格端口模式后 MC 连不上 | 端口白名单没包含 25565 | 房间设置里把 `allowedPorts` 填成 `25565`（或先关闭严格模式） |
| 改了 `MCLINK_ADMIN_PASSWORD` 但登录不了 | 该变量只在首次建号时生效 | 用原密码登录后在「账号设置」改密，或查 `../docs/troubleshooting.md` |

### 重点：`bind_device` 的坑

EasyTier 默认 `bind_device = true`，会把隧道的出站套接字绑到指定网卡；在受限容器、
多网卡、Windows 沙箱等环境会直接报 `WSAEADDRNOTAVAIL / 10049`，表现为**能登录主控、
但永远进不了房间**（客户端 easytier-core 起来后连不上中继）。

平台已经在中继实例、子节点实例、以及下发给客户端的票据 TOML 里统一设置
`bind_device = false`：

* 中继：`server/src/easytier/manager.ts` 的 `bindDevice: false`
* 子节点：`server/src/services/nodes.ts` 的 `renderNodeConfig()` → `bindDevice: false`
* 客户端：`server/src/services/rooms.ts` 的 `ticket()` → `bindDevice: false`
  （客户端 `client/electron/main.cjs` 只把票据里的 TOML 原样落盘，不自行改配置）

**因此不要手工去改生成的配置文件**（`/opt/mclink/data/easytier/relay.toml`、
`/etc/mclink/relay.toml`、客户端的 `%APPDATA%/<应用>/easytier/relay.toml`）：
改了会在下次同步时被覆盖；若确有需要，请改源码或提 issue 说明环境。

## 6. 运维命令速查

```bash
systemctl status  mclink-server        # 主控状态
journalctl -u mclink-server -f         # 主控日志
journalctl -u mclink-server --since "10 min ago"

systemctl status  mclink-node          # 子节点状态
journalctl -u mclink-node -f           # agent 日志

# 主控中继自身的日志（easytier-core 的 stdout/stderr）
tail -f /opt/mclink/data/logs/relay.log

# 数据库备份（WAL 模式，务必用 .backup 或先 checkpoint）
sqlite3 /opt/mclink/data/mclink.sqlite ".backup '/root/mclink-$(date +%F).sqlite'"

# 在线状态自查
curl -s http://127.0.0.1:8787/api/v1/meta | head -c 400
curl -s http://127.0.0.1:8787/api/v1/stats | head -c 400
```

## 7. 关于「主控下发的一键命令」

管理台「签发注册密钥」返回的 `command` 形如：

```bash
curl -fsSL https://master.example.com/agent/install.sh | sudo bash -s -- \
  --master https://master.example.com \
  --key <注册密钥> \
  --region cn-east \
  --endpoint relay-sh.example.com:11010
```

这条命令依赖主控静态目录里存在 `/agent/install.sh`（以及可选的 `/agent/agent.mjs`），
而**当前代码只静态托管 `/downloads/` 与前端构建产物**，所以默认会取到前端页面而不是脚本，
直接执行会失败。

两种可用做法：

1. **（推荐）手工拷贝**：把仓库 `deploy/install-node.sh` 与 `deploy/agent.mjs` 拷到区域服务器，
   然后 `sudo bash install-node.sh --master ... --key ... --region ... --endpoint ...`。
2. **让主控能提供安装脚本**（可选，注意构建会清空目录）：
   ```bash
   sudo install -D -m 0644 /opt/mclink/app/deploy/install-node.sh /opt/mclink/app/server/public/agent/install.sh
   sudo install -D -m 0644 /opt/mclink/app/deploy/agent.mjs      /opt/mclink/app/server/public/agent/agent.mjs
   ```
   之后管理台给出的命令即可直接执行（`install-node.sh` 在本地找不到 `agent.mjs` 时会从
   `${MASTER}/agent/agent.mjs` 下载）。
   注意 `pnpm build:web` 会清空 `server/public/`，每次重新构建前端后都要重跑上面两条命令。
