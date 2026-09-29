/**
 * 单元测试：跑 `pnpm test`（node --test）。
 *
 * 覆盖那些「错了会导致线上静默故障」的纯逻辑：
 *   - 生成给 EasyTier 的 TOML（字段名、u64 以字符串写出、转义）
 *   - ACL 构造（踢人黑名单、严格端口、限速单位是 pps）
 *   - 虚拟网段地址规划（房主 .1、成员 .2 起、槽位回收）
 *   - easytier-cli 输出解析（人类可读数值、延迟占位符）
 *   - 房间准入密码的哈希与校验
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { renderAcl, renderEasytierToml, buildLaunchArgs, tomlString, aclToJson, rpcPortalForListenPort, usableRpcPort } from '../src/easytier/config.ts';
import { buildRoomAcl, isAclEmpty } from '../src/easytier/acl.ts';
import { parseHumanNumber, parseLatencyMs } from '../src/easytier/manager.ts';
import { hashRoomPassword, verifyRoomPassword, deriveNetworkName, resolveMemberLink, relayScore, nextRoomExpiry, selectRelays, pickRoomRelays, LATENCY_TIE_BAND_MS, RoomService, type RelayCandidate } from '../src/services/rooms.ts';
import { Db } from '../src/db/index.ts';
import { NodeRepo } from '../src/db/nodes.ts';
import { RoomRepo } from '../src/db/rooms.ts';
import { UserRepo } from '../src/db/users.ts';
import { TrafficLedgerRepo, localDay } from '../src/db/traffic.ts';
import { TrafficAccountant } from '../src/services/traffic-ledger.ts';
import { ewma, NodeUtilization, shedUtilFor, UTIL_SHED } from '../src/services/node-utilization.ts';
import { parseLatencyHints, parsePolicy } from '../src/api/helpers.ts';
import {
  buildMessage,
  encodeHeader,
  maskAuthLine,
  parseCapabilities,
  type SmtpConfig,
} from '../src/mail/smtp.ts';
import { resolveFrom } from '../src/services/mailer.ts';
import { emailGateProblem } from '../src/services/email-gate.ts';
import { normalizePort, mergeRelayedNetworks, nextNodeStatus } from '../src/services/nodes.ts';
import { isDecorationLine } from '../src/easytier/process.ts';
import { DEFAULT_SETTINGS, clientArtifactName } from '../src/services/settings.ts';
import { endpointHost, endpointPort, nodeClientEndpoint, nodeConnectPort, nodeListenPort } from '../src/db/nodes.ts';
import type { NodeRow } from '../src/db/nodes.ts';
import type { UserRow } from '../src/db/users.ts';
import {
  DEFAULT_ROOM_POLICY,
  allocateSeat,
  allocateSlot,
  BLOCKED_WORDS,
  displayNameProblem,
  EMAIL_CODE_PATTERN,
  emailProblem,
  hostIpCidr,
  kbpsToBps,
  kbpsToBytesPerSecond,
  memberIpCidr,
  memberIpForSlot,
  normalizeDisplayName,
  normalizeEmailCode,
  slotFromIp,
  subnetForSlot,
  type RelayLatencyHint,
  generateNetworkSecret,
  generateRoomCode,
  passwordProblem,
  reconnectDelayMs,
  parseUsernameList,
  BROADCAST_USERNAME_MAX,
} from '@mclink/shared';
import { randomBytes } from 'node:crypto';

const randomBytesBuf = (n: number) => randomBytes(n);

describe('EasyTier TOML 生成', () => {
  test('顶层字段与网络身份按 EasyTier 的 schema 输出', () => {
    const toml = renderEasytierToml({
      instanceName: 'mclink-relay',
      hostname: 'relay-1',
      dhcp: true,
      listeners: ['tcp://0.0.0.0:11010', 'udp://0.0.0.0:11010'],
      peers: [{ uri: 'tcp://peer.example.com:11010' }],
      networkName: 'mclink-room-abc',
      networkSecret: 'secret-value',
      flags: { noTun: true, bindDevice: false },
    });
    assert.match(toml, /^instance_name = "mclink-relay"$/m);
    assert.match(toml, /^listeners = \["tcp:\/\/0\.0\.0\.0:11010", "udp:\/\/0\.0\.0\.0:11010"\]$/m);
    assert.match(toml, /^\[network_identity\]$/m);
    assert.match(toml, /^network_name = "mclink-room-abc"$/m);
    assert.match(toml, /^network_secret = "secret-value"$/m);
    assert.match(toml, /^\[\[peer\]\]$/m);
    assert.match(toml, /^uri = "tcp:\/\/peer\.example\.com:11010"$/m);
    assert.match(toml, /^\[flags\]$/m);
    assert.match(toml, /^no_tun = true$/m);
    assert.match(toml, /^bind_device = false$/m);
  });

  test('u64 限速字段必须写成裸数字（加引号会让 easytier-core 启动即 panic）', () => {
    const toml = renderEasytierToml({
      instanceName: 'x',
      listeners: [],
      peers: [],
      networkName: 'n',
      networkSecret: 's',
      flags: { foreignRelayBpsLimit: 10_000_000, instanceRecvBpsLimit: 800_000, mtu: 1380 },
    });
    // 实测（easytier-core 2.6.4 --check-config）：
    //   `= 1000000`   → 通过
    //   `= "1000000"` → panic: invalid type: string "1000000", expected u64
    assert.match(toml, /^foreign_relay_bps_limit = 10000000$/m);
    assert.match(toml, /^instance_recv_bps_limit = 800000$/m);
    assert.ok(!/instance_recv_bps_limit = "/.test(toml), 'u64 字段不能带引号');
    assert.ok(!/foreign_relay_bps_limit = "/.test(toml), 'u64 字段不能带引号');
    assert.match(toml, /^mtu = 1380$/m);
  });

  test('rpc_portal 不写进配置文件（它不是 TOML 字段，会被静默忽略）', () => {
    const toml = renderEasytierToml({
      instanceName: 'x',
      listeners: [],
      peers: [],
      networkName: 'n',
      networkSecret: 's',
    });
    assert.ok(!toml.includes('rpc_portal'), 'rpc_portal 只能走命令行 -r');
  });

  test('命令行为 rpc-portal 生成正确的参数', () => {
    const args = buildLaunchArgs({
      configFile: '/etc/mclink/relay.toml',
      rpcPortal: '127.0.0.1:15888',
      rpcPortalWhitelist: ['127.0.0.1/32'],
    });
    assert.deepEqual(args, [
      '-c',
      '/etc/mclink/relay.toml',
      '-r',
      '127.0.0.1:15888',
      '--rpc-portal-whitelist',
      '127.0.0.1/32',
    ]);
  });

  test('TOML 字符串转义：引号、反斜杠与控制字符', () => {
    assert.equal(tomlString('a"b'), '"a\\"b"');
    assert.equal(tomlString('a\\b'), '"a\\\\b"');
    assert.equal(tomlString('a\nb'), '"a\\nb"');
    assert.equal(tomlString('a\u0001b'), '"a\\u0001b"');
  });
});

describe('RPC 端口：客户端上报优先，否则按监听端口推算', () => {
  test('rpc_portal 只能走命令行，且由监听端口推导时落在 16000 段', () => {
    // 与服务端一致的推算规则；房主 11010 → 16010，成员 11011 → 16011
    assert.equal(rpcPortalForListenPort(11010), 16010);
    assert.equal(rpcPortalForListenPort(11011), 16011);
    // 相差 1000 的倍数会撞车，这是刻意的取舍（见函数注释）
    assert.equal(rpcPortalForListenPort(11010), rpcPortalForListenPort(12010));
  });

  test('usableRpcPort 只接受 1024–65535 的整数', () => {
    assert.equal(usableRpcPort(17321), 17321);
    assert.equal(usableRpcPort(1024), 1024);
    assert.equal(usableRpcPort(65535), 65535);
    // 低端口要管理员权限，客户端本来也拿不到，一律拒绝
    assert.equal(usableRpcPort(80), null);
    assert.equal(usableRpcPort(1023), null);
    assert.equal(usableRpcPort(65536), null);
    assert.equal(usableRpcPort(0), null);
    assert.equal(usableRpcPort(-1), null);
    assert.equal(usableRpcPort(1.5), null);
    assert.equal(usableRpcPort(Number.NaN), null);
    assert.equal(usableRpcPort(null), null);
    assert.equal(usableRpcPort(undefined), null);
    // JSON 里端口写成字符串是常见误用：拒绝，而不是悄悄转成数字
    assert.equal(usableRpcPort('17321' as unknown as number), null);
  });

  test('固定网卡名写进 [flags].dev_name', () => {
    const toml = renderEasytierToml({
      instanceName: 'mclink-room',
      ipv4: '10.200.5.2/24',
      listeners: ['tcp://0.0.0.0:11012'],
      peers: [],
      networkName: 'n',
      networkSecret: 's',
      flags: { devName: 'McLink', noTun: false },
    });
    assert.match(toml, /^dev_name = "McLink"$/m);
    // 必须落在 [flags] 段内，否则 easytier-core 会当成未知顶层字段拒收
    assert.ok(toml.indexOf('[flags]') < toml.indexOf('dev_name = '), 'dev_name 必须在 [flags] 之后');
  });
});

describe('平台默认设置：品牌与下载地址', () => {
  test('品牌默认写成 McLink（登录页与验证邮件的标题都取它）', () => {
    assert.equal(DEFAULT_SETTINGS.siteName, 'McLink 联机');
  });

  test('默认下载地址与真实产物名一致', () => {
    // 产物名规则必须与 client/electron-builder.yml 的 artifactName 相同
    assert.equal(clientArtifactName('0.1.0'), 'McLink-Setup-0.1.0-x64.exe');
    // 曾经的默认值是 /downloads/mclink-client-setup.exe —— 这个文件从来不存在，
    // 于是全新部署上「下载客户端」按钮直接 404，且没有任何产物能拿到主产物排序
    assert.equal(
      DEFAULT_SETTINGS.clientDownloadUrl,
      `/downloads/${clientArtifactName(DEFAULT_SETTINGS.clientVersion)}`,
    );
  });
});

describe('房间 ACL 构造', () => {
  const base = {
    roomId: 'r_abc',
    hostIp: '10.200.5.1',
    memberCount: 3,
  };

  test('踢人：为每个被踢成员的虚拟 IP 生成高优先级 Drop 规则', () => {
    const acl = buildRoomAcl({
      ...base,
      policy: { ...defaultPolicy(), strictPorts: false, rateLimitPps: 0 },
      blockedIps: ['10.200.5.2', '10.200.5.3'],
    });
    const rules = acl.chains[0]!.rules;
    const drops = rules.filter((r) => r.action === 2);
    assert.equal(drops.length, 2);
    assert.deepEqual(drops[0]!.sourceIps, ['10.200.5.2/32']);
    assert.ok((drops[0]!.priority ?? 0) > 1000, '踢人规则必须优先级最高');
    assert.equal(acl.chains[0]!.defaultAction, 1, '默认放行，避免误伤玩法');
  });

  test('严格端口模式：默认丢弃，只放行白名单端口与 ICMP', () => {
    const acl = buildRoomAcl({
      ...base,
      policy: { ...defaultPolicy(), strictPorts: true, allowedPorts: ['25565'] },
      blockedIps: [],
    });
    const chain = acl.chains[0]!;
    assert.equal(chain.defaultAction, 2);
    const allowGame = chain.rules.find((r) => r.name === 'allow_game_ports');
    assert.deepEqual(allowGame?.ports, ['25565']);
    assert.ok(chain.rules.some((r) => r.protocol === 3), '要放行 ICMP 便于排障');
  });

  test('限速规则的 rate_limit 单位是包/秒，且带突发值', () => {
    const acl = buildRoomAcl({
      ...base,
      policy: { ...defaultPolicy(), rateLimitPps: 500 },
      blockedIps: [],
    });
    const rule = acl.chains[0]!.rules.find((r) => r.name === 'room_rate_limit');
    assert.equal(rule?.rateLimitPps, 500);
    assert.ok((rule?.burstLimit ?? 0) >= 500);
    const toml = renderAcl(acl).join('\n');
    assert.match(toml, /^rate_limit = 500$/m);
  });

  test('空 ACL 判定：无链即视为空', () => {
    assert.equal(isAclEmpty({ chains: [] }), true);
    assert.equal(isAclEmpty(buildRoomAcl({ ...base, policy: defaultPolicy(), blockedIps: [] })), false);
  });

  test('ACL 转 JSON 时字段用 snake_case（CLI 的 JSON 接口要求）', () => {
    const acl = buildRoomAcl({
      ...base,
      // 必须打开严格端口模式，规则列表才会非空 —— ACL 只在「有规则可写」时才产生 rules
      policy: { ...defaultPolicy(), strictPorts: true, allowedPorts: ['25565'] },
      blockedIps: [],
    });
    const json = aclToJson(acl) as Record<string, unknown>;
    const v1 = (json.acl as Record<string, unknown>).acl_v1 as Record<string, unknown>;
    const chains = v1.chains as Array<Record<string, unknown>>;
    const rules = chains[0]!.rules as Array<Record<string, unknown>>;
    assert.ok(rules.length > 0, '严格端口模式下应当生成放行规则');
    assert.ok('chain_type' in chains[0]!);
    assert.ok('default_action' in chains[0]!);
    assert.ok('source_ips' in rules[0]!);
    assert.ok('rate_limit' in rules[0]!);
  });

  function defaultPolicy() {
    return { ...DEFAULT_ROOM_POLICY };
  }
});

describe('虚拟网络地址规划', () => {
  test('房主 .1、成员从 .2 开始、网段按槽位划分', () => {
    assert.equal(subnetForSlot(7), '10.200.7.0/24');
    assert.equal(hostIpCidr(7), '10.200.7.1/24');
    assert.equal(memberIpCidr(7, 1), '10.200.7.2/24');
    assert.equal(memberIpForSlot(7, 253), '10.200.7.254');
  });

  test('非法入参要抛错，而不是静默给出错误地址', () => {
    assert.throws(() => subnetForSlot(256));
    assert.throws(() => subnetForSlot(-1));
    assert.throws(() => memberIpForSlot(1, 0), '座位 0 是房主专用');
    assert.throws(() => memberIpForSlot(1, 254));
  });

  test('从 IP 反解槽位，非本平台网段返回 null', () => {
    assert.equal(slotFromIp('10.200.7.3'), 7);
    assert.equal(slotFromIp('10.126.1.1'), null);
    assert.equal(slotFromIp('192.168.1.2'), null);
    assert.equal(slotFromIp('not-an-ip'), null);
  });

  test('槽位与座位的分配会跳过已占用项', () => {
    assert.equal(allocateSlot([0, 1, 2]), 3);
    assert.equal(allocateSlot([]), 0);
    assert.equal(allocateSeat([1, 2]), 3, '座位 0 保留给房主，成员从 1 开始');
    assert.equal(allocateSeat([]), 1);
  });
});

describe('easytier-cli 输出解析', () => {
  test('解析人类可读的字节数（含十进制与二进制单位）', () => {
    assert.equal(parseHumanNumber('17.33 kB'), 17330);
    assert.equal(parseHumanNumber('1.2 MiB'), 1.2 * 1024 ** 2);
    assert.equal(parseHumanNumber('2.5 GB'), 2.5e9);
    assert.equal(parseHumanNumber('512'), 512);
  });

  test('未知/空值返回 0，不能变成 NaN 污染统计', () => {
    assert.equal(parseHumanNumber('-'), 0);
    assert.equal(parseHumanNumber(''), 0);
    assert.equal(parseHumanNumber(undefined), 0);
    assert.equal(parseHumanNumber('abc'), 0);
    assert.equal(parseHumanNumber(1234), 1234);
  });

  test('延迟占位符返回 null（区分「0ms」与「未知」）', () => {
    assert.equal(parseLatencyMs('3.452'), 3.452);
    assert.equal(parseLatencyMs('-'), null);
    assert.equal(parseLatencyMs('*'), null);
    assert.equal(parseLatencyMs(undefined), null);
  });
});

describe('房间准入密码与网络身份', () => {
  test('准入密码哈希带算法前缀，校验对错分明', () => {
    const hash = hashRoomPassword('open-sesame');
    assert.match(hash, /^sha256\$/);
    assert.equal(verifyRoomPassword('open-sesame', hash), true);
    assert.equal(verifyRoomPassword('wrong', hash), false);
  });

  test('没有设置密码时视为放行（避免把 null 当成校验失败）', () => {
    assert.equal(verifyRoomPassword('anything', null), true);
  });

  test('网络名由密钥派生：不同密钥必有不同网络名，且不可从房间码推测', () => {
    const secretA = generateNetworkSecret(randomBytesBuf, 32);
    const secretB = generateNetworkSecret(randomBytesBuf, 32);
    const nameA = deriveNetworkName(secretA);
    const nameB = deriveNetworkName(secretB);
    assert.notEqual(nameA, nameB);
    assert.match(nameA, /^mclink-room-[0-9a-f]{32}$/, '必须是 128bit 十六进制令牌');
    assert.equal(deriveNetworkName(secretA), nameA, '同样输入必须稳定得到同样结果');
  });

  test('房间码与网络密钥都用 URL 安全字符且长度正确', () => {
    const code = generateRoomCode(randomBytesBuf);
    assert.match(code, /^[A-Z0-9]{6}$/);
    assert.ok(!/[01OI]/.test(code), '加入码不应包含易混淆字符');

    const secret = generateNetworkSecret(randomBytesBuf, 32);
    assert.equal(secret.length, 32);
    assert.match(secret, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(secret, generateNetworkSecret(randomBytesBuf, 32));
  });
});

describe('限速单位换算', () => {
  test('kbps → EasyTier 的字节/秒（关键：不是比特/秒，差 8 倍）', () => {
    // 依据：EasyTier 自己的 instance_recv_bps_limit_test 里配置 bps_limit * 1024，
    // 然后把实测吞吐换算成 KiB/s 与 bps_limit 比较 → 配置单位是字节/秒。
    assert.equal(kbpsToBytesPerSecond(1000), 125_000);
    assert.equal(kbpsToBytesPerSecond(8), 1000);
    assert.equal(kbpsToBytesPerSecond(0), 0);
    assert.equal(kbpsToBytesPerSecond(-5), 0);
    // 旧名必须与新实现一致，避免有人误用旧语义
    assert.equal(kbpsToBps(1000), kbpsToBytesPerSecond(1000));
    // 明确记录这个 8 倍差异：按比特/秒实现会得到 1000000，那是错的
    assert.notEqual(kbpsToBytesPerSecond(1000), 1000 * 1000);
  });
});

describe('输入校验', () => {
  test('密码强度规则：长度、含字母、含数字', () => {
    assert.ok(passwordProblem('short1'));
    assert.ok(passwordProblem('12345678'), '纯数字不通过');
    assert.ok(passwordProblem('abcdefgh'), '纯字母不通过');
    assert.equal(passwordProblem('abcd1234'), null);
  });

  test('邮箱校验：挡明显不是邮箱的输入，放过正常地址', () => {
    assert.equal(emailProblem('player@cnnic.link'), null);
    assert.equal(emailProblem('a.b+tag@sub.example.co.uk'), null);
    assert.equal(emailProblem('  trim@example.com  '), null, '两侧空格应被容忍');

    assert.ok(emailProblem(''));
    assert.ok(emailProblem('no-at-sign'));
    assert.ok(emailProblem('two@@example.com'));
    assert.ok(emailProblem('@example.com'), '缺本地部分');
    assert.ok(emailProblem('user@'), '缺域名');
    assert.ok(emailProblem('user@localhost'), '顶级域必须有');
    assert.ok(emailProblem('user@example.c'), '顶级域至少 2 位');
    assert.ok(emailProblem('has space@example.com'));
    assert.ok(emailProblem(`${'x'.repeat(120)}@example.com`), '过长要挡');
  });

  test('验证码：只接受 6 位数字，允许用户带空格输入', () => {
    assert.ok(EMAIL_CODE_PATTERN.test('123456'));
    assert.ok(!EMAIL_CODE_PATTERN.test('12345'));
    assert.ok(!EMAIL_CODE_PATTERN.test('1234567'));
    assert.ok(!EMAIL_CODE_PATTERN.test('12345a'));
    assert.equal(normalizeEmailCode(' 12 34 56 '), '123456');
  });
});

describe('昵称（显示名）保留词与反冒充', () => {
  test('归一化：全角 / 零宽 / 分隔符 / 同形字都折成同一个骨架', () => {
    assert.equal(normalizeDisplayName('ＭｃＬｉｎｋ'), 'mclink', '全角走 NFKC');
    assert.equal(normalizeDisplayName('Mc\u200bLink'), 'mclink', '零宽空格 U+200B');
    assert.equal(normalizeDisplayName('Mc\u200dLink'), 'mclink', '零宽连接符 U+200D');
    assert.equal(normalizeDisplayName('Mc\ufeffLink'), 'mclink', 'BOM U+FEFF');
    assert.equal(normalizeDisplayName('Mc\u00adLink'), 'mclink', '软连字符 U+00AD');
    assert.equal(normalizeDisplayName('管 理 员'), '管理员', '空格分隔');
    assert.equal(normalizeDisplayName('Mc_L-i.nk'), 'mclink', '下划线/连字符/点');
    assert.equal(normalizeDisplayName('МсLink'), 'mclink', '西里尔 М(U+041C)/с(U+0441)');
    assert.equal(normalizeDisplayName(' 夜航星 '), '夜航星', '两侧空格');
  });

  test('冒充官方：归一化后命中保留词就拒（全角/空格/零宽/同形字/替形/加编号都挡）', () => {
    const bypasses = [
      '管理员',
      '管 理 员',
      '管-理-员',
      'ＭｃＬｉｎｋ',
      'McLink',
      'Mc\u200bLink',
      'МсLink',
      'McLink官方客服',
      '4dm1n',
      'Admin123',
      '管理员007',
      '系统',
      '客服',
      'root',
      'gm',
    ];
    for (const name of bypasses) {
      const problem = displayNameProblem(name);
      assert.ok(problem, `${JSON.stringify(name)} 应被拒绝`);
      assert.match(problem, /官方身份相近/, `${JSON.stringify(name)} 的原因要可读`);
    }
  });

  test('空/占位名：整名命中就拒，正常昵称放过', () => {
    for (const name of ['匿名', '游客', 'null', 'undefined', 'test', '测试', '某人', '用户']) {
      const problem = displayNameProblem(name);
      assert.ok(problem, `${name} 应被拒绝`);
      assert.match(problem ?? '', /占位名称/);
    }
    // 只做整名匹配：加了编号能区分到人，就不算占位名
    assert.equal(displayNameProblem('夜航星'), null);
    assert.equal(displayNameProblem('Player_01'), null, 'Player_01 是正常昵称（player 刻意不在词表里）');
    assert.equal(displayNameProblem(''), null, '空值的语义由调用方决定（注册时昵称可选）');
    // 只有不可见字符/分隔符：放行会在名册里出现看不见的人
    assert.ok(displayNameProblem('\u200b'));
    assert.ok(displayNameProblem('---'));
  });

  test('反冒充：与已有用户同名（含加零宽字符/分隔符）拒绝，改回自己原名放行', () => {
    const taken = ['夜航星', 'Player_01'];
    assert.ok(displayNameProblem('夜航星', { takenDisplayNames: taken }));
    assert.match(displayNameProblem('夜航星', { takenDisplayNames: taken }) ?? '', /已被占用/);
    assert.ok(displayNameProblem('夜\u200b航星', { takenDisplayNames: taken }), '插零宽字符冒充');
    assert.ok(displayNameProblem('夜 航 星', { takenDisplayNames: taken }), '插空格冒充');
    assert.equal(displayNameProblem('夜航星2', { takenDisplayNames: taken }), null, '不一样的名字要放过');

    // 改回自己现在的昵称：归一化后相同 → 放行（否则老用户连保存一次都过不去）
    assert.equal(displayNameProblem('夜航星', { takenDisplayNames: [], selfDisplayName: '夜航星' }), null);
    assert.equal(displayNameProblem(' 夜 航 星 ', { takenDisplayNames: [], selfDisplayName: '夜航星' }), null);
    assert.equal(displayNameProblem('ＭｃＬｉｎｋ', { selfDisplayName: 'McLink' }), null, '老昵称本身是保留词时也要放行');
  });

  test('运营词表：代码不预设内容（默认空），填进来即生效、不需要改代码', () => {
    const words = BLOCKED_WORDS as string[];
    const before = [...words];
    try {
      words.push('运营屏蔽词');
      assert.equal(displayNameProblem('运营屏蔽词'), '这个名字不能使用：包含平台不接受的词语，请换一个');
      assert.ok(displayNameProblem('前缀运营屏蔽词后缀'), '运营词表按"出现即拦"匹配');
      assert.equal(displayNameProblem('夜航星'), null, '词表之外的正常昵称不受影响');
    } finally {
      words.length = 0;
      words.push(...before);
    }
  });
});

describe('邮箱门禁（开启后谁能建房/进房）', () => {
  const user = (over: Partial<UserRow>): UserRow => ({
    id: 'u_test',
    username: 'tester',
    display_name: 'tester',
    password_hash: '',
    role: 'user',
    banned: 0,
    email: null,
    email_verified: 0,
    quota_bytes: null,
    used_bytes: 0,
    max_rooms: null,
    created_at: '',
    updated_at: '',
    ...over,
  });

  test('开关关闭时一律放行（哪怕没邮箱、没验证）', () => {
    assert.equal(emailGateProblem(user({}), false), null);
    assert.equal(emailGateProblem(user({ email: 'a@b.com', email_verified: 0 }), false), null);
  });

  test('开关打开时：没绑邮箱被挡，且提示去绑定', () => {
    const problem = emailGateProblem(user({}), true);
    assert.ok(problem, '应当被拒绝');
    assert.equal(problem?.status, 403);
    assert.equal(problem?.code, 'email_not_verified');
    assert.match(problem?.message ?? '', /绑定/);
  });

  test('开关打开时：绑了但没验证也被挡', () => {
    const problem = emailGateProblem(user({ email: 'a@b.com', email_verified: 0 }), true);
    assert.ok(problem);
    assert.match(problem?.message ?? '', /尚未验证/);
  });

  test('开关打开时：验证过才放行', () => {
    assert.equal(emailGateProblem(user({ email: 'a@b.com', email_verified: 1 }), true), null);
  });
});

describe('子节点端口：运行端口 / 链接端口分离', () => {
  const node = (over: Partial<NodeRow>): NodeRow => ({
    id: 'n_test',
    name: 'relay-test',
    region: 'cn-east',
    endpoint: 'relay.example.com:11010',
    listen_port: null,
    connect_port: null,
    public_ip: null,
    status: 'online',
    version: null,
    capacity_peers: 500,
    peers: 0,
    rooms: 0,
    rx_bps: 0,
    tx_bps: 0,
    weight: 100,
    tags: '[]',
    token_hash: '',
    last_seen_at: null,
    created_at: '',
    disabled: 0,
    config_revision: 0,
    ...over,
  });

  test('endpoint 端口解析：正常、无端口、越界', () => {
    assert.equal(endpointPort('relay.example.com:21010'), 21010);
    assert.equal(endpointPort('1.2.3.4:11010'), 11010);
    assert.equal(endpointPort('relay.example.com'), null, '没有冒号时应当拿不到端口');
    assert.equal(endpointPort('relay.example.com:0'), null);
    assert.equal(endpointPort('relay.example.com:99999'), null);
    assert.equal(endpointPort('relay.example.com:abc'), null);
    assert.equal(endpointHost('relay.example.com:21010'), 'relay.example.com');
  });

  test('两个端口都没存时回退到 endpoint 的端口（老数据行为不变）', () => {
    const row = node({});
    assert.equal(nodeListenPort(row, 11010), 11010);
    assert.equal(nodeConnectPort(row, 11010), 11010);
    assert.equal(nodeClientEndpoint(row, 11010), 'relay.example.com:11010');
  });

  test('显式端口优先：本机 11010、对外 21010（NAT 场景）', () => {
    const row = node({ listen_port: 11010, connect_port: 21010 });
    assert.equal(nodeListenPort(row, 11010), 11010, '运行端口给节点自己用');
    assert.equal(nodeConnectPort(row, 11010), 21010, '链接端口下发给客户端');
    // 关键：下发给客户端的地址必须是链接端口，不能是本机监听端口
    assert.equal(nodeClientEndpoint(row, 11010), 'relay.example.com:21010');
  });

  test('只存了运行端口时，链接端口回退到 endpoint 的端口', () => {
    const row = node({ listen_port: 11010, connect_port: null });
    assert.equal(nodeListenPort(row, 11010), 11010);
    assert.equal(nodeConnectPort(row, 11010), 11010);
  });

  test('端口归一化：只接受 1-65535 的整数', () => {
    assert.equal(normalizePort(11010), 11010);
    assert.equal(normalizePort('21010'), 21010);
    assert.equal(normalizePort(0), null);
    assert.equal(normalizePort(65536), null);
    assert.equal(normalizePort('abc'), null);
    assert.equal(normalizePort(undefined), null);
    assert.equal(normalizePort(11010.9), 11010);
  });
});

describe('局域网广播直通：默认关闭', () => {
  test('房主没开这个开关时，客户端配置里是 false（不再默认装内核网络驱动）', () => {
    // 背景：这个开关在 Windows 上靠 WinDivert 内核网络过滤驱动抓 UDP 广播，
    // 实测会与其它软件的网络栈冲突（玩家反馈连上后网易云音乐等上不了网）。
    // 所以默认必须是关的，只有房主显式打开才写 true。
    assert.equal(DEFAULT_ROOM_POLICY.allowBroadcast, false, '默认策略必须是关闭');

    const off = renderEasytierToml({
      instanceName: 'mclink-test',
      hostname: 'tester',
      dhcp: false,
      ipv4: '10.200.0.2/24',
      listeners: ['tcp://0.0.0.0:11010'],
      peers: [],
      networkName: 'mclink-room-test',
      networkSecret: 'secret',
      flags: { noTun: false, enableUdpBroadcastRelay: false },
      acl: null,
      fileLogDir: null,
      consoleLogLevel: 'warn',
    });
    assert.match(off, /enable_udp_broadcast_relay = false/);

    const on = renderEasytierToml({
      instanceName: 'mclink-test',
      hostname: 'tester',
      dhcp: false,
      ipv4: '10.200.0.2/24',
      listeners: ['tcp://0.0.0.0:11010'],
      peers: [],
      networkName: 'mclink-room-test',
      networkSecret: 'secret',
      flags: { noTun: false, enableUdpBroadcastRelay: true },
      acl: null,
      fileLogDir: null,
      consoleLogLevel: 'warn',
    });
    assert.match(on, /enable_udp_broadcast_relay = true/);
  });

  test('房间策略解析：只有显式传 true 才打开广播直通', () => {
    assert.equal(parsePolicy({}).allowBroadcast, false, '不传时保持默认关闭');
    assert.equal(parsePolicy({ allowBroadcast: true }).allowBroadcast, true);
    assert.equal(parsePolicy({ allowBroadcast: 'on' }).allowBroadcast, true, '字符串 on 也算开');
    assert.equal(parsePolicy({ allowBroadcast: false }).allowBroadcast, false);
    // 别被其它字段带偏
    assert.equal(parsePolicy({ allowP2p: true }).allowBroadcast, false);
  });
});

describe('日志视图：滤掉纯装饰行', () => {
  test('只把"整行都是分隔符"的行当装饰，正常日志不受影响', () => {
    // easytier-core 启动横幅
    assert.ok(isDecorationLine('-----------------------------------'));
    assert.ok(isDecorationLine('====='));
    assert.ok(isDecorationLine('  --------  '), '两侧空白应被容忍');
    // 正常日志绝不能被误判
    assert.ok(!isDecorationLine('2026-09-21T21:15:00  INFO CORE::INSTANCE: new listener added'));
    assert.ok(!isDecorationLine('---- 启动完成 ----'), '夹着文字的不能算装饰');
    assert.ok(!isDecorationLine('--'), '太短的不算（可能是有意义的短横线）');
    assert.ok(!isDecorationLine('-#'), '混了别的不算');
    assert.ok(!isDecorationLine('error: cannot bind 0.0.0.0:11010'));
  });
});

describe('SMTP 组信（中文邮件最容易坏的两个地方）', () => {  const config: SmtpConfig = {
    host: 'smtp.example.com',
    port: 465,
    secure: 'ssl',
    from: 'no-reply@cnnic.link',
    fromName: 'mclink 联机',
  };

  test('非 ASCII 头部按 RFC 2047 编码，纯 ASCII 保持可读', () => {
    assert.equal(encodeHeader('SMTP test'), 'SMTP test');
    const encoded = encodeHeader('mclink 邮箱验证码');
    assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // 解回来必须与原文一致，否则邮件客户端显示乱码
    const base64 = encoded.slice('=?UTF-8?B?'.length, -2);
    assert.equal(Buffer.from(base64, 'base64').toString('utf8'), 'mclink 邮箱验证码');
  });

  test('正文用 base64：既没有裸中文，也不需要 dot-stuffing', () => {
    const message = buildMessage(config, {
      to: 'player@example.com',
      subject: 'mclink 邮箱验证码',
      text: '你的验证码是：123456\n\n请在 15 分钟内输入。',
    });
    assert.match(message, /Content-Transfer-Encoding: base64/);
    assert.match(message, /Subject: =\?UTF-8\?B\?/);
    assert.match(message, /From: =\?UTF-8\?B\?[^?]+\?= <no-reply@cnnic.link>/);

    const [, body = ''] = message.split('\r\n\r\n');
    assert.ok(!/[\u4e00-\u9fa5]/.test(body), '正文里不该出现裸中文');
    assert.ok(!/^\./m.test(body), 'base64 正文不可能出现以点开头的行');
    const decoded = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.match(decoded, /123456/);
    // 每行不超过 76 字符（RFC 2045）
    for (const line of body.split('\r\n')) assert.ok(line.length <= 76, `base64 行过长: ${line.length}`);
  });

  test('发件人显示名走编码，裸地址不带尖括号', () => {
    const bare = buildMessage({ ...config, fromName: undefined }, { to: 'a@b.com', subject: 'x', text: 'y' });
    assert.match(bare, /^From: no-reply@cnnic\.link\r\n/);
  });

  test('EHLO 能力解析：多行响应、带参数与不带参数', () => {
    const reply = [
      '250-smtp.example.com',
      '250-STARTTLS',
      '250-AUTH PLAIN LOGIN',
      '250-SIZE 35882577',
      '250 8BITMIME',
    ].join('\r\n');
    const caps = parseCapabilities(reply);
    assert.equal(caps.get('STARTTLS'), '');
    assert.equal(caps.get('AUTH'), 'PLAIN LOGIN');
    assert.equal(caps.get('SIZE'), '35882577');
    assert.ok(caps.has('8BITMIME'));
  });

  test('AUTH 命令在会话记录里被脱敏（会被管理员看到）', () => {
    const masked = maskAuthLine('AUTH PLAIN AG5vLXJlcGx5QGNubmljLmxpbmsAc2VjcmV0');
    assert.equal(masked, 'AUTH PLAIN <已隐藏>');
    assert.equal(maskAuthLine('AG5vLXJlcGx5'), '<已隐藏>');
    assert.equal(maskAuthLine('MAIL FROM:<no-reply@cnnic.link>'), 'MAIL FROM:<no-reply@cnnic.link>');
  });

  test('发件人拆分：带显示名 / 裸地址 / 留空退回账号', () => {
    assert.deepEqual(resolveFrom('mclink <no-reply@cnnic.link>', ''), {
      address: 'no-reply@cnnic.link',
      name: 'mclink',
      display: 'mclink <no-reply@cnnic.link>',
    });
    assert.deepEqual(resolveFrom('no-reply@cnnic.link', ''), {
      address: 'no-reply@cnnic.link',
      name: '',
      display: 'no-reply@cnnic.link',
    });
    assert.equal(resolveFrom('', 'fallback@cnnic.link').address, 'fallback@cnnic.link');
    assert.equal(resolveFrom('"带引号" <a@b.com>', '').name, '带引号');
  });
});

/**
 * 成员链路判定：锁住「中继被显示成 P2P」这个线上 bug。
 *
 * 触发条件很隐蔽：EasyTier 对**经中继的路由同样会报 lat_ms**，
 * 老实现认为「这条 peer 有延迟 = 直连」，于是走中继的成员全被标成 P2P。
 */
describe('成员链路判定 resolveMemberLink', () => {
  const hostIp = '10.20.0.1';

  test('到房主经中继 → 不是 P2P（哪怕它到别的成员是直连、延迟更低）', () => {
    const link = resolveMemberLink(
      [
        { ipv4: hostIp, cost: 'relay(1)', latencyMs: 82 },
        { ipv4: '10.20.0.3', cost: 'p2p', latencyMs: 12 },
      ],
      hostIp,
      false,
    );
    assert.deepEqual(link, { latencyMs: 82, p2p: false });
  });

  test('到房主直连 → P2P，延迟取房主那一条而不是最小延迟', () => {
    const link = resolveMemberLink(
      [
        { ipv4: hostIp, cost: 'p2p', latencyMs: 24 },
        { ipv4: '10.20.0.4', cost: 'relay(2)', latencyMs: 9 },
      ],
      hostIp,
      false,
    );
    assert.deepEqual(link, { latencyMs: 24, p2p: true });
  });

  test('房主自己：取最快成员，且不声称直连', () => {
    const link = resolveMemberLink(
      [
        { ipv4: '10.20.0.2', cost: 'p2p', latencyMs: 18 },
        { ipv4: '10.20.0.3', cost: 'relay(1)', latencyMs: 41 },
      ],
      hostIp,
      true,
    );
    assert.deepEqual(link, { latencyMs: 18, p2p: false });
  });

  test('只报得出本机行 / 房主不在列表里 → 不给结论（未测得）', () => {
    assert.deepEqual(
      resolveMemberLink([{ ipv4: '', cost: 'Local', latencyMs: 1 }], hostIp, false),
      { latencyMs: null, p2p: false },
    );
    assert.deepEqual(
      resolveMemberLink([{ ipv4: '10.20.0.4', cost: 'p2p', latencyMs: 7 }], hostIp, false),
      { latencyMs: null, p2p: false },
    );
  });

  test('成本字符串未知形态（如 relay 换写法 / 空）一律不算直连', () => {
    assert.equal(resolveMemberLink([{ ipv4: hostIp, cost: 'Relayed', latencyMs: 30 }], hostIp, false).p2p, false);
    assert.equal(resolveMemberLink([{ ipv4: hostIp, cost: '', latencyMs: 30 }], hostIp, false).p2p, false);
  });

  test('虚拟地址带掩码也能对上房主（客户端可能上报 /24 形式）', () => {
    const link = resolveMemberLink([{ ipv4: '10.20.0.1/24', cost: 'p2p', latencyMs: 5 }], hostIp, false);
    assert.deepEqual(link, { latencyMs: 5, p2p: true });
  });
});

/**
 * 外来网络聚合：锁住「只看主控 → 长期显示 0」这个线上读数问题。
 *
 * 玩家按区域就近接入，房间流量大多走在子节点上；节点心跳里本来就有 roomTraffic
 * （网络名 + 速率），以前只拿去记账，没有并进这个读数。
 */
describe('外来网络聚合 mergeRelayedNetworks', () => {
  const node = (name: string, peers: number, rxBps: number, txBps: number) => ({ networkName: name, peers, rxBps, txBps });

  test('只有子节点在转发时也要算进来（这正是以前显示 0 的场景）', () => {
    const [first] = mergeRelayedNetworks([], [node('mclink-room-abc', 3, 1000, 2000)]);
    assert.ok(first, '应当合并出一条网络');
    assert.equal(first.onMaster, false);
    assert.equal(first.relaySources, 1);
  });

  test('同一网络被主控 + 两个节点带着：去重成一条、速率相加、来源计数 3', () => {
    const [first] = mergeRelayedNetworks(
      [node('net-a', 2, 100, 200)],
      [node('net-a', 3, 300, 400), node('net-a', 1, 50, 60)],
    );
    assert.ok(first, '应当合并出一条网络');
    assert.deepEqual(
      {
        peers: first.peers,
        rxBps: first.rxBps,
        txBps: first.txBps,
        sources: first.relaySources,
        onMaster: first.onMaster,
      },
      { peers: 6, rxBps: 450, txBps: 660, sources: 3, onMaster: true },
    );
  });

  test('网络名两边的空白被忽略，空名不产生条目', () => {
    const merged = mergeRelayedNetworks([node('   ', 9, 9, 9)], [node(' net-b ', 1, 1, 1)]);
    assert.deepEqual(merged.map((m) => m.networkName), ['net-b']);
  });

  test('按速率从大到小排序：控制台第一眼看到最忙的那个', () => {
    const merged = mergeRelayedNetworks([], [node('slow', 1, 10, 10), node('busy', 1, 5000, 5000)]);
    assert.deepEqual(merged.map((m) => m.networkName), ['busy', 'slow']);
  });

  test('负数被夹成 0：脏上报不能把总量算小', () => {
    const [first] = mergeRelayedNetworks([node('n', -5, -100, 50)], []);
    assert.ok(first, '应当合并出一条网络');
    assert.deepEqual({ peers: first.peers, rxBps: first.rxBps, txBps: first.txBps }, { peers: 0, rxBps: 0, txBps: 50 });
  });

  test('记下「是哪几台节点」在转发，并按 id 去重（同一台报两个实例只算一次）', () => {
    const withSource = (name: string, id: string, nodeName: string, rxBps: number) => ({
      ...node(name, 1, rxBps, 0),
      source: { id, name: nodeName },
    });
    const merged = mergeRelayedNetworks(
      [],
      [
        withSource('net-a', 'n_1', '华东-1', 100),
        withSource('net-a', 'n_2', '华南-2', 200),
        // 同一台节点的第二个实例：来源不重复计
        withSource('net-a', 'n_1', '华东-1', 50),
      ],
    );
    const [first] = merged;
    assert.ok(first);
    assert.deepEqual(first.sources, [
      { id: 'n_1', name: '华东-1' },
      { id: 'n_2', name: '华南-2' },
    ]);
    assert.equal(first.relaySources, 3, '计数仍是三条上报（界面上只在没有 nodes 时才用它兜底）');
    assert.equal(first.rxBps, 350);

    // 没带来源的样本（老节点/旧格式）不会往 sources 里塞空对象
    const [plain] = mergeRelayedNetworks([], [node('net-b', 1, 10, 0)]);
    assert.ok(plain);
    assert.deepEqual(plain.sources, []);
  });
});

/**
 * 重连退避：必须带抖动。
 *
 * 线上实测：一次故障后同一秒里有 6 个不同 IP 的 /ws 一起失败 —— 客户端原来是
 * 写死的 4 秒固定重连，所有玩家在同一毫秒回来，把刚恢复的单线程主控再打满一次。
 */
describe('重连退避 reconnectDelayMs', () => {
  test('抖动区间是 0.5x–1.5x，并在 8 次后封顶 30s', () => {
    assert.equal(reconnectDelayMs(0, () => 0), 500);
    assert.equal(reconnectDelayMs(0, () => 1), 1500);
    assert.equal(reconnectDelayMs(8, () => 0), 15_000);
    assert.equal(reconnectDelayMs(8, () => 1), 45_000);
    // 超过 8 次不再继续增长（否则长时间断网后第一个客户端要等几分钟）
    assert.equal(reconnectDelayMs(99, () => 1), 45_000);
  });

  test('同一抖动系数下随重连次数递增', () => {
    let previous = 0;
    for (const attempt of [0, 1, 2, 3, 5, 8]) {
      const value = reconnectDelayMs(attempt, () => 0.5);
      assert.ok(value >= previous, `${attempt} 次：${value} < ${previous}`);
      previous = value;
    }
  });

  test('不同客户端会得到不同时长（没有抖动就会一起回来）', () => {
    const values = new Set(Array.from({ length: 40 }, () => reconnectDelayMs(3)));
    assert.ok(values.size > 5, `40 次只有 ${values.size} 个不同值，抖动没生效`);
  });
});

/** 群发公告的手填名单：管理员是从表格/聊天记录里复制粘贴过来的，分隔符必须宽容 */
describe('群发名单解析 parseUsernameList', () => {
  test('逗号/顿号/分号/空白/换行混合分隔都能切开', () => {
    assert.deepEqual(parseUsernameList('alice, bob、carol;dave\neve fiona'), [
      'alice',
      'bob',
      'carol',
      'dave',
      'eve',
      'fiona',
    ]);
  });

  test('大小写不敏感去重，保留第一次出现的写法', () => {
    assert.deepEqual(parseUsernameList('Alice, alice, ALICE'), ['Alice']);
  });

  test('空串与纯分隔符得到空数组（= 不筛人，走全量）', () => {
    assert.deepEqual(parseUsernameList(''), []);
    assert.deepEqual(parseUsernameList('   ,, 、 ; \n'), []);
  });

  test('超过上限时截断，避免一次粘贴整张表', () => {
    const many = Array.from({ length: BROADCAST_USERNAME_MAX + 50 }, (_, i) => `user${i}`).join(',');
    assert.equal(parseUsernameList(many).length, BROADCAST_USERNAME_MAX);
  });
});

/**
 * 带宽感知调度：修的是"只看 peer 数"这个错。
 * 5 个 peer 但跑满 5Mbps 的节点，以前会被当成最优选择（用户实测反馈）。
 */
describe('带宽利用率与调度打分', () => {
  const node = (peers: number, status = 'online', weight = 100): NodeRow =>
    ({ capacity_peers: 500, peers, weight, status }) as NodeRow;

  test('relayScore：同样 5 个 peer，带宽跑满的那个应当被压到 0 分', () => {
    // 500 的容量、5 个在用 → 人数余量 0.99；带宽余量 1 → 取最小值 0.99
    assert.equal(relayScore(node(5), 0), 99);
    assert.equal(relayScore(node(5), 1), 0);
  });

  test('两个余量取最小值：人多时同样被压下来', () => {
    const busyPeers = relayScore({ capacity_peers: 100, peers: 90, weight: 100, status: 'online' } as NodeRow, 0);
    assert.ok(Math.abs(busyPeers - 10) < 1e-9, `(100-90)/100 = 0.1 → 期望 10，实际 ${busyPeers}`);
  });

  test('degraded 罚分：余量再大也被压成负数（兜底时才用得上）', () => {
    assert.equal(relayScore({ capacity_peers: 100, peers: 0, weight: 50, status: 'degraded' } as NodeRow, 0), -50);
  });

  test('利用率越界被夹到 0–1，不会算出负余量', () => {
    assert.equal(relayScore(node(0), 5), 0);
    assert.equal(relayScore(node(0), -1), 100);
  });

  test('ewma：dt = 时间常数时走完约 63%（1 - 1/e）', () => {
    const v = ewma(0, 100, 180_000, 180_000);
    assert.ok(Math.abs(v - 63.2) < 0.5, `期望 ≈63.2，实际 ${v}`);
    // dt 很小 → 几乎不动（脉冲不该立刻改变结论）
    assert.ok(ewma(100, 0, 1_000, 180_000) > 99, '1 秒的采样不该把 3 分钟均值拉下来');
  });

  test('NodeUtilization：首次采样直接作初值，之后平滑；未设上限时利用率恒为 0', () => {
    const util = new NodeUtilization(180_000);
    assert.equal(util.record('n1', 1_000_000, 0, 1_000), 1_000_000);
    const second = util.record('n1', 3_000_000, 6_000_000, 21_000);
    assert.ok(second > 1_000_000 && second < 3_000_000, `应当落在两次采样之间，实际 ${second}`);
    assert.equal(util.utilization('n1', 2_000_000), Math.min(1, second / 2_000_000));
    assert.equal(util.utilization('n1', 0), 0, '0 = 不限，不构成约束');
    util.forget('n1');
    assert.equal(util.usedBps('n1'), 0, '节点删除后采样要清掉');
  });

  test('NodeUtilization：收发取较大者（云厂商的 Mbps 按单向计）', () => {
    const util = new NodeUtilization();
    assert.equal(util.record('n2', 100, 9_000_000, 1_000), 9_000_000);
  });
  test('状态机：带宽 ≥90% 降级、≤70% 才恢复（滞后区间内维持原状）', () => {
    // 人数完全空闲（0/500），只有带宽在动
    assert.equal(nextNodeStatus('online', 0, 500, 0.9), 'degraded', '到 90% 就降');
    assert.equal(nextNodeStatus('online', 0, 500, 0.89), null, '89% 不动');
    assert.equal(nextNodeStatus('degraded', 0, 500, 0.71), null, '71% 还不恢复（滞后）');
    assert.equal(nextNodeStatus('degraded', 0, 500, 0.7), 'online', '降到 70% 才恢复');
  });

  test('状态机：人数维度仍是 90%/80%，两者任一吃紧就降级', () => {
    assert.equal(nextNodeStatus('online', 91, 100, 0), 'degraded');
    assert.equal(nextNodeStatus('degraded', 85, 100, 0), null, '人数 80–90% 之间维持降级');
    assert.equal(nextNodeStatus('degraded', 79, 100, 0), 'online');
    // 人数已回落但带宽还没回落 → 不能恢复
    assert.equal(nextNodeStatus('degraded', 0, 100, 0.95), null);
  });
});

/**
 * 「建房自动选中继」的调度规则：**权重优先，权重一致时才比延迟**。
 *
 * 用户拍板的语义（覆盖上一轮的"纯延迟优先"，也**不**引入档位/阈值）：
 *   ① `weight` 降序（主键）→ ② 权重相同才比延迟（有提示且真有余量的按 ms 升序）
 *   → ③ 仍相同用 relayScore 降序 → ④ 最后以 peers 升序收尾。
 * 前面还有一道"键 0"：真有余量（`peers < capacity_peers` 且利用率 < 90%）的节点排在满员/吃紧的节点之前
 * —— 满员/带宽吃紧是硬条件的延伸，weight 再高也不该顶掉一台还能接人的节点。
 *
 * 这里要钉住六件事：
 *   1. 权重是主键：**高权重但延迟差** 胜过 低权重但延迟好（本轮语义的核心）；
 *   2. 权重相同才看延迟：延迟好的赢，哪怕它的 relayScore 更低；
 *   3. 权重相同、延迟差落在 LATENCY_TIE_BAND_MS 内 → 交回 relayScore 决胜（并列带只在同权重内生效）；
 *   4. 提示**绝不能**绕过硬条件（权重 0 / 停用 / 离线 / 满员 / 带宽吃紧 / 区域不符）；
 *   5. `latencyHints` 缺省/空/全是池外 id 时三者结果完全一致；
 *   6. **老客户端（无提示）的结果也变了**：以前是纯 relayScore，现在权重在前（见本组倒数第二条测试）。
 */
describe('权重优先调度 selectRelays / scheduleRelays', () => {
  const cand = (id: string, over: Partial<NodeRow> = {}, utilization = 0): RelayCandidate => ({
    row: { id, capacity_peers: 500, peers: 0, weight: 100, status: 'online', ...over } as NodeRow,
    utilization,
  });

  const rowOf = (id: string, region: string, over: Partial<NodeRow> = {}): NodeRow =>
    ({ id, region, capacity_peers: 500, peers: 0, weight: 100, status: 'online', ...over }) as NodeRow;

  test('权重是主键：权重高但延迟差 胜过 权重低但延迟好（本轮语义的核心）', () => {
    const slow = cand('slow', { weight: 100 });
    const fast = cand('fast', { weight: 20 });
    // 前置条件：低权重那台的 relayScore 其实更高（更空），但延迟只有它的 1%
    assert.ok(relayScore(fast.row, 0) < relayScore(slow.row, 0), '前置条件：fast 的打分本来就低于 slow');
    const hints = [
      { nodeId: 'slow', ms: 500 },
      { nodeId: 'fast', ms: 5 },
    ];
    assert.deepEqual(selectRelays([fast, slow], hints, 1).map((row) => row.id), ['slow']);
    // 入参顺序反过来结果不变（排序键与候选顺序无关）
    assert.deepEqual(selectRelays([slow, fast], hints, 2).map((row) => row.id), ['slow', 'fast']);
    // 权重只差 1 也照样赢：并列带不会跨权重生效（它只在权重相同时才看延迟）
    assert.deepEqual(
      selectRelays([cand('w99', { weight: 99 }), cand('w100', { weight: 100 })], [{ nodeId: 'w99', ms: 5 }, { nodeId: 'w100', ms: 500 }], 1)
        .map((row) => row.id),
      ['w100'],
    );
  });

  test('权重相同才比延迟：延迟好的赢，即使它的 relayScore 更低', () => {
    // 两台同权重 50：loaded 更挤（打分 10），idle 很空（打分 ≈49.5）
    const loaded = cand('loaded', { weight: 50, peers: 400 });
    const idle = cand('idle', { weight: 50 });
    assert.ok(relayScore(loaded.row, 0) < relayScore(idle.row, 0), '前置条件：loaded 的打分更低');
    // 差 95ms ≫ 并列带 → 延迟说了算
    assert.deepEqual(
      selectRelays([idle, loaded], [{ nodeId: 'loaded', ms: 5 }, { nodeId: 'idle', ms: 100 }], 1).map((row) => row.id),
      ['loaded'],
    );
  });

  test('权重相同、无提示 → 完全回到 relayScore 排序（= 改造前的行为）', () => {
    const list = [
      cand('a', { weight: 50, peers: 0 }), // 50 × 0.99   = 49.5
      cand('c', { weight: 50, peers: 100 }), // 50 × 0.8    = 40
      cand('b', { weight: 50, peers: 300 }), // 50 × 0.4    = 20
      cand('d', { weight: 50, status: 'degraded' }), // 49.5 − 100 = −50.5
    ];
    const legacy = [...list]
      .sort((x, y) => relayScore(y.row, 0) - relayScore(x.row, 0) || x.row.peers - y.row.peers)
      .map((c) => c.row.id);
    assert.deepEqual(legacy, ['a', 'c', 'b', 'd'], '先钉住"改造前的旧行为"到底是什么，免得两边一起错');
    assert.deepEqual(selectRelays(list, [], 4).map((row) => row.id), legacy);
    assert.deepEqual(selectRelays(list, undefined, 4).map((row) => row.id), legacy);
    assert.deepEqual(selectRelays(list, [{ nodeId: 'ghost', ms: 1 }], 4).map((row) => row.id), legacy);
  });

  test('权重相同、延迟差在并列带内 → 按 relayScore 决胜；超出带子仍然延迟优先', () => {
    // 同权重 50：tight 很挤（打分 10）、roomy 很空（打分 ≈49.5）
    const tight = cand('tight', { weight: 50, peers: 400 });
    const roomy = cand('roomy', { weight: 50 });
    // 差刚好等于带子 → 同一档 → 余量更好的赢
    assert.deepEqual(
      selectRelays([tight, roomy], [{ nodeId: 'tight', ms: 10 }, { nodeId: 'roomy', ms: 10 + LATENCY_TIE_BAND_MS }], 1)
        .map((row) => row.id),
      ['roomy'],
    );
    // 只超出带子 1ms → 延迟优先
    assert.deepEqual(
      selectRelays([tight, roomy], [{ nodeId: 'tight', ms: 10 }, { nodeId: 'roomy', ms: 11 + LATENCY_TIE_BAND_MS }], 1)
        .map((row) => row.id),
      ['tight'],
    );
    // 延迟与打分都一样时看 peer 少的（改造前就有的末位判据，不能被并列带吃掉）
    assert.deepEqual(
      selectRelays(
        [cand('many', { peers: 30 }), cand('few', { peers: 3 })],
        [{ nodeId: 'many', ms: 20 }, { nodeId: 'few', ms: 25 }],
        1,
      ).map((row) => row.id),
      ['few'],
    );
  });

  test('满员节点（peers = 容量）：权重最高、延迟最低也排不到队首（提示同样不算数）', () => {
    const full = cand('full', { peers: 500, weight: 1000 });
    const ok = cand('ok', { weight: 1 });
    const hints = [{ nodeId: 'full', ms: 1 }, { nodeId: 'ok', ms: 900 }];
    assert.deepEqual(selectRelays([full, ok], hints, 1).map((row) => row.id), ['ok'], '满员的接不了新房间，不能靠权重抢名额');
    // 但它仍然留在池子里兜底（"一台空闲的都没有"时房间照旧有中继可用）
    assert.deepEqual(selectRelays([full, ok], hints, 2).map((row) => row.id), ['ok', 'full']);
  });

  test('带宽吃紧（利用率 ≥90%）的节点：提示同样不算数，判定回到权重/打分', () => {
    // 两个都吃紧 → 走"全都吃紧就回退全量候选"那条路，此时提示必须完全失效
    const busyHigh = cand('busyHigh', { weight: 100 }, 0.95);
    const busyLow = cand('busyLow', { weight: 1 }, 0.95);
    const picked = selectRelays(
      [busyHigh, busyLow],
      [{ nodeId: 'busyLow', ms: 1 }, { nodeId: 'busyHigh', ms: 80 }],
      2,
    );
    assert.deepEqual(picked.map((row) => row.id), ['busyHigh', 'busyLow']);

    // 一台吃紧、一台有余量：吃紧的那台权重再高、延迟再低也排在后面（键 0）
    const picked2 = selectRelays(
      [cand('busy', { weight: 1000 }, 0.95), cand('idle', { weight: 1 })],
      [{ nodeId: 'busy', ms: 1 }, { nodeId: 'idle', ms: 900 }],
      1,
    );
    assert.deepEqual(picked2.map((row) => row.id), ['idle']);
  });

  test('hints 为空 / 缺省 / 全是池外 id：三者完全一致，且就是"权重优先"的排序', () => {
    const list = [
      cand('a', { weight: 10 }),
      cand('b', { weight: 90 }),
      cand('c', { peers: 400 }), // weight 默认 100，最挤
      cand('d', { status: 'degraded', weight: 100 }),
      cand('e', { peers: 3, weight: 40 }),
    ];
    // 权重降序 → 同权重按 relayScore 降序 → peers 升序
    // 权重 100：c（50×0.99=… 吃紧 → 100×0.2=20）比 d（100×0.99−100≈−1）靠前
    const expected = ['c', 'd', 'b', 'e', 'a'];
    assert.deepEqual(selectRelays(list, [], 5).map((row) => row.id), expected);
    assert.deepEqual(selectRelays(list, undefined, 5).map((row) => row.id), expected);
    assert.deepEqual(selectRelays(list, [{ nodeId: 'ghost', ms: 1 }], 5).map((row) => row.id), expected);
    // ⚠️ 与改造前的纯 relayScore 排序（['b','e','c','a','d']）**不同**：权重现在是第一判据
    const legacy = [...list]
      .sort((x, y) => relayScore(y.row, 0) - relayScore(x.row, 0) || x.row.peers - y.row.peers)
      .map((c) => c.row.id);
    assert.deepEqual(legacy, ['b', 'e', 'c', 'a', 'd'], '旧行为：权重只是打分因子，低权重但更空的节点可以赢');
  });

  test('候选池外的节点（权重 0 / 停用 / 离线）——权重给到 500、延迟给到 1ms 也拉不进来', () => {
    const db = new Db(':memory:');
    try {
      const repo = new NodeRepo(db);
      const base = { region: 'cn-east', listenPort: 11010, connectPort: 11010, tokenHash: 't', capacityPeers: 500 };
      repo.create({ ...base, id: 'n_ok', name: 'ok', endpoint: '10.1.0.1:11010', status: 'online', weight: 1 });
      // 下面三台都是"看起来最该被选中"的：权重 500 + 延迟 1ms，但硬条件不合格
      repo.create({ ...base, id: 'n_w0', name: 'w0', endpoint: '10.1.0.2:11010', status: 'online', weight: 0 });
      repo.create({ ...base, id: 'n_off', name: 'off', endpoint: '10.1.0.3:11010', status: 'offline', weight: 500 });
      repo.create({ ...base, id: 'n_dis', name: 'dis', endpoint: '10.1.0.4:11010', status: 'online', weight: 500 });
      repo.setDisabled('n_dis', true);

      const pool: RelayCandidate[] = repo.listSchedulable().map((row) => ({ row, utilization: 0 }));
      assert.deepEqual(pool.map((c) => c.row.id), ['n_ok'], '候选池只剩合格的那一个');

      const picked = selectRelays(
        pool,
        [
          { nodeId: 'n_w0', ms: 1 },
          { nodeId: 'n_off', ms: 1 },
          { nodeId: 'n_dis', ms: 1 },
          { nodeId: 'n_ok', ms: 900 },
        ],
        2,
      );
      assert.deepEqual(picked.map((row) => row.id), ['n_ok']);
    } finally {
      db.close();
    }
  });

  /**
   * 只喂 `scheduleRelays` 真正用到的那几个依赖（候选查询 + 利用率采样 + 平台设置里的门槛），
   * 这样区域过滤、带宽吃紧过滤、回退全局、两个槽位的选法这些**服务层规则**也能被单测直接钉住。
   *
   * `relayBigPipeBps: 0` 表示"所有节点都算大带宽档"（等价于没配容量），
   * 于是中继槽就退化成"延迟优先"，正好让下面几条老断言继续描述同一个语义。
   */
  function schedule(
    rows: NodeRow[],
    utilizationOf: (row: NodeRow) => number = () => 0,
    relayBigPipeBps = 0,
    relaySmallShedPercent = 90,
  ) {
    const fake = Object.assign(Object.create(RoomService.prototype) as RoomService, {
      nodes: { listSchedulable: () => rows },
      utilizationOf,
      settings: { current: { relayBigPipeBps, relayScaleMbps: 0, relaySmallShedPercent } },
    });
    return (zone: string, hints: RelayLatencyHint[] = [], max = 2): string[] =>
      RoomService.prototype.scheduleRelays.call(fake, zone, hints, max);
  }

  test('区域是硬条件：权重 1000 + 1ms 的外区域节点也拉不进来', () => {
    const pick = schedule([rowOf('east', 'cn-east', { weight: 1 }), rowOf('south', 'cn-south', { weight: 1000 })]);
    assert.deepEqual(pick('cn-east', [{ nodeId: 'south', ms: 1 }, { nodeId: 'east', ms: 900 }]), ['east']);
  });

  test('该区域没有可用节点时回退全局（老行为不变）', () => {
    const pick = schedule([rowOf('south', 'cn-south')]);
    assert.deepEqual(pick('cn-east', [{ nodeId: 'south', ms: 5 }]), ['south']);
  });

  test('带宽吃紧的节点被移出候选，权重再高、延迟再低也拉不回来', () => {
    const pick = schedule(
      [rowOf('busy', 'cn-east', { weight: 1000 }), rowOf('idle', 'cn-east', { weight: 1 })],
      (row) => (row.id === 'busy' ? 0.95 : 0),
    );
    assert.deepEqual(pick('auto', [{ nodeId: 'busy', ms: 1 }, { nodeId: 'idle', ms: 900 }]), ['idle']);
  });

  /**
   * ⚠️ 这条是本轮"旧客户端行为变化"的**证据**：不传提示时不再是改造前的纯 relayScore 排序，
   * 而是"权重优先 → 同权重按 relayScore"。
   * 例子：c（weight 100、用了 400/500 人）以前排 b（weight 90、几乎全空）之后，现在排它前面。
   */
  test('不传提示（老客户端）：权重优先 → 同权重才按 relayScore（**与改造前不同**）', () => {
    const rows = [
      rowOf('a', 'cn-east', { weight: 10 }), // 打分 9.9
      rowOf('b', 'cn-east', { weight: 90 }), // 打分 89.1
      rowOf('c', 'cn-east', { peers: 400 }), // weight 100，打分 20
      rowOf('d', 'cn-east', { status: 'degraded' }), // weight 100，打分 ≈ −1
    ];
    const legacy = [...rows]
      .sort((x, y) => relayScore(y, 0) - relayScore(x, 0) || x.peers - y.peers)
      .slice(0, 2)
      .map((row) => row.id);
    assert.deepEqual(legacy, ['b', 'c'], '改造前：weight 只是打分因子，b（更空）赢 c（权重更高）');
    const pick = schedule(rows);
    assert.deepEqual(pick('auto'), ['c', 'd'], '现在：权重 100 的两台先排，同权重内 c 比 d 空');
    assert.deepEqual(pick('auto', []), ['c', 'd']);
    assert.deepEqual(pick('cn-east'), ['c', 'd']);
    // 同权重的两台之间仍然完全按打分（= 改造前那一步没变）
    const sameWeight = [rowOf('x', 'cn-east', { weight: 50 }), rowOf('y', 'cn-east', { weight: 50, peers: 400 })];
    assert.deepEqual(schedule(sameWeight)('auto'), ['x', 'y']);
  });

  test('parseLatencyHints：坏形状一律丢弃，重复 id 取最小值，条数封顶', () => {
    assert.deepEqual(parseLatencyHints({}), []);
    assert.deepEqual(parseLatencyHints({ latencyHints: 'nope' }), []);
    assert.deepEqual(
      parseLatencyHints({
        latencyHints: [
          { nodeId: 'a', ms: 42 },
          { nodeId: 'a', ms: 7 },
          { nodeId: 'b', ms: -1 },
          { nodeId: 'c', ms: Number.NaN },
          { nodeId: 'd', ms: 1e9 },
          { nodeId: 'e', ms: '12' },
          { nodeId: '', ms: 5 },
          { ms: 3 },
          null,
        ],
      }),
      [
        { nodeId: 'a', ms: 7 },
        { nodeId: 'd', ms: 60_000 },
      ],
    );
    const many = Array.from({ length: 100 }, (_, i) => ({ nodeId: `n${i}`, ms: i }));
    assert.equal(parseLatencyHints({ latencyHints: many }).length, 64);
  });
});

/**
 * 「活跃即续期」：房间的存活时长 = 无人活跃多久之后过期。
 *
 * 以前 expires_at 是建房那一刻算死的硬期限，到点就被 30 秒一次的 findExpired() 关掉，
 * **房里有人也照关**（隧道不会立刻断，但新人再也进不来）。
 */
describe('房间过期时间顺延 nextRoomExpiry', () => {
  const MIN = 60_000;
  const now = Date.parse('2026-09-25T12:00:00.000Z');

  test('没设 TTL 的房间永不续期（本来就不会过期）', () => {
    assert.equal(nextRoomExpiry(null, now, 720 * MIN), null);
    assert.equal(nextRoomExpiry('2026-09-25T13:00:00.000Z', now, 0), null);
  });

  test('时间只走了一点点时不写库（节流，避免每 10 秒一次写）', () => {
    const current = new Date(now + 720 * MIN).toISOString();
    // 12 小时的 TTL → 节流窗口 5 分钟；才过 10 秒 → 不动
    assert.equal(nextRoomExpiry(current, now + 10_000, 720 * MIN), null);
  });

  test('走过去超过节流窗口后顺延到「现在 + TTL」', () => {
    const current = new Date(now + 720 * MIN).toISOString();
    const moved = nextRoomExpiry(current, now + 6 * MIN, 720 * MIN);
    assert.equal(moved, new Date(now + 6 * MIN + 720 * MIN).toISOString());
  });

  test('短 TTL 用更小的节流窗口（1 分钟的房间也能滑动）', () => {
    const current = new Date(now + MIN).toISOString();
    // 1 分钟 TTL → 节流取 max(5s, 6s) = 6s
    assert.equal(nextRoomExpiry(current, now + 3_000, MIN), null, '3 秒还不够');
    assert.equal(nextRoomExpiry(current, now + 7_000, MIN), new Date(now + 7_000 + MIN).toISOString());
  });

  test('到期时间不可解析时直接按现在重算（脏数据不该让房间永不过期）', () => {
    assert.equal(nextRoomExpiry('not-a-date', now, MIN), new Date(now + MIN).toISOString());
  });
});

/**
 * 流量账本与会计。
 *
 * 这一组盯的是"累计流量 / 用户用量"这条链上**错了会静默给出假数字**的地方：
 *   · 中继重启后计数器回退（不能把回退算成增量，也不能重复入账）；
 *   · 同一房间被两台节点同时转发（必须相加，而不是互相覆盖 —— 改造前就是覆盖写）；
 *   · 用户维度（按成员上报的带宽份额分摊，`used_bytes` 要真的增长）。
 */
describe('流量账本与会计', () => {
  function fixture() {
    const db = new Db(':memory:');
    const users = new UserRepo(db);
    const rooms = new RoomRepo(db);
    const ledger = new TrafficLedgerRepo(db);
    const host = users.create({ username: 'ledger-host', displayName: '房主', passwordHash: 'x' });
    const guest = users.create({ username: 'ledger-guest', displayName: '成员', passwordHash: 'x' });
    const room = rooms.create({
      id: 'r_ledger',
      code: 'LDGR01',
      name: '账本房',
      hostUserId: host.id,
      access: 'open',
      visibility: 'public',
      zone: 'auto',
      relayNodeIds: ['n_1'],
      policy: DEFAULT_ROOM_POLICY,
      networkName: 'mclink-room-ledger',
      networkSecret: 'secret',
      subnet: '10.200.9.0/24',
      subnetSlot: 9,
      passwordHash: null,
      expiresAt: null,
    });
    rooms.addMember({ roomId: room.id, userId: host.id, role: 'host', status: 'active', virtualIp: '10.200.9.1/24', seat: 1 });
    rooms.addMember({ roomId: room.id, userId: guest.id, role: 'member', status: 'active', virtualIp: '10.200.9.2/24', seat: 2 });
    // 心跳：既让成员进入"最近活跃"窗口，又给出分摊份额（房主 3000、成员 1000 → 3:1）
    rooms.updateMemberHeartbeat(room.id, host.id, { rxBps: 3000, txBps: 3000 });
    rooms.updateMemberHeartbeat(room.id, guest.id, { rxBps: 1000, txBps: 1000 });
    const accountant = new TrafficAccountant({ ledger, rooms, users });
    return { db, users, rooms, ledger, accountant, host, guest, room };
  }

  test('delta：第一次只记基线，第二次给差值，计数器回退按"新实例从 0 开始"处理', () => {
    const { db, accountant } = fixture();
    try {
      assert.deepEqual(accountant.delta('master|net', 1000, 2000), { rx: 0, tx: 0 }, '第一次是基线');
      assert.deepEqual(accountant.delta('master|net', 1500, 2600), { rx: 500, tx: 600 });
      // 实例重启：计数器回到 200/300 —— 这段时间新产生的量就是 200/300
      assert.deepEqual(accountant.delta('master|net', 200, 300), { rx: 200, tx: 300 });
    } finally {
      db.close();
    }
  });

  test('account：房间累计是真的加法（两台来源同时转发时相加，而不是覆盖）', () => {
    const { db, ledger, accountant, rooms } = fixture();
    try {
      const net = { networkName: 'mclink-room-ledger', peerCount: 2 };
      // 第一轮只记基线，什么都不入账
      accountant.account('master', [{ ...net, rxBytes: 100, txBytes: 200 }]);
      assert.equal(rooms.usage('r_ledger')?.rxBytes ?? 0, 0, '首轮不该把历史总量记进来');

      accountant.account('master', [{ ...net, rxBytes: 1100, txBytes: 2200 }]);
      assert.deepEqual(
        { rx: rooms.usage('r_ledger')!.rxBytes, tx: rooms.usage('r_ledger')!.txBytes },
        { rx: 1000, tx: 2000 },
      );

      // 第二台来源（子节点）也在转发同一个房间：累计必须相加
      accountant.account('node:n_2', [{ ...net, rxBytes: 50, txBytes: 60 }]);
      accountant.account('node:n_2', [{ ...net, rxBytes: 550, txBytes: 660 }]);
      const usage = rooms.usage('r_ledger')!;
      assert.deepEqual({ rx: usage.rxBytes, tx: usage.txBytes }, { rx: 1500, tx: 2600 });
      assert.equal(usage.peers, 2);

      // 平台维度 = 各来源增量之和
      const platform = ledger.sum({ scope: 'platform', scopeId: 'all' });
      assert.deepEqual(platform, { rxBytes: 1500, txBytes: 2600 });
      // 房间维度记在该房间名下
      const roomSum = ledger.sum({ scope: 'room', scopeId: 'r_ledger' });
      assert.deepEqual(roomSum, { rxBytes: 1500, txBytes: 2600 });
    } finally {
      db.close();
    }
  });

  test('用户维度：按成员上报的带宽份额分摊，used_bytes 真的增长', () => {
    const { db, ledger, accountant, users, host, guest } = fixture();
    try {
      const net = { networkName: 'mclink-room-ledger', peerCount: 2, rxBytes: 0, txBytes: 0 };
      accountant.account('master', [net]);
      accountant.account('master', [{ ...net, rxBytes: 1000, txBytes: 2000 }]);

      // 房主 3000 / 成员 1000 → 3:1；增量 rx 1000 + tx 2000 = 3000
      const hostRow = users.findById(host.id)!;
      const guestRow = users.findById(guest.id)!;
      assert.equal(hostRow.used_bytes, 2250);
      assert.equal(guestRow.used_bytes, 750);
      assert.equal(hostRow.used_bytes + guestRow.used_bytes, 3000);

      const hostLedger = ledger.sum({ scope: 'user', scopeId: host.id, sinceDay: localDay() });
      assert.equal(hostLedger.rxBytes + hostLedger.txBytes, 2250);
    } finally {
      db.close();
    }
  });

  test('forgetSource：中继/节点换实例后重新记基线，不会把新实例的累计当成增量重复入账', () => {
    const { db, accountant, rooms } = fixture();
    try {
      const net = { networkName: 'mclink-room-ledger', peerCount: 1 };
      accountant.account('master', [{ ...net, rxBytes: 5000, txBytes: 5000 }]);
      accountant.account('master', [{ ...net, rxBytes: 6000, txBytes: 6000 }]);
      assert.equal(rooms.usage('r_ledger')!.rxBytes, 1000);

      // 主控中继重启（新实例计数器从 0 开始）
      accountant.forgetSource('master');
      accountant.account('master', [{ ...net, rxBytes: 800, txBytes: 800 }]);
      assert.equal(rooms.usage('r_ledger')!.rxBytes, 1000, '新实例的第一轮只记基线');

      accountant.account('master', [{ ...net, rxBytes: 900, txBytes: 900 }]);
      assert.equal(rooms.usage('r_ledger')!.rxBytes, 1100, '之后按新实例的差值累加');
    } finally {
      db.close();
    }
  });

  test('账本查询：区间求和、逐日补零、按 scope 排序、过期分批清理', () => {
    const { db, ledger } = fixture();
    try {
      const today = new Date();
      const old = new Date(today.getTime() - 500 * 86_400_000);
      ledger.addMany([{ scope: 'platform', scopeId: 'all', rxBytes: 100, txBytes: 200 }], today);
      ledger.addMany([{ scope: 'platform', scopeId: 'all', rxBytes: 50, txBytes: 50 }], today);
      ledger.addMany([{ scope: 'platform', scopeId: 'all', rxBytes: 7, txBytes: 9 }], old);
      ledger.addMany([{ scope: 'room', scopeId: 'r_a', roomId: 'r_a', rxBytes: 30, txBytes: 40 }], today);
      ledger.addMany([{ scope: 'room', scopeId: 'r_b', roomId: 'r_b', rxBytes: 90, txBytes: 10 }], today);

      // 同一天的两批累加进同一个桶
      assert.deepEqual(ledger.sum({ scope: 'platform', scopeId: 'all', sinceDay: localDay(today) }), {
        rxBytes: 150,
        txBytes: 250,
      });
      // 不加区间就是全量（含那条 500 天前的）
      assert.deepEqual(ledger.sum({ scope: 'platform', scopeId: 'all' }), { rxBytes: 157, txBytes: 259 });

      const days = ledger.daySeries(30);
      assert.equal(days.length, 30, '缺数据的日子要补 0，图表才不会断层');
      assert.deepEqual(days.at(-1), { day: localDay(today), rxBytes: 150, txBytes: 250 });
      assert.equal(days[0]!.rxBytes, 0);

      const byScope = ledger.byScope({ scope: 'room', sinceDay: localDay(today) });
      assert.deepEqual(byScope.map((r) => r.scopeId), ['r_b', 'r_a'], '按总量降序（r_b 100 > r_a 70）');

      assert.ok(ledger.pruneBatch(400, 100) >= 1, '500 天前的那条要被清掉');
      assert.deepEqual(ledger.sum({ scope: 'platform', scopeId: 'all' }), { rxBytes: 150, txBytes: 250 });
    } finally {
      db.close();
    }
  });
});

/**
 * 两个槽位：槽 1 = 打洞节点（`assist_only`，不承载数据），槽 2 = 中继节点。
 *
 * 这一组盯的是用户 2026-09-28 拍板的模型：把带宽少的机器标成"只协助打洞"，
 * 让它们只协调 P2P 打洞；真正承载数据的中继槽从**大带宽档**里按**客户端实测延迟**挑。
 */
describe('房间两个槽位：打洞节点 + 中继节点', () => {
  const cand = (id: string, over: Partial<NodeRow> = {}, utilization = 0): RelayCandidate => ({
    row: { id, capacity_peers: 500, peers: 0, weight: 100, status: 'online', ...over } as NodeRow,
    utilization,
  });
  /** 大带宽档门槛固定 10 Mbps，与默认设置一致 */
  const BIG = 10_000_000;

  test('槽 1 优先挑「只协助打洞」的节点，槽 2 从大带宽档里挑（权重一致时按延迟）', () => {
    const pool = [
      cand('punch', { assist_only: 1, capacity_bps: 5_000_000, weight: 1 }),
      cand('small', { capacity_bps: 5_000_000 }), // 小管子：不该当侦中继
      cand('big-slow', { capacity_bps: 100_000_000 }),
      cand('big-fast', { capacity_bps: 200_000_000 }),
    ];
    const picked = pickRoomRelays(
      pool,
      pool,
      [
        { nodeId: 'small', ms: 5 },
        { nodeId: 'big-slow', ms: 40 },
        { nodeId: 'big-fast', ms: 20 },
      ],
      2,
      BIG,
    );
    assert.deepEqual(picked, ['punch', 'big-fast'], '槽 1 = 打洞节点；槽 2 = 大管子里延迟最低的那台');
  });

  test('打洞节点永远不会进中继槽（它不承载数据，进去等于这个房间没有中继）', () => {
    // 打洞节点延迟最低、带宽最大、权重最高 —— 任何一条"看着该选它"的理由都给它了
    const punchLike = cand('punch-like', { assist_only: 1, capacity_bps: 1_000_000_000, weight: 999 });
    const plain = cand('plain', { capacity_bps: 20_000_000 });
    const picked = pickRoomRelays(
      [punchLike, plain],
      [punchLike, plain],
      [
        { nodeId: 'punch-like', ms: 1 },
        { nodeId: 'plain', ms: 300 },
      ],
      2,
      BIG,
    );
    assert.deepEqual(picked, ['punch-like', 'plain'], '中继槽只能是能承载数据的那台');
  });

  test('权重是中继槽的主键：权重更高但慢的那台照样当选（只有权重一致才比延迟）', () => {
    const pool = [cand('punch', { assist_only: 1 }), cand('heavy', { weight: 500 }), cand('light', { weight: 1 })];
    const picked = pickRoomRelays(
      pool,
      pool,
      [
        { nodeId: 'heavy', ms: 90 },
        { nodeId: 'light', ms: 12 },
      ],
      2,
      BIG,
    );
    assert.deepEqual(picked, ['punch', 'heavy'], '权重参与：500 那台赢，哪怕慢 78ms');

    // 权重一致时才走后续规则（延迟优先）
    const sameWeight = [cand('punch', { assist_only: 1 }), cand('slow', { weight: 100 }), cand('fast', { weight: 100 })];
    const hinted = pickRoomRelays(
      sameWeight,
      sameWeight,
      [
        { nodeId: 'slow', ms: 60 },
        { nodeId: 'fast', ms: 5 },
      ],
      2,
      BIG,
    );
    assert.deepEqual(hinted, ['punch', 'fast'], '权重一致 → 比延迟');
  });

  test('没有标 assist 的节点时，槽 1 退回原规则（与旧行为一致）', () => {
    const pool = [cand('w-high', { weight: 300 }), cand('w-low', { weight: 1 })];
    const picked = pickRoomRelays(
      pool,
      pool,
      [
        { nodeId: 'w-high', ms: 200 },
        { nodeId: 'w-low', ms: 5 },
      ],
      2,
      BIG,
    );
    // 槽 1 用 selectRelays（权重优先）→ w-high；槽 2 再按延迟挑 → w-low
    assert.deepEqual(picked, ['w-high', 'w-low']);
  });

  test('本区域只有打洞节点：中继槽从**别的区域**调一台（跨区兜底）', () => {
    const zonePool = [cand('punch-east', { assist_only: 1, region: 'cn-east' } as Partial<NodeRow>)];
    const allPool = [
      ...zonePool,
      cand('relay-south', { region: 'cn-south', capacity_bps: 200_000_000 }),
      cand('relay-north', { region: 'cn-north', capacity_bps: 200_000_000 }),
    ];
    const picked = pickRoomRelays(
      zonePool,
      allPool,
      [
        { nodeId: 'relay-south', ms: 35 },
        { nodeId: 'relay-north', ms: 60 },
      ],
      2,
      BIG,
      'cn-east',
    );
    assert.deepEqual(picked, ['punch-east', 'relay-south'], '槽 1 留在本区域；槽 2 取跨区里延迟最低的那台');
  });

  test('本区域有能承载数据的节点时**不跨区**（区域仍是硬条件）', () => {
    const zonePool = [
      cand('punch-east', { assist_only: 1 }),
      cand('relay-east-slow', { capacity_bps: 200_000_000 }),
    ];
    const allPool = [...zonePool, cand('relay-south-fast', { capacity_bps: 200_000_000 })];
    const picked = pickRoomRelays(
      zonePool,
      allPool,
      [
        { nodeId: 'relay-east-slow', ms: 80 },
        { nodeId: 'relay-south-fast', ms: 5 }, // 更快的外区节点也不该被拉进来
      ],
      2,
      BIG,
    );
    assert.deepEqual(picked, ['punch-east', 'relay-east-slow']);
  });

  test('大带宽档为空时中继槽不硬凑：退回全部候选并仍给两台', () => {
    const pool = [cand('a', { capacity_bps: 1_000_000 }), cand('b', { capacity_bps: 2_000_000 })];
    const picked = pickRoomRelays(
      pool,
      pool,
      [
        { nodeId: 'a', ms: 30 },
        { nodeId: 'b', ms: 10 },
      ],
      2,
      BIG,
    );
    // 两台都是小管子 → 槽 1 按原规则（权重相同则延迟优先）挑 b，槽 2 只能拿剩下的 a。
    // 关键是**一台都不少给**：宁可两台都小，也不能让房间只剩一台中继。
    assert.deepEqual(picked, ['b', 'a'], '池子里没有大管子：仍然给足两台');
  });

  test('capacity_bps = 0（控制台没填 = 不限）算大带宽档', () => {
    const pool = [cand('punch', { assist_only: 1 }), cand('unset')];
    const picked = pickRoomRelays(pool, pool, [], 2, BIG);
    assert.equal(picked.length, 2, '没填容量的节点不该被判成小管子');
    assert.equal(picked[0], 'punch');
  });

  test('只有一个能承载的候选时只返回一台（不重复、也不凭空造一台）', () => {
    assert.deepEqual(pickRoomRelays([cand('only')], [cand('only')], [], 2, BIG), ['only']);
    assert.deepEqual(pickRoomRelays([], [], [], 2, BIG), []);
  });
});

/**
 * 小带宽节点**提前卸荷**（用户 2026-09-28 提的）：
 * 「让小宽带节点只在宽带负载超过 80% 的时候停止新增中继，默认还是可以中继的」。
 *
 * 这一组盯的就是"那条线是按节点分档的、而且只挡新房间"：
 *   · 小管子 80%（可配、封顶 90%），大管子仍然 90%；
 *   · `capacity_bps = 0`（不限）不受影响；
 *   · 状态机（degraded）与调度（不再接新房间）用的是**同一条线**。
 */
describe('小带宽节点提前卸荷（80% 停止新增中继）', () => {
  const BIG = 10_000_000;
  const SMALL = 5_000_000;
  const rowOf = (id: string, region: string, over: Partial<NodeRow> = {}): NodeRow =>
    ({ id, region, capacity_peers: 500, peers: 0, weight: 100, status: 'online', ...over }) as NodeRow;
  /** 与前面那组同款：只喂 scheduleRelays 真正用到的依赖 */
  function schedule(
    rows: NodeRow[],
    utilizationOf: (row: NodeRow) => number = () => 0,
    relayBigPipeBps = 0,
    relaySmallShedPercent = 90,
  ) {
    const fake = Object.assign(Object.create(RoomService.prototype) as RoomService, {
      nodes: { listSchedulable: () => rows },
      utilizationOf,
      settings: { current: { relayBigPipeBps, relayScaleMbps: 0, relaySmallShedPercent } },
    });
    return (zone: string, hints: RelayLatencyHint[] = [], max = 2): string[] =>
      RoomService.prototype.scheduleRelays.call(fake, zone, hints, max);
  }

  test('shedUtilFor：小管子 80%，大管子/未填容量仍 90%，且封顶 90%', () => {
    assert.equal(shedUtilFor(SMALL, BIG, 80), 0.8, '小管子：80% 就卸荷');
    assert.equal(shedUtilFor(BIG, BIG, 80), UTIL_SHED, '够大档：仍走全局线');
    assert.equal(shedUtilFor(200_000_000, BIG, 80), UTIL_SHED);
    assert.equal(shedUtilFor(0, BIG, 80), UTIL_SHED, '没填容量（= 不限）不算小管子');
    assert.equal(shedUtilFor(null, BIG, 80), UTIL_SHED);
    assert.equal(shedUtilFor(SMALL, BIG, 95), UTIL_SHED, '配得比 90% 高时封顶在 90%，不会比全局线更晚');
    assert.equal(shedUtilFor(SMALL, BIG, 50), 0.5, '管理员可以调得更保守');
  });

  test('状态机用同一条线：小管子 85% 就 degraded，大管子 85% 还是 online', () => {
    assert.equal(nextNodeStatus('online', 0, 500, 0.85, shedUtilFor(SMALL, BIG, 80)), 'degraded');
    assert.equal(nextNodeStatus('online', 0, 500, 0.85, shedUtilFor(BIG, BIG, 80)), null, '大管子 85% 仍有富余');
  });

  test('调度侧：小管子到了自己的线就不再接新房间，大管子照旧', () => {
    const rows = [
      rowOf('small-busy', 'cn-east', { capacity_bps: SMALL }),
      rowOf('big-idle', 'cn-east', { capacity_bps: 200_000_000 }),
    ];
    const util = (row: NodeRow) => (row.id === 'small-busy' ? 0.85 : 0.1);
    // 小管子线 = 80% → 85% 那台被移出候选，只剩大管子
    const pick = schedule(rows, util, BIG, 80);
    assert.deepEqual(pick('cn-east'), ['big-idle'], '小管子 85% 时不再接新房间');
    // 大管子线 = 90% → 85% 仍然合格（证明这条线是**按节点分档**的，不是全局降线）
    const onlyBig = [rowOf('big-busy', 'cn-east', { capacity_bps: 200_000_000 })];
    const pickBig = schedule(onlyBig, () => 0.85, BIG, 80);
    assert.deepEqual(pickBig('cn-east'), ['big-busy']);
    // 默认（设置里没给这个值）= 90%：85% 的小管子照旧能接
    const pickDefault = schedule(rows, util);
    assert.equal(pickDefault('cn-east').includes('small-busy'), true, '没配这条线时行为不变');
  });
});
