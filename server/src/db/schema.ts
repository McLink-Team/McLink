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

export const MIGRATIONS: readonly string[] = [V1_INITIAL, V2_RELAY_ROOM_MAP, V3_ROOM_ACCESS_LOG];

export const SCHEMA_VERSION = MIGRATIONS.length;
