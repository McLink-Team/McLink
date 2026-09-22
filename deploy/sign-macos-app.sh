#!/usr/bin/env bash
# 对 electron-builder 产出的 .app 做 **ad-hoc 签名**，并用 zip -y 重新打包。
#
# 为什么必须要这一步
# ------------------
# 我们没有 Apple 开发者证书，electron-builder 在找不到证书时只会打印
#   "skipped macOS application code signing"
# 然后把**未签名**的 .app 打进 dmg/zip。而 Apple 芯片要求 arm64 可执行文件
# 至少有 ad-hoc 签名，否则内核直接拒绝执行（玩家看到的是"已损坏，无法打开"）。
# 在 macOS 上 `codesign -s -` 就是 ad-hoc 签名，成本为零，所以 CI 里顺手做掉。
#
# zip -y 的 -y 是**关键**：Electron 的 framework 靠符号链接组织
# （Versions/Current、Resources 等），不保留符号链接的压缩包解开后 .app 起不来。
#
# 用法（在 macOS 上）：bash deploy/sign-macos-app.sh [release 目录，默认 client/release]

set -euo pipefail

RELEASE_DIR="${1:-client/release}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "这个脚本只能在 macOS 上跑（需要 codesign 与 zip -y）：当前 $(uname -s)" >&2
  exit 1
fi

VERSION="$(node -p "require('./client/package.json').version")"
shopt -s nullglob

found=0
for APP in "$RELEASE_DIR"/mac*/McLink.app; do
  [[ -d "$APP" ]] || continue
  found=1
  ARCH="$(basename "$(dirname "$APP")")"          # mac-arm64 / mac-x64
  OUT="$RELEASE_DIR/McLink-${VERSION}-macos-${ARCH#mac-}.zip"

  echo "▸ 检查 $APP"
  # 核心二进制是不是目标架构的那一份（放错架构 = 玩家一进房就崩）
  CORE="$APP/Contents/Resources/vendor/easytier/macos-${ARCH#mac-}/easytier-core"
  if [[ -f "$CORE" ]]; then
    echo "  核心: $(file -b "$CORE" | cut -c1-60)"
  else
    echo "  ⚠ 没找到 $CORE —— 检查 electron-builder.yml 的 mac.extraResources" >&2
  fi

  echo "▸ ad-hoc 签名"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/  /'

  echo "▸ 重新打包（zip -y 保留符号链接）-> $OUT"
  rm -f "$OUT"
  ( cd "$(dirname "$APP")" && zip -y -r -q "$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")" McLink.app )

  echo "  产物: $OUT  $(du -h "$OUT" | cut -f1)"
  # 校验符号链接真的被保留了：framework 里应有 l 类型条目
  if unzip -l "$OUT" | grep -q 'Versions/Current$'; then
    echo "  ✓ 符号链接已保留（Versions/Current）"
  else
    echo "  ⚠ 压缩包里似乎没有符号链接，玩家解压后可能起不来" >&2
  fi
done

if [[ $found -eq 0 ]]; then
  echo "在 $RELEASE_DIR 下没找到 mac*/*.app —— 先跑构建" >&2
  exit 1
fi

echo
echo "下一步：把 zip 拷进主控下载目录（/opt/mclink/data/downloads/），官网会自动列出。"
