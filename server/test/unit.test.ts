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

import { renderAcl, renderEasytierToml, buildLaunchArgs, tomlString, aclToJson } from '../src/easytier/config.ts';
import { buildRoomAcl, isAclEmpty } from '../src/easytier/acl.ts';
import { parseHumanNumber, parseLatencyMs } from '../src/easytier/manager.ts';
import { hashRoomPassword, verifyRoomPassword, deriveNetworkName } from '../src/services/rooms.ts';
import {
  DEFAULT_ROOM_POLICY,
  allocateSeat,
  allocateSlot,
  hostIpCidr,
  memberIpCidr,
  memberIpForSlot,
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

  test('u64 限速字段必须以字符串写出（与 EasyTier 的序列化行为一致）', () => {
    const toml = renderEasytierToml({
      instanceName: 'x',
      listeners: [],
      peers: [],
      networkName: 'n',
      networkSecret: 's',
      flags: { foreignRelayBpsLimit: 10_000_000, instanceRecvBpsLimit: 800_000, mtu: 1380 },
    });
    assert.match(toml, /^foreign_relay_bps_limit = "10000000"$/m);
    assert.match(toml, /^instance_recv_bps_limit = "800000"$/m);
    // 普通整数不能加引号
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

describe('输入校验', () => {
  test('密码强度规则：长度、含字母、含数字', () => {
    assert.ok(passwordProblem('short1'));
    assert.ok(passwordProblem('12345678'), '纯数字不通过');
    assert.ok(passwordProblem('abcdefgh'), '纯字母不通过');
    assert.equal(passwordProblem('abcd1234'), null);
  });
});
