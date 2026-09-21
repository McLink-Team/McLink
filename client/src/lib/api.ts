/**
 * 客户端侧的 API 封装。
 *
 * 主控地址是**编译期常量**：平台不开放自建主控，客户端只能连官方主控。
 * 打包时通过 `VITE_MCLINK_MASTER` 注入（见 client/.env.example 与 scripts/build.mjs），
 * 不注入时回退到本地开发地址。运行时没有任何修改入口 ——
 * 这既避免了玩家被诱导连到钓鱼主控，也让「票据只能来自官方主控」这条
 * 安全前提成立。
 */
import { API_PREFIX, type ApiError } from '@mclink/shared';

const TOKEN_KEY = 'mclink.token';
const DEVICE_KEY = 'mclink.device';
/** 本地开发用回退地址；正式包一定会被 VITE_MCLINK_MASTER 覆盖 */
const DEV_FALLBACK_MASTER = 'http://127.0.0.1:8787';

function readEnvMaster(): string {
  const raw = import.meta.env.VITE_MCLINK_MASTER;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim().replace(/\/+$/, '');
  return DEV_FALLBACK_MASTER;
}

/** 主控地址（只读）。不要再往 localStorage 里存它 —— 那等于给了篡改入口。 */
export const MASTER_URL = readEnvMaster();

/** 是否使用了开发回退地址（界面据此提示「当前连的是本地主控」） */
export const USING_DEV_MASTER = !import.meta.env.VITE_MCLINK_MASTER;

export function getMasterUrl(): string {
  return MASTER_URL;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function getToken(): string | null {
  return readLocal(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  writeLocal(TOKEN_KEY, token);
}

export function getDeviceName(): string {
  return readLocal(DEVICE_KEY) ?? '';
}

export function setDeviceName(name: string): void {
  writeLocal(DEVICE_KEY, name);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_PREFIX}${path}`, getMasterUrl());
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    throw new ApiRequestError(0, 'network_error', `无法连接主控（${getMasterUrl()}）：${(err as Error).message}`);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiRequestError(res.status, 'bad_response', `主控返回了非 JSON 响应（HTTP ${res.status}）`);
    }
  }

  if (!res.ok) {
    const err = (payload as { error?: ApiError['error'] } | null)?.error;
    throw new ApiRequestError(res.status, err?.code ?? 'unknown', err?.message ?? `请求失败（HTTP ${res.status}）`);
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
  del: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'DELETE' }),
};

export function friendlyError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'network_error') return `连不上主控，请检查地址与网络（当前：${getMasterUrl()}）`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
