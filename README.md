# McLink

**基于 [EasyTier](https://github.com/EasyTier/EasyTier) 的局域网联机平台，支持《我的世界》等各类局域网联机游戏。**
一台主控、一个端口，把分散在各地的玩家拉进同一个虚拟局域网里开黑——不需要公网 IP、不需要端口映射、
不需要玩家装任何组网工具。

```
玩家 A（上海）──┐
玩家 B（广州）──┼──► 区域中继 :11010（一个端口，承载所有房间）──► 各房间彼此隔离
玩家 C（成都）──┘        主控只做控制面，不参与转发
```

---

## 它是什么

McLink = **主控（Master）** + **区域子节点（Relay）** + **Windows 客户端** + **管理控制台**。

* **主控**负责账号、房间编排、票据签发、子节点调度、流量账本与实时推送；
* **子节点**是部署在各区域的公共中继，让玩家就近接入；
* **客户端**在玩家本地托管一个 `easytier-core`，用主控下发的票据加入房间的虚拟网络；
* 每个房间是一个**独立的 EasyTier 网络**，网络名与密钥随机生成，彼此无法互相发现。

核心工程结论（也是本项目最大的设计点）：**每个中继只监听一个端口即可承载所有房间**——
中继按网络名（`relay_network_whitelist = "mclink-room-*"`，wildmatch）决定是否为某个网络转发，
所以新建/关闭房间都不需要重启中继进程，也不需要额外的端口。转发**全部**由子节点承担
（主控不再自带中继实例，单机部署就把主控这台机器注册成一台普通子节点）。原理与边界见
[docs/architecture.md](docs/architecture.md)。

---

## 功能特性

### 面向玩家

* **一键建房/进房**：建房得到 6 位加入码，朋友输入即可进；可选「密码加入」或「房主审批」。
* **自动就近中继**：按区域调度中继节点（华东/华南/华北/华中/西南/西北/东北/香港/海外），
  自动选择延迟更低的路径；每房一个主中继 + 一个兜底中继（同档延迟里挑空余带宽最大的），
  兜底会在节点状态变化时浮动切换。单机部署把主控注册成一台普通子节点即可。
* **局域网广播直通（可选，默认关）**：房主可以在「房间规则」里打开，让 Minecraft
  「多人游戏」列表直接看到房间、不用手抄 IP。默认关闭是有意的——它在 Windows 上依赖
  WinDivert 内核网络过滤驱动，等于给每台机器装一个系统级网络驱动，实测会与部分软件的
  网络栈冲突（见 `docs/troubleshooting.md` §16）。关着的时候用「直接连接 + 虚拟地址」照常联机。
* **P2P 优先**：允许成员间直连（可关闭以强制走中继，便于控制流量与可观测）。
* **零配置客户端**：客户端只需要登录——网络身份、虚拟地址、中继列表、启动参数全部由主控下发。
* **实时状态**：房间成员、延迟、P2P 直连状态、房间流量一目了然。
* **房主控制权**：审批进房、踢人、轮换密钥、房间策略（人数上限、端口白名单、包速率限制、公告）。
* **房间聊天**：房间内文字聊天（含 Emoji、系统消息、未读徽章），房主可删除刷屏消息；
  成员离开/被踢/审批都会留下系统消息，便于回溯「房间里发生了什么」。
* **游戏快连**：内置常见局域网游戏端口预设（MC Java/基岩、泰拉瑞亚、星露谷、饥荒、英灵神殿…），
  直接给出「房主该开什么、玩家该填什么」并一键复制。
* **连接诊断**：告诉你当前是 P2P 直连还是经中继、各节点延迟与隧道协议、NAT 类型，
  并给出可执行的改善建议（而不是只丢一堆数字）。
* **联机地址一眼可见、一点即复制**：房间页顶部的地址铭牌放大显示，点整块或点「复制地址」
  都能立刻拿到，直接粘贴给朋友（不用切窗口、也不用去翻日志）。
* **邮箱验证**：主控内置 SMTP 客户端（SSL 465 / STARTTLS 587，零外部依赖与额外进程），
  注册时发 6 位验证码；开启「要求验证邮箱」后，未验证的账号无法建房/进房。
  SMTP 参数在控制台可配，并能发测试邮件（失败时回显完整 SMTP 会话）。
* **公共广场 / 收藏 / 最近**：浏览公开房间，收藏常去的房间，一键重新进入。
* **首次使用向导**：检测管理员权限（建虚拟网卡必需）并引导完成第一次联机。

### 面向管理员

* **一键部署**：Debian 12 上 `install-server.sh` 一条命令装完（Node、依赖、前端构建、EasyTier、systemd）。
* **一键扩区域**：管理台签发一次性注册密钥（顺手填好区域与两个端口）→ 直接得到**一条**
  `curl -fsSL <主控>/agent/install.sh | sudo bash -s -- …` 命令，在区域服务器上粘贴执行即可：
  脚本与 agent 都由主控托管，不需要先拿到仓库，也不用 scp 文件。节点注册后自动上线参与调度。
* **运行端口与链接端口分离**：节点在 NAT / 端口映射后面时（本机绑 11010、对外只开 21010），
  主控按运行端口下发监听配置、按链接端口下发客户端票据——两种端口都能在控制台单独查看与修改。
* **国内节点加速**：签发密钥时可勾选「国内节点」，命令会带上 GitHub 加速前缀（默认 `ghproxy`，
  可自定义）。更稳的是让主控直接托管 EasyTier 二进制（`pnpm pack:server` 打的包就带），
  这样子节点连 GitHub 都不用碰。下载顺序：本机已有 → 从主控取 → GitHub（带代理）。
* **节点管理**：上下线、权重、容量、区域、标签、停用；节点 `pending → online` 自动流转，超时自动判离线。
* **房间与用户管理**：强制关房、改策略、封禁/解封、角色、流量配额、房间数上限。
* **流量监控**：平台级/房间级/节点级收发速率与累计用量，72 小时时序曲线，中继外来网络明细。
* **审计日志**：登录、注册、建房、加入、审批、踢人、轮换密钥、所有管理员操作全部落库。
* **安全默认值**：scrypt 口令哈希、令牌只存 sha256、会话可吊销、按 IP 限流、房间票据短时效。

---

## 架构简图

```
                    ┌──────────────────────────────────────────────┐
   浏览器（玩家/管理员）│  主控 Master   node server/src/index.ts :8787 │
   HTTP + WebSocket   │  REST API · WS Hub · 静态托管(前端) · SQLite  │
                    └───────────────┬──────────────────────────────┘
                                    │ 控制面：注册 / 心跳 / 票据 / 调度
                    ┌───────────────▼──────────────┐
                    │ 区域中继（子节点）             │  ← 单端口共享中继
                    │ easytier-core :11010 TCP+UDP  │
                    │ relay_network_whitelist =     │
                    │   "mclink-room-*"             │
                    └───┬───────────────┬───────────┘
              ┌─────────▼──────┐  ┌─────▼──────────┐
              │ 子节点 cn-east │  │ 子节点 hk      │   ← 各区域就近中继
              │ agent + core   │  │ agent + core   │
              └─────────┬──────┘  └─────┬──────────┘
                        └───────┬───────┘
          ┌─────────────────────┴─────────────────────┐
     ┌────▼─────┐            ┌──────────┐        ┌────▼─────┐
     │ 房主客户端│            │ 成员客户端│        │ 成员客户端│
     │10.200.7.1│            │10.200.7.2│        │10.200.7.3│
     └──────────┘            └──────────┘        └──────────┘
      同一个房间 = 同一个 EasyTier 网络（网络名由 32 位随机密钥派生）
```

---

## 快速开始

### 本机开发（3 条命令）

```bash
pnpm install          # 安装依赖
pnpm fetch:easytier   # 下载 EasyTier 到 vendor/easytier/
pnpm dev:server       # 主控启动：http://127.0.0.1:8787
```

需要 **Node.js ≥ 22.6**（推荐 24）与 pnpm 10。首次启动会自动生成
`server/data/secrets.json`（JWT / 中继密钥 / 初始管理员密码）并创建管理员账号，
密码会打印在启动日志里。想固定密码：

```bash
MCLINK_ADMIN_PASSWORD='请替换成强密码' pnpm dev:server
```

前端热更新另开一个终端（已配好 API/WS 代理）：

```bash
pnpm dev:web          # http://127.0.0.1:5173
```

验证（两个实验都会**真的**拉起 easytier-core 进程，不是 mock）：

```bash
pnpm test             # 单元测试（限速单位换算、TOML 生成、ACL 构造、地址规划…）
pnpm lab              # 控制面：单端口多房间、房间隔离、网络名准入、调度、踢人、流量归因
pnpm lab:dataplane    # 数据面：真实 TCP 跑通，并验证限速真的把带宽压到设定值
```

实测结果（本机，真实 EasyTier 2.6.4 二进制）：

| 实验 | 结果 |
| --- | --- |
| `pnpm lab` | **101/101** 断言通过，含「7 份生成的配置全部通过 `easytier-core --check-config`」 |
| `pnpm lab:dataplane` | **20/20** 通过：不限速 2 MiB / 11 ms（约 1.5 Gbps）→ 限速 1000 kbps 后 2 MiB / 18.7 s（**896 kbps**） |

详见 [docs/development.md](docs/development.md) 与 [docs/architecture.md](docs/architecture.md) §7.3。

### Debian 部署（1 条命令）

```bash
git clone <仓库地址> /opt/src/mclink && cd /opt/src/mclink

# 主控（不配 SMTP 的话记得加 --no-verify-email，否则注册会被挡住）
sudo bash deploy/install-server.sh --public-url https://cnnic.link \
  --smtp-host smtp.exmail.qq.com --smtp-secure ssl \
  --smtp-user no-reply@cnnic.link --smtp-password '<授权码>' \
  --smtp-from 'mclink <no-reply@cnnic.link>'
```

脚本会装 Node、装依赖、构建前端、下载 EasyTier、写 `/etc/mclink/mclink.env`、
安装并启动 systemd 服务、按需放行 ufw，最后打印**只显示一次**的初始管理员密码。
升级就是 `git pull` 后再跑同一条命令（密钥与邮件配置都会保留）。

> **主控不自带中继**：转发全在子节点上，所以装完主控后必须至少有一个可调度的子节点，
> 否则建房会报「当前没有可用的中继节点」。只有一台服务器时，把主控这台机器也注册成普通子节点：
>
> ```bash
> sudo node /opt/mclink/app/deploy/register-self-node.mjs --region oversea
> ```

加一个区域子节点：管理台「节点 → 签发注册密钥」填好区域与端口，它会给你**一条命令**，
在区域服务器上粘贴执行即可（脚本与 agent 由主控托管，不用先拿仓库）：

```bash
curl -fsSL https://cnnic.link/agent/install.sh | sudo bash -s -- \
  --master https://cnnic.link --key <注册密钥> --region cn-east --name relay-sh \
  --endpoint relay-sh.cnnic.link:21010 --listen-port 11010
```

* 端口清单：**8787**（HTTP，建议只给反代）、**11010 TCP+UDP**（中继，必须公网，开在跑中继的机器上）。
* 反代与证书：`deploy/nginx.conf.example`（`/ws` 必须单独配置，文件里写了原因）。
* 速查：[deploy/README.md](deploy/README.md)；完整手册：[docs/deployment.md](docs/deployment.md)。

---

## 技术栈与选型理由

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 运行时 | **Node.js 24** + TypeScript | 见下 |
| 后端 | Node 原生 TS 剥离直接跑 `.ts`（**无需构建**）+ 自研极简 HTTP 路由 | 去掉构建步骤与框架依赖，改完即生效；路由/鉴权/错误码完全可控 |
| 数据库 | 内置 **`node:sqlite`**（WAL） | **零原生依赖**：不需要 node-gyp/MSVC/编译工具链，Debian 上不需要装 build-essential |
| 实时 | `ws` + 话题订阅（platform/nodes/rooms/traffic/room:\<id\>/user:\<id\>） | 一个 WebSocket 覆盖落地页、房间页与管理台 |
| 前端 | Vite + Vue 3（产物输出到 `server/public`） | 主控**一个进程**同时提供 API、控制台与落地页，生产只需要一个 systemd 服务 |
| 客户端 | Electron（Windows） | 需要托管本地 `easytier-core` 子进程并与虚拟网卡交互，浏览器沙箱做不到 |
| 组网 | EasyTier（子进程调用，未修改其代码） | 成熟的 P2P/中继组网，支持 wildmatch 中继白名单与 ACL |

### 为什么是 Node.js 而不是 Rust

本项目的**原设计文档首选 Rust**（性能与单二进制部署）。实际落地时改成了
**Node.js 24 + TypeScript**，原因是统一工具链、降低部署复杂度：

1. **web 前端与 Electron 客户端本来就依赖 Node**——再引入 Rust 意味着维护两套工具链、
   两套 CI、两套依赖锁定；
2. **后端零原生依赖**：`node:sqlite` + Node 原生 TS 剥离，使得服务端**不需要构建步骤**，
   `node server/src/index.ts` 直接跑，也不用在目标机上装编译工具链；
   Rust 方案虽然产物是单个二进制，但要为每个目标平台做交叉编译与产物分发；
3. **性能不是瓶颈**：主控只做编排（不转发、也不再调 CLI 采样），真正的转发与加密
   由 EasyTier（Rust 编写）承担，且都在子节点上；
4. **排障与二次开发成本更低**：服务端代码即运行时代码，运维可以直接读、直接改。

代价与边界也如实记录：[docs/security.md](docs/security.md) 列出了当前实现的已知弱点，
[docs/api.md](docs/api.md) 文末列出了协议里"已定义但尚未实现"的部分。

---

## 目录结构

```
server/                主控后端（Node + TS，直接运行）
  src/api/             REST 路由：public / auth / rooms / agent / admin
  src/services/        业务：auth / rooms / nodes / settings
  src/easytier/        EasyTier 封装：TOML 生成、CLI 版本探测（主控不再托管中继实例）
  src/db/              SQLite 仓储与迁移
  src/ws/              WebSocket 推送中心
web/                   官网页 + 管理员控制台（Vite + Vue3）
client/                Windows 客户端（Electron）
packages/shared/       服务端/网页/客户端共用的类型与线协议
deploy/                安装脚本、systemd 单元、子节点 agent、nginx 示例
docs/                  架构、API、部署、开发、安全、排障文档
scripts/               fetch-easytier / lab / capture 辅助脚本
```

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 组件图、**单端口多房间隔离的原理与边界**、房主/成员体系、票据机制、虚拟地址规划、调度策略、流量与限速的落地位置、已核实的技术事实 |
| [docs/api.md](docs/api.md) | REST API 全量参考（真实路由/鉴权/请求响应/错误码）+ WebSocket 协议 + 与实现不一致的已知点 |
| [docs/deployment.md](docs/deployment.md) | 生产部署手册：容量规划、Debian 从零部署、systemd 运维、备份（WAL 注意事项）、日志、监控、扩容、环境变量全表、上线检查清单 |
| [docs/development.md](docs/development.md) | 本地开发：环境、命令、端到端实验、代码结构导览、如何加新 API、如何改房间策略 |
| [docs/security.md](docs/security.md) | **安全模型与已知边界**：网络名即准入凭证的来龙去脉、已实测限制、加固措施、弱点清单、合规 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 排障手册：症状 → 原因 → 处置 |
| [docs/mctier-parity.md](docs/mctier-parity.md) | 与 MCTier 的功能对照、差距分析、分期路线，以及**许可边界提醒**（MCTier 是 Source-Available 非商业许可，只借鉴功能不抄代码） |
| [docs/design.md](docs/design.md) | **视觉设计（信号室）+ 令牌契约 + 检测器验收方式**：颜色只能来自令牌、被明令禁止的写法、两条产品决定（不做置顶小窗、进房即落房间页） |
| [deploy/README.md](deploy/README.md) | 部署速查：单机最小部署、多区域子节点、升级流程、故障速查表、`bind_device` 的坑 |
| [deploy/nginx.conf.example](deploy/nginx.conf.example) | TLS 反代示例（含 WebSocket 必需配置与 certbot 提示） |

---

## 安全提示（务必先读）

* **单端口共享中继架构下，EasyTier 网络名就是准入凭证**——`network_secret` 只在
  `private_mode` 开启时校验，而共享中继不能开 `private_mode`。
  因此平台把网络名设计为由房间密钥派生的 128 bit 不可猜测令牌；6 位加入码只走主控 API。
* **已实测边界**：攻击者若已拿到网络名但密钥错误，EasyTier v2.6.4 仍会把它接入房间的 peer 网表
  （能看到成员虚拟 IP）；主控侧准入与**密钥轮换**仍然有效。需要更强成员认证时建议改用
  EasyTier 的 secure mode + credential（当前未实现）。
* 默认 **不要对公网直接暴露 8787**，用反向代理做 TLS；跑中继的子节点必须放行 **11010 的 TCP+UDP**。
* 完整限制清单（含待修复项）见 [docs/security.md](docs/security.md)。

---

## 许可证与合规

* **EasyTier 采用 LGPL-3.0**。本项目**通过子进程调用** `easytier-core` / `easytier-cli`
  （`spawn`，配置文件与命令行参数由主控生成），**未修改其代码、未链接、未再分发修改版**，
  因此不构成衍生作品；部署时下载的二进制来自 EasyTier 官方 Release，请遵守其许可证。
* 本项目自身代码以根目录 `package.json` 声明的 **AGPL-3.0-or-later** 发布。
* **《我的世界》（Minecraft）及其相关商标、素材、游戏内容归 Mojang Studios / Microsoft 所有。**
  本项目是独立的第三方联机工具，与 Mojang 无任何关联，也不包含任何游戏资源。
* **仅供合法联机用途**。请勿用于规避游戏授权、绕过服务器规则或任何违法用途；
  使用者需自行遵守所在地区法律与游戏服务条款。
* 平台会记录账号、IP 与流量数据用于运维与审计（流量明细默认保留 72 小时），
  部署方应按当地法规在隐私政策中告知用户并设定保留期限。
