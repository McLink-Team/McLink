#!/usr/bin/env node
/**
 * 「建房自动选中继」的针对性验收脚本（回归工具，一次跑完，共两段）。
 *
 * 现行调度语义（2026-09-27 改动之后的完整版，脚本按它断言）：
 *   硬过滤（离线/停用/权重 0/无余量）→ ① weight 降序 → ② 同权重才比延迟，
 *   延迟落在**同一段区间（极差 ≤5ms）**内则先比**空余带宽** `1 − utilization`、
 *   再比 `relayScore`、最后比 `peers`；没上报延迟的节点永远排最后。
 *   `max = 2` → 前两名 = **主中继 + 兜底中继**（两个**不同**子节点）。
 *   主控不再自动兜底：票据里的中继**只**来自 `relay_nodes` 的可调度子节点，
 *   要让它参与就得把主控注册成一台普通子节点。
 *
 * 跑法（Node ≥ 22.6：用到内置的 TS 类型剥离，所以能直接 import server 的 .ts 源码）：
 *   node scripts/check-latency-priority.mjs               # 两段都跑（需要本机主控，见下）
 *   node scripts/check-latency-priority.mjs --pure-only   # 只跑第一段（不需要主控/数据库）
 *
 *   第一段（纯函数，**不需要主控在跑**）：直接 import `server/src/services/rooms.ts`，钉住与
 *   「档内排序」有关的规则 —— 并列带 5ms（区间极差）/ 档内先比空余带宽 / 权重仍是主键 /
 *   没上报延迟的节点排最后。利用率是构造出来的显式入参（服务端采样后就是同一个入参，
 *   见 RoomService.scheduleRelays）。
 *
 *   第二段（真接口，需要**本机主控在 8787 上跑着**（`pnpm --filter @mclink/server dev`）
 *   + 开发库 `server/data/mclink.sqlite`）：
 *   1. 注册一个临时验证账号建房 —— admin 名下的配额被已有房间占着，不去动别人的房间。
 *   2. 往 `relay_nodes` 插两条**同区域、都可用**的测试节点（id 固定为 zz_lat_slow / zz_lat_fast）：
 *        zz_lat_slow —— weight 200（打分更高）
 *        zz_lat_fast —— weight 100
 *      `capacity_bps` 都是 0（不限带宽 → 内存 EWMA 利用率恒为 0，打分只由 weight 与人头决定）；
 *      每条用例开始前刷新 `last_seen_at`，免得 15 秒一次的健康检查把它们判成离线。
 *   3. 逐条建房并用响应里的 `nodeSelection` / `room.relayNodeIds` / `ticket.relays` 断言：
 *        · **票据里不再出现主控自身中继**（`nodeId = 'master'`）—— 2026-09-27 取消主控固定兜底；
 *        · 自动模式下每房 **2 个不同子节点**（主中继 + 兜底中继），票里也没有多余条目；
 *        · 延迟提示只在**同权重**时决定谁当主中继；权重不同时权重说了算（现行语义）；
 *        · 硬条件（weight/停用/离线/满员/区域）一条都不放松；
 *        · 一个可调度节点都没有时，建房**明确报错**（503 +「当前没有可用的中继节点」）。
 *      同时把服务端 `audit_log` 里落库的 `relayNodeIds` 打出来当证据。
 *   4. **会临时写开发库，但会自己清干净**（`try/finally` 保证失败也会跑）：删测试节点、测试账号
 *      （级联删房间/会话/成员）、本次房间的 chat/usage/access_log/relay_room_traffic 与审计行。
 *      真接口段只碰上面这些行，但跑之前仍建议先备份 `server/data/mclink.sqlite`。
 *
 * 环境变量：`MCLINK_MASTER`（默认 `http://127.0.0.1:8787`）、
 *   `MCLINK_ADMIN_PASSWORD`（默认 `dev-only-passw0rd`）、
 *   `MCLINK_DB_FILE`（默认 `<仓库>/server/data/mclink.sqlite`）。
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  LATENCY_TIE_BAND_MS,
  freeBandwidth,
  relayScore,
  selectRelays,
} from '../server/src/services/rooms.ts';

/** 主控地址（可用 `MCLINK_MASTER` 覆盖） */
const MASTER = process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787';
/**
 * 开发库路径：默认 `<仓库>/server/data/mclink.sqlite`。
 * 用 `import.meta.url` 解析，脚本换目录也不会指向别处（可用 `MCLINK_DB_FILE` 覆盖）。
 */
const DB_FILE =
  process.env.MCLINK_DB_FILE ?? fileURLToPath(new URL('../server/data/mclink.sqlite', import.meta.url));

/**
 * `--pure-only`（或 `MCLINK_PURE_ONLY=1`）：只跑第一段（纯函数）—— 不连主控、不开数据库，
 * 本机没起主控时用；第二段整体跳过。见文件头的「跑法」。
 */
const PURE_ONLY = process.argv.includes('--pure-only') || process.env.MCLINK_PURE_ONLY === '1';

const SLOW = 'zz_lat_slow';
const FAST = 'zz_lat_fast';
const USERNAME = `latverify${Date.now().toString(36).slice(-6)}`;
const PASSWORD = 'Lat-Verify-2026-xyz';

const createdRooms = [];
const results = [];
/** 本次会话里所有票据（每张都断言"没有主控端点 / 没有多余条目"） */
const ticketsSeen = [];
/** 按旧逻辑（Host 头这一级回退）推定出来的主控端点地址，汇总时用来断言"它没出现在任何票里" */
let oldMasterUrl = '';

const colors = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  fail: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  head: (s) => `\x1b[36m${s}\x1b[0m`,
  skip: (s) => `\x1b[33m${s}\x1b[0m`,
};

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition) });
  const tag = condition ? colors.ok('PASS') : colors.fail('FAIL');
  console.log(`  [${tag}] ${name}${detail ? colors.dim(`  — ${detail}`) : ''}`);
  return Boolean(condition);
}

function step(title) {
  console.log(`\n${colors.head('▸ ' + title)}`);
}

/* ============================================================ 第一段：纯函数 */

/** 与单测同一个构造器：默认 weight 100、未满员、无降级、利用率 0 */
function cand(id, over = {}, utilization = 0) {
  return {
    row: { id, capacity_peers: 500, peers: 0, weight: 100, status: 'online', ...over },
    utilization,
  };
}

function pick(ids, hints, max = 2) {
  return selectRelays(ids, hints, max).map((row) => row.id);
}

step('1. 延迟并列带：常量与「区间极差」语义');
{
  check('并列带常量 = 5ms（本轮由 20ms 收紧）', LATENCY_TIE_BAND_MS === 5, `LATENCY_TIE_BAND_MS=${LATENCY_TIE_BAND_MS}`);

  const ms0 = cand('p_ms0', {}, 0.85); // 空余带宽 0.15
  const ms4 = cand('p_ms4', {}, 0.85); // 空余带宽 0.15
  const ms8 = cand('p_ms8', {}, 0.0); // 空余带宽 1.00（最空）
  const picked = pick(
    [ms0, ms4, ms8],
    [
      { nodeId: 'p_ms0', ms: 0 },
      { nodeId: 'p_ms4', ms: 4 },
      { nodeId: 'p_ms8', ms: 8 },
    ],
    3,
  );
  console.log(`  ${colors.dim(`0/4/8ms 的排序结果 = ${JSON.stringify(picked)}`)}`);
  check(
    '区间极差：0 与 4 同档（极差 4 ≤ 5）、8ms 单独一档 —— 8 不会被当成"与前一个并列"而抢到最前',
    picked[2] === 'p_ms8' && picked[0] !== 'p_ms8',
    `picked=${JSON.stringify(picked)}`,
  );
  check(
    '同档内（0 与 4）按空余带宽/打分排，8ms 那台虽然最空也只能排在后面',
    picked[0] === 'p_ms0' && picked[1] === 'p_ms4',
  );
}

step('2. 档内（≤5ms）先比空余带宽，再比 relayScore');
{
  // peer 数与利用率刻意做成"互相对冲"：只看 relayScore 会选 roomy，只看空余带宽会选 tight
  const tight = cand('p_tight', { peers: 400 }, 0.05); // 空余带宽 .95；relayScore = 100×min(.2,.95) = 20
  const roomy = cand('p_roomy', { peers: 100 }, 0.6); //  空余带宽 .40；relayScore = 100×min(.8,.4)  = 40
  console.log(
    `  ${colors.dim(
      `p_tight: 空余带宽=${freeBandwidth(0.05)} relayScore=${relayScore(tight.row, 0.05)} ms=15 ；` +
          `p_roomy: 空余带宽=${freeBandwidth(0.6)} relayScore=${relayScore(roomy.row, 0.6)} ms=12`,
    )}`,
  );
  check(
    '前置条件：roomy 的 relayScore 更高（旧的"只看打分"规则会选它）',
    relayScore(roomy.row, 0.6) > relayScore(tight.row, 0.05),
  );
  const picked = pick(
    [tight, roomy],
    [
      { nodeId: 'p_tight', ms: 15 },
      { nodeId: 'p_roomy', ms: 12 },
    ],
    2,
  );
  check(
    '延迟差 3ms（同一档）→ 空余带宽更大的 p_tight 排第一（哪怕它慢 3ms、打分更低）',
    picked[0] === 'p_tight' && picked[1] === 'p_roomy',
    `picked=${JSON.stringify(picked)}`,
  );
}

step('3. 超出并列带（>5ms）→ 延迟说了算，带宽不再参与');
{
  const near = cand('p_near', { peers: 400 }, 0.05); // 空余带宽 .95，ms 12
  const far = cand('p_far', { peers: 100 }, 0.95); //  空余带宽 .05，ms 18
  const picked = pick(
    [near, far],
    [
      { nodeId: 'p_near', ms: 12 },
      { nodeId: 'p_far', ms: 18 },
    ],
    2,
  );
  check(
    '延迟差 6ms（> 带子）→ 延迟低的 p_near 赢，哪怕它的空余带宽小得多',
    picked[0] === 'p_near' && picked[1] === 'p_far',
    `picked=${JSON.stringify(picked)}`,
  );
  check(
    '同一对节点的 5ms 版本（12 vs 17）仍然同档 → 变成空余带宽决胜',
    pick(
      [near, far],
      [
        { nodeId: 'p_near', ms: 12 },
        { nodeId: 'p_far', ms: 17 },
      ],
      2,
    )[0] === 'p_near',
  );
}

step('4. 权重是主键：权重不同时延迟与带宽都不参与');
{
  const w99 = cand('p_w99', { weight: 99 }, 0.0); //  空余带宽 1.0，ms 5
  const w100 = cand('p_w100', { weight: 100 }, 0.8); // 空余带宽 .2，ms 500
  const picked = pick(
    [w99, w100],
    [
      { nodeId: 'p_w99', ms: 5 },
      { nodeId: 'p_w100', ms: 500 },
    ],
    2,
  );
  check(
    '权重 100 赢过权重 99（哪怕它空余带宽只有 .2、延迟差 495ms）',
    picked[0] === 'p_w100' && picked[1] === 'p_w99',
    `picked=${JSON.stringify(picked)}`,
  );
}

step('5. 没上报延迟（ms = +∞）的节点永远排最后');
{
  const hinted = cand('p_hinted', { peers: 450 }, 0.85); // 很挤：空余带宽 .15，打分 10
  const noHint = cand('p_nohint', {}, 0.0); //             很空：空余带宽 1.0，打分 100
  const picked = pick([hinted, noHint], [{ nodeId: 'p_hinted', ms: 300 }], 2);
  check(
    '有志的（300ms）排前，没志的排最后 —— 哪怕没志那台更空、打分更高',
    picked[0] === 'p_hinted' && picked[1] === 'p_nohint',
    `picked=${JSON.stringify(picked)}`,
  );
  check(
    '不重复：一次取满也只返回不重复的节点',
    (() => {
      const list = pick([hinted, noHint], [{ nodeId: 'p_hinted', ms: 300 }], 5);
      return list.length === new Set(list).size;
    })(),
  );
}

/* ============================================================ 第二段：真接口 */

/**
 * 第二段才需要数据库；`--pure-only` 时**根本不开连接**（所有 `db.*` 调用都在第二段里）。
 */
const db = PURE_ONLY ? null : new DatabaseSync(DB_FILE);
let token = null;
let userId = null;

async function api(pathname, { method = 'GET', body, token: tk } = {}) {
  const res = await fetch(`${MASTER}/api/v1${pathname}`, {
    method,
    headers: tk ? { 'content-type': 'application/json', authorization: `Bearer ${tk}` } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathname} 返回非 JSON: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`);
  }
  return json.data;
}

/** 允许失败的调用（用来断言"零节点时建房必须明确报错"） */
async function apiMaybe(pathname, options = {}) {
  const res = await fetch(`${MASTER}/api/v1${pathname}`, {
    method: options.method ?? 'GET',
    headers: options.token
      ? { 'content-type': 'application/json', authorization: `Bearer ${options.token}` }
      : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 允许非 JSON（只看状态码与原始文本） */
  }
  return { status: res.status, json, text };
}

/* ------------------------------------------------------- 测试节点数据 */

/**
 * 曾经存在过（或本来就存在）的 relay_nodes id 快照。
 *
 * 必须在**用例 I 把测试节点删掉之前**就攒好 —— 汇总那一步要断言"票里每个 id 都来自
 * relay_nodes"，而那时测试节点已经被 dropTestNodes() 清理了（上一版就是在这里踩的坑）。
 */
const knownRelayIds = new Set();

/** 把两条测试节点复位成指定形态（顺便刷新 last_seen_at，防止被健康检查判离线） */
function resetNodes(variant = {}) {
  const rows = {
    [SLOW]: {
      name: '验证-高延迟（打分高）',
      region: variant.slowRegion ?? 'cn-east',
      weight: variant.slowWeight ?? 200,
      peers: variant.slowPeers ?? 0,
      disabled: variant.slowDisabled ?? 0,
      status: variant.slowStatus ?? 'online',
    },
    [FAST]: {
      name: '验证-低延迟（打分低）',
      region: variant.fastRegion ?? 'cn-east',
      weight: variant.fastWeight ?? 100,
      peers: variant.fastPeers ?? 0,
      disabled: variant.fastDisabled ?? 0,
      status: variant.fastStatus ?? 'online',
    },
  };
  const now = new Date().toISOString();
  for (const [id, f] of Object.entries(rows)) {
    knownRelayIds.add(id);
    db.prepare('delete from relay_nodes where id = ?').run(id);
    db.prepare(
      `insert into relay_nodes (id, name, region, endpoint, listen_port, connect_port, public_ip, status, version,
        capacity_peers, peers, rooms, rx_bps, tx_bps, weight, tags, token_hash, last_seen_at, created_at, disabled, config_revision)
       values (?, ?, ?, ?, 11010, 11010, null, ?, null, 100, ?, 0, 0, 0, ?, '[]', ?, ?, ?, ?, 0)`,
    ).run(id, f.name, f.region, `${id.replace(/_/g, '-')}.example.com:11010`, f.status, f.peers, f.weight, `token-${id}`, now, now, f.disabled);
  }
}

/** 把两条测试节点都停掉（用来构造"一个可调度节点都没有"） */
function dropTestNodes() {
  for (const id of [SLOW, FAST]) db.prepare('delete from relay_nodes where id = ?').run(id);
}

function schedulableRows() {
  return db
    .prepare("select * from relay_nodes where status in ('online','degraded') and disabled = 0 and weight > 0")
    .all();
}

/** 独立复算「改造前」的打分（weight × min(人数余量, 带宽余量) − degraded 罚分，利用率取 0） */
function legacyRanking() {
  return schedulableRows()
    .map((r) => {
      const peerHeadroom = Math.max(0, r.capacity_peers - r.peers) / Math.max(1, r.capacity_peers);
      const bwHeadroom = 1; // 内存 EWMA 冷启动 / capacity_bps = 0 → 利用率恒为 0
      const penalty = r.status === 'degraded' ? 100 : 0;
      return { id: r.id, score: r.weight * Math.min(peerHeadroom, bwHeadroom) - penalty, peers: r.peers };
    })
    .sort((a, b) => b.score - a.score || a.peers - b.peers);
}

/**
 * 建房并返回关键字段；用完立刻关房，避免撞上"最多同时 N 个房间"的配额。
 *
 * 注意 `ticket.relays` 的顺序来自 `select * from relay_nodes where id in (...)`,**不是**优先级顺序
 * ——「谁优先」要看 `room.relayNodeIds`（= 服务端调度结果，第一顺位 = 主中继）。
 */
async function createRoom({ label, zone = 'auto', latencyHints, nodeIds }) {
  const body = {
    name: `延迟优先验证 ${label}`,
    zone,
    access: 'open',
    visibility: 'hidden',
    maxPlayers: 8,
    listenPort: 11010,
  };
  if (latencyHints !== undefined) body.latencyHints = latencyHints;
  if (nodeIds !== undefined) body.nodeIds = nodeIds;

  const data = await api('/rooms', { method: 'POST', body, token });
  createdRooms.push(data.room.id);
  const relays = data.ticket?.relays ?? [];
  ticketsSeen.push({ label, relays, relayNodeIds: data.room.relayNodeIds ?? [] });
  const relayIds = relays.map((r) => r.nodeId);
  console.log(`  ${colors.dim(`请求 body = ${JSON.stringify({ zone: body.zone, nodeIds: body.nodeIds, latencyHints: body.latencyHints })}`)}`);
  console.log(
    `  ${colors.dim(
      `响应: room=${data.room.id} room.relayNodeIds=${JSON.stringify(data.room.relayNodeIds)} ` +
        `nodeSelection=${JSON.stringify(data.nodeSelection)} ticket.relays=${JSON.stringify(relayIds)}`,
    )}`,
  );
  await api(`/rooms/${data.room.id}/close`, { method: 'POST', token });
  return { ...data, relayIds };
}

if (PURE_ONLY) {
  console.log(`\n${colors.skip('SKIP')} 第二段（真接口）已跳过：--pure-only。`);
} else {
  try {
    step('登录主控（admin，走 /auth/login）');
    {
      const login = await api('/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: process.env.MCLINK_ADMIN_PASSWORD ?? 'dev-only-passw0rd' },
      });
      check('admin 登录成功', Boolean(login.token), `user=${login.user?.username} role=${login.user?.role}`);
    }

    step(`注册临时验证账号建房（admin 名下的配额被已有房间占用）`);
    {
      const reg = await api('/auth/register', {
        method: 'POST',
        body: { username: USERNAME, password: PASSWORD, displayName: '延迟验证账号' },
      });
      token = reg.token;
      userId = reg.user?.id ?? null;
      check('临时账号注册成功并拿到令牌', Boolean(token && userId), `username=${USERNAME} userId=${userId}`);
      // 记下库里**原有**的节点 id（汇总那一步要断言"票里的 id 都来自 relay_nodes"，
      // 而测试节点会在用例 I 里被删掉，所以要在这里先快照）
      for (const row of db.prepare('select id from relay_nodes').all()) knownRelayIds.add(row.id);
    }

    step('旧逻辑（Host 头回退）会下发的主控端点：本次票据里必须看不到它');
    {
      const meta = await api('/meta');
      // 复刻被删掉的那段推导：relayPublicHost（未设）→ publicBaseUrl（未设）→ 请求 Host 头
      const hostHint = new URL(MASTER).host;
      const masterHost = hostHint.split(':')[0];
      oldMasterUrl = `tcp://${masterHost}:${meta.relayPort}`;
      console.log(`  ${colors.dim(`推定：旧代码会追加 nodeId=master、url=${oldMasterUrl}（label「主控中继（兜底）」）`)}`);
      check(
        '旧推导链在这个部署里是通的（请求 Host 头存在 + relayPort>0）→ 旧代码**确实会**追加主控端点，' +
          '所以下面"票里看不到它"是行为改变，不是环境巧合',
        hostHint.length > 0 && meta.relayPort > 0,
        `hostHint=${hostHint} relayPort=${meta.relayPort}`,
      );
    }

    /* ------------------------------------------------ A：同权重时，延迟提示决定主中继 */
    step('A. 延迟提示（同权重）：两台都是 weight 100，zz_lat_slow 报 500ms、zz_lat_fast 报 10ms');
    resetNodes({ slowWeight: 100 });
    {
      const r = await createRoom({ label: 'A', latencyHints: [{ nodeId: SLOW, ms: 500 }, { nodeId: FAST, ms: 10 }] });
      check(
        '主中继 = 低延迟的 zz_lat_fast',
        r.room.relayNodeIds[0] === FAST,
        `relayNodeIds=${JSON.stringify(r.room.relayNodeIds)}`,
      );
      check('主 + 兜底 = 2 个不同节点（票里也只有这两条）', r.room.relayNodeIds.length === 2 && new Set(r.relayIds).size === 2);
    }

    /* ------------------------------------------------ A2：权重是主键，权重不同时延迟不参与 */
    step('A2. 权重是主键：zz_lat_slow weight 200 / zz_lat_fast weight 100，提示仍然报 fast 更快');
    resetNodes();
    {
      const r = await createRoom({ label: 'A2', latencyHints: [{ nodeId: SLOW, ms: 500 }, { nodeId: FAST, ms: 10 }] });
      check(
        '权重不同：主中继仍是高权重的 zz_lat_slow（哪怕它慢 490ms）—— 这是现行语义，' +
          '"谁延迟低谁当主中继"只在同权重时才成立',
        r.room.relayNodeIds[0] === SLOW,
        `relayNodeIds=${JSON.stringify(r.room.relayNodeIds)}`,
      );
      check('低延迟那台没有被丢掉：它成了兜底（票里两条都在）', r.relayIds.includes(FAST) && r.relayIds.includes(SLOW));
    }

    /* ------------------------------------------------ B：不带提示 → 权重/打分说了算 */
    step('B. 建房不带 latencyHints（模拟老客户端：字段压根不出现）');
    resetNodes();
    {
      const expected = legacyRanking();
      console.log(`  ${colors.dim(`独立复算的旧打分排序 = ${JSON.stringify(expected)}`)}`);
      const r = await createRoom({ label: 'B' });
      check(
        '不带提示时主中继是"打分最高的那台"（zz_lat_slow，weight 200）',
        r.room.relayNodeIds[0] === SLOW && r.room.relayNodeIds[0] === expected[0]?.id,
        `expected=${expected[0]?.id} actual=${JSON.stringify(r.room.relayNodeIds)}`,
      );
      check(
        '两个不同节点：主中继 + 兜底中继（本轮新增的"每房两个"）',
        r.room.relayNodeIds.length === 2 && new Set(r.room.relayNodeIds).size === 2,
        `relayNodeIds=${JSON.stringify(r.room.relayNodeIds)}`,
      );
      check(
        '票里的中继条目与 room.relayNodeIds 完全一致（没有多出来的条目）',
        [...r.relayIds].sort().join(',') === [...r.room.relayNodeIds].sort().join(','),
        `ticket=${JSON.stringify(r.relayIds)} room=${JSON.stringify(r.room.relayNodeIds)}`,
      );
      check(
        'nodeSelection.fallback = 兜底那一台（自动模式下就是第二顺位）',
        r.nodeSelection?.fallback === r.room.relayNodeIds[1] && r.nodeSelection.fallback !== r.room.relayNodeIds[0],
        `fallback=${r.nodeSelection?.fallback}`,
      );
    }

    /* ------------------------------------------------ C：weight=0 硬条件 */
    step('C. 硬条件：低延迟节点 weight=0（提示仍把它报成 1ms）');
    resetNodes({ fastWeight: 0 });
    {
      const r = await createRoom({ label: 'C', latencyHints: [{ nodeId: FAST, ms: 1 }, { nodeId: SLOW, ms: 500 }] });
      check('weight=0 的节点即使延迟最低也不会被选中', !r.relayIds.includes(FAST), `selected=${JSON.stringify(r.relayIds)}`);
      check('选中 weight>0 的那台当主中继', r.room.relayNodeIds[0] === SLOW, `selected=${JSON.stringify(r.room.relayNodeIds)}`);
    }

    /* ------------------------------------------------ D：满员（提示不算数） */
    step('D. 硬条件：低延迟节点满员（peers = capacity_peers = 100）');
    resetNodes({ fastPeers: 100 });
    {
      const r = await createRoom({ label: 'D', latencyHints: [{ nodeId: FAST, ms: 1 }, { nodeId: SLOW, ms: 500 }] });
      check(
        '满员节点不会被提示抬成主中继（键 0「真有余量」在权重与延迟之前）',
        r.room.relayNodeIds[0] === SLOW,
        `relayNodeIds=${JSON.stringify(r.room.relayNodeIds)}`,
      );
      check(
        '满员节点仍然留在池子里当兜底（没有被排除，只是排第二）',
        r.room.relayNodeIds.length === 2 && r.room.relayNodeIds[1] === FAST,
        `relayNodeIds=${JSON.stringify(r.room.relayNodeIds)}`,
      );
    }

    /* ------------------------------------------------ E：停用 */
    step('E. 硬条件：低延迟节点被管理员停用（disabled=1 / status=disabled）');
    resetNodes({ fastDisabled: 1, fastStatus: 'disabled' });
    {
      const r = await createRoom({ label: 'E', latencyHints: [{ nodeId: FAST, ms: 1 }, { nodeId: SLOW, ms: 500 }] });
      check('停用节点连票都进不去（提示拉不回来、也不会被当兜底）', !r.relayIds.includes(FAST), `ticket=${JSON.stringify(r.relayIds)}`);
    }

    /* ------------------------------------------------ F：离线 */
    step('F. 硬条件：低延迟节点离线（status=offline）');
    resetNodes({ fastStatus: 'offline' });
    {
      const r = await createRoom({ label: 'F', latencyHints: [{ nodeId: FAST, ms: 1 }, { nodeId: SLOW, ms: 500 }] });
      check('离线节点连票都进不去', !r.relayIds.includes(FAST), `ticket=${JSON.stringify(r.relayIds)}`);
    }

    /* ------------------------------------------------ G：区域 */
    step('G. 硬条件：低延迟节点在别的区域（cn-south），建房 zone=cn-east');
    resetNodes({ fastRegion: 'cn-south' });
    {
      const r = await createRoom({
        label: 'G',
        zone: 'cn-east',
        latencyHints: [{ nodeId: FAST, ms: 1 }, { nodeId: SLOW, ms: 500 }],
      });
      check('外区域的低延迟节点不会被选中', !r.relayIds.includes(FAST), `ticket=${JSON.stringify(r.relayIds)}`);
      check('选中该区域内的那台当主中继', r.room.relayNodeIds[0] === SLOW, `relayNodeIds=${JSON.stringify(r.room.relayNodeIds)}`);
    }

    /* ------------------------------------------------ H：手动模式 = 手选优先 + 兜底不重复 */
    step('H. 手动模式：nodeIds=[zz_lat_slow] + 提示说 zz_lat_fast 更快');
    resetNodes();
    {
      const r = await createRoom({
        label: 'H',
        nodeIds: [SLOW],
        latencyHints: [{ nodeId: FAST, ms: 10 }, { nodeId: SLOW, ms: 500 }],
      });
      check(
        '手选节点仍然排在最前（room.relayNodeIds[0] = zz_lat_slow）',
        r.room.relayNodeIds[0] === SLOW,
        `relayNodeIds=${JSON.stringify(r.room.relayNodeIds)}`,
      );
      check(
        'nodeSelection：手选被接受、兜底是低延迟那台，且与手选不重复',
        r.nodeSelection?.accepted?.[0] === SLOW && r.nodeSelection?.fallback === FAST && FAST !== SLOW,
        `accepted=${JSON.stringify(r.nodeSelection?.accepted)} fallback=${r.nodeSelection?.fallback}`,
      );
      check(
        '票里两条中继都在（手选 + 兜底），且是两个不同节点',
        r.relayIds.includes(SLOW) && r.relayIds.includes(FAST) && new Set(r.relayIds).size === r.relayIds.length,
        `ticket.relays=${JSON.stringify(r.relayIds)}`,
      );
    }

    /* ------------------------------------------------ I：零可调度节点 → 明确报错 */
    step('I. 一个可调度子节点都没有 → 建房必须**明确报错**（不再拿主控兜底）');
    {
      const others = schedulableRows().filter((r) => r.id !== SLOW && r.id !== FAST);
      if (others.length > 0) {
        console.log(
          `  [${colors.skip('SKIP')}] 库里还有 ${others.length} 台可调度节点（${others.map((r) => r.id).join(', ')}），` +
            '构造不出"零节点"，本用例跳过（不是通过）。',
        );
      } else {
        dropTestNodes();
        const body = { name: '零节点守卫验证', zone: 'auto', access: 'open', visibility: 'hidden', maxPlayers: 8, listenPort: 11010 };
        const res = await apiMaybe('/rooms', { method: 'POST', body, token });
        const message = res.json?.error?.message ?? res.text.slice(0, 200);
        console.log(`  ${colors.dim(`POST /rooms -> ${res.status} ${res.json?.error?.code ?? ''} ${message}`)}`);
        check('零节点时建房被拒（503 SERVICE_UNAVAILABLE）', res.status === 503, `status=${res.status}`);
        check('错误文案能让玩家/客服看懂', String(message).includes('当前没有可用的中继节点'), `message=${message}`);
        check('被拒时没有留下半个房间', !res.json?.data?.room, `data=${res.json?.data ? 'present' : 'null'}`);
      }
    }

    /* ------------------------------------------------ 汇总：所有票据的主控端点检查 */
    step('汇总：本次全部票据的"没有主控端点"检查（本轮最重要的一条）');
    {
      const allRelayIds = ticketsSeen.flatMap((t) => t.relays.map((r) => r.nodeId));
      const allUrls = ticketsSeen.flatMap((t) => t.relays.flatMap((r) => [r.url, r.udpUrl]));
      const unknown = [...new Set(allRelayIds)].filter((id) => !knownRelayIds.has(id));
      console.log(`  ${colors.dim(`共检查 ${ticketsSeen.length} 张票据（用例 ${ticketsSeen.map((t) => t.label).join('/')}），` +
      `票里出现过的中继 = ${JSON.stringify([...new Set(allRelayIds)])}`)}`);
      check(
        `没有一张票据含 nodeId='master' 的主控端点（${ticketsSeen.length} 张全查）`,
        !allRelayIds.includes('master'),
        `tickets=${ticketsSeen.length}`,
      );
      check(
        `没有一张票据含旧逻辑会追加的地址 ${oldMasterUrl}`,
        !allUrls.includes(oldMasterUrl),
        `relay_urls=${JSON.stringify([...new Set(allUrls)])}`,
      );
      check(
        '票里的每个中继 id 都曾是 relay_nodes 里的一行（票据只来自子节点调度）',
        unknown.length === 0,
        `unknown=${JSON.stringify(unknown)}`,
      );
    }
  } finally {
    /* ---------------------------------------------------------------- 收尾 */
    const roomIds = [...new Set(createdRooms)];
    try {
      if (roomIds.length > 0) {
        step('服务端审计日志（room.create 落库的 relayNodeIds 证据，清理前抓取）');
        const placeholders = roomIds.map(() => '?').join(',');
        const rows = db
          .prepare(`select ts, actor_name, target_id, detail from audit_log where action = 'room.create' and target_id in (${placeholders}) order by id`)
          .all(...roomIds);
        for (const row of rows) console.log(`  ${colors.dim(`${row.ts} ${row.actor_name} ${row.target_id} ${row.detail}`)}`);
      }

      step('收尾：删除测试节点 + 测试账号（级联房间/会话）+ 本次房间的子表与审计行');
      db.exec('pragma foreign_keys = OFF');
      db.prepare('delete from relay_nodes where id in (?, ?)').run(SLOW, FAST);
      const leftNodes = db.prepare('select count(*) c from relay_nodes where id in (?, ?)').get().c;

      for (const id of roomIds) {
        for (const table of ['room_members', 'room_messages', 'room_usage', 'room_access_log', 'relay_room_traffic']) {
          db.prepare(`delete from ${table} where room_id = ?`).run(id);
        }
        db.prepare("delete from audit_log where target_id = ? and target_type = 'room'").run(id);
        db.prepare('delete from rooms where id = ?').run(id);
      }
      if (userId) {
        db.prepare('delete from sessions where user_id = ?').run(userId);
        // 临时账号产生的审计行一并清掉（action 名不固定：auth.register / room.create ...）
        db.prepare('delete from audit_log where actor_id = ? or target_id = ?').run(userId, userId);
        db.prepare('delete from users where id = ?').run(userId);
      }
      const leftRooms = roomIds.length
        ? db.prepare(`select count(*) c from rooms where id in (${roomIds.map(() => '?').join(',')})`).get(...roomIds).c
        : 0;
      const leftUser = userId ? db.prepare('select count(*) c from users where id = ?').get(userId).c : 0;
      console.log(
        `  ${colors.dim(`残留：测试节点=${leftNodes} 本次房间=${leftRooms} 临时账号=${leftUser}（共清理 ${roomIds.length} 个房间）`)}`,
      );
      check('测试节点已清理', leftNodes === 0);
      check('本次新建的房间已清理', leftRooms === 0);
      check('临时验证账号已清理', leftUser === 0);
    } finally {
      db.close();
    }
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n共 ${results.length} 项断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length > 0) {
  for (const f of failed) console.log(colors.fail(`  ✗ ${f.name}`));
  process.exitCode = 1;
}
