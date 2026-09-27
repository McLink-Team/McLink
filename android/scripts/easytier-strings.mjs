#!/usr/bin/env node
/**
 * 列出二进制里所有包含 easytier（不分大小写）的 ASCII 字符串，去重。
 * 用途：判断这个 .so/dex 里到底有没有 EasyTier 网络核心、有没有 JNI 绑定。
 * 用法: node .cache/easytier-strings.mjs <file> [--filter=<substr>]
 */
import fs from 'node:fs';
const file = process.argv[2];
const filter = (process.argv.find((a) => a.startsWith('--filter=')) ?? '').slice(9).toLowerCase();
const regexArg = process.argv.find((a) => a.startsWith('--regex='));
const re = regexArg ? new RegExp(regexArg.slice(8)) : /easytier/i;
const buf = fs.readFileSync(file);
const out = new Set();
let start = -1;
for (let i = 0; i <= buf.length; i++) {
  const b = i < buf.length ? buf[i] : 0;
  if (b >= 0x20 && b <= 0x7e) { if (start < 0) start = i; }
  else {
    if (start >= 0 && i - start >= 4) {
      const s = buf.toString('latin1', start, i);
      if (re.test(s)) out.add(s);
    }
    start = -1;
  }
}
const list = [...out].filter((s) => !filter || s.toLowerCase().includes(filter)).sort();
console.log(`FILE: ${file}  (${buf.length} bytes)`);
console.log(`unique strings matching /easytier/i${filter ? ` AND filter "${filter}"` : ''}: ${list.length}`);
const show = list.length > Number(process.env.MAX ?? 400) ? list.slice(0, Number(process.env.MAX ?? 400)) : list;
for (const s of show) console.log('  ' + (s.length > 240 ? s.slice(0, 240) + '…' : s));
if (show.length < list.length) console.log(`  … (${list.length - show.length} more)`);
