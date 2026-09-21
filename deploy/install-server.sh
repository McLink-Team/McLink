#!/usr/bin/env bash
#
# mclink 主控一键安装 / 升级脚本（面向 Debian 12 x86_64）
#
# 做四件事：
#   1) 装依赖（Node.js >= 22、curl、ca-certificates）并创建系统用户 mclink
#   2) 把代码同步到 /opt/mclink/app，构建前端到 server/public，下载 EasyTier 到 vendor/easytier
#   3) 生成 /etc/mclink/mclink.env（密钥只在首次生成，升级时保留）
#   4) 安装并启动 systemd 服务，按需放行 ufw 端口
#
# 用法：
#   sudo bash deploy/install-server.sh --port 8787 --relay-port 11010
#   sudo bash deploy/install-server.sh --admin-password '请替换成强密码'
#   sudo bash deploy/install-server.sh --no-relay          # 只跑控制面，房间中继全部交给子节点
#
# 升级：在源码目录里 git pull 后重新执行同一条命令即可。升级不会重置 JWT / 中继密钥。
#
set -euo pipefail

SCRIPT_VERSION="0.1.0"          # 与根目录 package.json 的 version 保持一致
DEFAULT_PNPM_VERSION="10.33.2"  # 与 package.json 的 packageManager 字段保持一致

# ---------------------------------------------------------------- 默认参数
INSTALL_DIR="/opt/mclink"
HTTP_PORT="8787"
RELAY_PORT="11010"
ADMIN_PASSWORD=""
ENABLE_RELAY="true"
PUBLIC_BASE_URL=""
RELAY_PUBLIC_HOST=""
GITHUB_PROXY="${MCLINK_GITHUB_PROXY:-}"
SMTP_HOST=""
SMTP_PORT=""
SMTP_SECURE=""
SMTP_USER=""
SMTP_PASSWORD=""
SMTP_FROM=""
VERIFY_EMAIL=""
ET_VERSION="v2.6.4"
SOURCE_DIR=""
SKIP_INSTALL="false"
SKIP_WEB="false"
SKIP_EASYTier="false"
NO_UFW="false"
ROTATE_SECRETS="false"
ADMIN_PASSWORD_FROM_ARG="false"

RUN_USER="mclink"

# ---------------------------------------------------------------- 输出工具
c_reset=""; c_red=""; c_green=""; c_yellow=""; c_cyan=""
if [[ -t 2 ]]; then
  c_reset=$'\033[0m'; c_red=$'\033[31m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_cyan=$'\033[36m'
fi

log()  { printf '%s[信息]%s %s\n' "$c_cyan" "$c_reset" "$*" >&2; }
ok()   { printf '%s[完成]%s %s\n' "$c_green" "$c_reset" "$*" >&2; }
warn() { printf '%s[警告]%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
die()  { printf '%s[错误]%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
mclink 主控一键安装 / 升级脚本（Debian 12 x86_64）

用法：
  sudo bash deploy/install-server.sh [选项]

常用选项：
  --dir <路径>               安装目录，默认 /opt/mclink
                             代码放 <dir>/app，数据放 <dir>/data
  --port <端口>              主控 HTTP 端口，默认 8787
  --relay-port <端口>        主控中继的公共端口（TCP+UDP 同一端口），默认 11010
  --admin-password <密码>    初始管理员密码；不传则随机生成并只打印一次
  --public-url <URL>         对外访问地址，例如 https://cnnic.link
  --relay-public-host <主机> 客户端连接中继用的公网主机名/IP；默认从 --public-url 推导
  --github-proxy <前缀>      GitHub 加速前缀（国内机器下载 EasyTier 用），
                            例如 https://ghproxy.net/；留空则直连 GitHub
  --no-relay                 不启动主控自带中继（MCLINK_AUTOSTART_RELAY=false），
                             必须已部署子节点，否则无法创建房间

邮件（SMTP）选项：
  --smtp-host <主机>         SMTP 服务器地址，例如 smtp.exmail.qq.com
  --smtp-port <端口>         端口；默认按加密方式取（ssl=465、starttls=587）
  --smtp-secure <方式>       ssl（直连 TLS，465）/ starttls（587）/ none（仅内网）
  --smtp-user <账号>         登录账号；留空表示不做认证
  --smtp-password <密码>     登录密码（写入权限 600 的 env 文件）
  --smtp-from <发件人>       例如 mclink <no-reply@cnnic.link>；留空则用登录账号
  --no-verify-email          关闭「要求验证邮箱」（MCLINK_REQUIRE_EMAIL_VERIFICATION=false）

  说明：主控出厂就要求验证邮箱才能建房/进房。若这次没配 SMTP，注册会被拒绝 ——
  要么现在配上，要么先用 --no-verify-email 装好、之后在控制台补齐。

高级选项：
  --source <目录>            从指定的源码目录同步（默认使用本脚本所在的仓库）
  --easytier-version <版本>  EasyTier 发行版本，默认 v2.6.4
  --skip-install             跳过 pnpm install（假定 node_modules 已就绪）
  --skip-web                 跳过 pnpm build:web（假定 server/public 已构建）
  --skip-easytier            跳过 EasyTier 下载（假定 vendor/easytier 已有二进制）
  --rotate-secrets           重新生成 JWT 与中继密钥（会让所有登录令牌与旧票据失效）
  --no-ufw                   不修改 ufw 规则

  -h, --help                 显示本帮助
  --version                  显示脚本版本

说明：
  * 升级时不会重置 MCLINK_JWT_SECRET / MCLINK_RELAY_SECRET；
    只有显式传 --admin-password 才会覆盖 env 里的初始管理员密码
    （该密码仅在首次建号时生效，改它不会修改已存在账号的密码）。
  * 若只用反向代理对外，请不要对公网放行 8787，只放行中继端口。
EOF
}

# ---------------------------------------------------------------- 参数解析
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)                [[ $# -ge 2 ]] || die "--dir 缺少参数"; INSTALL_DIR="$2"; shift 2 ;;
    --port)               [[ $# -ge 2 ]] || die "--port 缺少参数"; HTTP_PORT="$2"; shift 2 ;;
    --relay-port)         [[ $# -ge 2 ]] || die "--relay-port 缺少参数"; RELAY_PORT="$2"; shift 2 ;;
    --admin-password)     [[ $# -ge 2 ]] || die "--admin-password 缺少参数"; ADMIN_PASSWORD="$2"; ADMIN_PASSWORD_FROM_ARG="true"; shift 2 ;;
    --public-url)         [[ $# -ge 2 ]] || die "--public-url 缺少参数"; PUBLIC_BASE_URL="$2"; shift 2 ;;
    --relay-public-host)  [[ $# -ge 2 ]] || die "--relay-public-host 缺少参数"; RELAY_PUBLIC_HOST="$2"; shift 2 ;;
    --github-proxy)       [[ $# -ge 2 ]] || die "--github-proxy 缺少参数"; GITHUB_PROXY="$2"; shift 2 ;;
    --no-relay)           ENABLE_RELAY="false"; shift ;;
    --smtp-host)          [[ $# -ge 2 ]] || die "--smtp-host 缺少参数"; SMTP_HOST="$2"; shift 2 ;;
    --smtp-port)          [[ $# -ge 2 ]] || die "--smtp-port 缺少参数"; SMTP_PORT="$2"; shift 2 ;;
    --smtp-secure)        [[ $# -ge 2 ]] || die "--smtp-secure 缺少参数"; SMTP_SECURE="$2"; shift 2 ;;
    --smtp-user)          [[ $# -ge 2 ]] || die "--smtp-user 缺少参数"; SMTP_USER="$2"; shift 2 ;;
    --smtp-password)      [[ $# -ge 2 ]] || die "--smtp-password 缺少参数"; SMTP_PASSWORD="$2"; shift 2 ;;
    --smtp-from)          [[ $# -ge 2 ]] || die "--smtp-from 缺少参数"; SMTP_FROM="$2"; shift 2 ;;
    --no-verify-email)    VERIFY_EMAIL="false"; shift ;;
    --source)             [[ $# -ge 2 ]] || die "--source 缺少参数"; SOURCE_DIR="$2"; shift 2 ;;
    --easytier-version)   [[ $# -ge 2 ]] || die "--easytier-version 缺少参数"; ET_VERSION="$2"; shift 2 ;;
    --skip-install)       SKIP_INSTALL="true"; shift ;;
    --skip-web)           SKIP_WEB="true"; shift ;;
    --skip-easytier)      SKIP_EASYTier="true"; shift ;;
    --rotate-secrets)     ROTATE_SECRETS="true"; shift ;;
    --no-ufw)             NO_UFW="true"; shift ;;
    -h|--help)            usage; exit 0 ;;
    --version)            echo "install-server.sh ${SCRIPT_VERSION}"; exit 0 ;;
    *)                    printf '[错误] 未知参数: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- 基本校验
[[ "${EUID}" -eq 0 ]] || die "请用 root 运行：sudo bash deploy/install-server.sh ..."

for pair in "端口:$HTTP_PORT" "中继端口:$RELAY_PORT"; do
  name="${pair%%:*}"; value="${pair#*:}"
  [[ "$value" =~ ^[0-9]+$ ]] || die "${name}必须是数字: $value"
  if (( value < 1 || value > 65535 )); then die "${name}超出范围(1-65535): $value"; fi
done
[[ "$HTTP_PORT" != "$RELAY_PORT" ]] || die "HTTP 端口与中继端口不能相同"

# GitHub 加速前缀统一成"以 / 结尾"，避免用户写成 https://ghproxy.net 时拼出坏 URL
if [[ -n "$GITHUB_PROXY" ]]; then
  case "$GITHUB_PROXY" in
    http://*|https://*) : ;;
    *) die "--github-proxy 必须以 http:// 或 https:// 开头: $GITHUB_PROXY" ;;
  esac
  [[ "${GITHUB_PROXY}" == */ ]] || GITHUB_PROXY="${GITHUB_PROXY}/"
fi
if [[ -n "$ADMIN_PASSWORD" ]]; then
  # systemd EnvironmentFile 对空白、引号、# 很敏感，这里直接拒绝而不是做转义
  case "$ADMIN_PASSWORD" in
    *[[:space:]]*|*'"'*|*"'"*|*'#'*|*'\'*) die "--admin-password 不能包含空白、引号、# 或反斜杠（建议用字母数字与 -_ 组合）" ;;
  esac
fi

case "$INSTALL_DIR" in
  /*) : ;;
  *) die "--dir 必须是绝对路径: $INSTALL_DIR" ;;
esac
INSTALL_DIR="${INSTALL_DIR%/}"
APP_DIR="${INSTALL_DIR}/app"
DATA_DIR="${INSTALL_DIR}/data"
CONF_DIR="/etc/mclink"
ENV_FILE="${CONF_DIR}/mclink.env"
UNIT_FILE="/etc/systemd/system/mclink-server.service"
SERVICE_NAME="mclink-server"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------- 系统检查
if [[ ! -r /etc/os-release ]]; then
  warn "读不到 /etc/os-release，跳过发行版检查"
else
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "debian" ]]; then
    warn "本脚本面向 Debian 12 编写，当前系统是 ${PRETTY_NAME:-未知}；继续执行，但可能需要自行调整软件包名"
  elif [[ "${VERSION_ID:-12}" != "12" ]]; then
    warn "当前 Debian 版本为 ${VERSION_ID:-未知}，脚本按 Debian 12 验证，请留意 NodeSource 源地址"
  fi
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- 依赖安装
apt_install() {
  apt-get install -y --no-install-recommends "$@" >/dev/null
}

install_base_packages() {
  log "更新软件包索引并安装基础依赖…"
  apt-get update -qq || die "apt-get update 失败：请检查网络与 /etc/apt/sources.list"
  apt_install ca-certificates curl openssl tar coreutils || die "基础依赖安装失败"
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then echo "0"; return 0; fi
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

node_ok() {
  local major
  major="$(node_major)"
  [[ "$major" =~ ^[0-9]+$ ]] || major=0
  # mclink 依赖 Node 原生 TS 剥离与 node:sqlite，要求 >= 22.6
  (( major >= 22 ))
}

install_node_from_nodesource() {
  local major="$1" codename script
  if [[ -r /etc/os-release ]]; then
    codename="$(. /etc/os-release; echo "${VERSION_CODENAME:-}")"
  else
    codename=""
  fi
  if [[ -z "$codename" ]]; then
    warn "无法确定发行版 codename，NodeSource 源可能不可用（可手动装好 Node.js 后重试）"
  else
    log "检测到发行版代号: ${codename}"
  fi

  script="$(mktemp)"
  log "从 NodeSource 添加 Node.js ${major}.x 软件源…"
  if ! curl -fsSL "https://deb.nodesource.com/setup_${major}.x" -o "$script"; then
    rm -f "$script"
    return 1
  fi
  if ! bash "$script" >/dev/null; then
    rm -f "$script"
    return 1
  fi
  rm -f "$script"
  apt-get update -qq || true
  apt_install nodejs || return 1
  return 0
}

ensure_node() {
  if node_ok; then
    log "已检测到 Node.js $(node -v)，满足要求（>= 22）"
    return 0
  fi
  local current
  current="$(node_major)"
  if [[ "$current" != "0" ]]; then
    warn "当前 Node.js 版本过低（v${current}），需要 >= 22.6，将安装新版本"
  else
    log "未检测到 Node.js，开始安装"
  fi

  # 优先装 Node 24（与项目开发环境一致）；失败则退到 22 LTS
  local major
  for major in 24 22; do
    if install_node_from_nodesource "$major"; then
      if node_ok; then
        ok "Node.js 已安装: $(node -v)"
        return 0
      fi
    fi
    warn "通过 NodeSource 安装 Node.js ${major}.x 失败"
  done

  cat >&2 <<'EOF'
[错误] 无法自动安装 Node.js。
请手动处理其一后重试：
  1) curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  2) 用 nvm / 官方二进制包安装到 /usr/local，确保 `node -v` >= v22.6
  3) 若处于受限网络，先设置 HTTPS_PROXY 后重试
EOF
  exit 1
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    log "已检测到 pnpm $(pnpm --version 2>/dev/null || echo '?')"
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    log "通过 corepack 启用 pnpm@${DEFAULT_PNPM_VERSION}…"
    corepack enable >/dev/null 2>&1 || true
    if corepack prepare "pnpm@${DEFAULT_PNPM_VERSION}" --activate >/dev/null 2>&1; then
      return 0
    fi
    warn "corepack 启用失败，改用 npm 全局安装"
  fi
  command -v npm >/dev/null 2>&1 || die "找不到 npm，也无法启用 corepack；请检查 Node.js 安装"
  log "通过 npm 全局安装 pnpm@${DEFAULT_PNPM_VERSION}…"
  npm install -g "pnpm@${DEFAULT_PNPM_VERSION}" >/dev/null || die "pnpm 安装失败"
}

# ---------------------------------------------------------------- 用户与目录
ensure_user() {
  if id -u "$RUN_USER" >/dev/null 2>&1; then
    log "系统用户 ${RUN_USER} 已存在"
    return 0
  fi
  log "创建系统用户 ${RUN_USER}…"
  useradd --system --no-create-home --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$RUN_USER" \
    || die "创建用户 ${RUN_USER} 失败"
}

prepare_dirs() {
  mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR" "${DATA_DIR}/logs" "${DATA_DIR}/downloads"
  chmod 0750 "$CONF_DIR"
  # 代码目录归 root，mclink 只读；数据目录归 mclink
  chown -R "root:root" "$APP_DIR"
  chown -R "${RUN_USER}:${RUN_USER}" "$DATA_DIR"
  chmod 0750 "$DATA_DIR"
}

# ---------------------------------------------------------------- 代码同步
resolve_source() {
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ -d "$SOURCE_DIR" ]] || die "--source 目录不存在: $SOURCE_DIR"
    [[ -f "$SOURCE_DIR/server/src/index.ts" ]] || die "--source 目录不像 mclink 仓库（缺少 server/src/index.ts）"
    return 0
  fi
  # 脚本位于 <repo>/deploy/ 下
  local candidate
  candidate="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [[ -f "${candidate}/package.json" && -f "${candidate}/server/src/index.ts" ]]; then
    SOURCE_DIR="$candidate"
    return 0
  fi
  cat >&2 <<'EOF'
[错误] 找不到 mclink 源码目录。
请用 --source 指定，或先在目标机上获取源码，例如：
  git clone <仓库地址> /tmp/mclink && sudo bash /tmp/mclink/deploy/install-server.sh
EOF
  exit 1
}

sync_source() {
  log "同步源码到 ${APP_DIR}（排除 node_modules / .cache / 运行时数据）…"
  # 用 tar 而不是 rsync，避免额外依赖；保留权限与符号链接
  tar -C "$SOURCE_DIR" \
    --exclude='./.git' \
    --exclude='node_modules' \
    --exclude='*/node_modules' \
    --exclude='./.cache' \
    --exclude='./server/data' \
    --exclude='./client/data' \
    --exclude='./release' \
    --exclude='./out' \
    --exclude='*.log' \
    -cf - . | tar -C "$APP_DIR" -xf -
  ok "源码已同步"
}

# ---------------------------------------------------------------- 构建
build_app() {
  if [[ "$SKIP_INSTALL" == "true" ]]; then
    warn "--skip-install：跳过依赖安装"
  else
    ensure_pnpm
    log "安装依赖（pnpm install --frozen-lockfile）…"
    if ! ( cd "$APP_DIR" && pnpm install --frozen-lockfile ); then
      # 这一条踩过：某个 package.json 改了但 pnpm-lock.yaml 没跟着更新时，
      # frozen-lockfile 会直接失败。默认报错只有一行 ERR_PNPM_OUTDATED_LOCKFILE，
      # 不说该找谁，所以在部署脚本里把处置办法讲清楚。
      warn "——————————————————————————————————————————————"
      warn "pnpm install 失败。若上面出现 ERR_PNPM_OUTDATED_LOCKFILE，说明仓库里的"
      warn "pnpm-lock.yaml 与某个 package.json 不一致（通常是改依赖后没提交 lockfile）。"
      warn ""
      warn "处置：在开发机上执行 pnpm install 更新 pnpm-lock.yaml 并提交，然后再跑本脚本。"
      warn "自检命令：pnpm verify:lockfile（应为 0 退出）"
      warn ""
      warn "应急：pnpm install --no-frozen-lockfile 可以装上，但依赖版本可能偏离 lockfile，"
      warn "      不建议用于生产。"
      warn "——————————————————————————————————————————————"
      die "pnpm install 失败"
    fi
  fi

  if [[ "$SKIP_WEB" == "true" ]]; then
    warn "--skip-web：跳过前端构建，假定 ${APP_DIR}/server/public 已存在"
  else
    log "构建前端到 server/public…"
    ( cd "$APP_DIR" && pnpm build:web ) || die "前端构建失败"
  fi
}

# ---------------------------------------------------------------- EasyTier
install_easytier() {
  local et_dir="${APP_DIR}/vendor/easytier"
  mkdir -p "$et_dir"

  if [[ "$SKIP_EASYTier" == "true" ]]; then
    warn "--skip-easytier：跳过 EasyTier 安装"
    return 0
  fi

  # 1) 仓库里若已带 Linux 产物（deploy/vendor/ 已被 gitignore，通常是本机下载的），直接复用
  if [[ -f "${APP_DIR}/deploy/vendor/linux-x86_64/easytier-core" ]]; then
    log "复用仓库自带的 Linux 产物：${APP_DIR}/deploy/vendor/linux-x86_64/"
    cp -f "${APP_DIR}/deploy/vendor/linux-x86_64/easytier-core" "${et_dir}/easytier-core"
    [[ -f "${APP_DIR}/deploy/vendor/linux-x86_64/easytier-cli" ]] \
      && cp -f "${APP_DIR}/deploy/vendor/linux-x86_64/easytier-cli" "${et_dir}/easytier-cli" || true
  fi

  # 2) 否则从 GitHub Releases 下载（用 -f 而不是 -x：复制过来的文件可能还没可执行位）
  if [[ ! -f "${et_dir}/easytier-core" || ! -f "${et_dir}/easytier-cli" ]]; then
    local url tmp
    url="https://github.com/EasyTier/EasyTier/releases/download/${ET_VERSION}/easytier-linux-x86_64-${ET_VERSION}.zip"
    # 国内机器直连 GitHub 常常超时（后果是"主控中继起不来"），所以支持加速前缀
    if [[ -n "$GITHUB_PROXY" ]]; then
      url="${GITHUB_PROXY}${url}"
      log "使用 GitHub 加速前缀：${GITHUB_PROXY}"
    fi
    tmp="$(mktemp -d)"
    log "下载 EasyTier ${ET_VERSION}：${url}"
    if curl -fL --retry 3 --connect-timeout 20 --retry-delay 3 -o "${tmp}/et.zip" "$url"; then
      if tar -xf "${tmp}/et.zip" -C "$tmp" >/dev/null 2>&1; then
        local found
        found="$(find "$tmp" -type f -name 'easytier-core' | head -n1)"
        if [[ -n "$found" ]]; then
          cp -f "$found" "${et_dir}/easytier-core"
        fi
        found="$(find "$tmp" -type f -name 'easytier-cli' | head -n1)"
        if [[ -n "$found" ]]; then
          cp -f "$found" "${et_dir}/easytier-cli"
        fi
      else
        warn "EasyTier 压缩包解压失败（文件可能损坏）"
      fi
    else
      warn "EasyTier 下载失败：HTTP 请求未成功（受限网络可设置 HTTPS_PROXY 后重试）"
    fi
    rm -rf "$tmp"
  fi

  chmod 0755 "${et_dir}"/* 2>/dev/null || true

  if [[ -f "${et_dir}/easytier-core" ]]; then
    ok "EasyTier 核心已就绪：${et_dir}/easytier-core"
    sha256sum "${et_dir}/easytier-core" 2>/dev/null | sed 's/^/    sha256 /' >&2 || true
    if [[ -f "${et_dir}/easytier-cli" ]]; then
      ok "EasyTier CLI 已就绪：${et_dir}/easytier-cli"
    else
      warn "缺少 easytier-cli：流量统计与 ACL 下发将不可用（房间仍可联机）"
    fi
  else
    warn "未能安装 easytier-core。主控可以启动，但不会拉起中继；房间将依赖子节点。"
    warn "可稍后手动执行：sudo bash ${APP_DIR}/deploy/install-server.sh --skip-install --skip-web"
    warn "或用 MCLINK_ET_CORE 指定已有的二进制路径。"
  fi
  return 0
}

# ---------------------------------------------------------------- env 文件
read_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || { echo ""; return 0; }
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

random_hex() { openssl rand -hex "$1"; }

write_env_file() {
  local old_jwt old_relay old_admin
  old_jwt="$(read_env_value "$ENV_FILE" MCLINK_JWT_SECRET)"
  old_relay="$(read_env_value "$ENV_FILE" MCLINK_RELAY_SECRET)"
  old_admin="$(read_env_value "$ENV_FILE" MCLINK_ADMIN_PASSWORD)"
  # 邮件配置在升级时也要保留：参数没给就沿用 env 里的旧值。
  # 尤其是密码 —— 升级时不会重新传一遍，丢了就等于把邮件服务悄悄关掉。
  old_smtp_host="$(read_env_value "$ENV_FILE" MCLINK_SMTP_HOST)"
  old_smtp_port="$(read_env_value "$ENV_FILE" MCLINK_SMTP_PORT)"
  old_smtp_secure="$(read_env_value "$ENV_FILE" MCLINK_SMTP_SECURE)"
  old_smtp_user="$(read_env_value "$ENV_FILE" MCLINK_SMTP_USER)"
  old_smtp_password="$(read_env_value "$ENV_FILE" MCLINK_SMTP_PASSWORD)"
  old_smtp_from="$(read_env_value "$ENV_FILE" MCLINK_SMTP_FROM)"
  old_verify_email="$(read_env_value "$ENV_FILE" MCLINK_REQUIRE_EMAIL_VERIFICATION)"
  final_smtp_host="${SMTP_HOST:-$old_smtp_host}"
  final_smtp_secure="${SMTP_SECURE:-$old_smtp_secure}"
  final_smtp_user="${SMTP_USER:-$old_smtp_user}"
  final_smtp_password="${SMTP_PASSWORD:-$old_smtp_password}"
  final_smtp_from="${SMTP_FROM:-$old_smtp_from}"
  final_verify_email="${VERIFY_EMAIL:-$old_verify_email}"
  # 端口没显式给就按加密方式取默认值（ssl=465 / starttls=587 / none=25）
  final_smtp_port="${SMTP_PORT:-$old_smtp_port}"
  if [[ -z "$final_smtp_port" ]]; then
    case "$final_smtp_secure" in
      starttls) final_smtp_port="587" ;;
      none)     final_smtp_port="25" ;;
      *)        final_smtp_port="465" ;;
    esac
  fi

  local jwt_secret relay_secret admin_password admin_is_new="false"
  local old_umask

  if [[ "$ROTATE_SECRETS" == "true" ]]; then
    jwt_secret="$(random_hex 32)"
    relay_secret="$(random_hex 32)"
    warn "--rotate-secrets：已生成新的 JWT 与中继密钥，所有登录令牌与旧票据将立即失效"
  else
    jwt_secret="${old_jwt:-$(random_hex 32)}"
    relay_secret="${old_relay:-$(random_hex 32)}"
    if [[ -n "$old_jwt" || -n "$old_relay" ]]; then
      log "检测到已有 ${ENV_FILE}，保留原有 JWT / 中继密钥"
    fi
  fi

  if [[ "$ADMIN_PASSWORD_FROM_ARG" == "true" ]]; then
    admin_password="$ADMIN_PASSWORD"
  elif [[ -n "$old_admin" ]]; then
    admin_password="$old_admin"
  else
    # 生成 20 位可打印随机密码
    admin_password="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
    admin_is_new="true"
  fi

  if [[ -f "$ENV_FILE" ]]; then
    local backup
    backup="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$ENV_FILE" "$backup"
    log "已备份旧环境文件到 ${backup}"
  fi

  old_umask="$(umask)"
  umask 077
  {
    echo "# mclink 主控环境变量 —— 由 deploy/install-server.sh 生成于 $(date -Is)"
    echo "# 权限 600 / owner ${RUN_USER}；升级脚本会保留其中的密钥，请勿手工删除。"
    echo "# 可用变量与默认值详见 server/src/config.ts 与 docs/deployment.md。"
    echo ""
    echo "# ---- 存储 ----"
    echo "MCLINK_DATA_DIR=${DATA_DIR}"
    echo "MCLINK_DOWNLOADS_DIR=${DATA_DIR}/downloads"
    echo ""
    echo "# ---- HTTP ----"
    echo "MCLINK_PORT=${HTTP_PORT}"
    echo "MCLINK_HOST=0.0.0.0"
    [[ -n "$PUBLIC_BASE_URL" ]] && echo "MCLINK_PUBLIC_BASE_URL=${PUBLIC_BASE_URL}"
    echo "MCLINK_TRUST_PROXY=true"
    echo ""
    echo "# ---- 主控中继（单端口承载多房间）----"
    echo "MCLINK_RELAY_PORT=${RELAY_PORT}"
    echo "MCLINK_RELAY_RPC=127.0.0.1:15888"
    echo "MCLINK_RELAY_WHITELIST=mclink-room-*"
    echo "MCLINK_RELAY_NETWORK=mclink-master"
    echo "MCLINK_RELAY_NO_TUN=true"
    [[ -n "$RELAY_PUBLIC_HOST" ]] && echo "MCLINK_RELAY_PUBLIC_HOST=${RELAY_PUBLIC_HOST}"
    if [[ "$ENABLE_RELAY" == "true" ]]; then
      echo "MCLINK_AUTOSTART_RELAY=true"
    else
      echo "MCLINK_AUTOSTART_RELAY=false"
    fi
    echo ""
    echo "# ---- EasyTier 二进制 ----"
    echo "MCLINK_ET_CORE=${APP_DIR}/vendor/easytier/easytier-core"
    echo "MCLINK_ET_CLI=${APP_DIR}/vendor/easytier/easytier-cli"
    echo ""
    echo "# ---- 密钥（请勿泄露；升级时脚本会保留这些值）----"
    echo "MCLINK_JWT_SECRET=${jwt_secret}"
    echo "MCLINK_ADMIN_PASSWORD=${admin_password}"
    echo "MCLINK_RELAY_SECRET=${relay_secret}"
    echo ""
    echo "# ---- 运行 ----"
    echo "MCLINK_LOG_LEVEL=info"
    echo ""
    echo "# ---- 邮件（SMTP，主控自己发信）----"
    echo "MCLINK_REQUIRE_EMAIL_VERIFICATION=${final_verify_email:-true}"
    if [[ -n "$final_smtp_host" ]]; then
      echo "MCLINK_SMTP_HOST=${final_smtp_host}"
      echo "MCLINK_SMTP_PORT=${final_smtp_port}"
      echo "MCLINK_SMTP_SECURE=${final_smtp_secure:-ssl}"
      [[ -n "$final_smtp_user" ]] && echo "MCLINK_SMTP_USER=${final_smtp_user}"
      [[ -n "$final_smtp_password" ]] && echo "MCLINK_SMTP_PASSWORD=${final_smtp_password}"
      [[ -n "$final_smtp_from" ]] && echo "MCLINK_SMTP_FROM=${final_smtp_from}"
    else
      echo "# 尚未配置 SMTP：控制台「平台设置 → 邮件服务」里补，或重跑本脚本带 --smtp-host"
      echo "# 注意：REQUIRE_EMAIL_VERIFICATION=true 且没有可用 SMTP 时，新用户注册会被拒绝"
    fi
  } > "$ENV_FILE"
  umask "$old_umask"

  chown "${RUN_USER}:${RUN_USER}" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"

  ADMIN_PASSWORD_FINAL="$admin_password"
  ADMIN_PASSWORD_IS_NEW="$admin_is_new"
  ok "环境文件已写入 ${ENV_FILE}（权限 600，owner ${RUN_USER}）"
}

# ---------------------------------------------------------------- systemd
install_unit() {
  local unit_src="${APP_DIR}/deploy/mclink-server.service"
  local node_bin
  [[ -f "$unit_src" ]] || die "找不到单元文件：$unit_src"
  node_bin="$(command -v node || true)"
  [[ -n "$node_bin" ]] || die "在 PATH 中找不到 node，无法生成 systemd 单元"
  if [[ "$node_bin" != "/usr/bin/node" ]]; then
    warn "node 实际路径为 ${node_bin}，将同步写入单元文件"
  fi

  log "安装 systemd 单元到 ${UNIT_FILE}…"
  sed \
    -e "s#^User=.*#User=${RUN_USER}#" \
    -e "s#^Group=.*#Group=${RUN_USER}#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}#" \
    -e "s#^EnvironmentFile=.*#EnvironmentFile=${ENV_FILE}#" \
    -e "s#^ExecStart=.*#ExecStart=${node_bin} server/src/index.ts#" \
    -e "s#^ReadWritePaths=.*#ReadWritePaths=${DATA_DIR}#" \
    -e "s#^Documentation=.*#Documentation=file://${APP_DIR}/docs/deployment.md#" \
    "$unit_src" > "$UNIT_FILE"
  chmod 0644 "$UNIT_FILE"

  systemctl daemon-reload
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "重启 ${SERVICE_NAME}…"
    systemctl restart "$SERVICE_NAME"
  else
    log "启动并设置开机自启 ${SERVICE_NAME}…"
    systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || warn "systemctl enable --now 失败，请手动检查"
  fi

  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "${SERVICE_NAME} 正在运行"
  else
    warn "${SERVICE_NAME} 未处于运行状态，请查看：journalctl -u ${SERVICE_NAME} -n 80 --no-pager"
  fi
}

# ---------------------------------------------------------------- 防火墙
configure_firewall() {
  if [[ "$NO_UFW" == "true" ]]; then
    warn "--no-ufw：跳过防火墙配置"
    return 0
  fi
  if ! command -v ufw >/dev/null 2>&1; then
    log "未安装 ufw，跳过防火墙配置"
    return 0
  fi
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    log "ufw 未启用，跳过防火墙配置"
    return 0
  fi

  log "为 ufw 放行端口…"
  ufw allow "${RELAY_PORT}/tcp" comment 'mclink relay tcp' >/dev/null 2>&1 || warn "ufw 放行 ${RELAY_PORT}/tcp 失败"
  ufw allow "${RELAY_PORT}/udp" comment 'mclink relay udp' >/dev/null 2>&1 || warn "ufw 放行 ${RELAY_PORT}/udp 失败"
  ok "已放行中继端口 ${RELAY_PORT}（TCP+UDP）"

  if [[ -n "$PUBLIC_BASE_URL" && "$PUBLIC_BASE_URL" == https://* ]]; then
    warn "检测到 HTTPS 对外地址：建议不要对公网放行 ${HTTP_PORT}，只让反向代理访问本机 ${HTTP_PORT}"
    warn "如需放行可执行：ufw allow ${HTTP_PORT}/tcp"
  else
    ufw allow "${HTTP_PORT}/tcp" comment 'mclink master http' >/dev/null 2>&1 || warn "ufw 放行 ${HTTP_PORT}/tcp 失败"
    ok "已放行 HTTP 端口 ${HTTP_PORT}"
  fi
}

# ---------------------------------------------------------------- 汇总
print_summary() {
  local base_url
  base_url="${PUBLIC_BASE_URL:-http://<服务器IP>:${HTTP_PORT}}"
  cat >&2 <<EOF

${c_green}======================= mclink 主控安装完成 =======================${c_reset}

  安装目录 : ${INSTALL_DIR}
  代码     : ${APP_DIR}
  数据     : ${DATA_DIR}          （SQLite / EasyTier 配置 / 日志 / 下载）
  环境变量 : ${ENV_FILE}
  服务     : ${SERVICE_NAME}（systemd，已设为开机自启）
  访问地址 : ${base_url}

EOF

  if [[ "${ADMIN_PASSWORD_IS_NEW:-false}" == "true" ]]; then
    cat >&2 <<EOF
  ${c_yellow}初始管理员密码（只显示这一次，请立即保存）${c_reset}
    用户名 : admin
    密码   : ${ADMIN_PASSWORD_FINAL}

  ${c_yellow}注意${c_reset}：该密码只在「库里还没有任何用户」时用于建号。
  如果数据库里已经有 admin 账号，这里显示的密码不会改变现有密码 ——
  请用旧密码登录后在「账号设置」里修改。

EOF
  else
    cat >&2 <<EOF
  初始管理员密码沿用 ${ENV_FILE} 中已有的值（未修改）。
  注意：该变量只在首次建号时生效，改它不会修改已存在账号的密码；
  请用旧密码登录后在「账号设置」改密（见 docs/troubleshooting.md 第 13 节）。

EOF
  fi

  cat >&2 <<EOF
后续步骤：
  1) 看日志        : journalctl -u ${SERVICE_NAME} -f
  2) 看状态        : systemctl status ${SERVICE_NAME}
  3) 首登后改密码  : 登录 ${base_url} → 「账号设置」→ 修改密码
                     （改后所有旧会话立即失效）
  4) 装子节点      : 管理台「节点」页签发注册密钥（填好区域与运行/链接端口），
                     然后在区域服务器上粘贴返回的那条命令即可：
                       curl -fsSL ${base_url}/agent/install.sh | sudo bash -s -- \\
                         --master ${base_url} --key <注册密钥> --region cn-east \\
                         --name relay-sh --endpoint relay-sh.cnnic.link:${RELAY_PORT} \\
                         --listen-port ${RELAY_PORT}
  5) 反向代理/证书 : 参考 ${APP_DIR}/deploy/nginx.conf.example（WS 必须单独配置）
  6) 是否放行 ${HTTP_PORT}: 若已用 HTTPS 反代，不要对公网放行 ${HTTP_PORT}
$(if [[ "${final_verify_email:-true}" == "true" && -z "$final_smtp_host" ]]; then
  cat <<'WARN'
  7) ⚠ 邮箱验证已开启但没有 SMTP：新用户注册会被拒绝。
     补配：sudo nano /etc/mclink/mclink.env 填 MCLINK_SMTP_* 后
           sudo systemctl restart mclink-server
     或者在控制台「平台设置 → 邮件服务」里填，并点「发送测试邮件」验证。
     临时放行：把 MCLINK_REQUIRE_EMAIL_VERIFICATION 改成 false 后重启。
WARN
elif [[ -n "$final_smtp_host" ]]; then
  cat <<SMTP
  7) 邮件服务      : 已配置（${final_smtp_host}:${final_smtp_port}，加密 ${final_smtp_secure:-ssl}
                     请到控制台「平台设置 → 邮件服务」点一次「发送测试邮件」确认能投递。
SMTP
fi)

文档索引：${APP_DIR}/docs/（deployment.md 生产部署、security.md 安全边界、troubleshooting.md 排障）
EOF
}

# ---------------------------------------------------------------- 主流程
main() {
  log "mclink 主控安装脚本 ${SCRIPT_VERSION} 开始（安装目录 ${INSTALL_DIR}）"

  install_base_packages
  ensure_node
  ensure_user
  prepare_dirs

  resolve_source
  sync_source
  build_app
  install_easytier

  write_env_file
  install_unit
  configure_firewall
  print_summary
}

main "$@"
