/**
 * SEO：把平台设置注入到前端外壳里，并给出 robots.txt / sitemap.xml。
 *
 * 为什么需要"注入"而不是改 index.html
 * ----------------------------------
 * 应用是 SPA（Vite 构建的静态壳 + 前端路由）。爬虫请求 `/` 时拿到的是那份**静态 HTML**，
 * 里面的 title/description 是构建时写死的 —— 管理员在控制台改了站点名与简介，
 * 搜索结果里却永远不会变。所以在**服务时**把设置注入进去：
 *   · title / description / og:* / canonical 按站点名与简介生成
 *   · noscript 里的站点名同样替换，让不跑 JS 的爬虫看到一致的品牌与正文
 *
 * 关于长度：不照搬英文的 50–60 / 150–160 字符。
 * 百度与 Google 的中文结果页大约 30 个汉字标题、78 个汉字摘要就被截断，
 * 按英文标准写只会让关键词落在截断线之外。下面的常量就是按汉字定的。
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { App } from '../app.ts';

/** 标题里除了站点名之外的固定后缀（控制在 30 个汉字以内） */
const TITLE_TAIL = '· 支持《我的世界》等各类局域网联机游戏';
/** og:title / noscript 里的 h1 用这句；与上面的标题后缀分开，避免出现两个"·" */
const PLATFORM_TAG = '支持《我的世界》等各类局域网联机游戏';
const DESC_MAX = 78;
const TITLE_MAX = 32;

/** HTML 转义：设置是管理员填的，注入前必须转义，否则可以塞标签进 head */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 摘要按「整句拼装」而不是先拼好再截断。
 *
 * 中文搜索结果页约 78 字就被切掉，而站点简介是**管理员可改**的：
 * 以前是先拼成一个长句再 clamp，简介一变长，摘要就以
 * "…按区域就近接入中继，P2…"这种半个词收尾（本次实测）。
 * 现在逐句累加，放不下就停 —— 结尾永远是完整的一句话。
 */
function buildDescription(siteName: string, tagline: string): string {
  const head = `${siteName}：${tagline}`;
  if (head.length >= DESC_MAX) return clamp(tagline, DESC_MAX);
  let out = head;
  for (const sentence of ['一条加入码进房', 'P2P 打洞直连', '按区域就近接入中继', '受限网络自动回退']) {
    const next = `${out}。${sentence}`;
    if (next.length + 1 > DESC_MAX) break;
    out = next;
  }
  return `${out}。`;
}

/** 站点根地址：优先用反向代理传来的 proto/host，退回到公开地址设置 */
export function siteOrigin(app: App, headers: IncomingHttpHeaders): string {
  const proto = String(headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() ?? '';
  const host = String(headers['x-forwarded-host'] ?? headers.host ?? '').split(',')[0]?.trim() ?? '';
  if (host) return `${proto === 'http' ? 'http' : 'https'}://${host}`;
  // 安装脚本的 --public-url 写进 MCLINK_PUBLIC_BASE_URL，服务端读成 config.publicBaseUrl
  return app.config.publicBaseUrl || 'http://127.0.0.1:8787';
}

export function renderShell(
  app: App,
  html: string,
  headers: IncomingHttpHeaders,
): string {
  const s = app.settings.current;
  const origin = siteOrigin(app, headers);
  const siteName = s.siteName || 'McLink 联机';
  const tagline = (s.siteTagline || '基于 EasyTier 的局域网联机平台').trim();

  const title = clamp(`${siteName} ${TITLE_TAIL}`, TITLE_MAX);
  const desc = buildDescription(siteName, tagline);

  let out = html;
  const set = (re: RegExp, value: string): void => {
    out = re.test(out) ? out.replace(re, value) : out;
  };
  set(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  set(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${esc(desc)}$2`);
  set(/(<meta\s+property="og:title"\s+content=")[^"]*(")/, `$1${esc(siteName)} · ${esc(PLATFORM_TAG)}$2`);
  set(/(<meta\s+property="og:description"\s+content=")[^"]*(")/, `$1${esc(desc)}$2`);
  set(/(<meta\s+property="og:site_name"\s+content=")[^"]*(")/, `$1${esc(siteName)}$2`);
  set(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${esc(`${origin}/`)}$2`);
  set(/(<meta\s+property="og:url"\s+content=")[^"]*(")/, `$1${esc(`${origin}/`)}$2`);
  set(/(<meta\s+property="og:image"\s+content=")[^"]*(")/, `$1${esc(`${origin}/icon-256.png`)}$2`);
  /**
   * 分享卡片与结构化数据里也要跟着设置走。
   * `twitter:title` 以前没被注入：管理员改了站点名，微信/Twitter 分享出来的标题还是旧的。
   */
  set(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/, `$1${esc(`${siteName} · ${PLATFORM_TAG}`)}$2`);
  set(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, `$1${esc(desc)}$2`);
  // 结构化数据里的客户端版本：写死在 HTML 里必然随发布过期（客户端已经是 1.0.1 了）
  set(/("softwareVersion"\s*:\s*")[^"]*(")/, `$1${esc(s.clientVersion)}$2`);
  // noscript 里的品牌与正文：不跑 JS 的爬虫只看得到这里
  out = out.replace(/<h1>[\s\S]*?<\/h1>\s*<p>/, `<h1>${esc(siteName)} —— ${esc(PLATFORM_TAG)}</h1>\n      <p>`);
  return out;
}

/** robots.txt：允许抓取公开页，禁掉需要登录/无意义抓取的路径 */
export function renderRobots(app: App, headers: IncomingHttpHeaders): string {
  const origin = siteOrigin(app, headers);
  return [
    'User-agent: *',
    'Allow: /',
    'Allow: /download',
    // 控制台与接口对爬虫没有意义，且会浪费主控配额
    'Disallow: /console',
    'Disallow: /api/',
    'Disallow: /assets/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/** sitemap.xml：只列公开、可匿名访问的页面 */
export function renderSitemap(app: App, headers: IncomingHttpHeaders): string {
  const origin = siteOrigin(app, headers);
  const today = new Date().toISOString().slice(0, 10);
  const pages: Array<{ path: string; priority: string; freq: string }> = [
    { path: '/', priority: '1.0', freq: 'daily' },
    { path: '/download', priority: '0.9', freq: 'weekly' },
    { path: '/login', priority: '0.2', freq: 'monthly' },
  ];
  const urls = pages
    .map(
      (p) =>
        `  <url>\n    <loc>${esc(`${origin}${p.path}`)}</loc>\n` +
        `    <lastmod>${today}</lastmod>\n` +
        `    <changefreq>${p.freq}</changefreq>\n` +
        `    <priority>${p.priority}</priority>\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
