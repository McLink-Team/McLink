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
try {
  const a = await makeNode(`slots-data-${RUN}`, BASE_PORT);
  const b = await makeNode(`slots-assist-${RUN}`, BASE_PORT + 1);
  made.push(a.id, b.id);

  /** a = 能承载数据（当手选中继）；b = 只协助打洞（当打洞节点） */
  await api(`/admin/nodes/${b.id}`, { method: 'PATCH', token: admin.token, body: { assistOnly: true } });
  await api(`/admin/nodes/${a.id}`, { method: 'PATCH', token: admin.token, body: { assistOnly: false, capacityBps: 0 } });

  const nodes = (await api('/nodes', { token: admin.token })).nodes;
  check(
    '客户端节点列表带 assistOnly（手动选择要靠它提示玩家）',
    nodes.filter((n) => [a.id, b.id].includes(n.id)).every((n) => typeof n.assistOnly === 'boolean') &&
      nodes.find((n) => n.id === b.id)?.assistOnly === true,
    JSON.stringify(nodes.filter((n) => [a.id, b.id].includes(n.id)).map((n) => [n.name, n.assistOnly])),
  );

  // ① 手选一台"能承载数据"的节点 → 它必须当中继（下标 1），打洞槽由平台补
  const r1 = await api('/rooms', {
    method: 'POST',
    token: admin.token,
    body: { name: `slot-a ${RUN}`, zone: 'cn-east', nodeIds: [a.id] },
  });
  createdRooms.push(r1.room.id);
  const ids1 = r1.room.relayNodeIds ?? [];
  check('① 手选"能承载数据"的节点落在 relayNodeIds[1]（下标 0 才是打洞节点）', ids1[1] === a.id, JSON.stringify(ids1));
  check('① nodeSelection.roles 告诉界面谁是中继', r1.nodeSelection?.roles?.relay === a.id, JSON.stringify(r1.nodeSelection?.roles));
  check('① 打洞槽由平台补了另一台（不会重复占两槽）', Boolean(ids1[0]) && ids1[0] !== a.id, String(ids1[0]));

  // ② 手选一台"只协助打洞"的节点 → 它必须落打洞槽，中继槽仍得是能承载数据的节点
  const r2 = await api('/rooms', {
    method: 'POST',
    token: admin.token,
    body: { name: `slot-b ${RUN}`, zone: 'cn-east', nodeIds: [b.id] },
  });
  createdRooms.push(r2.room.id);
  const ids2 = r2.room.relayNodeIds ?? [];
  check('② 手选"只协助打洞"的节点落 relayNodeIds[0]（打洞槽）', ids2[0] === b.id, JSON.stringify(ids2));
  check('② 中继槽仍是能承载数据的节点（不会把 assist 补进中继槽）', Boolean(ids2[1]) && ids2[1] !== b.id, String(ids2[1]));
} catch (err) {
  fail += 1;
  console.log(`  [FAIL] 运行中断：${err?.message ?? err}`);
} finally {
  for (const id of createdRooms) await api(`/rooms/${id}/close`, { method: 'POST', token: admin.token }).catch(() => {});
  for (const id of made) await api(`/admin/nodes/${id}`, { method: 'DELETE', token: admin.token }).catch(() => {});
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败（临时房间与节点已清理）`);
process.exitCode = fail === 0 ? 0 : 1;
