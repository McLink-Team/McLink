<script setup lang="ts">
/**
 * 设置 —— 只放玩家自己能决定的事：账号（昵称/密码/邮箱）、本机名称、本机端口、
 * 外观、日志、关于。
 *
 * 刻意不放任何服务器/主控信息：客户端连哪台机器不是玩家能改的，
 * 摆在这里只会让人以为自己可以填错。
 *
 * 排版：**分区 + 两列**（窗口窄了自动回落一列，见 .settings-grid 的 auto-fit）。
 * 以前这里是 `repeat(auto-fit, minmax(320px, 1fr))` 的等宽卡片流：窄窗时代够用，
 * 换成 940×580 的横窗之后，卡片高度差被放大成"三列不等高"，
 * 最右一列还会顶到窗口边缘；「本机监听端口」被裁掉则是上面那半截卡片
 * 把可用高度吃光了。现在同排卡片顶部对齐（align-items: start），
 * 高度各由内容决定，谁也不会去挤谁。
 *
 * 「客户端版本 / 平台 / 日志目录」这类**只读事实**用定义列表（dt + dd）而不是卡片：
 * 它们没有可操作的形态，做成卡片的后果是"一屏里六张白卡、每张只有一行字"。
 *
 * 「账号」卡排在「本机」前面：这一页里只有这两张卡在回答"你是谁"，而账号是
 * **主控上的身份**（昵称、密码、邮箱），本机名称只是这台设备在成员列表里的备注。
 * 顺序按作用域从大到小，也顺带回答了"改昵称该去哪儿"——以前这一页里唯一像昵称的
 * 输入框其实是本机名称。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { currentTheme, emailProblem, passwordProblem, setThemeChoice, themeChoice, type ThemeChoice } from '@mclink/shared';
import {
  changePassword,
  clientState,
  logout,
  openUpdatePage,
  refreshEmailStatus,
  relaunchElevated,
  setAutoFallback,
  setDevice,
  startEmailVerification,
  submitEmailCode,
  updateDisplayName,
} from '../lib/store.ts';
import { friendlyError } from '../lib/api.ts';
import { reopenOnboarding } from '../lib/onboarding.ts';
import type { AppInfo, CloseAction } from '../lib/bridge.ts';

const info = ref<AppInfo | null>(null);
const device = ref(clientState.deviceName);
const listenPort = ref(clientState.listenPort);
const saved = ref(false);
/** 启动时自动请求管理员权限（默认开；关掉后不再自动弹 UAC） */
const autoElevate = ref(true);

async function saveAutoElevate(): Promise<void> {
  const res = await window.mclink.setAutoElevate(autoElevate.value);
  autoElevate.value = res.autoElevate;
}

/**
 * 关闭窗口时的行为。默认 ask（关的时候问一次）——
 * 以前是无条件收进托盘且没有任何提示，玩家以为退出了、其实还在后台跑。
 */
const CLOSE_OPTIONS: ReadonlyArray<{ value: CloseAction; label: string }> = [
  { value: 'ask', label: '每次都问我' },
  { value: 'tray', label: '最小化到托盘（保持联机）' },
  { value: 'quit', label: '彻底退出' },
];
const closeAction = ref<CloseAction>('ask');

async function saveCloseAction(): Promise<void> {
  const res = await window.mclink.setCloseAction(closeAction.value);
  closeAction.value = res.closeAction;
}

/**
 * 自动回落（P2P 丢包 → 切中继）。**默认关**。
 *
 * 为什么默认关：它会在玩家没盯着屏幕的时候重启 EasyTier 核心，每次断几秒。
 * 自动做"打断连接"的决定，必须由玩家先明确打开（这也是它跟"配色模式"这类
 * 纯偏好设置的区别）。
 */
const autoFallback = ref(clientState.autoFallback);

function saveAutoFallback(): void {
  setAutoFallback(autoFallback.value);
}

/* ------------------------------------------------------------------ 外观 */
const THEME_OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
];
const theme = ref<ThemeChoice>(themeChoice());
const effective = ref(currentTheme());

function pickTheme(choice: ThemeChoice): void {
  theme.value = choice;
  // 共享层负责写盘 + 立刻改 <html data-theme> + 重新订阅系统变化
  setThemeChoice(choice);
  effective.value = currentTheme();
}

/* ------------------------------------------------------------------ 账号 */

/** 用户名是主控发的，改不了 —— 只用来告诉玩家"昵称不是这个" */
const username = computed(() => clientState.user?.username ?? '');

/* ---- 昵称 ---- */

const nickname = ref(clientState.user?.displayName ?? '');
const nickBusy = ref(false);
const nickError = ref('');
const nickSaved = ref(false);

async function saveNickname(): Promise<void> {
  const next = nickname.value.trim();
  if (next.length === 0) {
    nickError.value = '昵称不能为空。';
    return;
  }
  nickBusy.value = true;
  nickError.value = '';
  nickSaved.value = false;
  try {
    await updateDisplayName(next);
    // 服务端会 trim + 截到 32 字：以它回来的那一份为准，别让输入框停在一个没生效的值上
    nickname.value = clientState.user?.displayName ?? next;
    nickSaved.value = true;
    setTimeout(() => (nickSaved.value = false), 3000);
  } catch (err) {
    nickError.value = friendlyError(err);
  } finally {
    nickBusy.value = false;
  }
}

/* ---- 密码 ---- */

const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const pwBusy = ref(false);
const pwError = ref('');

/** 与注册、与服务端 `passwordProblem()` 同一条规则（≥8 位、含字母与数字、≤128 位） */
const newPasswordIssue = computed(() => (newPassword.value.length > 0 ? passwordProblem(newPassword.value) : null));
const passwordMismatch = computed(
  () => confirmPassword.value.length > 0 && confirmPassword.value !== newPassword.value,
);
/** 能立刻判定的错就别让请求跑一趟：三项齐了、两次一致、规则过了才让点 */
const canChangePassword = computed(
  () =>
    !pwBusy.value &&
    oldPassword.value.length > 0 &&
    newPassword.value.length > 0 &&
    newPasswordIssue.value === null &&
    confirmPassword.value === newPassword.value,
);

async function submitPassword(): Promise<void> {
  pwError.value = '';
  // 这三个分支在按钮 disabled 时进不来（回车/别处触发时兜底），保证一定有可读的原因
  if (oldPassword.value.length === 0) {
    pwError.value = '请先填写原密码。';
    return;
  }
  const issue = passwordProblem(newPassword.value);
  if (issue) {
    pwError.value = issue;
    return;
  }
  if (confirmPassword.value !== newPassword.value) {
    pwError.value = '两次输入的新密码不一致。';
    return;
  }
  pwBusy.value = true;
  try {
    await changePassword(oldPassword.value, newPassword.value);
    /**
     * 走到这里本机已经被登出了：服务端在改密后吊销了该账号的全部会话
     * （包括手里这条），store 只能本地登出并把这句提示交给登录页 —— 见
     * lib/store.ts 的 changePassword()。所以这一页马上会卸载，这里不再写"成功"提示。
     */
    oldPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
  } catch (err) {
    // 原密码错、新密码不合规都由服务端回可读文案（"原密码不正确"…）
    pwError.value = friendlyError(err);
  } finally {
    pwBusy.value = false;
  }
}

/* ---- 邮箱 ---- */

const emailInput = ref(clientState.email.email ?? clientState.user?.email ?? '');
const codeInput = ref('');
const mailBusy = ref(false);
const mailError = ref('');
const mailNotice = ref('');
/** 重发冷却：服务端 60 秒内不收第二次（会回 429），界面必须同步禁掉按钮 */
const cooldown = ref(0);
let cooldownTimer: number | null = null;

/** 主控有没有配邮件服务（`/meta` 的 emailServiceAvailable）——没配就不给按钮 */
const mailReady = computed(() => clientState.platform.emailServiceAvailable);
const currentEmail = computed(() => clientState.email.email ?? clientState.user?.email ?? '');
const emailVerified = computed(() => clientState.email.verified || clientState.user?.emailVerified === true);
const emailIssue = computed(() => {
  const value = emailInput.value.trim();
  return value.length > 0 ? emailProblem(value) : null;
});
/** 码发出去过（或上次发的还没过期）才显示验证码那一行，免得空着一个用不上的输入框 */
const codeRowVisible = computed(() => cooldown.value > 0 || clientState.email.codeExpiresAt !== null);

function startCooldown(seconds: number): void {
  cooldown.value = Math.max(0, Math.floor(seconds));
  if (cooldownTimer !== null) window.clearInterval(cooldownTimer);
  cooldownTimer = window.setInterval(() => {
    cooldown.value = Math.max(0, cooldown.value - 1);
    if (cooldown.value === 0 && cooldownTimer !== null) {
      window.clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }, 1000);
}

async function sendEmailCode(): Promise<void> {
  const address = emailInput.value.trim();
  const issue = emailProblem(address);
  if (issue) {
    mailError.value = issue;
    return;
  }
  mailBusy.value = true;
  mailError.value = '';
  mailNotice.value = '';
  try {
    await startEmailVerification(address);
    mailNotice.value = `验证码已发送到 ${address}，请查收（也看看垃圾邮件）。`;
    startCooldown(60);
  } catch (err) {
    // 邮箱被别人占了、SMTP 没配好/发不出去 —— 服务端都给可读文案
    mailError.value = friendlyError(err);
  } finally {
    mailBusy.value = false;
  }
}

async function verifyEmailCode(): Promise<void> {
  mailBusy.value = true;
  mailError.value = '';
  mailNotice.value = '';
  try {
    await submitEmailCode(codeInput.value.trim());
    codeInput.value = '';
    mailNotice.value = '邮箱已验证。';
  } catch (err) {
    mailError.value = friendlyError(err);
  } finally {
    mailBusy.value = false;
  }
}

onMounted(async () => {
  info.value = await window.mclink.info();
  autoElevate.value = info.value.autoElevate !== false;
  closeAction.value = (info.value.closeAction ?? 'ask') as CloseAction;
  nickname.value = clientState.user?.displayName ?? nickname.value;
  // 邮箱状态以主控为准（可能刚在别处验过），顺带把冷却期接着算
  await refreshEmailStatus();
  if (!emailInput.value) emailInput.value = clientState.email.email ?? '';
  if (clientState.email.resendAfterSeconds > 0) startCooldown(clientState.email.resendAfterSeconds);
});

onUnmounted(() => {
  if (cooldownTimer !== null) window.clearInterval(cooldownTimer);
});

function save(): void {
  setDevice(device.value.trim());
  clientState.listenPort = Number(listenPort.value) || clientState.listenPort;
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

function openLogDir(): void {
  const dir = info.value?.logDir;
  if (dir) void window.mclink.openPath(dir);
}

function openDataDir(): void {
  const dir = info.value?.dataDir;
  if (dir) void window.mclink.openPath(dir);
}
</script>

<template>
  <div class="view settings-page">
    <div v-if="saved" class="alert alert-ok">设置已保存。</div>

    <!-- 权限状态：Windows 上创建虚拟网卡必须提权。通栏，不进下面的栅格 -->
    <div v-if="info && !info.elevated" class="alert alert-warn">
      <div class="grow">
        <div style="font-weight: 600">当前未以管理员身份运行</div>
        <div class="hint">
          EasyTier 需要管理员权限才能创建虚拟网卡（wintun）。不提权的话可以登录、建房，但成员之间无法真正连通。
        </div>
      </div>
      <button class="btn btn-primary btn-sm" @click="relaunchElevated()">以管理员身份重启</button>
    </div>
    <div v-else-if="info" class="alert alert-ok">已以管理员身份运行，虚拟网卡可用。</div>

    <div class="settings-grid">
      <section v-if="info" class="card stack">
        <div class="section-head">
          <span class="title">权限</span>
        </div>
        <label class="check-row">
          <input v-model="autoElevate" type="checkbox" @change="saveAutoElevate()" />
          <span>
            启动时自动请求管理员权限
            <span class="hint" style="display: block">
              开始联机需要管理员权限创建虚拟网卡。关掉后不再自动弹 UAC，可以手动点上面的按钮。
              在 UAC 上点了「否」的话，7 天内也不会再自动弹。
            </span>
          </span>
        </label>
      </section>

      <section v-if="info" class="card stack">
        <div class="section-head">
          <span class="title">关闭窗口时</span>
        </div>
        <div class="field">
          <select v-model="closeAction" class="select" @change="saveCloseAction()">
            <option v-for="opt in CLOSE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <span class="hint">
            点右上角关闭时做什么。<b>最小化到托盘</b>不会断开局域网（托盘图标右键可退出）；
            <b>彻底退出</b>会断开连接、房间里的朋友会掉线。选「每次都问我」时，
            关窗口会弹一次询问框，那里勾了「记住我的选择」也会写进这个设置。
          </span>
        </div>
      </section>

      <!--
        账号：改昵称 / 改密码 / 邮箱状态。
        三段之间只用一条发丝线分（.acct-block），不再套小卡片 —— 契约禁止卡里套卡。
      -->
      <section class="card stack">
        <div class="section-head">
          <span class="title">账号</span>
          <span class="count mono">{{ username }}</span>
        </div>

        <!-- 昵称：账号显示名（≠ 下面的「本机名称」） -->
        <div class="acct-block stack">
          <div class="field">
            <label class="label" for="acct-nick">昵称</label>
            <input
              id="acct-nick"
              v-model="nickname"
              class="input"
              maxlength="32"
              placeholder="会显示在房间成员列表与聊天里"
              :disabled="nickBusy"
            />
            <div v-if="nickname.trim().length === 0" class="hint acct-bad">昵称不能为空。</div>
            <div v-else class="hint">
              房间成员列表、聊天和左下角头像都用它；用户名
              <span class="mono">{{ username }}</span> 不可修改，「本机名称」是另一回事（只备注这台设备）。
            </div>
          </div>
          <div class="ops">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="nickBusy || nickname.trim().length === 0"
              @click="saveNickname()"
            >
              保存昵称
            </button>
            <span v-if="nickSaved" class="hint acct-ok">昵称已保存。</span>
          </div>
          <div v-if="nickError" class="alert alert-danger">{{ nickError }}</div>
        </div>

        <!-- 密码 -->
        <div class="acct-block stack">
          <div class="field">
            <label class="label" for="acct-pw-old">原密码</label>
            <input
              id="acct-pw-old"
              v-model="oldPassword"
              class="input"
              type="password"
              autocomplete="current-password"
              :disabled="pwBusy"
            />
          </div>
          <div class="field">
            <label class="label" for="acct-pw-new">新密码</label>
            <input
              id="acct-pw-new"
              v-model="newPassword"
              class="input"
              type="password"
              autocomplete="new-password"
              placeholder="至少 8 位，含字母与数字"
              :disabled="pwBusy"
            />
            <!-- 与服务端同一条规则（shared 的 passwordProblem），在本地立刻报错 -->
            <div v-if="newPasswordIssue" class="hint acct-bad">{{ newPasswordIssue }}</div>
            <div v-else class="hint">至少 8 位、最多 128 位，且要同时有字母和数字。</div>
          </div>
          <div class="field">
            <label class="label" for="acct-pw-new2">确认新密码</label>
            <input
              id="acct-pw-new2"
              v-model="confirmPassword"
              class="input"
              type="password"
              autocomplete="new-password"
              :disabled="pwBusy"
            />
            <div v-if="passwordMismatch" class="hint acct-bad">两次输入的新密码不一致。</div>
          </div>
          <!-- 这件事必须写在按钮之前：改密会在服务端吊销全部会话，包括本机这一条 -->
          <div class="hint">
            改完密码后主控会立刻让这个账号的<strong>所有登录</strong>失效：这台电脑要重新登录，
            其它设备上的 McLink 也一样；如果正开着房，房间会一起断开。
          </div>
          <div class="ops">
            <button class="btn btn-primary" type="button" :disabled="!canChangePassword" @click="submitPassword()">
              <span v-if="pwBusy" class="spinner" />
              <span>修改密码</span>
            </button>
          </div>
          <div v-if="pwError" class="alert alert-danger">{{ pwError }}</div>
        </div>

        <!-- 邮箱：状态用只读事实那一套（dt + dd），能走的只有主控的验证流程 -->
        <div class="acct-block stack">
          <dl class="facts">
            <div class="fact">
              <dt>邮箱</dt>
              <dd>
                <span v-if="currentEmail" class="mono acct-mail">{{ currentEmail }}</span>
                <span v-else class="hint">未绑定</span>
                <span class="badge" :class="emailVerified ? 'badge-ok' : currentEmail ? 'badge-warn' : 'badge-neutral'">
                  {{ emailVerified ? '已验证' : currentEmail ? '未验证' : '未绑定' }}
                </span>
              </dd>
            </div>
          </dl>

          <template v-if="mailReady">
            <div class="field">
              <label class="label" for="acct-email">{{ currentEmail ? '换绑邮箱' : '绑定邮箱' }}</label>
              <div class="row">
                <input
                  id="acct-email"
                  v-model="emailInput"
                  class="input grow"
                  type="email"
                  autocomplete="email"
                  placeholder="you@example.com"
                  :disabled="mailBusy"
                />
                <button
                  class="btn"
                  type="button"
                  :disabled="mailBusy || cooldown > 0 || emailIssue !== null || emailInput.trim().length === 0"
                  @click="sendEmailCode()"
                >
                  {{ cooldown > 0 ? `${cooldown} 秒后可重发` : currentEmail ? '重新发送' : '发送验证码' }}
                </button>
              </div>
              <div v-if="emailIssue" class="hint acct-bad">{{ emailIssue }}</div>
              <div v-else class="hint">
                一个邮箱只能绑一个账号；换邮箱要重新验证，老邮箱的验证状态不会跟着新地址走。
              </div>
            </div>

            <div v-if="codeRowVisible" class="field">
              <label class="label" for="acct-code">验证码</label>
              <div class="row">
                <input
                  id="acct-code"
                  v-model="codeInput"
                  class="input mono grow"
                  inputmode="numeric"
                  maxlength="6"
                  placeholder="6 位数字"
                  :disabled="mailBusy"
                />
                <button
                  class="btn btn-primary"
                  type="button"
                  :disabled="mailBusy || codeInput.trim().length === 0"
                  @click="verifyEmailCode()"
                >
                  验证邮箱
                </button>
              </div>
              <div class="hint">验证码 15 分钟内有效；没收到可以点上面的按钮重发。</div>
            </div>

            <div v-if="mailNotice" class="alert alert-ok">{{ mailNotice }}</div>
            <div v-if="mailError" class="alert alert-danger">{{ mailError }}</div>
          </template>
          <!-- 主控没配 SMTP 时这条路一定走不通（服务端会回 503），所以只说明原因，不给按钮 -->
          <div v-else class="hint">
            主控还没有配置邮件服务（SMTP），现在无法绑定或换绑邮箱 —— 需要的话请联系管理员。
          </div>
        </div>
      </section>

      <section class="card stack">
        <div class="section-head">
          <span class="title">本机</span>
        </div>
        <div class="field">
          <label class="label">本机名称</label>
          <input v-model="device" class="input" />
          <div class="hint">会出现在房主的成员列表里，方便他认出你。</div>
        </div>
        <div class="field">
          <label class="label">本机监听端口</label>
          <input v-model.number="listenPort" class="input" type="number" min="1024" max="65535" />
          <div class="hint">用于其它成员直连你；已在启动时自动选了一个空闲端口，一般不用改。</div>
        </div>
        <div class="ops">
          <button class="btn btn-primary" type="button" @click="save">保存</button>
          <button class="btn btn-ghost" type="button" title="退出当前账号（不影响房间里的其他人）" @click="logout()">
            退出登录
          </button>
          <button class="btn btn-ghost" type="button" title="重新看一遍上手指引" @click="reopenOnboarding()">
            新手引导
          </button>
        </div>
      </section>

      <!--
        联机质量：自动回落（P2P 丢包 → 切中继）。
        放在「本机」之后：它和本机名称/端口一样是"这台机器怎么联网"的事，
        而不是账号或外观。默认关，条件与代价全部写在开关下面 ——
        一个会自动重启核心的设置，玩家有权在打开之前知道它什么时候动手。
      -->
      <section class="card stack">
        <div class="section-head">
          <span class="title">联机质量</span>
        </div>
        <label class="check-row">
          <input v-model="autoFallback" type="checkbox" @change="saveAutoFallback()" />
          <span>
            P2P 丢包时自动切到中继
            <span class="hint" style="display: block">
              直连打洞成功但质量很差时（游戏里表现为人物回弹），自动改走中继。
              触发条件：连续 3 个采样窗口（约 36 秒）里，<b>所有</b>测得丢包的直连节点都超过 5%。
              切过去之后还会比一次，如果中继反而更差（中继自己也在丢包，或延迟明显绕远）
              就自动切回直连，并在 30 分钟内不再自动切换。
              为确认能不能切回直连，之后每 15 分钟会尝试恢复一次直连，连续失败则逐步拉长到 1 小时。
              <b>每次自动切换与重试都会让连接中断约 3 秒。</b>
            </span>
          </span>
        </label>
      </section>

      <section class="card stack">
        <div class="section-head">
          <span class="title">外观</span>
        </div>
        <div class="field">
          <label class="label">配色模式</label>
          <!-- 复用登录页 登录/注册 的那套分段控件，窄窗里三档也放得下 -->
          <div class="tabs" role="group" aria-label="配色模式">
            <button
              v-for="opt in THEME_OPTIONS"
              :key="opt.value"
              class="tab"
              :class="{ active: theme === opt.value }"
              type="button"
              :aria-pressed="theme === opt.value"
              @click="pickTheme(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>
          <div class="hint">
            默认跟随系统；钉住某一档后系统再切换也不会变。当前生效：{{ effective === 'light' ? '亮色' : '暗色' }}。
          </div>
        </div>
      </section>

      <section class="card stack">
        <div class="section-head">
          <span class="title">运行环境</span>
        </div>
        <!--
          只读事实用定义列表：标签一列、值一列，值一律允许换行。
          路径与 hash 以前是两行 `row-between`（标签 + "打开"按钮）再加一行等宽文字，
          一旦窗口不够宽就会被右边切掉 —— 现在值自己换行、按钮跟在值后面。
        -->
        <dl v-if="info" class="facts">
          <div class="fact">
            <dt>客户端版本</dt>
            <dd>
              <span class="mono">McLink {{ info.version }}</span>
              <!-- 有新版本时直接给出对比与下载入口，不用玩家自己去下载页翻 -->
              <span v-if="clientState.update" class="badge badge-brand">
                新版 {{ clientState.update.latest }}
              </span>
            </dd>
          </div>
          <div class="fact">
            <dt>平台</dt>
            <dd class="mono">{{ info.platform }}/{{ info.arch }}</dd>
          </div>
          <div class="fact">
            <dt>联机核心</dt>
            <dd>
              <span class="badge" :class="clientState.coreStatus?.coreBinExists ? 'badge-ok' : 'badge-danger'">
                {{ clientState.coreStatus?.coreBinExists ? '已就绪' : '缺失' }}
              </span>
            </dd>
          </div>
          <div class="fact">
            <dt>日志目录</dt>
            <dd class="fact-value">
              <span class="mono path">{{ info.logDir }}</span>
              <button class="btn btn-sm btn-ghost" type="button" title="在资源管理器里打开日志目录" @click="openLogDir">
                打开
              </button>
            </dd>
          </div>
          <div class="fact">
            <dt>数据目录</dt>
            <dd class="fact-value">
              <span class="mono path">{{ info.dataDir }}</span>
              <button class="btn btn-sm btn-ghost" type="button" title="在资源管理器里打开数据目录" @click="openDataDir">
                打开
              </button>
            </dd>
          </div>
        </dl>
        <div v-else class="empty">读取中…</div>

        <div v-if="info && clientState.update" class="update">
          <div class="hint">
            主控上有更新的客户端
            <span class="mono">v{{ clientState.update.latest }}</span>
            <template v-if="clientState.update.sizeBytes">
              ，约 {{ Math.round(clientState.update.sizeBytes / 1024 / 1024) }} MB
            </template>
            。下载后在旧版上直接覆盖安装即可，登录状态与设置都会保留。
          </div>
          <div class="mono path">sha256 {{ clientState.update.sha256 ?? '（主控尚未登记校验值）' }}</div>
          <div class="ops">
            <button class="btn btn-primary btn-sm" type="button" @click="openUpdatePage()">打开下载页</button>
          </div>
        </div>
      </section>

      <section class="card stack">
        <div class="section-head">
          <span class="title">关于</span>
        </div>
        <div class="hint stack">
          <span>
            McLink 通过调用 EasyTier 核心（LGPL-3.0）建立虚拟局域网，不修改其源码；
            每个房间是一个独立网络，房间之间彼此不可见。
          </span>
          <span>
            联机小贴士：房主先在游戏里「对局域网开放」，再创建房间；玩家用「直接连接」输入联机地址即可。
            如果延迟高，可以在建房时换个区域，或让房主允许 P2P 直连。
          </span>
          <span>《我的世界》为 Mojang 商标，本平台与 Mojang 无关联，仅供合法联机使用。</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/*
 * 两列栅格：`auto-fit + minmax(300px, 1fr)` 让"窄了回落一列"自己发生，
 * 不需要断点 —— 断点要和窗口最小宽度（780）对齐，改窗口尺寸时容易失效。
 * `align-items: start` 是关键：同排卡片各自按内容定高，不再互相拉平，
 * 于是"三列不等高"那种参差不会传染到下一排。
 */
.settings-grid {
  display: grid;
  /* **单列**（用户指定）：设置是纵向读的表单，分两列会让视线来回跳；这一屏本来
   * 也不需要靠并排省高度 —— 一屏之内滚一列比横着扫两列省事。 */
  grid-template-columns: minmax(0, 1fr);
  gap: var(--s-3);
  align-items: start;
  min-width: 0;
}

/*
 * `width: 100%` 不是多余的：`.view` 自带 `margin: 0 auto`，而它在 `.deck-scroll`
 * 这个**纵向 flex 容器**里 —— 带 auto 外边距的 flex 项不会被 stretch，
 * 宽度退化成 fit-content。实测就是这么坏的：设置页只撑到一张卡的宽度（462px），
 * 于是 auto-fit 只排得下一列，看起来"宽窗还是单列"。
 * 100% + max-width 1060 的组合才能既吃满窗口、又在超宽窗口里居中。
 */
.settings-page {
  width: 100%;
}

/* 只读事实：标签固定一列，值占剩下的地方并且一定能换行 */
.facts {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  margin: 0;
  min-width: 0;
}
.fact {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: var(--s-2);
  align-items: baseline;
  min-width: 0;
}
.fact dt {
  color: var(--ink-3);
  font-size: var(--fs-xs);
}
.fact dd {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--s-2);
  /* dd 默认有 40px 缩进且带外边距：不清掉，两列栅格里会被顶出去 */
  margin: 0;
  min-width: 0;
  color: var(--ink-2);
  font-size: var(--fs-sm);
}
/* 路径那一行：值自己占满剩余宽度，按钮跟在后面（换行时也不会把值挤没） */
.fact-value .path {
  flex: 1 1 auto;
  min-width: 0;
}
.path {
  font-size: var(--fs-xs);
  /* 长路径/64 位 hash 必须能断：overflow-wrap 而不是 break-word，
     这样 grid/flex 的 min-content 计算也会把它算成"可以很小" */
  overflow-wrap: anywhere;
}

/* 新版本提示：不是一张卡（那会是卡里套卡），只用一条发丝线与上面的读数分开 */
.update {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding-top: var(--s-3);
  border-top: 1px solid var(--line-soft);
  min-width: 0;
}

/*
 * 「账号」卡里的三段（昵称 / 密码 / 邮箱）：同样只用一条发丝线分，不套小卡片。
 * 卡片本身是 .stack，段与段之间已经有 --s-3 的间距，这里再往上垫一点，
 * 让"线上面属于上一段"看起来成立。
 */
.acct-block + .acct-block {
  padding-top: var(--s-3);
  border-top: 1px solid var(--line-soft);
}

/* 就地报错 / 就地报成功：都是 .hint 的字号，只换颜色（颜色全部来自令牌） */
.acct-bad {
  color: var(--fault);
}
.acct-ok {
  color: var(--ok);
}
/* 邮箱最长 120 字，窄窗里必须能断开 */
.acct-mail {
  overflow-wrap: anywhere;
  min-width: 0;
}
</style>
