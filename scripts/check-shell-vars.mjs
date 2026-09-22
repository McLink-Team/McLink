#!/usr/bin/env node
/**
 * 检查 shell 脚本里一个隐蔽的坑：**变量展开后面紧跟别的字符**。
 *
 * 两类都会让 bash 把后面的字符当成变量名的一部分：
 *
 *   1. 非 ASCII 字符（中文标点最常见）：
 *        echo "▸ $APP  （架构 $ARCH）"      ← $ARCH 后面紧跟全角「）」
 *      bash 在 UTF-8 locale 下把合法的多字节字符也算作名字字符，于是去找一个叫
 *      `ARCH）` 的变量 —— `set -u` 直接报：
 *        deploy/sign-macos-app.sh: line 57: ARCH）: unbound variable
 *      （CI 上就是这么红的，排查了半天。）
 *
 *   2. ASCII 字母/数字/下划线：
 *        echo "$ZIPs"                       ← 实际找的是 ZIPs，不是 ZIP
 *
 * 修法：写成 ${NAME}，花括号明确结束名字。
 * 这个脚本扫仓库里所有 *.sh，以及 CI 配置（*.yml 里也有内联 shell）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'release', 'dist', '.cache', 'vendor'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.sh') || entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) targets.push(full);
  }
};
walk(REPO_ROOT);

/**
 * 只查**非 ASCII 紧跟**这一种。
 *
 * 不能用 `\$(\w+)([\u0080-\uFFFF]|[A-Za-z0-9_])` 这种写法：贪婪组会回溯，
 * `$DMG` 会被拆成 `$DM` + `G` 报成问题 —— 第一版就因此刷出 278 条误报。
 * 正确做法：先用贪婪组吃掉整个变量名，再看**紧随其后**的那个字符是不是非 ASCII。
 * ASCII 字母紧跟（`$DMG`）本来就属于同一个变量名，无从判定也无需判定。
 */
const RE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

let found = 0;
for (const file of targets) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) return; // 注释里无所谓
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(line)) !== null) {
      const next = line[RE.lastIndex];
      if (next === undefined || next.charCodeAt(0) < 0x80) continue;
      found += 1;
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      console.log(`  ✗ ${rel}:${i + 1}:${m.index + 1}   $${m[1]}"${next}"   应写成 \${${m[1]}}`);
      console.log(`      ${line.trim().slice(0, 110)}`);
    }
  });
}

console.log(
  found === 0
    ? `✅ 扫描 ${targets.length} 个文件，没有变量名粘连问题`
    : `\n共 ${found} 处：给变量加花括号（\${NAME}）即可`,
);
process.exit(found === 0 ? 0 : 1);
