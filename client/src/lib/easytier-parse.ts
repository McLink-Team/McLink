/**
 * `easytier-cli` JSON 输出的解析工具（纯函数，无依赖）。
 *
 * 为什么单独成文件：这些解析是「界面能不能正确显示网络状态」的关键，
 * 又完全依赖 EasyTier 的输出结构，因此抽出来以便用真实 CLI 输出做离线校验
 * （见 client/scripts/verify-diagnostic.mjs，fixture 就是从 easytier-cli 2.6.4 抄下来的）。
 *
 * 已核对的真实结构（easytier-cli 2.6.4）：
 *   node info  → { peer_id: <number>, ipv4_addr: string, hostname, version,
 *                  stun_info: { udp_nat_type: <number>, tcp_nat_type: <number>,
 *                               public_ip: string[], min_port, max_port },
 *                  listeners: string[] }
 *   peer list  → [{ cidr, ipv4, hostname, cost, lat_ms, loss_rate, rx_bytes, tx_bytes,
 *                   tunnel_proto, nat_type, id, version }]
 * 注意：`peer_id` 是数字（不是字符串）、虚拟地址字段叫 `ipv4_addr`、
 * 公网 IP 在 `stun_info.public_ip` 里是数组 —— 早先按猜测写的键名全部落空。
 */

/** easytier-cli 的 JSON 输出把数值格式化成 "17.33 kB" / "-" 这样的字符串 */
export function parseHumanNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const text = value.trim();
  if (text.length === 0 || text === '-' || text === '*') return 0;
  const m = /^([\d.]+)\s*([a-zA-Z]*)$/.exec(text);
  if (!m) return 0;
  const base = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(base)) return 0;
  const unit = (m[2] ?? '').toLowerCase();
  const factors: Record<string, number> = {
    '': 1,
    b: 1,
    kb: 1000,
    mb: 1e6,
    gb: 1e9,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
  };
  return base * (factors[unit] ?? 1);
}

export function parseLatency(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text === '-' || text === '*') return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

export interface PeerView {
  hostname: string;
  ipv4: string;
  cost: string;
  latencyMs: number | null;
  rxBytes: number;
  txBytes: number;
  tunnelProto: string;
  /** EasyTier 自己给出的 NAT 类型名（如 SymmetricEasyInc），未知时为空串 */
  natType: string;
}

function readableString(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '-' ? '' : text;
}

/**
 * 把 `easytier-cli peer list` 的 JSON 输出解析成界面用的结构。
 * 本机那一行（cost = Local 且没有虚拟地址）会被跳过：它不是「其它节点」。
 */
export function parsePeers(data: unknown): PeerView[] {
  if (!Array.isArray(data)) return [];
  const out: PeerView[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    const ipv4 = String(row.ipv4 ?? '');
    const cost = String(row.cost ?? '');
    if (cost === 'Local' && ipv4.length === 0) continue;
    out.push({
      hostname: String(row.hostname ?? ''),
      ipv4,
      cost,
      latencyMs: parseLatency(row.lat_ms),
      rxBytes: parseHumanNumber(row.rx_bytes),
      txBytes: parseHumanNumber(row.tx_bytes),
      tunnelProto: readableString(row.tunnel_proto),
      natType: readableString(row.nat_type),
    });
  }
  return out;
}

/**
 * 取本机那一行的 NAT 类型名。
 * 这不是我们编的映射：EasyTier 的 CLI 自己在 `peer list` 里就把数字翻译成了名字
 * （实测 udp_nat_type = 8 → "SymmetricEasyInc"）。
 */
export function parseLocalNatType(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  for (const row of data as Array<Record<string, unknown>>) {
    if (String(row.cost ?? '') !== 'Local') continue;
    const name = readableString(row.nat_type);
    if (name.length > 0) return name;
  }
  return null;
}

/** 链路类型：p2p = 直连，relay = 经中继，local = 本机 */
export function linkKind(cost: string): 'p2p' | 'relay' | 'local' | 'other' {
  const value = cost.toLowerCase();
  if (value.startsWith('local')) return 'local';
  if (value.startsWith('p2p')) return 'p2p';
  if (value.includes('relay')) return 'relay';
  return 'other';
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

/* --------------------------------------------------- node info 提取 */

export interface NodeFacts {
  peerId: string | null;
  hostname: string | null;
  virtualIp: string | null;
  publicIp: string | null;
  /** STUN 探测出的 UDP NAT 类型码（EasyTier 的数字，含义以官方文档为准） */
  natUdp: number | null;
  natTcp: number | null;
  listenUrls: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把嵌套的 CLI JSON 摊平成一组对象，之后按键名找值 —— 比死记 schema 更耐版本变化 */
export function flattenRecords(value: unknown, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 5 || out.length > 200) return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenRecords(item, out, depth + 1);
    return out;
  }
  if (!isRecord(value)) return out;
  out.push(value);
  for (const child of Object.values(value)) flattenRecords(child, out, depth + 1);
  return out;
}

/** 依次尝试多个键名，返回第一个非空字符串（数字会被转成字符串） */
export function pickString(records: Record<string, unknown>[], keys: string[]): string | null {
  for (const rec of records) {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}

export function pickNumber(records: Record<string, unknown>[], keys: string[]): number | null {
  for (const rec of records) {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}

/** 取字符串数组；元素是对象时退回读它的 `url` / `addr` 字段 */
export function pickStringList(records: Record<string, unknown>[], keys: string[]): string[] {
  for (const rec of records) {
    for (const key of keys) {
      const value = rec[key];
      if (!Array.isArray(value)) continue;
      const items: string[] = [];
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) items.push(item);
        else if (isRecord(item)) {
          const url = item.url ?? item.addr;
          if (typeof url === 'string' && url.length > 0) items.push(url);
        }
      }
      if (items.length > 0) return items;
    }
  }
  return [];
}

export function extractNodeFacts(data: unknown): NodeFacts {
  const records = flattenRecords(data);
  return {
    peerId: pickString(records, ['peer_id', 'peerId']),
    hostname: pickString(records, ['hostname', 'host_name']),
    // 真实字段名是 ipv4_addr；ipv4/virtual_ip 只是兼容旧版本
    virtualIp: pickString(records, ['ipv4_addr', 'ipv4', 'virtual_ip', 'virtualIp']),
    // 公网 IP 在 stun_info 里是数组，所以先按数组找，再退回普通字段
    publicIp:
      pickStringList(records, ['public_ip', 'publicIp'])[0] ?? pickString(records, ['public_ip', 'publicIp']),
    natUdp: pickNumber(records, ['udp_nat_type', 'udpNatType']),
    natTcp: pickNumber(records, ['tcp_nat_type', 'tcpNatType']),
    listenUrls: pickStringList(records, ['listeners', 'listen_urls', 'listenUrls']),
  };
}

/** 从监听地址里取端口，例如 tcp://0.0.0.0:11010 → 11010 */
export function listenPortsOf(urls: string[]): string[] {
  const ports: string[] = [];
  for (const url of urls) {
    const m = /:(\d+)\s*$/.exec(url);
    if (m && m[1] && !ports.includes(m[1])) ports.push(m[1]);
  }
  return ports;
}
