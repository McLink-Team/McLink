/**
 * 客户端侧的 API 封装。
 *
 * 主控地址有两层：
 *   1. **打包时注入**的默认值（`VITE_MCLINK_MASTER`，见 client/.env.example 与 scripts/build.mjs），
 *      不注入时回退到本地开发地址；
 *   2. **玩家自己填的覆盖值**（`localStorage['mclink.master']`，设置页可改、可清空）。
 *
 * 第 2 层是 2026-10-03 加的：官方服务停止后，玩家要能连**自己的主控**或社区的实例，
 * 否则这版客户端就只能是废包。风险也如实写在界面上 ——
 * 连到别人的主控意味着**账号密码会交给那台机器**，所以设置页把这句话写在输入框旁边，
 * 并且切换主控时会**清掉本地登录态**（旧令牌对新主控无效，留着只会让人困惑）。
 *
 * 安全前提的变化：以前"票据只能来自官方主控"，现在"票据来自你自己选定的那台主控"——
 * 房间内的权限模型不变（票据仍然由主控签发），只是信任对象从平台变成了你填的那台机器。
 */
import { API_PREFIX, type ApiError } from '@mclink/shared';

const TOKEN_KEY = 'mclink.token';
const DEVICE_KEY = 'mclink.device';
/** 玩家自填的主控地址（空/无效 = 用打包时注入的默认值） */
const MASTER_KEY = 'mclink.master';
/** 本地开发用回退地址；正式包一定会被 VITE_MCLINK_MASTER 覆盖 */
const DEV_FALLBACK_MASTER = 'http://127.0.0.1:8787';

function readEnvMaster(): string {
  const raw = import.meta.env.VITE_MCLINK_MASTER;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim().replace(/\/+$/, '');
  return DEV_FALLBACK_MASTER;
}

/** 打包时注入的主控地址（**只读**：界面上显示"官方/默认地址"用的就是它） */
export const MASTER_URL = readEnvMaster();

/** 是否使用了开发回退地址（界面据此提示「当前连的是本地主控」） */
export const USING_DEV_MASTER = !import.meta.env.VITE_MCLINK_MASTER;

/**
 * 地址归一化在 `master-url.ts`（纯函数、无 Vite 依赖，可离线校验：
 * `node client/scripts/verify-selfhost-fn.mjs`）。这里导入后**再用原路径导出一次**，
 * 界面按原路径引用即可（`export ... from` 不会把名字带进本模块作用域，
 * 而下面 setCustomMasterUrl 要用它 —— 所以是 import + export 两步）。
 */
import { normalizeMasterUrl } from './master-url.ts';
export { normalizeMasterUrl };

/** 玩家自己填的主控地址（没填返回 null） */
export function customMasterUrl(): string | null {
  const stored = readLocal(MASTER_KEY);
  return stored === null ? null : normalizeMasterUrl(stored);
}

/**
 * 设置/清除自填主控地址。**返回是否发生了改变**（调用方据此决定要不要清登录态）。
 *
 * 传空的/非法的值 = 清除覆盖，回到打包时注入的默认地址。
 */
export function setCustomMasterUrl(raw: string | null): boolean {
  const before = getMasterUrl();
  const next = raw === null || raw.trim().length === 0 ? null : normalizeMasterUrl(raw);
  if (next === null) writeLocal(MASTER_KEY, null);
  else writeLocal(MASTER_KEY, next);
  return getMasterUrl() !== before;
}

export function getMasterUrl(): string {
  return customMasterUrl() ?? MASTER_URL;
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
  const method = options.method ?? 'GET';
  /** 报错时带上请求本身，否则界面上只有一句"主控没响应"，谁也说不清是哪个接口 */
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
    throw new ApiRequestError(0, 'network_error', `无法连接服务器（${where}）：${(err as Error).message}`);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      /**
       * 响应不是 JSON —— 十有八九根本没到主控，而是**反向代理**回的 HTML 错误页：
       * 502（后端起不来）、503（后端不可用）、504（等待超时）。
       * 只说「非 JSON 响应」玩家看不懂也做不了什么，这里给出判断、**接口名**与下一步。
       */
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new ApiRequestError(
          res.status,
          'proxy_error',
          `主控暂时没有响应（HTTP ${res.status}，${where}）。这是反向代理给出的错误页：` +
            '要么主控正在重启，要么这个请求处理得太久、超过了代理的等待时间。请稍后重试；' +
            '若反复出现，把括号里的接口名交给管理员，到主控日志里搜「慢请求 / 请求仍未返回」即可定位。',
        );
      }
      throw new ApiRequestError(
        res.status,
        'bad_response',
        `主控返回了非 JSON 响应（HTTP ${res.status}，${where}）`,
      );
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
    if (err.code === 'network_error') return '连不上服务器，请检查网络后重试。';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
