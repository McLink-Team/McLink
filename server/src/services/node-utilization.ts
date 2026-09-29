/**
 * 节点带宽利用率的 EWMA（指数加权移动平均）。
 *
 * 为什么单独一个模块：**两个服务都要用它**，而它们之间不该互相依赖（会成环）——
 *   · NodeService 在心跳里写入采样，并据此把节点标成 degraded；
 *   · RoomService 在调度新房间时读它算带宽余量。
 * 所以由 app.ts 构造一个实例，注入给两边（与项目里"依赖显式注入"的一贯做法一致）。
 *
 * 时间常数 3 分钟：节点心跳 20 秒一次，瞬时速率是脉冲式的（一次存档同步就能顶满），
 * 不做平滑的话调度会跟着抖；3 分钟刚好覆盖"一次大流量事件"，又能在一两分钟内反映真实趋势。
 * 注意这里只影响**新票据**：我们不会为了缓解负载去改节点配置 ——
 * 那要重启 easytier-core，会把该节点上所有房间抖一遍（见 rooms.ts 的调度注释）。
 */

/** 一次采样的记录 */
interface Sample {
  /** 平滑后的"已用带宽"（bit/s） */
  usedBps: number;
  /** 采样时刻，用来算 dt */
  at: number;
}

/** 纯函数：指数加权移动平均。dt 越大、alpha 越大（越信任新样本） */
export function ewma(prev: number, sample: number, dtMs: number, tauMs: number): number {
  const alpha = 1 - Math.exp(-Math.max(0, dtMs) / Math.max(1, tauMs));
  return prev + alpha * (sample - prev);
}

/** 全平台一致的带宽卸荷线：利用率到 90% 就不再把**新房间**分给它 */
export const UTIL_SHED = 0.9;

/**
 * 某台节点自己的「不再接新房间」利用率阈值。
 *
 * 为什么小管子要更早卸荷（用户 2026-09-28 提的）：90% 这条线对大带宽节点是"还有余量"，
 * 对小管子却是"已经贴着天花板"—— 5 Mbps 的机器跑到 85% 时，再来一个房间就会把
 * 已经在玩的房间一起拖慢（中继是单线程转发，丢包会传导到房间里的每个人）。
 * 所以**带宽小的节点在 80%（可配）就停止新增中继**，但**默认仍然可以中继**：
 * 这条线只挡"新房间"，已经跑在上面的房间一个都不动。
 *
 * 「小管子」的判定与调度里的大带宽档一致：声明了 `capacity_bps` 且小于 `bigPipeBps`。
 *   · `capacity_bps = 0`（控制台没填 = 不限）→ 不算小管子，用 90%；
 *   · 管理员把 `smallShedPercent` 调到比 90% 还高时封顶在 90%（永远不比全局线更晚卸荷）。
 */
export function shedUtilFor(
  capacityBps: number | null | undefined,
  bigPipeBps: number,
  smallShedPercent: number,
): number {
  const capacity = capacityBps ?? 0;
  const isSmall = capacity > 0 && capacity < bigPipeBps;
  if (!isSmall) return UTIL_SHED;
  const percent = Number.isFinite(smallShedPercent) ? smallShedPercent : 80;
  return Math.min(UTIL_SHED, Math.max(1, percent) / 100);
}

export class NodeUtilization {
  readonly #samples = new Map<string, Sample>();
  readonly tauMs: number;

  constructor(tauMs = 3 * 60_000) {
    this.tauMs = tauMs;
  }

  /**
   * 记一次采样，返回平滑后的已用带宽（bit/s）。
   *
   * 取**收发的较大者**：云厂商标的「5 Mbps」通常按单向计，所以约束在大的那个方向上。
   * 第一次采样直接作为初值 —— 否则冷启动（或主控重启）后要几分钟才收敛，
   * 而这期间调度看到的利用率一直是 0。
   */
  record(nodeId: string, rxBps: number, txBps: number, now = Date.now()): number {
    const used = Math.max(0, rxBps, txBps);
    const prev = this.#samples.get(nodeId);
    const value = prev ? ewma(prev.usedBps, used, now - prev.at, this.tauMs) : used;
    this.#samples.set(nodeId, { usedBps: value, at: now });
    return value;
  }

  usedBps(nodeId: string): number {
    return this.#samples.get(nodeId)?.usedBps ?? 0;
  }

  /** 利用率 0–1；节点没设上限（capacityBps <= 0）时返回 0，表示"不构成约束" */
  utilization(nodeId: string, capacityBps: number): number {
    if (!(capacityBps > 0)) return 0;
    return Math.min(1, this.usedBps(nodeId) / capacityBps);
  }

  /** 节点被删掉时清掉它的采样，避免长跑进程里攒下无主记录 */
  forget(nodeId: string): void {
    this.#samples.delete(nodeId);
  }
}
