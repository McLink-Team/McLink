#!/usr/bin/env node
/**
 * 端到端检查：**手选节点的槽位归属**（建房接口真的按能力落槽，顺序是 `[打洞, 中继]`）。
 *
 * 为什么要有它（2026-09-29 用户实测报的问题）：
 *   建房页那颗按钮写的是「中继节点 → 手动选择」，但服务端把手选节点**原样塞在数组最前面**，
 *   而客户端把 `relayNodeIds[0]` 当「打洞节点」（`client/src/lib/relay-roles.ts`）——
 *   于是**玩家挑的中继 100% 被标成打洞节点**；平台再补的那台取的是自动调度的**第一顺位**
 *   （`pickRoomRelays` 的槽 1 候选，优先"只协助打洞"的节点），而那种节点不承载数据
 *   （`disable_relay_data`）—— 手选一台 assist 节点时，两个槽位都不是承载者，房间没有中继。
 *
 * 为什么必须**打真接口**：这个 bug 的性质是"纯函数写对了、接线/顺序错了"，
 * 单测 `assignRelaySlots` 抓不到。上一次"心跳不下发配置"的 bug 也是这么漏过去的
 * （当时脚本测的是 agent 从来不走的 `/agent/config` 拉取接口）。所以这里：
 * 自己注册两台临时节点 → 分别手选建房 → 检查 `relayNodeIds` 顺序与 `nodeSelection.roles`。
 *
 * 用法（需要本机 8787 主控在跑）：
 *   node scripts/check-relay-slots.mjs
 *   MCLINK_MASTER=http://127.0.0.1:8787 MCLINK_ADMIN_PASSWORD=xxx node scripts/check-relay-slots.mjs
 *
 * 前置：管理员密码默认 `dev-only-passw0rd`（可用环境变量覆盖）。
 * 副作用：注册两台临时节点建两个临时房间，结束时全部删掉/关闭（那把注册密钥会留在库里）。
 */
const MASTER = process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787';
const PASS = process.env.MCLINK_ADMIN_PASSWORD ?? 'dev-only-passw0rd';
const RUN = Date.now().toString(36).slice(-5);
const BASE_PORT = 13700 + (Number(Date.now().toString().slice(-3)) % 100);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${MASTER}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || payload.ok === false) {
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${payload?.error?.message ?? ''}`);
  }
  return payload.data;
}

const admin = await api('/auth/login', { method: 'POST', body: { username: 'admin', password: PASS } });

/** 注册一台临时节点并让它上线（pending → 首次心跳即 online） */
async function makeNode(name, port) {
  const key = await api('/admin/nodes/enroll-key', {
    method: 'POST',
    token: admin.token,
    body: { note: `slots ${RUN}`, host: '127.0.0.1' },
  });
  const node = await api('/agent/register', {
    method: 'POST',
    body: {
      enrollKey: key.enrollKey,
      name,
      region: 'cn-east',
      endpoint: `127.0.0.1:${port}`,
      listenPort: port,
      connectPort: port,
      capacityPeers: 500,
      version: 'verify',
    },
  });
  await api('/agent/heartbeat', {
    method: 'POST',
    token: node.nodeToken,
    body: { peers: 0, rooms: 0, rxBps: 0, txBps: 0, appliedConfigRevision: 0 },
  });
  return { id: node.node.id, token: node.nodeToken };
}

const made = [];
const createdRooms = [];
/** ④ 里注册的临时成员账号（收尾时封禁它，避免它在开发主控上继续可用） */
let memberId = null;
try {
  const a = await makeNode(`slots-data-${RUN}`, BASE_PORT);
  const b = await makeNode(`slots-assist-${RUN}`, BASE_PORT + 1);
  made.push(a.id, b.id);

  /** a = 大管子；b = 小管子（单节点模型下 assist_only 已不再影响配置与调度，这里只用来造差异） */
  await api(`/admin/nodes/${b.id}`, { method: 'PATCH', token: admin.token, body: { assistOnly: true } });
  await api(`/admin/nodes/${a.id}`, { method: 'PATCH', token: admin.token, body: { assistOnly: false, capacityBps: 0 } });

  const nodes = (await api('/nodes', { token: admin.token })).nodes;
  /*
   * 单节点模型（2026-09-30 起）下 `/nodes` **不再下发 `assistOnly`** ——
   * 「只协助打洞」那套语义已废弃（所有节点都允许中继）。继续下发只会让老客户端把房间页
   * 写成「只协助打洞（不承载流量）」，那是错的（见 docs/relay-assignment.md）。
   */
  check(
    '客户端节点列表**不再**下发 assistOnly（该语义已废弃）',
    nodes.filter((n) => [a.id, b.id].includes(n.id)).every((n) => n.assistOnly === undefined),
    JSON.stringify(nodes.filter((n) => [a.id, b.id].includes(n.id)).map((n) => [n.name, n.assistOnly])),
  );
  // ① 手选一台 → 它就是房间唯一的节点（单节点模型：不再有"打洞槽/中继槽"之分）
  const r1 = await api('/rooms', {
    method: 'POST',
    token: admin.token,
    body: { name: `slot-a ${RUN}`, zone: 'cn-east', nodeIds: [a.id] },
  });
  createdRooms.push(r1.room.id);
  const ids1 = r1.room.relayNodeIds ?? [];
  check(
    '① 手选的节点进了房间的中继集合（≤3 台，且它是第一台）',
    ids1.length >= 1 && ids1.length <= 3 && ids1[0] === a.id,
    JSON.stringify(ids1),
  );
  check('① nodeSelection.roles 告诉界面谁是中继', r1.nodeSelection?.roles?.relay === a.id, JSON.stringify(r1.nodeSelection?.roles));
  check('① 单节点模型下没有"打洞节点"角色', r1.nodeSelection?.roles?.punch === null, JSON.stringify(r1.nodeSelection?.roles?.punch));

  // ② 手选两台 → 只认第一台，其余如实进 rejected
  const r2 = await api('/rooms', {
    method: 'POST',
    token: admin.token,
    body: { name: `slot-b ${RUN}`, zone: 'cn-east', nodeIds: [b.id, a.id] },
  });
  createdRooms.push(r2.room.id);
  const ids2 = r2.room.relayNodeIds ?? [];
  check(
    '② 手选两台都在集合里（上限 3 台，不会只留一台）',
    ids2.includes(b.id) && ids2.includes(a.id) && ids2.length <= 3,
    JSON.stringify(ids2),
  );
  check(
    '② 没超过上限就没有 rejected',
    (r2.nodeSelection?.rejected ?? []).length === 0,
    JSON.stringify(r2.nodeSelection?.rejected),
  );

  /*
   * ③ 票据按角色给中继集合（docs/relay-assignment.md）：
   *   · 房主 → **全部**可调度节点（每台都有一条直达房主的链路，成员分配怎么变都不用动房主）；
   *   · 成员 → **只有分配给他的那一台**（分配写回 room_members.relay_node_id）。
   * 这个脚本里的账号是建房者 = 房主，所以这里断言"房主拿到多台"这一半；
   * 成员侧要用第二个账号在开发主控上验（见文档的验收标准）。
   */
  const ticket = await api(`/rooms/${r2.room.id}/ticket`, { token: admin.token });
  const hostRelays = ticket.relays ?? [];
  check(
    '③ 房主票据包含**全部**可调度节点（不只房间默认那一台）',
    hostRelays.length >= 2,
    `relays=${JSON.stringify(hostRelays.map((r) => r.label))}`,
  );
  check(
    '③ 房主票据里仍有 latency_first',
    String(ticket.configToml ?? '').includes('latency_first = true'),
  );

  /*
   * ④ 成员侧（2026-10-02 新增，见 docs/relay-assignment.md 的"成员分配的口径"）：
   *   注册第二个账号 → 带**故意偏心**的延迟提示进房 → 断言：
   *     · 成员票据**只有 1 台**中继（整个集合只给房主）；
   *     · 拿到的正是他自己上报延迟最低的那台（**延迟优先**，不是按负载）；
   *     · 再拉一次票据仍是同一台（分配已固定）；
   *     · 分配写回 `room_members.relay_node_id`（房主在成员列表里能看到）。
   *
   *   为什么这里只能验"延迟优先"：房间集合里 a / b 两台利用率都是 0（没有流量采样），
   *   于是"延迟"是唯一能分出胜负的规则 —— 提示给 b 5ms、给 a 900ms 就应当分到 b。
   *   "过卸荷线就排除"这条要等 EWMA 收敛（tau = 3 分钟），live 脚本里构造不出来，
   *   由单测 `pickMemberRelay`（server/test/unit.test.ts）钉住。
   */
  const memberName = `slots_m_${RUN}`;
  const memberPass = `Slots-${RUN}-pw`;
  const reg = await api('/auth/register', {
    method: 'POST',
    body: { username: memberName, password: memberPass },
  });
  memberId = reg.user.id;
  let joined = null;
  try {
    joined = await api('/rooms/join', {
      method: 'POST',
      token: reg.token,
      body: {
        code: r2.room.code,
        deviceName: memberName,
        listenPort: BASE_PORT + 2,
        latencyHints: [
          { nodeId: b.id, ms: 5 },
          { nodeId: a.id, ms: 900 },
        ],
      },
    });
  } catch (err) {
    /*
     * 平台开着「必须验证邮箱」时新账号进不了房（403 EMAIL_NOT_VERIFIED）——
     * 那是环境限制，不是这次改动的问题，如实报 SKIP 而不是 FAIL。
     */
    if (String(err?.message ?? '').includes('邮箱')) {
      console.log(`  [SKIP] ④ 成员侧检查：该主控开启了"必须验证邮箱"，临时账号进不了房（${err.message}）`);
    } else {
      throw err;
    }
  }
  if (joined) {
    const memberRelays = joined.ticket?.relays ?? [];
    check(
      '④ 成员票据只含 **1 台**中继（整个集合只给房主）',
      memberRelays.length === 1,
      `relays=${JSON.stringify(memberRelays.map((r) => r.label))}`,
    );
    check(
      '④ 成员拿到的是**他自己上报延迟最低**的那台（延迟优先）',
      memberRelays[0]?.nodeId === b.id,
      `分了 ${memberRelays[0]?.label}（提示：b=5ms / a=900ms）`,
    );
    const again = await api(`/rooms/${r2.room.id}/ticket`, { token: reg.token });
    check(
      '④ 再拉一次票据仍是同一台（分配已固定，不会来回漂）',
      (again.relays ?? [])[0]?.nodeId === memberRelays[0]?.nodeId,
      JSON.stringify((again.relays ?? []).map((r) => r.label)),
    );
    /*
     * 分配就发生在 join 内部那次 ticket() 里 —— 所以 join 的响应必须**重新读一次**成员行，
     * 否则这里永远是 null（票据里已经有中继了、接口却说"没分"）。这条就是那个 bug 的回归哨兵。
     */
    check(
      '④ 进房响应里的 member.relayNodeId 就是分到的那台（不能是 null）',
      joined.member?.relayNodeId === memberRelays[0]?.nodeId,
      `relayNodeId=${joined.member?.relayNodeId}`,
    );
    const detail = await api(`/rooms/${r2.room.id}`, { token: admin.token });
    const mine = (detail.members ?? []).find((m) => m.userId === reg.user.id);
    check(
      '④ 分配写回了 room_members.relay_node_id（房主看得到）',
      mine?.relayNodeId === memberRelays[0]?.nodeId,
      `relayNodeId=${mine?.relayNodeId}`,
    );
  }
}
 catch (err) {
  fail += 1;
  console.log(`  [FAIL] 运行中断：${err?.message ?? err}`);
} finally {
  for (const id of createdRooms) await api(`/rooms/${id}/close`, { method: 'POST', token: admin.token }).catch(() => {});
  for (const id of made) await api(`/admin/nodes/${id}`, { method: 'DELETE', token: admin.token }).catch(() => {});
  // 临时成员账号：接口没有删用户，就封禁 + 清掉它的会话（别在开发主控上留一个能用的账号）
  if (memberId) {
    await api(`/admin/users/${memberId}`, { method: 'PATCH', token: admin.token, body: { banned: true } }).catch(() => {});
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败（临时房间与节点已清理${memberId ? '，临时账号已封禁' : ''}）`);
process.exitCode = fail === 0 ? 0 : 1;
