<script setup lang="ts">
/**
 * 设置 —— 只放玩家自己能决定的事：本机名称、本机端口、外观、日志、关于。
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
 */
import { onMounted, ref } from 'vue';
import { currentTheme, setThemeChoice, themeChoice, type ThemeChoice } from '@mclink/shared';
import { clientState, openUpdatePage, relaunchElevated, setDevice, logout } from '../lib/store.ts';
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

onMounted(async () => {
  info.value = await window.mclink.info();
  autoElevate.value = info.value.autoElevate !== false;
  closeAction.value = (info.value.closeAction ?? 'ask') as CloseAction;
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
</style>
