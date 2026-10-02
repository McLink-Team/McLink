# mclink 本地开发

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.6**（开发机实测 v24.19.0） | 需要原生 TypeScript 剥离（type stripping）与内置 `node:sqlite`。**不需要**任何编译工具链 |
| pnpm | **10.33.2**（见根 `package.json` 的 `packageManager`） | `corepack enable` 即可；monorepo 用 workspace 协议 |
| 操作系统 | Windows / macOS / Linux | Windows 客户端是 Electron；服务端跨平台 |

不需要：TypeScript 编译器（后端直接跑 `.ts`）、node-gyp、Python、MSVC、数据库服务。
`tsc` 只在 `pnpm typecheck` 时用（devDependency）。

## 2. 起步：三条命令

```bash
pnpm install          # 安装依赖（workspace 会把 packages/shared 链接进 server、web、client 三个包）

pnpm fetch:easytier   # 下载 EasyTier 发行包到 vendor/easytier/
                      # 已有二进制时它会跳过；--all 可同时下 Windows+Linux；--version v2.6.4 指定版本

pnpm dev:server       # 启动主控：http://127.0.0.1:8787
```

> 🌐 **国内网络**：主远端是 GitHub，`git push` / `git pull` 需要挂代理（本仓库已配好 7890）
> —— 见 **§10.2**；远端约定、主控部署路径、以及那几个"打真接口"的检查脚本都在 **§10**。

首次启动会在 `server/data/` 生成 `secrets.json`（JWT / 中继密钥 / 初始管理员密码）并建管理员账号。
管理员密码会打印在启动日志里；也可以自己指定：

```powershell
# Windows PowerShell
$env:MCLINK_ADMIN_PASSWORD = "dev-only-passw0rd"
pnpm dev:server
```

```bash
# Linux / macOS
MCLINK_ADMIN_PASSWORD='dev-only-passw0rd' pnpm dev:server
```

前端另开一个终端：

```bash
pnpm dev:web          # Vite 开发服务器：http://127.0.0.1:5173
                      # /api、/ws、/downloads 已配置代理到 http://127.0.0.1:8787
                      # 可用 MCLINK_MASTER 指向别的主控
```

## 3. 常用脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:server` | 主控开发模式（`node --watch src/index.ts`，改后端自动重启） |
| `pnpm dev:web` | 前端 Vite 开发服务器（5173，带 API/WS 代理） |
| `pnpm dev:client` | Electron 客户端开发模式 |
| `pnpm build:web` | 构建前端到 **`server/public/`**（主控一个进程同时提供 API + 控制台） |
| `pnpm build:client` / `pnpm dist:client` | 构建 / 打包 Windows 客户端安装包 |
| `pnpm start` | 生产方式启动主控（`node src/index.ts`，不带 watch） |
| `pnpm typecheck` | 全仓 `tsc --noEmit` / `vue-tsc` |
| `pnpm test` | 服务端测试（`node --test --test-concurrency=1 test/*.test.ts`） |
| `pnpm fetch:easytier` | 下载 EasyTier 到 `vendor/easytier/` |
| `pnpm lab` | 控制面端到端实验（**真的**拉起 easytier-core 进程，见 §4） |
| `pnpm lab:dataplane` | 数据面与限速实验（真实 TCP 测速 + 限速前后对比，见 §4.1） |
| `pnpm verify:lockfile` | 校验 `pnpm-lock.yaml` 与所有 `package.json` 一致（约 0.3 秒，见 §9） |
| `pnpm pack:server` | 打一个可拷到服务器直接安装的源码包（`out/mclink-src.tar.gz`，见 `deploy/README.md`） |
| `node scripts/capture.mjs <输出文件> <命令> [参数...]` | 把子进程 stdout+stderr 落文件（本机沙箱禁管道 stdio 时用） |

> **关于 `pnpm test`**：`server/test/unit.test.ts` 已包含一套单元测试（40 个用例），覆盖
> TOML 生成、ACL 构造、虚拟地址规划、`easytier-cli` 输出解析、房间凭证、邮箱验证码与
> SMTP 组信（RFC 2047 / base64）、子节点端口分离的回退规则。
> 新增测试按 `server/test/*.test.ts` 放置即可直接生效（Node 原生 TS 剥离同样适用于测试文件）。

## 3.1 客户端的主控地址是「编译期嵌入」的

平台**不开放自建主控**，客户端里没有任何修改服务器地址的入口：

- 地址由打包时的环境变量 `VITE_MCLINK_MASTER` 注入渲染层，运行时只读
  （见 `client/src/lib/api.ts`：不再写入 localStorage，避免被篡改）。
- 未注入时回退到本地开发地址 `http://127.0.0.1:8787`，界面上会显示一条黄色提示。
- `pnpm build:client` 在未注入时会**警告**；`pnpm dist:client` 会**直接失败**，
  以免打出「指向 localhost」的正式安装包（那种坏法是装完连不上、却看不出哪里错）。
  本地只想验证打包流程时可加 `--allow-dev-master`。

```bash
# 正式发包（把域名换成你自己的主控）
VITE_MCLINK_MASTER=https://cnnic.link pnpm dist:client

# 或在 client/.env.local 里写（该文件不入库，见 client/.env.example）
VITE_MCLINK_MASTER=https://cnnic.link
```

这样设计有两个目的：一是避免玩家被诱导把客户端指向钓鱼主控；
二是让「房间票据只能由官方主控签发」这条安全前提真正成立。

### 发布步骤（打包完 ≠ 下载页就能用）

下载页的产物来自主控的下载目录，**不是** `client/release/`，所以打完包还要发布一次：

```bash
# 1) 打包（产物在 client/release/）
VITE_MCLINK_MASTER=https://cnnic.link pnpm dist:client

# 2) 放进主控的下载目录（默认 server/data/downloads，可用 MCLINK_DOWNLOADS_DIR 改）
cp client/release/McLink-Setup-0.1.0-x64.exe server/data/downloads/

# 产物名由 client/electron-builder.yml 的 artifactName 决定，格式是
#   McLink-Setup-<版本>-<架构>.exe
# 它必须与 server/src/services/settings.ts 的 clientArtifactName() 以及设置项
# clientDownloadUrl 指向的文件一致。对不上时的现象是：下载页主按钮 404、
# 没有任何产物拿到「主产物」排序与已登记的 sha256。改版本号时三处一起改。
# （服务端有兜底：设置里的文件不存在时，会退回下载目录里真实的 Windows 产物。）

# 3) 登记校验值：下载页显示的 sha256 默认由主控**自己算**（懒计算 + 缓存，
#    见 server/src/api/public.ts 的 listDownloads/artifactSha256），不需要人工登记。
#    设置项 clientSha256 仍然可以登记（自建下载源、站外核对过的值），但一旦它与
#    实际文件对不上，主控会**以实际文件为准**并记一条 warn —— 所以忘了改这一项
#    的后果从"页面显示旧哈希、玩家以为文件被篡改"降级成一条日志提醒。
node -e "const {createHash}=require('crypto'),fs=require('fs');\
console.log(createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" \
  server/data/downloads/McLink-Setup-0.1.0-x64.exe
# 想人工登记就 PATCH /api/v1/admin/settings 的 clientSha256（控制台「平台设置」里也能改；
# clientDownloadUrl 同理，文件名变了要一起改）
```

发布后建议按下载页给的链接**真下一次**并核对哈希——这条链路上
「静态服务是否真的吐出了那个文件」是唯一无法靠读代码确认的一环：

```bash
curl -sO http://<主控>/downloads/McLink-Setup-0.1.0-x64.exe && sha256sum McLink-Setup-0.1.0-x64.exe
```

## 4. 端到端实验（`pnpm lab`）

`scripts/lab.mjs` 不是 mock：它会真的拉起 **1 个子节点中继 + 4~5 个客户端**
`easytier-core` 进程，然后用 `easytier-cli` 的 JSON 输出核对下面这些结论：

1. 子节点中继只监听一个端口（默认 11010），却同时服务两个不同房间
   （主控不再自带中继实例，观测点因此在这台子节点上）；
2. 房间之间完全隔离 —— A 房成员看不到 B 房任何 peer；
3. 网络密钥错误者进不了房间；
4. 子节点可以注册上线并参与房间中继调度；
5. 中继能按房间（外来网络）统计流量。

前置条件：

```bash
# 1) 主控已在 8787 运行
pnpm dev:server
# 2) vendor/easytier 下已有 easytier-core 与 easytier-cli
pnpm fetch:easytier
```

运行：

```bash
node scripts/lab.mjs
# 或指定主控与管理员密码
MCLINK_MASTER=http://127.0.0.1:8787 MCLINK_ADMIN_PASSWORD=xxx node scripts/lab.mjs
```

实验会在 `.cache/lab/` 下创建临时目录，并使用随机端口段（12000 起）避免与上次实验冲突。

实验最后一步会拿**真实二进制**给所有生成的配置判卷（`easytier-core --check-config`）。
这一步不是装饰：曾经把 u64 限速字段写成带引号的字符串，TypeScript 侧测试全绿，
但 easytier-core 一加载配置就 panic。让真实二进制判卷，是唯一可靠的守门方式。

### 4.1 数据面与限速实验（`pnpm lab:dataplane`）

`pnpm lab` 刻意用 `no_tun` 跑，因为「同机多个虚拟网卡 + 同一网段」会让操作系统的
路由表产生歧义，OS 层 ping 测试不可信。想验证**数据面**（真的把字节从 A 送到 B）
以及**限速是否真的生效**，用这个脚本：

```bash
pnpm lab:dataplane
```

它做的事：

1. 建两个房间（一个不限速作基准、一个 `perMemberKbps=1000`）；
2. 用 **TUN** 模式启动房主与成员两个实例（每个实例给不同的 `dev_name`，
   否则同机两个实例会抢同名虚拟网卡）；
3. 在房主机器上起一个 TCP 服务当作「Minecraft 服务端」；
4. 用 `easytier-cli port-forward add tcp <bind> <dst>` 在成员侧把本地端口转发到
   房主的虚拟 IP —— **转发在 EasyTier 内部完成，不依赖系统路由表**，
   所以同机多实例也能得到可信的吞吐数字；
5. 两个场景各传输 2 MiB，对比实际吞吐。

本机实测：不限速 **1,525,201 kbps**（2 MiB / 11 ms），限速 1000 kbps 后 **896 kbps**
（2 MiB / 18.7 s）—— 限速确实把带宽压到了设定值附近。

## 5. 代码结构导览

```
packages/shared/src/       服务端 / 网页 / 客户端共用契约
  types.ts                 领域模型：User/Room/RoomMember/RoomTicket/RelayNode/RoomPolicy…
  protocol.ts              线协议：Routes(路由常量)、ErrorCodes、WS 的 Topics/ClientEvent/ServerEvent
  virtualnet.ts            虚拟地址规划：10.200.<slot>.0/24、slot/seat 分配
  regions.ts               区域定义（cn-east/hk/oversea…）
  validation.ts            校验规则：用户名/房间码/密码强度/host:port
  format.ts                展示层格式化

server/src/
  index.ts                 入口：装配 → 建管理员 → 起 HTTP/WS → 拉起中继 → 后台定时任务
  app.ts                   应用容器（可注入配置，便于测试）+ 静态目录解析 + 首次建管理员
  config.ts                全部环境变量与默认值（**改配置先看这里**）
  server.ts                路由分发、CORS、安全头、按 IP 限流、静态托管
  logger.ts                轻量结构化日志
  http/kit.ts              极简路由/上下文/响应/静态文件（含 Range）
  api/                     public / auth / rooms / agent / admin 五组路由
  services/                auth(账号与会话) / rooms(房间与票据与调度) / nodes(子节点) / settings
  db/                      index(SQLite 封装) / schema(迁移) / users / rooms / nodes / traffic
  easytier/                config(TOML 生成) / process(子进程托管) / manager(中继与采样) /
                           cli(CLI 封装) / acl(房间 ACL 构造)
  ws/hub.ts                WebSocket 话题订阅与推送
  util/                    errors / id(哈希与随机) / net(真实 IP)

web/src/                   官网页 + 管理员控制台（Vite + Vue3，产物输出到 server/public）
client/                    Windows 客户端（Electron 主进程 + Vue 渲染层）
  electron/main.cjs        唯一有权启动 easytier-core / 读写配置 / 申请提权的地方
  src/lib/store.ts         客户端状态机：登录、建房/进房、心跳、按需应用 ACL
deploy/                    部署脚本、systemd 单元、子节点 agent
docs/                      文档
scripts/                   fetch-easytier / lab / capture
```

分层约定：

* **路由层只做参数解析与鉴权断言**，业务逻辑必须在 `services/` 里；跨表操作用 `db/` 的仓储方法。
* **共享类型只加在 `packages/shared`**，不要在前端/客户端各自重复定义。
* `services/` 不直接碰 `req`/`res`；错误统一抛 `HttpError`（`util/errors.ts`），
  由 `http/kit.ts` 的 `errorResponse()` 转成 `{error:{code,message,fields?}}`。

## 6. 如何新增一个 API

以「导出房间成员的连接信息」为例，完整步骤如下（顺序很重要）：

1. **加路由常量**（`packages/shared/src/protocol.ts`）：

   ```ts
   export const Routes = {
     // ...
     roomExport: (id: string) => `/rooms/${id}/export`,
   } as const;
   ```

2. **加数据库查询（如果需要）**：`server/src/db/*.ts` 里加方法，SQL 用参数占位符，不要拼字符串。

3. **加服务方法**：`server/src/services/rooms.ts`，用 `HttpError.xxx()` 表达错误：

   ```ts
   export(roomId: string, userId: string): { ok: true; data: string } {
     const row = this.getRow(roomId);
     this.assertHost(row, userId);              // 非房主 → 403 forbidden
     return { ok: true, data: '...' };
   }
   ```

4. **注册路由**（`server/src/api/rooms.ts`）：

   ```ts
   router.get(Routes.roomExport(ctx.params.id ?? ''), (ctx) => {
     const auth = requireAuth(ctx);
     return app.roomService.export(ctx.params.id ?? '', auth.userId);
   }, { auth: true });        // auth: true 需要登录；再加 admin: true 需要管理员
   ```

   注意：

   * 动态段写成 `:id`，路由匹配是「段数必须完全相等」，所以
     `/rooms/public` 这类静态路径**必须注册在 `/rooms/:id` 之前**（`Router.match()`
     按注册顺序返回第一个匹配）。
   * `auth` / `admin` 由 `server.ts` 在进入 handler 前统一校验；
     房主这类「资源级权限」只能在服务层用 `assertHost()` 判。

5. **补文档**：`docs/api.md` 的路由总表 + 对应小节；如果有新错误码，同步 `ErrorCodes`。

6. **补测试**（可选）：`server/test/rooms-export.test.ts`，用 `createApp({ withRelay: false })`
   构造一个使用临时数据库的 App，直接调服务方法（不需要起 HTTP）。

## 7. 如何修改房间策略（`RoomPolicy`）

房间策略同时影响 **数据库、ACL、票据 TOML、前端表单**，改动要四处齐动：

1. **类型与默认值**：`packages/shared/src/types.ts` 的 `RoomPolicy` + `DEFAULT_ROOM_POLICY`。
2. **请求解析与范围裁剪**：`server/src/api/helpers.ts` 的 `parsePolicy()`。
   新字段必须在这里显式解析并**裁剪范围**，否则客户端可以塞任意值影响 ACL 生成。
3. **落地实现**（三选一，或都做）：
   * 影响房主实例 ACL → `server/src/easytier/acl.ts` 的 `buildRoomAcl()`；
     注意 ACL 的 `rate_limit` 单位是**包/秒**，不是带宽。
   * 影响客户端实例配置 → `server/src/services/rooms.ts` 的 `ticket()` 里写进 `flags`
     （例如 `perMemberKbps` → `instanceRecvBpsLimit`）。
   * 影响平台级中继 → `server/src/easytier/manager.ts` 的 `renderConfig()`
     （例如平台级出口限速写 `foreignRelayBpsLimit`）。
4. **变更触发重算**：`server/src/api/rooms.ts` 的 `PATCH /rooms/:id` 里那串
   `['maxPlayers','maxBandwidthKbps', ...]` 数组要加上新字段名；
   加进去后 `updatePolicy()` 会 `bumpAcl()` 递增 `acl_revision`，
   房主客户端下次心跳就会重新应用 ACL。
5. **前端表单**：玩家侧房间设置表单在 `client/src/pages/RoomPage.vue`（含 `rateLimitPps` 等字段，
   界面上要注明单位是包/秒）；管理台的只读展示在 `web/src/console/pages/RoomsPage.vue`。

单位与陷阱（务必记住）：

* `rateLimitPps` 是**包/秒**。界面上不要写成带宽。
* 带宽限速只有两个字段可用：中继的 `foreign_relay_bps_limit`（平台级，硬限制）和
  实例的 `instance_recv_bps_limit`（客户端自制，可被绕过）。
* **它们的单位是「字节/秒」，不是比特/秒**（EasyTier 的 `_bps_` 命名有歧义，
  依据是 `three_node.rs` 的 `instance_recv_bps_limit_test`）。平台对外用 kbps，
  存储与界面都用 kbps，**下发前必须经 `kbpsToBytesPerSecond()` 换算**（÷8）。
  按比特/秒写会让玩家实际拿到 8 倍带宽——`pnpm lab:dataplane` 会守住这条。
* **两个 `*_bps_limit` 在 TOML 里必须写裸数字，不能加引号**，否则
  easytier-core 解析配置时直接 panic（`expected u64`）。`server/test/unit.test.ts`
  有对应回归断言；两个实验脚本会在启动实例前跑 `--check-config` 判卷。
* 改动票据生成后，请跑 `pnpm lab:dataplane` 确认限速仍按预期生效（它做真实 TCP 测速）。
* `rpc_portal` 不是 TOML 字段，只能走命令行 `-r`；不要试图写进 `renderEasytierToml()`。
* 客户端实例的 `bind_device` 必须保持 `false`（见 `ticket()` 里的注释）。

改完后建议：

```bash
pnpm typecheck
pnpm lab            # 用真实 easytier-core 验证隔离与限速仍然成立
```

## 8. 调试技巧

```bash
# 打开 debug 日志（默认在非生产环境就是 debug）
MCLINK_LOG_LEVEL=debug pnpm dev:server

# 用临时数据目录，避免污染开发库
MCLINK_DATA_DIR=.tmp/dev-data pnpm dev:server

# 直接问主控要一份票据（把 <token>/<roomId> 换成真实值）
curl -s -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:8787/api/v1/rooms/<roomId>/ticket?listenPort=11010"

# 看子节点下发出来的配置（agent 落在节点机器上的那份）
cat /etc/mclink/relay.toml            # 主控机器上没有它 —— 主控不再自带中继

# 手动问中继要 peer 列表（RPC 只监听本机；端口 = 16000 + 监听端口 % 1000）
vendor/easytier/easytier-cli -p 127.0.0.1:16010 -o json peer list
vendor/easytier/easytier-cli -p 127.0.0.1:16010 -o json peer list-foreign

# 受限沙箱里子进程不能用管道 stdio（会 EPERM），用 capture 脚本落文件
node scripts/capture.mjs .cache/out.log vendor/easytier/easytier-cli -p 127.0.0.1:16010 peer list
```

在 Windows 上调试时常见的坑：

* `easytier-core` 在受限令牌下可能 panic（`SCM start an error`，见 `troubleshooting.md`）——
  用普通用户令牌运行，不要用服务/受限令牌。
* `easytier-cli` 在中文 Windows 下可能输出 GBK；`server/src/easytier/cli.ts` 的 `decodeSmart()`
  已经做了 UTF-8 → GBK 回退。
* 端口 11010 可能被上一次没退干净的 easytier-core 占着：
  `Get-NetTCPConnection -LocalPort 11010` 找到 PID 后结束它。

## 9. 提交前的检查清单

- [ ] `pnpm typecheck` 通过
- [ ] **动过任何 `package.json` 就跑了 `pnpm install`**，并确认 `pnpm verify:lockfile` 退出码为 0
- [ ] 涉及协议/接口的改动，`docs/api.md` 已同步
- [ ] 涉及环境变量的改动，`docs/deployment.md` 的变量表已同步
- [ ] 涉及安全边界的改动（隔离、限速、鉴权），`docs/security.md` 已同步
- [ ] 改了 `ticket()` / `renderEasytierToml()` / ACL → 跑过 `pnpm lab`
- [ ] 没有把真实密钥、令牌、真实域名写进代码或文档（示例统一用 `请替换`/`changeme`）

### 为什么"动过 package.json"要单独列一条

这条是踩出来的：`client/package.json` 里从来没有 `vue-router`（客户端不用路由，只有 web 用），
但 `pnpm-lock.yaml` 的 `client` 段里留着它 —— 生成 lockfile 时留下的脏数据。
本机一直没跑过 `--frozen-lockfile`，所以从开发到提交、推送、`pnpm lab` 全都没暴露；
直到在 Debian 上执行部署脚本，`pnpm install --frozen-lockfile` 才直接失败：

```
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with <ROOT>/client/package.json
```

自检（很快，约 0.3 秒，只校验 lockfile 不装依赖）：

```bash
pnpm verify:lockfile     # 退出码 0 = lockfile 与所有 package.json 一致
```

它等价于 `pnpm install --frozen-lockfile --lockfile-only`。故意把 `package.json` 改坏
验证过：会以退出码 1 报 `ERR_PNPM_OUTDATED_LOCKFILE`，所以是真守卫而不是摆设。

## 10. 远端、网络与部署（运维笔记）

### 10.1 远端：GitHub 是主远端

| 远端名 | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `https://github.com/luo-die/mclink`（私有） | **主远端**：`git push` / `git pull` 都走它 |
| `gitlab` | `git@gitlab.com:mc7984239/mc.git` | 历史备份，**不再推**（GitLab CI 额度已用完） |

推 `v*` 标签**不会**触发构建：`.github/workflows/build-clients.yml` 只留了
`workflow_dispatch`（要出 mac 包就去 Actions →「构建客户端」→ Run workflow）。
私有仓库额度与产物大小限制见 `docs/build-clients.md`。

### 10.2 国内网络：GitHub 要挂代理（本机用 7890）

不挂代理时的症状长这样（都是"连不上"，不是权限问题）：

```
fatal: unable to access 'https://github.com/luo-die/mclink.git/': Recv failure: Connection was reset
fatal: unable to access 'https://github.com/luo-die/mclink.git/':
       Failed to connect to github.com port 443 after 21055 ms
```

本仓库已经配好**只对 github.com 生效**的代理（写在 `.git/config`，不污染其它仓库）：

```bash
git config --local http.https://github.com.proxy http://127.0.0.1:7890
git config --local --get-regexp proxy                            # 查看
git config --local --unset http.https://github.com.proxy         # 关掉
```

- 想让所有仓库都走代理：把 `--local` 换成 `--global`。
- 先确认代理本身是通的：

  ```bash
  curl -x http://127.0.0.1:7890 -sI https://github.com | head -1
  # 期望：HTTP/1.1 200 Connection established
  ```

- 走 **SSH**（`git@github.com:` 那种地址）时代理要写进 `~/.ssh/config`：

  ```
  Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/github_mclink
    IdentitiesOnly yes
    ProxyCommand connect -H 127.0.0.1:7890 %h %p    # connect.exe 随 Git for Windows 一起装
  ```

> 主控服务器上如果也连不上 GitHub，同样处理；那台机器是用**只读 deploy key**
> （`~/.ssh/github_mclink`）拉的，key 加在仓库的 Settings → Deploy keys。

### 10.3 主控部署：源码目录 ≠ 运行目录

- 源码克隆在 `/opt/src/mclink`（**有 `.git`**）；运行目录 `/opt/mclink/app` 是
  `deploy/install-server.sh` 用 tar 同步出来的产物、**故意不含 `.git`** ——
  在 `/opt/mclink/app` 里执行 `git pull` 会报 `fatal: not a git repository`。
- 升级流程：

```bash
cd /opt/src/mclink
git pull
sudo bash "$PWD/deploy/install-server.sh" --skip-install --skip-web   # 无新依赖/前端改动时
```

`install-server.sh` 负责同步源码到 `/opt/mclink/app`、跑迁移、重启 `mclink-server`。

### 10.4 那几个"打真接口"的检查脚本

单测只覆盖纯函数，**接线错了它们抓不到** —— 这一条是踩了两次换来的：
「心跳不下发配置」（脚本测的是 agent 从来不走的 `/agent/config` 拉取接口）、
「手选节点落错槽」（纯函数是对的，调用处顺序错了）。所以动过相关代码后，
对着一个**跑起来的开发主控**跑一遍：

```bash
pnpm dev:server                                # 另开一个终端保持运行（默认 8787）

node scripts/check-node-config-revision.mjs    # 配置版本 +1 / 心跳下发配置（11 项）
node scripts/check-relay-slots.mjs             # 房主票据=整个集合、成员只拿1台且按延迟优先（13 项；
                                               #   自造节点 + 临时账号，跑完清理/封禁）
node scripts/check-node-cmd-origin.mjs         # 签发节点命令里的主控地址（4 项；自造请求头）
node scripts/check-trusted-proxies.mjs         # 控制台里的可信代理真的生效（7 项；看审计行 ip）
node scripts/repro-easytier-avoid-relay.mjs    # 复现 EasyTier 的 avoid-relay 失效（四实例本地拓扑，见 §10.5）
node client/scripts/verify-platform.mjs        # 平台分支 + CI/文档静态断言（85 项）
node client/scripts/verify-relay-roles.mjs     # 中继角色判定（18 项；纯函数，不用主控）
node scripts/fetch-client-artifacts.mjs --help # 一键收产物：改名 + 算 sha256 + 打印要填的三个设置
```

七个脚本的默认管理员密码都是 `dev-only-passw0rd`，可用 `MCLINK_ADMIN_PASSWORD` /
`MCLINK_MASTER`（或 `MCLINK_PORT`）覆盖；它们会在开发库里留下一次性注册密钥（未使用），
`check-relay-slots.mjs` 还会多留一个**已封禁**的临时账号（接口没有删用户的路径）。

`check-relay-slots.mjs` 的 ④ 组是**成员侧**的活体断言（2026-10-02 加）：注册一个临时账号，
带"故意偏心"的延迟提示进房，验"只拿 1 台 + 拿的是最近那台 + 分配已固定 + 写回了
`relay_node_id`"。"过卸荷线就排除"那条 live 里构造不出来（要等 EWMA 收敛 3 分钟），
由单测 `pickMemberRelay` 钉住。若主控开了「必须验证邮箱」，这一组会如实报 SKIP 而不是 FAIL。

---

## 10.5 复现 EasyTier 的 avoid-relay 失效（打补丁前的现场）

**症状**（线上实测）：两台中继各与房间两端 **p2p 直连**、路径同为 2 跳，其中一台标了
「只协助打洞」（配置写 `disable_relay_data = true`，EasyTier 广播 `avoid_relay_data`），
但两端到对方的 `route` **仍然选那台被标记的** —— 数据被它的 data plane 丢掉、房间不通。
`latency_first = true`（LeastCost）也救不回来。

```bash
node scripts/repro-easytier-avoid-relay.mjs                # 用 vendor/easytier 的二进制
ET_DIR=/path/to/easytier node scripts/repro-easytier-avoid-relay.mjs
node scripts/repro-easytier-avoid-relay.mjs --case=marked-latency-first
```

它在一台机器上摆出四实例拓扑（两台"服务器" + 两个客户端，客户端用 `disable_p2p = true`
强制走中继），跑四档对照。**二分结果**（2026-09-29，EasyTier 2.6.4 / 8428a89d）：

| 拓扑 | 被标记的那台 | client1 → client2 的 next_hop |
| --- | --- | --- |
| 两台"服务器"作为**外来网络的 public server**（＝线上形态） | ✗ 仍被选中 | `PublicServer_relayA` ← **复现** |
| 两台作为**房间网络里的普通成员** | ✓ 被绕开 | `relayB` ✓ |

**结论**：标志在同网 peer 之间传播正常（惩罚生效），缺口在
「**public server 代转外来网络**」这条链 —— 客户端为这台中继建立的路由信息里没有带上
`avoid_relay_data`，于是 `get_avoid_relay_data()`（`peer_ospf_route.rs:789-797`）返回 false，
`AVOID_RELAY_COST` 那一步（`:1405-1418`）根本没执行。

**补丁方向**（待定位到具体同步点后落地）：让外来网络实例的 `avoid_relay_data`
随它对外发布的路由信息一起同步；或在 `get_avoid_relay_data()` 里增加一条回退 ——
从该 peer **握手时**交换的 `PeerFeatureFlag` 读取（同网 peer 走的正是这条路，已被证明有效）。
补丁用 `deploy/easytier-patches/*.patch` 管理，由 CI 构建三平台二进制后随节点/客户端分发 ——
在那之前，**别把「只协助打洞」当成可靠的"不承载"保证**（见 `troubleshooting.md` §6.6）。
