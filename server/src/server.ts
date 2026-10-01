/**
 * HTTP 服务装配：
 *  - 路由分发（含认证中间件与管理员校验）
 *  - 静态资源（前端构建产物）与 /downloads（客户端安装包，支持 Range 断点续传）
 *  - CORS、安全响应头、请求日志、按 IP 的滑动窗口限流
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { API_PREFIX, Routes, WS_PATH, Topics } from '@mclink/shared';
import type { App } from './app.ts';
import { REPO_ROOT } from './config.ts';
import { HttpError, isHttpError } from './util/errors.ts';
import { logger } from './logger.ts';
import {
  Router,
  errorResponse,
  jsonResponse,
  makeCtx,
  notFound,
  serveStatic,
  streamFile,
  type Ctx,
} from './http/kit.ts';
import { registerPublicRoutes } from './api/public.ts';
import { renderRobots, renderShell, renderSitemap } from './api/shell.ts';
import { registerAuthRoutes } from './api/auth.ts';
import { registerRoomRoutes } from './api/rooms.ts';
import { registerAgentRoutes } from './api/agent.ts';
import { registerAdminRoutes } from './api/admin.ts';
import { WsHub, type WsClient } from './ws/hub.ts';
import type { AuthContext } from './http/kit.ts';

const log = logger('server');

export interface RunningServer {
  server: http.Server;
  hub: WsHub;
  close: () => Promise<void>;
}

/* ------------------------------------------------------------- 限流 */

interface Bucket {
  windowStart: number;
  count: number;
}

class RateLimiter {
  #buckets = new Map<string, Bucket>();
  private readonly limitPerMinute: number;

  constructor(limitPerMinute: number) {
    this.limitPerMinute = limitPerMinute;
  }

  /** 返回 true 表示允许通过 */
  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.#buckets.get(key);
    if (!bucket || now - bucket.windowStart > 60_000) {
      this.#buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limitPerMinute;
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStart > 120_000) this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/* --------------------------------------------------------- 服务构建 */

export function buildRouter(app: App): Router {
  const router = new Router();
  registerPublicRoutes(router, app);
  registerAuthRoutes(router, app);
  registerRoomRoutes(router, app);
  registerAgentRoutes(router, app);
  registerAdminRoutes(router, app);
  return router;
}

export function createServer(app: App): RunningServer {
  const router = buildRouter(app);
  const generalLimiter = new RateLimiter(app.config.anonymousRateLimitPerMinute);
  const loginLimiter = new RateLimiter(app.config.loginRateLimitPerMinute);

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.error('请求处理异常', { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'internal_error', message: '服务器内部错误' } }));
      } else {
        res.end();
      }
    });
  });

  // 客户端安装包可能很大，放宽超时；同时保持 keep-alive 复用
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // 真实 IP 策略每次请求现取：控制台里改完「可信代理」立刻生效（无需重启）
    const ipPolicy = app.realIpPolicy();
    const ctx = makeCtx(req, res, url, ipPolicy.trustProxy, ipPolicy.trustedProxies);

    applySecurityHeaders(res);

    /**
     * API 请求的兜底超时 + 在途请求看门狗。
     *
     * 起因：线上出现过 HTTP 504，而客户端只能拿到反向代理那张 HTML 错误页，
     * 于是报「主控返回了非 JSON 响应」——玩家和管理员都看不出是哪个接口卡住了。
     * 更麻烦的是：主控**只在请求结束时**记日志，一个卡住的请求上线前不留任何痕迹。
     *
     * 所以这里做两件事：
     *   1. 看门狗：在途超过 WATCHDOG_MS 就写一条 warn（只写一次），日志里能直接看到卡住的是谁；
     *   2. 兜底超时：到 DEADLINE_MS 还没回，就自己回一个 JSON 504，
     *      让客户端拿到结构化错误（而不是让 nginx 先超时吐 HTML）。
     * DEADLINE_MS 特意小于 nginx 示例里的 120s，保证这个 JSON 一定能发出去。
     */
    const WATCHDOG_MS = readMs('MCLINK_SLOW_REQUEST_MS', 30_000);
    const DEADLINE_MS = readMs('MCLINK_REQUEST_DEADLINE_MS', 110_000);
    let watchdog: NodeJS.Timeout | null = null;
    let deadline: NodeJS.Timeout | null = null;
    if (url.pathname.startsWith(API_PREFIX)) {
      const inflight = { method: ctx.method, path: url.pathname, ip: ctx.ip, user: undefined as string | undefined };
      watchdog = setTimeout(() => {
        log.warn(`请求仍未返回（超过 ${WATCHDOG_MS}ms，可能在等外部进程或数据库）`, {
          ...inflight,
          user: ctx.auth?.username,
          ms: Date.now() - started,
        });
      }, WATCHDOG_MS);
      deadline = setTimeout(() => {
        if (res.writableEnded) return;
        log.warn('请求处理超时，已由主控主动结束（而不是让反代 504）', {
          ...inflight,
          user: ctx.auth?.username,
          ms: Date.now() - started,
        });
        try {
          res.statusCode = 504;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: 'server_timeout', message: '主控处理这个请求超时了，请稍后重试' },
            }),
          );
        } catch {
          /* 已经断开就算了 */
        }
      }, DEADLINE_MS);
      const clearTimers = (): void => {
        if (watchdog) clearTimeout(watchdog);
        if (deadline) clearTimeout(deadline);
      };
      res.once('finish', clearTimers);
      res.once('close', clearTimers);
    }

    // CORS：仅对配置的来源放行（客户端 Electron 用的是 file:// 与本地端口）
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(app, origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('vary', 'Origin');
    }
    if (ctx.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization,x-mclink-token',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }

    try {
      /*
       * ---- 静态：子节点一键安装脚本 ----
       * 刻意放在根路径（不走 /api/v1）：这样运维拿到的是
       * `curl -fsSL <主控>/agent/install.sh | sudo bash -s -- …` 这种一眼就懂的命令，
       * 也与 install-node.sh 里"从 ${MASTER}/agent/agent.mjs 取 agent"的约定一致。
       * 两个文件都不含密钥 —— 注册密钥是命令行参数，一次性且用完即废。
       */
      if (
        url.pathname === Routes.agentInstallScript ||
        url.pathname === Routes.agentScript ||
        url.pathname === Routes.agentNodeUnit
      ) {
        const name =
          url.pathname === Routes.agentInstallScript
            ? 'install-node.sh'
            : url.pathname === Routes.agentScript
              ? 'agent.mjs'
              : 'mclink-node.service';
        const target = path.join(REPO_ROOT, 'deploy', name);
        if (!fs.existsSync(target)) throw HttpError.notFound(`主控上没有找到 deploy/${name}`);
        streamFile(ctx, target, 0);
        logRequest(ctx, started);
        return;
      }

      /*
       * ---- 静态：Linux 版 EasyTier 二进制 ----
       * 子节点装的时候优先从这里取，国内节点就不用去 GitHub（或其代理）下载了。
       * 是不是"有"取决于主控是怎么装的：从源码包装的会带上
       * `deploy/vendor/linux-x86_64/`（打包脚本会塞进去），纯 git clone 的没有 ——
       * 没有就返回 404，装节点的脚本会退回到 GitHub（可带代理）。
       */
      if (url.pathname === Routes.agentCoreBin || url.pathname === Routes.agentCliBin) {
        const name = url.pathname === Routes.agentCoreBin ? 'easytier-core' : 'easytier-cli';
        const target = path.join(REPO_ROOT, 'deploy', 'vendor', 'linux-x86_64', name);
        if (!fs.existsSync(target)) {
          throw HttpError.notFound(
            `主控上没有 ${name}（deploy/vendor/linux-x86_64/）。` +
              '可在开发机执行 `pnpm fetch:easytier --all` 后把它放进该目录，或让子节点走 GitHub。',
          );
        }
        streamFile(ctx, target, 0);
        logRequest(ctx, started);
        return;
      }

      // ---- 静态：客户端安装包 ----
      if (url.pathname.startsWith('/downloads/')) {
        const rel = url.pathname.slice('/downloads/'.length);
        if (rel.length > 0) {
          const target = path.join(app.downloads.root, path.basename(rel));
          if (fs.existsSync(target)) {
            streamFile(ctx, target, 300);
            logRequest(ctx, started);
            return;
          }
        }
        throw HttpError.notFound('下载文件不存在');
      }

      // ---- API ----
      if (url.pathname.startsWith(API_PREFIX) || url.pathname === '/api') {
        const apiPath = url.pathname.slice(API_PREFIX.length) || '/';

        // 登录/注册走独立限流，防止撞库
        if (apiPath === Routes.login || apiPath === Routes.register) {
          if (!loginLimiter.allow(`login:${ctx.ip}`)) {
            throw HttpError.rateLimited('登录尝试过于频繁，请稍后再试');
          }
        } else if (!generalLimiter.allow(`gen:${ctx.ip}`)) {
          throw HttpError.rateLimited();
        }

        const matched = router.match(ctx.method, apiPath);
        if (!matched) {
          notFound(ctx);
          logRequest(ctx, started);
          return;
        }

        ctx.params = matched.params;
        ctx.route = `${ctx.method} ${API_PREFIX}${apiPath}`;

        // 认证：解析 Bearer 令牌
        const token = extractToken(req);
        if (token) {
          const session = app.auth.resolveSession(token);
          if (session) {
            ctx.auth = {
              userId: session.user.id,
              username: session.user.username,
              displayName: session.user.display_name,
              role: session.user.role as 'admin' | 'user',
            };
            app.users.touchSession(session.token);
          } else if (matched.route.auth) {
            throw HttpError.unauthorized('登录状态已失效，请重新登录');
          }
        }

        if (matched.route.auth && !ctx.auth) throw HttpError.unauthorized();
        if (matched.route.admin && ctx.auth?.role !== 'admin') throw HttpError.forbidden('需要管理员权限');

        const result = await matched.route.handler(ctx);
        if (!res.headersSent) {
          jsonResponse(ctx, 200, { ok: true, data: result ?? null });
        }
        logRequest(ctx, started);
        return;
      }

      // ---- SEO：把平台设置注入前端外壳，并给出 robots / sitemap ----
      // 必须在 serveStatic 之前：SPA 的 index.html 是构建时写死的，
      // 直接发出去的话，管理员在控制台改的站点名永远不会出现在搜索结果里。
      if (ctx.method === 'GET' || ctx.method === 'HEAD') {
        if (url.pathname === '/robots.txt') {
          ctx.send(200, renderRobots(app, ctx.req.headers), 'text/plain; charset=utf-8');
          logRequest(ctx, started);
          return;
        }
        if (url.pathname === '/sitemap.xml') {
          ctx.send(200, renderSitemap(app, ctx.req.headers), 'application/xml; charset=utf-8');
          logRequest(ctx, started);
          return;
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
          const indexPath = path.join(app.web.root, 'index.html');
          if (fs.existsSync(indexPath)) {
            const html = renderShell(app, fs.readFileSync(indexPath, 'utf8'), ctx.req.headers);
            ctx.send(200, html, 'text/html; charset=utf-8');
            logRequest(ctx, started);
            return;
          }
        }
      }

      // ---- 静态：前端 ----
      if (app.web.available) {
        if (serveStatic(ctx, url.pathname, { root: app.web.root, spa: true, cacheSeconds: 0 })) {
          logRequest(ctx, started);
          return;
        }
        // SPA 回退
        const indexPath = path.join(app.web.root, 'index.html');
        if (ctx.method === 'GET' && fs.existsSync(indexPath)) {
          streamFile(ctx, indexPath, 0);
          logRequest(ctx, started);
          return;
        }
      }

      // 前端未构建时给一个明确的提示页，而不是 404
      if (ctx.method === 'GET') {
        ctx.send(200, fallbackPage(app), 'text/html; charset=utf-8');
        logRequest(ctx, started);
        return;
      }
      notFound(ctx);
    } catch (err) {
      /*
       * 响应可能已经由兜底超时（或 streamFile）结束了：这时再写一次头会抛
       * 「Cannot write headers after they are sent」，把它当错误报出来只会误导排查
       * （真正的原因在 30s 前那条「请求仍未返回」的 warn 里）。所以先看响应状态。
       */
      if (res.headersSent || res.writableEnded) {
        log.debug('响应已结束，忽略处理异常', {
          method: ctx.method,
          path: url.pathname,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      errorResponse(ctx, err);
      logRequest(ctx, started, err);
    }
  }

  const hub = new WsHub({
    server,
    path: WS_PATH,
    trustProxy: app.config.trustProxy,
    trustedProxies: app.config.trustedProxies,
    /** 每次握手现取：控制台改完「可信代理」对后续连接立即生效 */
    realIp: () => app.realIpPolicy(),
    resolveToken: (token) => {
      const session = app.auth.resolveSession(token);
      if (!session) return null;
      return {
        userId: session.user.id,
        username: session.user.username,
        displayName: session.user.display_name,
        role: session.user.role as 'admin' | 'user',
      } satisfies AuthContext;
    },
    authorizeTopic: (client: WsClient, topic: string) => {
      // platform 只含聚合计数，落地页未登录也要显示在线数据，故匿名可订阅
      if (topic === Topics.platform) return true;
      // traffic 会按房间暴露流量与网络名映射，属于管理信息，必须管理员
      if (topic === Topics.traffic) return client.auth?.role === 'admin';
      if (topic === Topics.nodes || topic === Topics.rooms) return client.auth?.role === 'admin';
      if (topic.startsWith('user:')) return topic === Topics.user(client.auth?.userId ?? '');
      if (topic.startsWith('room:')) {
        const roomId = topic.slice('room:'.length);
        if (!client.auth) return false;
        const row = app.rooms.findById(roomId);
        if (!row) return false;
        if (row.host_user_id === client.auth.userId) return true;
        const member = app.rooms.findMember(roomId, client.auth.userId);
        return member?.status === 'active';
      }
      return false;
    },
  });

  // 周期性清理限流桶
  const sweepTimer = setInterval(() => {
    generalLimiter.sweep();
    loginLimiter.sweep();
  }, 120_000);
  sweepTimer.unref?.();

  return {
    server,
    hub,
    close: async () => {
      clearInterval(sweepTimer);
      hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------- 工具 */

function extractToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m?.[1]) return m[1].trim();
  }
  const alt = req.headers['x-mclink-token'];
  const raw = Array.isArray(alt) ? alt[0] : alt;
  if (raw) return raw.trim();
  const url = req.url ?? '';
  const idx = url.indexOf('token=');
  if (idx >= 0) return decodeURIComponent(url.slice(idx + 6).split('&')[0] ?? '');
  return null;
}

function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
}

function isAllowedOrigin(app: App, origin: string): boolean {
  if (app.config.corsOrigins.includes('*')) return true;
  if (app.config.corsOrigins.includes(origin)) return true;
  // Electron 渲染进程与本地开发
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === 'file://' || origin === 'null';
}

/** 读一个毫秒级环境变量；非法值（负数、非数字）退回默认，不让配置错误把请求打死 */
function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function logRequest(ctx: Ctx, startedAt: number, err?: unknown): void {
  const ms = Date.now() - startedAt;
  const fields = {
    method: ctx.method,
    path: ctx.url.pathname,
    status: ctx.res.statusCode,
    ms,
    ip: ctx.ip,
    user: ctx.auth?.username,
  };
  if (err) {
    log.warn('请求失败', { ...fields, error: isHttpError(err) ? err.code : (err as Error).message });
    return;
  }
  if (ms > 1500 || ctx.res.statusCode >= 400) {
    log.warn('慢请求或异常状态', fields);
  } else {
    log.debug('请求', fields);
  }
}

/** 前端尚未构建时的兜底页面，给出清晰的下一步提示 */
function fallbackPage(app: App): string {
  const s = app.settings.current;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(s.siteName)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    background:radial-gradient(1200px 600px at 20% -10%, #1b2a5e 0%, #0b1020 55%, #05070f 100%);
    color:#e8ecf8; font:15px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .card { max-width:640px; padding:40px; border-radius:18px; background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.09); box-shadow:0 24px 60px rgba(0,0,0,.45); }
  h1 { margin:0 0 8px; font-size:24px; }
  p { margin:8px 0; color:#a8b3cf; }
  code { background:rgba(120,160,255,.14); padding:2px 7px; border-radius:6px; font-size:13px; color:#cfe0ff; }
  ul { padding-left:20px; color:#a8b3cf; }
</style></head>
<body><div class="card">
  <h1>${escapeHtml(s.siteName)} 主控已启动</h1>
  <p>${escapeHtml(s.siteTagline)}</p>
  <p>检测到前端尚未构建，因此这里显示的是兜底页面。构建管理台与落地页：</p>
  <ul>
    <li><code>pnpm build:web</code> —— 构建前端到 <code>server/public</code></li>
    <li>或开发时另开一个 <code>pnpm dev:web</code>（Vite 开发服务器）</li>
  </ul>
  <p>API 已可用：<code>/api/v1/meta</code>、<code>/api/v1/regions</code>、<code>/api/v1/auth/login</code></p>
</div></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
