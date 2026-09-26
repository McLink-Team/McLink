/**
 * 从票据的 EasyTier TOML 算出「本机虚拟地址 + 要加的路由 + MTU」。
 *
 * ## 为什么这一段在 TypeScript 里，而不是在 Kotlin 里
 *
 * 它是整条 Android 联机链上**唯一"算错就整机断网"**的逻辑：`VpnService` 一旦带着
 * 空路由或 `0.0.0.0/0` 建起来，系统会把手机的全部流量导向一个只在虚拟局域网里存在的
 * 隧道 —— 玩家看到的是"手机突然没网了"（FCL 线上事故 #1429，见
 * `docs/android-milestone2-easytier.md` §1.7）。
 *
 * 放在这里能用 Node 单元测试盖住（含**真实票据**，见 `android/scripts/verify-vpn-plan.mjs`），
 * 而 Kotlin 那侧没有测试运行环境。Kotlin 仍然独立校验一遍 §4 的硬规则，不盲信入参。
 *
 * ## 纯函数
 *
 * 不碰 `window`、不碰网络、不碰时间 —— 同样的输入永远给同样的输出，
 * 于是"这个 TOML 会被算成什么"可以在测试里一条一条钉死。
 *
 * ## 为什么能读 `@mclink/shared`，却不能读 `client/src`
 *
 * 这是**移动端外壳自己的模块**（与 `mobile-bridge.ts` 同一层），不是渲染层页面的一部分。
 * `client/src` 是"复用来的 UI"，它随时可能为桌面端的需要而改动；把"路由怎么算"挂在它下面，
 * 等于让桌面端一次无害的重构有机会改掉本机的网络行为。
 * `@mclink/shared` 则是两端共用的**纯数据与纯函数**（`VNET_BASE_PREFIX` 就是虚拟网段的唯一
 * 事实来源），用它恰恰是为了不出现第二份 `10.200` 字面量。
 *
 * 生成器在 `server/src/easytier/config.ts` 的 `renderEasytierToml()`，它写出的是：
 *
 * ```toml
 * # 由 mclink 主控自动生成，请勿手工编辑 —— 下次同步会被覆盖
 * instance_name = "mclink-k7qm2p"
 * hostname = "我的手机"
 * ipv4 = "10.200.7.3/24"
 * listeners = ["tcp://0.0.0.0:23456", "udp://0.0.0.0:23456"]
 *
 * [network_identity]
 * network_name = "…"
 * network_secret = "…"
 *
 * [flags]
 * enable_encryption = true
 * mtu = 1380
 * ```
 *
 * 也就是**双引号包裹的字符串**、`=` 两侧各一个空格。解析器对此宽容（空格、单双引号、
 * 行尾注释都吃），但**不认识就拒绝** —— 见下面的拒绝规则。
 *
 * ## 拒绝规则（宁可连不上，不可整机断网）
 *
 * 下面每一条都返回 `code: 'no-routes'`，调用方据此**不启动插件**：
 *
 * | 情况 | 为什么 |
 * | --- | --- |
 * | TOML 里没有 `ipv4` / 值是空串 / 不是 `地址/前缀` | 不知道房间网段，猜一个就是拿玩家的流量做实验 |
 * | 前缀 < 8 | `0.0.0.0/0` 走的就是这条路；`/1`、`/2` 之类同样等于接管整机 |
 * | 前缀 > 24 | 房间是 /24；`/25`–`/32` 说明读到的不是房间地址，按它建隧道没有意义 |
 * | 网段不在 `10.200.0.0/16` 里 | 只允许路由我们自己的房间网段（`VNET_BASE_PREFIX`） |
 * | 算完路由为空 | §4 第 1 条：空路由的 VPN 按默认路由接管整机流量 |
 *
 * **`instance_name` 只解析、不校验**：它不参与"会不会断网"的决策，
 * 一条票据里的实例名再怪也只是让内核启动失败，而那是能看得到的失败。
 */

import { VNET_BASE_PREFIX } from '@mclink/shared';

/* --------------------------------------------------------------- 对外形状 */

/** 一个 `地址 + 前缀长度`。与插件接口（`docs/android-vpn.md` §3）逐字一致 */
export interface VpnCidr {
  ip: string;
  prefix: number;
}

/** 一份可以直接交给 `MclinkVpn.start()` 的启动计划 */
export interface VpnPlan {
  /** 实例名（EasyTier 的 `instance_name`，`setTunFd` 要用它认实例） */
  instanceName: string;
  /** 本机虚拟地址，来自 TOML 的 `ipv4` */
  address: VpnCidr;
  /**
   * 要加进 `VpnService` 的路由，**只含房间网段**。
   *
   * 结构上恒为 1 条（房间独占一个 /24），但它是个数组：插件接口就是这么定义的，
   * 而"空数组 = 拒绝启动"这条硬规则要能在类型上表达出来。
   */
  routes: VpnCidr[];
  /** 要与 `Builder.setMtu()` 一致的 MTU */
  mtu: number;
}

/** 目前只有一种拒绝原因：算不出可用的房间网段 */
export type VpnPlanFailureCode = 'no-routes';

/**
 * 结果用**可辨识联合**，不是 `null` + 抛异常。
 *
 * 调用方（`mobile-bridge.ts`）必须把失败变成一句给玩家看的中文，
 * 而不是让异常冒到房间页 —— 在手机上没有 devtools，一个未捕获的异常
 * 就是"点了没反应"。联合类型逼着调用方在编译期把失败分支写出来。
 */
export type VpnPlanResult =
  | { ok: true; plan: VpnPlan }
  | { ok: false; code: VpnPlanFailureCode; message: string };

/* --------------------------------------------------------------- 常量 */

/**
 * 房间网段的固定前缀长度。
 *
 * 与 `packages/shared/src/virtualnet.ts` 的规划一致（每个房间一个 /24），
 * 也是 `subnetForSlot()` 给出的形状。**不跟着 `ipv4` 里的前缀走**：
 * 票据里写的是成员地址的 /24，但万一哪天主控下发的是 `/32` 主机路由，
 * 我们要的仍然是整个房间网段，而不是只路由自己那一个地址。
 */
export const ROOM_ROUTE_PREFIX = 24;

/**
 * 可接受的最小前缀。
 *
 * §4 第 2 条：`0.0.0.0/0` 永远不许出现。用 `< 8` 而不是 `=== 0` 是刻意的 ——
 * `/1` 到 `/7` 与 `/0` 在效果上没有区别（都覆盖了本机绝大部分地址空间），
 * 而它们同样不可能来自我们的生成器。
 */
export const MIN_ACCEPTED_PREFIX = 8;

/**
 * 可接受的最大前缀（§4 第 2 条）。
 *
 * 上界和最小前缀一样是**安全属性**，不是洁癖：房间网段是 /24，一条 `/32` 的"地址"
 * 只覆盖它自己那一个 IP —— 那说明我们读到的根本不是房间地址；`/25`–`/31` 这类
 * 比房间更窄的写法同样与"每房间一个 /24"的规划不符。遇到它们正确的动作是拒绝，
 * 而不是照单收下再让原生侧去拒。
 *
 * 这个上界**必须与 `MclinkVpnService.Payload#problem()` 一致**：一侧放行、另一侧拒绝的话，
 * 玩家拿到的是一句没头没尾的"网络前缀不合法"，而正确答案本来是"重新拉一次票据"。
 */
export const MAX_ACCEPTED_PREFIX = 24;

/**
 * 票据里没有可用的 `mtu` 时用的值。
 *
 * 1380 是 EasyTier 自己的默认 MTU，也是主控 `rooms.ts` 硬编码进票据的值
 * （§4 第 6 条：VpnService 的 MTU 必须与 EasyTier 的一致）。MTU 取错只会让大包被丢，
 * 不会像路由那样把整机流量带走，所以这里**回落**而不是拒绝 —— 拒绝掉一个
 * 本来能连的房间，代价更大。
 *
 * 取值范围（576–1500）与 Kotlin 侧 `MclinkVpnService.Payload#problem()` 的校验一致：
 * 两边区间不同的话，TS 放行、Kotlin 拒绝，玩家会看到一句"网络前缀/MTU 不合法"的
 * 内部错误，而正确的兜底动作本来只是回落到默认值。
 */
export const DEFAULT_MTU = 1380;

/** 可接受的 MTU 区间：低于 576 违背 IPv4 主机要求，高于 1500 不是 VpnService 能给的链路 */
const MTU_MIN = 576;
const MTU_MAX = 1500;

/* --------------------------------------------------------------- TOML 取值 */

/**
 * 去掉行尾注释，**但不动字符串里的 `#`**。
 *
 * 为什么不能简单地 `line.split('#')[0]`：`network_secret` 是我们自己生成的随机串，
 * 里面完全可能有 `#`。切错了就会把一行配置截断成半个值 —— 而这类解析错误
 * 最难发现，因为它只在"随机串里恰好出现 #"的那次票据上发作。
 */
function stripTrailingComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (quote === '"' && ch === '\\') i += 1; // 跳过转义的下一个字符
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * 去掉包裹的引号（单双都吃），并还原 TOML 基本字符串里的转义。
 *
 * 不带引号的裸值原样返回：我们生成器永远写双引号，但"宽容"在这里几乎没有成本，
 * 而一个手改过的票据不该让玩家看到"算不出网段"。
 */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length < 2) return v;
  const first = v[0];
  const last = v[v.length - 1];
  if (first !== last || (first !== '"' && first !== "'")) return v;
  const inner = v.slice(1, -1);
  // 单引号是 TOML 的「字面字符串」，里面没有转义；双引号才需要还原
  return first === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
}

/** `[flags]` / `[[peer]]` → `flags` / `peer`；空行与注释返回 `null` */
function sectionNameOf(line: string): string | null {
  if (!line.startsWith('[')) return null;
  return line.replace(/^\[+/, '').replace(/\]+$/, '').trim();
}

interface TomlScalars {
  ipv4: string | null;
  mtu: string | null;
  instanceName: string | null;
}

/**
 * 只挑我们关心的三个键，其余一律不看。
 *
 * **只认顶层与 `[flags]` 里的键**（生成器把 `ipv4` 写在顶层、`mtu` 写在 `[flags]`）。
 * 为什么要按 section 过滤：`[network_identity]`、`[file_logger]`、`[[peer]]` 里
 * 将来完全可能出现同名的键，而后者的语义与"本机地址"无关。宁可在这里漏读（→ 拒绝），
 * 也不要在别的 section 里误读一个地址出来（→ 拿它当路由）。
 */
function scanScalars(toml: string): TomlScalars {
  const found: TomlScalars = { ipv4: null, mtu: null, instanceName: null };
  let section = '';

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = stripTrailingComment(rawLine).trim();
    if (line === '') continue;

    const sectionName = sectionNameOf(line);
    if (sectionName !== null) {
      section = sectionName;
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1));

    // 同一个键出现两次时**留第一条**：生成器不会写重复键，
    // 真出现了也说明这份 TOML 被动过，取第一条与 EasyTier 自己的行为一致。
    if (key === 'ipv4' && section === '' && found.ipv4 === null) found.ipv4 = value;
    else if (key === 'mtu' && (section === '' || section === 'flags') && found.mtu === null) found.mtu = value;
    else if (key === 'instance_name' && section === '' && found.instanceName === null) found.instanceName = value;
  }

  return found;
}

/* --------------------------------------------------------------- 地址运算 */

/**
 * 解析 `10.200.7.3/24`。
 *
 * 前缀**必填**：缺了前缀就无法知道这个地址代表多大的范围，而"默认按 /24 算"
 * 正是那种"猜一个网段出来"的做法 —— 契约明令禁止。真遇到没有前缀的 `ipv4`，
 * 正确的动作是拒绝并让人去看票据为什么变了。
 */
const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*\/\s*(\d{1,2})$/;

function parseIpv4Cidr(value: string): VpnCidr | null {
  const m = IPV4_CIDR_RE.exec(value.trim());
  if (!m) return null;
  const octets = [m[1]!, m[2]!, m[3]!, m[4]!].map((s) => Number(s));
  // `\d{1,3}` 会放过 999：范围必须自己判
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const prefix = Number(m[5]!);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  // 归一化：`10.200.007.3` → `10.200.7.3`（交给原生侧的值不带前导零）
  return { ip: octets.join('.'), prefix };
}

/** 某个地址所在 /24 的**网络地址**：`10.200.7.3` → `10.200.7.0/24` */
function networkAddress24(ip: string): VpnCidr {
  const parts = ip.split('.');
  return { ip: `${parts[0]}.${parts[1]}.${parts[2]}.0`, prefix: ROOM_ROUTE_PREFIX };
}

/** MTU 取值：能安全用就用票据里的，否则回落到 EasyTier 的默认值 */
function resolveMtu(raw: string | null): number {
  if (raw === null) return DEFAULT_MTU;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < MTU_MIN || n > MTU_MAX) return DEFAULT_MTU;
  return n;
}

/* --------------------------------------------------------------- 入口 */

function reject(message: string): VpnPlanResult {
  return { ok: false, code: 'no-routes', message };
}

/**
 * 从票据 TOML 算出一份启动计划。
 *
 * `message` 是**给开发者看的诊断**（说明是哪条规则拒的），不是给玩家的文案 ——
 * §3 明确要求不要把内部 code / 原始报错直接显示给玩家，玩家那句由
 * `mobile-bridge.ts` 按 code 表生成。
 */
export function plan(input: { configToml: string; instanceName: string }): VpnPlanResult {
  const configToml = typeof input?.configToml === 'string' ? input.configToml : '';
  const fallbackInstanceName = typeof input?.instanceName === 'string' ? input.instanceName.trim() : '';

  const scalars = scanScalars(configToml);

  if (scalars.ipv4 === null) {
    return reject('票据里没有顶层的 ipv4 字段，算不出房间网段');
  }
  if (scalars.ipv4.trim() === '') {
    return reject('票据里的 ipv4 是空值，算不出房间网段');
  }

  const address = parseIpv4Cidr(scalars.ipv4);
  if (address === null) {
    return reject(`票据里的 ipv4 不是「地址/前缀」的形式：${JSON.stringify(scalars.ipv4.slice(0, 64))}`);
  }

  if (address.prefix < MIN_ACCEPTED_PREFIX) {
    return reject(
      `ipv4 的前缀 /${address.prefix} 小于允许的最小值 /${MIN_ACCEPTED_PREFIX}；` +
        `这一档的路由会接管整机流量（0.0.0.0/0 就属于这一类）`,
    );
  }
  if (address.prefix > MAX_ACCEPTED_PREFIX) {
    return reject(
      `ipv4 的前缀 /${address.prefix} 大于允许的最大值 /${MAX_ACCEPTED_PREFIX}；` +
        `房间网段是 /${ROOM_ROUTE_PREFIX}，比它还窄的地址说明这不是房间地址`,
    );
  }

  const route = networkAddress24(address.ip);
  const [a, b] = route.ip.split('.');
  if (`${a}.${b}` !== VNET_BASE_PREFIX) {
    return reject(`算出的网段 ${route.ip}/${ROOM_ROUTE_PREFIX} 不在 ${VNET_BASE_PREFIX}.0.0/16 内，只允许路由房间网段`);
  }

  const routes: VpnCidr[] = [route];
  /*
   * §4 第 1 条：路由为空就不许 establish（空路由的 VPN 按默认路由接管整机流量）。
   * 走到这里的 routes 恒为 1 条 —— 这条检查是让该规则成为**本函数自己的性质**，
   * 而不是"调用方要记得的事"。调用方（mobile-bridge）还会再判一次。
   */
  if (routes.length === 0) {
    return reject('算不出任何房间网段；空路由的虚拟网卡会接管整机流量，拒绝启动');
  }
  /*
   * §4 第 2 条对**路由前缀**同样有上下界（8 ≤ prefix ≤ 24）。
   * 我们只会产出 /24，也就是天然落在区间里 —— 这条检查是**契约要求的显式保证**：
   * 哪天有人把 ROOM_ROUTE_PREFIX 改小了，这里会当场拒绝，而不是把一个越界网段交给原生侧。
   */
  const badRoute = routes.find((x) => x.prefix < MIN_ACCEPTED_PREFIX || x.prefix > MAX_ACCEPTED_PREFIX);
  if (badRoute) {
    return reject(
      `算出的路由 ${badRoute.ip}/${badRoute.prefix} 的前缀不在 ${MIN_ACCEPTED_PREFIX}–${MAX_ACCEPTED_PREFIX} 之间，拒绝启动`,
    );
  }

  return {
    ok: true,
    plan: {
      /*
       * 实例名以 **TOML 里的 `instance_name` 为准**：Kotlin 侧是拿它去
       * `runNetworkInstance(toml)` / `setTunFd(instanceName, fd)` 的，内核真正注册的名字
       * 只可能来自 TOML；入参只是 TOML 里漏了这个键时的兜底（生成器永远会写它）。
       */
      instanceName: scalars.instanceName?.trim() || fallbackInstanceName,
      address,
      routes,
      mtu: resolveMtu(scalars.mtu),
    },
  };
}
