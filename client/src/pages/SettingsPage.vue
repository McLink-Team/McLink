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
import { currentTheme, displayNameProblem, emailProblem, passwordProblem, setThemeChoice, themeChoice, type ThemeChoice } from '@mclink/shared';
import {
  changePassword,
  clientState,
  countPeers,
  inspectPeers,
  logout,
  openUpdatePage,
  refreshEmailStatus,
  relaunchElevated,
  setAutoFallback,
  setDevice,
  setExtraPeers,
  setMasterUrl,
  startEmailVerification,
  submitEmailCode,
  updateDisplayName,
} from '../lib/store.ts';
import { customMasterUrl, friendlyError, MASTER_URL } from '../lib/api.ts';
import { reopenOnboarding } from '../lib/onboarding.ts';
import { adminAuthPrompt, closeActionLabel, isMac, needsAdmin, trayName, tunName } from '../lib/platform.ts';
import { applyMessagesEnabled, messagesEnabled } from '../lib/notify.ts';
import type { AppInfo, CloseAction } from '../lib/bridge.ts';

const info = ref<AppInfo | null>(null);
const device = ref(clientState.deviceName);
const listenPort = ref(clientState.listenPort);
const saved = ref(false);

/* ------------------------------------------------ 自建 / 社区节点（主控与中继） */

/**
 * 主控地址与中继节点这两个输入框。
 *
 * 主控：保存后**必须清登录态并重新连一次**（旧令牌是旧主控签的），
 * 所以这里不做"静默保存"，而是明确告诉玩家"已切换，请重新登录"。
 * 中继：只影响下次进房时生成的配置，改完提示"退出房间再进一次"。
 */
const masterInput = ref(customMasterUrl() ?? '');
const masterBusy = ref(false);
const masterMessage = ref('');
const masterIsCustom = computed(() => customMasterUrl() !== null);
const state = clientState;

const peersInput = ref(clientState.extraPeers);
const peersMessage = ref('');
const peerCount = computed(() => countPeers(peersInput.value));
const peerBad = computed(() =>
  inspectPeers(peersInput.value)
    .filter((p) => p.uri === null)
    .map((p) => p.raw),
);

async function saveMaster(): Promise<void> {
  masterBusy.value = true;
  masterMessage.value = '';
  try {
    const changed = setMasterUrl(masterInput.value);
    if (!changed) {
      masterMessage.value = `主控地址没变，仍是 ${state.masterUrl}。`;
      return;
    }
    /**
     * 切换成功后回到登录页：`clientState.ready` 已被 setMasterUrl 置回 false，
     * 但界面还停在设置页 —— 让玩家看到"该重新登录了"，比停在设置页更清楚。
     */
    masterMessage.value = `已切换到 ${state.masterUrl}，登录状态已清除，请重新登录。`;
    device.value = clientState.deviceName;
  } catch (err) {
    masterMessage.value = friendlyError(err);
  } finally {
    masterBusy.value = false;
  }
}

async function clearMaster(): Promise<void> {
  masterInput.value = '';
  await saveMaster();
}

function savePeers(): void {
  const count = setExtraPeers(peersInput.value);
  peersMessage.value =
    count === 0
      ? '已清空：以后只用平台下发的中继。'
      : `已保存 ${count} 个节点，退出房间再进一次即可生效。`;
  peersInput.value = clientState.extraPeers;
}

function clearPeers(): void {
  peersInput.value = '';
  savePeers();
}

/** 默认主控地址（只读展示：让玩家知道"留空"会连到哪里） */
const defaultMaster = MASTER_URL;

/** 启动时自动请求管理员权限（默认开；关掉后不再自动弹 UAC） */
const autoElevate = ref(true);

async function saveAutoElevate(): Promise<void> {
  const res = await window.mclink.setAutoElevate(autoElevate.value);
  autoElevate.value = res.autoElevate;
}

/**
 * 「有人发消息时提醒我」（默认开）。
 *
 * 写入走 client-prefs.json（与 autoElevate / closeAction 同一套 readPrefs/writePrefs），
 * 但**不能只写主进程**：判定发生在 WS 消息到手的那一瞬间、必须是同步的，
 * 所以真正生效的是渲染层那份（lib/notify.ts），applyMessagesEnabled 负责两边一起更新
 * —— 这里必须调它，而不是直接调 window.mclink.setNotifyMessages。
 */
const notifyMessages = ref(true);
/** 「发一条测试通知」的结果：区分"策略跳过了"和"系统根本不弹" */
const testNotifyResult = ref('');

/**
 * 手动弹一条测试通知。
 *
 * 为什么要这个按钮：判定链有 5 道（开关 / 在房间里 / 非系统消息 / 非自己发的 /
 * 没正看着那个房间），任何一道都会让通知**安静地不出现** —— 而"安静"正是它该有的表现，
 * 于是玩家没法区分"被策略跳过了"和"系统通知坏了"。
 *
 * 这个按钮**故意绕过整套判定**，直接走主进程那条投递路径（`window.mclink.notify.show`），
 * 所以它能证明的只有一件事：**系统这一侧的投递通不通**。这也是最值得先排除的一环 ——
 * 真机上"没弹"最常见的原因其实是系统通知权限/专注模式，它在两端（Win/Mac）表现一样，
 * 与"是不是我正看着房间页"很像，没有这个按钮就只能靠猜。
 */
async function sendTestNotification(): Promise<void> {
  testNotifyResult.value = '';
  const bridge = window.mclink?.notify;
  if (!bridge) {
    testNotifyResult.value = '这个平台还没有接入系统通知。';
    return;
  }
  try {
    const res = await bridge.show({
      title: 'McLink 测试通知',
      body: '看到这条说明系统通知是通的 —— 真有人说话时也会这样弹。',
      roomId: clientState.session?.room.id ?? '',
    });
    if (res && res.ok === false) {
      testNotifyResult.value = '系统没有接受这条通知：' + (res.error ?? '未知原因');
    } else {
      testNotifyResult.value = '已发出。若通知区域没出现，请检查系统通知权限与「专注/勿扰」模式。';
    }
  } catch (err) {
    testNotifyResult.value = '发送失败：' + (err instanceof Error ? err.message : String(err));
  }
}

async function saveNotifyMessages(): Promise<void> {
  await applyMessagesEnabled(notifyMessages.value);
  // 以真实生效值为准：主进程把它归一成布尔（enabled !== false）
  notifyMessages.value = messagesEnabled();
}

/**
 * 关闭窗口时的行为。默认 ask（关的时候问一次）——
 * 以前是无条件收进托盘且没有任何提示，玩家以为退出了、其实还在后台跑。
 * 选项文案按平台取（mac 上是「隐藏窗口」，不是「最小化到托盘」）。
 */
const CLOSE_OPTIONS: ReadonlyArray<{ value: CloseAction; label: string }> = [
  { value: 'ask', label: '每次都问我' },
  { value: 'tray', label: closeActionLabel('tray') },
  { value: 'quit', label: '彻底退出' },
];
const closeAction = ref<CloseAction>('ask');

async function saveCloseAction(): Promise<void> {
  const res = await window.mclink.setCloseAction(closeAction.value);
  closeAction.value = res.closeAction;
}

/**
 * 自动回落（**到房主的直连**丢包 → 切中继）。**默认关**。
 *
 * 判据只有"本机 → 房主"那一条链路（见 lib/relay-fallback.ts 的 hostLinkQuality）：
 * `cost = p2p` 只说明本机到那个节点是直连，中继节点通常也是直连 ——
 * 按它判定会把"到中继服务器的直连"当成玩家间的 P2P。
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

/**
 * 与服务端同一条规则（shared 的 `displayNameProblem`）：保留词（冒充官方、匿名/占位）
 * 在输入时就报出来，不用等服务端回一次 400。
 *
 * 两点与密码那一段同理：
 *   · `selfDisplayName` 要传自己的旧昵称 —— 服务端"改回自己原名放行"的规则这里也要一致，
 *     否则老用户改邮箱时会被自己现在的名字卡住；
 *   · 服务端仍是强制点：它还会拿库里**所有**显示名做重名比对（客户端没有那份名单）。
 */
const nicknameIssue = computed(() =>
  nickname.value.trim().length > 0
    ? displayNameProblem(nickname.value.trim(), { selfDisplayName: clientState.user?.displayName ?? null })
    : null,
);

async function saveNickname(): Promise<void> {
  const next = nickname.value.trim();
  if (next.length === 0) {
    nickError.value = '昵称不能为空。';
    return;
  }
  // 按钮 disabled 时进不来，回车/别处触发时兜底 —— 保证一定有可读的原因
  if (nicknameIssue.value) {
    nickError.value = nicknameIssue.value;
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
  notifyMessages.value = info.value.notifyMessages !== false;
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

    <!--
      权限状态：Windows 与 macOS 上创建虚拟网卡必须提权。通栏，不进下面的栅格。
      判定必须**按平台**：只有这两个平台"没提权"才意味着联机不可用，
      其它平台（例如 Linux 用户态建网卡）显示这条横幅就是误报。
    -->
    <div v-if="info && needsAdmin && !info.elevated" class="alert alert-warn">
      <div class="grow">
        <div style="font-weight: 600">当前未以管理员身份运行</div>
        <div class="hint">
          EasyTier 需要管理员权限才能创建虚拟网卡（{{ tunName }}）。不提权的话可以登录、建房，但成员之间无法真正连通。
        </div>
      </div>
      <button class="btn btn-primary btn-sm" @click="relaunchElevated()">以管理员身份重启</button>
    </div>
    <div v-else-if="info && needsAdmin" class="alert alert-ok">已以管理员身份运行，虚拟网卡可用。</div>

    <div class="settings-grid">
      <section v-if="info && needsAdmin" class="card stack">
        <div class="section-head">
          <span class="title">权限</span>
        </div>
        <label class="check-row">
          <input v-model="autoElevate" type="checkbox" @change="saveAutoElevate()" />
          <span>
            启动时自动请求管理员权限
            <span class="hint" style="display: block">
              开始联机需要管理员权限创建虚拟网卡（{{ tunName }}）。关掉后不再自动弹{{ adminAuthPrompt }}，可以手动点上面的按钮。
              <template v-if="!isMac">
                在 {{ adminAuthPrompt }} 上点了「否」的话，7 天内也不会再自动弹。
              </template>
              <template v-else>
                在系统授权框上点了「取消」的话，7 天内也不会再自动弹。
              </template>
            </span>
          </span>
        </label>
      </section>

      <section v-if="info" class="card stack">
        <div class="section-head">
          <span class="title">消息提醒</span>
        </div>
        <label class="check-row">
          <input v-model="notifyMessages" type="checkbox" @change="saveNotifyMessages()" />
          <span>
            有人发消息时提醒我
            <span class="hint" style="display: block">
              房间里有人说话时弹一条{{ isMac ? '通知中心' : '系统通知' }}。
              <b>正看着那个房间、窗口也在前台时不会弹</b>（消息就在眼前）；
              窗口收在{{ trayName }}里、最小化、或停在别的页面时才提醒；自己发的消息不提醒。
              同一个房间几秒内的连发会合并成一条。关掉之后一条都不弹。
              <span v-if="info.notificationsSupported === false" style="color: var(--warn)">
                当前系统报告不支持通知 —— 开了也不会弹，请检查系统通知设置。
              </span>
            </span>
          </span>
        </label>
        <!--
          测试通知按钮：绕过上面那 5 道判定，只验证"系统这一侧通不通"。
          真机/真机上"没弹"最常见的原因是系统权限或专注模式 —— 这一条能立刻排除它。
        -->
        <div class="row" style="gap: 10px; align-items: center; flex-wrap: wrap">
          <button class="btn btn-sm" type="button" @click="sendTestNotification()">发一条测试通知</button>
          <span v-if="testNotifyResult" class="hint">{{ testNotifyResult }}</span>
        </div>
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
            {{ isMac ? '点窗口左上角的红点（或按 ⌘W）时做什么。' : '点右上角关闭时做什么。' }}
            <b>{{ closeActionLabel('tray') }}</b>不会断开局域网（{{ trayName }}图标可退出）；
            <b>彻底退出</b>会断开连接、房间里的朋友会掉线。
            <template v-if="isMac">
              注意 ⌘Q 是<b>退出应用</b>，不受这里影响 —— 与系统上其它应用一致。
            </template>
            <template v-else>
              选「每次都问我」时，关窗口会弹一次询问框，那里勾了「记住我的选择」也会写进这个设置。
            </template>
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
            <!-- 与服务端同一条规则（shared 的 displayNameProblem）：冒充官方/占位名在输入时就报 -->
            <div v-else-if="nicknameIssue" class="hint acct-bad">{{ nicknameIssue }}</div>
            <div v-else class="hint">
              房间成员列表、聊天和左下角头像都用它；用户名
              <span class="mono">{{ username }}</span> 不可修改，「本机名称」是另一回事（只备注这台设备）。
            </div>
          </div>
          <div class="ops">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="nickBusy || nickname.trim().length === 0 || nicknameIssue !== null"
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

      <!--
        自建 / 社区节点（2026-10-03）。
        官方服务停止后，这一块是"这版客户端还能不能用"的开关：
          · 主控地址 —— 换成你自己的实例；切换会清掉登录态（旧令牌对新主控无效）；
          · 中继节点 —— 平台没有官方节点时，填社区/自建节点的地址，进房时追加进内核配置。
        风险如实写在输入框下面：连到谁的主控，账号密码就交给谁。
      -->
      <section class="card stack">
        <div class="section-head">
          <span class="title">自建 / 社区节点</span>
        </div>

        <div class="field">
          <label class="label">主控地址</label>
          <input
            v-model="masterInput"
            class="input"
            :placeholder="`留空 = 用本包内置的 ${defaultMaster}`"
            spellcheck="false"
          />
          <div class="hint">
            当前正在连：<b class="mono">{{ state.masterUrl }}</b>
            <template v-if="masterIsCustom">（你填的）</template>
            <template v-else>（本包内置）</template>
            。填自己的实例地址即可（例如 <span class="mono">https://mclink.example.com</span> 或
            <span class="mono">http://192.168.1.10:8787</span>）。
            <b>切换主控会退出当前登录</b>——你的账号只存在于原来那台主控上。
            另外请只填你信任的实例：<b>登录时账号密码会发给那台主控</b>。
          </div>
          <div class="ops">
            <button class="btn btn-primary" type="button" :disabled="masterBusy" @click="saveMaster">
              保存并重启连接
            </button>
            <button
              v-if="masterIsCustom"
              class="btn btn-ghost"
              type="button"
              :disabled="masterBusy"
              @click="clearMaster"
            >
              恢复默认主控
            </button>
          </div>
          <div v-if="masterMessage" class="hint">{{ masterMessage }}</div>
        </div>

        <div class="field">
          <label class="label">中继节点（可选，一行一个）</label>
          <textarea
            v-model="peersInput"
            class="textarea"
            rows="4"
            spellcheck="false"
            placeholder="tcp://relay.example.com:11010&#10;udp://relay.example.com:11010&#10;或者只写 relay.example.com:11010（会同时按 tcp 与 udp 各加一条）"
          />
          <div class="hint">
            平台没有可用中继时（官方服务已停、或你自建的主控还没接节点），
            可以把社区/自己搭的 EasyTier 节点填在这里：进房时它们会被<b>追加</b>到平台下发的配置里，
            房间仍然由主控签发票据，只是转发多几个可选出口。
            社区公共节点列表见
            <a href="https://info.qtet.cn/uptime/easytier" rel="noreferrer noopener" target="_blank">
              info.qtet.cn/uptime/easytier
            </a>
            （第三方提供，与本项目无关联，请自行判断可用性与可信度）。
            改完<b>退出房间再进一次</b>才会生效。
          </div>
          <div class="hint">
            已识别 <b>{{ peerCount }}</b> 个合法地址<template v-if="peerBad.length > 0">
              ；这些会被跳过：<span class="mono">{{ peerBad.join('、') }}</span></template
            >。
          </div>
          <div class="ops">
            <button class="btn btn-primary" type="button" @click="savePeers">保存</button>
            <button v-if="peersInput.trim().length > 0" class="btn btn-ghost" type="button" @click="clearPeers">
              清空
            </button>
          </div>
          <div v-if="peersMessage" class="hint">{{ peersMessage }}</div>
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
        联机质量：自动回落（到房主的直连丢包 → 切中继）。
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
            到房主的直连丢包时自动切到中继
            <span class="hint" style="display: block">
              直连打洞成功但质量很差时（游戏里表现为人物回弹），自动改走中继。
              判据只看<b>本机到房主</b>那一条链路 —— 房主跑着游戏服务端，它才决定游戏手感
              （本机到中继节点往往也是直连，那不是"玩家之间的 P2P"，不算数）。
              触发条件：本机不是房主，且连续 3 个采样窗口（约 36 秒）里到房主的<b>直连</b>丢包都超过 5%。
              本机就是房主时没有"到房主"的链路，这项不适用，永不自动切换。
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
