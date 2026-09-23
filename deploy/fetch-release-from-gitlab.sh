#!/usr/bin/env bash
# 在主控上下载 GitLab CI 产出的客户端安装包，直接放进下载目录。
#
# 用法（在主控机器上执行）：
#   GITLAB_TOKEN=glpat-xxxx bash deploy/fetch-release-from-gitlab.sh v1.0.0
#   GITLAB_TOKEN=glpat-xxxx bash deploy/fetch-release-from-gitlab.sh main --windows-only
#
# 说明：
#   · GITLAB_TOKEN 用一个 **Project Access Token**（权限只需 read_api），
#     在 GitLab → 项目 → Settings → Access tokens 里建。
#     私有仓库必须带 token；公开仓库可省略。
#   · 产物来源是**某次 pipeline 的 artifacts**：先按 ref（标签或分支）找到该 job，
#     再下它的 artifacts.zip。所以标签推上去、CI 跑完之前执行会拿不到东西。
#   · 下载目录默认 /opt/mclink/data/downloads（可用 MCLINK_DOWNLOADS_DIR 覆盖）。
#   · 只挑客户端安装包（.exe/.dmg/.zip），并排除 .blockmap —— 那不是给玩家下的。
#   · 拷完打印每个文件的 sha256；**不会**自动改平台设置（版本号要不要对外宣称
#     新版本是运营决定，控制台里改「客户端版本」即可）。

set -euo pipefail

REF="${1:-main}"
shift || true
WINDOWS_ONLY=0
for a in "$@"; do [[ "$a" == "--windows-only" ]] && WINDOWS_ONLY=1; done

: "${GITLAB_TOKEN:=}"
PROJECT_PATH="${GITLAB_PROJECT:-example/legacy-backup}"
GITLAB_HOST="${GITLAB_HOST:-https://gitlab.com}"
DOWNLOADS_DIR="${MCLINK_DOWNLOADS_DIR:-/opt/mclink/data/downloads}"
OWNER="${MCLINK_OWNER:-mclink:mclink}"

PROJECT_ID="$(printf '%s' "$PROJECT_PATH" | sed 's|/|%2F|g')"
API="$GITLAB_HOST/api/v4/projects/$PROJECT_ID"

auth_header=()
[[ -n "$GITLAB_TOKEN" ]] && auth_header=(-H "PRIVATE-TOKEN: $GITLAB_TOKEN")

echo "▸ 项目 $PROJECT_PATH  ref=$REF"
echo "▸ 下载目录 $DOWNLOADS_DIR"

sudo mkdir -p "$DOWNLOADS_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

jobs=("build:windows")
[[ $WINDOWS_ONLY -eq 0 ]] && jobs+=("build:macos")

got=0
for job in "${jobs[@]}"; do
  echo
  echo "▸ 拉取 job「${job}」的 artifacts"
  url="$API/jobs/artifacts/$REF/download?job=$(printf '%s' "$job" | sed 's|:|%3A|g')"
  if ! curl -fsSL "${auth_header[@]}" "$url" -o "$TMP/$job.zip"; then
    echo "  ✗ 拿不到（该 ref 上这个 job 可能还没跑、或没生成 artifacts）"
    continue
  fi
  echo "  已下载 $(du -h "$TMP/$job.zip" | cut -f1)"
  unzip -q -o "$TMP/$job.zip" -d "$TMP/$job"

  # artifacts.zip 里是仓库相对路径（client/release/…），挑出安装包
  while IFS= read -r -d '' f; do
    name="$(basename "$f")"
    case "$name" in
      *.blockmap) continue ;;
    esac
    if [[ $WINDOWS_ONLY -eq 1 && "$name" != *.exe ]]; then continue; fi
    if [[ $WINDOWS_ONLY -eq 0 && ! ( "$name" == *.exe || "$name" == *.dmg || "$name" == *.zip ) ]]; then continue; fi
    sudo cp -f "$f" "$DOWNLOADS_DIR/$name"
    sudo chown "$OWNER" "$DOWNLOADS_DIR/$name" 2>/dev/null || true
    sudo chmod 0644 "$DOWNLOADS_DIR/$name"
    got=$((got + 1))
    printf '  ✓ %s  %s\n' "$name" "$(du -h "$DOWNLOADS_DIR/$name" | cut -f1)"
  done < <(find "$TMP/$job" -type f -print0)
done

if [[ $got -eq 0 ]]; then
  echo
  echo "没有拿到任何产物。检查："
  echo "  · 这个 ref 的 pipeline 是否已成功（GitLab → CI/CD → Pipelines）"
  echo "  · job 名是否还是 build:windows / build:macos（改了 .gitlab-ci.yml 要同步）"
  echo "  · 私有仓库是否设置了 GITLAB_TOKEN（read_api）"
  exit 1
fi

echo
echo "▸ 下载目录现状"
sudo ls -lh "$DOWNLOADS_DIR" | tail -n +2

echo
echo "▸ sha256（登记到平台设置里用得上）"
for f in "$DOWNLOADS_DIR"/*.exe "$DOWNLOADS_DIR"/*.dmg "$DOWNLOADS_DIR"/*.zip; do
  [[ -f "$f" ]] || continue
  printf '  %s  %s\n' "$(sudo sha256sum "$f" | cut -d' ' -f1)" "$(basename "$f")"
done

cat <<'EOF'

下一步
------
1) 控制台 →「平台设置」确认：
     · 客户端版本 = 1.0.0（与产物版本一致，否则客户端不会提示更新）
     · 下载地址   = /downloads/McLink-Setup-1.0.0-x64.exe（Windows 主产物）
   macOS 的两个包不用配 —— 官网按文件名自动识别平台与架构。
2) 老客户端会在启动时对比版本号，自动提示「有新版本 v1.0.0」。
EOF
