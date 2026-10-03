/**
 * 隐私清理（2026-10-03）：把**真实节点名 / 私有仓库账号 / 内部 GitLab 路径**换成中性占位。
 *
 * 为什么要做：这些字符串会随**公开仓库**一起发布 ——
 *   · 真实节点名（各家云厂商 + 线路 + 带宽）等于对外公开"我们有哪些机器、什么线路、多大带宽"；
 *   · 私有仓库/组织的账号与路径（GitHub 与 GitLab 各一个）；
 *   · 提交作者名（那条走 filter-branch 的 --env-filter，不在这个脚本里）。
 *
 * 用法（两种场合都用它）：
 *   node scripts/scrub-privacy.mjs            # 清理当前工作树
 *   git filter-branch --tree-filter 'node /abs/path/scripts/scrub-privacy.mjs --quiet' -- --all
 *
 * ⚠️ 两个坑（都踩过）：
 *   1. 替换必须**成对一致**：单元测试里既用节点名当夹具、又用同一个字面量做断言，
 *      只改一处会让测试失败（跑一遍 `pnpm test` 就能发现）；
 *   2. **不能让它清理自己** —— 第一版跑完把本文件的替换表也换成了占位符，
 *      于是再跑就什么都不匹配（幂等性没了）。所以下面显式跳过自身。
 */
import fs from 'node:fs';
import path from 'node:path';

const QUIET = process.argv.includes('--quiet');
const REPO =
  process.env.MCLINK_SCRUB_ROOT ??
  path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/**
 * 替换表：顺序**从长到短**（先换"华东-A（2 Mbps）"再换"华东-A"，
 * 否则短的先命中会留下半截名字）。
 */
const RULES = [
  // ---- 真实节点名（含线路与带宽描述）→ 中性占位 ----
  ['华东-A（2 Mbps）', '华东-A（2 Mbps）'],
  ['华东-A（200 Mbps）', '华东-A（200 Mbps）'],
  ['华东-A', '华东-A'],
  ['华北-A（200 Mbps）', '华北-A（200 Mbps）'],
  ['华北-A（200 Mbps）', '华北-A（200 Mbps）'],
  ['华北-A', '华北-A'],
  ['华南-A（5 Mbps）', '华南-A（5 Mbps）'],
  ['华南-A（5 Mbps）', '华南-A（5 Mbps）'],
  ['华南-A', '华南-A'],
  ['香港-A（200 Mbps）', '香港-A（200 Mbps）'],
  ['香港-A（200 Mbps）', '香港-A（200 Mbps）'],
  ['香港-A', '香港-A'],
  ['海外-A（500 Mbps）', '海外-A（500 Mbps）'],
  ['海外-A（500 Mbps）', '海外-A（500 Mbps）'],
  ['海外-A', '海外-A'],
  ['海外-B（1 Gbps）', '海外-B（1 Gbps）'],
  ['海外-B（1 Gbps）', '海外-B（1 Gbps）'],
  ['海外-B', '海外-B'],
  ['海外-C（50 Mbps）', '海外-C（50 Mbps）'],
  ['海外-C（50 Mbps）', '海外-C（50 Mbps）'],
  ['海外-C', '海外-C'],
  ['海外-D（1 Gbps）', '海外-D（1 Gbps）'],
  // ---- 私有仓库账号 / 内部 GitLab 路径 ----
  ['https://github.com/example/backup', 'https://github.com/example/backup'],
  ['git@gitlab.com:example/legacy-backup.git', 'git@gitlab.com:example/legacy-backup.git'],
  ['https://gitlab.com/example/legacy-backup', 'https://gitlab.com/example/legacy-backup'],
  ['example/legacy-backup', 'example/legacy-backup'],
  ['example', 'example'],
  ['example/backup', 'example/backup'],
  ['example', 'example'],
  // ---- 实验室口令（上一轮清理的默认值，顺手保证幂等）----
  ['dev-only-passw0rd', 'dev-only-passw0rd'],
  ['lab-not-a-real-password', 'lab-not-a-real-password'],
];

/** 跳过自身：否则替换表会被自己换成占位符，第二次运行就什么都不匹配了（实测踩过） */
const SKIP_FILES = new Set([path.join('scripts', 'scrub-privacy.mjs')]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', '.cache', 'vendor', 'build', '.smoke', 'public']);
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.vue', '.json', '.md', '.yml', '.yaml', '.sh', '.ps1',
  '.toml', '.example', '.txt', '.css', '.html', '.conf', '.properties', '.gradle', '.xml', '.kt', '.java',
]);

let changed = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(REPO, abs);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs);
      continue;
    }
    if (SKIP_FILES.has(rel)) continue;
    if (!TEXT_EXT.has(path.extname(entry.name)) && !entry.name.startsWith('.gitlab-ci')) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let next = text;
    for (const [from, to] of RULES) {
      if (next.includes(from)) next = next.split(from).join(to);
    }
    if (next !== text) {
      fs.writeFileSync(abs, next, 'utf8');
      changed += 1;
      if (!QUIET) console.log(`  改过: ${rel}`);
    }
  }
}

walk(REPO);
if (!QUIET) console.log(`\n共改动 ${changed} 个文件。`);
