/**
 * EasyTier 配置模型与生成器。
 *
 * 字段来源：EasyTier v2.6.4 的 `FlagsInConfig`（easytier-core/src/config/toml.rs）。
 * 这里只声明我们实际会用到的字段，避免把整张表照抄一遍带来的维护负担。
 *
 * 重要事实（已核对源码，与部分网上示例不同）：
 *  1. `acl` 的 `rate_limit` 单位是 **包/秒（pps）**，不是带宽。带宽限速要用
 *     `foreign_relay_bps_limit`（中继转发出口）或 `instance_recv_bps_limit`（本实例接收）。
 *  2. `foreign_relay_bps_limit` / `instance_recv_bps_limit` 是 u64，在 TOML 里以
 *     **字符串**形式写出（见 toml.rs 的 flags_diff 宏与序列化测试）。
 *  3. `relay_network_whitelist` 支持 wildmatch 通配（`*`、`?`），空格分隔。
 */

/** ACL 协议枚举（easytier-proto/proto/acl.proto） */
export const AclProtocol = {
  Unspecified: 0,
  TCP: 1,
  UDP: 2,
  ICMP: 3,
  ICMPv6: 4,
  Any: 5,
} as const;

/** ACL 动作枚举 */
export const AclAction = {
  Noop: 0,
  Allow: 1,
  Drop: 2,
} as const;

/** ACL 链类型枚举 */
export const AclChainType = {
  Unspecified: 0,
  /** 发往本节点的流量 */
  Inbound: 1,
  /** 从本节点发出的流量 */
  Outbound: 2,
  /** 子网代理转发 */
  Forward: 3,
} as const;

export interface AclRuleSpec {
  name: string;
  description?: string;
  /** 数值越大优先级越高（0-65535） */
  priority?: number;
  enabled?: boolean;
  protocol?: number;
  ports?: string[];
  sourcePorts?: string[];
  sourceIps?: string[];
  destinationIps?: string[];
  sourceGroups?: string[];
  destinationGroups?: string[];
  action: number;
  /** 包/秒；0 = 不限 */
  rateLimitPps?: number;
  /** 突发包数；0 = 不限 */
  burstLimit?: number;
  stateful?: boolean;
}

export interface AclChainSpec {
  name: string;
  chainType: number;
  description?: string;
  enabled?: boolean;
  defaultAction: number;
  rules: AclRuleSpec[];
}

export interface AclGroupDeclare {
  groupName: string;
  groupSecret: string;
}

export interface AclSpec {
  chains: AclChainSpec[];
  group?: {
    declares?: AclGroupDeclare[];
    members?: string[];
  };
}

/* ------------------------------------------------------------ 转义与序列化 */

/** TOML 基本字符串转义 */
export function tomlString(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
      }
    }
  }
  return `"${out}"`;
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlNumberArray(values: readonly number[]): string {
  return `[${values.map((v) => String(v)).join(', ')}]`;
}

/* ---------------------------------------------------- 顶层配置（服务器 / 客户端通用） */

export interface PeerSpec {
  /** 形如 tcp://host:11010 */
  uri: string;
}

export interface EasytierConfigSpec {
  instanceName: string;
  /** 本机在虚拟网络中的地址，如 10.200.7.3/24；缺省表示用 DHCP */
  ipv4?: string | null;
  dhcp?: boolean;
  hostname?: string | null;
  listeners: string[];
  peers: PeerSpec[];
  networkName: string;
  networkSecret: string;
  /**
   * 注意：rpc_portal / rpc_portal_whitelist **不是** TOML 配置字段，
   * 只存在于 easytier-core 的命令行参数（`-r` / `--rpc-portal-whitelist`）。
   * 写进配置文件会被静默忽略，进而让所有实例都退回默认的 15888 并互相抢占。
   * 因此这里不提供这两个字段，改由 `buildLaunchArgs()` 生成命令行参数。
   */
  proxyNetworks?: string[];
  flags?: EasytierFlagsSpec;
  acl?: AclSpec | null;
  /** 原样追加到配置末尾的 TOML 片段（用于管理员下发的自定义 ACL 等） */
  extraToml?: string | null;
  /** 文件日志目录；null 表示不写文件 */
  fileLogDir?: string | null;
  consoleLogLevel?: string;
  fileLogLevel?: string;
}

/** easytier-core 的启动参数（与配置文件互补，二者共同决定实例行为） */
export interface EasytierLaunchOptions {
  configFile: string;
  /** RPC 管理端口，仅本机可访问 */
  rpcPortal?: string | null;
  /** RPC 访问白名单，缺省即仅本机 */
  rpcPortalWhitelist?: string[];
  /** 额外透传参数 */
  extraArgs?: string[];
}

/**
 * 启动参数里配置文件路径的占位符。
 *
 * 主控无法知道客户端/子节点本地的配置落盘路径，因此下发的启动参数里用 `%CONFIG%`
 * 占位，由执行方替换成自己写的配置文件的绝对路径。
 */
export const CONFIG_PLACEHOLDER = '%CONFIG%';

/**
 * 由监听端口推导本机的 RPC portal 端口。
 *
 * 为什么不用固定的 15888：同一台机器上可能跑多个 EasyTier 实例（预发环境、
 * 房主客户端与管理实例共存），固定端口会互相抢占导致后启动的实例失去管理能力。
 * 用 `16000 + port % 1000` 保证：同机不同监听端口 → RPC 端口不同，
 * 且与主控默认的 15888 不重叠，并始终落在合法端口范围内。
 *
 * 注意取模的含义：端口相差正好 1000 的倍数时（如 11010 与 12010）会撞到同一个
 * RPC 端口。这是刻意的取舍——同机部署多实例时只要避免端口差为 1000 的倍数即可，
 * 比引入一张持久化的端口分配表要轻得多。
 */
export function rpcPortalForListenPort(listenPort: number): number {
  return 16000 + (Math.abs(listenPort) % 1000);
}

/**
 * 校验客户端上报的 RPC 端口，不合法返回 null。
 *
 * 存在意义：上面那个推算函数只保证「同一台机器上不同实例不撞车」，它推不出
 * 玩家机器上哪些端口是**被系统保留**的——Windows 的 Hyper-V / WSL / Docker 会占住
 * 成段的端口（`netsh int ipv4 show excludedportrange protocol=tcp`），
 * 显式绑定到这些端口会直接 WSAEACCES(10013)，而按空闲端口探测过的客户端知道答案。
 * 因此只要上报值合法就用它；低端口需要管理员权限，一律拒绝。
 */
export function usableRpcPort(port: number | null | undefined): number | null {
  if (typeof port !== 'number' || !Number.isInteger(port)) return null;
  return port >= 1024 && port <= 65535 ? port : null;
}

/**
 * 拼装 easytier-core 的完整命令行。
 * 把「配置文件 + 命令行」两处知识收敛到一个函数，避免调用方各写一遍。
 */
export function buildLaunchArgs(options: EasytierLaunchOptions): string[] {
  const args = ['-c', options.configFile];
  if (options.rpcPortal) {
    args.push('-r', options.rpcPortal);
    // 显式限定 RPC 只对本机开放；这是安全默认值
    args.push('--rpc-portal-whitelist', ...(options.rpcPortalWhitelist ?? ['127.0.0.1/32']));
  }
  if (options.extraArgs) args.push(...options.extraArgs);
  return args;
}

export interface EasytierFlagsSpec {
  defaultProtocol?: string;
  devName?: string;
  enableEncryption?: boolean;
  enableIpv6?: boolean;
  mtu?: number;
  latencyFirst?: boolean;
  noTun?: boolean;
  useSmoltcp?: boolean;
  /** wildmatch 模式，空格分隔 */
  relayNetworkWhitelist?: string;
  disableP2p?: boolean;
  p2pOnly?: boolean;
  lazyP2p?: boolean;
  relayAllPeerRpc?: boolean;
  disableUdpHolePunching?: boolean;
  disableTcpHolePunching?: boolean;
  multiThread?: boolean;
  multiThreadCount?: number;
  bindDevice?: boolean;
  enableKcpProxy?: boolean;
  disableKcpInput?: boolean;
  disableRelayKcp?: boolean;
  enableRelayForeignNetworkKcp?: boolean;
  acceptDns?: boolean;
  privateMode?: boolean;
  enableQuicProxy?: boolean;
  disableQuicInput?: boolean;
  disableRelayQuic?: boolean;
  enableRelayForeignNetworkQuic?: boolean;
  /** 外来网络经本节点中继的出口限速（bit/s），u64 以字符串写出 */
  foreignRelayBpsLimit?: number;
  /** 本实例接收限速（bit/s），u64 以字符串写出 */
  instanceRecvBpsLimit?: number;
  tldDnsZone?: string;
  needP2p?: boolean;
  disableUpnp?: boolean;
  disableRelayData?: boolean;
  preferPeerRelay?: boolean;
  enableUdpBroadcastRelay?: boolean;
}

const FLAG_KEY_MAP: Record<keyof EasytierFlagsSpec, string> = {
  defaultProtocol: 'default_protocol',
  devName: 'dev_name',
  enableEncryption: 'enable_encryption',
  enableIpv6: 'enable_ipv6',
  mtu: 'mtu',
  latencyFirst: 'latency_first',
  noTun: 'no_tun',
  useSmoltcp: 'use_smoltcp',
  relayNetworkWhitelist: 'relay_network_whitelist',
  disableP2p: 'disable_p2p',
  p2pOnly: 'p2p_only',
  lazyP2p: 'lazy_p2p',
  relayAllPeerRpc: 'relay_all_peer_rpc',
  disableUdpHolePunching: 'disable_udp_hole_punching',
  disableTcpHolePunching: 'disable_tcp_hole_punching',
  multiThread: 'multi_thread',
  multiThreadCount: 'multi_thread_count',
  bindDevice: 'bind_device',
  enableKcpProxy: 'enable_kcp_proxy',
  disableKcpInput: 'disable_kcp_input',
  disableRelayKcp: 'disable_relay_kcp',
  enableRelayForeignNetworkKcp: 'enable_relay_foreign_network_kcp',
  acceptDns: 'accept_dns',
  privateMode: 'private_mode',
  enableQuicProxy: 'enable_quic_proxy',
  disableQuicInput: 'disable_quic_input',
  disableRelayQuic: 'disable_relay_quic',
  enableRelayForeignNetworkQuic: 'enable_relay_foreign_network_quic',
  foreignRelayBpsLimit: 'foreign_relay_bps_limit',
  instanceRecvBpsLimit: 'instance_recv_bps_limit',
  tldDnsZone: 'tld_dns_zone',
  needP2p: 'need_p2p',
  disableUpnp: 'disable_upnp',
  disableRelayData: 'disable_relay_data',
  preferPeerRelay: 'prefer_peer_relay',
  enableUdpBroadcastRelay: 'enable_udp_broadcast_relay',
};

/**
 * u64 限速字段在 TOML 里必须写成**数字**，不能加引号。
 *
 * 这里曾经写成字符串（依据是 EasyTier 的 `flags_diff_from_default` 宏把 u64 序列化
 * 成 JSON 字符串）——但那是 **JSON config-patch** 路径的表示法，与 TOML 无关。
 * 实测（easytier-core 2.6.4 `--check-config`）：
 *   `instance_recv_bps_limit = 1000000`   → 通过
 *   `instance_recv_bps_limit = "1000000"` → panic:
 *     invalid type: string "1000000", expected u64
 * 任何设了带宽上限的房间都会让客户端 easytier-core 启动即崩溃，所以这条必须守住：
 * server/test/unit.test.ts 里有对应的回归断言。
 */

/** 生成 EasyTier 可用的 TOML 配置。
 * 不依赖任何 TOML 库：字段固定且可控，手写更可预测，也避免引第三方依赖。
 */
export function renderEasytierToml(spec: EasytierConfigSpec): string {
  const lines: string[] = [];

  lines.push(`# 由 mclink 主控自动生成，请勿手工编辑 —— 下次同步会被覆盖`);
  lines.push(`instance_name = ${tomlString(spec.instanceName)}`);
  if (spec.hostname) lines.push(`hostname = ${tomlString(spec.hostname)}`);
  if (spec.ipv4) lines.push(`ipv4 = ${tomlString(spec.ipv4)}`);
  if (spec.dhcp !== undefined) lines.push(`dhcp = ${spec.dhcp ? 'true' : 'false'}`);
  if (spec.listeners.length > 0) lines.push(`listeners = ${tomlArray(spec.listeners)}`);
  if (spec.proxyNetworks && spec.proxyNetworks.length > 0) {
    lines.push(`proxy_networks = ${tomlArray(spec.proxyNetworks)}`);
  }
  if (spec.consoleLogLevel) lines.push(`console_log_level = ${tomlString(spec.consoleLogLevel)}`);

  lines.push('');
  lines.push('[network_identity]');
  lines.push(`network_name = ${tomlString(spec.networkName)}`);
  lines.push(`network_secret = ${tomlString(spec.networkSecret)}`);

  if (spec.peers.length > 0) {
    lines.push('');
    for (const peer of spec.peers) {
      lines.push('[[peer]]');
      lines.push(`uri = ${tomlString(peer.uri)}`);
      lines.push('');
    }
    // 去掉尾部多余空行，保持输出整洁
    while (lines[lines.length - 1] === '') lines.pop();
  }

  if (spec.flags) {
    const entries: string[] = [];
    for (const [key, rawValue] of Object.entries(spec.flags) as Array<[keyof EasytierFlagsSpec, unknown]>) {
      if (rawValue === undefined || rawValue === null) continue;
      const tomlKey = FLAG_KEY_MAP[key];
      if (!tomlKey) continue;
      if (typeof rawValue === 'boolean') {
        entries.push(`${tomlKey} = ${rawValue ? 'true' : 'false'}`);
      } else if (typeof rawValue === 'number') {
        // u64 也写成裸数字：加引号会被 EasyTier 的 TOML 反序列化拒绝（见文件顶部注释）
        entries.push(`${tomlKey} = ${Math.trunc(rawValue)}`);
      } else if (typeof rawValue === 'string') {
        entries.push(`${tomlKey} = ${tomlString(rawValue)}`);
      }
    }
    if (entries.length > 0) {
      lines.push('');
      lines.push('[flags]');
      lines.push(...entries);
    }
  }

  if (spec.fileLogDir) {
    lines.push('');
    lines.push('[file_logger]');
    lines.push(`level = ${tomlString(spec.fileLogLevel ?? 'info')}`);
    lines.push(`file = ${tomlString(spec.fileLogDir)}`);
  }

  if (spec.acl && spec.acl.chains.length > 0) {
    lines.push('');
    lines.push(...renderAcl(spec.acl));
  }

  if (spec.extraToml && spec.extraToml.trim().length > 0) {
    lines.push('');
    lines.push(spec.extraToml.trimEnd());
  }

  return `${lines.join('\n')}\n`;
}

/** 渲染 [acl] 段为行数组；可独立用于 `easytier-cli acl set` */
export function renderAcl(acl: AclSpec): string[] {
  const lines: string[] = [];
  lines.push('[acl.acl_v1]');

  const group = acl.group;
  if (group && ((group.declares && group.declares.length > 0) || (group.members && group.members.length > 0))) {
    lines.push('');
    lines.push('[acl.acl_v1.group]');
    if (group.members && group.members.length > 0) {
      lines.push(`members = ${tomlArray(group.members)}`);
    }
    for (const declare of group.declares ?? []) {
      lines.push('');
      lines.push('[[acl.acl_v1.group.declares]]');
      lines.push(`group_name = ${tomlString(declare.groupName)}`);
      lines.push(`group_secret = ${tomlString(declare.groupSecret)}`);
    }
  }

  for (const chain of acl.chains) {
    lines.push('');
    lines.push('[[acl.acl_v1.chains]]');
    lines.push(`name = ${tomlString(chain.name)}`);
    lines.push(`chain_type = ${chain.chainType}`);
    if (chain.description) lines.push(`description = ${tomlString(chain.description)}`);
    lines.push(`enabled = ${chain.enabled === false ? 'false' : 'true'}`);
    lines.push(`default_action = ${chain.defaultAction}`);

    for (const rule of chain.rules) {
      lines.push('');
      lines.push('[[acl.acl_v1.chains.rules]]');
      lines.push(`name = ${tomlString(rule.name)}`);
      if (rule.description) lines.push(`description = ${tomlString(rule.description)}`);
      lines.push(`priority = ${rule.priority ?? 1000}`);
      lines.push(`enabled = ${rule.enabled === false ? 'false' : 'true'}`);
      if (rule.protocol !== undefined) lines.push(`protocol = ${rule.protocol}`);
      if (rule.action !== undefined) lines.push(`action = ${rule.action}`);
      if (rule.ports && rule.ports.length > 0) lines.push(`ports = ${tomlArray(rule.ports)}`);
      if (rule.sourcePorts && rule.sourcePorts.length > 0) {
        lines.push(`source_ports = ${tomlArray(rule.sourcePorts)}`);
      }
      if (rule.sourceIps && rule.sourceIps.length > 0) lines.push(`source_ips = ${tomlArray(rule.sourceIps)}`);
      if (rule.destinationIps && rule.destinationIps.length > 0) {
        lines.push(`destination_ips = ${tomlArray(rule.destinationIps)}`);
      }
      if (rule.sourceGroups && rule.sourceGroups.length > 0) {
        lines.push(`source_groups = ${tomlArray(rule.sourceGroups)}`);
      }
      if (rule.destinationGroups && rule.destinationGroups.length > 0) {
        lines.push(`destination_groups = ${tomlArray(rule.destinationGroups)}`);
      }
      if (rule.rateLimitPps !== undefined && rule.rateLimitPps > 0) {
        lines.push(`rate_limit = ${Math.trunc(rule.rateLimitPps)}`);
      }
      if (rule.burstLimit !== undefined && rule.burstLimit > 0) {
        lines.push(`burst_limit = ${Math.trunc(rule.burstLimit)}`);
      }
      if (rule.stateful !== undefined) lines.push(`stateful = ${rule.stateful ? 'true' : 'false'}`);
    }
  }

  return lines;
}

/** 供 `easytier-cli acl set` 使用的等价 JSON（CLI 同时接受 TOML 与 JSON） */
export function aclToJson(acl: AclSpec): unknown {
  return {
    acl: {
      acl_v1: {
        ...(acl.group
          ? {
              group: {
                declares: (acl.group.declares ?? []).map((d) => ({
                  group_name: d.groupName,
                  group_secret: d.groupSecret,
                })),
                members: acl.group.members ?? [],
              },
            }
          : {}),
        chains: acl.chains.map((chain) => ({
          name: chain.name,
          chain_type: chain.chainType,
          description: chain.description ?? '',
          enabled: chain.enabled !== false,
          default_action: chain.defaultAction,
          rules: chain.rules.map((rule) => ({
            name: rule.name,
            description: rule.description ?? '',
            priority: rule.priority ?? 1000,
            enabled: rule.enabled !== false,
            protocol: rule.protocol ?? AclProtocol.Any,
            ports: rule.ports ?? [],
            source_ports: rule.sourcePorts ?? [],
            source_ips: rule.sourceIps ?? [],
            destination_ips: rule.destinationIps ?? [],
            source_groups: rule.sourceGroups ?? [],
            destination_groups: rule.destinationGroups ?? [],
            action: rule.action,
            rate_limit: rule.rateLimitPps ?? 0,
            burst_limit: rule.burstLimit ?? 0,
            stateful: rule.stateful ?? false,
          })),
        })),
      },
    },
  };
}
