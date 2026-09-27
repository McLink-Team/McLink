#!/usr/bin/env node
/**
 * 二进制取证：对 ELF 共享库做
 *   1) ELF 头解析（class / endian / e_machine / e_type）
 *   2) 段表解析 → .dynsym/.dynstr → 导出符号 + 未定义符号（看谁的依赖）
 *   3) SHT_DYNAMIC → DT_NEEDED / DT_SONAME（真实的 .so 依赖关系）
 *   4) 纯字节流 ASCII 字符串扫描（不用 findstr / grep，按字节找，避免编码猜测）
 *
 * 用法: node .cache/scan-so.mjs <file> [<file> ...]
 * 输出同时写到 stdout 与 .cache/scan-so-report.txt 由调用方决定（此处只 stdout）。
 */
import fs from 'node:fs';

const EM = { 3: 'Intel 80386', 8: 'MIPS', 40: 'ARM (32-bit)', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V' };
const ET = { 1: 'ET_REL', 2: 'ET_EXEC', 3: 'ET_DYN (PIE/shared object)', 4: 'ET_CORE' };

function parseElf(buf) {
  if (buf.length < 64) return { ok: false, why: 'file smaller than 64 bytes' };
  const magic = buf.subarray(0, 4);
  const isElf = magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
  const ei_class = buf[4], ei_data = buf[5];
  if (!isElf) return { ok: false, why: 'not an ELF (magic mismatch)', magic: magic.toString('hex') };
  if (ei_class !== 2) return { ok: false, why: `ELF class ${ei_class} (only 64-bit supported here)` };
  const le = ei_data === 1;
  const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const r64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));

  const e_type = r16(0x10), e_machine = r16(0x12);
  const e_shoff = r64(0x28), e_shentsize = r16(0x3a), e_shnum = r16(0x3c), e_shstrndx = r16(0x3e);

  // section headers
  const secs = [];
  for (let i = 0; i < e_shnum; i++) {
    const o = e_shoff + i * e_shentsize;
    if (o + 64 > buf.length) break;
    secs.push({
      i, name: r32(o), type: r32(o + 4), offset: r64(o + 24), size: r64(o + 32),
      link: r32(o + 40), entsize: r64(o + 56),
    });
  }
  const shstrSec = secs[e_shstrndx];
  const secName = (s) => {
    if (!shstrSec) return `#${s.name}`;
    let e = shstrSec.offset + s.name, s2 = '';
    while (e < buf.length && buf[e] !== 0) s2 += String.fromCharCode(buf[e++]);
    return s2;
  };
  for (const s of secs) s.sname = secName(s);

  const dynsymSec = secs.find((s) => s.type === 11); // SHT_DYNSYM
  const dynstrSec = dynsymSec ? secs[dynsymSec.link] : null;
  const dynSec = secs.find((s) => s.type === 6);     // SHT_DYNAMIC

  const strAt = (base, off) => {
    let e = base + off, out = '';
    while (e < buf.length && buf[e] !== 0) out += String.fromCharCode(buf[e++]);
    return out;
  };

  // dynamic entries: DT_NEEDED(1) / DT_SONAME(14) / DT_RPATH(15) / DT_RUNPATH(29)
  const dyn = [];
  if (dynSec && dynSec.entsize) {
    for (let o = dynSec.offset; o + 16 <= dynSec.offset + dynSec.size; o += dynSec.entsize) {
      const tag = r64(o), val = r64(o + 8);
      if (tag === 0) break;
      dyn.push({ tag, val });
    }
  }
  const dynstrBase = dynstrSec ? dynstrSec.offset : 0;
  const needed = dyn.filter((d) => d.tag === 1).map((d) => strAt(dynstrBase, d.val));
  const soname = dyn.filter((d) => d.tag === 14).map((d) => strAt(dynstrBase, d.val));
  const runpath = dyn.filter((d) => d.tag === 29 || d.tag === 15).map((d) => strAt(dynstrBase, d.val));

  // symbols
  const syms = [];
  if (dynsymSec && dynstrSec && dynsymSec.entsize) {
    const n = Math.floor(dynsymSec.size / dynsymSec.entsize);
    for (let i = 0; i < n; i++) {
      const o = dynsymSec.offset + i * dynsymSec.entsize;
      if (o + 24 > buf.length) break;
      const st_name = r32(o), st_info = buf[o + 4], st_shndx = r16(o + 6), st_value = r64(o + 8), st_size = r64(o + 16);
      const bind = st_info >> 4, type = st_info & 0xf;
      if (st_name === 0) continue;
      syms.push({ name: strAt(dynstrSec.offset, st_name), bind, type, shndx: st_shndx, value: st_value, size: st_size });
    }
  }
  // 导出 = 有定义（shndx != 0）; 未定义 = shndx == 0 且 bind 为 GLOBAL/WEAK
  const defined = syms.filter((s) => s.shndx !== 0);
  const undef = syms.filter((s) => s.shndx === 0 && s.bind >= 1);

  return { ok: true, ei_class, ei_data, e_type, e_machine, secs, syms, defined, undef, needed, soname, runpath };
}

/** 纯字节流 ASCII 扫描：返回 [{pattern, count, offsets[]}] */
function scanAscii(buf, patterns, minStr = 4) {
  const res = new Map(patterns.map((p) => [p, { count: 0, offsets: [] }]));
  // 先把 buffer 里的可打印 ASCII 串索引出来（长度 >= minStr）
  const strings = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i] : 0;
    const printable = b >= 0x20 && b <= 0x7e;
    if (printable) { if (start < 0) start = i; }
    else { if (start >= 0 && i - start >= minStr) strings.push([start, buf.toString('latin1', start, i)]); start = -1; }
  }
  for (const [off, s] of strings) {
    for (const p of patterns) {
      let idx = s.indexOf(p);
      while (idx !== -1) {
        const r = res.get(p);
        r.count++;
        if (r.offsets.length < 12) r.offsets.push(off + idx);
        idx = s.indexOf(p, idx + 1);
      }
    }
  }
  return { res, stringCount: strings.length };
}

/** 打印某个模式命中处前后的可读上下文（±64 字节），用于判断字符串是什么 */
function dumpContext(buf, pattern) {
  const p = Buffer.from(pattern, 'latin1');
  console.log(`--- CONTEXT for "${pattern}" (±64 bytes, latin1, non-printable -> '.') ---`);
  let idx = buf.indexOf(p), n = 0;
  while (idx !== -1 && n < 10) {
    const a = Math.max(0, idx - 64), b = Math.min(buf.length, idx + p.length + 64);
    let s = '';
    for (let i = a; i < b; i++) { const c = buf[i]; s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.'; }
    console.log(`  @0x${idx.toString(16)}: ${s}`);
    idx = buf.indexOf(p, idx + 1); n++;
  }
  if (n === 0) console.log('  (no hit)');
}

const PATTERNS = [
  'JNI_OnLoad', 'JNI_OnUnload', 'RegisterNatives', 'Java_',
  'com/easytier', 'com.easytier', 'EasyTier', 'EasyTierJNI',
  'libeasytier_ffi', 'easytier_ffi', 'libeasytier_android_jni', 'easytier_android_jni',
  'parseConfig', 'runNetworkInstance', 'setTunFd', 'stopAllInstances', 'getLastError',
  'callJsonRpc', 'collectNetworkInfosAsMap', 'collectNetworkInfos', 'retainNetworkInstance',
  'deleteNetworkInstance', 'listInstances', 'startConfigServerClient', 'isConfigServerClientConnected',
  'ConfigServerEventCallback', 'easytier_ffi_', 'easytier_',
  'easytier-core', 'easytier-cli', 'RPC_PORTAL', 'network_name', 'app_lib',
  'easytier_android', 'com.kkrainbow', 'kkrainbow', 'libapp_lib',
];

for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  console.log('='.repeat(100));
  console.log(`FILE: ${file}`);
  console.log(`BYTES: ${buf.length}  (${(buf.length / 1048576).toFixed(2)} MiB)`);
  console.log(`FIRST 20 BYTES (hex): ${buf.subarray(0, 20).toString('hex').match(/../g).join(' ')}`);
  const html = buf.subarray(0, 64).toString('latin1').trim().toLowerCase();
  console.log(`LOOKS LIKE HTML ERROR PAGE: ${html.startsWith('<') || html.includes('<!doctype html') ? 'YES (!!!)' : 'no'}`);

  const elf = parseElf(buf);
  if (!elf.ok) {
    console.log(`ELF PARSE: FAILED -> ${elf.why}`);
    const { res, stringCount } = scanAscii(buf, PATTERNS);
    console.log(`--- ASCII STRING SCAN (strings>=4 chars indexed: ${stringCount}) ---`);
    for (const p of PATTERNS) {
      const r = res.get(p);
      const head = r.offsets.slice(0, 6).map((o) => '0x' + o.toString(16)).join(' ');
      console.log(`    ${r.count > 0 ? 'HIT ' : 'MISS'}  ${String(r.count).padStart(5)}x  ${p}${r.count ? '   @ ' + head : ''}`);
    }
    if (process.env.CONTEXT) dumpContext(buf, process.env.CONTEXT);
    continue;
  }
  console.log(`ELF: class=${elf.ei_class} (2=64-bit) endian=${elf.ei_data} (1=LE) type=${elf.e_type} ${ET[elf.e_type] ?? '?'} e_machine=${elf.e_machine} ${EM[elf.e_machine] ?? '?'}`);
  console.log(`ELF SECTIONS: ${elf.secs.length}`);
  console.log(`DT_NEEDED (dependency .so): ${elf.needed.length ? JSON.stringify(elf.needed) : '(none)'}`);
  console.log(`DT_SONAME: ${elf.soname.length ? JSON.stringify(elf.soname) : '(none)'}`);
  console.log(`DT_RPATH/RUNPATH: ${elf.runpath.length ? JSON.stringify(elf.runpath) : '(none)'}`);
  console.log(`DYNSYM: total=${elf.syms.length} defined=${elf.defined.length} undefined=${elf.undef.length}`);

  const jniExports = elf.defined.filter((s) => s.name.startsWith('Java_'));
  console.log(`--- EXPORTED Java_* symbols (${jniExports.length}) ---`);
  for (const s of jniExports) console.log(`    ${s.name}   (size=${s.size})`);
  const jniOnLoad = elf.defined.filter((s) => s.name === 'JNI_OnLoad' || s.name === 'JNI_OnUnload');
  console.log(`--- JNI_OnLoad / JNI_OnUnload exported: ${jniOnLoad.length ? jniOnLoad.map((s) => s.name).join(', ') : 'NONE'} ---`);
  const ezExports = elf.defined.filter((s) => /easytier/i.test(s.name));
  console.log(`--- EXPORTED symbols containing "easytier" (${ezExports.length}) ---`);
  for (const s of ezExports.slice(0, 60)) console.log(`    ${s.name}   (size=${s.size})`);
  const ezUndef = elf.undef.filter((s) => /easytier|Java_/i.test(s.name));
  console.log(`--- UNDEFINED symbols matching easytier|Java_ (${ezUndef.length}) ---`);
  for (const s of ezUndef.slice(0, 60)) console.log(`    ${s.name}`);

  const { res, stringCount } = scanAscii(buf, PATTERNS);
  console.log(`--- ASCII STRING SCAN (strings>=4 chars indexed: ${stringCount}) ---`);
  for (const p of PATTERNS) {
    const r = res.get(p);
    const head = r.offsets.slice(0, 6).map((o) => '0x' + o.toString(16)).join(' ');
    console.log(`    ${r.count > 0 ? 'HIT ' : 'MISS'}  ${String(r.count).padStart(5)}x  ${p}${r.count ? '   @ ' + head : ''}`);
  }
  if (process.env.CONTEXT) for (const pat of process.env.CONTEXT.split(',')) dumpContext(buf, pat);
}
