/**
 * 验证脚本共用的「本机主控」生命周期。
 *
 * ## 为什么单独一个模块
 *
 * `verify-vpn-plan.mjs` 要一个**真的主控**（真实票据只能从它那里拿），
 * 而"起一个主控"这件事本身有一串容易写错的细节（端口、数据目录、管理员密码、
 * 等它真的监听、跑完要停）。写两遍就会有其中一遍忘了停。
 *
 * ## 两种模式，差别只在数据落在哪
 *
 * | 8787 上有主控吗 | 用谁的数据 | 跑完怎么清 |
 * | --- | --- | --- |
 * | 有 | 它自己的（可能是开发库） | 删掉这个脚本造的那一行行（`purgeRows`） |
 * | 没有 | `android/.smoke/vpn-verify-data`（每次都新建） | 停掉进程 + 删掉整个目录 |
 *
 * 第二种是**默认路径**（本机平时没有常驻主控），它的好处是清理是彻底的：
 * 数据从一开始就不在开发库里，不存在"清了一半"。
 * 第一种（复用）必须按 id 精确删，见 `purgeRows`。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** android/ */
export const ANDROID_ROOT = path.resolve(HERE, '..', '..');
/** 仓库根 F:\mc */
export const REPO_ROOT = path.resolve(ANDROID_ROOT, '..');
export const SERVER_DIR = path.join(REPO_ROOT, 'server');

export const DEFAULT_MASTER = 'http://127.0.0.1:8787';
/** 文档里写死的本机管理员密码（`.cache/` 下的验证脚本用的是同一个） */
export const DEFAULT_ADMIN_PASSWORD = 'dev-only-passw0rd';

/** 复用模式下去哪里找库：与 server/src/config.ts 的 MCLINK_DATA_DIR 规则一致 */
export function resolveDbPath() {
  const envDir = process.env.MCLINK_DATA_DIR;
  const dataDir = envDir ? path.resolve(envDir) : path.join(SERVER_DIR, 'data');
  return path.join(dataDir, 'mclink.sqlite');
}

/** 主控活着吗。返回 boolean，**不抛异常**：连不上就是"没在跑" */
export async function masterAlive(base = DEFAULT_MASTER, timeoutMs = 2500) {
  try {
    const res = await fetch(`${base}/api/v1/meta`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 确保有一个可用的主控，返回 `{ base, owned, api, stop }`。
 *
 * `api()` 是给调用方用的最小客户端：拼 URL、带令牌、解 `{ data }` 信封、
 * 失败时把服务端那句 `error.message` 原样抛出来（"HTTP 400" 这种信息查不了问题）。
 */
export async function ensureMaster({ base = DEFAULT_MASTER, log = console.log, adminPassword = DEFAULT_ADMIN_PASSWORD } = {}) {
  let owned = false;
  let child = null;
  let dataDir = null;

  if (await masterAlive(base)) {
    log(`复用已在运行的主控 ${base}（跑完只删本脚本造的数据）`);
  } else {
    const port = Number(new URL(base).port || 80);
    dataDir = path.join(ANDROID_ROOT, '.smoke', 'vpn-verify-data');
    // 每次都是全新的库：上一次的残留（如果有）会让"注册成功"变成"用户名已被占用"
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });

    /*
     * stdio 用 ignore 而不是 pipe：主控是长驻进程，我们不需要它的输出，
     * 而给长驻子进程挂管道在部分受限环境下会被直接拒绝（与 lib/browser.mjs 同一个理由）。
     * 它的日志本来也会落到 dataDir 里。
     */
    child = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'index.ts')], {
      cwd: SERVER_DIR,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        MCLINK_ADMIN_PASSWORD: adminPassword,
        MCLINK_DATA_DIR: dataDir,
        MCLINK_PORT: String(port),
        /*
         * 关掉"必须验证邮箱"。
         *
         * 默认是**开**（`DEFAULT_SETTINGS.requireEmailVerification = true`），
         * 而验证邮箱要真的发信 —— 本机没有 SMTP，注册那一步就会 400，
         * 整个验证脚本连门都进不去。这条只作用于**脚本自己起的临时主控**
         * （它的库跑完就删），复用模式下一个字都不改 ——
         * 那台主控的设置是别人的真实配置，我们没有权利动。
         */
        MCLINK_REQUIRE_EMAIL_VERIFICATION: '0',
      },
    });
    owned = true;
    log(`已启动本机主控（临时数据目录 ${dataDir}，端口 ${port}），等它就绪…`);

    const deadline = Date.now() + 60_000;
    let up = false;
    while (Date.now() < deadline) {
      if (await masterAlive(base, 1500)) {
        up = true;
        break;
      }
      if (child.exitCode !== null) break;
      await sleep(500);
    }
    if (!up) {
      child.kill();
      throw new Error(`主控没能在 60 秒内起来（${base}）。手动跑一次 server/src/index.ts 看它报什么错。`);
    }
    log('主控已就绪');
  }

  const api = async (p, { method = 'GET', body, token } = {}) => {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api/v1${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 响应：下面按原文报出来 */
    }
    if (!res.ok) {
      const detail = json?.error?.message ?? text.slice(0, 200);
      throw new Error(`${method} ${p} → HTTP ${res.status}：${detail}`);
    }
    return json?.data;
  };

  const stop = async () => {
    if (!owned) return;
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
    for (let i = 0; i < 40 && (await masterAlive(base, 500)); i += 1) await sleep(250);
    // 让被 kill 的子进程句柄在 libuv 里落定再返回：紧接着 process.exit() 时
    // Windows 上偶发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（噪声，不是失败）
    await sleep(200);
  };

  return { base, owned, api, stop, dataDir, child };
}

/* --------------------------------------------------------------- 精确清理 */

/**
 * 按 id 删掉本脚本造的行。
 *
 * 口径比 `.cache/clean-bench-data.mjs` 更窄：那边按**前缀**删压测数据，
 * 这里只有一条房间 + 一个用户，按 id 删不会碰到任何别人的东西。
 *
 * 表名不写死：谁有 `room_id` / `user_id` 列就删谁 —— 迁移里加一张引用表时
 * 这里不用跟着改（上一版写死表名的教训在那份脚本的注释里）。
 * 会主动 `pragma busy_timeout`，因为复用模式下主控可能正开着这张库（WAL 允许并发写）。
 */
export async function purgeRows(dbPath, { roomIds = [], userIds = [] } = {}, log = console.log) {
  if (!fs.existsSync(dbPath)) {
    log(`⚠ 找不到库 ${dbPath}，跳过 SQL 清理（请手工确认没有残留）`);
    return { ok: false, reason: 'db-missing' };
  }
  // 动态 import：只有真的要清理时才需要 node:sqlite
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const placeholders = (ids) => ids.map(() => '?').join(',');

  try {
    db.exec('pragma busy_timeout = 10000');
    const tables = all("select name from sqlite_master where type='table'").map((r) => r.name);
    const columnsOf = (t) => all(`pragma table_info("${t}")`).map((c) => c.name);
    const purgeBy = (col, ids, skip = []) => {
      if (ids.length === 0) return [];
      const touched = [];
      for (const t of tables) {
        if (skip.includes(t) || !columnsOf(t).includes(col)) continue;
        db.prepare(`delete from "${t}" where ${col} in (${placeholders(ids)})`).run(...ids);
        touched.push(t);
      }
      return touched;
    };

    db.exec('begin');
    const roomRefs = purgeBy('room_id', roomIds, ['rooms']);
    const userRefs = purgeBy('user_id', userIds, ['users']);
    if (roomIds.length > 0) {
      db.prepare(`delete from rooms where id in (${placeholders(roomIds)})`).run(...roomIds);
    }
    if (userIds.length > 0) {
      db.prepare(`delete from users where id in (${placeholders(userIds)})`).run(...userIds);
    }
    db.exec('commit');

    // 断言真的删干净了：清理脚本不自己验一遍，就等于没清
    const leftover = {
      rooms: roomIds.length > 0 ? all(`select count(*) c from rooms where id in (${placeholders(roomIds)})`, ...roomIds)[0].c : 0,
      users: userIds.length > 0 ? all(`select count(*) c from users where id in (${placeholders(userIds)})`, ...userIds)[0].c : 0,
    };
    log(
      `已清理（引用表 room_id: ${roomRefs.join(', ') || '无'} / user_id: ${userRefs.join(', ') || '无'}）；` +
        `残留 rooms=${leftover.rooms} users=${leftover.users}`,
    );
    return { ok: leftover.rooms === 0 && leftover.users === 0, leftover };
  } catch (err) {
    try {
      db.exec('rollback');
    } catch {
      /* 事务可能已经不在 */
    }
    log(`⚠ SQL 清理失败（${String(err.message)}）。这不是测试失败，但库里有残留，需要手工确认。`);
    return { ok: false, reason: String(err.message) };
  } finally {
    db.close();
  }
}
