# 构建客户端（Windows / macOS）

## 一句话结论

**macOS 包必须在 macOS 上构建** —— electron-builder 直接拒绝跨平台：

```
$ node scripts/dist.mjs --mac zip          # 在 Windows 上执行
⨯ Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build
```

所以「我没有 Mac」时的正确路线是 **用 CI 的 macOS runner 出包**
（GitLab CI 的 `build:macos` 是主路线；GitLab 额度用完后走 GitHub Actions 的
`build-clients.yml` —— 两条都在下面第一节），而不是想办法在 Windows 上凑。

| 平台 | 产物 | 出包途径 |
| --- | --- | --- |
| Windows | `McLink-Setup-<版本>-x64.exe`（NSIS） | 本地 `pnpm dist:client` 或 GitLab `build:windows` |
| macOS | `McLink-<版本>-macos-arm64.dmg` / `.zip`（Apple 芯片）<br>`McLink-<版本>-macos-x64.dmg` / `.zip`（Intel） | 必须在 macOS 机器上：GitLab `build:macos`、GitHub Actions `build-clients.yml`，或一台真 Mac |
| macOS（应急、未签名） | `McLink-<版本>-macos-<架构>.zip`（**没有 dmg**） | 在 Linux 服务器上跑 `deploy/build-macos-on-linux.sh` —— 限制见下面路线 C |

> 文件名里那个 `macos` 不是装饰：官网/下载页按**文件名**判断平台与架构
> （`server/src/api/public.ts` 的 `platformOf` / `archOf`），
> 叫 `McLink-<版本>-arm64.dmg` 会被挂到 Windows 按钮上。

---

## 一、用 CI 出包（不需要自己有 Mac）

三条路，按优先级排 —— A/B 出的包**完全等价**（dmg + zip，两个架构，都补了 ad-hoc 签名），
C 只是应急：

| 路线 | 什么时候用它 | 配置 | 跑在哪 |
| --- | --- | --- | --- |
| **A. GitLab CI**（主路线） | 共享额度还有 | `.gitlab-ci.yml` 的 `build:macos` | GitLab SaaS 的 macOS runner |
| **B. GitHub Actions** | GitLab 额度用完了（本仓库当前就是这个状态） | `.github/workflows/build-clients.yml` | GitHub 托管的 `macos-15`（arm64） |
| C. Linux 服务器硬出（应急） | 两边 CI 都用不了，且只要发 Intel Mac | `deploy/build-macos-on-linux.sh` | 主控那台 Linux —— **没 dmg、没签名**，见路线 C |

### 路线 A：GitLab CI（主路线）

`.gitlab-ci.yml` 里的 **`build:macos`** 就是干这个的：跑在 macOS runner 上，产出 dmg + zip。

#### 怎么触发

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| 出正式包 | 推一个 `v*` 标签 | `build:windows` 与 `build:macos` **都自动跑**，mac 失败就是失败（发布路径不允许静默跳过） |
| 只想试一次 | GitLab → CI/CD → **Pipelines → Run pipeline** | `build:windows` 自动跑；`build:macos` 是**手动** job，需要出 mac 包时单独点它（跳过它不会让 pipeline 卡在 blocked） |

跑完在 pipeline 页面的 **Artifacts** 里下载：`mclink-macos-<短 SHA>`，里面是
`client/release/*.dmg` 与 `client/release/*.zip`（两个架构 × 两种格式，共 4 个文件）。

#### runner

`build:macos` 的 `tags` 写死为 **`saas-macos-medium-m1`**（GitLab.com SaaS 的 Apple 芯片
macOS runner，用户已确认本项目上可用）。换机器时**直接改这个字面量**：
可替换的值有 `saas-macos-medium-m1`（M1）、`saas-macos-large-m2pro`（M2 Pro，更贵）。
不写成 CI 变量是有意的 —— runner tag 写错的表现是 job 永远停在 pending（最难排查的一种失败），
而 GitLab 对 `tags` 的变量展开依赖实例版本与变量作用域，不值得为可读性冒这个险。

#### job 里做了什么（顺序即原因）

```bash
node scripts/fetch-easytier.mjs --macos   # 取两个架构的 EasyTier 核心（arm64 的资产名叫 aarch64）
pnpm icons                                # 生成含 1024 的图标 + macOS 菜单栏模板图
pnpm --filter @mclink/client exec node scripts/dist.mjs --mac zip --arm64 --x64
                                          # 两个架构各出一个 zip（dmg 留到签名之后）
node deploy/assert-artifacts.mjs --macos  # 没有产物就让 job 失败（别让它"成功"着没东西）
bash deploy/sign-macos-app.sh             # ad-hoc 签名 + 重新打 zip（保留符号链接）+ 生成 dmg
```

**为什么 CI 里只让 electron-builder 出 `zip`、dmg 交给脚本**：没有证书时 electron-builder
打出的是**未签名**的 `.app`，而它做 dmg 是在签名**之前** —— dmg 里装的就是未签名副本。
Apple 芯片要求 arm64 可执行文件至少有 ad-hoc 签名，否则内核直接拒绝执行
（玩家看到"已损坏，无法打开"）。所以顺序必须是：先出 zip → 补 ad-hoc 签名 → 再用签名后的
`.app` 生成 dmg。`electron-builder.yml` 里 `mac.target` 仍然写着 dmg + zip
（本地手动跑 `--mac dmg zip` 时的默认目标），CI 只是覆盖成了上面这条更安全的路径。

#### ⚠️ CI 能不能跑起来，只能在推送之后验证

本地没有 GitLab runner，也没有 GitLab 的 `rules` 求值器。本地**能**验的只有：

```bash
node client/scripts/verify-platform.mjs    # YAML 语法 + job/tags/artifacts/分支的静态断言
```

**不能**验的：runner 是否真的空闲、tags 是否真的匹配、macOS 上 `codesign` / `hdiutil` 是否
按预期工作、两次 Electron 下载会不会超时。这些都要推上去跑一次才算数 —— 第一次跑
`build:macos` 时请盯一眼日志里的 `du -sh` 与 `codesign -dv` 输出（job 里已经把这两条打成证据）。

### 路线 B：GitHub Actions（GitLab 额度用完时走这条）

GitLab SaaS 的 macOS runner 吃**每月共享额度**，额度用完之后 `build:macos` 就起不来了
（pipeline 报配额相关的错误，而不是构建失败）。

镜像仓库：**<https://github.com/luo-die/mclink>**（**私有** —— 公开仓库的 runner 免费不限量，
但那等于把 mclink 的源码整个公开，所以选私有）。工作流 `.github/workflows/build-clients.yml`
的步骤与 GitLab 的 `build:macos` 一一对应
（`--mac zip --arm64 --x64` → `assert-artifacts.mjs --macos` → `sign-macos-app.sh` → 上传产物）。

```bash
# 一次性：加远端并推上去（只推分支，别推 tag —— 见下表）
git remote add github https://github.com/luo-die/mclink.git
git push github main
```

然后 GitHub → **Actions** →「构建客户端（Windows / macOS）」→ **Run workflow**（分支选 `main`）；
跑完在这次的 **Artifacts → `mclink-macos`** 里下载，默认是**两个 dmg**（arm64 + x64）。

| 事项 | 说明 |
| --- | --- |
| 从哪个提交构建 | **从 `main` 跑**：1.0.9 的 mac 包要带上「mac 的更新提示不该指向 Windows 安装包」这处修复，它是打 tag 之后才提交的。版本号取自 `client/package.json`（仍是 1.0.9），文件名不变，主控照旧认。 |
| runner | pin 在 **`macos-15`**（arm64，仍在 GA）。**别改回 `macos-14`**：GitHub 已把它标记为 deprecated；也别用 `macos-latest`（会被自动迁移到新系统）或 `-intel` / `-large`（x64 / 收费的更大规格）。 |
| Windows job | 手动跑时**默认跳过**（要出就勾上 input `windows`）—— mac 包不需要它，而私有仓库的额度按分钟扣（Windows 还按 2 倍折算）。 |
| **别推 tag** | 推 `v*` 标签也会触发这个工作流，等于再花一次额度（一次 mac 构建 ≈ 月度额度的 1/10）。镜像仓库里只要 `main`。 |
| 额度 | GitHub Free 的私有仓库是 **2,000 分钟/月**，macOS 按 **10 倍**折算：一次 mac 构建（十几分钟）≈ 100~200 分钟额度，一个月够十几次。 |
| 存储 | 私有仓库的 Actions 存储只有 **500 MB**，而两个架构 × dmg + zip 差不多正好 500MB —— 所以工作流**默认只上传两个 dmg**（≈260MB，保留 7 天）。要 zip 就勾 input `full_artifacts`（只留 1 天，且可能顶到上限）。 |
| 日志里的校验值 | 最后一步用 `shasum -a 256` 打印 dmg/zip 的校验值 —— 传完可以拿它核对有没有传错文件。 |
| 认证 | 开发机不用装 `gh`、也不用重新授权：Windows 凭据管理器里存着 `luo-die` 的 token（scope `repo` + `workflow`，后者是推 workflow 文件必需的），`git push` 会直接用它。 |

### 路线 C：在 Linux 服务器上硬出（应急：没 dmg、没签名）

`deploy/build-macos-on-linux.sh` 能在 Linux 上打出 mac 的 **zip**（electron-builder 那条
mac 守卫只拦 Windows，见脚本头部注释）。但两条硬限制决定了它只能应急：

- **没有 dmg**：dmg 要 `hdiutil`（macOS 专属命令），Linux 上没有替代实现；
- **没有签名**：`codesign` 同样只有 macOS 有 → 出来的是未签名包。Intel Mac 右键「打开」
  还能跑；**Apple 芯片会被内核拒绝执行**（玩家看到的是「已损坏，无法打开」），
  得让玩家自己执行 `sudo codesign --force --deep --sign - /Applications/McLink.app` 才能开。

这条路**本仓库没有在真机上验过**（手上没有 Linux 机器），第一次跑请盯日志。
能用 CI 就用 CI（路线 A / B）。

---

## 二、如果你确实有一台 Mac

```bash
pnpm install
node scripts/fetch-easytier.mjs --macos  # 会下 vendor/easytier/macos-{arm64,x64}/
pnpm icons                               # 生成含 1024 的图标（.icns 需要 ≥512）+ tray-mac.png
cd client
VITE_MCLINK_MASTER=https://cnnic.link node scripts/dist.mjs --mac zip --arm64 --x64
cd ..
# 补 ad-hoc 签名并生成 dmg（无证书时 electron-builder 不会签名，产物在 Apple 芯片上起不来）
bash deploy/sign-macos-app.sh
# 产物在 client/release/
```

只出当前架构的话，`--arm64 --x64` 去掉即可（脚本默认按本机架构）。

**为什么不做 universal 包**：universal 要把 x64 与 arm64 两个 .app 合并
（`@electron/universal` 会去 lipo 每一个 Mach-O），而我们的包里还有一批**非 Mach-O 的
资源文件**（`Resources/vendor/easytier/macos-*` 两个架构的核心，运行时按 `process.arch` 选）。
合并后的包体积是单架构的两倍（~260MB），换来的只是"一个包通吃"。
分架构出两个包更稳：CI 已经验证过这条路径，下载页也是按文件名里的架构分流的。

---

## 三、把 macOS 产物发布到主控

主控**没有**上传接口，发布就是两步（和 Windows 一样）：

```bash
# 1) 把产物拷进下载目录（Debian 上默认路径）
sudo cp McLink-1.0.9-macos-arm64.dmg /opt/mclink/data/downloads/
sudo cp McLink-1.0.9-macos-arm64.zip /opt/mclink/data/downloads/
sudo chown mclink:mclink /opt/mclink/data/downloads/McLink-1.0.9-macos-*
```

```bash
# 2) 控制台 →「平台设置」把 clientVersion 改成新版本号即可
#    （clientDownloadUrl 仍指向 Windows 主产物；macOS 的包会被官网自动发现）
```

官网/下载页会**按文件名自动识别平台与架构**（`.dmg`→macOS，`arm64`/`x64`→芯片），
所以文件一进目录，下载页的 macOS 卡片就会自动出现 —— 不需要额外配置。
Windows 那边的 `clientDownloadUrl` / `clientSha256` 仍是管理员维护的"主产物"。

CI 跑完后也可以在主控上一条命令取产物（`deploy/fetch-release-from-gitlab.sh` 会同时取
`build:windows` 与 `build:macos` 两个 job 的 artifacts）。

走**路线 B（GitHub Actions）**时没有这个脚本：产物是 run 页面上下载的
`mclink-macos.zip`，解开就是那两个 dmg（勾了 `full_artifacts` 才另有 zip），
`scp` 进 `data/downloads/` 后按上一步改权限即可。

---

## 四、macOS 玩家的首次启动（未签名包）

我们没有 Apple 开发者证书，产物是**未签名**的（electron-builder 在 macOS 上会跳过签名，
由 `deploy/sign-macos-app.sh` 补 ad-hoc 签名 —— 这一步不能省，Apple 芯片要求二进制至少有
ad-hoc 签名，否则内核直接拒绝执行）。玩家第一次打开会遇到 Gatekeeper 拦截，两种绕过方式：

1. 在 Finder 里**右键**点图标 → 选「打开」→ 再点一次「打开」；
2. 或执行一行命令去掉隔离标记：

   ```bash
   xattr -dr com.apple.quarantine /Applications/McLink.app
   ```

> **"右键 → 打开"给的是 Gatekeeper 的通行证，不是管理员权限** —— 这两件事在 mac 上完全分开。
> 联机要的 root 权限由客户端自己弹系统授权框（osascript）申请，与上面的绕过无关。
> 这一条很容易被搞混，所以客户端在 macOS 上的提权文案不再出现"以管理员身份运行"那种 Windows 说法。
>
> 想彻底免掉 Gatekeeper 这一步就得买 Apple 开发者账号（$99/年）做签名 + 公证：
> 在 CI 里加 `CSC_LINK` / `CSC_KEY_PASSWORD` 与 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`
> 两个 secret，并把 `CSC_IDENTITY_AUTO_DISCOVERY` 从 `false` 改回 `true`。
> 这一步做完，玩家双击即可打开，和 Windows 一样。

---

## 五、macOS 上的行为差异（与 Windows 版对照）

界面（「暖纸台」）**逐像素一致**，只有"窗口控制"和"平台专属能力"这两类按 mac 的习惯走。

| 事项 | Windows | macOS |
| --- | --- | --- |
| 标题栏 | 无边框 + 自绘三个按钮 | `titleBarStyle: 'hiddenInset'` + **系统红黄绿**；自绘标题栏仍留着（拖动区 + 连接状态文字），图标栏顶部让出 26px 给按钮 |
| 关闭窗口 | 点自绘 ✕ → 按「关闭窗口时」偏好（询问 / 收进托盘 / 退出） | 点红点或 **⌘W** → 同一套偏好（文案是「隐藏窗口」）；**⌘Q** 是真退出，不会再问一次 |
| 菜单栏 | 无（自绘外壳） | App / 编辑 / 视图 / 窗口：⌘Q 退出、⌘W 关闭窗口、**⌘,** 设置页、⌘R 重新加载界面、⌘M 最小化、⌘H 隐藏 |
| 重新加载（⌘R） | — | 正在联机时先问一次：直接 reload 会让界面忘记当前房间，而核心还在跑（半吊子状态） |
| 托盘 | 任务栏右下角，图标 `icon.ico` | 菜单栏图标 `tray-mac.png`（模板图，系统按明暗反色；`.ico` 在 mac 上读不出来，会变成一块空白） |
| 管理员权限 | UAC，右键「以管理员身份运行」 | 系统授权框（osascript，输登录密码）；文案里不再出现"右键 → 以管理员身份运行" |
| 虚拟网卡 | wintun（`wintun.dll`） | utun（系统自带，需要 root）；报错文案跟着换成 utun |
| 孤儿进程清理 | PowerShell / WMI（`Get-CimInstance Win32_Process`） | `pkill -f easytier-core.*<数据目录>` |
| 核心资源占用 | `Get-Process`（PowerShell） | `ps -o rss=,time=`，归一成同一形状返回 |
| 数据目录 | `%APPDATA%\McLink` | `~/Library/Application Support/McLink`（同一段代码，走 `app.getPath('appData')`） |
| 中文字体 | 微软雅黑 | 苹方（PingFang SC）/ 黑体-简；字体栈里两套都在，谁有谁上 |
| **局域网广播直通** | 可用（装 WinDivert 内核驱动，有断网风险，默认关） | **不可用**：房间规则里那一项置灰并写明原因；即使房间策略是别的平台开的，本地核心也会在写配置前把 `enable_udp_broadcast_relay` 强制改成 `false` 并打一行日志（不静默失败）。用「直接连接 + 房间地址」照常联机 |
| 首次启动 | 双击安装包 | 未签名：右键 → 打开，或 `xattr -dr com.apple.quarantine`（见上一节） |

---

## 六、macOS 首次出包后的自测清单

1. 双击 dmg → 拖进「应用程序」→ 首次打开（必要时 `xattr -dr com.apple.quarantine`）。
2. 是否弹出管理员授权？授权后窗口是否正常出现（这一步对应 osascript 提权）。
3. 左上角是否是**系统红黄绿**、且不与品牌块重叠；标题栏空白处能不能拖动窗口；
   菜单栏是否有 App/编辑/视图/窗口，⌘Q / ⌘W / ⌘, / ⌘R 是否都通。
4. 菜单栏（屏幕右上角）是否出现 McLink 图标、在深色菜单栏上是否看得清。
5. 登录 → 建房间 → 「连接路径」里是否出现 `P2P 直连` 或 `经中继`（说明 utun 建成、核心在跑）。
6. 「设置 → 运行环境」里核心路径应指向 `…/Resources/vendor/easytier/macos-<arch>/easytier-core`
   （**不是** `…/vendor/easytier/easytier-core` —— 那是主控在用的 Linux 版）。
7. 房间规则里「局域网广播直通」应是置灰的，并且旁边写着为什么。
8. 退出客户端后 `pgrep -f easytier-core` 应为空（验证孤儿清理在 macOS 上生效）。
9. 局域网里另一台机器用「多人游戏 → 直接连接」填房间地址，能进得来。

> 本仓库的 macOS 分支是**在 Windows 上写完并用静态断言守住的**
> （`node client/scripts/verify-platform.mjs`，60+ 项，覆盖"mac 分支存在"与"Windows 分支没被删"两个方向），
> 但 `utun` 建立、osascript 提权、dmg 内首次启动、红黄绿的实际位置这些**只有真机能验**。
> 第一次出包后请按上面的清单走一遍。
