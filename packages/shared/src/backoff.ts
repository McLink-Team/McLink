/**
 * 断线重连的退避时长（**带抖动**）。
 *
 * 为什么必须有抖动：如果退避是确定值（客户端原来就是写死的固定 4 秒），
 * 一次故障里掉线的所有客户端会在**同一毫秒**一起回来。主控是单线程的，
 * 刚恢复就被这一波打满：新连接的 SYN 排不进 accept 队列，内核直接丢包，
 * nginx 于是报 `upstream timed out (110) while connecting to upstream`，
 * 客户端再一起掉线 —— 自己制造出下一波（线上实测：同一秒里 6 个不同 IP 的 /ws 一起失败）。
 *
 * 抖动把这一波摊到一个区间里：0.5x–1.5x 随机。
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(Math.max(attempt, 0), 8);
  const base = Math.min(30_000, 1000 * 1.6 ** step);
  return Math.round(base * (0.5 + random()));
}
