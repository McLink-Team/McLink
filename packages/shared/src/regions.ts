/**
 * 中国大陆常见的大区划分。主控在下发中继节点时按此维度分组，
 * 客户端让玩家自行选择「就近区域」。
 */
export interface RegionDef {
  /** 稳定标识，落库与 API 均使用该值 */
  id: string;
  /** 中文展示名 */
  label: string;
  /** 排序权重，越小越靠前 */
  order: number;
  /** 建议的子节点部署地（运维参考） */
  hint: string;
}

export const REGIONS: readonly RegionDef[] = [
  /**
   * `auto` 的标签在「建房自动选中继」改成延迟优先后**才是准确的**：
   * 主控没有自己测延迟的能力，用的是客户端建房那一刻上报的 `latencyHints`
   * （见 protocol.ts 的 RelayLatencyHint），延迟接近时再比负载与余量。
   * 客户端一条都没测到时（或老客户端），退化为纯负载打分 —— 这条标签仍然描述的是平台的策略。
   */
  { id: 'auto', label: '自动选择（延迟优先）', order: 0, hint: '主控按客户端实测延迟优先、延迟接近时再看负载推荐' },
  { id: 'cn-east', label: '华东', order: 10, hint: '上海 / 杭州 / 南京' },
  { id: 'cn-south', label: '华南', order: 20, hint: '广州 / 深圳 / 厦门' },
  { id: 'cn-north', label: '华北', order: 30, hint: '北京 / 天津' },
  { id: 'cn-central', label: '华中', order: 40, hint: '武汉 / 长沙 / 郑州' },
  { id: 'cn-southwest', label: '西南', order: 50, hint: '成都 / 重庆' },
  { id: 'cn-northwest', label: '西北', order: 60, hint: '西安 / 兰州' },
  { id: 'cn-northeast', label: '东北', order: 70, hint: '沈阳 / 大连' },
  { id: 'hk', label: '香港', order: 80, hint: 'CN2 / BGP 出海' },
  { id: 'oversea', label: '海外', order: 90, hint: '新加坡 / 东京 / 洛杉矶' },
] as const;

export const REGION_IDS = REGIONS.map((r) => r.id);

const REGION_MAP = new Map(REGIONS.map((r) => [r.id, r]));

export function getRegion(id: string): RegionDef | undefined {
  return REGION_MAP.get(id);
}

export function regionLabel(id: string): string {
  return REGION_MAP.get(id)?.label ?? id;
}

export function isKnownRegion(id: string): boolean {
  return REGION_MAP.has(id);
}
