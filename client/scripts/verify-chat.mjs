#!/usr/bin/env node
/**
 * 开发期校验脚本：走真实主控接口，验证「房间聊天」的调用方式与返回结构
 * 是否与 client/src/components/ChatPanel.vue 的假设一致。
 *
 * 覆盖：
 *   1. 注册三个用户（房主 / 成员 / 非成员）
 *   2. 房主建房，成员凭加入码进房
 *   3. 房主发消息 → 成员 GET 能读到（结构、字段）
 *   4. 非成员 GET → 403
 *   5. 成员尝试删房主消息 → 403
 *   6. 房主删成员消息 → 成功
 *   7. 500 字符截断与每分钟 20 条限流（429）的真实行为
 *   8. 收尾：关闭房间
 *
 * 用法：
 *   node client/scripts/verify-chat.mjs [masterUrl]
 *   默认 http://127.0.0.1:8787
 */
const BASE = (process.argv[2] ?? process.env.MCLINK_MASTER ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const STAMP = Date.now().toString(36);
const PASSWORD = `Vc${STAMP}Aa1`; // 至少 8 位，含字母与数字

const results = [];
let failed = 0;

function record(ok, label, detail) {
  results.push({ ok, label, detail });
  if (!ok) failed += 1;
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark} ${label}${detail ? `\n      ${detail}` : ''}`);
}

async function call(method, path, { token, body, query } = {}) {
  const url = new URL(`${API}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  // 主控统一包一层 { ok, data }；unwrap 后与 client/src/lib/api.ts 行为一致
  const data =
    payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  return { status: res.status, data, payload };
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

async function main() {
  console.log(`mclink 聊天接口校验 —— ${BASE}`);
  console.log(`用户后缀：${STAMP}（密码：${PASSWORD}）`);

  /* ---------------------------------------------------------- 注册 */
  section('注册与登录');
  const users = {};
  for (const role of ['host', 'member', 'outsider']) {
    const username = `vc${STAMP}${role.slice(0, 1)}`;
    const reg = await call('POST', '/auth/register', {
      body: { username, password: PASSWORD, displayName: `校验-${role}` },
    });
    if (reg.status !== 200 && reg.status !== 201) {
      record(false, `注册 ${role}`, `HTTP ${reg.status}：${JSON.stringify(reg.data)}`);
      return;
    }
    const token = reg.data?.token;
    record(typeof token === 'string' && token.length > 0, `注册 ${role} 并拿到 token`, `username=${username}`);
    users[role] = { username, token, userId: reg.data?.user?.id };
  }

  const host = users.host;
  const member = users.member;
  const outsider = users.outsider;

  /* ------------------------------------------------------------ 建房 */
  section('建房 / 进房');
  const created = await call('POST', '/rooms', {
    token: host.token,
    body: { name: `聊天校验 ${STAMP}`, zone: 'auto', access: 'open', visibility: 'hidden', listenPort: 21100 },
  });
  const room = created.data?.room;
  if (!room?.id || !room?.code) {
    record(false, '房主建房', `HTTP ${created.status}：${JSON.stringify(created.data)}`);
    return;
  }
  record(true, '房主建房成功', `roomId=${room.id} code=${room.code}`);

  const joined = await call('POST', '/rooms/join', {
    token: member.token,
    body: { code: room.code, deviceName: '校验成员机', listenPort: 21101 },
  });
  record(
    joined.status === 200 && joined.data?.room?.id === room.id,
    '成员凭加入码进房',
    `HTTP ${joined.status} pending=${joined.data?.pending} ticket=${joined.data?.ticket ? '有' : '无'}`,
  );

  /* ---------------------------------------------------------- 聊天 */
  section('聊天：发送 / 读取');
  const hostMsg = await call('POST', `/rooms/${room.id}/messages`, {
    token: host.token,
    body: { body: `房主说话 ${STAMP}` },
  });
  const m1 = hostMsg.data;
  record(
    hostMsg.status === 200 && typeof m1?.id === 'number' && m1?.kind === 'text' && m1?.role === 'host',
    '房主发消息，返回完整 ChatMessage',
    JSON.stringify(m1),
  );

  const memberMsg = await call('POST', `/rooms/${room.id}/messages`, {
    token: member.token,
    body: { body: `成员说话 ${STAMP}` },
  });
  const m2 = memberMsg.data;
  record(
    memberMsg.status === 200 && m2?.role === 'member' && m2?.userId === member.userId,
    '成员发消息（role=member，userId 正确）',
    JSON.stringify(m2),
  );

  const list = await call('GET', `/rooms/${room.id}/messages`, { token: member.token, query: { limit: 100 } });
  const messages = list.data?.messages ?? [];
  record(
    list.status === 200 && Array.isArray(messages) && messages.some((m) => m.id === m1.id),
    '成员 GET ?limit=100 能读到房主的消息',
    `条数=${messages.length} keepPerRoom=${list.data?.keepPerRoom} maxBodyChars=${list.data?.maxBodyChars}`,
  );
  record(
    JSON.stringify(Object.keys(messages[0] ?? {}).sort()) ===
      JSON.stringify(['body', 'createdAt', 'displayName', 'id', 'kind', 'role', 'roomId', 'userId']),
    '字段与 ChatMessage 契约一致',
    `keys=${Object.keys(messages[0] ?? {}).sort().join(',')}`,
  );

  const since = await call('GET', `/rooms/${room.id}/messages`, {
    token: member.token,
    query: { sinceId: m2.id, limit: 100 },
  });
  record(
    since.status === 200 && Array.isArray(since.data?.messages) && since.data.messages.length === 0,
    'sinceId=最后一条 → 增量返回空（重连补齐语义）',
    `返回 ${since.data?.messages?.length ?? '?'} 条`,
  );

  /* -------------------------------------------------------- 权限 */
  section('权限：非成员 / 删消息');
  const outsiderList = await call('GET', `/rooms/${room.id}/messages`, { token: outsider.token });
  record(
    outsiderList.status === 403,
    '非成员 GET 消息 → 403',
    `HTTP ${outsiderList.status} ${JSON.stringify(outsiderList.data)}`,
  );

  const memberDelHost = await call('DELETE', `/rooms/${room.id}/messages/${m1.id}`, { token: member.token });
  record(
    memberDelHost.status === 403,
    '成员删房主消息 → 403（只能删自己的）',
    `HTTP ${memberDelHost.status} ${JSON.stringify(memberDelHost.data)}`,
  );

  const memberDelOwn = await call('DELETE', `/rooms/${room.id}/messages/${m2.id}`, { token: member.token });
  record(memberDelOwn.status === 200, '成员删自己的消息 → 成功', `HTTP ${memberDelOwn.status} ${JSON.stringify(memberDelOwn.data)}`);

  const hostDelMember = await call('DELETE', `/rooms/${room.id}/messages/${m2.id}`, { token: host.token });
  record(
    hostDelMember.status === 404,
    '房主删已被成员删掉的消息 → 404（幂等语义）',
    `HTTP ${hostDelMember.status} ${JSON.stringify(hostDelMember.data)}`,
  );

  const m3 = await call('POST', `/rooms/${room.id}/messages`, { token: member.token, body: { body: `待房主删除 ${STAMP}` } });
  const hostDelMember2 = await call('DELETE', `/rooms/${room.id}/messages/${m3.data?.id}`, { token: host.token });
  record(
    hostDelMember2.status === 200 && hostDelMember2.data?.ok === true,
    '房主删成员消息 → 成功（返回 { ok: true }）',
    `HTTP ${hostDelMember2.status} ${JSON.stringify(hostDelMember2.data)}`,
  );

  const afterDel = await call('GET', `/rooms/${room.id}/messages`, { token: member.token, query: { limit: 100 } });
  record(
    !(afterDel.data?.messages ?? []).some((m) => m.id === m3.data?.id),
    '删除后列表里不再出现该消息',
    `剩余 ${afterDel.data?.messages?.length ?? '?'} 条`,
  );

  /* ---------------------------------------------------------- 限制 */
  section('限制：500 字符截断 / 每分钟 20 条');
  const longBody = 'x'.repeat(600);
  const clamped = await call('POST', `/rooms/${room.id}/messages`, { token: host.token, body: { body: longBody } });
  const clampedText = typeof clamped.data?.body === 'string' ? clamped.data.body : '';
  record(
    clamped.status === 200 && [...clampedText].length === 501 && clampedText.endsWith('…'),
    '超过 500 字符时按码点截断并追加省略号',
    `请求 600 字符 → 返回 ${[...clampedText].length} 个码点`,
  );

  let rateLimitedAt = 0;
  let lastStatus = 0;
  for (let i = 1; i <= 25; i += 1) {
    const res = await call('POST', `/rooms/${room.id}/messages`, {
      token: host.token,
      body: { body: `限流探测 ${i}` },
    });
    lastStatus = res.status;
    if (res.status === 429) {
      rateLimitedAt = i;
      record(
        res.data?.error?.code === 'rate_limited',
        `连续发言触发限流 → 429（第 ${i} 次）`,
        `error.code=${res.data?.error?.code} message=${res.data?.error?.message}`,
      );
      break;
    }
    if (res.status !== 200) {
      record(false, `第 ${i} 次发言异常`, `HTTP ${res.status} ${JSON.stringify(res.data)}`);
      break;
    }
  }
  if (rateLimitedAt === 0) {
    record(false, '未触发限流（25 次发言全部成功）', `最后一次 HTTP ${lastStatus}——与「每分钟 20 条」的描述不符`);
  }

  /* ---------------------------------------------------------- 收尾 */
  section('收尾');
  const leave = await call('POST', `/rooms/${room.id}/leave`, { token: member.token });
  record(leave.status === 200, '成员退出房间', `HTTP ${leave.status}`);
  const closed = await call('POST', `/rooms/${room.id}/close`, { token: host.token });
  record(closed.status === 200, '房主关闭房间（清理测试数据）', `HTTP ${closed.status}`);

  const afterClose = await call('GET', `/rooms/${room.id}/messages`, { token: host.token });
  // 这一条只是记录真实行为（关闭房间后是否还能读历史），不作为通过/失败判据
  console.log(`  · 房间关闭后 GET 历史消息 → HTTP ${afterClose.status} ${JSON.stringify(afterClose.data).slice(0, 160)}`);

  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`);
  if (failed > 0) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.label}${r.detail ? `：${r.detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log('全部通过：客户端 ChatPanel 的调用方式与返回结构与主控一致。');
  }
}

main().catch((err) => {
  console.error('\n校验脚本异常终止：', err);
  process.exitCode = 1;
});
