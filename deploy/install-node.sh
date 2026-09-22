#!/usr/bin/env bash
#
# mclink 子节点（区域中继）一键安装脚本（面向 Debian 12 x86_64）
#
# 做四件事：
#   1) 装依赖（Node.js >= 22、curl、ca-certificates）并创建系统用户 mclink
#   2) 把 deploy/agent.mjs 与 EasyTier 二进制放到 /opt/mclink-node/app
#   3) 生成 /etc/mclink/node.env（权限 600，owner mclink）
#   4) 安装并启动 systemd 服务 mclink-node
#
# 前置：先在主控管理台「节点」页签发一次性注册密钥，再执行本脚本。
#
# 用法：
#   sudo bash deploy/install-node.sh \
#     --master https://cnnic.link \
#     --key <注册密钥> \
#     --region cn-east \
#     --endpoint relay-sh.cnnic.link:11010 \
#     --name relay-sh
#
set -euo pipefail

SCRIPT_VERSION="0.1.0"

# ---------------------------------------------------------------- 默认参数
INSTALL_DIR="/opt/mclink-node"
RUN_USER="mclink"
MASTER=""
ENROLL_KEY=""
REGION=""
ENDPOINT=""
# 运行端口 / 链接端口：默认都取 --endpoint 的端口；NAT 后面两者可以不同
LISTEN_PORT=""
CONNECT_PORT=""
# GitHub 加速前缀（国内节点用）；空 = 直连 GitHub
GITHUB_PROXY="${MCLINK_GITHUB_PROXY:-}"
NODE_NAME=""
CAPACITY_PEERS="500"
TAGS=""
ET_VERSION="v2.6.4"
AGENT_SRC=""
SOURCE_DIR=""
SKIP_EASYTier="false"
NO_UFW="false"
HEARTBEAT_INTERVAL=""

CONF_DIR="/etc/mclink"
ENV_FILE="${CONF_DIR}/node.env"
LOG_DIR="/var/log/mclink"
UNIT_FILE="/etc/systemd/system/mclink-node.service"
SERVICE_NAME="mclink-node"

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
mclink 子节点（区域中继）一键安装脚本（Debian 12 x86_64）

用法：
  sudo bash deploy/install-node.sh --master <主控地址> --key <注册密钥> \
    --region <区域> --endpoint <公网地址> [选项]

必填：
  --master <URL>            主控地址，例如 https://cnnic.link
  --key <注册密钥>           管理台签发的一次性注册密钥
  --region <区域>            区域标识：cn-east / cn-south / cn-north / cn-central /
                            cn-southwest / cn-northwest / cn-northeast / hk / oversea
  --endpoint <host:port>    客户端连接本节点用的公网地址；端口即**链接端口**，
                            例如 relay-sh.cnnic.link:21010

端口说明（NAT / 端口映射部署必读）：
  --listen-port <端口>       **运行端口**：本机 easytier-core 实际监听的端口，默认取
                            --endpoint 的端口。本机只能绑 11010、而对外只开放 21010 时，
                            就写 --listen-port 11010（防火墙/安全组要放行的是**它**，
                            以及映射出去的那个对外端口）。
  --connect-port <端口>      **链接端口**：主控下发给客户端用的端口，默认取 --endpoint
                            的端口。两者相同时（多数情况）不用写。

国内节点加速：
  --github-proxy <前缀>      GitHub 加速前缀，例如 https://ghproxy.net/
                            （或环境变量 MCLINK_GITHUB_PROXY）
                            EasyTier 二进制按这个顺序取：本机已有 → 从主控下载 →
                            GitHub（国内建议加本参数，否则可能超时）。

可选：
  --name <名称>              节点显示名，默认取主机名
  --capacity-peers <n>       可承载的最大 peer 数，默认 500
  --tags <a,b>               逗号分隔的标签，最多 8 个
  --dir <路径>               安装目录，默认 /opt/mclink-node
  --interval <秒>            心跳间隔，默认 20
  --easytier-version <版本>  EasyTier 发行版本，默认 v2.6.4
  --agent-src <文件>         指定 agent.mjs 的来源路径（默认从主控下载）
  --source <目录>            源码目录（用于在 node.env 里记录文档路径，可省略）
  --skip-easytier            跳过 EasyTier 下载
  --no-ufw                   不修改 ufw 规则
  -h, --help                 显示本帮助
  --version                  显示脚本版本

说明：
  * 注册密钥是一次性的：安装成功后 agent 会把长期令牌写入 /etc/mclink/node-token.json，
    之后重启服务无需再次注册。可以放心把 MCLINK_NODE_ENROLL_KEY 从 node.env 中删掉。
  * 防火墙要放行的是**运行端口**（本机监听的那个）与对外映射端口，TCP 与 UDP 都要。
  * 典型的"一条命令"由管理台生成（控制台 → 中继节点 → 签发注册密钥），
    形如 `curl -fsSL <主控>/agent/install.sh | sudo bash -s -- ...`，无需先拿到本仓库。
EOF
}

# ---------------------------------------------------------------- 参数解析
while [[ $# -gt 0 ]]; do
  case "$1" in
    --master)            [[ $# -ge 2 ]] || die "--master 缺少参数"; MASTER="$2"; shift 2 ;;
    --key)               [[ $# -ge 2 ]] || die "--key 缺少参数"; ENROLL_KEY="$2"; shift 2 ;;
    --region)            [[ $# -ge 2 ]] || die "--region 缺少参数"; REGION="$2"; shift 2 ;;
    --endpoint)          [[ $# -ge 2 ]] || die "--endpoint 缺少参数"; ENDPOINT="$2"; shift 2 ;;
    --listen-port)       [[ $# -ge 2 ]] || die "--listen-port 缺少参数"; LISTEN_PORT="$2"; shift 2 ;;
    --connect-port)      [[ $# -ge 2 ]] || die "--connect-port 缺少参数"; CONNECT_PORT="$2"; shift 2 ;;
    --github-proxy)      [[ $# -ge 2 ]] || die "--github-proxy 缺少参数"; GITHUB_PROXY="$2"; shift 2 ;;
    --name)              [[ $# -ge 2 ]] || die "--name 缺少参数"; NODE_NAME="$2"; shift 2 ;;
    --capacity-peers)    [[ $# -ge 2 ]] || die "--capacity-peers 缺少参数"; CAPACITY_PEERS="$2"; shift 2 ;;
    --tags)              [[ $# -ge 2 ]] || die "--tags 缺少参数"; TAGS="$2"; shift 2 ;;
    --dir)               [[ $# -ge 2 ]] || die "--dir 缺少参数"; INSTALL_DIR="$2"; shift 2 ;;
    --interval)          [[ $# -ge 2 ]] || die "--interval 缺少参数"; HEARTBEAT_INTERVAL="$2"; shift 2 ;;
    --easytier-version)  [[ $# -ge 2 ]] || die "--easytier-version 缺少参数"; ET_VERSION="$2"; shift 2 ;;
    --agent-src)         [[ $# -ge 2 ]] || die "--agent-src 缺少参数"; AGENT_SRC="$2"; shift 2 ;;
    --source)            [[ $# -ge 2 ]] || die "--source 缺少参数"; SOURCE_DIR="$2"; shift 2 ;;
    --skip-easytier)     SKIP_EASYTier="true"; shift ;;
    --no-ufw)            NO_UFW="true"; shift ;;
    -h|--help)           usage; exit 0 ;;
    --version)           echo "install-node.sh ${SCRIPT_VERSION}"; exit 0 ;;
    *)                   printf '[错误] 未知参数: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- 基本校验
[[ "${EUID}" -eq 0 ]] || die "请用 root 运行：sudo bash deploy/install-node.sh ..."
[[ -n "$MASTER" ]] || die "缺少 --master"
[[ -n "$REGION" ]] || die "缺少 --region"
[[ -n "$ENDPOINT" ]] || die "缺少 --endpoint（形如 relay-sh.cnnic.link:11010）"

case "$MASTER" in
  http://*|https://*) : ;;
  *) die "--master 必须以 http:// 或 https:// 开头: $MASTER" ;;
esac
MASTER="${MASTER%/}"

# endpoint 允许只写主机名：端口交给 --connect-port / --listen-port
case "$ENDPOINT" in
  *:*) ENDPOINT_PORT="${ENDPOINT##*:}"
       [[ "$ENDPOINT_PORT" =~ ^[0-9]+$ ]] || die "--endpoint 端口必须是数字: $ENDPOINT"
       ;;
  *)   ENDPOINT_PORT="" ;;
esac
ENDPOINT_HOST="${ENDPOINT%%:*}"

# 端口优先级：显式给的 > endpoint 里的 > 默认 11010
CONNECT_PORT="${CONNECT_PORT:-$ENDPOINT_PORT}"
LISTEN_PORT="${LISTEN_PORT:-$CONNECT_PORT}"
CONNECT_PORT="${CONNECT_PORT:-11010}"
LISTEN_PORT="${LISTEN_PORT:-$CONNECT_PORT}"
for _p in "$LISTEN_PORT" "$CONNECT_PORT"; do
  [[ "$_p" =~ ^[0-9]+$ ]] || die "端口必须是数字: $_p"
  if (( _p < 1 || _p > 65535 )); then die "端口超出范围: $_p"; fi
done
unset _p
ENDPOINT="${ENDPOINT_HOST}:${CONNECT_PORT}"

# GitHub 加速前缀统一成"以 / 结尾"，避免用户写成 https://ghproxy.net 时拼出坏 URL
if [[ -n "$GITHUB_PROXY" ]]; then
  case "$GITHUB_PROXY" in
    http://*|https://*) : ;;
    *) die "--github-proxy 必须以 http:// 或 https:// 开头: $GITHUB_PROXY" ;;
  esac
  [[ "${GITHUB_PROXY}" == */ ]] || GITHUB_PROXY="${GITHUB_PROXY}/"
fi

case "$INSTALL_DIR" in
  /*) : ;;
  *) die "--dir 必须是绝对路径: $INSTALL_DIR" ;;
esac
INSTALL_DIR="${INSTALL_DIR%/}"
APP_DIR="${INSTALL_DIR}/app"
DATA_DIR="${INSTALL_DIR}/data"

case "$REGION" in
  cn-east|cn-south|cn-north|cn-central|cn-southwest|cn-northwest|cn-northeast|hk|oversea) : ;;
  auto) die "--region 不能是 auto：auto 只用于房间调度，节点必须落在具体区域" ;;
  *) warn "区域 '${REGION}' 不在内置列表中；主控若返回「未知区域」请改用内置区域" ;;
esac

if [[ -z "$NODE_NAME" ]]; then
  NODE_NAME="$(hostname -s 2>/dev/null || hostname)"
fi
NODE_NAME="${NODE_NAME:0:40}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 只在**确实存在**本地副本时才用本地的：
# 通过 `curl | sudo bash` 安装时同目录下不会有 agent.mjs，此时必须留空，
# 好让 install_agent() 走"从主控下载"的分支。
if [[ -z "$AGENT_SRC" && -f "${SCRIPT_DIR}/agent.mjs" ]]; then
  AGENT_SRC="${SCRIPT_DIR}/agent.mjs"
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- 发行版检查
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "debian" ]]; then
    warn "本脚本面向 Debian 12 编写，当前系统是 ${PRETTY_NAME:-未知}；继续执行，但请留意软件包名与 NodeSource 源"
  fi
fi

# ---------------------------------------------------------------- 依赖安装
apt_install() { apt-get install -y --no-install-recommends "$@" >/dev/null; }

install_base_packages() {
  log "更新软件包索引并安装基础依赖…"
  apt-get update -qq || die "apt-get update 失败：请检查网络与 /etc/apt/sources.list"
  # unzip：EasyTier 官方只发 zip，而 Debian 的 GNU tar 解不了 zip。
  # 以前这里漏了它、又用 tar 去解，于是"下载成功但二进制没落地"（实测踩过）。
  apt_install ca-certificates curl openssl tar unzip coreutils || die "基础依赖安装失败"
}

# 解 zip 包。GNU tar 不支持 zip，按可用工具依次退让；全都没有才失败。
extract_zip() {  # extract_zip <zip 文件> <目标目录>
  local zip="$1" dest="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -o -q "$zip" -d "$dest" && return 0
  fi
  if command -v bsdtar >/dev/null 2>&1; then
    bsdtar -xf "$zip" -C "$dest" && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$zip" "$dest" && return 0
  fi
  return 1
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then echo "0"; return 0; fi
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

node_ok() {
  local major
  major="$(node_major)"
  [[ "$major" =~ ^[0-9]+$ ]] || major=0
  (( major >= 22 ))
}

install_node_from_nodesource() {
  local major="$1" script
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
  local major
  for major in 24 22; do
    if install_node_from_nodesource "$major" && node_ok; then
      ok "Node.js 已安装: $(node -v)"
      return 0
    fi
    warn "通过 NodeSource 安装 Node.js ${major}.x 失败"
  done
  cat >&2 <<'EOF'
[错误] 无法自动安装 Node.js。
请手动处理其一后重试：
  1) curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  2) 确保 `node -v` >= v22.6
EOF
  exit 1
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
  mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR" "$LOG_DIR" "${APP_DIR}/vendor/easytier"
  chown -R "root:root" "$APP_DIR"
  # CONF_DIR 必须给 mclink 写权限：agent 以 mclink 身份运行，要把节点令牌
  # （/etc/mclink/node-token.json）写在这里。漏掉这一条会造成一个很隐蔽的故障：
  #   注册成功（一次性密钥被消耗）→ 令牌写不下 → 下次重启重新注册 → "密钥已被使用"
  #   → systemd 无限重启。实测踩过（restart counter 涨到 132）。
  chown -R "${RUN_USER}:${RUN_USER}" "$CONF_DIR" "$DATA_DIR" "$LOG_DIR"
  chmod 0750 "$CONF_DIR" "$DATA_DIR" "$LOG_DIR"
}

# ---------------------------------------------------------------- agent.mjs
install_agent() {
  local target="${APP_DIR}/agent.mjs"
  if [[ -f "$AGENT_SRC" ]]; then
    log "安装 agent: ${AGENT_SRC} → ${target}"
    install -m 0755 "$AGENT_SRC" "$target"
    return 0
  fi
  # 回退：从主控的静态目录下载（需要管理员把 agent.mjs 发布到 server/public/agent/）
  local url="${MASTER}/agent/agent.mjs"
  warn "本机没有找到 agent.mjs（${AGENT_SRC}），尝试从主控下载：${url}"
  if curl -fsSL -o "${target}.tmp" "$url" && [[ -s "${target}.tmp" ]]; then
    # 必须校验内容：前端 SPA 回退会把 index.html 以 200 返回，直接装上去会得到一个"HTML 版 agent"
    if grep -q '#!/usr/bin/env node' <(head -n1 "${target}.tmp"); then
      mv "${target}.tmp" "$target"
      chmod 0755 "$target"
      ok "已从主控下载 agent.mjs"
      return 0
    fi
    warn "主控返回的不是 agent.mjs（可能返回了前端页面），放弃使用"
  fi
  rm -f "${target}.tmp"
  die "无法获取 agent.mjs。请在主控上确认 deploy/agent.mjs 存在，并用 --agent-src 指定，或把它拷到本机后重试"
}

# ---------------------------------------------------------------- EasyTier
install_easytier() {
  local et_dir="${APP_DIR}/vendor/easytier"
  if [[ "$SKIP_EASYTier" == "true" ]]; then
    warn "--skip-easytier：跳过 EasyTier 安装"
    return 0
  fi

  # 1) 优先复用仓库自带的 Linux 产物（<repo>/deploy/vendor/linux-x86_64/，已被 gitignore）
  local seed=""
  for candidate in \
    "${SOURCE_DIR:-/nonexistent}/deploy/vendor/linux-x86_64" \
    "${SCRIPT_DIR}/vendor/linux-x86_64" \
    "${SCRIPT_DIR}/../deploy/vendor/linux-x86_64"
  do
    if [[ -f "${candidate}/easytier-core" ]]; then seed="$candidate"; break; fi
  done
  if [[ -n "$seed" ]]; then
    log "复用本机自带的 Linux 产物：${seed}"
    cp -f "${seed}/easytier-core" "${et_dir}/easytier-core"
    [[ -f "${seed}/easytier-cli" ]] && cp -f "${seed}/easytier-cli" "${et_dir}/easytier-cli" || true
  fi

  # 2) 其次从**主控**取：主控若带着 Linux 二进制（用 pack-server-source 打的源码包就有），
  #    国内节点就完全不需要碰 GitHub。没有则 404，继续往下走。
  if [[ ! -f "${et_dir}/easytier-core" || ! -f "${et_dir}/easytier-cli" ]]; then
    local from_master=0
    for pair in "easytier-core:/agent/easytier-core" "easytier-cli:/agent/easytier-cli"; do
      local bin="${pair%%:*}" path="${pair#*:}"
      [[ -f "${et_dir}/${bin}" ]] && continue
      if curl -fsSL --connect-timeout 10 --max-time 120 -o "${et_dir}/${bin}.tmp" "${MASTER}${path}"; then
        mv -f "${et_dir}/${bin}.tmp" "${et_dir}/${bin}"
        from_master=1
      else
        rm -f "${et_dir}/${bin}.tmp"
      fi
    done
    if (( from_master == 1 )); then
      ok "已从主控取得 EasyTier 二进制（无需访问 GitHub）"
    fi
  fi

  # 3) 最后才是 GitHub Releases，可加国内加速前缀（用 -f 而不是 -x：复制过来的文件可能还没可执行位）
  if [[ ! -f "${et_dir}/easytier-core" || ! -f "${et_dir}/easytier-cli" ]]; then
    local url tmp
    url="https://github.com/EasyTier/EasyTier/releases/download/${ET_VERSION}/easytier-linux-x86_64-${ET_VERSION}.zip"
    if [[ -n "$GITHUB_PROXY" ]]; then
      url="${GITHUB_PROXY}${url}"
      log "使用 GitHub 加速前缀：${GITHUB_PROXY}"
    fi
    tmp="$(mktemp -d)"
    log "下载 EasyTier ${ET_VERSION}：${url}"
    if curl -fL --retry 3 --connect-timeout 20 --retry-delay 3 -o "${tmp}/et.zip" "$url"; then
      if extract_zip "${tmp}/et.zip" "$tmp"; then
        local found
        found="$(find "$tmp" -type f -name 'easytier-core' | head -n1)"
        [[ -n "$found" ]] && cp -f "$found" "${et_dir}/easytier-core" || true
        found="$(find "$tmp" -type f -name 'easytier-cli' | head -n1)"
        [[ -n "$found" ]] && cp -f "$found" "${et_dir}/easytier-cli" || true
      else
        warn "EasyTier 压缩包解压失败（已尝试 unzip / bsdtar / python3）"
      fi
    else
      warn "EasyTier 下载失败（受限网络可设置 HTTPS_PROXY 后重试）"
    fi
    rm -rf "$tmp"
  fi

  chmod 0755 "${et_dir}"/* 2>/dev/null || true

  if [[ -f "${et_dir}/easytier-core" ]]; then
    ok "EasyTier 核心已就绪：${et_dir}/easytier-core"
    [[ -f "${et_dir}/easytier-cli" ]] || warn "缺少 easytier-cli：本节点将无法上报逐房间流量"
  else
    warn "没有可用的 easytier-core：服务可以启动并注册，但不会真的提供中继"
    warn "已尝试：本机自带产物 → 主控 /agent/ → GitHub Releases"
    if [[ -z "$GITHUB_PROXY" ]]; then
      warn "国内机器建议加 --github-proxy https://ghproxy.net/ 重跑（GitHub 直连常常超时）"
    else
      warn "已使用加速前缀 ${GITHUB_PROXY}，仍失败的话换一个前缀或改用 --source 指向本机已有产物"
    fi
  fi
  return 0
}

# ---------------------------------------------------------------- node.env
write_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    local backup
    backup="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$ENV_FILE" "$backup"
    log "已备份旧环境文件到 ${backup}"
  fi

  local old_umask
  old_umask="$(umask)"
  umask 077
  {
    echo "# mclink 子节点环境变量 —— 由 deploy/install-node.sh 生成于 $(date -Is)"
    echo "# 权限 600 / owner ${RUN_USER}。agent 首次注册成功后会把长期令牌写入"
    echo "# ${CONF_DIR}/node-token.json，此后可以删除下面的 MCLINK_NODE_ENROLL_KEY。"
    echo ""
    echo "# ---- 主控与节点身份 ----"
    echo "MCLINK_NODE_MASTER=${MASTER}"
    echo "MCLINK_NODE_ENROLL_KEY=${ENROLL_KEY}"
    echo "MCLINK_NODE_REGION=${REGION}"
    echo "MCLINK_NODE_ENDPOINT=${ENDPOINT}"
    echo "# 运行端口 = 本机 easytier-core 监听的端口；链接端口 = 主控下发给客户端的端口"
    echo "MCLINK_NODE_LISTEN_PORT=${LISTEN_PORT}"
    echo "MCLINK_NODE_CONNECT_PORT=${CONNECT_PORT}"
    echo "MCLINK_NODE_NAME=${NODE_NAME}"
    echo "MCLINK_NODE_CAPACITY_PEERS=${CAPACITY_PEERS}"
    [[ -n "$TAGS" ]] && echo "MCLINK_NODE_TAGS=${TAGS}"
    [[ -n "$HEARTBEAT_INTERVAL" ]] && echo "MCLINK_NODE_INTERVAL=${HEARTBEAT_INTERVAL}"
    echo ""
    echo "# ---- 本地路径 ----"
    echo "MCLINK_NODE_STATE_DIR=${CONF_DIR}"
    echo "MCLINK_NODE_LOG_DIR=${LOG_DIR}"
    echo "MCLINK_ET_CORE=${APP_DIR}/vendor/easytier/easytier-core"
    echo "MCLINK_ET_CLI=${APP_DIR}/vendor/easytier/easytier-cli"
    echo ""
    echo "# 留空则主控按请求来源 IP 记录；也可显式指定（多网卡 / NAT 场景）"
    echo "# MCLINK_NODE_PUBLIC_IP="
    echo "MCLINK_NODE_LOG_LEVEL=info"
  } > "$ENV_FILE"
  umask "$old_umask"

  chown "${RUN_USER}:${RUN_USER}" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  ok "环境文件已写入 ${ENV_FILE}（权限 600，owner ${RUN_USER}）"
}

# ---------------------------------------------------------------- systemd
install_unit() {
  local unit_src="${SCRIPT_DIR}/mclink-node.service"
  local node_bin tmp_unit
  if [[ ! -f "$unit_src" ]]; then
    # 常见情况：install-node.sh 被单独拷到目标机，单元文件不在旁边
    if [[ -f "${SOURCE_DIR:-/nonexistent}/deploy/mclink-node.service" ]]; then
      unit_src="${SOURCE_DIR}/deploy/mclink-node.service"
    elif [[ -f "${SCRIPT_DIR}/../deploy/mclink-node.service" ]]; then
      unit_src="$(cd "${SCRIPT_DIR}/../deploy" && pwd)/mclink-node.service"
    else
      # `curl | sudo bash` 装的时候本机必然没有这个文件 —— 从主控取。
      # 这一步和 agent.mjs 是同一个思路：脚本能自举，就不该要求先有仓库。
      tmp_unit="$(mktemp -d)/mclink-node.service"
      log "本机没有 mclink-node.service，从主控下载：${MASTER}/agent/mclink-node.service"
      if curl -fsSL --connect-timeout 10 --max-time 60 -o "$tmp_unit" "${MASTER}/agent/mclink-node.service" \
        && grep -q '^\[Unit\]' "$tmp_unit"; then
        unit_src="$tmp_unit"
      else
        rm -f "$tmp_unit"
        die "无法获取 mclink-node.service（本机没有、主控也没提供）。请把 deploy/mclink-node.service 放到本机后重试"
      fi
    fi
  fi
  node_bin="$(command -v node)"

  log "安装 systemd 单元到 ${UNIT_FILE}…"
  sed \
    -e "s#^User=.*#User=${RUN_USER}#" \
    -e "s#^Group=.*#Group=${RUN_USER}#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}#" \
    -e "s#^EnvironmentFile=.*#EnvironmentFile=${ENV_FILE}#" \
    -e "s#^ExecStart=.*#ExecStart=${node_bin} ${APP_DIR}/agent.mjs#" \
    -e "s#^ReadWritePaths=.*#ReadWritePaths=${CONF_DIR} ${LOG_DIR}#" \
    "$unit_src" > "$UNIT_FILE"
  chmod 0644 "$UNIT_FILE"

  systemctl daemon-reload
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "重启 ${SERVICE_NAME}…"
    systemctl restart "$SERVICE_NAME"
  else
    systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || warn "systemctl enable --now 失败，请手动检查"
  fi

  sleep 3
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
    log "未安装 ufw，跳过防火墙配置（请确认安全组已放行运行端口 ${LISTEN_PORT} TCP+UDP）"
    return 0
  fi
  if ! grep -q "Status: active" <(ufw status 2>/dev/null); then
    log "ufw 未启用，跳过防火墙配置（请确认安全组已放行运行端口 ${LISTEN_PORT} TCP+UDP）"
    return 0
  fi
  # 放行的是**运行端口**：本机 easytier-core 实际在它上面监听。
  # 对外那个端口由 NAT / 端口映射负责，本机防火墙管不到。
  log "为 ufw 放行运行端口 ${LISTEN_PORT}（对外链接端口 ${CONNECT_PORT}）…"
  ufw allow "${LISTEN_PORT}/tcp" comment 'mclink node relay tcp' >/dev/null 2>&1 || warn "ufw 放行 ${LISTEN_PORT}/tcp 失败"
  ufw allow "${LISTEN_PORT}/udp" comment 'mclink node relay udp' >/dev/null 2>&1 || warn "ufw 放行 ${LISTEN_PORT}/udp 失败"
  ok "已放行 ${LISTEN_PORT}（TCP+UDP）"
}

# ---------------------------------------------------------------- 汇总
print_summary() {
  cat >&2 <<EOF

${c_green}======================= mclink 子节点安装完成 =======================${c_reset}

  主控     : ${MASTER}
  节点名   : ${NODE_NAME}
  区域     : ${REGION}
  运行端口 : ${LISTEN_PORT}（本机 easytier-core 监听；ufw/安全组要放行它，TCP+UDP）
  链接端口 : ${CONNECT_PORT}（主控下发给客户端的端口；NAT/映射后的对外端口）
  公网地址 : ${ENDPOINT}
  安装目录 : ${INSTALL_DIR}
  环境变量 : ${ENV_FILE}
  服务     : ${SERVICE_NAME}（systemd，已设为开机自启）

后续步骤：
  1) 看日志        : journalctl -u ${SERVICE_NAME} -f
  2) 已在管理台「节点」页看到该节点从 pending 变成 online 即接入成功
  3) 令牌就绪后可清理一次性密钥：
       sudo sed -i 's/^MCLINK_NODE_ENROLL_KEY=.*/MCLINK_NODE_ENROLL_KEY=/' ${ENV_FILE}
       sudo systemctl restart ${SERVICE_NAME}
  4) 两个端口不同时（NAT/端口映射），请自行确认外部 ${CONNECT_PORT} → 本机 ${LISTEN_PORT} 的映射规则
  5) 排障          : 参见主控上的 docs/troubleshooting.md 与 docs/deployment.md
EOF
}

# ---------------------------------------------------------------- 主流程
main() {
  log "mclink 子节点安装脚本 ${SCRIPT_VERSION} 开始（${NODE_NAME} → ${MASTER}）"

  install_base_packages
  ensure_node
  ensure_user
  prepare_dirs
  install_agent
  install_easytier
  write_env_file
  install_unit
  configure_firewall
  print_summary
}

main "$@"
