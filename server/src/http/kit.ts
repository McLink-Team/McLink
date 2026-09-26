/**
 * 极简 HTTP 工具箱：路由、请求上下文、响应封装、静态文件。
 *
 * 不引框架的原因：项目需要的只是「路径参数 + JSON 体 + 统一错误」，
 * 自己实现约 300 行，换来零依赖与完全可控的行为（尤其是错误码与日志字段）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes, type ApiError } from '@mclink/shared';
import { HttpError, isHttpError } from '../util/errors.ts';
import { ValidationError } from '@mclink/shared';
import { clientIp, type TrustedNet } from '../util/net.ts';
import { logger } from '../logger.ts';

const log = logger('http');

export interface AuthContext {
  userId: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
}

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  params: Record<string, string>;
  /** 已解析的查询参数 */
  query: URLSearchParams;
  readonly ip: string;
  /** 已认证用户；由 authenticate 中间件填充 */
  auth: AuthContext | null;
  /** 节点 agent 认证信息 */
  agent: { nodeId: string } | null;
  /** 每请求的临时存放点 */
  state: Record<string, unknown>;
  /** 读取并缓存 JSON 请求体 */
  body<T = Record<string, unknown>>(): Promise<T>;
  /** 直接返回一段文本/字节流（静态资源等） */
  send(status: number, body: Buffer | string, contentType?: string): void;
  /** 记录审计/日志时用的原始路径（由路由层在匹配后覆盖） */
  route: string;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
type Middleware = (ctx: Ctx) => Promise<boolean> | boolean;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** 标记需要认证 */
  auth: boolean;
  /** 标记需要管理员 */
  admin: boolean;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB，足够所有 API；下载走静态通道

export class Router {
  #routes: Route[] = [];
  #middlewares: Middleware[] = [];

  use(mw: Middleware): void {
    this.#middlewares.push(mw);
  }

  add(method: string, pattern: string, handler: Handler, opts: { auth?: boolean; admin?: boolean } = {}): void {
    const segments = pattern.split('/').filter((s) => s.length > 0);
    this.#routes.push({
      method,
      segments,
      handler,
      auth: opts.auth ?? false,
      admin: opts.admin ?? false,
    });
  }

  get(pattern: string, handler: Handler, opts?: { auth?: boolean; admin?: boolean }): void {
    this.add('GET', pattern, handler, opts);
  }

  post(pattern: string, handler: Handler, opts?: { auth?: boolean; admin?: boolean }): void {
    this.add('POST', pattern, handler, opts);
  }

  patch(pattern: string, handler: Handler, opts?: { auth?: boolean; admin?: boolean }): void {
    this.add('PATCH', pattern, handler, opts);
  }

  put(pattern: string, handler: Handler, opts?: { auth?: boolean; admin?: boolean }): void {
    this.add('PUT', pattern, handler, opts);
  }

  delete(pattern: string, handler: Handler, opts?: { auth?: boolean; admin?: boolean }): void {
    this.add('DELETE', pattern, handler, opts);
  }

  /** 找到匹配路由；未匹配返回 null */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter((s) => s.length > 0);
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i]!;
        const actual = parts[i]!;
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(actual);
        } else if (seg !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  middlewares(): readonly Middleware[] {
    return this.#middlewares;
  }
}

/* --------------------------------------------------------------- 响应 */

export function jsonResponse(ctx: Ctx, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  ctx.res.end(text);
}

export function errorResponse(ctx: Ctx, err: unknown): void {
  if (err instanceof ValidationError) {
    const payload: ApiError = {
      error: { code: ErrorCodes.BAD_REQUEST, message: '参数校验失败', fields: err.fields },
    };
    jsonResponse(ctx, 400, payload);
    return;
  }
  if (isHttpError(err)) {
    const payload: ApiError = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
      },
    };
    jsonResponse(ctx, err.status, payload);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error('未处理的服务端异常', { route: ctx.route, error: message, stack: (err as Error)?.stack });
  const payload: ApiError = {
    error: { code: ErrorCodes.INTERNAL, message: '服务器内部错误' },
  };
  jsonResponse(ctx, 500, payload);
}

/** 读取请求体（JSON），带大小限制 */
export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw HttpError.badRequest('请求体过大');
    }
    chunks.push(buf);
  }
  if (total === 0) return {} as T;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw HttpError.badRequest('请求体不是合法 JSON');
  }
}

/**
 * 组装一次请求的上下文。
 * `trustedProxies` 为空表示兼容模式（见 util/net.ts 的 clientIp）——
 * 真实 IP 的判定规则只写在那一个地方，这里只负责把配置透传下去。
 */
export function makeCtx(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  trustProxy: boolean,
  trustedProxies: TrustedNet[] | null = null,
): Ctx {
  let bodyPromise: Promise<Record<string, unknown>> | null = null;
  return {
    req,
    res,
    method: req.method ?? 'GET',
    url,
    params: {},
    query: url.searchParams,
    ip: clientIp(req, trustProxy, trustedProxies),
    auth: null,
    agent: null,
    state: {},
    body<T = Record<string, unknown>>(): Promise<T> {
      bodyPromise ??= readJsonBody<Record<string, unknown>>(req);
      return bodyPromise as Promise<T>;
    },
    send(status: number, body: Buffer | string, contentType = 'text/plain; charset=utf-8'): void {
      const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      res.writeHead(status, {
        'content-type': contentType,
        'content-length': buf.length,
      });
      res.end(buf);
    },
    route: url.pathname,
  };
}

/* ----------------------------------------------------------- 静态文件 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
  '.dll': 'application/octet-stream',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
};

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 安全地把 URL 路径映射到磁盘路径，阻断 `..` 穿越。
 * 返回 null 表示越权或非法。
 */
export function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  if (decoded.includes('\0')) return null;
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, '');
  const target = path.resolve(root, normalized);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export interface StaticOptions {
  root: string;
  /** 单页应用：找不到文件时回退到 index.html */
  spa?: boolean;
  /** 是否允许列目录（默认否） */
  index?: string;
  cacheSeconds?: number;
}

/** 尝试提供静态文件；返回 false 表示没命中，交给上层继续处理 */
export function serveStatic(ctx: Ctx, urlPath: string, options: StaticOptions): boolean {
  const target = safeJoin(options.root, urlPath);
  if (!target) return false;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }

  const index = options.index ?? 'index.html';
  let file = target;
  if (stat.isDirectory()) {
    file = path.join(target, index);
    if (!fs.existsSync(file)) return false;
  }

  return streamFile(ctx, file, options.cacheSeconds ?? 0);
}

/** 以流式方式发送文件，支持 Range（客户端安装包下载需要断点续传） */
export function streamFile(ctx: Ctx, file: string, cacheSeconds = 0): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (ctx.req.headers['if-none-match'] === etag) {
    ctx.res.writeHead(304, { etag });
    ctx.res.end();
    return true;
  }

  const type = contentTypeFor(file);
  const range = ctx.req.headers.range;
  const headers: Record<string, string> = {
    'content-type': type,
    etag,
    'accept-ranges': 'bytes',
    'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-cache',
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? Number.parseInt(m[1], 10) : 0;
      const end = m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
        const last = Math.min(end, stat.size - 1);
        headers['content-length'] = String(last - start + 1);
        headers['content-range'] = `bytes ${start}-${last}/${stat.size}`;
        ctx.res.writeHead(206, headers);
        fs.createReadStream(file, { start, end: last }).pipe(ctx.res);
        return true;
      }
    }
  }

  headers['content-length'] = String(stat.size);
  ctx.res.writeHead(200, headers);
  if (ctx.method === 'HEAD') {
    ctx.res.end();
    return true;
  }
  // 大文件（客户端安装包）用流，避免一次性读进内存
  if (stat.size > 512 * 1024) {
    const stream = fs.createReadStream(file);
    stream.on('error', () => ctx.res.end());
    stream.pipe(ctx.res);
    return true;
  }
  ctx.res.end(fs.readFileSync(file));
  return true;
}

export function notFound(ctx: Ctx): void {
  const payload: ApiError = { error: { code: ErrorCodes.NOT_FOUND, message: '接口不存在' } };
  jsonResponse(ctx, 404, payload);
}
