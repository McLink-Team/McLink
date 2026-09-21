/**
 * 打一个可以拷到 Debian 服务器上直接安装的源码包。
 *
 * 为什么不用 tar 的 --exclude：实测 `--exclude="./vendor"` 把 deploy/vendor/linux-x86_64
 * 也一起排除了（bsdtar 的路径模式会跨层匹配），结果包里没有 Linux 二进制，
 * 服务器还得去 GitHub 下载。改成**按 git 跟踪清单**打，再加几个故意不入库的文件，精确可控。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/mc';
const OUT = `${ROOT}/.cache/mclink-src.tar.gz`;
const LIST = `${ROOT}/.cache/mclink-src.list`;

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

/** 故意不入库、但服务器安装时很有用的文件 */
const extra = ['deploy/vendor/linux-x86_64/easytier-core', 'deploy/vendor/linux-x86_64/easytier-cli'];

const files = [...tracked, ...extra].filter((rel) => {
  if (rel.startsWith('vendor/')) return false; // Windows 二进制，服务器不需要
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(`  ! 跳过不存在的文件: ${rel}`);
    return false;
  }
  return true;
});

fs.writeFileSync(LIST, `${files.join('\n')}\n`);
console.log(`清单：${files.length} 个文件（git 跟踪 ${tracked.length} + 额外 ${extra.length}）`);

if (fs.existsSync(OUT)) fs.rmSync(OUT);
execFileSync('tar', ['-czf', OUT, '-C', ROOT, '-T', LIST], { stdio: 'inherit' });

const stat = fs.statSync(OUT);
console.log(`\n打包完成：${OUT}  ${(stat.size / 1048576).toFixed(1)} MB`);

// 自检：Linux 二进制与几个关键文件必须在包里
const listing = execFileSync('tar', ['-tzf', OUT], { encoding: 'utf8' }).split('\n').filter(Boolean);
console.log(`包内条目：${listing.length}`);
for (const need of [
  './deploy/vendor/linux-x86_64/easytier-core',
  './deploy/vendor/linux-x86_64/easytier-cli',
  './deploy/install-server.sh',
  './pnpm-lock.yaml',
  './server/src/index.ts',
]) {
  const hit = listing.includes(need);
  console.log(`  ${hit ? '✓' : '✗'} ${need}`);
  if (!hit) process.exitCode = 1;
}
