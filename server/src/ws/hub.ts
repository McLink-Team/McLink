/**
 * WebSocket 实时推送中心。
 *
 * 认证方式：连接时通过 `?token=` 或在 `hello` 帧里带令牌。
 * 订阅模型是「话题（topic）」——客户端只收到自己订阅得起的话题，
 * 服务端据此做权限过滤（例如 `room:<id>` 需要是该房间成员）。
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Topics, type ClientEvent, type ServerEvent } from '@mclink/shared';
import { logger } from '../logger.ts';
import type { AuthContext } from '../http/kit.ts';

const log = logger('ws');

export interface WsClient {
  id: string;
  socket: WebSocket;
  auth: AuthContext | null;
  topics: Set<string>;
  ip: string;
  alive: boolean;
  connectedAt: number;
}

export interface WsHubOptions {
  server: Server;
  path: string;
  /** 解析令牌 → 用户上下文 */
  resolveToken: (token: string) => AuthContext | null;
  /** 订阅话题的授权检查；返回 false 则拒绝订阅 */
  authorizeTopic: (client: WsClient, topic: string) => boolean | Promise<boolean>;
  heartbeatMs?: number;
}

let clientSeq = 0;

export class WsHub {
  readonly #wss: WebSocketServer;
  readonly #clients = new Map<string, WsClient>();
  readonly #options: WsHubOptions;
  #heartbeat: NodeJS.Timeout | null = null;

  constructor(options: WsHubOptions) {
    this.#options = options;
    this.#wss = new WebSocketServer({ server: options.server, path: options.path });
    this.#wss.on('connection', (socket, req) => void this.#onConnection(socket, req));
    this.#wss.on('error', (err) => log.error('WebSocket 服务错误', { error: err.message }));
    this.#startHeartbeat();
    log.info('WebSocket 已就绪', { path: options.path });
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** 在线用户 ID 集合（去重） */
  onlineUserIds(): string[] {
    const ids = new Set<string>();
    for (const c of this.#clients.values()) {
      if (c.auth) ids.add(c.auth.userId);
    }
    return [...ids];
  }

  /** 向某个话题的所有订阅者推送 */
  publish(topic: string, event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.#clients.values()) {
      if (!client.topics.has(topic)) continue;
      this.#safeSend(client, payload);
    }
  }

  /** 向某用户的全部连接推送（多端登录都会收到） */
  sendToUser(userId: string, event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.#clients.values()) {
      if (client.auth?.userId !== userId) continue;
      this.#safeSend(client, payload);
    }
  }

  /** 广播给所有连接（不含未认证连接） */
  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.#clients.values()) {
      if (!client.auth) continue;
      this.#safeSend(client, payload);
    }
  }

  /** 强制断开某用户的连接（例如封禁、改密） */
  disconnectUser(userId: string, reason: string): void {
    for (const client of this.#clients.values()) {
      if (client.auth?.userId !== userId) continue;
      this.#safeSend(client, JSON.stringify({ type: 'error', code: 'unauthorized', message: reason }));
      client.socket.close(4001, reason);
    }
  }

  close(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    for (const client of this.#clients.values()) client.socket.terminate();
    this.#clients.clear();
    this.#wss.close();
  }

  /* ------------------------------------------------------------- 内部 */

  #onConnection(socket: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    const client: WsClient = {
      id: `ws_${(clientSeq += 1).toString(36)}`,
      socket,
      auth: null,
      topics: new Set(),
      ip: req.socket.remoteAddress ?? '',
      alive: true,
      connectedAt: Date.now(),
    };

    if (token) {
      const auth = this.#options.resolveToken(token);
      if (auth) {
        client.auth = auth;
        // 默认订阅自己的私有话题与平台话题
        client.topics.add(Topics.user(auth.userId));
        client.topics.add(Topics.platform);
      }
    }

    this.#clients.set(client.id, client);

    socket.on('message', (data) => void this.#onMessage(client, data.toString()));
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => {
      this.#clients.delete(client.id);
    });
    socket.on('error', () => {
      this.#clients.delete(client.id);
    });

    this.#send(client, {
      type: 'hello',
      serverTime: new Date().toISOString(),
      version: '0.1.0',
      topics: [...client.topics],
    });
  }

  async #onMessage(client: WsClient, raw: string): Promise<void> {
    let event: ClientEvent;
    try {
      event = JSON.parse(raw) as ClientEvent;
    } catch {
      this.#send(client, { type: 'error', code: 'bad_request', message: '消息不是合法 JSON' });
      return;
    }

    switch (event.type) {
      case 'ping':
        this.#send(client, { type: 'pong', ts: event.ts, serverTime: new Date().toISOString() });
        return;
      case 'subscribe': {
        const accepted: string[] = [];
        for (const topic of event.topics ?? []) {
          if (typeof topic !== 'string') continue;
          const ok = await this.#options.authorizeTopic(client, topic);
          if (ok) {
            client.topics.add(topic);
            accepted.push(topic);
          }
        }
        this.#send(client, { type: 'hello', serverTime: new Date().toISOString(), version: '0.1.0', topics: [...client.topics] });
        log.debug('话题订阅', { client: client.id, accepted });
        return;
      }
      case 'unsubscribe': {
        for (const topic of event.topics ?? []) client.topics.delete(topic);
        return;
      }
      default:
        this.#send(client, { type: 'error', code: 'bad_request', message: `未知事件类型: ${String((event as { type?: string }).type)}` });
    }
  }

  #safeSend(client: WsClient, payload: string): void {
    try {
      if (client.socket.readyState === client.socket.OPEN) client.socket.send(payload);
    } catch (err) {
      log.debug('WebSocket 发送失败', { client: client.id, error: (err as Error).message });
    }
  }

  #send(client: WsClient, event: ServerEvent): void {
    this.#safeSend(client, JSON.stringify(event));
  }

  #startHeartbeat(): void {
    const interval = this.#options.heartbeatMs ?? 30_000;
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients.values()) {
        if (!client.alive) {
          client.socket.terminate();
          this.#clients.delete(client.id);
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          /* 连接可能已关闭 */
        }
      }
    }, interval);
    this.#heartbeat.unref?.();
  }
}
