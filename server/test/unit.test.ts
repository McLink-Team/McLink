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
import { hashRoomPassword, verifyRoomPassword, deriveNetworkName } from '../src/services/rooms.ts';
import { parsePolicy } from '../src/api/helpers.ts';
import {
  buildMessage,
  encodeHeader,
  maskAuthLine,
  parseCapabilities,
  type SmtpConfig,
} from '../src/mail/smtp.ts';
import { resolveFrom } from '../src/services/mailer.ts';
import { emailGateProblem } from '../src/services/email-gate.ts';
import { normalizePort } from '../src/services/nodes.ts';
import { isDecorationLine } from '../src/easytier/process.ts';
import { DEFAULT_SETTINGS, clientArtifactName } from '../src/services/settings.ts';
import { endpointHost, endpointPort, nodeClientEndpoint, nodeConnectPort, nodeListenPort } from '../src/db/nodes.ts';
import type { NodeRow } from '../src/db/nodes.ts';
import type { UserRow } from '../src/db/users.ts';
import {
  DEFAULT_ROOM_POLICY,
  allocateSeat,
  allocateSlot,
  EMAIL_CODE_PATTERN,
  emailProblem,
  hostIpCidr,
  kbpsToBps,
  kbpsToBytesPerSecond,
  memberIpCidr,
  memberIpForSlot,
  normalizeEmailCode,
  slotFromIp,
  subnetForSlot,
  generateNetworkSecret,
  generateRoomCode,
  passwordProblem,
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
