#!/usr/bin/env node
/**
 * 回归检查：**改了会影响节点生成配置的字段，必须让配置版本 +1**。
 *
 * 为什么需要它（用户实测踩到的坑）：在控制台把节点从 `阿里云上海` 改成
 * `上海阿里云 2Mbps BGP` 之后，节点**永远不重新取配置** —— 因为 `NodeService.update()`
 * 只在改端口时 bump `configRevision`。后果是节点内核里的 hostname 还是旧名字，
 * 客户端房间页按"内核 hostname ↔ 票据节点名"判定「打洞 / 中继」角色时对不上，
 * 只能显示「角色未知」（来回装了两遍客户端才发现是主控侧的问题）。
 *
 * 现在名字与 `assistOnly`（→ `disable_relay_data`）变更都会 bump，且**同名重复保存不会**空转
 * （避免白重启一次节点核心）。
 *
 * 用法（需要本机 8787 主控在跑 + 开发库）：
 *   node scripts/check-node-config-revision.mjs
 *   MCLINK_MASTER=http://127.0.0.1:8787 MCLINK_ADMIN_PASSWORD=xxx node scripts/check-node-config-revision.mjs
 *
 * 前置：管理员密码默认 `dev-only-passw0rd`（可用环境变量覆盖）。
 * 副作用：会注册一个临时节点并在结束时删掉它；那把一次性注册密钥会留在库里（未使用）。
 */
const MASTER = process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787';
const PASS = process.env.MCLINK_ADMIN_PASSWORD ?? 'dev-only-passw0rd';
const RUN = Date.now().toString(36).slice(-5);

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
const port = 12600 + (Number(Date.now().toString().slice(-3)) % 100);
const key = await api('/admin/nodes/enroll-key', {
  method: 'POST',
  token: admin.token,
  body: { note: `cfgrev ${RUN}`, host: '127.0.0.1' },
});
const node = await api('/agent/register', {
  method: 'POST',
  body: {
    enrollKey: key.enrollKey,
    name: `cfgrev-${RUN}`,
    region: 'cn-east',
    endpoint: `127.0.0.1:${port}`,
    listenPort: port,
    connectPort: port,
    capacityPeers: 500,
    version: 'verify',
  },
});
const nodeToken = node.nodeToken;
const id = node.node.id;

/** 节点此刻拿到的配置版本（agent 就是靠它决定要不要重启核心、应用新配置） */
const revisionSeenByNode = async () => (await api('/agent/config', { token: nodeToken }).catch(() => null))?.configRevision ?? null;

const before = await revisionSeenByNode();
check('刚注册的节点拿到配置版本', typeof before === 'number', `configRevision=${before}`);
check(
  '刚落地的生成配置里 hostname 是注册时的名字',
  (node.relayConfigToml ?? '').includes(`hostname = "cfgrev-${RUN}"`),
);

await api(`/admin/nodes/${id}`, { method: 'PATCH', token: admin.token, body: { name: `cfgrev-renamed-${RUN}` } });
const afterRename = await revisionSeenByNode();
check(
  '**改名后配置版本 +1**（节点下次心跳自动重下发并重启核心）',
  typeof afterRename === 'number' && typeof before === 'number' && afterRename > before,
  `${before} → ${afterRename}`,
);
const afterConfig = await api('/agent/config', { token: nodeToken });
check('重新下发的配置里 hostname 已是新名字', String(afterConfig.configToml ?? '').includes(`hostname = "cfgrev-renamed-${RUN}"`));

const beforeAssist = await revisionSeenByNode();
await api(`/admin/nodes/${id}`, { method: 'PATCH', token: admin.token, body: { assistOnly: true } });
const afterAssist = await revisionSeenByNode();
check(
  '**打开「只协助打洞」后配置版本 +1**',
  typeof afterAssist === 'number' && typeof beforeAssist === 'number' && afterAssist > beforeAssist,
  `${beforeAssist} → ${afterAssist}`,
);
const assistConfig = await api('/agent/config', { token: nodeToken });
check('配置里写上了 disable_relay_data', String(assistConfig.configToml ?? '').includes('disable_relay_data = true'));

/* ------------------------------------ 心跳：agent **唯一**会走的配置下发路径 */

/*
 * 这一段是"开了几小时还没生效"那次事故之后补的。
 *
 * agent 只调 `/agent/register`（注册时拿第一份配置）与 `/agent/heartbeat`，
 * **从不调 `/agent/config`**。上面那些断言全走拉取接口，所以"控制台改了、节点纹丝不动"
 * 这种 bug 一路绿灯通过 —— 测了一扇没人走的门。配置有没有真的到节点手上，
 * 只能这么验：拿心跳响应里的 configToml 看。
 */
const hb = (body) => api('/agent/heartbeat', { method: 'POST', token: nodeToken, body });

const revNow = await revisionSeenByNode();
const hbStale = await hb({ peers: 0, rooms: 0, rxBps: 0, txBps: 0, appliedConfigRevision: revNow - 1 });
check(
  '**节点版本落后时，心跳响应里带着新配置**（agent 靠它写盘并重启核心）',
  String(hbStale.configToml ?? '').includes(`hostname = "cfgrev-renamed-${RUN}"`) &&
    String(hbStale.configToml ?? '').includes('disable_relay_data = true'),
  `configRevision=${hbStale.configRevision}`,
);
const hbFresh = await hb({ peers: 0, rooms: 0, rxBps: 0, txBps: 0, appliedConfigRevision: revNow });
check('版本已一致时不再重复下发（避免白重启一次核心）', !hbFresh.configToml);
const hbOldAgent = await hb({ peers: 0, rooms: 0, rxBps: 0, txBps: 0 });
check(
  '老 agent（心跳不带 appliedConfigRevision）也能拿到配置 —— 自我疗愈',
  Boolean(hbOldAgent.configToml),
);

const beforeNoop = await revisionSeenByNode();
await api(`/admin/nodes/${id}`, { method: 'PATCH', token: admin.token, body: { name: `cfgrev-renamed-${RUN}` } });
const afterNoop = await revisionSeenByNode();
check('同名重复保存不会无谓地 +1（避免白重启一次核心）', afterNoop === beforeNoop, `${beforeNoop} → ${afterNoop}`);

await api(`/admin/nodes/${id}`, { method: 'DELETE', token: admin.token }).catch(() => {});
console.log(`\n结果：${pass} 通过 / ${fail} 失败（临时节点已删除）`);
process.exitCode = fail === 0 ? 0 : 1;
