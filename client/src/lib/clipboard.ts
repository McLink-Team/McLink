/**
 * 复制到剪贴板 —— 带兜底。
 *
 * 为什么不能只用 `navigator.clipboard.writeText`：异步剪贴板 API 要求
 * **文档处于聚焦状态 + 用户激活**。实测在这个 Electron 客户端里，只要窗口
 * 没拿到焦点（比如用户刚在浏览器里点过东西），writeText 就会抛 NotAllowedError，
 * 界面上就变成「复制失败」——而「把地址发给朋友」是本产品最核心的动作，不能这样。
 *
 * 兜底走 `document.execCommand('copy')`：它已废弃，但不需要焦点与权限，
 * 对本机桌面客户端正好合适。两条路都失败才返回 false。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 落到下面的兜底路径 */
  }

  return legacyCopy(text);
}

/** execCommand 兜底：临时塞一个不可见的 textarea，选中后复制 */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // 必须留在文档里才能被选中；用 fixed + 透明而不是 display:none（后者选不中）
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.padding = '0';
    area.style.border = 'none';
    area.style.outline = 'none';
    area.style.boxShadow = 'none';
    area.style.background = 'transparent';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
