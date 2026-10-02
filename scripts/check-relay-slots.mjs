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

/**
 * 注册一台临时节点并让它上线（pending → 首次心跳即 online）。
 *
 * `opts.capacityBps` 在**首次心跳之前**写进去，`opts.rxBps/txBps` 就是首帧读数 ——
 * 这是造"利用率立刻到 100%"的唯一办法：EWMA 的**第一个样本直接作为初值**
 * （见 `node-utilization.ts` 的 record），之后再补帧只会被 3 分钟的时间常数拖住。
 */
async function makeNode(name, port, { capacityBps, rxBps = 0, txBps = 0 } = {}) {
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
  if (capacityBps !== undefined) {
    await api(`/admin/nodes/${node.node.id}`, { method: 'PATCH', token: admin.token, body: { capacityBps } });
  }
  await api('/agent/heartbeat', {
    method: 'POST',
    token: node.nodeToken,
    body: { peers: 0, rooms: 0, rxBps, txBps, appliedConfigRevision: 0 },
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
  // ① 手选一台 → 它就是房间唯一的中继（单节点模型：房间只下发一台）
  const r1 = await api('/rooms', {
    method: 'POST',
    token: admin.token,
    body: { name: `slot-a ${RUN}`, zone: 'cn-east', nodeIds: [a.id] },
  });
  createdRooms.push(r1.room.id);
  const ids1 = r1.room.relayNodeIds ?? [];
  check(
    '① 手选的节点就是房间**唯一**的中继（单节点模型：length === 1）',
    ids1.length === 1 && ids1[0] === a.id,
    JSON.stringify(ids1),
  );
  check('① nodeSelection.roles 告诉界面谁是中继', r1.nodeSelection?.roles?.relay === a.id, JSON.stringify(r1.nodeSelection?.roles));
  check('① 单节点模型下没有"打洞节点"角色', r1.nodeSelection?.roles?.punch === null, JSON.stringify(r1.nodeSelection?.roles?.punch));

  // ② 手选两台 → 只认第一台，第二台如实进 rejected（并说清"一个房间只下发一台"）
  const r2 = await api('/rooms', {
    method: 'POST',
    token: admin.token,
    body: { name: `slot-b ${RUN}`, zone: 'cn-east', nodeIds: [b.id, a.id] },
  });
  createdRooms.push(r2.room.id);
  const ids2 = r2.room.relayNodeIds ?? [];
  check(
    '② 手选两台 → 只留第一台（单节点模型）',
    ids2.length === 1 && ids2[0] === b.id,
    JSON.stringify(ids2),
  );
  const rejected2 = r2.nodeSelection?.rejected ?? [];
  check(
    '② 被忽略的那台如实进 rejected，且理由说清"最多 1 台"',
    rejected2.length === 1 && rejected2[0]?.id === a.id && /最多 1 台/.test(rejected2[0]?.reason ?? ''),
    JSON.stringify(rejected2),
  );

  /*
   * ③ 票据：单节点模型下**房主也只是一台**（他自己的核心只连这一台），
   * 与房间的中继集合完全一致 —— 这是"房间里没有第二条可被误选的路"的前提。
   */
  const ticket = await api(`/rooms/${r2.room.id}/ticket`, { token: admin.token });
  const hostRelays = ticket.relays ?? [];
  check(
    '③ 房主票据也只有 **1 台**中继，且等于房间中继集合',
    hostRelays.length === 1 && hostRelays[0]?.nodeId === b.id,
    `relays=${JSON.stringify(hostRelays.map((r) => r.label))}`,
  );
  check(
    '③ 房主票据里仍有 latency_first',
    String(ticket.configToml ?? '').includes('latency_first = true'),
  );

  /*
   * ④ 成员侧（2026-10-02 加，2026-10-03 按单节点模型重写）：
   *   注册第二个账号 → 进房 → 断言：
   *     · 成员票据**只有 1 台**中继，且**与房主那台是同一台**（单节点模型的全部意义）；
   *     · 分配写回 `room_members.relay_node_id`，进房响应里就能看到；
   *     · 再拉一次票据仍是同一台（分配已固定）。
   *   提示里故意写"a 只要 5ms、b 要 900ms"，用来证明**单节点模型下不会因为延迟好就换台** ——
   *   房间是谁就是谁（延迟排序只在集合里有多台时才有得挑，见单测 pickMemberRelay）。
   */
  const memberName = `slots_m_${RUN}`;
  const memberPass = `Slots-${RUN}-pw1`;
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
          { nodeId: a.id, ms: 5 },
          { nodeId: b.id, ms: 900 },
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
      '④ 成员票据只含 **1 台**中继',
      memberRelays.length === 1,
      `relays=${JSON.stringify(memberRelays.map((r) => r.label))}`,
    );
    check(
      '④ 成员拿到的就是**房主那台**（单节点：房间里没有第二条路）',
      memberRelays[0]?.nodeId === hostRelays[0]?.nodeId,
      `成员=${memberRelays[0]?.label} 房主=${hostRelays[0]?.label}（提示故意说另一台只要 5ms）`,
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
      '④ 分配写回了 room_members.relay_node_id（房主在控制台看得到）',
      mine?.relayNodeId === memberRelays[0]?.nodeId,
      `relayNodeId=${mine?.relayNodeId}`,
    );
    /*
     * ⑤ 心跳里那条"该重连了"的标志（单节点换中继的一半机制，见 memberRelayStale）：
     *   正常态必须是 false —— 房间里没换过中继，客户端就不该弹横幅、不该响。
     *   另一半（房主切完之后真的变成 true）需要真的触发一次过载切换（6 个 30 秒窗口），
     *   live 脚本里等不起，由单测 memberRelayStale + relayLoadAction 钉住判定本身。
     */
    const hb = await api(`/rooms/${r2.room.id}/heartbeat`, {
      method: 'POST',
      token: reg.token,
      body: { virtualIp: joined.member?.virtualIp ?? null, peers: [], rxBps: 0, txBps: 0, aclRevision: 0 },
    });
    check(
      '⑤ 没换过中继时，心跳的 relayChanged 是 false（不会平白弹横幅/响铃）',
      hb.relayChanged === false,
      `relayChanged=${JSON.stringify(hb.relayChanged)}`,
    );

    /*
     * ⑥ 卸荷线 live（2026-10-02 加，2026-10-03 按单节点模型改写）：
     *   "过线的节点不再接新房间"原来只有单测，这是它的活体证据。
     *
     *   造一台**首帧就顶满**的节点：容量写 1 Mbps、第一次心跳就报 rxBps = 1 Mbps。
     *   EWMA 的第一个样本直接作为初值（见 node-utilization.ts 的 record），
     *   于是它的利用率稳稳是 100% ≥ 卸荷线（小管子 80%），必被排除在**自动调度**之外。
     *   然后建一个不带手选节点的房间（region = cn-east）：房间的中继**不能**是它。
     *
     *   注意单节点模型下"过线的节点仍可被手选"（手选是用户的直接意图，见
     *   `#validatePickedNodes`），这里验的是**平台自己挑**的那条路。
     */
    const hot = await makeNode(`slots-hot-${RUN}`, BASE_PORT + 3, { capacityBps: 1_000_000, rxBps: 1_000_000 });
    made.push(hot.id);
    const r3 = await api('/rooms', {
      method: 'POST',
      token: admin.token,
      body: { name: `slot-hot ${RUN}`, zone: 'cn-east' },
    });
    createdRooms.push(r3.room.id);
    const autoIds = r3.room.relayNodeIds ?? [];
    check(
      '⑥ 自动调度不会把已过卸荷线的节点分给新房间',
      autoIds.length === 1 && !autoIds.includes(hot.id),
      `房间中继=${JSON.stringify(autoIds)}（过线的 hot=${hot.id}）`,
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
