#!/usr/bin/env node
/**
 * 断言 CI 真的产出了安装包。
 *
 * 为什么需要它：GitLab 的 Windows runner 用 **PowerShell 5.1**，而它不支持 `&&`
 * （PowerShell 7 才有）。曾经的构建步骤写成 `cd client && node scripts/dist.mjs …`，
 * 解析阶段就报错，但 PowerShell 把它当**非终止错误**，步骤退出码仍是 0 ——
 * job 显示 success、artifacts 上传时却报 "no matching files"，
 * 最后在主控上按名字下载产物就得到 404（排查了半天）。
 *
 * 所以：构建之后**显式检查产物**，没有就让 job 失败。
 * 用 node 写而不是 shell，是为了在 PowerShell 与 bash 下行为一致。
 *
 * 用法：
 *   node deploy/assert-artifacts.mjs --windows
 *   node deploy/assert-artifacts.mjs --macos
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = path.resolve('client/release');

const SPECS = {
  '--windows': { label: 'Windows 安装包', match: (f) => f.endsWith('.exe') && !f.endsWith('.blockmap') },
  '--macos': {
    label: 'macOS 包（dmg 或 zip）',
    match: (f) => (f.endsWith('.dmg') || f.endsWith('.zip')) && !f.endsWith('.blockmap'),
  },
};

const wanted = Object.keys(SPECS).filter((k) => args.includes(k));
if (wanted.length === 0) {
  console.error('用法: node deploy/assert-artifacts.mjs --windows|--macos');
  process.exit(2);
}

if (!fs.existsSync(dir)) {
  console.error(`✗ 产物目录不存在：${dir}`);
  console.error('  说明构建步骤根本没跑起来（例如 PowerShell 5.1 不支持 `&&` 导致命令解析失败）。');
  process.exit(1);
}

const files = fs.readdirSync(dir);
let failed = 0;
for (const key of wanted) {
  const spec = SPECS[key];
  const hits = files.filter(spec.match);
  if (hits.length === 0) {
    console.error(`✗ 没有找到${spec.label}。release 目录内容：${files.join(', ') || '(空)'}`);
    failed += 1;
  } else {
    for (const f of hits) {
      const size = (fs.statSync(path.join(dir, f)).size / 1048576).toFixed(1);
      console.log(`✓ ${f}  ${size}MB`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} 项断言失败：构建没有产出预期的安装包。`);
  process.exit(1);
}
console.log('\n产物断言通过。');
