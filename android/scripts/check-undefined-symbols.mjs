#!/usr/bin/env node
/**
 * 检查一个 Android 用的 .so 里**有没有留下未定义符号**。
 *
 * ## 为什么需要这个脚本（这是个真机踩出来的坑）
 *
 * 上游 EasyTier v2.6.4 的 JNI crate 只在 `unsafe extern "C"` 里**声明**了 FFI 函数
 * （`set_tun_fd` / `parse_config` / `run_network_instance` / `retain_network_instance` /
 * `collect_network_infos` / `get_error_msg` / `free_string`），却没依赖 `easytier-ffi`。
 * 如果只往 Cargo.toml 里加依赖、而没有任何 Rust 代码用到它，rustc **不会把 rlib 交给链接器**，
 * 于是这些符号在 .so 里保持**未定义**。
 *
 * 关键陷阱：**编译会"成功"**。因为 `-shared`（cdylib）允许未定义符号，链接器不报错；
 * 失败被推迟到装机后的 `dlopen`：
 *
 *     java.lang.UnsatisfiedLinkError: dlopen failed:
 *     cannot locate symbol "collect_network_infos" referenced by ".../libeasytier_android_jni.so"
 *
 * 这个脚本就是那道闸：**未定义符号里只要出现任一 FFI 函数名，就退出码 1**。
 *
 * 用法：
 *   node .cache/check-undefined-symbols.mjs <file.so> [...]
 *
 * 顺带说明：它不检查"其余未定义符号是否都能由 DT_NEEDED 提供" —— 那需要 bionic 的符号表，
 * 本机没有。其余符号会**全量打印**出来供人眼过一遍（正常情况下应该只有 libc/liblog/libdl 的东西）。
 */
import fs from 'node:fs';

/** 上游 FFI 库导出、JNI 库会引用的 C 函数名（v2.6.4 + main 的交集，宁可多列） */
const FFI_NAMES = new Set([
  'set_tun_fd',
  'get_error_msg',
  'free_string',
  'parse_config',
  'run_network_instance',
  'retain_network_instance',
  'delete_network_instance',
  'collect_network_infos',
  'list_instance',
  'list_instances',
  'call_json_rpc',
  'start_config_server_client',
  'stop_config_server_client',
  'is_config_server_client_connected',
]);

function parseElf(buf) {
  if (buf.readUInt32LE(0) !== 0x464c457f) throw new Error('不是 ELF 文件');
  if (buf[4] !== 2) throw new Error('只支持 64 位 ELF');
  const eShoff = Number(buf.readBigUInt64LE(0x28));
  const eShentsize = buf.readUInt16LE(0x3a);
  const eShnum = buf.readUInt16LE(0x3c);

  const sections = [];
  for (let i = 0; i < eShnum; i += 1) {
    const off = eShoff + i * eShentsize;
    sections.push({
      name: buf.readUInt32LE(off),
      type: buf.readUInt32LE(off + 4),
      offset: Number(buf.readBigUInt64LE(off + 0x18)),
      size: Number(buf.readBigUInt64LE(off + 0x20)),
      link: buf.readUInt32LE(off + 0x28),
      entsize: Number(buf.readBigUInt64LE(off + 0x38)),
    });
  }
  const dynsym = sections.find((s) => s.type === 11); // SHT_DYNSYM
  if (!dynsym) throw new Error('没有 .dynsym');
  const strtab = sections[dynsym.link];
  const cstr = (at) => {
    let end = at;
    while (end < buf.length && buf[end] !== 0) end += 1;
    return buf.toString('utf8', at, end);
  };

  const defined = [];
  const undefinedNames = [];
  const count = Math.floor(dynsym.size / (dynsym.entsize || 24));
  for (let i = 0; i < count; i += 1) {
    const off = dynsym.offset + i * (dynsym.entsize || 24);
    const stName = buf.readUInt32LE(off);
    const stShndx = buf.readUInt16LE(off + 6);
    if (stName === 0) continue;
    const name = cstr(strtab.offset + stName);
    if (!name) continue;
    if (stShndx === 0) undefinedNames.push(name);
    else defined.push(name);
  }
  return { defined, undefined: undefinedNames };
}

let failed = false;
for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const { defined, undefined: undef } = parseElf(buf);
  const offenders = undef.filter((n) => FFI_NAMES.has(n));

  console.log('='.repeat(84));
  console.log('FILE: ' + file);
  console.log('BYTES: ' + buf.length);
  console.log('DYNSYM: defined=' + defined.length + ' undefined=' + undef.length);
  console.log('EXPORTED Java_* : ' + defined.filter((n) => n.startsWith('Java_')).length);
  console.log('');
  console.log('未定义的 FFI 符号（必须为空）: ' + (offenders.length === 0 ? '(空) ✓' : offenders.join(', ')));
  console.log('');
  console.log('全部未定义符号（人眼过一遍，应只有 libc/liblog/libdl 的东西）:');
  for (const n of undef.slice().sort()) console.log('  ' + n);

  if (offenders.length > 0) {
    console.error('');
    console.error('✗ ' + file);
    console.error('  这些符号没有静态链接进来：' + offenders.join(', '));
    console.error('  后果：装机后 dlopen 抛 UnsatisfiedLinkError（编译期不会报错）。');
    console.error('  修法：在 easytier-android-jni/src/lib.rs 顶部加 `extern crate easytier_ffi;`');
    console.error('        （只把依赖写进 Cargo.toml 不够 —— 未被使用的依赖会被 rustc 丢掉）。');
    failed = true;
  } else {
    console.log('');
    console.log('✓ ' + file + ' 没有残留的 FFI 未定义符号');
  }
}

process.exit(failed ? 1 : 0);
