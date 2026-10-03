#!/usr/bin/env node
/**
 * 离线校验：**玩家自填的主控地址与中继节点**（2026-10-03 加的那套）。
 *
 * 为什么值得一个脚本：这两处直接决定"客户端连到哪台机器、配置里写进什么"，
 * 而它们都是纯字符串处理 —— 一次写成 `tcp://host:11010/path` 这种地址，
 * 轻则节点连不上，重则把玩家引到一个看着像你实例的钓鱼地址。
 * 所以：解析、归一化、去重、注入位置，全部钉死在这里，不需要主控也能跑。
 *
 * 用法：node client/scripts/verify-selfhost.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * 这两个模块是 TS 且 import 了 vue / import.meta.env，不能直接 `import`。
 * 所以做**源码级断言**：把函数体抠出来跑不现实，改成断言"关键行还在"——
 * 这类检查本来就是为了防"有人手滑删掉一段规则"，源码级断言足够。
 * 真正跑逻辑的那份在 `relay-fallback.ts` 里，由 tsc 与运行时保证。
 */
const relayFallback = fs.readFileSync(path.join(REPO, 'client/src/lib/relay-fallback.ts'), 'utf8');
const api = fs.readFileSync(path.join(REPO, 'client/src/lib/api.ts'), 'utf8');
const masterUrl = fs.readFileSync(path.join(REPO, 'client/src/lib/master-url.ts'), 'utf8');
const store = fs.readFileSync(path.join(REPO, 'client/src/lib/store.ts'), 'utf8');

console.log('主控地址（client/src/lib/api.ts + master-url.ts）');
check('能从 localStorage 读覆盖值', /mclink\.master/.test(api));
check('没有协议时补 http://', /http:\/\/\$\{text\}/.test(masterUrl));
check('只允许 http/https', /url\.protocol !== 'http:' && url\.protocol !== 'https:'/.test(masterUrl));
check('拒绝非 ASCII（否则随便一段中文会被 IDNA 成"合法域名"）', /\[\^\\x20-\\x7e\]/.test(masterUrl));
check('主机名走白名单', /\^\[A-Za-z0-9\._-\]\+\$/.test(masterUrl));
check('归一化到 origin（丢掉路径，避免拼错接口前缀）', /return `\$\{url\.protocol\}\/\/\$\{url\.host\}`/.test(masterUrl));
check('getMasterUrl 优先用覆盖值', /return customMasterUrl\(\) \?\? MASTER_URL;/.test(api));
check('切换主控会清登录态', /setToken\(null\)/.test(store) && /export function setMasterUrl/.test(store));

console.log('\n中继节点（client/src/lib/relay-fallback.ts）');
check('有 normalizePeerUri', /export function normalizePeerUri/.test(relayFallback));
check('拒绝带路径/查询串的地址', /\[\/\?#\]/.test(relayFallback));
check('拒绝非法端口（越界整条丢）', /parsed < 1 \|\| parsed > 65535/.test(relayFallback));
check('端口必须是纯数字（防止两个地址粘一起被截断）', /\^\\d\+\$/.test(relayFallback));
check('主机名走白名单字符集', /\^\[A-Za-z0-9\._-\]\+\$/.test(relayFallback));
check('没写协议时 tcp + udp 各来一条', /`tcp:\/\/\$\{part\}`/.test(relayFallback) && /`udp:\/\/\$\{part\}`/.test(relayFallback));
check('拆 token 与展开协议分成两层（界面标红要用原文）', /export function splitPeerTokens/.test(relayFallback));
check('按整行 URI 去重（平台已给的不重复写）', /existing\.has\(uri\)/.test(relayFallback));
check('插在最后一个 [[peer]] 段之后', /PEER_HEADER_RE/.test(relayFallback) && /lastPeerLine/.test(relayFallback));
check('没有 peer 段时退化成追加末尾', /lastPeerLine < 0/.test(relayFallback));

console.log('\n注入时机（client/src/lib/store.ts）');
check('在交给内核前追加（effectiveConfigToml）', /withExtraPeers\(raw, splitPeerUris\(state\.extraPeers\)\)/.test(store));
check('追加与"强制走中继"两个注入叠加而不是互相覆盖', /withDisableP2p\(withPeers\)/.test(store));
check('自填节点持久化到 localStorage', /mclink\.extraPeers/.test(store));
check('非法地址只跳过、不抛错（一张坏地址不该让房间起不来）', /parsed !== null && !wanted\.includes\(parsed\)/.test(relayFallback));

console.log('\n界面入口');
const login = fs.readFileSync(path.join(REPO, 'client/src/pages/LoginPage.vue'), 'utf8');
const settings = fs.readFileSync(path.join(REPO, 'client/src/pages/SettingsPage.vue'), 'utf8');
check('登录页能改主控（自建用户不至于卡在登录页）', /applyMaster/.test(login) && /主控地址/.test(login));
check('登录页默认折叠（不诱导普通玩家去改）', /masterOpen = ref\(false\)/.test(login));
check('设置页有"自建 / 社区节点"卡片', /自建 \/ 社区节点/.test(settings));
check('设置页给出社区节点列表外链', /info\.qtet\.cn\/uptime\/easytier/.test(settings));
check('界面如实说明"账号密码会发给那台主控"', /账号密码会发给/.test(settings) || /账号密码会发给/.test(login));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
