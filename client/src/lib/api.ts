/**
 * 客户端侧的 API 封装。
 *
 * 主控地址有两层（**都可以为空** —— 2026-10-03 起不再强制内置）：
 *   1. **打包时注入**的默认值（`VITE_MCLINK_MASTER`）：**现在允许留空**。
 *      官方服务停止后，"内置一个官方地址"本身就成了误导 —— 官方不会提供服务，
 *      而社区/自建实例的地址只有玩家自己知道。所以产物默认**不含**任何主控地址。
 *   2. **玩家自己填的覆盖值**（`localStorage['mclink.master']`，登录页/设置页可改）。
 *
 * 两层都没有时 `getMasterUrl()` 返回空串：界面要引导玩家去填（登录页首屏那块），
 * 而所有 API 调用会**在发请求之前**就以一句可读的错误失败（见 `assertMaster`），
 * 不会静默去连 `127.0.0.1`。
 *
 * 安全前提：以前是"票据只能来自官方主控"，现在是"票据来自你自己填的那台主控"——
 * 房间内的权限模型不变（票据仍由主控签发），只是信任对象变成了你填的那台机器。
 * 所以界面里必须写明：**登录时账号密码会发给那台主控**。
 */
import { API_PREFIX, type ApiError } from '@mclink/shared';

const TOKEN_KEY = 'mclink.token';
const DEVICE_KEY = 'mclink.device';
/** 玩家自填的主控地址（空/无效 = 没有主控，界面会引导去填） */
const MASTER_KEY = 'mclink.master';

function readEnvMaster(): string {
  const raw = import.meta.env.VITE_MCLINK_MASTER;
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}

/**
 * 打包时注入的主控地址（**可能为空串** = 这个包没有内置任何主控）。
 *
 * ⚠️ 以前这里会在缺失时回退到 `http://127.0.0.1:8787`。那条回退是"开发方便、发布危险"：
 * 一个忘了设环境变量的正式包会静默指向本机回环地址，玩家只会看到"连不上服务器"。
 * 现在缺失就是缺失 —— 界面明确说"还没设置主控"，玩家自己填。
 */
export const MASTER_URL = readEnvMaster();

/** 这个包有没有内置主控地址（界面据此决定"留空"的文案与首屏引导） */
export const HAS_BUILT_IN_MASTER = MASTER_URL.length > 0;

/** 地址归一化在 `master-url.ts`（纯函数、无 Vite 依赖，可离线校验：
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
 * 传空的/非法的值 = 清除覆盖，回到"这个包内置的地址"（可能也没有 → 那就没有主控）。
 */
export function setCustomMasterUrl(raw: string | null): boolean {
  const before = getMasterUrl();
  const next = raw === null || raw.trim().length === 0 ? null : normalizeMasterUrl(raw);
  if (next === null) writeLocal(MASTER_KEY, null);
  else writeLocal(MASTER_KEY, next);
  return getMasterUrl() !== before;
}

/** 当前要连的主控；**空串 = 还没有主控**（界面必须先引导玩家填一个） */
export function getMasterUrl(): string {
  return customMasterUrl() ?? MASTER_URL;
}

/** 没有主控时统一用这句提示（界面与 API 层共用，避免两种说法） */
export const NO_MASTER_MESSAGE = '还没有设置主控地址：请在「自建 / 社区节点」里填一个你自己的实例地址';

/**
 * 发请求前的兜底：没有主控就**根本不发**。
 *
 * 为什么要有它：所有调用点都假设"主控地址一定存在"（相对路径拼 base）。没有主控时
 * `fetch('/api/v1/…')` 会打到 **WebView 自己的 origin**（Capacitor 下是 `https://localhost`），
 * 拿到一个 HTML 404，最后报给玩家的是"主控没响应"——完全指错方向。
 */
function assertMaster(): string {
  const master = getMasterUrl();
  if (master.length === 0) throw new ApiRequestError(0, 'no_master', NO_MASTER_MESSAGE);
  return master;
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
  // `assertMaster()` 已经在 request() 里先跑过一次：这里直接用，保证绝不用空 base 拼 URL
  const url = new URL(`${API_PREFIX}${path}`, assertMaster());
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
  // 没有主控就别发请求（否则会打到 WebView 自己的 origin，报出一句指错方向的错）
  assertMaster();

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
