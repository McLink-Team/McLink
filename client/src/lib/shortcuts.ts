/**
 * 收藏与「最近进入」房间的本地持久化。
 *
 * 为什么只存本机 localStorage：这是「这台机器上这个人的习惯」，换台机器没有意义，
 * 也不该被主控收集。记录里只放客户端自己见过的信息（房间名、加入码、上次的联机地址），
 * 不含网络名/密钥这类凭证 —— 那些只能由主控票据接口现签现用。
 */
import { ref } from 'vue';

export interface RoomShortcut {
  roomId: string;
  code: string;
  name: string;
  /** 上次进入时的联机地址（房主虚拟 IP），未知时为 null */
  lastAddress: string | null;
  lastSeenAt: string;
}

const FAVORITES_KEY = 'mclink.favorites';
const RECENT_KEY = 'mclink.recentRooms';
/** 最近进入最多保留的条数 */
const RECENT_MAX = 10;

/**
 * 每次写入 +1。界面用 computed 依赖它重新读 localStorage：
 * 这样收藏/最近列表能在多个面板之间保持同步，而不必引入额外的状态库。
 */
export const shortcutsRevision = ref(0);

function readRaw(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitize(value: unknown): RoomShortcut | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.roomId !== 'string' || row.roomId.length === 0) return null;
  if (typeof row.code !== 'string' || row.code.length === 0) return null;
  return {
    roomId: row.roomId,
    code: row.code,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.code,
    lastAddress: typeof row.lastAddress === 'string' && row.lastAddress.length > 0 ? row.lastAddress : null,
    lastSeenAt: typeof row.lastSeenAt === 'string' ? row.lastSeenAt : new Date(0).toISOString(),
  };
}

function readList(key: string): RoomShortcut[] {
  const raw = readRaw(key);
  if (!Array.isArray(raw)) return [];
  const out: RoomShortcut[] = [];
  for (const item of raw) {
    const entry = sanitize(item);
    if (entry && !out.some((x) => x.roomId === entry.roomId)) out.push(entry);
  }
  return out.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

function writeList(key: string, list: RoomShortcut[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* 隐私模式/配额满：忽略，功能降级为「本次会话有效」 */
  }
  shortcutsRevision.value += 1;
}

export function loadFavorites(): RoomShortcut[] {
  return readList(FAVORITES_KEY);
}

export function loadRecent(): RoomShortcut[] {
  return readList(RECENT_KEY);
}

export function isFavorite(roomId: string): boolean {
  return loadFavorites().some((f) => f.roomId === roomId);
}

/** 收藏 / 取消收藏；返回操作后的收藏状态 */
export function toggleFavorite(entry: RoomShortcut): boolean {
  const list = loadFavorites();
  const exists = list.some((f) => f.roomId === entry.roomId);
  const next = exists ? list.filter((f) => f.roomId !== entry.roomId) : [entry, ...list];
  writeList(FAVORITES_KEY, next);
  return !exists;
}

export function forgetFavorite(roomId: string): void {
  writeList(
    FAVORITES_KEY,
    loadFavorites().filter((f) => f.roomId !== roomId),
  );
}

/** 进入房间成功后写入最近记录（最多 RECENT_MAX 条，重复进入只更新时间） */
export function recordRecent(entry: RoomShortcut): void {
  const list = loadRecent().filter((r) => r.roomId !== entry.roomId);
  list.unshift(entry);
  writeList(RECENT_KEY, list.slice(0, RECENT_MAX));
  // 收藏项里的名字/地址也顺手更新，避免显示的还是很久以前的信息
  const favorites = loadFavorites();
  const index = favorites.findIndex((f) => f.roomId === entry.roomId);
  if (index >= 0) {
    const current = favorites[index];
    if (current) {
      favorites[index] = { ...current, name: entry.name, code: entry.code, lastAddress: entry.lastAddress, lastSeenAt: entry.lastSeenAt };
      writeList(FAVORITES_KEY, favorites);
    }
  }
}

export function removeRecent(roomId: string): void {
  writeList(
    RECENT_KEY,
    loadRecent().filter((r) => r.roomId !== roomId),
  );
}

export function clearRecent(): void {
  writeList(RECENT_KEY, []);
}
