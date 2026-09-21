#!/usr/bin/env node
/**
 * 开发/测试辅助：运行一个外部命令并把 stdout+stderr 落到文件。
 *
 * 为什么不用管道：本机沙箱（workspace-write）禁止子进程使用管道 stdio，
 * `child_process` 默认的 'pipe' 会直接 EPERM。把 fd 指向真实文件既能绕开该限制，
 * 也顺带避免了管道缓冲区写满导致的死锁。
 *
 * 用法: node scripts/capture.mjs <输出文件> <命令> [参数...]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [outFile, cmd, ...args] = process.argv.slice(2);
if (!outFile || !cmd) {
  console.error('用法: node scripts/capture.mjs <输出文件> <命令> [参数...]');
  process.exit(2);
}

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
const fd = fs.openSync(outFile, 'w');

const child = spawn(cmd, args, {
  stdio: ['ignore', fd, fd],
  windowsHide: true,
});

const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
});

fs.closeSync(fd);
console.log(`exit=${code} bytes=${fs.statSync(outFile).size} file=${path.resolve(outFile)}`);
