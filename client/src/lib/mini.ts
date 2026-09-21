/**
 * 迷你窗与主窗之间的状态镜像。
 *
 * 两个窗口是两个渲染进程，Vue 的响应式状态不共享，因此把「当前房间的关键信息」
 * 落到 localStorage：主窗写、迷你窗读。只放展示所需字段，不放票据/密钥。
 */
import type { CoreState } from './core-types.ts';

export const MINI_STATE_KEY = 'mclink.mini.state';

/**
 * 当前渲染进程是不是迷你窗（主进程用 `?mini=1` 加载同一个产物）。
 *
 * 为什么需要它：迷你窗是另一个渲染进程，但它加载的是同一份 JS，
 * 因而也会执行 store.ts 的模块级代码。如果不加区分，
 * 迷你窗启动时会用「自己这边什么都没有」的初始状态覆盖掉主窗写下的镜像。
 */
export function isMiniRenderer(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('mini') === '1';
  } catch {
    return false;
  }
}

export interface MiniState {
  roomId: string | null;
  roomName: string | null;
  code: string | null;
  /** 房主虚拟 IP，也就是玩家要填进游戏的联机地址 */
  hostVirtualIp: string | null;
  /** 本地 easytier-core 的运行状态 */
  state: CoreState;
  updatedAt: string;
}

export function readMiniState(): MiniState | null {
  try {
    const text = localStorage.getItem(MINI_STATE_KEY);
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const row = parsed as Record<string, unknown>;
    const state = row.state;
    return {
      roomId: typeof row.roomId === 'string' ? row.roomId : null,
      roomName: typeof row.roomName === 'string' ? row.roomName : null,
      code: typeof row.code === 'string' ? row.code : null,
      hostVirtualIp: typeof row.hostVirtualIp === 'string' ? row.hostVirtualIp : null,
      state:
        state === 'running' || state === 'starting' || state === 'error' || state === 'stopped'
          ? state
          : 'stopped',
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeMiniState(next: MiniState): void {
  try {
    localStorage.setItem(MINI_STATE_KEY, JSON.stringify(next));
  } catch {
    /* 存储不可用时忽略：迷你窗会退化为「未进入房间」的空态 */
  }
}
