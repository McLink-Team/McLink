#!/usr/bin/env node
/**
 * 主控一键收产物：把客户端安装包放进 `downloads/`、算 sha256、打印（或写入）平台设置。
 *
 * 为什么需要它：发布一次要动三处 —— 产物名字要对上主控的期望、`downloads/` 里要有文件、
 * 平台设置里的 `clientVersion / clientDownloadUrl / clientSha256` 要同步。以前是手工 copy +
 * `sha256sum` + 手填控制台，容易漏（尤其是名字里的版本号）。
 *
 * 用法（在**主控**上跑）：
 *   # ① 从本地目录收（最常见：包已经 scp 到主控的某个目录）
 *   node scripts/fetch-client-artifacts.mjs --from /root/mclink-out
 *
 *   # ② 从 GitHub CI 的最近一次成功构建收（需要能访问 GitHub；代理用 HTTPS_PROXY）
 *   HTTPS_PROXY=http://127.0.0.1:7890 GITHUB_TOKEN=ghp_xxx \
 *     node scripts/fetch-client-artifacts.mjs --from github
 *
 *   # ③ 手编的安卓包顺带收进来（只算 sha、放进 downloads/，不写设置）
 *   node scripts/fetch-client-artifacts.mjs --apk /root/mclink-android-1.1.0-debug.apk
 *
 *   # ④ 确认无误后写入平台设置（管理接口）
 *   node scripts/fetch-client-artifacts.mjs --from /root/mclink-out --apply --password '管理员密码'
 *
 * 选项：
 *   --from <dir|github>  来源目录，或 `github`（从 CI 产物下载）
 *   --apk <path>         额外的 APK 文件（放进 downloads/ 并算 sha256）
 *   --version <v>        版本号，默认读 client/package.json
 *   --dir <path>         下载目录，默认 `$MCLINK_DOWNLOADS_DIR`，再退到 server/data/downloads
 *   --master <url>       主控地址（--apply 用），默认 http://127.0.0.1:8787
 *   --password <pw>      管理员密码（--apply 用；也读 MCLINK_ADMIN_PASSWORD）
 *   --apply              真的写入平台设置（不带就只打印）
 *   --dry-run            只打印计划，不落盘
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

/** 主控期望的文件名（与 server/src/services/settings.ts 的 clientArtifactName 保持一致） */
const expectedNames = (v) => ({
  win: `McLink-Setup-${v}-x64.exe`,
  macArm: `McLink-${v}-macos-arm64.dmg`,
  macX64: `McLink-${v}-macos-x64.dmg`,
  apk: `mclink-android-${v}-debug.apk`,
});

const version = arg('version') ?? JSON.parse(fs.readFileSync(path.join(REPO, 'client/package.json'), 'utf8')).version;
const names = expectedNames(version);
const dir =
  arg('dir') ??
  process.env.MCLINK_DOWNLOADS_DIR ??
  path.join(REPO, 'server', 'data', 'downloads');
const source = arg('from');
const apk = arg('apk');
const dryRun = flag('dry-run');

if (!source && !apk) {
  console.error('至少要给一个来源：--from <目录|github> 或 --apk <路径>（--help 看用法，文件头注释里有）');
  process.exit(2);
}
if (!fs.existsSync(dir)) {
  if (dryRun) console.log(`（dry-run）下载目录还不存在，会创建：${dir}`);
  else fs.mkdirSync(dir, { recursive: true });
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const human = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** 把某个文件按主控期望的名字放好；返回落盘信息 */
function place(srcFile, targetName) {
  const target = path.join(dir, targetName);
  const size = fs.statSync(srcFile).size;
  if (path.resolve(srcFile) !== path.resolve(target)) {
    if (dryRun) console.log(`（dry-run）${srcFile} → ${target}`);
    else fs.copyFileSync(srcFile, target);
  }
  const digest = sha256(dryRun ? srcFile : target);
  return { name: targetName, size, sha256: digest, path: dryRun ? target : target };
}

const placed = [];

if (source === 'github') {
  /* ---------------- 从 CI 产物收 ---------------- */
  const token = process.env.GITHUB_TOKEN ?? '';
  const repo = process.env.MCLINK_REPO ?? 'luo-die/mclink';
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
  const curl = (args) => execFileSync('curl', ['-sS', ...(proxy ? ['--proxy', proxy] : []), ...args]).toString();
  const api = (p) => JSON.parse(curl(['-H', `Authorization: Bearer ${token}`, `https://api.github.com/repos/${repo}${p}`]));

  const runs = api('/actions/workflows/build-clients.yml/runs?status=success&per_page=1').workflow_runs ?? [];
  if (runs.length === 0) {
    console.error('没找到成功的 build-clients 构建（也可以直接用 --from <目录>）');
    process.exit(1);
  }
  const run = runs[0];
  console.log(`取 CI 构建：run ${run.id}（${run.head_sha.slice(0, 7)}，${run.created_at}）`);
  const artifacts = api(`/actions/runs/${run.id}/artifacts`).artifacts ?? [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mclink-artifacts-'));
  for (const a of artifacts) {
    console.log(`  下载产物 ${a.name} …`);
    const zip = path.join(tmp, `${a.name}.zip`);
    // 注意：先带 token 拿 302，再让 curl -L 到存储域名（跨主机时会自动丢掉 Authorization）
    execFileSync('curl', [
      '-sSL',
      ...(proxy ? ['--proxy', proxy] : []),
      '-H',
      `Authorization: Bearer ${token}`,
      '-o',
      zip,
      a.archive_download_url,
    ]);
    execFileSync('unzip', ['-oq', zip, '-d', path.join(tmp, a.name)]);
  }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(tmp);
  const pick = (re) => files.find((f) => re.test(path.basename(f)));
  const pairs = [
    [pick(/Setup.*x64.*\.exe$|\.exe$/), names.win],
    [pick(/macos-arm64.*\.dmg$|arm64\.dmg$/), names.macArm],
    [pick(/macos-x64.*\.dmg$|x64\.dmg$/), names.macX64],
  ];
  for (const [file, target] of pairs) {
    if (file) placed.push(place(file, target));
    else console.log(`  ⚠️ CI 产物里没找到 ${target}（可能是那份产物没构建）`);
  }
} else if (source) {
  /* ---------------- 从本地目录收 ---------------- */
  const all = fs
    .readdirSync(source, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(source, e.name));
  /*
   * 优先只认**文件名里带这个版本号**的产物。
   *
   * 为什么必须有这一步：`--from` 常常指向"下载"文件夹，里面同时堆着好几个版本的
   * exe / dmg。只按后缀挑会随手命中旧版本 —— 收进来的**文件名是对的、内容却是上一版的**，
   * 而且事后没人看得出来（上一轮的坑，见 docs/relay-assignment.md 的待办）。
   * 一个带版本号的都没有时才退回宽松匹配，并明确警告。
   */
  const versioned = all.filter((f) => path.basename(f).includes(version));
  const files = versioned.length > 0 ? versioned : all;
  if (all.length > 0 && versioned.length === 0) {
    console.log(`  ⚠️ 目录里没有文件名带 ${version} 的产物 —— 退回按后缀挑，可能挑到别的版本（建议 --version 指定）`);
  }
  const pick = (re) => files.find((f) => re.test(path.basename(f)));
  const pairs = [
    [pick(/\.exe$/i), names.win],
    [pick(/arm64.*\.dmg$/i), names.macArm],
    [pick(/(x64|x86_64|intel).*\.dmg$/i), names.macX64],
    [pick(/\.apk$/i), names.apk],
  ];
  for (const [file, target] of pairs) {
    if (file) placed.push(place(file, target));
    else console.log(`  ⚠️ 目录里没有 ${target} 对应的文件（跳过）`);
  }
}

if (apk) placed.push(place(apk, names.apk));

if (placed.length === 0) {
  console.error('什么都没收进来 —— 检查 --from 目录里有没有 .exe / .dmg / .apk');
  process.exit(1);
}

/* ---------------- 结果 + 要填的设置 ---------------- */
const winEntry = placed.find((p) => p.name === names.win);
console.log('\n已放入下载目录：');
for (const p of placed) console.log(`  ${p.name}  ${human(p.size)}  sha256=${p.sha256}`);

console.log('\n平台设置（控制台 → 平台设置，或 --apply 直接写）：');
console.log(`  clientVersion     = ${version}`);
if (winEntry) {
  console.log(`  clientDownloadUrl = /downloads/${winEntry.name}`);
  console.log(`  clientSha256      = ${winEntry.sha256}`);
} else {
  console.log('  ⚠️ 没有 Windows 安装包，clientDownloadUrl / clientSha256 请按实际产物填');
}

if (flag('apply')) {
  const master = arg('master') ?? 'http://127.0.0.1:8787';
  const password = arg('password') ?? process.env.MCLINK_ADMIN_PASSWORD ?? '';
  if (!password) {
    console.error('\n--apply 需要管理员密码：--password <pw> 或 MCLINK_ADMIN_PASSWORD');
    process.exit(2);
  }
  const post = async (p, body, token) => {
    const res = await fetch(`${master}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const login = await post('/api/v1/auth/login', { username: 'admin', password });
  const token = login.json?.data?.token;
  if (!token) {
    console.error(`登录失败（HTTP ${login.status}）：${JSON.stringify(login.json)?.slice(0, 200)}`);
    process.exit(1);
  }
  const patch = { clientVersion: version };
  if (winEntry) {
    patch.clientDownloadUrl = `/downloads/${winEntry.name}`;
    patch.clientSha256 = winEntry.sha256;
  }
  const res = await fetch(`${master}/api/v1/admin/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  console.log(`\n写入设置：HTTP ${res.status}${res.ok ? ' ✓' : ' ✗'}`);
  if (!res.ok) console.log((await res.text()).slice(0, 300));
} else {
  console.log('\n（只打印，没有写设置 —— 确认无误后加 --apply）');
}
