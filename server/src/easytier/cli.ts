/**
 * easytier-cli 封装。
 *
 * 为什么用 CLI 而不是直接对接 gRPC：
 *  - CLI 支持 `-o json`，输出结构化数据，字段稳定；
 *  - 不必内嵌 .proto 并维护 gRPC 客户端与 EasyTier 的握手/鉴权细节；
 *  - 出问题时能直接把命令打印出来给运维复现（可观测性更好）。
 *
 * 代价是每次调用要 fork 一个约 10MB 的进程，所以统计轮询保持在 5s 级，
 * 不做高频调用。
 */
import { spawn } from 'node:child_process';
import { logger } from '../logger.ts';
import { HttpError } from '../util/errors.ts';

const log = logger('easytier-cli');

export interface CliRunOptions {
  cliBin: string;
  /** RPC portal 地址，如 127.0.0.1:15888 */
  rpcPortal: string;
  args: string[];
  timeoutMs?: number;
  /** 多实例节点可用 --instance-id / --instance-name 指定目标实例 */
  instanceName?: string;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

/**
 * Windows 下 easytier-cli 会按系统区域设置输出 GBK 中文（例如错误信息），
 * 直接按 UTF-8 解码会得到乱码。这里先试 UTF-8，出现替换字符再退化为 GBK。
 */
export function decodeSmart(buf: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(buf);
  } catch {
    return utf8;
  }
}

export async function runCli(options: CliRunOptions): Promise<CliResult> {
  const { cliBin, rpcPortal, args, timeoutMs = 10_000, instanceName } = options;
  const fullArgs = ['-p', rpcPortal, '-o', 'json'];
  if (instanceName) fullArgs.push('-n', instanceName);
  fullArgs.push(...args);

  const command = `${cliBin} ${fullArgs.join(' ')}`;
  log.debug('执行', { command });

  return new Promise<CliResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(cliBin, fullArgs, { windowsHide: true });
    } catch (err) {
      reject(HttpError.unavailable(`无法启动 easytier-cli: ${(err as Error).message}`));
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(HttpError.unavailable(`easytier-cli 超时（${timeoutMs}ms）: ${command}`));
    }, timeoutMs);

    child.stdout?.on('data', (c: Buffer) => outChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(HttpError.unavailable(`easytier-cli 执行失败: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: decodeSmart(Buffer.concat(outChunks)),
        stderr: decodeSmart(Buffer.concat(errChunks)),
        command,
      });
    });
  });
}

/** 运行并解析 JSON 输出；失败时抛出带命令上下文的 HttpError */
export async function cliJson<T>(options: CliRunOptions): Promise<T> {
  const result = await runCli(options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 500);
    throw HttpError.unavailable(`easytier-cli 返回非零退出码 ${result.code}: ${detail}`);
  }
  const text = result.stdout.trim();
  if (text.length === 0) {
    throw HttpError.unavailable(`easytier-cli 无输出: ${result.command}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // 有些子命令在 JSON 模式下仍会先打一行人类可读的提示，尝试取最后一个 JSON 块
    const start = text.search(/[[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start)) as T;
      } catch {
        /* 落到统一的报错 */
      }
    }
    throw HttpError.unavailable(`easytier-cli 输出无法解析为 JSON: ${text.slice(0, 300)}`);
  }
}

/** 探测 CLI 是否可用及其版本 */
export async function probeCli(cliBin: string): Promise<{ ok: boolean; version: string | null; error: string | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cliBin, ['--version'], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, version: null, error: (err as Error).message });
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    child.stderr?.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (err) => resolve({ ok: false, version: null, error: err.message }));
    child.on('close', (code) => {
      const text = decodeSmart(Buffer.concat(chunks)).trim();
      if (code === 0) resolve({ ok: true, version: text || null, error: null });
      else resolve({ ok: false, version: null, error: text || `退出码 ${code}` });
    });
  });
}
