/**
 * 房间页「打洞节点 / 中继节点」的角色判定（**纯逻辑**，见 `scripts/verify-relay-roles.mjs`）。
 *
 * 为什么从组件里抽出来：这一条判据被一个真实的显示 bug 咬过 ——
 * EasyTier 对客户端来说把中继节点当成"公共服务器"，内核报的 hostname 带
 * `PublicServer_` 前缀（upstream `easytier/src/peers/mod.rs` 的
 * `PUBLIC_SERVER_HOSTNAME_PREFIX`），而票据里的 label 是平台下发的节点名（没有前缀）。
 * 不剥前缀就一个都对不上 → 两行一起落到兜底分支 → 用户实测「都只显示是打洞节点」。
 *
 * 抽成纯函数之后，这种"两行标成同一个角色"的回归可以在没有 Electron、没有网络的地方
 * 直接断言（脚本里就有这一条）。
 */

/** 内核给公共中继的 hostname 前缀（保持与 upstream 一致） */
export const PUBLIC_SERVER_PREFIX = 'PublicServer_';

/** 名字归一化：去空白、小写、剥掉公共中继前缀（大小写与分隔符都容错） */
export function relayNameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^public[_-]?server[_-]/, '');
}

export interface RelayTicketNames {
  /** 票据 `relays[0]`（= `room.relayNodeIds[0]`）的 label：打洞节点 */
  punchLabel: string | null;
  /** 票据里所有中继的 label，用来确认"这个 peer 确实是我们的中继之一" */
  allLabels: readonly string[];
}

/**
 * 内核 peer 行属于哪个槽位。
 *
 * @returns `'punch'` 打洞节点 / `'relay'` 中继节点 / `null` 认不出来（**不标角色**：
 *          标错比不标更糟，玩家会照着一个错的角色去排障）
 */
export function relayRoleOf(hostname: string, names: RelayTicketNames): 'punch' | 'relay' | null {
  const key = relayNameKey(hostname ?? '');
  if (!key) return null;
  const known = names.allLabels.some((label) => relayNameKey(label) === key);
  if (!known || !names.punchLabel) return null;
  return relayNameKey(names.punchLabel) === key ? 'punch' : 'relay';
}
