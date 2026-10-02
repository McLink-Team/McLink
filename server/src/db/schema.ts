/**
 * 数据库迁移表。
 *
 * 规则：只允许在数组末尾追加新元素，禁止修改已发布的语句——
 * 已部署实例靠 PRAGMA user_version 判断进度。
 */

const V1_INITIAL = `
create table if not exists users (
  id              text primary key,
  username        text not null unique,
  display_name    text not null,
  password_hash   text not null,
  role            text not null default 'user',
  banned          integer not null default 0,
  email           text,
  quota_bytes     integer,
  used_bytes      integer not null default 0,
  max_rooms       integer,
  created_at      text not null,
  updated_at      text not null
);
create index if not exists idx_users_username on users(username);

create table if not exists sessions (
  id            text primary key,
  user_id       text not null references users(id) on delete cascade,
  token_hash    text not null unique,
  created_at    text not null,
  expires_at    text not null,
  last_seen_at  text,
  ip            text,
  user_agent    text
);
create index if not exists idx_sessions_user on sessions(user_id);
create index if not exists idx_sessions_expires on sessions(expires_at);

create table if not exists enroll_keys (
  key         text primary key,
  note        text,
  created_by  text,
  created_at  text not null,
  used_at     text,
  used_by     text,
  revoked     integer not null default 0
);

create table if not exists relay_nodes (
  id              text primary key,
  name            text not null,
  region          text not null,
  endpoint        text not null,
  public_ip       text,
  status          text not null default 'pending',
  version         text,
  capacity_peers  integer not null default 500,
  peers           integer not null default 0,
  rooms           integer not null default 0,
  rx_bps          integer not null default 0,
  tx_bps          integer not null default 0,
  weight          integer not null default 100,
  tags            text not null default '[]',
  token_hash      text not null,
  last_seen_at    text,
  created_at      text not null,
  disabled        integer not null default 0,
  config_revision integer not null default 0
);
create index if not exists idx_nodes_region on relay_nodes(region);
create index if not exists idx_nodes_status on relay_nodes(status);

create table if not exists rooms (
  id              text primary key,
  code            text not null unique,
  name            text not null,
  host_user_id    text not null references users(id) on delete cascade,
  status          text not null default 'open',
  access          text not null default 'open',
  visibility      text not null default 'public',
  zone            text not null default 'auto',
  relay_node_ids  text not null default '[]',
  policy          text not null default '{}',
  network_name    text not null unique,
  network_secret  text not null,
  subnet          text not null,
  subnet_slot     integer not null,
  password_hash   text,
  online_members  integer not null default 0,
  member_count    integer not null default 0,
  acl_revision    integer not null default 1,
  created_at      text not null,
  expires_at      text,
  closed_at       text,
  last_active_at  text not null
);
create index if not exists idx_rooms_host on rooms(host_user_id);
create index if not exists idx_rooms_status on rooms(status);
create index if not exists idx_rooms_slot on rooms(subnet_slot);

create table if not exists room_members (
  room_id       text not null references rooms(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  role          text not null default 'member',
  status        text not null default 'active',
  virtual_ip    text,
  seat          integer,
  device_name   text,
  latency_ms    real,
  p2p           integer not null default 0,
  rx_bps        integer not null default 0,
  tx_bps        integer not null default 0,
  joined_at     text not null,
  last_seen_at  text,
  primary key (room_id, user_id)
);
create index if not exists idx_members_user on room_members(user_id);
create index if not exists idx_members_room on room_members(room_id);

create table if not exists traffic_samples (
  id          integer primary key autoincrement,
  ts          text not null,
  scope       text not null,
  scope_id    text not null,
  room_id     text,
  rx_bytes    integer not null default 0,
  tx_bytes    integer not null default 0,
  rx_bps      integer not null default 0,
  tx_bps      integer not null default 0,
  peers       integer not null default 0
);
create index if not exists idx_traffic_scope on traffic_samples(scope, scope_id, ts);
create index if not exists idx_traffic_ts on traffic_samples(ts);

create table if not exists room_usage (
  room_id     text primary key references rooms(id) on delete cascade,
  rx_bytes    integer not null default 0,
  tx_bytes    integer not null default 0,
  peers       integer not null default 0,
  updated_at  text not null
);

create table if not exists audit_log (
  id           integer primary key autoincrement,
  ts           text not null,
  actor_type   text not null,
  actor_id     text,
  actor_name   text,
  action       text not null,
  target_type  text,
  target_id    text,
  detail       text,
  ip           text
);
create index if not exists idx_audit_ts on audit_log(ts);
create index if not exists idx_audit_action on audit_log(action);

create table if not exists settings (
  key         text primary key,
  value       text not null,
  updated_at  text not null
);

create table if not exists meta (
  key   text primary key,
  value text not null
);
`;

const V2_RELAY_ROOM_MAP = `
create table if not exists relay_room_traffic (
  network_name  text primary key,
  room_id       text,
  peer_count    integer not null default 0,
  rx_bytes      integer not null default 0,
  tx_bytes      integer not null default 0,
  rx_bps        integer not null default 0,
  tx_bps        integer not null default 0,
  last_seen_at  text
);
create index if not exists idx_relay_room_traffic_room on relay_room_traffic(room_id);
`;

const V3_ROOM_ACCESS_LOG = `
create table if not exists room_access_log (
  id         integer primary key autoincrement,
  ts         text not null,
  room_id    text not null,
  user_id    text,
  action     text not null,
  detail     text,
  ip         text
);
create index if not exists idx_room_access_room on room_access_log(room_id, ts);
`;

const V4_ROOM_CHAT = `
create table if not exists room_messages (
  id          integer primary key autoincrement,
  room_id     text not null references rooms(id) on delete cascade,
  user_id     text,
  display_name text not null,
  role        text not null default 'member',
  kind        text not null default 'text',
  body        text not null,
  created_at  text not null
);
create index if not exists idx_room_messages_room on room_messages(room_id, id);
create index if not exists idx_room_messages_ts on room_messages(created_at);
`;

const V5_EMAIL_VERIFICATION = `
alter table users add column email_verified integer not null default 0;

/* 一个邮箱只能绑一个账号（历史账号 email 为 null，部分索引正好跳过它们） */
create unique index if not exists idx_users_email on users(email) where email is not null;

/* 验证码：只存 sha256，不存明文；consumed_at 非空表示已用过 */
create table if not exists email_codes (
  id          text primary key,
  user_id     text not null references users(id) on delete cascade,
  email       text not null,
  code_hash   text not null,
  purpose     text not null default 'verify',
  attempts    integer not null default 0,
  created_at  text not null,
  expires_at  text not null,
  consumed_at text
);
create index if not exists idx_email_codes_user on email_codes(user_id, created_at);
create index if not exists idx_email_codes_email on email_codes(email, created_at);

/*
 * 历史上没有邮箱的账号（管理员建号、早期玩家）：
 * 它们没有可验证的地址，因此不标记为已验证 —— email_verified 只表示"真的验证过"，
 * 这样"是否验证"这件事在库里只有一个含义，不会出现"标记为已验证但其实没验过"的脏数据。
 *
 * 它们在开关打开时会被门禁挡住（见 services/email-gate.ts 的说明），
 * 解法是让这些账号自己绑一次邮箱，或由管理员关掉开关。
 * 这一条 UPDATE 只是把不变量写实：没邮箱的账号不该处于"已验证"状态。
 */
update users set email_verified = 0 where email is null;
`;

/**
 * 子节点的「运行端口」与「链接端口」分离。
 *
 * 为什么需要分开：节点常常在 NAT / Docker 端口映射后面——本机只能绑 11010，
 * 但对外只开放 21010（或者机房只允许某几个端口对外）。此前两者是同一个端口，
 * 于是这种部署要么连不上，要么得改节点本地配置。
 *
 *   listen_port  —— 运行端口：子节点 easytier-core 实际 bind 的端口，由主控下发的安装命令指定
 *   connect_port —— 链接端口：主控下发给客户端用于连接的公网端口
 *   endpoint     —— 仍然表示面向客户端的 `host:connect_port`
 *
 * 回填策略：老节点两个端口都取原 endpoint 的端口，行为与之前完全一致。
 */
const V6_NODE_PORT_SPLIT = `
alter table relay_nodes add column listen_port integer;
alter table relay_nodes add column connect_port integer;

update relay_nodes
   set listen_port = coalesce(listen_port, cast(substr(endpoint, instr(endpoint, ':') + 1) as integer)),
       connect_port = coalesce(connect_port, cast(substr(endpoint, instr(endpoint, ':') + 1) as integer))
 where instr(endpoint, ':') > 0;
`;

/**
 * V7：把「品牌改名」之前留在库里的默认值一次性改过来。
 *
 * 平台设置是**首次启动时写进库**的，之后代码里的默认值再改也不会影响老库：
 * 老部署的登录页、验证邮件标题会一直显示 `mclink 联机`。
 * 这里只改「等于旧默认值」的行——管理员自己填过的名字不会被覆盖；
 * 下载地址同理，旧默认指向的 `mclink-client-setup.exe` 是从来不存在过的文件名。
 */
const V7_BRAND_DEFAULTS = `
update settings
   set value = json_set(value, '$.siteName', 'McLink 联机'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.siteName') = 'mclink 联机';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-0.1.0-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/mclink-client-setup.exe';
`;


/**
 * V8：客户端版本升到 1.0.0（首个正式版）。
 *
 * 只改**还停在旧默认值**的部署：管理员手工改过版本/地址的（比如自建下载源）
 * 一律不动 —— 迁移不该覆盖人的选择。
 * 不改的话，线上主控会一直对外宣称 0.1.0，玩家永远收不到「有新版本」提示。
 */
const V8_CLIENT_1_0_0 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.0'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '0.1.0';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.0-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-0.1.0-x64.exe';
`;

/**
 * V9：客户端版本 1.0.0 → 1.0.1。
 *
 * 迁移纪律：**已发布过的迁移不能改**（V8 已经在部署上跑过，user_version=8），
 * 升级只能追加一条新的。同样只动"还停在上一版默认值"的部署，
 * 管理员手改过版本/下载地址的一律不碰。
 */
const V9_CLIENT_1_0_1 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.1'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.0';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.1-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.0-x64.exe';
`;

/**
 * V10：邮件退订开关。
 *
 * 群发公告必须带可用的退订入口（合规要求，也直接影响域名送达率）。
 * 默认 0 = 正常接收：公告是玩家主动选择的平台通知，不该默认把人静音。
 */
const V10_EMAIL_OPT_OUT = `
alter table users add column email_opt_out integer not null default 0;
`;

/**
 * V11：站点简介不再写成"我的世界专用"。
 *
 * 平台本来就支持各类局域网联机游戏，简介写成《我的世界》专用等于把其它游戏的玩家
 * 挡在门外（搜索结果里的摘要也一直是这句话）。同 V8/V9 的纪律：
 * 只动**还停在上一版默认值**的部署，管理员自己改过简介的一律不碰。
 */
const V11_TAGLINE_ALL_GAMES = `
update settings
   set value = json_set(value, '$.siteTagline', '基于 EasyTier 的局域网联机平台，支持《我的世界》等各类局域网联机游戏'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.siteTagline') = '基于 EasyTier 的《我的世界》联机平台 —— 单端口、低延迟、开箱即用';
`;

/**
 * V12：`users.last_seen_at` —— 群发公告要能按「最近 N 天活跃」挑收件人。
 *
 * 为什么不直接读 `sessions.last_seen_at`：会话是登出/过期就删的，
 * 活跃度会莫名其妙"变旧"（一个昨天还在玩、今天退出了登录的人，看起来像从没来过）。
 * 挂在用户行上才是持久的，也不受会话保留期影响。
 */
const V12_USER_LAST_SEEN = `
alter table users add column last_seen_at text;
create index if not exists idx_users_last_seen on users(last_seen_at);
`;

/**
 * V13：`relay_nodes.capacity_bps` —— 节点的带宽上限（bit/s），供调度打分用。
 *
 * 为什么要有它：只看 peer 数是错的 —— 200 个 peer 的节点和 5 个 peer 但跑满 5Mbps 的节点，
 * 后者才是真的顶不住。0 = 不限（只用人数维度），与 `relayBandwidthKbps` 的约定一致。
 * 由管理员在控制台按节点填（云厂商给的是"5 Mbps BGP"这种口径），不做自动探测。
 */
const V13_NODE_CAPACITY_BPS = `
alter table relay_nodes add column capacity_bps integer not null default 0;
`;

/**
 * V14：`rooms.ttl_minutes` —— 房间自己的存活时长。
 *
 * 为什么要存：到期时间现在会**随活跃顺延**（心跳把 expires_at 往后推），
 * 于是"expires_at − created_at"不再是房间的 TTL，推不出该顺延多久。
 * 不存的话就只能用平台当前默认值硬推 —— 房主建房时把 TTL 下调到 2 小时的房间，
 * 会被心跳悄悄拉回 12 小时，那是改用户的选择。
 *
 * 存量房间：只有还开着的会用到这个值，按此刻的平台默认值回填即可。
 */
const V14_ROOM_TTL = `
alter table rooms add column ttl_minutes integer;
update rooms set ttl_minutes = (
  select json_extract(value, '$.roomTtlMinutes') from settings where key = 'platform'
) where status = 'open' and ttl_minutes is null;
`;

/**
 * V15：客户端版本 1.0.1 → 1.0.2。
 *
 * 沿用 V8/V9 的纪律：只动"还停在上一版默认值"的部署，管理员手改过版本或下载地址的一律不碰。
 * 1.0.2 是纯客户端修复（WS 重连加抖动、GPU 进程崩溃后自动降级软件渲染），
 * 主控侧只需要把对外宣称的版本与下载地址推上去 —— 客户端靠它提示"有新版本"。
 */
const V15_CLIENT_1_0_2 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.2'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.1';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.2-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.1-x64.exe';
`;

/**
 * V16：客户端版本 1.0.2 → 1.0.3。
 *
 * 1.0.2 是"本地编译好、还没上线"的那一版，1.0.3 在它基础上加了两处**客户端**改动：
 *   · 未以管理员身份启动时**直接弹窗**（文案写明「右键 → 以管理员身份运行」），
 *     关掉后保留常驻横幅；
 *   · 权限判定不再只看完整性级别：`runas /trustlevel:0x20000` 这类**受限令牌**下
 *     级别仍是 High，但建不出虚拟网卡 —— 以前界面会显示"已以管理员身份运行，虚拟网卡可用"，
 *     把人引到完全错误的方向；现在会明确说出原因。
 *   · 核心异常退出时，错误信息里带上核心日志的最后一行（以前只有一个退出码，没法排查）。
 *
 * 纪律同 V8/V9/V15：只动"还停在上一版默认值"的部署，管理员手改过的一律不碰。
 * 从更老的版本升上来的实例会依次跑 V15 → V16，最终都落在 1.0.3。
 */
const V16_CLIENT_1_0_3 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.3'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.2';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.3-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.2-x64.exe';
`;

/**
 * V17：客户端版本 1.0.3 → 1.0.4。
 *
 * 1.0.3 修的是"管理员判定"（不再只看完整性级别，改成问 IsInRole），但用户装上后复测发现
 * **「以管理员身份重启」按钮点了没反应**：打包版没有额外参数，命令被拼成
 * `Start-Process -FilePath '…' -ArgumentList  -Verb RunAs`（空值），PowerShell 直接报
 * `Missing an argument for parameter 'ArgumentList'` 并以 1 退出 —— 既不弹授权框也没有任何提示。
 * 开发版带着入口参数，所以这条路径一直没被走到，之前的验证也就没发现。
 *
 * 1.0.4 = 1.0.3 的全部内容 + 这个修复，并且这条路径现在**按打包形态做了真点击实测**。
 * 纪律同前：只动"还停在上一版默认值"的部署，管理员手改过的一律不碰；
 * 从更老的版本升上来会依次跑 V15 → V16 → V17，最终都落在 1.0.4。
 */
const V17_CLIENT_1_0_4 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.4'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.3';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.4-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.3-x64.exe';
`;
/**
 * V18：客户端版本 1.0.4 → 1.0.5。
 *
 * 1.0.5 是**外观与交互的一次大改**（客户端换成「暖纸台」世界：横向外壳 + 左图标栏 +
 * 链路牌首页；房间页两栏；原生确认框换应用内模态；设置页新增「账号」分区可以改昵称/密码/邮箱）。
 * 功能上还修了几处真问题：在线中继数被 `auto` 伪区域算了两遍（7 显示成 14）、
 * 关客户端时主进程抛 `Object has been destroyed`（easytier-core 比窗口晚退出，
 * 往已销毁的 webContents 发消息）、成员"离线"误报（首次心跳前 lastSeenAt 为 null）、
 * `.btn-danger` 在新世界里被 `.btn` 盖掉根本不红。
 *
 * 纪律同前：只动"还停在上一版默认值"的部署，管理员手改过的一律不碰；
 * 从更老的版本升上来会依次跑 V15 → V16 → V17 → V18，最终都落在 1.0.5。
 */
const V18_CLIENT_1_0_5 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.5'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.4';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.5-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.4-x64.exe';
`;
/**
 * V19：客户端版本 1.0.5 → 1.0.6。
 *
 * 1.0.6 只有一个主题：**把「P2P 直连质量差」这件事从看不见变成能处理**。
 * 打洞成功不等于链路可用 —— 家里宽带到对端那一段拥塞时延迟看着正常（20ms），
 * 但丢包会让游戏里人物回弹。EasyTier 一直在算这个数（`peer list` 的 `loss_rate`），
 * 客户端以前只是没读它。这一版：
 *   · 房间页「连接路径」每一行、连接诊断的每个节点行都显示丢包率（拿不到显示「—」）；
 *   · 丢包 >5% 时房间里给一句话提示 + 一个「强制走中继」按钮；
 *   · 打开开关 = 往票据 TOML 注入 `disable_p2p = true` 并重启本地核心（**不动主控**，
 *     这是本机偏好，按房间存在客户端本地，重启客户端后仍生效）；
 *   · 设置里可选「P2P 丢包时自动切到中继」（**默认关**，带迟滞、A/B 对照与指数退避重试）。
 *
 * 纪律同前：只动"还停在上一版默认值"的部署，管理员手改过的一律不碰；
 * 从更老的版本升上来会依次跑 V15 → V16 → V17 → V18 → V19，最终都落在 1.0.6。
 */
const V19_CLIENT_1_0_6 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.6'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.5';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.6-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.5-x64.exe';
`;
/**
 * V20：客户端版本 1.0.6 → 1.0.7。
 *
 * 1.0.7 只改了一件事，但改在玩家每天都会碰到的地方：**建房页那一列的延迟读数**。
 * 以前是 ICMP ping（调系统 `ping` 再正则解析输出），现在是对中继**链接端口**做一次
 * TCP 握手（tcping）。原因：ICMP 只证明主机活着，而玩家要连的是那个端口 ——
 * 线上两种误判都出现过（主机屏蔽 ICMP 却完全可用；ICMP 12ms 但端口被安全组挡着）。
 * 界面文案与降级行为不变：测不到仍然显示「—」，仍然只用于展示与排序。
 *
 * 顺带说明为什么这个迁移只动版本号：这次没有任何**库结构**变化
 * （`relay_nodes` 的 listen_port / connect_port 早在 V6 就有了），
 * 需要迁移的只是"平台对外宣称的客户端版本与下载地址"。
 *
 * 纪律同前：只动"还停在上一版默认值"的部署，管理员手改过的一律不碰；
 * 从更老的版本升上来会依次跑 V15 → … → V20，最终都落在 1.0.7。
 */
const V20_CLIENT_1_0_7 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.7'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.6';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.7-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.6-x64.exe';
`;
/**
 * V21：客户端版本 1.0.7 → 1.0.8。
 *
 * 1.0.8 改的是**中继调度**，不是界面：主控不再无条件当"兜底中继"，
 * 每个房间下发 2 台**不同子节点**（主中继 + 兜底中继），节点列表里不再混进主控自己。
 * 挑选顺序：硬过滤（在线/容量/白名单）→ 权重降序 → 客户端上报延迟升序
 * （并列带 20ms 收到 5ms，档内先比**空余带宽** 1−利用率）→ 兜底再避开主中继那台。
 *
 * 为什么这条迁移值得写清楚：以前"区域没节点也能建房"靠的就是主控兜底，
 * 而现在**一个可调度子节点都没有就明确 503**（文案：「当前没有可用的中继节点，暂时无法建房」）。
 * 单机部署想让主控参与转发，得把主控注册成一台普通子节点（见 docs/deployment.md）。
 * 配套的客户端改动：延迟探测改到初始化时一次性做完（建房时直接读缓存，不再等）。
 *
 * 这次同样没有**库结构**变化，迁移只负责"平台对外宣称的客户端版本与下载地址"；
 * 纪律同前：只动"还停在上一版默认值"的部署，管理员手改过的一律不碰。
 */
const V21_CLIENT_1_0_8 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.8'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.7';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.8-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.7-x64.exe';
`;
/**
 * V22：流量账本（分钟桶 + **增量**口径）。
 *
 * 为什么需要一张新表：`traffic_samples` 存的是**采样瞬间的累计计数器与瞬时速率**
 * （中继/节点侧 `peer list-foreign` 的 rx_bytes/tx_bytes 是从该实例启动算起的累计值），
 * 于是：
 *   · 「累计流量」只能靠 `max(rx_bytes)` 猜，中继一重启就失真（线上主控中继起不来时读到 0）；
 *   · 一个房间被两台节点同时转发时，两边的累计值互相覆盖（`room_usage` 以前是覆盖写）；
 *   · 用户维度根本没地方落库（`users.used_bytes` 从来没有写入方，一直是 0）。
 * 结果就是控制台的「今日累计 / 累计流量 / 用户用量」全都不可用。
 *
 * 这张表按**分钟桶 + 维度**记录**增量**（`+=` 累加），维度是 platform / room / node / user：
 *   · 增量由 `services/traffic-ledger.ts` 的会计模块算出（前后两次采样相减；
 *     计数器回退 = 该实例重启过，按"本次值即增量"处理）；
 *   · 于是重启不丢历史、多源可相加、按天/按月既能求和也能画字节曲线；
 *   · `bucket`/`day` 用**服务器本地时间** —— 界面上「自然日 00:00 起」就是本地时间的语义。
 *
 * 保留期比采样长得多（默认 400 天）：曲线看近几小时，账本看月/年。
 */
const V22_TRAFFIC_LEDGER = `
create table if not exists traffic_ledger (
  bucket      text    not null,
  day         text    not null,
  scope       text    not null,
  scope_id    text    not null,
  room_id     text,
  user_id     text,
  node_id     text,
  rx_bytes    integer not null default 0,
  tx_bytes    integer not null default 0,
  updated_at  text    not null,
  primary key (bucket, scope, scope_id)
);

create index if not exists idx_ledger_day_scope on traffic_ledger(day, scope);
create index if not exists idx_ledger_room on traffic_ledger(room_id, day);
create index if not exists idx_ledger_user on traffic_ledger(user_id, day);
create index if not exists idx_ledger_node on traffic_ledger(node_id, day);

-- 旧口径的房间累计流量是"某个来源重启以来的累计值"（覆盖写），换算不出真实总量，
-- 账本从 0 开始更有意义（房间与用户的其它历史数据不受影响）。
delete from room_usage;
`;
/**
 * V23：节点角色 —— 「只协助打洞」。
 *
 * 带宽很少的机器不该扛房间流量。`assist_only = 1` 的节点在生成配置时会写
 * `disable_relay_data = true`：它照样是房间里的一个 peer（两端通过它交换公网地址、
 * 协调打洞），但 OSPF 会给它的中继链路一个极大代价，**数据不会落到它身上**。
 *
 * 于是房间的两个槽位有了明确分工（见 `RoomService.#pickRelays`）：
 *   槽 1 = 打洞节点（优先从 assist_only 里选），槽 2 = 中继节点（真正承载数据的那台，
 *   从"大带宽档"里按**客户端实测延迟**优先挑）。因为槽 1 不转发数据，
 *   "客户端走中继时用哪台"这件事就由结构决定，不需要客户端配合。
 */
const V23_NODE_ASSIST_ONLY = `
alter table relay_nodes add column assist_only integer not null default 0;
`;
/**
 * V24：客户端版本 1.0.8 → 1.0.9（**主控版本线同时并到 1.0.9**）。
 *
 * 1.0.9 是一次"中继模型"的换代，玩家能感知的有四件事：
 *   1. 每个房间两台中继分成两个槽位：**槽 1 = 打洞节点**（只协调 P2P 打洞，不承载数据）、
 *      **槽 2 = 中继节点**（真正转发房间流量）；客户端房间页按票据顺序标「打洞节点 / 中继节点」。
 *   2. 中继槽从「大带宽档」（默认 ≥10 Mbps；没填带宽上限也算）里挑，**权重优先、权重一致才比延迟**；
 *      小带宽节点利用率到 **80%** 就停止新增中继（大带宽节点仍是 90%），只挡新房间。
 *   3. 房间中继过载时，主控会把中继槽换成更空的大带宽节点，并给房里的客户端推一条
 *      **建议**（`room.relayHint`）—— **不自动切**，玩家自己决定（切一次要重建隧道、卡几秒）。
 *   4. 流量统计修好了：「今日/本月/累计」与「按用户用量」改成真增量累加
 *      （新增 `traffic_ledger`，见 V22），重启不再归零。
 * 部署侧：主控不再自带中继实例（转发全部下沉到子节点）。
 *
 * 纪律同前：只动"还停在上一版默认值"的部署，管理员手改过的一律不碰；
 * 从更老的版本升上来会依次跑 V21 → V24，最终都落在 1.0.9。
 */
const V25_MEMBER_RELAY_NODE = `
alter table room_members add column relay_node_id text;
`;

const V24_CLIENT_1_0_9 = `
update settings
   set value = json_set(value, '$.clientVersion', '1.0.9'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientVersion') = '1.0.8';

update settings
   set value = json_set(value, '$.clientDownloadUrl', '/downloads/McLink-Setup-1.0.9-x64.exe'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 where key = 'platform'
   and json_extract(value, '$.clientDownloadUrl') = '/downloads/McLink-Setup-1.0.8-x64.exe';
`;
export const MIGRATIONS: readonly string[] = [
  V1_INITIAL,
  V2_RELAY_ROOM_MAP,
  V3_ROOM_ACCESS_LOG,
  V4_ROOM_CHAT,
  V5_EMAIL_VERIFICATION,
  V6_NODE_PORT_SPLIT,
  V7_BRAND_DEFAULTS,
  V8_CLIENT_1_0_0,
  V9_CLIENT_1_0_1,
  V10_EMAIL_OPT_OUT,
  V11_TAGLINE_ALL_GAMES,
  V12_USER_LAST_SEEN,
  V13_NODE_CAPACITY_BPS,
  V14_ROOM_TTL,
  V15_CLIENT_1_0_2,
  V16_CLIENT_1_0_3,
  V17_CLIENT_1_0_4,
  V18_CLIENT_1_0_5,
  V19_CLIENT_1_0_6,
  V20_CLIENT_1_0_7,
  V21_CLIENT_1_0_8,
  V22_TRAFFIC_LEDGER,
  V23_NODE_ASSIST_ONLY,
  V24_CLIENT_1_0_9,
  /**
   * V25：**成员级中继分配**（`room_members.relay_node_id`）。
   *
   * 背景：EasyTier 的 avoid-relay 惩罚只对"同网 peer"可靠，对"代转外来网络的 public server"
   * 约一半的运行失效且不自愈（复现见 `scripts/repro-easytier-avoid-relay.mjs`）——
   * 所以"哪台承载"不再交给它选路，改由调度在**票据**上定死（见 `docs/relay-assignment.md`）：
   *   · 房主 → **全部可调度节点**（每台都有一条直达房主的链路，成员分配怎么变都不用动房主）；
   *   · 成员 → **只有分配给他的那一台**（到房主的路只有一条）。
   * 老数据为 NULL = 用房间默认（`rooms.relay_node_ids[0]`），行为与改造前一致。
   */
  V25_MEMBER_RELAY_NODE,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
