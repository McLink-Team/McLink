/**
 * 房间聊天仓储。
 *
 * 设计取舍：
 *  - 消息只经过主控（不点对点），因此房主/成员在任何连接方式下都能看到同一份历史；
 *  - 不做端到端加密——房间里的一切本来就对主控可见（票据、成员、流量都由主控签发），
 *    假称 E2E 反而误导用户；
 *  - 保留量有上限（每房间最多 KEEP_PER_ROOM 条），并在定期清理时删除过期消息，
 *    避免 SQLite 被聊天记录无限撑大。
 */
import type { ChatMessage, ChatMessageKind } from '@mclink/shared';
import { Db, nowIso } from './index.ts';

/** 每个房间保留的最大消息条数 */
export const KEEP_PER_ROOM = 500;
/** 消息最长字符数（按码点计，避免把 emoji 截断成乱码） */
export const MAX_BODY_CHARS = 500;

export interface MessageRow {
  id: number;
  room_id: string;
  user_id: string | null;
  display_name: string;
  role: string;
  kind: string;
  body: string;
  created_at: string;
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role as ChatMessage['role'],
    kind: row.kind as ChatMessageKind,
    body: row.body,
    createdAt: row.created_at,
  };
}

export class MessageRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  add(input: {
    roomId: string;
    userId: string | null;
    displayName: string;
    role: ChatMessage['role'];
    kind?: ChatMessageKind;
    body: string;
  }): ChatMessage {
    const res = this.db.run(
      `insert into room_messages (room_id, user_id, display_name, role, kind, body, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      input.roomId,
      input.userId,
      input.displayName,
      input.role,
      input.kind ?? 'text',
      input.body,
      nowIso(),
    );
    const id = Number(res.lastInsertRowid);
    const row = this.db.get<MessageRow>('select * from room_messages where id = ?', id);
    if (!row) throw new Error('写入聊天消息后无法读回记录');
    return toMessage(row);
  }

  /**
   * 取历史消息。
   * `sinceId` 用于增量拉取（重连后补齐断线期间的消息），
   * 否则返回最近 `limit` 条（按时间正序，便于直接渲染）。
   */
  list(roomId: string, options: { sinceId?: number; limit?: number } = {}): ChatMessage[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);
    if (options.sinceId && options.sinceId > 0) {
      const rows = this.db.all<MessageRow>(
        'select * from room_messages where room_id = ? and id > ? order by id asc limit ?',
        roomId,
        options.sinceId,
        limit,
      );
      return rows.map(toMessage);
    }
    const rows = this.db.all<MessageRow>(
      'select * from room_messages where room_id = ? order by id desc limit ?',
      roomId,
      limit,
    );
    return rows.reverse().map(toMessage);
  }

  findById(messageId: number): MessageRow | undefined {
    return this.db.get<MessageRow>('select * from room_messages where id = ?', messageId);
  }

  remove(messageId: number): void {
    this.db.run('delete from room_messages where id = ?', messageId);
  }

  /** 统计某用户在某房间最近一段时间内发了多少条，用于发言限流 */
  countRecentByUser(roomId: string, userId: string, windowSeconds: number): number {
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
    return Number(
      this.db.scalar<number>(
        'select count(*) as c from room_messages where room_id = ? and user_id = ? and created_at >= ?',
        roomId,
        userId,
        cutoff,
      ) ?? 0,
    );
  }

  countInRoom(roomId: string): number {
    return Number(
      this.db.scalar<number>('select count(*) as c from room_messages where room_id = ?', roomId) ?? 0,
    );
  }

  /** 只保留每房间最近 KEEP_PER_ROOM 条 */
  trim(roomId: string): number {
    const res = this.db.run(
      `delete from room_messages where room_id = ? and id not in (
         select id from room_messages where room_id = ? order by id desc limit ?
       )`,
      roomId,
      roomId,
      KEEP_PER_ROOM,
    );
    return Number(res.changes ?? 0);
  }

  /** 定期清理：删除最后一个活跃房间也没有消息的房间记录 + 过期消息 */
  /**
   * 清理过期聊天记录。同样是同步 SQLite，所以按批删（调用方循环 + 让出事件循环）。
   * 聊天量比流量采样小得多，但长期跑的库、房间开开关关也可能攒出几万条。
   */
  pruneOlderThan(hours: number, limit = 2000): number {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const res = this.db.run(
      `delete from room_messages
        where rowid in (select rowid from room_messages where created_at < ? limit ?)`,
      cutoff,
      limit,
    );
    return Number(res.changes ?? 0);
  }

  /** 房间关闭时清空其聊天记录 */
  clearRoom(roomId: string): number {
    const res = this.db.run('delete from room_messages where room_id = ?', roomId);
    return Number(res.changes ?? 0);
  }
}

/** 按码点截断，避免把 emoji / 代理对切成乱码 */
export function clampBody(body: string, max = MAX_BODY_CHARS): string {
  const chars = [...body];
  return chars.length <= max ? body : `${chars.slice(0, max).join('')}…`;
}
