/**
 * 冒烟/E2E 脚本共用的浏览器驱动 —— 一个够用的 CDP 客户端 + 静态服务。
 *
 * 为什么自己写而不是装 Playwright/Puppeteer：
 *   1. 那两个都要额外下一个 100–300MB 的浏览器二进制，而 Windows 10/11 已经自带
 *      Edge（Chromium 内核）—— 我们只需要"一个 Chromium + 能执行 JS + 能截图"，
 *      这三件事 CDP 原生就够；
 *   2. 这两个脚本的职责是**验证产物**，依赖越少越可信：现在它只用 Node 内置模块
 *      （http / child_process / 全局 WebSocket），没有 node_modules 依赖。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- 结果汇报 */

export function createReporter(prefix) {
  let failures = 0;
  return {
    log: (msg) => console.log(`[${prefix}] ${msg}`),
    /** 记一条断言。返回是否通过，方便调用方在失败时提前结束 */
    check(name, ok, detail = '') {
      if (ok) console.log(`  ✓ ${name}`);
      else {
        failures += 1;
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
      }
      return ok;
    },
    get failures() {
      return failures;
    },
  };
}

/* --------------------------------------------------------------- 静态服务 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/** 把某个目录喂到 http://127.0.0.1:<随机端口>/，返回 { server, port, url } */
export function serveDir(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const file = path.join(dir, rel === '/' ? 'index.html' : rel);
      // 目录穿越防护：解析后的路径必须仍在 dir 之内
      if (!file.startsWith(dir)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404).end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/* --------------------------------------------------------------- 浏览器 */

/** 找一个 Chromium 内核的浏览器：优先 Edge（Windows 自带），其次 Chrome */
export function findChromium() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Edge/Chrome。这一步需要一个 Chromium 内核的浏览器。');
}

/** 用 Node 内置的 WebSocket（Node 22+ 全局可用）做一个够用的 CDP 客户端 */
export function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`CDP 超时：${method}`));
            }, 30000);
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });
}

/**
 * 起一个无头浏览器并连上 CDP。
 *
 * stdio 用 ignore 而不是 pipe：我们只通过 CDP 说话，不需要它的输出流，
 * 而给一个长驻进程挂管道在部分受限环境下会被拒绝。
 */
export async function launchBrowser({ chromium, debugPort, profileDir, viewport, log = () => {} }) {
  const child = spawn(
    chromium,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      `--window-size=${viewport.width},${viewport.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  log(`已启动 ${path.basename(chromium)}（headless, CDP :${debugPort}）`);

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(500);
  }
  if (!target) {
    child.kill();
    throw new Error('浏览器调试端口没起来');
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.scale,
    mobile: true,
  });

  /** 在页面里求值；页面抛异常时把它当失败抛出，而不是静默返回 undefined */
  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? 'JS 异常');
    return res.result.value;
  };

  return { child, cdp, evaluate };
}
