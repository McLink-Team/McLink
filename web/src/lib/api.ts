/**
 * 主控 API 客户端。
 * 统一处理：令牌注入、{ok,data} 解包、错误码到中文提示、401 自动登出。
 */
// 注意：shared 里的 `ApiError` 是「错误响应体」类型，与下面本模块导出的 ApiError 类同名，
// 因此这里必须重命名导入，否则会出现声明合并冲突。
import { API_PREFIX, ErrorCodes, type ApiError as ApiErrorBody } from '@mclink/shared';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }
}

const TOKEN_KEY = 'mclink.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

/** 认证失效时通知上层（路由跳转到登录页） */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** 不回跳登录（用于探测类请求） */
  silentAuth?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_PREFIX}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const method = options.method ?? 'GET';
  /** 报错里带上接口名：否则页面上只有一句"主控没响应"，谁也说不清是哪个请求 */
  const where = `${method} ${API_PREFIX}${path}`;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', `无法连接主控服务（${where}）：${(err as Error).message}`);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 非 JSON 通常是反向代理的 HTML 错误页：502/503/504 各有一句能行动的解释
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new ApiError(
          res.status,
          'proxy_error',
          `主控暂时没有响应（HTTP ${res.status}，${where}）。这是反向代理给出的错误页：` +
            '要么主控正在重启，要么这个请求处理得太久、超过了代理的等待时间。请稍后重试；' +
            '若反复出现，把括号里的接口名交给管理员，到主控日志里搜「慢请求 / 请求仍未返回」即可定位。',
        );
      }
      throw new ApiError(res.status, 'bad_response', `主控返回了非 JSON 响应（HTTP ${res.status}，${where}）`);
    }
  }

  if (!res.ok) {
    const err = (payload as ApiErrorBody | null)?.error;
    const code = err?.code ?? 'unknown';
    const message = err?.message ?? `请求失败（HTTP ${res.status}）`;
    if (res.status === 401 && !options.silentAuth) {
      setToken(null);
      onUnauthorized?.();
    }
    throw new ApiError(res.status, code, message, err?.fields);
  }

  const wrapped = payload as { ok?: boolean; data?: T } | null;
  if (wrapped && typeof wrapped === 'object' && 'data' in wrapped) return wrapped.data as T;
  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  del: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'DELETE' }),
};

/** 把错误码翻译成面向用户的中文提示（服务端已有 message 时优先用 message） */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case ErrorCodes.UNAUTHORIZED:
        return '登录状态已失效，请重新登录';
      case ErrorCodes.RATE_LIMITED:
        return '操作太频繁，请稍后再试';
      case 'network_error':
        return '无法连接主控服务，请检查网络或稍后重试';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
