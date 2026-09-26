/** 零依赖的输入校验helper：服务端与客户端共用，保证前后端规则一致 */

export class ValidationError extends Error {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(`参数校验失败: ${Object.keys(fields).join(', ')}`);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export interface FieldRule {
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  patternMessage?: string;
  oneOf?: readonly string[];
  label?: string;
}

export type Schema = Record<string, FieldRule>;

export type Validated<T extends Schema> = {
  [K in keyof T]?: string;
};

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
export const ROOM_NAME_MAX = 32;
export const DEVICE_NAME_MAX = 32;

/**
 * 邮箱校验。
 *
 * 刻意不做"完全符合 RFC 5322"的解析——那种正则出了名地长且仍然会放过一堆东西，
 * 而真正的判定标准是"验证码能不能寄到"。这里只挡明显不是邮箱的输入：
 * 必须有且只有一个 @、本地部分与域名都非空、域名至少有一个点且顶级域是纯字母。
 * 最长 120 字符（与 users.email 的截断长度一致）。
 */
export const EMAIL_MAX = 120;
export const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)*\.[a-zA-Z]{2,24}$/;

export function emailProblem(value: string): string | null {
  const email = value.trim();
  if (email.length === 0) return '邮箱不能为空';
  if (email.length > EMAIL_MAX) return `邮箱不能超过 ${EMAIL_MAX} 个字符`;
  if (!EMAIL_PATTERN.test(email)) return '邮箱格式不正确';
  return null;
}

/** 验证码：6 位数字，允许用户带空格输入 */
export const EMAIL_CODE_PATTERN = /^\d{6}$/;

export function normalizeEmailCode(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * 校验一个纯字符串字段字典（来自 JSON body 或 query）。
 * 返回值只包含通过校验的键；数值用 `coerceInt` 另外转换。
 */
export function validate(body: Record<string, unknown>, schema: Schema): Record<string, string> {
  const out: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const [key, rule] of Object.entries(schema)) {
    const label = rule.label ?? key;
    const raw = body[key];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (rule.required) errors[key] = `${label}不能为空`;
      continue;
    }
    if (typeof raw !== 'string') {
      errors[key] = `${label}必须是字符串`;
      continue;
    }
    const value = raw.trim();
    if (value.length === 0) {
      if (rule.required) errors[key] = `${label}不能为空`;
      continue;
    }
    if (rule.min !== undefined && value.length < rule.min) {
      errors[key] = `${label}至少 ${rule.min} 个字符`;
      continue;
    }
    if (rule.max !== undefined && value.length > rule.max) {
      errors[key] = `${label}最多 ${rule.max} 个字符`;
      continue;
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      errors[key] = rule.patternMessage ?? `${label}格式不正确`;
      continue;
    }
    if (rule.oneOf && !rule.oneOf.includes(value)) {
      errors[key] = `${label}必须是以下之一: ${rule.oneOf.join(', ')}`;
      continue;
    }
    out[key] = value;
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return out;
}

/** 宽松取整：非法/缺省返回 fallback */
export function coerceInt(value: unknown, fallback: number, min?: number, max?: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  let out = Number.isFinite(n) ? Math.trunc(n) : fallback;
  if (min !== undefined) out = Math.max(min, out);
  if (max !== undefined) out = Math.min(max, out);
  return out;
}

export function coerceBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/** 密码强度：至少 8 位，且不能是纯数字/纯字母 */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return '密码至少 8 位';
  if (pw.length > 128) return '密码最多 128 位';
  if (!/[a-zA-Z]/.test(pw)) return '密码需包含字母';
  if (!/\d/.test(pw)) return '密码需包含数字';
  return null;
}

/** 生成人类可读的加入码，去掉容易混淆的 0/O/1/I */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateRoomCode(random: (n: number) => Uint8Array): string {
  const bytes = random(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * 生成 EasyTier 网络密钥。
 * 用 URL 安全字符集，避免配置在 TOML/命令行/URL 中出现转义问题。
 */
export function generateNetworkSecret(random: (n: number) => Uint8Array, length = 32): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const bytes = random(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}

export function isValidIpv4(ip: string): boolean {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isValidHostPort(value: string): boolean {
  const m = /^([a-zA-Z0-9._-]+):(\d{1,5})$/.exec(value.trim());
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535;
}

/** 手填用户名名单的长度上限：一次定向公告足够用，也防呆（防粘贴一整张表） */
export const BROADCAST_USERNAME_MAX = 200;

/**
 * 解析管理员手填的用户名名单。
 *
 * 允许逗号、顿号、分号、空白、换行混合分隔 —— 从表格或聊天记录里粘过来就是这样。
 * 大小写不敏感去重（用户名本身是唯一的，但人写的时候大小写随便）。
 * **不在这里校验存在性**：那要查库才知道，由调用方回传"没找到的名字"让人自己核对。
 */
export function parseUsernameList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,，、;；]+/)) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= BROADCAST_USERNAME_MAX) break;
  }
  return out;
}

/* ------------------------------------------------------- 显示名（昵称） */

/**
 * 运营可填的屏蔽词表（默认空 = 不拦）。
 *
 * **交给运营填，代码不预设内容判断。** 违法/不当词这类判断会随时间和地区变，
 * 写死在代码里等于每个版本都要发一次版；留空表 + 一处配置，运营自己维护。
 *
 * 填法：往数组里加词就行，**不需要改任何代码** —— `displayNameProblem` 对这张表和
 * 内置保留词一视同仁，都要过同一条归一化管线（NFKC、去零宽、去分隔符、同形字与数字替形折叠），
 * 所以填 `某 词`、`ＭｃＬｉｎｋ` 这种写法一样能命中。
 *
 * ⚠️ 匹配语义是**出现即拦**（不当词出现在昵称任何位置都要拦），别填太短的词：
 * 填 `art` 会连 `Martha` 一起拦下来。
 */
export const BLOCKED_WORDS: readonly string[] = [];

/** 保留词命中后返回给用户的文案：要写清"为什么"和"怎么办"，会被直接显示在输入框下面 */
const REASON_OFFICIAL = '这个名字不能使用：与官方身份相近，请换一个';
const REASON_PLACEHOLDER = '这个名字不能使用：看起来像匿名或占位名称，请换一个';
const REASON_BLOCKED = '这个名字不能使用：包含平台不接受的词语，请换一个';
const REASON_TAKEN = '这个名字已被占用（含相似字符也不行），请换一个';
const REASON_UNREADABLE = '这个名字不能使用：请不要只用符号或不可见字符';

/**
 * 零宽/控制字符。
 *
 * 这一类是**最省事的绕过手法**：`Mc<U+200B>Link` 在屏幕上和 `McLink` 一模一样，
 * 但字符串比对是两个不同的值 —— 只按字面查词表的话，插一个不可见字符就混过去了。
 * 顺带把 BOM、软连字符、变体选择符、双向控制符也去掉（同理，它们都不占位、看不见）。
 */
const INVISIBLE_RE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u2028-\u202F\u205F-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB]/g;

/**
 * 分隔符：空白、下划线、连字符、点、竖线、括号、引号、逗号……
 *
 * `管 理 员`、`Mc_Link`、`Mc·Link` 都是同一个意思，去掉之后才是可比较的骨架。
 * 标点（`@` `$` `!` `|` `+`）也在这里被去掉 —— 它们在中文社区里更常当装饰用
 * （`@夜航星` 这种前缀很常见），当字母处理会让"加个前缀冒充别人"反而漏掉。
 * 它们的替形含义留给下面 `foldLookalikes` 那一层去找补（只用于跟保留词比对）。
 */
const SEPARATOR_RE =
  /[\s_\-–—―−.。·•・*＊|｜/\\、,，;；:：!！?？"'“”‘’`´()（）[\]【】{}｛｝<>《》«»~～^+=&@#$%…]/g;

/**
 * 同形字（homoglyph）表：西里尔/希腊字母里"长得和拉丁字母一模一样"的那批 → 拉丁字母。
 *
 * 为什么必须有这一层：`МсLink` 的头一个字符是西里尔 М（U+041C）而不是拉丁 M，
 * `с` 是西里尔 с（U+0441）而不是拉丁 c —— 屏幕上完全看不出区别，
 * 而 `toLowerCase()` 之后仍是两个不同的字符串。冒充者只要敲一个西里尔字母就能绕过词表。
 *
 * 一律用小写做键（映射前已经 `toLowerCase()`）；用 \u 转义写，免得源码里再混进
 * 一个肉眼分不清的"看着像拉丁字母的西里尔字母"——这张表本身就是跟这种字符打交道的。
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // 西里尔
  '\u0430': 'a', // а
  '\u0432': 'b', // в
  '\u0433': 'r', // г（形近 r）
  '\u0435': 'e', // е
  '\u043c': 'm', // м
  '\u043d': 'h', // н（形近 h）
  '\u043e': 'o', // о
  '\u0440': 'p', // р
  '\u0441': 'c', // с
  '\u0442': 't', // т
  '\u0443': 'y', // у
  '\u0445': 'x', // х
  '\u0448': 'w', // ш（形近 w）
  '\u044a': 'b', // ъ
  '\u044c': 'b', // ь
  '\u044d': 'e', // э
  '\u044f': 'r', // я（形近倒过来的 R）
  '\u0451': 'e', // ё
  '\u0455': 's', // ѕ
  '\u0456': 'i', // і
  '\u0457': 'i', // ї
  '\u0458': 'j', // ј
  '\u0461': 'w', // ѡ
  '\u04bb': 'h', // һ
  '\u04cf': 'l', // ӏ
  '\u0501': 'd', // ԁ
  '\u051b': 'q', // ԛ
  // 希腊
  '\u03b1': 'a', // α
  '\u03b2': 'b', // β
  '\u03b3': 'y', // γ
  '\u03b5': 'e', // ε
  '\u03b7': 'n', // η
  '\u03b9': 'i', // ι
  '\u03ba': 'k', // κ
  '\u03bc': 'u', // μ（形近 u）
  '\u03bd': 'v', // ν（形近 v）
  '\u03bf': 'o', // ο
  '\u03c1': 'p', // ρ
  '\u03c2': 's', // ς
  '\u03c3': 'o', // σ
  '\u03c4': 't', // τ
  '\u03c5': 'u', // υ
  '\u03c7': 'x', // χ
  '\u03c9': 'w', // ω
};

/**
 * 数字/标点的常见替形。
 *
 * ⚠️ **这一层只用于"跟保留词比对"，不参与身份（重名）比对，更不改动用户实际保存的原文。**
 * 理由：折叠是有损的 —— `Player_01` 会折成 `playerol`，跟 `Player_ol` 撞在一起，
 * 拿它判重名会把两个不同的人判成同一个；拿它改用户输入则等于替用户改名。
 * 只用来查词表（`4dm1n` → `admin`）就没有这个问题。
 *
 * `1` 和 `|` 同时像 `i` 和 `l`，一个目标字母盖不住，所以给两个候选，
 * 折叠时按 variant 取其中一个（生成两份骨架，见 `reservedForms`）。
 */
const LOOKALIKE_RE = /[0-9@$!|+]/g;
const LOOKALIKE_SETS: Readonly<Record<string, readonly string[]>> = {
  '0': ['o'],
  '1': ['i', 'l'],
  '2': ['z'],
  '3': ['e'],
  '4': ['a'],
  '5': ['s'],
  '6': ['b'],
  '7': ['t'],
  '8': ['b'],
  '9': ['g'],
  '@': ['a'],
  $: ['s'],
  '!': ['i'],
  '|': ['i', 'l'],
  '+': ['t'],
};

/**
 * 1) 冒充官方：**整个昵称就是它（或它 + 编号）**时拒绝。
 *
 * 依据：这些词在界面里代表平台本身或平台职务（管理员/客服/主控/中继……）。
 * 玩家拿它们当昵称没有正当用途，而名册、聊天、系统消息里看到这个名字的人会真当成官方。
 * 简繁都列（NFKC 不折叠繁简，只列简体等于漏一半）。
 * 英文词一律只做**整名**匹配：`badminton` 里就含 `admin`、`modern` 含 `mod`、
 * `Gmail` 含 `gm`，对这些短词做包含匹配会大面积误伤正常昵称。
 */
const OFFICIAL_EXACT_WORDS: readonly string[] = [
  // 平台自指
  '官网',
  '官方网站',
  '官方',
  '官方客服',
  '官方团队',
  '平台',
  '平台方',
  '平台官方',
  // 职务/身份
  '管理',
  '管理员',
  '管理員',
  '超级管理员',
  '超级管理員',
  '超管',
  '版主',
  '客服',
  '系统',
  '系統',
  '系统管理员',
  '系統管理員',
  '主控',
  '主控端',
  '中继',
  '中繼',
  '子节点',
  '子節點',
  '运维',
  '運維',
  '网管',
  // 英文与缩写（Minecraft 圈里 op/gm/mod 就是"管理员"，叫这个等于自封）
  'admin',
  'adm',
  'administrator',
  'sysadmin',
  'superadmin',
  'root',
  'operator',
  'op',
  'gm',
  'mod',
  'moderator',
  'support',
  'service',
  'system',
  'official',
  'staff',
  'webmaster',
];

/**
 * 2) 冒充官方：昵称里**任何位置**出现品牌名都拒绝。
 *
 * 只有品牌名享受"出现即拦"：拼接式冒充（`McLink官方客服`、`McLink客服01`）是最常见的一种，
 * 而 "McLink" 这串字符在正常昵称里没有出现的理由。
 *
 * 中文身份词**刻意不做包含匹配**：那会把主控自建的初始管理员昵称「平台管理员」一起判死 ——
 * 那是既有数据（本功能明确不追溯），而且那样连管理员自己都改不回去。
 * 别人想用这个名字还有重名检查挡着（它属于现存的账号）。
 */
const OFFICIAL_CONTAINS_WORDS: readonly string[] = ['mclink'];

/**
 * 3) 空/占位：**整个昵称就是它（或它 + 编号）**时拒绝。
 *
 * 判据是"这个名字指不到具体的人"：名册里一排「匿名」「游客」「用户」，
 * 房主既认不出谁是谁，也没法按名字把人找出来。
 * 只做整名匹配 —— `用户123` 是能区分到人的，`用户` 不是。
 * `player` 刻意不列：`Player_01` 是最常见的正常昵称写法之一，列了会被"名字+编号"规则误杀。
 */
const PLACEHOLDER_EXACT_WORDS: readonly string[] = [
  '匿名',
  '匿名用户',
  '匿名玩家',
  '游客',
  '游客用户',
  '无名',
  '无名氏',
  '某人',
  '某某',
  '某某某',
  '用户',
  '用户名',
  '新用户',
  '玩家',
  '测试',
  '测试用户',
  '测试账号',
  '临时用户',
  '已注销',
  '已删除',
  'null',
  'undefined',
  'none',
  'nan',
  'nil',
  'n/a',
  'anonymous',
  'anon',
  'guest',
  'nobody',
  'user',
  'username',
  'test',
  'testing',
  'demo',
  'example',
  'sample',
  'temp',
  'temporary',
  'default',
  'unknown',
];

/** NFKC 折叠（全角→半角、兼容字符归一）→ 去不可见字符 → 小写 → 同形字映射。**不做分隔符处理** */
function toBase(raw: string): string {
  const folded = raw.normalize('NFKC').replace(INVISIBLE_RE, '').toLowerCase();
  let out = '';
  for (const ch of folded) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

/**
 * 昵称归一化骨架：NFKC + 去零宽/控制字符 + 小写 + 同形字映射 + 去分隔符。
 *
 * 这是**唯一**的归一化实现，客户端与服务端共用 —— 与 `passwordProblem`/`emailProblem`
 * 一样，规则只有一处，两边不会漂移。
 *
 * ⚠️ 返回值**只用于比对**，不要拿它回写：它抹掉了大小写、空格和用户的原始字符，
 * 回写等于替用户改名（并且会把他的同形字写法悄悄换成拉丁字母）。
 */
export function normalizeDisplayName(raw: string): string {
  return toBase(raw).replace(SEPARATOR_RE, '');
}

/** 数字/标点替形折叠：variant 用于消解 `1`/`|` 这类"同时像两个字母"的字符 */
function foldLookalikes(base: string, variant: 0 | 1): string {
  return base.replace(LOOKALIKE_RE, (ch) => {
    const options = LOOKALIKE_SETS[ch];
    if (!options) return ch;
    return options[Math.min(variant, options.length - 1)] ?? ch;
  });
}

/**
 * 用来跟保留词比对的候选骨架。
 *
 * 三件事叠在一起，都是为了堵"看起来是官方、字面上又不是"的写法：
 *   · 归一化本体：`管 理 员` → `管理员`、`МсLink` → `mclink`；
 *   · 数字/标点替形：`4dm1n` / `Adm1n` → `admin`（`1` 同时像 i 和 l，所以出两份候选）；
 *   · 尾随编号主干：`admin123`、`管理员007` —— 加个编号是最常见的
 *     "看着像官方、又不完全重名"的写法。
 *
 * 这些都是比对用的临时值，不会写回任何地方。
 */
function reservedForms(raw: string): string[] {
  const base = toBase(raw);
  const out = new Set<string>();
  for (const candidate of [base, foldLookalikes(base, 0), foldLookalikes(base, 1)]) {
    const form = candidate.replace(SEPARATOR_RE, '');
    if (form.length === 0) continue;
    out.add(form);
    const stem = form.replace(/\d+$/, '');
    if (stem.length > 0) out.add(stem);
  }
  return [...out];
}

/** 词表命中判定：mode=exact 是整名相同，mode=contains 是出现即拦 */
function wordFormsHit(forms: readonly string[], words: readonly string[], mode: 'exact' | 'contains'): boolean {
  for (const word of words) {
    for (const w of reservedForms(word)) {
      if (w.length === 0) continue;
      for (const form of forms) {
        if (mode === 'exact' ? form === w : form.includes(w)) return true;
      }
    }
  }
  return false;
}

/** `displayNameProblem` 的附加判据（保留词之外，只有查库/查状态才知道的信息） */
export interface DisplayNameCheck {
  /**
   * 已存在用户的显示名 —— 由调用方查库传入（通常已经排除调用者自己那一行）。
   * 归一化后相同即视为占用：挡住"插零宽字符/分隔符/换同形字冒充别人"。
   */
  takenDisplayNames?: readonly string[];
  /** 调用者**当前**的显示名：归一化后与自己相同就直接放行 */
  selfDisplayName?: string | null;
}

/**
 * 显示名（昵称）校验。没问题返回 null，有问题返回**可直接显示给用户**的中文原因。
 *
 * 三类：① 冒充官方/管理身份；② 空/占位名；③ 归一化后与已有用户同名（反冒充）。
 * 另外运营可在 `BLOCKED_WORDS` 里加自己的词表，会被同一条管线一起比对。
 *
 * 空值返回 null：空昵称的语义由调用方定 —— 注册时它是可选字段（留空回落到用户名），
 * 改资料那一侧另有"显示名不能为空"。长度上限同理，由调用方按既有规则处理。
 */
export function displayNameProblem(raw: string, check: DisplayNameCheck = {}): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  const normalized = normalizeDisplayName(value);
  // 只剩不可见字符或分隔符（`\u200B`、`---`）：放行的话名册里会出现一个看不见、也点不中的人
  if (normalized.length === 0) return REASON_UNREADABLE;

  /**
   * 改回自己现在的昵称必须放行。
   *
   * 归一化抹平了大小写、空格与同形字，所以"和自己一样"包括 `ＭcLink` 这类写法；
   * 而历史昵称本身就可能落在下面的规则里（本功能不追溯既有数据）——
   * 不放行的话，这样的用户连"只改邮箱"这一次保存都过不去。
   */
  const self = check.selfDisplayName ? normalizeDisplayName(check.selfDisplayName) : '';
  if (self.length > 0 && self === normalized) return null;

  const forms = reservedForms(value);
  if (wordFormsHit(forms, OFFICIAL_EXACT_WORDS, 'exact')) return REASON_OFFICIAL;
  if (wordFormsHit(forms, OFFICIAL_CONTAINS_WORDS, 'contains')) return REASON_OFFICIAL;
  if (wordFormsHit(forms, PLACEHOLDER_EXACT_WORDS, 'exact')) return REASON_PLACEHOLDER;
  if (wordFormsHit(forms, BLOCKED_WORDS, 'contains')) return REASON_BLOCKED;

  // 反冒充：跟已有账号的显示名比，同样是"先归一化再比" —— 加零宽字符改不掉骨架
  for (const other of check.takenDisplayNames ?? []) {
    if (other.trim().length === 0) continue;
    if (normalizeDisplayName(other) === normalized) return REASON_TAKEN;
  }
  return null;
}
