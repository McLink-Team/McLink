/**
 * 页面共用的小工具：剪贴板、错误提示、时间格式化与状态徽章映射。
 * 只依赖已有的 api/toast 与设计令牌，不引入任何第三方库。
 */
import type { MemberStatus, NodeStatus, RoomStatus } from '@mclink/shared';
import { friendlyError } from './api.ts';
import { notifyError, notifyOk, notifyWarn } from './toast.ts';

/** 与 Badge.vue 的 tone 保持一致，避免各页面各写一套颜色映射 */
export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'brand';

/**
 * 复制文本到剪贴板。
 * `navigator.clipboard` 在非安全上下文（http + 非 localhost）下不存在，
 * 所以失败时必须退回「提示手动复制」，而不是静默失败。
 */
export async function copyText(text: string, label = '内容'): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    notifyOk(`${label}已复制到剪贴板`);
  } catch {
    notifyWarn(`浏览器不允许自动复制，请手动选中${label}后按 Ctrl+C`);
  }
}

/** 把异常转成面向用户的中文提示，并弹一条错误 toast */
export function reportError(err: unknown): string {
  const message = friendlyError(err);
  notifyError(message);
  return message;
}

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」；空值与非法值返回占位符 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 表单文本 → 整数；非法或空返回 fallback */
export function toInt(value: string | number | null | undefined, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  const text = String(value ?? '').trim();
  if (text.length === 0) return fallback;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 表单文本 → 浮点数；非法或空返回 fallback */
export function toFloat(value: string | number | null | undefined, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const text = String(value ?? '').trim();
  if (text.length === 0) return fallback;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : fallback;
}

/* --------------------------------------------------------- 字段归一化 */

/**
 * 保险：本应是数组的字段（旧版主控可能漏给或给成别的类型）统一成数组。
 * 只在渲染路径上使用，避免一个字段的类型漂移把整个页面渲染成白屏。
 */
export function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** 把「可能是数组、可能是单值、可能缺失」的字段归一成字符串数组（不做拆分） */
export function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  return [];
}

/**
 * 归一化「模式列表」类字段。
 *
 * 注意服务端 `easytier.relayNetworkWhitelist` 的**类型是字符串**（例如 `mclink-room-*`，
 * 多个模式时以空格分隔），不是数组——直接 `.join()` 会在渲染期抛
 * `TypeError: ... .join is not a function` 并让整页白屏。这里统一成数组。
 */
export function asPatternList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter((item) => item.length > 0);
  }
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

/**
 * 中继网络白名单：优先用新版的 `whitelistPatterns: string[]`，
 * 否则回退到可能是空格分隔字符串的 `whitelist`。两版主控都要能跑。
 */
export function relayWhitelist(
  source: { whitelist?: unknown; whitelistPatterns?: unknown } | null | undefined,
): string[] {
  if (!source) return [];
  const patterns = asPatternList(source.whitelistPatterns);
  if (patterns.length > 0) return patterns;
  return asPatternList(source.whitelist);
}

/** 复用 base.css 的 `.kv` 布局时用：把值安全地转成可渲染文本 */
export function asText(value: unknown, fallback = '—'): string {
  if (typeof value === 'string') return value.length > 0 ? value : fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

/* ------------------------------------------------------------ 状态徽章 */

export function nodeTone(status: NodeStatus): BadgeTone {
  switch (status) {
    case 'online':
      return 'ok';
    case 'degraded':
      return 'warn';
    case 'offline':
      return 'danger';
    case 'pending':
      return 'info';
    default:
      return 'neutral';
  }
}

export function nodeLabel(status: NodeStatus): string {
  switch (status) {
    case 'online':
      return '在线';
    case 'degraded':
      return '降级';
    case 'offline':
      return '离线';
    case 'pending':
      return '待审核';
    case 'disabled':
      return '已禁用';
    default:
      return status;
  }
}

export function roomTone(status: RoomStatus): BadgeTone {
  switch (status) {
    case 'open':
      return 'ok';
    case 'expired':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function roomLabel(status: RoomStatus): string {
  switch (status) {
    case 'open':
      return '开放中';
    case 'closed':
      return '已关闭';
    case 'expired':
      return '已过期';
    default:
      return status;
  }
}

export function memberLabel(status: MemberStatus): string {
  switch (status) {
    case 'pending':
      return '待审批';
    case 'active':
      return '在线';
    case 'kicked':
      return '已移出';
    case 'left':
      return '已退出';
    default:
      return status;
  }
}

export function memberTone(status: MemberStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'ok';
    case 'pending':
      return 'warn';
    case 'kicked':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** 房间准入方式的中文标签 */
export function accessLabel(access: string): string {
  switch (access) {
    case 'open':
      return '直接加入';
    case 'password':
      return '需要密码';
    case 'approval':
      return '房主审批';
    default:
      return access;
  }
}
