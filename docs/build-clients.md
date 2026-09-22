# 构建客户端（Windows / macOS）

## 一句话结论

**macOS 包必须在 macOS 上构建** —— electron-builder 直接拒绝跨平台：

```
$ node scripts/dist.mjs --mac zip          # 在 Windows 上执行
⨯ Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build
```

所以「我没有 Mac」时的正确路线是 **用托管的 macOS runner 出包**
（本仓库已配好 `.github/workflows/build-clients.yml`），而不是想办法在 Windows 上凑。

## 一、用 GitHub Actions 出包（不需要自己有 Mac）

1. 把仓库镜像到 GitHub（**公开仓库的 macOS runner 免费**）：

   ```bash
   git remote add github git@github.com:<你的账号>/<仓库>.git
   git push github main --tags
   ```

2. GitHub → Actions → 「构建客户端（Windows / macOS）」→ **Run workflow**
   （`master` 输入框填客户端要内嵌的主控地址，默认 `https://cnnic.link`）。
   也可以直接推一个 `v*` 标签触发。

3. 跑完在本次运行的 **Artifacts** 里下载：

   | 产物 | 说明 |
   | --- | --- |
   | `mclink-windows-x64` | `McLink-Setup-<版本>-x64.exe` |
   | `mclink-macos` | `McLink-<版本>-arm64.dmg` / `-x64.dmg`（还有对应 `.zip`） |

> 不用 GitHub 的话，任何能提供 macOS 主机的 CI 都行（GitLab 的 SaaS macOS runner
> 属于付费档；Codemagic 每月有免费 macOS 额度）。关键只有一条：**构建跑在 macOS 上**。

## 二、如果你确实有一台 Mac

```bash
pnpm install
node scripts/fetch-easytier.mjs --macos  # 会下 vendor/easytier/macos-{arm64,x64}/
pnpm icons                               # 生成含 1024 的图标（.icns 需要 ≥512）
cd client
VITE_MCLINK_MASTER=https://cnnic.link node scripts/dist.mjs --mac dmg zip --arm64 --x64
# 产物在 client/release/
```

只出当前架构的话，`--arm64 --x64` 去掉即可（脚本默认按本机架构）。

## 三、把 macOS 产物发布到主控

主控**没有**上传接口，发布就是两步（和 Windows 一样）：

```bash
# 1) 把产物拷进下载目录（Debian 上默认路径）
sudo cp McLink-0.1.0-arm64.dmg /opt/mclink/data/downloads/
sudo chown mclink:mclink /opt/mclink/data/downloads/McLink-0.1.0-arm64.dmg

# 2) 控制台 →「平台设置」把 clientVersion 改成新版本号即可
#    （clientDownloadUrl 仍指向 Windows 主产物；macOS 的两个包会被官网自动发现）
```

官网/下载页会**按文件名自动识别平台与架构**（`.dmg`→macOS，`arm64`/`x64`→芯片），
所以文件一进目录，下载页的 macOS 卡片就会自动出现 —— 不需要额外配置。
Windows 那边的 `clientDownloadUrl` / `clientSha256` 仍是管理员维护的"主产物"。

## 四、macOS 玩家的首次启动（未签名包）

我们没有 Apple 开发者证书，产物是**未签名**的（electron-builder 在 macOS 上会做
ad-hoc 签名 —— 这一步不能省，Apple 芯片要求二进制至少有 ad-hoc 签名，否则内核直接拒绝执行）。
玩家第一次打开会遇到 Gatekeeper 拦截，两种绕过方式：

1. 在 Finder 里**右键**点图标 → 选「打开」→ 再点一次「打开」；
2. 或执行一行命令去掉隔离标记：

   ```bash
   xattr -dr com.apple.quarantine /Applications/McLink.app
   ```

> 想彻底免掉这一步就得买 Apple 开发者账号（$99/年）做签名 + 公证：
> 在 CI 里加 `CSC_LINK` / `CSC_KEY_PASSWORD` 与 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`
> 两个 secret，并把 `CSC_IDENTITY_AUTO_DISCOVERY` 从 `false` 改回 `true`。
> 这一步做完，玩家双击即可打开，和 Windows 一样。

## 五、macOS 上的权限与实现细节

| 事项 | 说明 |
| --- | --- |
| 管理员权限 | 创建 `utun` 虚拟网卡需要 root。客户端启动时会用 `osascript … with administrator privileges` 重新拉起自己（与 Windows 的 UAC 等价），设置页也有手动按钮 |
| EasyTier 核心 | 从 `vendor/easytier/macos-arm64/`（或 `macos-x64/`）按 `process.arch` 取，**不是**根目录那份（根目录是无扩展名的 Linux 版，主控在用） |
| 孤儿进程清理 | macOS 走 `pkill -f easytier-core.*<数据目录>`（Windows 走 WMI 那条路） |
| 未验证的部分 | 本仓库只在 Windows 上开发/验证过；macOS 路径（utun 建立、osascript 提权、dmg 内首次启动）**没有在真机上跑过**，第一次出包后请在 Mac 上按下面的清单自测 |

## 六、macOS 首次出包后的自测清单

1. 双击 dmg → 拖进「应用程序」→ 首次打开（必要时 `xattr -dr com.apple.quarantine`）。
2. 是否弹出管理员授权？授权后窗口是否正常出现（这一步对应 osascript 提权）。
3. 登录 → 建房间 → 「连接路径」里是否出现 `P2P 直连` 或 `经中继`（说明 utun 建成、核心在跑）。
4. 「设置 → 运行环境」里核心路径应指向 `…/Resources/vendor/easytier/macos-<arch>/easytier-core`。
5. 退出客户端后 `pgrep -f easytier-core` 应为空（验证孤儿清理在 macOS 上生效）。
6. 局域网里另一台机器用「多人游戏 → 直接连接」填房间地址，能进得来。
