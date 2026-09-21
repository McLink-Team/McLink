/**
 * 房间 ACL 构造。
 *
 * 明确一件事：EasyTier 的 ACL 是**每个实例各自持有**的，不会在虚拟网络里同步。
 * 所以「房主踢人」「房间限速」这类控制必须由主控生成 ACL、下发给房主客户端，
 * 由房主客户端在自己本地实例上通过 `easytier-cli acl set` 热应用。
 * 主控不直接连房主的 RPC 端口（那既不安全也过不了 NAT）。
 */
import { AclAction, AclChainType, AclProtocol, type AclRuleSpec, type AclSpec } from './config.ts';
import type { RoomPolicy } from '@mclink/shared';

export interface RoomAclInput {
  roomId: string;
  policy: RoomPolicy;
  /** 房主虚拟 IP，用于识别「谁是谁」；当前未直接用到，保留以便后续细化规则 */
  hostIp: string;
  /** 被踢成员的虚拟 IP（不含前缀） */
  blockedIps: string[];
  /** 房间成员总数，仅用于描述信息 */
  memberCount: number;
}

/** 需要放行的诊断协议：ICMP / ICMPv6，避免严格模式下玩家无法用 ping 排障 */
const DIAGNOSTIC_PROTOCOLS = [AclProtocol.ICMP, AclProtocol.ICMPv6];

/**
 * 生成房主实例应持有的 ACL。
 *
 * 优先级约定（数值越大越先匹配）：
 *   30000  踢人黑名单（Drop）
 *   20000  严格端口模式下的放行规则
 *      100  包速率限制
 */
export function buildRoomAcl(input: RoomAclInput): AclSpec {
  const { policy, blockedIps, roomId } = input;
  const rules: AclRuleSpec[] = [];

  // 1) 被踢成员：直接丢弃其全部入向流量
  for (const [index, ip] of blockedIps.entries()) {
    rules.push({
      name: `block_kicked_${index + 1}`,
      description: `房间 ${roomId} 已移除的成员 ${ip}`,
      priority: 30000 - index,
      protocol: AclProtocol.Any,
      action: AclAction.Drop,
      sourceIps: [`${ip}/32`],
      enabled: true,
      stateful: false,
    });
  }

  const hasPorts = policy.allowedPorts.length > 0;

  // 2) 严格端口模式：先放行游戏端口与 ICMP，其余由 default_action 丢弃
  if (policy.strictPorts) {
    for (const proto of DIAGNOSTIC_PROTOCOLS) {
      rules.push({
        name: `allow_diag_${proto}`,
        description: '放行 ICMP，便于玩家自行排查连通性',
        priority: 20000,
        protocol: proto,
        action: AclAction.Allow,
        enabled: true,
      });
    }
    if (hasPorts) {
      rules.push({
        name: 'allow_game_ports',
        description: `只放行游戏端口: ${policy.allowedPorts.join(', ')}`,
        priority: 19900,
        protocol: AclProtocol.Any,
        ports: policy.allowedPorts,
        action: AclAction.Allow,
        enabled: true,
      });
    }
  }

  // 3) 包速率限制：单位是包/秒，不是带宽
  if (policy.rateLimitPps > 0) {
    rules.push({
      name: 'room_rate_limit',
      description: `房间 ${roomId} 包速率限制 ${policy.rateLimitPps} pps`,
      priority: 100,
      protocol: AclProtocol.Any,
      ports: hasPorts ? policy.allowedPorts : [],
      action: AclAction.Allow,
      rateLimitPps: policy.rateLimitPps,
      burstLimit: Math.max(policy.rateLimitPps * 2, policy.rateLimitPps + 1),
      enabled: true,
    });
  }

  const chain = {
    name: `mclink_room_${roomId}`,
    chainType: AclChainType.Inbound,
    description: `mclink 房间 ${roomId} 的访问控制`,
    enabled: true,
    defaultAction: policy.strictPorts ? AclAction.Drop : AclAction.Allow,
    rules,
  };

  return { chains: [chain] };
}

/** 判断 ACL 是否「实质性为空」——空 ACL 不应下发给 CLI（CLI 会拒绝） */
export function isAclEmpty(acl: AclSpec): boolean {
  return acl.chains.length === 0 && !acl.group;
}
