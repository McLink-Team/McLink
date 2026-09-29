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

/**
 * 名字归一化：去空白、小写、剥掉公共中继前缀，并把"看起来像分隔符"的字符统一掉。
 *
 * 为什么要容错这么多：这一条判据是"内核报的 hostname ↔ 票据里的节点名"，
 * 而两侧的来源不同（内核那份来自节点上运行的配置，票据那份来自主控库）。
 * 实测踩过的坑：`PublicServer_` 前缀（upstream `PUBLIC_SERVER_HOSTNAME_PREFIX`）一个都没剥，
 * 于是两行都认不出角色。所以这里把**空白、`_`、`-`、`·`、全角/半角括号**统统归一化 ——
 * 名字里"阿里云 上海 / 阿里云-上海 / 阿里云（上海）"这类差异不该让界面瞎猜角色。
 */
export function relayNameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    // 公共中继前缀（大小写与分隔符都容错）
    .replace(/^public[_-]?server[_-]/, '')
    // 空白与常见分隔符
    .replace(/[\s_\-·•]+/g, '')
    // 全角括号 → 半角（内容保留：`（上海）` 与 `(上海)` 视为同一个名字）
    .replace(/[（）]/g, (ch) => (ch === '（' ? '(' : ')'));
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
 * 匹配分两趟：
 *   1. 归一化后**完全相同**（正常情况都走这一趟）；
 *   2. 归一化后**互相包含**（名字被截断、被加了别的前缀/后缀时的兜底）——
 *      长名字优先，且只在 label 足够长（≥3 字符）时才认，避免"a"这种短名字误吞。
 *
 * @returns `'punch'` 打洞节点 / `'relay'` 中继节点 / `null` 认不出来（**不标角色**：
 *          标错比不标更糟，玩家会照着一个错的角色去排障）
 */
export function relayRoleOf(hostname: string, names: RelayTicketNames): 'punch' | 'relay' | null {
  const key = relayNameKey(hostname ?? '');
  if (!key) return null;

  const entries = names.allLabels
    .map((label) => ({ label, key: relayNameKey(label) }))
    .filter((entry) => entry.key.length > 0);
  if (entries.length === 0) return null;

  let hit = entries.find((entry) => entry.key === key);
  if (!hit) {
    hit = entries
      .filter((entry) => entry.key.length >= 3 && (key.includes(entry.key) || entry.key.includes(key)))
      // 长名字优先：`阿里云上海` 比 `上海` 更可能是同一台
      .sort((a, b) => b.key.length - a.key.length)[0];
  }
  if (!hit) return null;

  const punchKey = relayNameKey(names.punchLabel ?? '');
  // 票据里没给打洞槽（老主控只下发一台）时也不瞎猜
  if (!punchKey) return null;
  return punchKey === hit.key ? 'punch' : 'relay';
}
