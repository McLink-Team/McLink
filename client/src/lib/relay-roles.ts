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
  /**
   * 票据里所有中继的 label，用来确认"这个 peer 确实是我们的中继之一"。
   *
   * 早期这里还有个 `punchLabel`（票据 `relays[0]` = 打洞节点）—— **已经不适用**：
   * 中继集合模型（2026-09-30 起，见 `docs/relay-assignment.md`）下不再有"打洞节点"这个角色，
   * 所有节点都允许中继，一个房间最多下发 3 台、成员各连其中一台，**每一台都是中继**。
   */
  allLabels: readonly string[];
}

/**
 * 内核 peer 行是不是我们的中继之一。
 *
 * 匹配分三趟（从严到宽）：
 *   1. 归一化后**完全相同** —— 正常情况都走这一趟；
 *   2. 归一化后**互相包含** —— 名字被截断、或末尾多了说明性的后缀；
 *   3. **字符集合包含**（短名字的每个字符都出现在长名字里，且短名字 ≥3 字符）——
 *      用来兜住"词序不同 / 中间多了字"的情况。用户实测就是这个：
 *      票据里叫 `上海阿里云 2Mbps BGP`，而节点内核里还是改名前的 `阿里云上海`
 *      （词序正好相反），前两趟都对不上。
 *      第 3 趟只在**唯一命中**时才认（多个 label 都像就返回 null），避免把两台搞混。
 *
 * @returns `'relay'` 命中我们的一台中继 / `null` 认不出来（**不标角色**：
 *          标错比不标更糟，玩家会照着一个错的角色去排障）
 */
export function relayRoleOf(hostname: string, names: RelayTicketNames): 'relay' | null {
  const key = relayNameKey(hostname ?? '');
  if (!key) return null;

  const entries = names.allLabels
    .map((label) => ({ label, key: relayNameKey(label) }))
    .filter((entry) => entry.key.length > 0);
  if (entries.length === 0) return null;

  // ① 完全相同
  let hit = entries.find((entry) => entry.key === key);
  // ② 互相包含（长名字优先）
  if (!hit) {
    hit = entries
      .filter((entry) => entry.key.length >= 3 && (key.includes(entry.key) || entry.key.includes(key)))
      .sort((a, b) => b.key.length - a.key.length)[0];
  }
  // ③ 字符集合包含 —— 只在唯一命中时才认
  if (!hit) {
    const byChars = entries.filter((entry) => {
      const [short, long] = entry.key.length <= key.length ? [entry.key, key] : [key, entry.key];
      if (short.length < 3) return false;
      const pool = new Set([...long]);
      return [...short].every((ch) => pool.has(ch));
    });
    if (byChars.length === 1) hit = byChars[0];
  }
  /*
   * 中继集合模型下票据里的每一台都是中继 —— 没有"打洞节点"这个角色了。
   * （老版本这里还会拿 `punchLabel` 比一下，把 `relays[0]` 标成「打洞节点」，
   *   现在那样标必然是错的：成员票据只有一台，而它就是承载数据的那台。）
   */
  return hit ? 'relay' : null;
}
