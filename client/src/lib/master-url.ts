/**
 * 主控地址的归一化与判定（**纯函数，可离线校验**）。
 *
 * 为什么单独一个文件：`api.ts` 在模块初始化时就会读 `import.meta.env`
 * （Vite 注入的打包常量），那里在纯 Node 里跑不起来 —— 而"玩家填的地址到底
 * 会被解析成什么"恰恰是最该被离线测的一环（写错就是连到别的机器）。
 * 所以把这段纯逻辑挪出来，`api.ts` 只负责拼上 localStorage 与打包常量。
 *
 * 两种写法都接受（社区教程里两种都常见）：
 *   · `https://example.com`（推荐：反代 + TLS）
 *   · `example.com:8787` / `192.168.1.10:8787`（自建直连，没证书时补 `http://`）
 */

/**
 * 归一化一个主控地址：补协议、去尾部斜杠、**只保留 origin**。
 * 返回 `null` 表示这不是个能用的地址（调用方据此回退到默认主控）。
 *
 * 为什么要剥掉路径：主控的接口前缀由 `API_PREFIX`（`/api/v1`）负责，
 * 玩家把 `https://example.com/console/rooms` 粘进来时，拼出来的请求会变成
 * `/console/rooms/api/v1/...` —— 404 而且很难看出原因。
 */
export function normalizeMasterUrl(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  /**
   * ⚠️ 先挡非 ASCII：`new URL('http://这不是地址')` 会**成功**并把它 IDNA 成
   * `http://xn--ihqq6tnb086gx92c` —— 于是随便一段中文都能变成"合法主控地址"，
   * 玩家会连到一个根本不存在的域名上、只看到"无法连接"。
   * 主控地址是机器名或域名，写成中文域名的场景（需要 punycode）在这里不值得支持。
   */
  if (/[^\x20-\x7e]/.test(text)) return null;
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // 主机名与节点地址同一套白名单：单标签的内网名（nas:8787）也放行，但必须是纯 ASCII 主机名
  if (!/^[A-Za-z0-9._-]+$/.test(url.hostname)) return null;
  return `${url.protocol}//${url.host}`;
}
