<script setup lang="ts">
/**
 * 客户端下载页。
 * 产物列表来自主控扫描的下载目录（GET /downloads），主按钮优先指向 Windows 安装包；
 * 列表为空时给出管理员上传指引，而不是留一个死按钮。
 */
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Routes, formatBytes } from '@mclink/shared';
import { api, friendlyError } from '../lib/api.ts';
import { asArray, copyText } from '../lib/ui.ts';


interface DownloadArtifact {
  id: string;
  platform: string;
  /** `universal` = 与 CPU 架构无关（安卓 APK 是 Capacitor 壳，包内没有本地库） */
  arch: string;
  label: string;
  /** 主控从文件名里取的版本号；取不到为 null */
  version?: string | null;
  filename: string;
  size: number;
  sha256: string | null;
  url: string;
}

interface DownloadsResponse {
  clientVersion: string;
  primary: string;
  artifacts: DownloadArtifact[];
}

/**
 * `/meta` 里只取下载相关的这一块。
 *
 * 安卓卡片**用主控挑好的那个产物**，而不是自己在 `artifacts` 里翻：
 * "哪个 apk 是最新的"属于产物语义（目录里会同时留历史版本），
 * 只有扫描下载目录的那一侧说得清。
 */
interface MetaDownloads {
  clientDownloads?: { version: string; android: DownloadArtifact | null } | null;
}

const data = ref<DownloadsResponse | null>(null);
const metaDownloads = ref<MetaDownloads['clientDownloads']>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const EASYTier_REPO = 'https://github.com/EasyTier/EasyTier';
const EASYTier_RELEASES = 'https://github.com/EasyTier/EasyTier/releases';

async function load(): Promise<void> {
  loading.value = true;
  try {
    /**
     * 产物清单是硬依赖；`/meta` 只是给安卓卡片补一个"最新 apk"，
     * 拿不到就退回从产物清单里找 —— 少一个请求不能让整页变成错误页。
     */
    const [list, meta] = await Promise.all([
      api.get<DownloadsResponse>(Routes.downloads),
      api.get<MetaDownloads>(Routes.meta).catch(() => null),
    ]);
    data.value = list;
    metaDownloads.value = meta?.clientDownloads ?? null;
    error.value = null;
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

const artifacts = computed<DownloadArtifact[]>(() => asArray(data.value?.artifacts));

const windowsArtifacts = computed(() => artifacts.value.filter((a) => a.platform === 'windows'));
/**
 * 「未做玩家侧引导」的那一类产物。
 *
 * Windows / macOS / Android 上面都各有一张卡了，所以这里要把它们排掉 ——
 * 否则安卓包一上传，下方那句"非 Windows 产物…未做玩家侧引导"就会指向
 * 明明已经在卡片里给了下载入口的文件。
 */
const otherArtifacts = computed(
  () => artifacts.value.filter((a) => !['windows', 'macos', 'android'].includes(a.platform)),
);

/**
 * 三端下载：Windows / macOS(两种芯片) / Android 各一张卡。
 *
 * macOS 分两种芯片（Apple 芯片 / Intel），而**浏览器判断不出来** ——
 * Safari 在 M 系列机器上也会把 UA 报成 "Intel Mac OS X"。所以不猜：
 * 两个按钮都给出来，并附一句"怎么查自己的芯片"。
 * macOS 产物还没上传时（刚部署、mac 包还在构建），卡片如实说明，
 * 而不是留一个点了 404 的按钮 —— 产物一进下载目录，这里会自动出现。
 */
const detectedPlatform = computed<'windows' | 'macos' | 'android' | 'other'>(() => {
  if (typeof navigator === 'undefined') return 'other';

  /**
   * 优先用 UA-CH 的 platform（Chromium 系）：它是结构化字段，
   * 不受 UA 字符串精简的影响，也不会被"UA 里塞一堆浏览器名"搞混。
   */
  const uaChPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  if (uaChPlatform) {
    if (/windows/i.test(uaChPlatform)) return 'windows';
    if (/macos|mac os/i.test(uaChPlatform)) return 'macos';
    if (/android/i.test(uaChPlatform)) return 'android';
    if (/ios|linux|chrome os/i.test(uaChPlatform)) return 'other';
  }

  const ua = navigator.userAgent;

  /**
   * iPhone / iPad 要判成 other，**不能算 macOS**。
   * 这里有两个坑：
   *   1. 旧写法把 `iPhone|iPad` 直接归到 macos —— iOS 用户会看到"macOS"徽标；
   *   2. iPadOS 的"请求桌面网站"会让 Safari 报出和 Mac 一模一样的 UA，
   *      唯一可靠的区别是**触摸点数**（Mac 上 maxTouchPoints 为 0，iPad ≥ 1）。
   */
  const looksLikeMac = /Mac OS X|Macintosh/i.test(ua);
  const isIPadInDesktopMode = looksLikeMac && (navigator.maxTouchPoints ?? 0) > 1;
  if (looksLikeMac && !isIPadInDesktopMode) return 'macos';
  /** Android 的 UA 一直带 `Android` 字样（手机与平板都是），比"猜芯片"可靠得多 */
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'other';
  if (/Windows/i.test(ua)) return 'windows';
  return 'other';
});

const windowsArtifact = computed<DownloadArtifact | null>(() => windowsArtifacts.value[0] ?? null);
const macArmArtifact = computed<DownloadArtifact | null>(
  () => artifacts.value.find((a) => a.platform === 'macos' && a.arch === 'arm64') ?? null,
);
const macIntelArtifact = computed<DownloadArtifact | null>(
  () => artifacts.value.find((a) => a.platform === 'macos' && a.arch === 'x64') ?? null,
);
const macMissing = computed(() => !macArmArtifact.value && !macIntelArtifact.value);

/**
 * 安卓产物：优先用主控在 `/meta` 里挑好的那一个，拿不到再从产物清单里找。
 *
 * 没有 apk 时它是 null —— 卡片据此走"即将推出"的占位态，
 * 而不是渲染一个点了没反应的按钮。
 */
const androidArtifact = computed<DownloadArtifact | null>(
  () =>
    metaDownloads.value?.android ??
    artifacts.value.find((a) => a.platform === 'android') ??
    null,
);

/**
 * 安卓卡片的版本号**不能借用 `clientVersion`**。
 *
 * 实测三方版本互不一致：apk 文件名是 0.1.0、`android/package.json` 是 0.1.0、
 * 而 `android/android/app/build.gradle` 的 versionName 是 "1.0"、
 * 主控设置里的 clientVersion 是 1.0.8（那是 Windows/macOS 客户端的版本）。
 * 所以只显示**这个文件自己带的**版本，取不到就不显示，绝不把 1.0.8 挂到 apk 上。
 *
 * 顺序：主控给的 `version` 优先；老主控（还没部署这次改动）不给这个字段时，
 * 从文件名里取一段 x.y.z —— **只是显示**，不参与任何挑选逻辑
 * （"哪个 apk 是最新的"始终只由主控决定，见 androidArtifact）。
 */
const androidVersion = computed(() => {
  const artifact = androidArtifact.value;
  if (!artifact) return null;
  return artifact.version ?? /(\d+\.\d+\.\d+)/.exec(artifact.filename)?.[1] ?? null;
});

const mb = (size: number): string => `${(size / 1048576).toFixed(0)} MB`;

/**
 * 架构列：主控给的 `universal` 是"与 CPU 架构无关"（安卓 APK 没有本地库）。
 * 中文界面里直接写「通用」，不要把一个英文枚举原样丢给玩家。
 */
const archText = (arch: string): string => (arch === 'universal' ? '通用' : arch);

/**
 * 主按钮目标：服务端已把与设置里 `clientDownloadUrl` 同名的主产物排在最前，
 * 所以直接用 `artifacts[0]`；没有产物时才退回平台登记的下载地址。
 */
const primaryArtifact = computed<DownloadArtifact | null>(() => artifacts.value[0] ?? null);

const primaryUrl = computed(() => primaryArtifact.value?.url ?? data.value?.primary ?? '/downloads/');

const clientVersion = computed(() => data.value?.clientVersion ?? '0.1.0');

const requirements: Array<{ label: string; value: string }> = [
  { label: '操作系统', value: 'Windows 10 1809 及以上 / Windows 11（64 位）' },
  { label: '运行库', value: '需允许安装 EasyTier 的 TUN 虚拟网卡驱动（首次启动会请求管理员权限）' },
  { label: '网络', value: '能访问本站主控；UDP 可用时优先 P2P 直连，受限网络自动回退中继' },
  { label: '磁盘', value: '安装约 60 MB，另需少量空间存放日志与实例配置' },
  { label: '其他', value: 'EasyTier 核心随包分发；也可自行替换为官方核心（见下方说明）' },
];
</script>

<template>
  <div class="dl">
    <header class="nav">
      <div class="container nav-inner">
        <RouterLink class="brand" to="/">
          <span class="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
              <path d="M4 16.5c0-1.2 1-2.1 2.2-1.9l3.1.5 3-5.4-2.4-2.6 1.6-3.1 3.4 1 1.4 3.2 3.2.7c1.5.3 2.5 1.6 2.5 3.1" />
              <path d="M3 20h18" />
            </svg>
          </span>
          <span class="brand-text">McLink</span>
        </RouterLink>
        <div class="nav-actions">
          <RouterLink class="btn btn-ghost" to="/">返回首页</RouterLink>
          <RouterLink class="btn" to="/console/dashboard">控制台</RouterLink>
        </div>
      </div>
    </header>

    <section class="head aurora">
      <div class="container head-inner">
        <span class="badge badge-brand">客户端 v{{ clientVersion }}</span>
        <h1>下载客户端</h1>
        <p class="muted">
          安装后登录 → 选择区域 → 输入加入码即可联机。客户端会向主控申请一张短时效票据，
          自动拉起本机 EasyTier 实例，无需手动配置网络名、密钥或中继地址。
        </p>

        <!--
          四张卡，玩家自己选：Windows / macOS(Apple 芯片) / macOS(Intel) / Android。
          不做芯片"自动判断" —— 浏览器根本拿不到可靠的芯片信息
          （Safari 在 M 系列上也把 UA 报成 Intel Mac），猜错就是白下一次 130MB。
          能可靠判断的只有**平台**（Windows / macOS / Android），所以只用它做高亮。
        -->
        <div class="dl-platforms">
          <article class="dl-platform" :class="{ 'is-current': detectedPlatform === 'windows' }">
            <div class="dl-platform-head">
              <span class="dl-platform-name">Windows</span>
              <span v-if="detectedPlatform === 'windows'" class="badge badge-brand">你正在用它</span>
            </div>
            <p class="dl-platform-meta">Windows 10 1809+ / 11（64 位）· 首次启动会请求管理员权限</p>
            <a v-if="windowsArtifact" class="btn btn-primary" :href="windowsArtifact.url" download>
              下载安装包 · {{ mb(windowsArtifact.size) }}
            </a>
            <p v-else class="hint">下载目录里还没有 Windows 产物。</p>
            <template v-if="windowsArtifact">
              <p class="dl-platform-file mono">{{ windowsArtifact.filename }}</p>
              <div v-if="windowsArtifact.sha256" class="dl-platform-hash">
                <span class="dl-platform-hash-key">SHA-256</span>
                <code class="dl-platform-hash-value">{{ windowsArtifact.sha256 }}</code>
                <button
                  class="btn btn-sm btn-ghost"
                  type="button"
                  @click="copyText(windowsArtifact.sha256 ?? '', 'SHA-256')"
                >
                  复制
                </button>
              </div>
            </template>
          </article>

          <article class="dl-platform" :class="{ 'is-current': detectedPlatform === 'macos' }">
            <div class="dl-platform-head">
              <span class="dl-platform-name">macOS · Apple 芯片</span>
              <span v-if="detectedPlatform === 'macos'" class="badge badge-brand">macOS</span>
            </div>
            <p class="dl-platform-meta">M1 / M2 / M3 / M4 等 Apple 自研芯片</p>
            <a v-if="macArmArtifact" class="btn btn-primary" :href="macArmArtifact.url" download>
              下载 dmg · {{ mb(macArmArtifact.size) }}
            </a>
            <p v-else class="hint">这个架构的产物还没上传（构建完放进下载目录会自动出现）。</p>
            <p class="hint">
              怎么查芯片：左上角  →「关于本机」，写着 <b>Apple M…</b> 就是这一份；
              写着 <b>Intel</b> 请用右边那张卡。
            </p>
          </article>

          <article class="dl-platform" :class="{ 'is-current': detectedPlatform === 'macos' }">
            <div class="dl-platform-head">
              <span class="dl-platform-name">macOS · Intel</span>
              <span v-if="detectedPlatform === 'macos'" class="badge badge-brand">macOS</span>
            </div>
            <p class="dl-platform-meta">Intel 处理器的旧款 Mac</p>
            <a v-if="macIntelArtifact" class="btn" :href="macIntelArtifact.url" download>
              下载 dmg · {{ mb(macIntelArtifact.size) }}
            </a>
            <p v-else class="hint">这个架构的产物还没上传（构建完放进下载目录会自动出现）。</p>
            <p class="hint">
              未签名的包首次打开会被 Gatekeeper 拦下 —— 右键点图标选「打开」，或执行
              <code class="mono">xattr -dr com.apple.quarantine /Applications/McLink.app</code>。
            </p>
          </article>

          <!--
            安卓：**唯一的"还没准备好"平台**，所以这张卡的两种状态差别最大。
               · 有 apk → 与 Windows 卡同一套东西：版本、大小、SHA-256、下载按钮；
               · 没有 apk → 只有一句"即将推出"和一行说明，**不渲染任何按钮**。
                 留一个 href 指向不存在文件的 <a> 就是死链，所以宁可什么都不给。

            版本号取文件自己的（见 androidVersion）：主控的 clientVersion 是
            Windows/macOS 客户端的 1.0.8，挂到 apk 上就是错的。

            "你正在用它"这个徽标**不给安卓**：这张卡的位置要留给「测试版」标记 ——
            它会一直是内测签名（debug keystore）包，这件事比"你在用安卓"重要得多。
            访客自己在不在安卓上，靠卡片的琥珀描边表达就够了。
          -->
          <article class="dl-platform" :class="{ 'is-current': detectedPlatform === 'android' }">
            <div class="dl-platform-head">
              <span class="dl-platform-name">Android</span>
              <span v-if="androidArtifact" class="badge badge-warn">测试版</span>
            </div>
            <p class="dl-platform-meta">
              <template v-if="androidArtifact">
                <template v-if="androidVersion">版本 {{ androidVersion }} · </template>
                手机与平板，需允许「安装未知来源的应用」
              </template>
              <template v-else>手机与平板 · 通过 APK 安装</template>
            </p>
            <a v-if="androidArtifact" class="btn btn-primary" :href="androidArtifact.url" download>
              下载 APK · {{ mb(androidArtifact.size) }}
            </a>
            <template v-else>
              <p class="hint">
                <b>安卓版即将推出。</b>安装包还没上传到主控的下载目录；上传后这里会自动出现下载按钮。
              </p>
            </template>
            <template v-if="androidArtifact">
              <p class="dl-platform-file mono">{{ androidArtifact.filename }}</p>
              <div v-if="androidArtifact.sha256" class="dl-platform-hash">
                <span class="dl-platform-hash-key">SHA-256</span>
                <code class="dl-platform-hash-value">{{ androidArtifact.sha256 }}</code>
                <button
                  class="btn btn-sm btn-ghost"
                  type="button"
                  @click="copyText(androidArtifact.sha256 ?? '', 'SHA-256')"
                >
                  复制
                </button>
              </div>
              <!--
                ⚠️ 这里以前有一句"内测版：目前可用房间与聊天，手机端接入 MC 联机还在开发中"——
                **已经删掉**，因为那句话不再成立：安卓端 1.0.x 起，授权 VPN 后手机真的进入房间的
                虚拟局域网，可以在 MC 启动器里添加服务器直接联机（见 docs/android-vpn.md）。
                别再把它加回来 —— 卡片上那句"开发中"会让玩家以为手机上不能玩。

                仍然保留 head 上的「测试版」徽标：这个 apk 是 assembleDebug 出来的 debug 签名包，
                这个事实没变（换正式签名包时已装的用户需要先卸载）。徽标说的是"签名/发布阶段"，
                不是"功能没做完"。
              -->
            </template>
          </article>
        </div>

        <div class="cta-row">
          <a class="btn btn-lg" :href="EASYTier_RELEASES" target="_blank" rel="noreferrer noopener">
            EasyTier 官方发布页
          </a>
        </div>
      </div>
    </section>

    <main class="container stack" style="padding-top: var(--s-6); padding-bottom: var(--s-8)">
      <!-- 加载中 -->
      <div v-if="loading" class="card stack">
        <div class="skeleton" style="height: 20px; width: 30%" />
        <div class="skeleton" style="height: 44px" />
        <div class="skeleton" style="height: 44px" />
        <div class="skeleton" style="height: 44px" />
      </div>

      <!-- 失败 -->
      <div v-else-if="error" class="card stack">
        <div class="row-between">
          <div>
            <div class="panel-title">无法读取产物列表</div>
            <p class="panel-sub">{{ error }}</p>
          </div>
          <button class="btn" type="button" @click="load">重试</button>
        </div>
      </div>

      <template v-else>
        <!-- 产物列表 -->
        <section class="card stack">
          <div class="row-between">
            <div>
              <div class="panel-title">可用产物</div>
              <p class="panel-sub">主控下载目录中扫描到的安装包；Windows 安装包即主推客户端。</p>
            </div>
            <button class="btn btn-sm" type="button" @click="load">刷新列表</button>
          </div>

          <div v-if="artifacts.length === 0" class="empty">
            <p>下载目录中还没有任何安装包。</p>
            <p class="hint" style="margin-top: var(--s-2)">
              管理员请在主控的下载目录（默认 <span class="mono">server/downloads</span>，可由
              <span class="mono">MCLINK_DOWNLOADS_DIR</span> 指定）放入
              <span class="mono">McLink-Setup-&lt;版本&gt;-x64.exe</span> 等产物，
              然后在控制台「平台设置」里登记下载地址、版本号与 SHA-256 校验值。
            </p>
          </div>

          <template v-else>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>产物</th>
                    <th>平台 / 架构</th>
                    <th class="table-num">大小</th>
                    <th>SHA-256</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="a in artifacts" :key="a.id">
                    <td>
                      <div class="row" style="gap: var(--s-2)">
                        <span class="badge" :class="a.platform === 'windows' ? 'badge-brand' : 'badge-neutral'">
                          {{ a.platform }}
                        </span>
                        <span class="mono file-name" :title="a.filename">{{ a.filename }}</span>
                      </div>
                      <!--
                        主控对"认不出来的产物"会把文件名原样当 label 返回，
                        那样这一行就会把同一个文件名写两遍。重复的一行不如不显示。
                      -->
                      <div
                        v-if="a.label && a.label !== a.filename"
                        class="faint"
                        style="font-size: var(--fs-xs)"
                      >
                        {{ a.label }}
                      </div>
                    </td>
                    <td class="muted">{{ archText(a.arch) }}</td>
                    <td class="table-num">{{ formatBytes(a.size) }}</td>
                    <td>
                      <div v-if="a.sha256" class="hash-cell">
                        <code class="hash-text" :title="a.sha256">{{ a.sha256 }}</code>
                        <button class="btn btn-sm btn-ghost" type="button" @click="copyText(a.sha256, 'SHA-256')">
                          复制
                        </button>
                      </div>
                      <span v-else class="faint" style="font-size: var(--fs-xs)">未登记</span>
                    </td>
                    <td style="text-align: right">
                      <a class="btn btn-sm" :href="a.url" download>下载</a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="otherArtifacts.length > 0" class="hint">
              其它产物（{{ otherArtifacts.map((a) => a.filename).join('、') }}）同样可直接下载，但未做玩家侧引导。
            </p>
          </template>
        </section>

        <div class="grid two">
          <!-- EasyTier 核心说明 -->
          <section class="card stack">
            <div class="panel-title">关于 EasyTier 官方核心</div>
            <p class="muted" style="font-size: var(--fs-sm)">
              McLink 的组网能力完全来自
              <a class="link" :href="EASYTier_REPO" target="_blank" rel="noreferrer noopener">EasyTier</a>
              （LGPL-3.0）。中继节点与客户端实例都是独立运行的
              <span class="mono">easytier-core</span> 进程，本平台未修改其源码，
              只通过 TOML 配置与命令行参数驱动它，因此你可以自行替换核心版本。
            </p>
            <ul class="bullets">
              <li>客户端安装包内已附带与主控版本匹配的核心，正常使用无需额外下载。</li>
              <li>
                如需自带核心，请从
                <a class="link" :href="EASYTier_RELEASES" target="_blank" rel="noreferrer noopener">官方 Release</a>
                获取对应平台的 <span class="mono">easytier-core</span> 与
                <span class="mono">easytier-cli</span>，放在客户端目录下的 <span class="mono">core/</span> 中。
              </li>
              <li>核心版本差异会影响 ACL 热更新能力：旧版不支持 <span class="mono">acl set</span> 时，ACL 变更会通过重启实例生效。</li>
            </ul>
          </section>

          <!-- 校验 + 系统要求 -->
          <section class="card stack">
            <div class="panel-title">校验安装包</div>
            <p class="muted" style="font-size: var(--fs-sm)">
              建议先校验再安装。Windows 上用 PowerShell：
            </p>
            <pre class="code">Get-FileHash .\McLink-Setup-0.1.0-x64.exe -Algorithm SHA256</pre>
            <p class="muted" style="font-size: var(--fs-sm)">Linux / macOS 上：</p>
            <pre class="code">sha256sum McLink-Setup-0.1.0-x64.exe</pre>
            <p class="hint">
              与「可用产物」里该文件显示的 SHA-256 不一致时不要安装，
              并联系管理员确认来源（校验值由主控按下载目录里的实际文件计算）。
            </p>
            <button class="btn btn-sm" type="button" @click="copyText(primaryUrl, '下载地址')">
              复制下载地址
            </button>
          </section>
        </div>

        <section class="card stack">
          <div class="panel-title">系统要求</div>
          <div class="table-wrap">
            <table class="table">
              <tbody>
                <tr v-for="r in requirements" :key="r.label">
                  <td style="width: 140px" class="muted">{{ r.label }}</td>
                  <td>{{ r.value }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </main>

    <footer class="foot">
      <div class="container row-between wrap">
        <span class="faint" style="font-size: var(--fs-xs)">
          McLink v{{ clientVersion }} · 构建于 EasyTier（LGPL-3.0）之上
        </span>
        <span class="row" style="gap: var(--s-3); font-size: var(--fs-sm)">
          <a class="link" :href="EASYTier_REPO" target="_blank" rel="noreferrer noopener">EasyTier GitHub</a>
          <RouterLink class="link" to="/">返回首页</RouterLink>
        </span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.dl {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.nav {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  backdrop-filter: blur(14px);
  background: color-mix(in srgb, var(--bg-0) 72%, transparent);
  border-bottom: 1px solid var(--border);
}
.nav-inner {
  height: var(--header-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-weight: 700;
}
.brand-mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--grad-brand);
  color: var(--bg-0);
}
.brand-mark svg {
  width: 19px;
  height: 19px;
}
.brand-text {
  font-size: var(--fs-lg);
  letter-spacing: -0.02em;
}
.nav-actions {
  display: flex;
  gap: var(--s-2);
}
.head {
  padding: var(--s-8) 0 var(--s-7);
}
.head-inner {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  align-items: flex-start;
}
.head h1 {
  font-size: var(--fs-3xl);
}
.head p {
  /* 用共享令牌的阅读行宽（原来写死 60em = 870px，压过了全局 p 的 max-width，
     一行能排 ~115 个字符 —— 设计检测器的 line-length 报的就是它） */
  max-width: var(--measure);
}
.hero-hint {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.cta-row {
  display: flex;
  gap: var(--s-3);
  flex-wrap: wrap;
  margin-top: var(--s-2);
}
/* 校验值是一长串 hex：换行显示完整值，比截断成省略号更有用 */
.hero-hash {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--s-2) var(--s-3);
  margin-top: var(--s-4);
  padding: var(--s-3) var(--s-4);
  border: 1px solid var(--rule-faint);
  border-radius: var(--r-sm);
  background: var(--ink-800);
  max-width: 100%;
}
.hero-hash-key {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--paper-faint);
}
.hero-hash-value {
  flex: 1 1 24ch;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--paper-dim);
  overflow-wrap: anywhere;
}
.hash-cell {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  min-width: 0;
}
.hash-text {
  flex: 1 1 22ch;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--paper-dim);
  overflow-wrap: anywhere;
}
.file-name {
  min-width: 0;
  overflow-wrap: anywhere;
}
.grid.two {
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}
.table-wrap {
  overflow-x: auto;
}
.link {
  color: var(--brand);
}
.link:hover {
  text-decoration: underline;
}
.bullets {
  margin: 0;
  padding-left: 1.1em;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.code {
  margin: 0;
  padding: var(--s-3);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--bg-0) 60%, transparent);
  border: 1px solid var(--border);
  color: var(--text-dim);
  overflow-x: auto;
  font-size: var(--fs-xs);
}
.foot {
  margin-top: auto;
  border-top: 1px solid var(--border);
  padding: var(--s-5) 0;
  background: var(--bg-1);
}
@media (max-width: 720px) {
  .head {
    padding: var(--s-7) 0 var(--s-6);
  }
  .head h1 {
    font-size: var(--fs-2xl);
  }
}

/* ------------------------------------------------------------ 双端下载卡片 */
.dl-platforms {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--s-4);
  margin-top: var(--s-5);
  text-align: left;
  /*
   * width: 100% 是必须的：父级 .head-inner 是 `align-items: flex-start` 的 flex 列，
   * 作为 flex 子项的网格会被「收缩到内容宽度」—— 那样 auto-fit 只排得出一列，
   * 三张卡就竖着堆起来了。撑满之后三列并排。
   */
  width: 100%;
}

.dl-platform {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  background: var(--ink-800);
}

/* 访客自己的系统：琥珀描边，不用阴影/发光（设计规则） */
.dl-platform.is-current {
  border-color: var(--signal-line);
  background: var(--signal-wash);
}

.dl-platform-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}

.dl-platform-name {
  font-family: var(--font-display);
  font-size: var(--fs-lg);
  font-weight: 600;
}

.dl-platform-meta {
  margin: 0;
  color: var(--paper-dim);
  font-size: var(--fs-sm);
  line-height: var(--lh-snug);
}

.dl-platform-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}

.dl-platform-file {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  overflow-wrap: anywhere;
}

.dl-platform-hash {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  padding-top: var(--s-2);
  border-top: 1px solid var(--rule-faint);
}

.dl-platform-hash-key {
  font-size: var(--fs-xs);
  letter-spacing: var(--track-caps);
  text-transform: uppercase;
  color: var(--paper-faint);
}

.dl-platform-hash-value {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--paper-2);
  overflow-wrap: anywhere;
}
</style>
