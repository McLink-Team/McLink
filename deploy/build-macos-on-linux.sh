#!/usr/bin/env bash
# 在 **Linux 服务器**上构建 macOS 客户端包（不需要 Mac）。
#
# 为什么 Linux 可以、Windows 不行 —— 这不是猜的，是 electron-builder 源码里的判断
# （app-builder-lib/out/packager.js 的 doBuild）：
#
#     if (platform === Platform.MAC && process.platform === Platform.WINDOWS.nodeName) {
#       throw new InvalidConfigurationError('Build for macOS is supported only on macOS, ...')
#     }
#
# 只拦 **Windows**。Linux 上会照常下载 darwin 版 Electron 并组装 .app。
# 两处限制要知道：
#   1. **dmg 出不来**：dmg-builder 直接调 `hdiutil`（out/hdiuil.js），Linux 上没有这个命令，
#      也没有回退实现 —— 所以本脚本只出 **zip**（解压即用，官网也认 zip）。
#   2. **不会签名**：macCodeSign.js 里 `isSignAllowed()` 在非 darwin 上返回 false，
#      只会打印 "skipped macOS application code signing"。
#      · Intel Mac：去掉隔离标记后可以直接跑（见脚本末尾的说明）。
#      · Apple 芯片：macOS 要求 arm64 可执行文件至少有 ad-hoc 签名，
#        玩家侧执行一次 `sudo codesign --force --deep --sign - /Applications/McLink.app` 即可
#        （或者你在这台 Linux 上用 rcodesign 先签好，脚本里给了位置）。
#
# 用法：
#   bash deploy/build-macos-on-linux.sh                      # 默认主控 https://cnnic.link
#   MCLINK_MASTER=https://your.domain bash deploy/build-macos-on-linux.sh
#   ARCHES="--arm64" bash deploy/build-macos-on-linux.sh     # 只出 Apple 芯片版
#
# 依赖：Node ≥ 22、pnpm、unzip/zip、能访问 GitHub（取 EasyTier 核心与 Electron 二进制；
#      国内服务器会走 npmmirror 镜像下载 Electron）。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MCLINK_MASTER="${MCLINK_MASTER:-https://cnnic.link}"
ARCHES="${ARCHES:---arm64 --x64}"
VERSION="$(node -p "require('$REPO_ROOT/client/package.json').version" 2>/dev/null || echo 0.1.0)"

step() { printf '\n\033[36m▸ %s\033[0m\n' "$1"; }

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "这个脚本是给 Linux 服务器用的；当前是 $(uname -s)。" >&2
  echo "（macOS 上请直接跑：cd client && node scripts/dist.mjs --mac dmg zip）" >&2
  exit 1
fi

step "环境检查"
node --version
pnpm --version
command -v unzip >/dev/null || { echo "缺 unzip，请先 apt install unzip"; exit 1; }
command -v zip >/dev/null || { echo "缺 zip，请先 apt install zip"; exit 1; }

step "安装依赖"
pnpm install --frozen-lockfile

step "取 EasyTier 核心（含 macOS 两个架构）"
node scripts/fetch-easytier.mjs --macos

step "生成图标（含 macOS 需要的 1024 尺寸）"
pnpm icons

step "打包 macOS zip（未签名 / 无 dmg —— 原因见脚本头部注释）"
cd client
# 国内服务器走镜像，避免 Electron 二进制下载卡住
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
export VITE_MCLINK_MASTER="$MCLINK_MASTER"
export CSC_IDENTITY_AUTO_DISCOVERY=false
# shellcheck disable=SC2086
node scripts/dist.mjs --mac zip $ARCHES
cd "$REPO_ROOT"

shopt -s nullglob
ZIPS=(client/release/*macos*.zip)
if [[ ${#ZIPS[@]} -eq 0 ]]; then
  echo "没有生成任何 macos zip，请检查上面的 electron-builder 输出。" >&2
  exit 1
fi

step "产物"
for z in "${ZIPS[@]}"; do
  printf '  %s  %s\n' "$(du -h "$z" | cut -f1)" "$z"
  sha256sum "$z" | awk '{print "    sha256 " $1}'
done

# ---------------------------------------------------------------------------
# 可选：在这台 Linux 上做 ad-hoc 签名（Apple 芯片更省事）
#
# rcodesign（apple-codesign 项目，Rust 实现，有 Linux 版本）能在 Linux 上写 Apple 签名：
#   curl -L -o rcodesign.tar.gz \
#     https://github.com/indygreg/apple-platform-rs/releases/latest/download/rcodesign-x86_64-unknown-linux-musl.tar.gz
#   tar -xzf rcodesign.tar.gz && sudo mv rcodesign /usr/local/bin/
# 然后对解压出来的 .app 执行签名，再用 `zip -y -r` 重新打包（-y 保留符号链接，
# 这一步至关重要：Electron 的 framework 靠符号链接组织，缺了它 .app 起不来）：
#
#   unzip -q <产物.zip> -d /tmp/mclink-mac
#   rcodesign sign /tmp/mclink-mac/McLink.app        # 具体参数以 `rcodesign sign --help` 为准
#   ( cd /tmp/mclink-mac && zip -y -r -q <产物.zip> McLink.app )
#
# 这条路径**没有在本仓库验证过**（我们手上没有 Linux 机器），所以默认不自动执行，
# 只留给你需要时走。不签名同样可发：玩家侧一条命令即可（见下）。
# ---------------------------------------------------------------------------

cat <<EOF

下一步
------
1) 发布到主控下载目录（Debian 默认 /opt/mclink/data/downloads/）：
     sudo cp ${ZIPS[0]} /opt/mclink/data/downloads/
     sudo chown mclink:mclink /opt/mclink/data/downloads/$(basename "${ZIPS[0]}")
   文件名带 macos 与架构，官网会**自动**在下载页的 macOS 卡片里列出来（无需配置）。

2) 告诉 Mac 玩家首次怎么打开（未签名包）：
     · Intel Mac：解压后右键点图标 → 「打开」；仍被拦就执行
         xattr -dr com.apple.quarantine /Applications/McLink.app
     · Apple 芯片：若提示「已损坏，无法打开」，执行一次 ad-hoc 签名即可
         sudo codesign --force --deep --sign - /Applications/McLink.app

3) 想要"双击即开"的正式包（含 dmg 与公证）：只能在 macOS 上出 ——
   用 .github/workflows/build-clients.yml（公开仓库免费）或一台 Mac，
   见 docs/build-clients.md。
EOF
