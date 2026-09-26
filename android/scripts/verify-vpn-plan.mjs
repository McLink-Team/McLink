#!/usr/bin/env node
/**
 * `android/web/src/vpn-plan.ts` 的验证 —— **喂真实票据**，而不是喂手写的样例。
 *
 * ## 为什么必须是真实票据
 *
 * 手写的样例只能证明"我能解析我自己写的那段 TOML"。真正要回答的问题是：
 * **主控今天下发的这份 TOML，会不会被算成一个安全的启动计划。**
 * 这两件事的差别在字段名、引号风格、缩进、section 归属上 —— 生成器
 * （`server/src/easytier/config.ts` 的 `renderEasytierToml`）改一个字，
 * 手写样例照样绿，而手机上就是连不上或者整机断网。
 *
 * 所以这里的流程是真的：起本机主控 → 注册临时用户 → 建房 → `GET …/ticket`
 * → 把返回的 `configToml` 原样喂给 `plan()`。跑完把这个用户和房间删掉。
 *
 * ## 覆盖
 *
 *   1. 正例：真实票据算出的 address / routes / mtu / instanceName，并与票据里
 *      另外两个字段（`virtualIp` / `mtu`）**独立对账**（期望值不用被测代码算）；
 *   2. 宽容解析：单引号、多余空格、行尾注释都要能认；
 *   3. 负例：删掉 `ipv4`、`0.0.0.0/0`、`192.168.1.5/24`、空串、缺前缀、
 *      越界网段、前缀 < 8 —— 逐条必须返回 `no-routes`；
 *   4. 提交在仓库里的那份真实票据 fixture 仍然可用（防止它悄悄过期）。
 *
 * 用法：
 *   node android/scripts/verify-vpn-plan.mjs
 *
 * 退出码 0 = 全部通过。主控若已在 8787 上跑就复用它（此时只删本脚本造的行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createReporter } from './lib/browser.mjs';
import {
  ANDROID_ROOT,
  DEFAULT_MASTER,
  ensureMaster,
  purgeRows,
  resolveDbPath,
} from './lib/master.mjs';
// 直接 import .ts：Node 24 的 type stripping 原生就能跑（主控自己也是这么起的）。
// 这也是为什么这个模块能被单测 —— 它是纯函数，不依赖 Vite/Vue 的任何东西。
import { DEFAULT_MTU, MAX_ACCEPTED_PREFIX, MIN_ACCEPTED_PREFIX, ROOM_ROUTE_PREFIX, plan } from '../web/src/vpn-plan.ts';

const MASTER = (process.env.MCLINK_VPN_MASTER ?? DEFAULT_MASTER).trim().replace(/\/+$/, '');
const FIXTURE = path.join(ANDROID_ROOT, 'scripts', 'fixtures', 'ticket-real.toml');
const OUT_DIR = path.join(ANDROID_ROOT, '.smoke');

const r = createReporter('vpn-plan');

/* ------------------------------------------------ 期望值的独立算法 */

/**
 * 独立的 CIDR 解析 —— **刻意不复用 `vpn-plan.ts` 的任何东西**。
 *
 * 期望值如果用被测代码算出来，这个测试就变成了"它等于它自己"。
 * 这里只要能把 `10.200.7.3/24` 拆成 octet 与前缀就够了。
 */
function expectedFromTicket(virtualIp) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(virtualIp);
  if (!m) throw new Error(`票据里的 virtualIp 形状意外：${virtualIp}`);
  const [, a, b, c, d, prefix] = m.map((v) => Number(v));
  return {
    address: { ip: `${a}.${b}.${c}.${d}`, prefix },
    net: `${a}.${b}.${c}.0/${ROOM_ROUTE_PREFIX}`,
  };
}

/** 把 TOML 里那一行 `ipv4 = …` 换成别的（负例都是这么造的） */
function rewriteIpv4(toml, replacement) {
  const re = /^ipv4\s*=.*$/m;
  if (!re.test(toml)) throw new Error('真实票据里没有 ipv4 行 —— 生成器变了，先看 server/src/easytier/config.ts');
  return toml.replace(re, replacement);
}

const removeIpv4Line = (toml) => toml.replace(/^ipv4\s*=.*\r?\n/m, '');

/* ------------------------------------------------ 0. 起主控 */

let master;
try {
  master = await ensureMaster({ base: MASTER, log: r.log });
} catch (err) {
  console.error(`[vpn-plan] ✗ ${err.message}`);
  process.exit(2);
}

/** 无论后面成败，都要把这一步造的数据清掉 */
const created = { roomIds: [], userId: null, roomCodes: [] };
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  r.log('清理临时数据');
  if (master.owned) {
    await master.stop();
    // 临时数据目录整个删掉：数据从一开始就没进开发库，这是最彻底的清理
    if (master.dataDir) fs.rmSync(master.dataDir, { recursive: true, force: true });
    r.log(`已停掉临时主控并删除 ${master.dataDir}`);
  } else if (created.roomIds.length > 0 || created.userId) {
    const res = await purgeRows(
      resolveDbPath(),
      { roomIds: created.roomIds, userIds: created.userId ? [created.userId] : [] },
      r.log,
    );
    r.check('临时数据已从开发库里清掉', res.ok === true, JSON.stringify(res));
  }
}

try {
  /* ------------------------------------------------ 1. 真实票据 */

  const stamp = Date.now().toString(36);
  const username = `vpnplan${stamp}`;
  const password = 'vpnPlan-2026';
  r.log(`注册临时账号 ${username}`);
  let reg;
  try {
    reg = await master.api('/auth/register', {
      method: 'POST',
      body: { username, password, displayName: `VPN 票据校验 ${stamp.slice(-4)}` },
    });
  } catch (err) {
    /*
     * 复用一台**别人的**主控时最常见的失败：那台主控开着"必须验证邮箱"，
     * 而验证要真的发信。这不是本脚本能改的设置（人家是真实配置），所以把
     * 该怎么绕过说清楚，而不是抛一句 HTTP 400。
     */
    if (/验证邮箱|邮箱地址/.test(String(err.message))) {
      throw new Error(
        `${err.message}\n` +
          `      ${MASTER} 上的主控要求验证邮箱，脚本无法自助注册。两条路：\n` +
          `        · 停掉它，让本脚本起自己的临时主控（会自动关掉这条开关）：Stop-Process 之后重跑；\n` +
          `        · 或者换一个已经在跑、允许直接注册的主控：$env:MCLINK_VPN_MASTER='http://127.0.0.1:<端口>'`,
      );
    }
    throw err;
  }
  const token = reg.token;
  created.userId = reg.user?.id ?? null;

  /*
   * 建**两个**房间。
   *
   * 为什么要两个：房间网段是按空闲 slot 分配的（`packages/shared/src/virtualnet.ts`
   * 的 allocateSlot，取最小可用值），所以**第一个房间的 slot 恒为 0** ——
   * 只建一个房间的话，"routes 是 10.200.<slot>.0/24"这条断言其实只在 slot=0 上跑过，
   * 一个把 slot 写死成 0 的实现也能全绿。第二个房间拿到 slot=1，
   * 两张票据各自算出各自的网段，才算真的验了这条规则。
   */
  const tickets = [];
  for (const label of ['一', '二']) {
    r.log(`建房（第${label}个）`);
    const room = await master.api('/rooms', {
      method: 'POST',
      token,
      body: { name: `票据校验${label} ${stamp.slice(-4)}`, zone: 'auto', visibility: 'hidden', listenPort: 21480 },
    });
    created.roomIds.push(room.room.id);
    created.roomCodes.push(room.room.code);

    r.log(`取票据（第${label}个）`);
    const ticket = await master.api(`/rooms/${room.room.id}/ticket?listenPort=21480&rpcPort=21481`, { token });
    if (typeof ticket.configToml !== 'string' || ticket.configToml.length === 0) {
      throw new Error('票据里没有 configToml');
    }
    tickets.push({ label, ticket, toml: ticket.configToml, expected: expectedFromTicket(ticket.virtualIp) });
  }

  const { ticket, toml, expected } = tickets[0];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dumpPath = path.join(OUT_DIR, 'vpn-ticket.last.toml');
  fs.writeFileSync(dumpPath, toml, 'utf8');

  /* ------------------------------------------------ 2. 正例 */

  r.log('正例 1 —— 真实票据（两个房间，各自的网段各自算）');
  for (const t of tickets) {
    const tag = `第${t.label}个房间`;
    r.check(
      `${tag}：票据 TOML 里确实有 \`ipv4 = "…"\` 这一行（否则下面的断言没有意义）`,
      /^ipv4\s*=\s*"[\d.]+\/\d+"\s*$/m.test(t.toml),
      t.toml.split(/\r?\n/).find((l) => l.startsWith('ipv4')) ?? '（没有这一行）',
    );
    r.check(
      `${tag}：票据 TOML 的 [flags] 里确实有 \`mtu = …\``,
      /^mtu\s*=\s*\d+\s*$/m.test(t.toml),
      t.toml.split(/\r?\n/).find((l) => l.startsWith('mtu')) ?? '（没有这一行）',
    );
    r.log(`  ${tag}票据：instanceName=${t.ticket.instanceName} virtualIp=${t.ticket.virtualIp} mtu=${t.ticket.mtu}`);

    const live = plan({ configToml: t.toml, instanceName: t.ticket.instanceName });
    if (!live.ok) {
      r.check(`${tag}：真实票据能算出启动计划`, false, `被拒：${live.code} / ${live.message}`);
      continue;
    }
    const p = live.plan;
    r.check(`${tag}：真实票据能算出启动计划`, true);
    r.log(
      `  ${tag}算出的计划：address=${p.address.ip}/${p.address.prefix} ` +
        `routes=${p.routes.map((x) => `${x.ip}/${x.prefix}`).join(',')} mtu=${p.mtu}`,
    );
    r.check(
      `${tag}：address 与票据 virtualIp 一致`,
      p.address.ip === t.expected.address.ip && p.address.prefix === t.expected.address.prefix,
      `期望 ${t.expected.address.ip}/${t.expected.address.prefix}，实际 ${p.address.ip}/${p.address.prefix}`,
    );
    r.check(
      `${tag}：routes 恰有一条 /${ROOM_ROUTE_PREFIX} 房间网段，且是网络地址（末位 .0）`,
      p.routes.length === 1 && `${p.routes[0].ip}/${p.routes[0].prefix}` === t.expected.net,
      `期望 ${t.expected.net}，实际 ${JSON.stringify(p.routes)}`,
    );
    r.check(
      `${tag}：routes 落在 10.200.0.0/16 内（契约 §4 第 2 条）`,
      p.routes.every((x) => x.ip.startsWith('10.200.')),
      JSON.stringify(p.routes),
    );
    r.check(`${tag}：没有出现 0.0.0.0/0`, !p.routes.some((x) => x.ip === '0.0.0.0' && x.prefix === 0), JSON.stringify(p.routes));
    r.check(`${tag}：mtu 与票据一致（1380）`, p.mtu === t.ticket.mtu && p.mtu === 1380, `期望 ${t.ticket.mtu}，实际 ${p.mtu}`);
    r.check(
      `${tag}：instanceName 与票据一致`,
      p.instanceName === t.ticket.instanceName,
      `期望 ${t.ticket.instanceName}，实际 ${p.instanceName}`,
    );
  }
  r.check(
    '两个房间拿到了不同的网段（证明 slot 是从票据里读的，不是写死的）',
    tickets.length === 2 && tickets[0].expected.net !== tickets[1].expected.net,
    tickets.map((t) => t.expected.net).join(' vs '),
  );

  /* ------------------------------------------------ 3. 宽容解析 */

  r.log('正例 2 —— 宽容：单引号 + 多余空格 + 行尾注释');
  const tolerantToml = rewriteIpv4(toml, `ipv4   =   '${expected.address.ip}/${expected.address.prefix}'   # 手工改过`);
  const tolerant = plan({ configToml: tolerantToml, instanceName: ticket.instanceName });
  r.check(
    '单引号 / 空格 / 行尾注释都能解析出同一个地址',
    tolerant.ok === true &&
      tolerant.plan.address.ip === expected.address.ip &&
      tolerant.plan.routes[0].ip === expected.net.split('/')[0],
    tolerant.ok ? JSON.stringify(tolerant.plan.address) : `${tolerant.code}: ${tolerant.message}`,
  );

  r.log('正例 3 —— `#` 出现在 network_secret 里时不会把行截断');
  // 真实生成器会写 network_secret = "<随机串>"，随机串里完全可能有 #
  const hashToml = toml.replace(/^network_secret\s*=.*$/m, 'network_secret = "ab#cd#ef"');
  const hashPlan = plan({ configToml: hashToml, instanceName: ticket.instanceName });
  r.check(
    'secret 里的 # 不影响 ipv4 的解析',
    hashPlan.ok === true && hashPlan.plan.address.ip === expected.address.ip,
    hashPlan.ok ? JSON.stringify(hashPlan.plan.address) : `${hashPlan.code}: ${hashPlan.message}`,
  );

  r.log('正例 4 —— mtu 缺失 / 越界时回落到 EasyTier 默认值（不拒绝）');
  const noMtu = plan({ configToml: toml.replace(/^mtu\s*=.*\r?\n/m, ''), instanceName: ticket.instanceName });
  r.check(
    `mtu 行缺失 → 仍能算出计划，mtu 回落到 ${DEFAULT_MTU}`,
    noMtu.ok === true && noMtu.plan.mtu === DEFAULT_MTU,
    noMtu.ok ? `mtu=${noMtu.plan.mtu}` : `${noMtu.code}: ${noMtu.message}`,
  );
  const bigMtu = plan({ configToml: toml.replace(/^mtu\s*=.*$/m, 'mtu = 99999'), instanceName: ticket.instanceName });
  r.check(
    'mtu 越界（99999）→ 回落而不是照抄',
    bigMtu.ok === true && bigMtu.plan.mtu === DEFAULT_MTU,
    bigMtu.ok ? `mtu=${bigMtu.plan.mtu}` : `${bigMtu.code}: ${bigMtu.message}`,
  );

  r.log(`正例 5 —— 前缀下界是闭区间：/${MIN_ACCEPTED_PREFIX} 放行，/${MIN_ACCEPTED_PREFIX - 1} 拒绝`);
  const atLower = plan({ configToml: rewriteIpv4(toml, `ipv4 = "10.200.7.3/${MIN_ACCEPTED_PREFIX}"`), instanceName: ticket.instanceName });
  r.check(
    `前缀 /${MIN_ACCEPTED_PREFIX}（下界本身）→ 放行，且路由仍是 /${ROOM_ROUTE_PREFIX} 房间网段`,
    atLower.ok === true && atLower.plan.routes.length === 1 && atLower.plan.routes[0].prefix === ROOM_ROUTE_PREFIX,
    atLower.ok ? JSON.stringify(atLower.plan.routes) : `${atLower.code}: ${atLower.message}`,
  );

  /* ------------------------------------------------ 4. 负例 */

  r.log('负例 —— 每一条都必须返回 no-routes（契约 §4 第 1、2 条）');

  const negatives = [
    ['删掉整个 ipv4 行', removeIpv4Line(toml)],
    ['ipv4 = "0.0.0.0/0"', rewriteIpv4(toml, 'ipv4 = "0.0.0.0/0"')],
    ['ipv4 = "192.168.1.5/24"', rewriteIpv4(toml, 'ipv4 = "192.168.1.5/24"')],
    ['整份 TOML 是空串', ''],
    ['ipv4 = ""', rewriteIpv4(toml, 'ipv4 = ""')],
    ['ipv4 没有前缀（10.200.7.3）', rewriteIpv4(toml, 'ipv4 = "10.200.7.3"')],
    ['前缀 /0（0.0.0.0/0 的另一种写法）', rewriteIpv4(toml, 'ipv4 = "10.200.7.3/0"')],
    [`前缀 /${MIN_ACCEPTED_PREFIX - 1}（小于允许的最小值）`, rewriteIpv4(toml, `ipv4 = "10.200.7.3/${MIN_ACCEPTED_PREFIX - 1}"`)],
    [`前缀 /${MAX_ACCEPTED_PREFIX + 1}（大于允许的最大值）`, rewriteIpv4(toml, `ipv4 = "10.200.7.3/${MAX_ACCEPTED_PREFIX + 1}"`)],
    ['前缀 /32（主机路由，只覆盖自己一个 IP）', rewriteIpv4(toml, 'ipv4 = "10.200.7.3/32"')],
    ['前缀 /30（比房间 /24 还窄）', rewriteIpv4(toml, 'ipv4 = "10.200.7.3/30"')],
    ['同前缀但网段越界（10.201.7.3/24）', rewriteIpv4(toml, 'ipv4 = "10.201.7.3/24"')],
    ['私有网段但不是我们的（172.16.9.4/24）', rewriteIpv4(toml, 'ipv4 = "172.16.9.4/24"')],
    ['octet 越界（10.200.7.999/24）', rewriteIpv4(toml, 'ipv4 = "10.200.7.999/24"')],
    ['前缀根本不存在（10.200.7.3/33）', rewriteIpv4(toml, 'ipv4 = "10.200.7.3/33"')],
    ['不是地址（ipv4 = "auto"）', rewriteIpv4(toml, 'ipv4 = "auto"')],
    ['ipv4 落在别的 section 里（[network_identity]）', toml.replace(/^ipv4\s*=.*\r?\n/m, '').replace('[network_identity]', '[network_identity]\nipv4 = "10.200.7.3/24"')],
  ];

  for (const [label, mutated] of negatives) {
    const out = plan({ configToml: mutated, instanceName: ticket.instanceName });
    const ok = out.ok === false && out.code === 'no-routes';
    r.check(`${label} → no-routes`, ok, out.ok ? `竟然成功了：${JSON.stringify(out.plan)}` : `实际 code=${out.code}`);
  }

  r.log('负例 —— 非字符串入参不许抛异常');
  for (const [label, bad] of [
    ['configToml 为 undefined', { configToml: undefined, instanceName: 'x' }],
    ['configToml 为 null', { configToml: null, instanceName: 'x' }],
    ['configToml 为数字', { configToml: 12345, instanceName: 'x' }],
    ['整个入参为 null', null],
  ]) {
    let threw = null;
    let out = null;
    try {
      out = plan(bad);
    } catch (err) {
      threw = err;
    }
    r.check(
      `${label} → 返回 no-routes 而不是抛异常`,
      threw === null && out?.ok === false && out.code === 'no-routes',
      threw ? `抛了：${threw.message}` : JSON.stringify(out),
    );
  }

  /* ------------------------------------------------ 5. 提交在仓库里的 fixture */

  r.log('fixture —— 仓库里那份真实票据仍然可用');
  if (!fs.existsSync(FIXTURE)) {
    r.check(`fixture 存在（${path.relative(ANDROID_ROOT, FIXTURE)}）`, false, '缺文件；接线测试会用到它');
  } else {
    const fixed = plan({ configToml: fs.readFileSync(FIXTURE, 'utf8'), instanceName: 'mclink-fixture' });
    r.check(
      'fixture 能算出 10.200.x.0/24 的房间网段',
      fixed.ok === true && fixed.plan.routes.length === 1 && /^10\.200\.\d+\.0$/.test(fixed.plan.routes[0].ip),
      fixed.ok ? JSON.stringify(fixed.plan.routes) : `${fixed.code}: ${fixed.message}`,
    );
    r.check('fixture 里没有 0.0.0.0/0', fixed.ok === true && !fixed.plan.routes.some((x) => x.prefix === 0));
  }

  r.log(`真实票据已留档：${dumpPath}`);
} catch (err) {
  r.check('脚本没有中途抛异常', false, String(err?.stack ?? err));
} finally {
  await cleanup();
}

console.log('');
r.log(r.failures === 0 ? '全部通过 ✓' : `${r.failures} 项未通过 ✗`);
process.exit(r.failures === 0 ? 0 : 1);
