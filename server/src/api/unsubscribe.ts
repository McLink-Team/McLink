/**
 * 邮件退订。
 *
 * 为什么必须做：群发公告如果没有可用的退订入口，既是合规问题（CAN-SPAM 要求
 * 每封营销邮件都能一键退订），也会推高"标记为垃圾邮件"的比例 —— 那个比例一高，
 * 整个域名的送达率都会掉。
 *
 * 两条关键设计：
 *
 * 1. **退订链接必须免登录可用**。玩家点邮件里的链接时通常不在客户端里，
 *    要他去登录再找开关，等于没有退订。
 *
 * 2. **链接要能扛住重启**。签名用 MCLINK_JWT_SECRET：显式配置时用它；
 *    没配时服务端会生成一份并**持久化**在 data/secrets.json 里，
 *    所以几个月前那封邮件里的链接今天点开依然有效（密钥没变）。
 *    如果改成每次启动随机生成，老邮件里的链接就全废了。
 *
 * 签名内容是 `unsubscribe:<userId>`，比较时用 timingSafeEqual（避免按字节比较泄露信息）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface UnsubscribeDeps {
  /** 签名密钥（config.jwtSecret） */
  secret: string;
  /** 站点公开地址，用于展示与生成链接 */
  origin: string;
  /** 真的落库：把某个用户标成"不再接收公告" */
  setOptOut(userId: string, value: boolean): void;
  /** 查用户是否存在（不存在的 id 不该被"退订成功"糊弄过去） */
  userExists(userId: string): boolean;
}

/** 签名：只签 userId，不签邮箱 —— 玩家改邮箱后老链接仍然有效 */
export function unsubscribeToken(secret: string, userId: string): string {
  return createHmac('sha256', secret).update(`unsubscribe:${userId}`).digest('hex').slice(0, 32);
}

export function verifyUnsubscribeToken(secret: string, userId: string, token: string): boolean {
  const expect = unsubscribeToken(secret, userId);
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(String(token ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function unsubscribeUrl(deps: Pick<UnsubscribeDeps, 'secret' | 'origin'>, userId: string): string {
  const base = deps.origin.replace(/\/+$/, '');
  return `${base}/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(deps.secret, userId)}`;
}

/** 结果页：自带样式、不依赖任何外部资源（邮件点开的场景可能很受限） */
function page(title: string, lines: string[]): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${title} · 邮件退订</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #121110; color: #f5f0e7;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.5rem; color: #bdb3a4; }
  a { color: #e0a33e; }
</style>
</head>
<body><main>
<h1>${title}</h1>
${lines.map((l) => `<p>${l}</p>`).join('\n')}
</main></body>
</html>
`;
}

/**
 * 处理退订请求，返回要发回去的 HTML 与状态码。
 * GET 是邮件里那个链接；POST 留给以后做「一键退订」头（List-Unsubscribe=One-Click）。
 */
export function handleUnsubscribe(deps: UnsubscribeDeps, query: URLSearchParams): { status: number; html: string } {
  const userId = (query.get('u') ?? '').trim();
  const token = (query.get('t') ?? '').trim();

  if (!userId || !token || !verifyUnsubscribeToken(deps.secret, userId, token)) {
    return {
      status: 400,
      html: page('链接无效', [
        '这个退订链接不完整或已失效。',
        '如果你想停止接收公告邮件，请直接回复任意一封公告邮件说明，我们会手动处理。',
      ]),
    };
  }
  if (!deps.userExists(userId)) {
    // 账号已注销：也回"已退订"，避免暴露"这个 id 不存在"
    return { status: 200, html: page('已退订', ['这个账号已不在列表中，无需再退订。']) };
  }

  deps.setOptOut(userId, true);
  return {
    status: 200,
    html: page('已退订', [
      '你不会再收到本站的公告邮件了（账号仍可正常使用）。',
      '如果哪天想重新接收，在客户端的账号设置里把开关打开即可。',
    ]),
  };
}

export { page as unsubscribePage };
