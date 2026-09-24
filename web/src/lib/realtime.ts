/**
 * WebSocket 实时通道：自动重连 + 话题订阅。
 * 落地页用它获取在线人数/流量，控制台用它刷新节点与房间状态。
 */
import { WS_PATH, Topics, reconnectDelayMs, type ServerEvent } from '@mclink/shared';
import { getToken } from './api.ts';

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

export interface RealtimeOptions {
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: RealtimeStatus) => void;
  /** 订阅的话题，重连后会自动重新订阅 */
  topics?: string[];
}

export class RealtimeClient {
  #socket: WebSocket | null = null;
  #topics = new Set<string>();
  #reconnectTimer: number | null = null;
  #attempts = 0;
  #closedByUser = false;
  #pingTimer: number | null = null;
  #options: RealtimeOptions;

  constructor(options: RealtimeOptions) {
    this.#options = options;
    for (const t of options.topics ?? [Topics.platform]) this.#topics.add(t);
  }

  get status(): RealtimeStatus {
    if (!this.#socket) return 'closed';
    if (this.#socket.readyState === WebSocket.OPEN) return 'open';
    if (this.#socket.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'closed';
  }

  connect(): void {
    this.#closedByUser = false;
    if (this.#socket && this.#socket.readyState <= WebSocket.OPEN) return;

    const token = getToken();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${WS_PATH}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    this.#options.onStatus?.('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#attempts = 0;
      this.#options.onStatus?.('open');
      this.subscribe([...this.#topics]);
      this.#startPing();
    });

    socket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as ServerEvent;
        this.#options.onEvent(parsed);
      } catch {
        /* 忽略无法解析的帧 */
      }
    });

    socket.addEventListener('close', () => {
      this.#stopPing();
      this.#options.onStatus?.('closed');
      if (!this.#closedByUser) this.#scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      /* close 事件会跟着触发，统一在那里重连 */
    });
  }

  /** 订阅话题（也可在连接后动态追加） */
  subscribe(topics: string[]): void {
    for (const t of topics) this.#topics.add(t);
    this.#send({ type: 'subscribe', topics });
  }

  unsubscribe(topics: string[]): void {
    for (const t of topics) this.#topics.delete(t);
    this.#send({ type: 'unsubscribe', topics });
  }

  close(): void {
    this.#closedByUser = true;
    this.#stopPing();
    if (this.#reconnectTimer !== null) {
      window.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
  }

  #send(event: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(event));
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    this.#attempts += 1;
    /**
     * 退避必须带抖动（`reconnectDelayMs` 里 0.5–1.5x 随机）：
     * 主控重启后所有控制台页面同时回来，会把刚起来的单线程主控再打满一次。
     */
    const delay = reconnectDelayMs(this.#attempts);
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }

  #startPing(): void {
    this.#stopPing();
    this.#pingTimer = window.setInterval(() => {
      this.#send({ type: 'ping', ts: Date.now() });
    }, 25_000);
  }

  #stopPing(): void {
    if (this.#pingTimer !== null) {
      window.clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }
}
