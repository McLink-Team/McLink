/**
 * EasyTier 链路类型判定 —— 全平台只此一份。
 *
 * 控制台、客户端诊断面板、服务端心跳三处都要回答同一个问题「这条 peer 是直连还是经中继」，
 * 规则必须一致。踩过的坑：服务端以前用「这条 peer 有 lat_ms 就算直连」，
 * 而 EasyTier 对**经中继的路由同样会报延迟**，于是走中继的成员在房间管理里被一律标成 P2P
 * （用户实测反馈：明明全是中继，列表里人人 P2P）。
 *
 * `cost` 是 `easytier-cli peer list` 的原始字符串，实测取值形如：`Local`、`p2p`、`relay(1)`。
 * 未知形态一律落到 `other`（**不**当作直连），宁可显示"未知"也不要给玩家一个假的直连结论。
 */
export type LinkKind = 'p2p' | 'relay' | 'local' | 'other';

export function linkKind(cost: string): LinkKind {
  const value = cost.toLowerCase();
  if (value.startsWith('local')) return 'local';
  if (value.startsWith('p2p')) return 'p2p';
  if (value.includes('relay')) return 'relay';
  return 'other';
}

/** 只有真正打洞成功（`p2p`）才算直连；经中继与未知一律 false。 */
export function isDirectLink(cost: string): boolean {
  return linkKind(cost) === 'p2p';
}

/**
 * 链路类型的展示文案。
 *
 * 原来这段逻辑写在模板里（三层嵌套三元），既难读，`other` 分支还会把 EasyTier 的
 * 原始 cost 字符串直接丢给玩家。抽成函数后每种类型都有一句人话，未知类型也有兜底。
 */
export function linkLabel(cost: string): string {
  switch (linkKind(cost)) {
    case 'p2p':
      return 'P2P 直连';
    case 'relay':
      return '经中继';
    case 'local':
      return '本机';
    default:
      return cost ? `其它（${cost}）` : '未知';
  }
}
