/**
 * 中继节点的延迟探测：**TCP 握手（tcping）**，不是 ICMP。
 *
 * 为什么换成 TCP：建房页要回答的问题是「我连这个中继要多久」，而玩家真正要连的是中继的
 * **链接端口**。ICMP 只证明主机在网络层活着，跟那个端口能不能连是两件事，线上两种误判都出现过：
 *   · 主机不答 ICMP（不少机房默认屏蔽或限速）→ 界面显示「—」，节点其实完全可用；
 *   · 主机答 ICMP 很快，但中继端口被安全组挡着 → 界面显示「12 ms」，玩家点进去连不上。
 * 对链接端口做一次 TCP 握手，量出来的包含 DNS 解析 + 路由 + 端口放行 + 握手，
 * 与真正建房走的是同一条路径。
 *
 * 实现用 Node 原生 `net`：三平台一致、零依赖、零提权（raw socket 做 SYN 探测要管理员/root，
 * 代价比这点精度大得多）。代价是**会在中继上留下一次「连上就断」的记录** ——
 * 这是 tcping 的固有行为，EasyTier 只会记一条普通连接关闭。
 *
 * **结果只用于展示与排序**：握手失败返回 null（界面显示「—」），不参与可用性判断 ——
 * 单次超时可能只是瞬时抖动，不能让一个节点因此从选单里消失。
 *
 * 离线校验：`node client/scripts/verify-tcping.mjs`（自己起真实监听、自己制造失败）。
 */
const net = require('node:net');

/** 单次握手超时：与旧 ICMP 探测（`ping -w 1200`）同量级，界面等的秒数不变 */
const TCPING_TIMEOUT_MS = 1200;
/** 采样次数：取最小值，压掉调度抖动（对应旧实现的 `ping -n 2`） */
const TCPING_ATTEMPTS = 2;
/** 一次最多探多少个目标：节点再多也不该把界面按住 */
const TCPING_MAX_TARGETS = 24;
/**
 * 主机部分只接受 DNS 名/IPv4 的字符集，与平台校验 `endpoint` 的规则一致
 * （见 packages/shared/src/validation.ts 的 `isValidHostPort`）。
 * 端口是独立字段，所以这里**不接受冒号** —— 否则 `host:port` 这个键会有歧义。
 */
const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 一次 TCP 握手耗时（ms）。
 *
 * 计时从 `connect()` 调用那一刻算起，**含 DNS 解析**：玩家感受到的等待就是这些。
 * 连上即断开、不发任何字节 —— 我们要的只是握手这一段的时间。
 *
 * @param {string} host 主机名或 IPv4
 * @param {number} port 端口
 * @param {number} [timeoutMs] 单次超时
 * @returns {Promise<number|null>} 连上返回毫秒数（浮点），超时或出错返回 null
 */
function tcpHandshakeMs(host, port, timeoutMs = TCPING_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = new net.Socket();
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    /**
     * 硬兜底：不指望 `socket.setTimeout` 一定在**连接阶段**生效
     * （它的语义是「空闲超时」，连接中的行为各版本有过变化），
     * 自己再压一个定时器，保证最坏情况一定有结果返回。
     */
    timer = setTimeout(() => finish(null), timeoutMs + 50);
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(Number(process.hrtime.bigint() - started) / 1e6));
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
    try {
      socket.connect({ host, port });
    } catch {
      finish(null);
    }
  });
}

/**
 * 过滤 + 去重探测目标。
 * 去重是因为渲染进程可能把同一个节点列两遍，而同一个 `host:port` 探两次没有意义。
 *
 * @param {unknown} targets
 * @returns {Array<{host: string, port: number}>}
 */
function normalizeTargets(targets) {
  const seen = new Map();
  for (const raw of Array.isArray(targets) ? targets : []) {
    const host = typeof raw?.host === 'string' ? raw.host.trim() : '';
    const port = Number(raw?.port);
    if (!HOST_PATTERN.test(host)) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    seen.set(`${host}:${port}`, { host, port });
    if (seen.size >= TCPING_MAX_TARGETS) break;
  }
  return [...seen.values()];
}

/**
 * 批量探测：目标之间**并行**（界面只等最慢的那一个），同一个目标采样两次取最小值。
 * 最坏等待 = 采样次数 × 单次超时（约 2.4 秒），与旧 ICMP 探测的两次 echo 同量级。
 *
 * @param {unknown} targets `[{ host, port }]`
 * @param {{timeoutMs?: number, attempts?: number}} [options] 仅供校验脚本调参
 * @returns {Promise<Record<string, number|null>>} 键是 `host:port`：整数毫秒，或 null（没连上）
 */
async function tcpPingAll(targets, options = {}) {
  const timeoutMs = options.timeoutMs ?? TCPING_TIMEOUT_MS;
  const attempts = options.attempts ?? TCPING_ATTEMPTS;
  const out = {};
  await Promise.all(
    normalizeTargets(targets).map(async ({ host, port }) => {
      let best = null;
      for (let i = 0; i < attempts; i += 1) {
        const ms = await tcpHandshakeMs(host, port, timeoutMs);
        if (ms === null) continue;
        if (best === null || ms < best) best = ms;
      }
      /**
       * 亚毫秒的握手（本机中继）显示成「0 ms」会让人以为没测到，下限取 1。
       * 四舍五入到整数：界面那一格是给人扫一眼排序用的，小数只是噪声。
       */
      out[`${host}:${port}`] = best === null ? null : Math.max(1, Math.round(best));
    }),
  );
  return out;
}

module.exports = {
  HOST_PATTERN,
  TCPING_ATTEMPTS,
  TCPING_MAX_TARGETS,
  TCPING_TIMEOUT_MS,
  normalizeTargets,
  tcpHandshakeMs,
  tcpPingAll,
};
