#!/usr/bin/env bash
# 对 electron-builder 产出的 .app 做 **ad-hoc 签名**，再产出可直接分发的 zip 与 dmg。
#
# 为什么必须有这一步
# ------------------
# 没有 Apple 开发者证书时，electron-builder 只会打印
#   "skipped macOS application code signing"
# 然后把**未签名**的 .app 打进 dmg/zip。而 Apple 芯片要求 arm64 可执行文件至少有
# ad-hoc 签名，否则内核直接拒绝执行 —— 玩家看到的是「已损坏，无法打开」。
#
# 同时这也解决了另一个坑：electron-builder 的 dmg 是在签名**之前**做的，
# 里面装的是未签名副本。所以 dmg 也由本脚本在签名之后重新生成。
#
# 关键细节（都是踩过的）
# --------------------
#   · zip 必须用 `-y`：Electron 的 framework 靠符号链接组织（Versions/Current 等），
#     不保留链接的话玩家解压出来的 .app 起不来。
#   · 架构**不能从目录名推断**：electron-builder 把 x64 放在 `release/mac/`、
#     arm64 放在 `release/mac-arm64/`（x64 那个目录名里没有架构），
#     所以这里用 `lipo -archs` 读主程序真实的架构。
#   · 所有路径先转成绝对路径：脚本中途会 cd，相对路径会算错
#     （上一版就是这样把 zip 写到了 `/`，报 "Read-only file system"）。
#
# 用法（只能在 macOS 上跑）：bash deploy/sign-macos-app.sh [release 目录=client/release]

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(pwd)"
RELEASE_DIR="$(cd "${1:-client/release}" && pwd)"
VERSION="$(node -p "require('./client/package.json').version")"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "这个脚本只能在 macOS 上跑（需要 codesign / hdiutil / zip -y）：当前 $(uname -s)" >&2
  exit 1
fi

shopt -s nullglob
found=0

for APP in "$RELEASE_DIR"/mac*/McLink.app; do
  [[ -d "$APP" ]] || continue
  found=1

  # 真实架构：读主可执行文件，而不是看目录名
  MAIN_BIN="$APP/Contents/MacOS/McLink"
  ARCH="$(lipo -archs "$MAIN_BIN" 2>/dev/null | tr -d ' ' || true)"
  case "$ARCH" in
    arm64) SUBDIR=macos-arm64 ;;
    x86_64|x86_64h) ARCH=x64; SUBDIR=macos-x64 ;;
    *) echo "⚠ 无法识别的架构 '${ARCH}'（${MAIN_BIN}），跳过 ${APP}" >&2; continue ;;
  esac

  ZIP="$RELEASE_DIR/McLink-${VERSION}-macos-${ARCH}.zip"
  DMG="$RELEASE_DIR/McLink-${VERSION}-macos-${ARCH}.dmg"

  echo "▸ ${APP}  （架构 ${ARCH}）"

  # 核心二进制必须是目标架构那一份：放错架构 = 玩家一进房就崩（根目录那份是 Linux 版）
  CORE="$APP/Contents/Resources/vendor/easytier/$SUBDIR/easytier-core"
  if [[ -f "$CORE" ]]; then
    echo "  核心: $(file -b "$CORE" | cut -c1-70)"
  else
    echo "  ✗ 缺少 $CORE —— electron-builder.yml 的 mac.extraResources 没生效，包不可用" >&2
    exit 1
  fi
  [[ -f "$APP/Contents/Resources/app.asar" ]] || { echo "  ✗ 缺少 app.asar" >&2; exit 1; }

  echo "▸ ad-hoc 签名"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP" && echo "  ✓ 签名校验通过（ad-hoc）"

  echo "▸ 重新打包 zip（保留符号链接）"
  rm -f "$ZIP"
  # 优先用 ditto：Apple 官方推荐的 .app 归档方式（-c 创建、-k PKZip、--keepParent 保留顶层目录），
  # 符号链接与扩展属性都能保留 —— 这正是公证/Gatekeeper 关心的东西。
  # 没有 ditto 时退回 `zip -y`（-y = 把符号链接按链接存，而不是存它指向的文件）。
  if command -v ditto >/dev/null; then
    ( cd "$(dirname "$APP")" && ditto -c -k --sequesterRsrc --keepParent McLink.app "$ZIP" )
    echo "  （用 ditto 归档）"
  else
    ( cd "$(dirname "$APP")" && zip -y -r -q "$ZIP" McLink.app )
    echo "  （用 zip -y 归档）"
  fi
  echo "  $ZIP  $(du -h "$ZIP" | cut -f1)"

  # 符号链接检查分两步，且**不要把 unzip 和 grep -q 放进同一条管道**：
  # `set -o pipefail` 下 grep -q 一命中就退出，unzip 收到 SIGPIPE 返回 141，
  # 整条管道因此算失败 —— 明明有链接也会被判成"没有"（CI 上就是这么误报的）。
  FRAMEWORK_LINK="$APP/Contents/Frameworks/Electron Framework.framework/Versions/Current"
  if [[ -L "$FRAMEWORK_LINK" ]]; then
    echo "  ✓ 磁盘上的 framework 符号链接正常（zip -y 以它为准）"
  else
    echo "  ✗ 磁盘上就没有 $FRAMEWORK_LINK —— 打包链本身有问题" >&2
    exit 1
  fi

  LIST="$(mktemp)"
  unzip -l "$ZIP" > "$LIST" 2>&1 || true
  LINK_COUNT="$(grep -c 'Versions/Current$' "$LIST" || true)"
  if [[ "${LINK_COUNT:-0}" -gt 0 ]]; then
    echo "  ✓ 压缩包内保留 ${LINK_COUNT} 个符号链接条目"
  else
    echo "  ✗ 压缩包里没有符号链接（条目总数 $(grep -c 'McLink.app' "$LIST" || true)）" >&2
    echo "    压缩包内前几行：" >&2
    sed -n '1,6p' "$LIST" >&2
    rm -f "$LIST"
    exit 1
  fi
  rm -f "$LIST"

  # dmg 在签名**之后**生成，里面装的才是已签名副本；附 /Applications 软链方便拖动安装
  if command -v hdiutil >/dev/null; then
    echo "▸ 生成 dmg（含已签名副本）"
    STAGE="$(mktemp -d)"
    cp -R "$APP" "$STAGE/McLink.app"
    ln -s /Applications "$STAGE/Applications"
    rm -f "$DMG"
    hdiutil create -volname "McLink ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"
    rm -rf "$STAGE"
    echo "  $DMG  $(du -h "$DMG" | cut -f1)"
  else
    echo "  （这台机器没有 hdiutil，跳过 dmg）"
  fi
done

if [[ $found -eq 0 ]]; then
  echo "在 $RELEASE_DIR 下没找到 mac*/McLink.app —— 先跑构建" >&2
  exit 1
fi

echo
echo "下一步：把 zip/dmg 拷进主控下载目录（/opt/mclink/data/downloads/），官网会自动列出。"
echo "仓库根目录: $REPO_ROOT"
