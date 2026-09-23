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
];

export const SCHEMA_VERSION = MIGRATIONS.length;
