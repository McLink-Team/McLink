#!/usr/bin/env node
/**
 * 打真接口检查：**签发节点命令时的"主控对外地址"**。
 *
 * 为什么要它（用户实测踩到的 bug）：没配 `MCLINK_PUBLIC_BASE_URL` 的部署里，控制台签发的
 * 安装命令是 `curl -fsSL http://127.0.0.1:8787/agent/install.sh` —— 节点装完指向**它自己**。
 * 根因：兜底直接写死了 `127.0.0.1:<port>`（`MCLINK_RELAY_PUBLIC_HOST` 随"主控中继"废弃之后，
 * 那条兜底就成了唯一去向）；而且直连主控时协议还被默认成 https，生成 `https://127.0.0.1:8787`。
 *
 * 为什么必须打真接口：地址解析依赖**请求头**（`Host` / `x-forwarded-*`），纯函数单测只能覆盖
 * 传入的那些头，覆盖不到"路由有没有把请求头传进来"。所以这里用 `node:http` 自己造请求头。
 *
 * 用法（需要本机 8787 主控在跑）：
 *   node scripts/check-node-cmd-origin.mjs
 *   MCLINK_PORT=8787 MCLINK_ADMIN_PASSWORD=xxx node scripts/check-node-cmd-origin.mjs
 *
 * 副作用：会签发两把一次性注册密钥（未使用，留在库里）。
 */
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MCLINK_PORT ?? 8787);
const PASS = process.env.MCLINK_ADMIN_PASSWORD ?? 'dev-only-passw0rd';

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
            resolve({ status: res.statusCode, json: null, raw: data.slice(0, 200) });
          }
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const login = await req('POST', '/api/v1/auth/login', { body: { username: 'admin', password: PASS } });
if (login.status !== 200) {
  console.error(`✗ 登录失败：HTTP ${login.status}（主控没跑？密码不对？见文件头的环境变量）`);
  process.exit(2);
}
const token = login.json.data.token;

/** ① 直连主控（只有 Host）：命令里只能是本机地址 —— 但**必须带警告**，不能默默给出去 */
const local = await req('POST', '/api/v1/admin/nodes/enroll-key', {
  token,
  body: { note: 'origin-check local', host: '127.0.0.1' },
  headers: { host: '127.0.0.1:8787' },
});
const localCmd = String(local.json?.data?.command ?? '');
const localWarn = local.json?.data?.warning ?? null;
check(
  '直连主控：命令里是本机地址**且协议是 http**（曾经错成 https://127.0.0.1:8787）',
  localCmd.includes('http://127.0.0.1:8787/agent/install.sh'),
  localCmd.split('|')[0].trim(),
);
check(
  '直连主控：**返回警告**（这条命令在节点上跑不通，界面必须显示）',
  typeof localWarn === 'string' && localWarn.length > 10,
  `${String(localWarn).slice(0, 36)}…`,
);

/** ② 反向代理（Host 是内网、x-forwarded-* 是公网）：命令必须用公网地址，且不报警 */
const viaProxy = await req('POST', '/api/v1/admin/nodes/enroll-key', {
  token,
  body: { note: 'origin-check public', host: 'node1.example.com' },
  headers: { host: '10.0.0.5:8787', 'x-forwarded-host': 'cnnic.link', 'x-forwarded-proto': 'https' },
});
const proxyCmd = String(viaProxy.json?.data?.command ?? '');
check(
  '反代访问：命令里用的是**公网地址**（这就是修好的那条）',
  proxyCmd.includes('https://cnnic.link/agent/install.sh') && proxyCmd.includes('--master https://cnnic.link'),
  proxyCmd.split('|')[0].trim(),
);
check('反代访问：不再有警告', !viaProxy.json?.data?.warning, String(viaProxy.json?.data?.warning ?? '(无)'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
