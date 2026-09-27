/**
 * 流量会计：把「中继/节点侧的**累计**计数器」变成「可累加的**增量**账本」。
 *
 * 为什么需要它（线上问题）：EasyTier 的 `peer list-foreign` 给的是**从该实例启动算起的
 * 累计字节**。以前的写法是把这个累计值直接覆盖写进 `room_usage`，于是：
 *   · 中继一重启，房间的"累计流量"就归零（主控中继起不来时干脆一直是 0）；
 *   · 一个房间被两台节点同时转发时，两边的数字互相覆盖；
 *   · `users.used_bytes` 没有写入方，永远是 0（控制台的"用户流量"因此毫无意义）；
 *   · 「今日累计」只能靠 `max(rx_bytes)` 猜。
 *
 * 现在改成：每个来源（`master` = 主控自带中继；`node:<id>` = 某台子节点）的每个网络网络名
 * 各记一条基线，两次采样相减得增量，增量再：
 *   1. `+=` 进 `room_usage`（真累加，多源相加、重启不丢历史）；
 *   2. 写进 `traffic_ledger` 的 room / node / platform 维度；
 *   3. 按**成员当前上报的带宽份额**分摊给房间成员，`+=` 进 `users.used_bytes` 与 user 维度。
 *
 * 计数器回退的处理：`当前值 < 上次值` 说明该实例重启过，此时"当前值"就是重启后新产生的量
 * （重启前的量在上一轮已经入账），所以直接取当前值。反过来，如果重启发生在两次采样之间、
 * 而重启后累计又超过了上次的值，就会少记一段（无法从计数器本身分辨）。为此在两个明确
 * 时机调用 `forgetSource()` 清掉基线：主控中继启动、子节点重新注册。
 *
 * 口径说明（写进文档以免以后对不上账）：中继侧的 rx+tx 会把同一个包记两次
 * （发给对端的 tx 与对端收到的 rx 各一次），所以这是"流量计费口径"而不是"载荷口径"。
 */
import type { LedgerDelta, LedgerScope, TrafficLedgerRepo } from '../db/traffic.ts';
import type { RoomRepo } from '../db/rooms.ts';
import type { UserRepo } from '../db/users.ts';

export interface RelayedSample {
  networkName: string;
  /** 该实例自启动以来的累计接收/发送字节 */
  rxBytes: number;
  txBytes: number;
  /** 当前挂在这个网络上的 peer 数（瞬时值） */
  peerCount: number;
}

export interface AccountResult {
  /** 本轮入账的增量（该来源所有网络之和） */
  rxBytes: number;
  txBytes: number;
  /** 有增量的房间网络数 */
  rooms: number;
  /** 分摊到成员的字节数（进 users.used_bytes 的那部分） */
  userBytes: number;
}

interface Baseline {
  rx: number;
  tx: number;
  at: number;
}

export interface TrafficAccountantDeps {
  ledger: TrafficLedgerRepo;
  rooms: RoomRepo;
  users: UserRepo;
}

/** 成员带宽份额的"活跃窗口"：只有最近心跳过的成员才参与分摊 */
const MEMBER_ACTIVE_MS = 120_000;

export class TrafficAccountant {
  readonly #prev = new Map<string, Baseline>();
  readonly #deps: TrafficAccountantDeps;

  constructor(deps: TrafficAccountantDeps) {
    this.#deps = deps;
  }

  /**
   * 把某个来源某个网络的累计值转成增量。
   * 第一次看到这个来源只记基线（返回 0），避免把"历史总量"当成这一轮的增量。
   */
  delta(sourceKey: string, rxBytes: number, txBytes: number, atMs = Date.now()): { rx: number; tx: number } {
    const rx = Number.isFinite(rxBytes) ? Math.max(0, Math.round(rxBytes)) : 0;
    const tx = Number.isFinite(txBytes) ? Math.max(0, Math.round(txBytes)) : 0;
    const prev = this.#prev.get(sourceKey);
    this.#prev.set(sourceKey, { rx, tx, at: atMs });
    if (!prev) return { rx: 0, tx: 0 };
    return {
      // 回退 = 该实例重启过：当前值就是重启后新产生的量
      rx: rx >= prev.rx ? rx - prev.rx : rx,
      tx: tx >= prev.tx ? tx - prev.tx : tx,
    };
  }

  /**
   * 一个来源（主控中继 / 某台子节点）本轮上报的全部房间网络。
   *
   * @param sourceKey `master` 或 `node:<id>`
   * @param samples   该来源此刻转发的网络（**累计值**）
   * @param scope     记账维度：主控与子节点都记 node 维度时传节点 ID；主控传 'master'
   */
  account(
    sourceKey: string,
    samples: readonly RelayedSample[],
    at: Date = new Date(),
  ): AccountResult {
    const atMs = at.getTime();
    const perRoom: Array<RelayedSample & { rx: number; tx: number }> = [];
    let totalRx = 0;
    let totalTx = 0;
    for (const sample of samples) {
      const d = this.delta(`${sourceKey}|${sample.networkName}`, sample.rxBytes, sample.txBytes, atMs);
      if (d.rx === 0 && d.tx === 0) continue;
      perRoom.push({ ...sample, rx: d.rx, tx: d.tx });
      totalRx += d.rx;
      totalTx += d.tx;
    }
    this.forgetStale(atMs);
    if (perRoom.length === 0) return { rxBytes: 0, txBytes: 0, rooms: 0, userBytes: 0 };

    const items: LedgerDelta[] = [];
    // 平台维度：所有来源的增量之和
    items.push({ scope: 'platform', scopeId: 'all', rxBytes: totalRx, txBytes: totalTx });
    // 来源维度：主控中继记 'master'，子节点记它自己的 ID
    const sourceScope: LedgerScope = 'node';
    items.push({
      scope: sourceScope,
      scopeId: sourceKey.startsWith('node:') ? sourceKey.slice(5) : sourceKey,
      nodeId: sourceKey.startsWith('node:') ? sourceKey.slice(5) : null,
      rxBytes: totalRx,
      txBytes: totalTx,
    });

    let userBytes = 0;
    for (const room of perRoom) {
      const row = this.#deps.rooms.findByNetworkName(room.networkName);
      if (!row) {
        // 不在平台登记的网络（攻击者自己造的网名、或房间已删除）：只记平台与来源维度
        continue;
      }
      this.#deps.rooms.incrementUsage(row.id, room.rx, room.tx, room.peerCount);
      items.push({ scope: 'room', scopeId: row.id, roomId: row.id, rxBytes: room.rx, txBytes: room.tx });

      for (const [userId, ratio] of this.#memberShares(row.id, atMs)) {
        const rx = Math.round(room.rx * ratio);
        const tx = Math.round(room.tx * ratio);
        if (rx === 0 && tx === 0) continue;
        items.push({ scope: 'user', scopeId: userId, roomId: row.id, userId, rxBytes: rx, txBytes: tx });
        this.#deps.users.addUsage(userId, rx + tx);
        userBytes += rx + tx;
      }
    }

    this.#deps.ledger.addMany(items, at);
    return { rxBytes: totalRx, txBytes: totalTx, rooms: perRoom.length, userBytes };
  }

  /**
   * 成员分摊比例：按成员**最近上报的实时带宽**占比。
   *
   * 为什么用带宽份额而不是问中继要"每个 peer 的字节数"：EasyTier 的 `peer list-foreign`
   * 只给 `peer_id`（`PeerInfo` 里 IP 字段是空的，见 upstream 的 `list_foreign_networks`），
   * 拿不到"哪个成员用了多少"。而客户端心跳已经在上报自己的 rx/tx 速率，
   * 按它分摊是**零客户端改动**下最接近事实的做法。
   *
   * 边界情况：所有人速率都是 0（刚开始传、或客户端还没上报）时按人数均分；
   * 最近没心跳的成员不参与（否则"人不在了还在扣流量"）。
   */
  #memberShares(roomId: string, atMs: number): Array<[string, number]> {
    const members = this.#deps.rooms
      .listMembers(roomId)
      .filter((m) => {
        if (!m.last_seen_at) return false;
        const seen = Date.parse(m.last_seen_at);
        return Number.isFinite(seen) && atMs - seen <= MEMBER_ACTIVE_MS;
      });
    if (members.length === 0) return [];
    if (members.length === 1) return [[members[0]!.user_id, 1]];

    const weight = (m: (typeof members)[number]): number => Math.max(0, m.rx_bps) + Math.max(0, m.tx_bps);
    const total = members.reduce((acc, m) => acc + weight(m), 0);
    if (total <= 0) {
      const even = 1 / members.length;
      return members.map((m) => [m.user_id, even] as [string, number]);
    }
    return members.map((m) => [m.user_id, weight(m) / total] as [string, number]);
  }

  /** 清掉某个来源的全部基线（中继重启 / 子节点重新注册时调用） */
  forgetSource(sourceKey: string): void {
    for (const key of [...this.#prev.keys()]) {
      if (key === sourceKey || key.startsWith(`${sourceKey}|`)) this.#prev.delete(key);
    }
  }

  /** 清掉长时间没上报的来源，避免内存无上限增长（房间结束、节点下线） */
  forgetStale(atMs = Date.now(), maxAgeMs = 10 * 60_000): number {
    let removed = 0;
    for (const [key, base] of [...this.#prev.entries()]) {
      if (atMs - base.at > maxAgeMs) {
        this.#prev.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 诊断用：当前跟踪的来源数 */
  trackedSources(): number {
    return new Set([...this.#prev.keys()].map((k) => k.split('|')[0])).size;
  }
}
