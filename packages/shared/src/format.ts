/** 字节数转人类可读；用于流量面板与控制台 */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/** 比特率（bps）；EasyTier 的 *_bps_limit 字段语义为 bit/s */
export function formatBitrate(bps: number, digits = 1): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0 bps';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bps) / Math.log(1000)));
  return `${(bps / 1000 ** i).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/**
 * 把界面上的「kbps（千比特/秒）」换算成 EasyTier 的 `*_bps_limit` 字段值。
 *
 * ⚠️ 单位陷阱：EasyTier 的字段名虽然写作 `_bps_`，但它的单位是**字节/秒**，
 * 不是比特/秒。依据是 EasyTier 自己的测试
 * （`easytier/src/tests/three_node.rs` 的 `instance_recv_bps_limit_test`）：
 * 配置写 `bps_limit * 1024`，随后把实测吞吐换算成 KiB/s 与 `bps_limit` 比较，
 * 即「配置值 1024 → 每秒 1024 字节」。
 *
 * 早先按比特/秒换算（`kbps * 1000`），会让玩家实际拿到 **8 倍**于界面所配的带宽；
 * 这个 8 倍偏差是通过真实数据面测速才发现的（见 scripts/lab-dataplane.mjs）。
 */
export function kbpsToBytesPerSecond(kbps: number): number {
  if (!Number.isFinite(kbps) || kbps <= 0) return 0;
  // kbps(千比特/秒) → 比特/秒 → 字节/秒
  return Math.floor((kbps * 1000) / 8);
}

/**
 * 旧名保留：历史上的实现按比特/秒换算，是错的。
 * 新代码一律用 kbpsToBytesPerSecond，这里只做转发并保留注释以免再被误用。
 */
export function kbpsToBps(kbps: number): number {
  return kbpsToBytesPerSecond(kbps);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

export function formatRelativeTime(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined) return '从未';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '未知';
  const diff = Math.max(0, now - t) / 1000;
  if (diff < 5) return '刚刚';
  if (diff < 60) return `${Math.floor(diff)} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
