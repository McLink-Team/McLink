/**
 * 虚拟网络地址规划。
 *
 * 每个房间独占一个 /24，从 10.200.0.0/16 里按 slot（0-255）分配：
 *   房间网段 = 10.200.<slot>.0/24
 *   房主     = 10.200.<slot>.1
 *   成员     = 10.200.<slot>.2 起依次分配
 *
 * 这样即使所有房间共用主控的同一个监听端口，各房间的 IP 平面也天然不冲突，
 * 房间被回收后其 slot 可再次使用。
 */

export const VNET_BASE_PREFIX = '10.200';
export const VNET_MAX_SLOTS = 256;
/** 每个房间最多可分配的成员地址数（.2 至 .254） */
export const VNET_MAX_MEMBERS = 253;

export function subnetForSlot(slot: number): string {
  assertSlot(slot);
  return `${VNET_BASE_PREFIX}.${slot}.0/24`;
}

export function hostIpForSlot(slot: number): string {
  assertSlot(slot);
  return `${VNET_BASE_PREFIX}.${slot}.1`;
}

export function memberIpForSlot(slot: number, seat: number): string {
  assertSlot(slot);
  if (!Number.isInteger(seat) || seat < 1 || seat > VNET_MAX_MEMBERS) {
    throw new RangeError(`成员座位号越界: ${seat}`);
  }
  return `${VNET_BASE_PREFIX}.${slot}.${seat + 1}`;
}

export function memberIpCidr(slot: number, seat: number): string {
  return `${memberIpForSlot(slot, seat)}/24`;
}

export function hostIpCidr(slot: number): string {
  return `${hostIpForSlot(slot)}/24`;
}

/** 从形如 `10.200.7.3` 的地址反解 slot */
export function slotFromIp(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const [, a, b, c] = m;
  if (`${a}.${b}` !== VNET_BASE_PREFIX) return null;
  const slot = Number(c);
  return Number.isInteger(slot) && slot >= 0 && slot < VNET_MAX_SLOTS ? slot : null;
}

export function isIpInSubnet(ip: string, subnet: string): boolean {
  const slot = slotFromIp(ip);
  if (slot === null) return false;
  return subnetForSlot(slot) === subnet.trim();
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= VNET_MAX_SLOTS) {
    throw new RangeError(`虚拟网段槽位越界: ${slot}`);
  }
}

/**
 * 按信号量语义挑选下一个可用 slot。
 * 传入当前占用的 slot 集合，返回最小可用值；若已满返回 null。
 */
export function allocateSlot(usedSlots: Iterable<number>): number | null {
  const used = new Set(usedSlots);
  for (let i = 0; i < VNET_MAX_SLOTS; i += 1) {
    if (!used.has(i)) return i;
  }
  return null;
}

/** 成员座位：跳过 0（房主占 .1） */
export function allocateSeat(usedSeats: Iterable<number>): number | null {
  const used = new Set(usedSeats);
  for (let i = 1; i <= VNET_MAX_MEMBERS; i += 1) {
    if (!used.has(i)) return i;
  }
  return null;
}
