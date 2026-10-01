#!/usr/bin/env node
/**
 * 打真接口检查：**控制台里的「可信反向代理」设置真的生效**（不只是存进库）。
 *
 * 背景（用户实测痛点）：`MCLINK_TRUSTED_PROXIES` / `MCLINK_TRUST_PROXY` 以前只能改
 * `/etc/mclink/mclink.env`，而升级脚本会重写那个文件 —— 每升一次级就要 SSH 上去再改一遍。
 * 现在它们进了平台设置（存库、升级不受影响），环境变量降级为"首次安装的初值"。
 *
 * 这个脚本验的是**整条链路**：PATCH 设置 → 下一个请求的真实 IP 判定 → 审计行里的 ip。
 * 用法：先 `pnpm dev:server`，再 `node scripts/check-trusted-proxies.mjs`。
 *
 * 副作用：会临时改一次平台设置（跑完还原），并写入几条登录审计。
 */
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MCLINK_PORT ?? 8787);
const PASS = process.env.MCLINK_ADMIN_PASSWORD ?? 'dev-only-passw0rd';
const SPOOF = '203.0.113.9'; // TEST-NET-3，绝不会是真地址

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
};

function req(method, path, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: HOST,
        port: PORT,
        method,
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, json: null, raw: data.slice(0, 160) });
          }
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const login = (headers) => req('POST', '/api/v1/auth/login', { body: { username: 'admin', password: PASS }, headers });
const patchSettings = (token, patch) => req('PATCH', '/api/v1/admin/settings', { token, body: patch });

/** 最近一条登录审计行里的 ip（证明真实 IP 判定用的是哪套规则） */
async function lastLoginIp(token) {
  const res = await req('GET', '/api/v1/admin/audit?limit=10', { token });
  const data = res.json?.data;
  // 审计列表可能是裸数组，也可能包在 {items|rows|list} 里
  const rows = Array.isArray(data)
    ? data
    : (data?.items ?? data?.rows ?? data?.list ?? data?.entries ?? []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return `(审计返回形状意外：${JSON.stringify(data)?.slice(0, 120)})`;
  }
  const row = rows.find((r) => String(r.action ?? '').includes('login'));
  return row ? String(row.ip ?? '(行里没有 ip 字段)') : '(审计里没有登录行)';
}

const health = await req('GET', '/api/v1/meta');
if (health.status !== 200) {
  console.error(`✗ 主控没起来（HTTP ${health.status}）`);
  process.exit(2);
}
const first = await login();
if (first.status !== 200) {
  console.error(`✗ 登录失败：HTTP ${first.status}`);
  process.exit(2);
}
const token = first.json.data.token;

const original = (await req('GET', '/api/v1/admin/settings', { token })).json?.data?.settings ?? {};
const restore = { trustProxy: original.trustProxy !== false, trustedProxies: original.trustedProxies ?? '' };

/* ① 写入合法值 → 应当被接受并原样读回 */
const okPatch = await patchSettings(token, { trustProxy: true, trustedProxies: '127.0.0.1/8,::1/128' });
check('PATCH 合法网段：接受', okPatch.status === 200, `HTTP ${okPatch.status}`);
const after = (await req('GET', '/api/v1/admin/settings', { token })).json?.data?.settings ?? {};
check(
  '读回一致（真的存进库了，不是只回显）',
  after.trustedProxies === '127.0.0.1/8,::1/128' && after.trustProxy === true,
  `trustedProxies=${JSON.stringify(after.trustedProxies)} trustProxy=${after.trustProxy}`,
);

/* ② 非法项要被拒（写错一个网段等于"配了但没生效"，是最难查的部署问题） */
const badPatch = await patchSettings(token, { trustedProxies: '127.0.0.1/8, 不是网段' });
check('PATCH 非法网段：被 400 拒绝', badPatch.status === 400, `HTTP ${badPatch.status}`);
const stillOk = (await req('GET', '/api/v1/admin/settings', { token })).json?.data?.settings ?? {};
check('被拒之后库里的值没被改坏', stillOk.trustedProxies === '127.0.0.1/8,::1/128', JSON.stringify(stillOk.trustedProxies));

/* ③ trustProxy=true（来源 127.0.0.1 在可信网段里）→ 伪造头会被采信 */
await patchSettings(token, { trustProxy: true, trustedProxies: '127.0.0.1/8,::1/128' });
await login({ 'x-forwarded-for': SPOOF });
const honored = await lastLoginIp(token);
check('trustProxy=true：转发头被采信（审计记的是伪造的那个地址）', honored === SPOOF, `审计 ip=${honored}`);

/* ④ trustProxy=false → 同一请求改记直连地址（伪造头整条忽略） */
await patchSettings(token, { trustProxy: false });
await login({ 'x-forwarded-for': SPOOF });
const ignored = await lastLoginIp(token);
check('trustProxy=false：转发头被忽略（审计记 127.0.0.1）', ignored === '127.0.0.1', `审计 ip=${ignored}`);

/* ⑤ 还原（这个脚本不该改变开发库的语义） */
const restored = await patchSettings(token, restore);
check('已还原原值', restored.status === 200, JSON.stringify(restore));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
