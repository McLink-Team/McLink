<script setup lang="ts">
/**
 * 玩家侧落地页（首页）。
 * 首屏只依赖两个公开接口：`/meta`（平台统计）与 `/regions`（区域可用性），
 * 任一失败都降级为占位内容，绝不让首屏白屏。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { REGIONS, Routes, Topics, type ServerEvent } from '@mclink/shared';
import { api, friendlyError } from '../lib/api.ts';
import { RealtimeClient } from '../lib/realtime.ts';

/** GET /meta */
interface PlatformMeta {
  siteName: string;
  siteTagline: string;
  version: string;
  serverTime: string;
  uptimeSeconds: number;
  registrationOpen: boolean;
  announcement: string | null;
  relayPort: number;
  easytierVersion: string | null;
  clientVersion: string;
  clientDownloadUrl: string;
  stats: {
    onlineNodes: number;
    totalNodes: number;
    openRooms: number;
    onlinePlayers: number;
    users: number;
    relayPeers: number;
    relayRxBps: number;
    relayTxBps: number;
    foreignNetworks: number;
  };
}

/** GET /regions */
interface RegionAvailability {
  id: string;
  label: string;
  hint: string;
  onlineNodes: number;
  peers: number;
  capacity: number;
}

const meta = ref<PlatformMeta | null>(null);
const regions = ref<RegionAvailability[]>([]);
const metaError = ref<string | null>(null);
const regionsError = ref<string | null>(null);
const loading = ref(true);

const EASYTier_REPO = 'https://github.com/EasyTier/EasyTier';
const EASYTier_SITE = 'https://www.easytier.cn/';

async function loadMeta(): Promise<void> {
  try {
    meta.value = await api.get<PlatformMeta>(Routes.meta);
    metaError.value = null;
  } catch (err) {
    metaError.value = friendlyError(err);
  }
}

async function loadRegions(): Promise<void> {
  try {
    regions.value = await api.get<RegionAvailability[]>(Routes.regions);
    regionsError.value = null;
  } catch (err) {
    regionsError.value = friendlyError(err);
  }
}

async function reload(): Promise<void> {
  loading.value = true;
  await Promise.all([loadMeta(), loadRegions()]);
  loading.value = false;
}

/* --------------------------------------------------------------- 实时 */

let client: RealtimeClient | null = null;
let lastRefresh = 0;

onMounted(() => {
  void reload();
  client = new RealtimeClient({
    topics: [Topics.platform],
    onEvent: (event: ServerEvent) => {
      if (event.type !== 'traffic.tick') return;
      // 平台心跳每 6 秒一次，落地页没必要跟着打接口，节流到 15 秒
      const now = Date.now();
      if (now - lastRefresh < 15_000) return;
      lastRefresh = now;
      void loadMeta();
    },
  });
  client.connect();
});

onUnmounted(() => {
  client?.close();
  client = null;
});

/* --------------------------------------------------------------- 派生 */

const siteName = computed(() => meta.value?.siteName ?? 'mclink');
const tagline = computed(
  () => meta.value?.siteTagline ?? '基于 EasyTier 的《我的世界》联机平台 —— 一个加入码，和朋友直接开黑',
);
const version = computed(() => meta.value?.version ?? '0.1.0');
const easytierVersion = computed(() => meta.value?.easytierVersion ?? null);
const announcement = computed(() => meta.value?.announcement ?? null);
const registrationOpen = computed(() => meta.value?.registrationOpen ?? true);

const heroStats = computed(() => {
  const s = meta.value?.stats;
  return [
    { label: '在线中继节点', value: s ? `${s.onlineNodes}` : '—', hint: s ? `共 ${s.totalNodes} 个` : '数据加载中' },
    { label: '开放房间', value: s ? `${s.openRooms}` : '—', hint: s ? `${s.foreignNetworks} 个网络经由中继` : '数据加载中' },
    { label: '在线玩家', value: s ? `${s.onlinePlayers}` : '—', hint: s ? `累计 ${s.users} 位玩家` : '数据加载中' },
    { label: '中继直连 peer', value: s ? `${s.relayPeers}` : '—', hint: '主控中继实时连接数' },
  ];
});

/** 接口没数据时用 REGIONS 兜底，保证区域区块结构完整而不是空一片 */
const regionRows = computed<RegionAvailability[]>(() => {
  if (regions.value.length > 0) return regions.value;
  return REGIONS.map((r) => ({ id: r.id, label: r.label, hint: r.hint, onlineNodes: 0, peers: 0, capacity: 0 }));
});

const totalRegionNodes = computed(() => regionRows.value.reduce((acc, r) => acc + r.onlineNodes, 0));

const steps = [
  {
    no: '01',
    title: '下载 Windows 客户端',
    desc: '安装包内置接驳流程，双击即用；不需要手动配置 TUN 驱动参数，也不必懂 EasyTier。',
  },
  {
    no: '02',
    title: '登录并选择区域',
    desc: '用平台账号登录，选一个延迟最低的就近区域；也可以交给主控自动按延迟与负载挑选。',
  },
  {
    no: '03',
    title: '创建 / 加入房间',
    desc: '房主创建房间拿到 6 位加入码；客机加入后，在游戏里打开「多人游戏」就能直接看到房间。',
  },
];

const features: Array<{ icon: string; title: string; desc: string; tag: string }> = [
  {
    icon: 'M12 3 3 7.5 12 12l9-4.5L12 3Zm-9 9 9 4.5L21 12M3 16.5 12 21l9-4.5',
    title: '单端口多房间隔离',
    desc: '所有房间共用主控中继的一个端口，但每个房间是独立的 EasyTier 网络（随机网络名 + 密钥派生），互相不可发现、不可通信。',
    tag: '核心架构',
  },
  {
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.6 2.6 2.6 15.4 0 18M3.2 9h17.6M3.2 15h17.6',
    title: '就近区域中继',
    desc: '华东 / 华南 / 华北等大区可按需铺子节点，主控按实时负载与剩余容量调度，玩家只连离自己最近的那台。',
    tag: '低延迟',
  },
  {
    icon: 'M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-10 0V9ZM12 17v4',
    title: 'NAT 穿透与 P2P 直连',
    desc: 'EasyTier 自动打洞，能直连就直连，省下中继带宽；打不通时自动回退到中继，不会卡在「连不上」。',
    tag: '更省带宽',
  },
  {
    icon: 'M12 3l7 3v6c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6l7-3Zm-2.6 8.8 2 2 4.1-4.1',
    title: '房主权限与踢人',
    desc: '房主拥有房间控制权：审批加入、一键踢人（按虚拟 IP 下发 ACL 丢弃规则）、轮换房间密钥让旧票据立即失效。',
    tag: '可控',
  },
  {
    icon: 'M4 19V5m0 14h16M8 19v-6m4 6V9m4 10v-4',
    title: '流量统计与限速',
    desc: '房间、节点、平台三级流量账本，月度配额与单房带宽上限都能落地；超额自动提示，不靠玩家自觉。',
    tag: '可计量',
  },
  {
    icon: 'M12 3v11m0 0-4-4m4 4 4-4M5 20h14',
    title: 'Windows 一键安装',
    desc: '安装包自带客户端界面与核心接驳逻辑，登录 → 选区域 → 进房间三步完成，无需命令行。',
    tag: '开箱即用',
  },
];

const faqs: Array<{ q: string; a: string }> = [
  {
    q: '需要自己会配 EasyTier 或者有公网 IP 吗？',
    a: '都不需要。你只要装好客户端并登录即可，虚拟网络、密钥、中继地址都由主控下发。房主也不需要公网 IP —— 所有玩家都经中继或 P2P 直连进入同一个虚拟网络。',
  },
  {
    q: '朋友怎么进我的房间？',
    a: '把 6 位加入码发给他，他在客户端里输入加入码即可。房主也可以在「多人游戏」里直接开局域网世界 —— 虚拟网络支持 UDP 广播中继，所以其他人刷新一下多人游戏列表就能看到你的房间。',
  },
  {
    q: '为什么游戏里要用虚拟 IP 而不是加入码？',
    a: '加入码用来加入虚拟网络；进入网络后，每个成员会得到一个 10.200.x.x 的虚拟地址。房主在「多人游戏」里开好房间后，客机在「直接连接」里填房主的虚拟地址即可（广播中继正常时列表里也能直接看到）。',
  },
  {
    q: '房间之间会不会串台？',
    a: '不会。每个房间是独立的 EasyTier 网络，网络名由 32 字节随机密钥派生，中继只按网络名转发。房主轮换密钥时，网络名会一起变化，被踢出的玩家手里的旧凭证立刻作废。',
  },
  {
    q: '延迟高、卡顿怎么办？',
    a: '先在客户端里换一个更近的区域；能 P2P 直连的成员之间会绕开中继。若整个中继都在告警，页面顶部的在线节点数会下降，可以稍后再试或联系管理员排查。',
  },
  {
    q: '流量是怎么算的？会不会超？',
    a: '按房间维度累计收发字节数，计入账号的月度配额。房主可以在建房时设置房间总带宽上限与单成员上限，避免一个人把带宽占满。',
  },
];

const showErrorBanner = computed(() => metaError.value !== null || regionsError.value !== null);
</script>

<template>
  <div class="landing">
    <!-- ------------------------------------------------------------ 顶部导航 -->
    <header class="nav">
      <div class="container nav-inner">
        <a class="brand" href="#top">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
              <path d="M4 16.5c0-1.2 1-2.1 2.2-1.9l3.1.5 3-5.4-2.4-2.6 1.6-3.1 3.4 1 1.4 3.2 3.2.7c1.5.3 2.5 1.6 2.5 3.1" />
              <path d="M3 20h18" />
            </svg>
          </span>
          <span class="brand-text">mclink</span>
        </a>
        <nav class="nav-links">
          <a href="#features">特性</a>
          <a href="#how">如何联机</a>
          <a href="#faq">常见问题</a>
        </nav>
        <div class="nav-actions">
          <RouterLink class="btn btn-ghost" to="/console/dashboard">控制台</RouterLink>
          <RouterLink class="btn btn-primary" to="/download">下载客户端</RouterLink>
        </div>
      </div>
    </header>

    <!-- ------------------------------------------------------------------ Hero -->
    <section id="top" class="hero aurora">
      <div class="container hero-inner">
        <div class="hero-copy">
          <span class="badge badge-brand">
            <span class="dot" style="background: var(--brand)" />
            基于 EasyTier · {{ easytierVersion ? `核心 ${easytierVersion}` : '单端口共享中继' }}
          </span>
          <h1 class="hero-title">
            和朋友一起开黑，<br />
            只要一个<span class="grad-text">加入码</span>
          </h1>
          <p class="hero-sub">{{ tagline }}</p>
          <div class="hero-cta">
            <RouterLink class="btn btn-primary btn-lg" to="/download">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M12 4v10m0 0-4-4m4 4 4-4M5 19h14" />
              </svg>
              下载 Windows 客户端
            </RouterLink>
            <a class="btn btn-lg" href="#how">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M10 8.5 16 12l-6 3.5z" />
              </svg>
              查看如何联机
            </a>
          </div>
          <p class="hero-note faint">
            版本 {{ version }} · 客户端 {{ meta?.clientVersion ?? '0.1.0' }} ·
            中继端口 {{ meta?.relayPort ?? 11010 }} ·
            {{ registrationOpen ? '当前开放注册' : '当前仅管理员开号' }}
          </p>
        </div>

        <div class="hero-stats">
          <div v-for="s in heroStats" :key="s.label" class="card stat-tile">
            <div class="stat-tile-label">{{ s.label }}</div>
            <div class="stat-tile-value">{{ s.value }}</div>
            <div class="stat-tile-hint faint">{{ s.hint }}</div>
          </div>
        </div>
      </div>
    </section>

    <div class="container">
      <!-- 公告 -->
      <div v-if="announcement" class="notice card">
        <span class="badge badge-info">公告</span>
        <span>{{ announcement }}</span>
      </div>

      <!-- 接口失败降级：不白屏，给出原因与重试 -->
      <div v-if="showErrorBanner" class="warn-bar">
        <div class="row wrap" style="gap: var(--s-3)">
          <span class="badge badge-warn">部分数据不可用</span>
          <span class="grow">
            {{ metaError ?? regionsError }}
            <template v-if="metaError">（平台统计已降级为占位值）</template>
          </span>
          <button class="btn btn-sm" type="button" :disabled="loading" @click="reload">
            <span v-if="loading" class="spinner" />
            重试
          </button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------------ 三步联机 -->
    <section id="how" class="section">
      <div class="container">
        <div class="section-head">
          <h2>三步联机</h2>
          <p class="muted">从下载到在游戏里看到好友，正常不超过两分钟。</p>
        </div>
        <div class="steps">
          <article v-for="s in steps" :key="s.no" class="card card-hover step">
            <span class="step-no">{{ s.no }}</span>
            <h3>{{ s.title }}</h3>
            <p class="muted">{{ s.desc }}</p>
          </article>
        </div>
        <p class="hint steps-hint">
          进服提示：房主在「多人游戏 → 对局域网开放」后，客机刷新多人游戏列表即可看到房间；若列表未出现，改用「直接连接」填房主虚拟地址。
        </p>
      </div>
    </section>

    <!-- -------------------------------------------------------------- 特性 -->
    <section id="features" class="section">
      <div class="container">
        <div class="section-head">
          <h2>为什么用 mclink</h2>
          <p class="muted">为「几个人偶尔联机」这件事做的取舍：不要虚拟局域网配置，不要端口映射。</p>
        </div>
        <div class="features">
          <article v-for="f in features" :key="f.title" class="card card-hover feature">
            <div class="feature-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path :d="f.icon" />
              </svg>
            </div>
            <div class="row-between" style="gap: var(--s-2)">
              <h3>{{ f.title }}</h3>
              <span class="badge badge-neutral">{{ f.tag }}</span>
            </div>
            <p class="muted">{{ f.desc }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- -------------------------------------------------------------- 区域 -->
    <section id="regions" class="section">
      <div class="container">
        <div class="section-head">
          <h2>区域与可用中继</h2>
          <p class="muted">
            当前共 {{ totalRegionNodes }} 个在线中继节点。选择离自己最近的区域，延迟通常能降一半。
          </p>
        </div>
        <div v-if="regionsError" class="empty card">
          {{ regionsError }}
          <div style="margin-top: var(--s-3)">
            <button class="btn btn-sm" type="button" @click="loadRegions">重试</button>
          </div>
        </div>
        <div v-else class="region-grid">
          <div v-for="r in regionRows" :key="r.id" class="card region-item">
            <div class="row-between">
              <strong>{{ r.label }}</strong>
              <span class="badge" :class="r.onlineNodes > 0 ? 'badge-ok' : 'badge-neutral'">
                <span class="dot" :style="{ background: r.onlineNodes > 0 ? 'var(--ok)' : 'var(--text-faint)' }" />
                {{ r.onlineNodes > 0 ? `${r.onlineNodes} 节点在线` : '暂无在线节点' }}
              </span>
            </div>
            <div class="region-hint faint">{{ r.hint }}</div>
            <div class="region-meta">
              <span>承载 peer：{{ r.peers }}</span>
              <span>容量：{{ r.capacity }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- -------------------------------------------------------------- FAQ -->
    <section id="faq" class="section">
      <div class="container">
        <div class="section-head">
          <h2>常见问题</h2>
          <p class="muted">还有疑问？登录后可以在控制台看到平台公告与当前节点状态。</p>
        </div>
        <div class="faq">
          <details v-for="f in faqs" :key="f.q" class="card faq-item">
            <summary>
              <span>{{ f.q }}</span>
              <span class="faq-chevron" aria-hidden="true">+</span>
            </summary>
            <p class="muted">{{ f.a }}</p>
          </details>
        </div>
      </div>
    </section>

    <!-- ------------------------------------------------------------- 页脚 -->
    <footer class="foot">
      <div class="container foot-inner">
        <div>
          <div class="row" style="gap: var(--s-2)">
            <span class="brand-text">mclink</span>
            <span class="badge badge-neutral">v{{ version }}</span>
          </div>
          <p class="faint" style="margin-top: var(--s-2)">
            {{ siteName }} · 本站源码以 AGPL-3.0-or-later 授权；底层组网能力来自 EasyTier（LGPL-3.0），
            本平台未修改其源码，仅以独立进程调用其核心与 CLI。
          </p>
        </div>
        <div class="foot-links">
          <a :href="EASYTier_REPO" target="_blank" rel="noreferrer noopener">EasyTier GitHub</a>
          <a :href="EASYTier_SITE" target="_blank" rel="noreferrer noopener">EasyTier 官网</a>
          <RouterLink to="/download">下载客户端</RouterLink>
          <RouterLink to="/console/dashboard">管理控制台</RouterLink>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.landing {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* ------------------------------------------------------------------ 导航 */
.nav {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  backdrop-filter: blur(14px);
  background: rgba(5, 7, 15, 0.72);
  border-bottom: 1px solid var(--border);
}
.nav-inner {
  height: var(--header-h);
  display: flex;
  align-items: center;
  gap: var(--s-5);
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
  color: #04121a;
}
.brand-mark svg {
  width: 19px;
  height: 19px;
}
.brand-text {
  font-size: var(--fs-lg);
  letter-spacing: -0.02em;
}
.nav-links {
  display: flex;
  gap: var(--s-5);
  margin-left: auto;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.nav-links a:hover {
  color: var(--text);
}
.nav-actions {
  display: flex;
  gap: var(--s-2);
}

/* -------------------------------------------------------------------- Hero */
.hero {
  padding: var(--s-9) 0 var(--s-8);
}
.hero-inner {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  gap: var(--s-7);
  align-items: center;
}
.hero-copy {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  align-items: flex-start;
}
.hero-title {
  font-size: var(--fs-4xl);
  line-height: 1.1;
}
.grad-text {
  background: var(--grad-brand);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.hero-sub {
  font-size: var(--fs-lg);
  color: var(--text-dim);
  max-width: 34em;
}
.hero-cta {
  display: flex;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.hero-note {
  font-size: var(--fs-xs);
}
.hero-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-3);
}
.stat-tile {
  padding: var(--s-4);
  background: rgba(10, 15, 30, 0.62);
}
.stat-tile-label {
  font-size: var(--fs-xs);
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.stat-tile-value {
  font-size: var(--fs-2xl);
  font-weight: 680;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}
.stat-tile-hint {
  font-size: var(--fs-xs);
}

/* ------------------------------------------------------------------- 区块 */
.notice {
  margin-top: var(--s-6);
  display: flex;
  align-items: center;
  gap: var(--s-3);
  border-color: rgba(92, 200, 255, 0.3);
}
.warn-bar {
  margin-top: var(--s-4);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  border: 1px solid rgba(255, 200, 74, 0.28);
  color: var(--text);
  font-size: var(--fs-sm);
}
.section {
  padding: var(--s-8) 0;
}
.section-head {
  margin-bottom: var(--s-5);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  max-width: 46em;
}
.section-head h2 {
  font-size: var(--fs-2xl);
}
.section-head p {
  font-size: var(--fs-base);
}

.steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s-4);
}
.step {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  position: relative;
}
.step-no {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--brand);
  letter-spacing: 0.08em;
}
.step h3 {
  font-size: var(--fs-lg);
}
.steps-hint {
  display: block;
  margin-top: var(--s-4);
}

.features {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s-4);
}
.feature {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.feature h3 {
  font-size: var(--fs-base);
}
.feature p {
  font-size: var(--fs-sm);
}
.feature-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  color: var(--brand);
  background: rgba(53, 224, 200, 0.12);
  border: 1px solid rgba(53, 224, 200, 0.24);
}

.region-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--s-3);
}
.region-item {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-4);
}
.region-hint {
  font-size: var(--fs-xs);
}
.region-meta {
  display: flex;
  gap: var(--s-4);
  font-size: var(--fs-xs);
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.faq {
  display: grid;
  gap: var(--s-3);
}
.faq-item {
  padding: 0;
  overflow: hidden;
}
.faq-item summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  padding: var(--s-4) var(--s-5);
  font-weight: 560;
}
.faq-item summary::-webkit-details-marker {
  display: none;
}
.faq-item p {
  padding: 0 var(--s-5) var(--s-4);
  font-size: var(--fs-sm);
}
.faq-chevron {
  color: var(--text-faint);
  font-family: var(--font-mono);
  transition: transform var(--dur) var(--ease);
}
.faq-item[open] .faq-chevron {
  transform: rotate(45deg);
  color: var(--brand);
}

/* ------------------------------------------------------------------- 页脚 */
.foot {
  margin-top: auto;
  border-top: 1px solid var(--border);
  padding: var(--s-6) 0;
  background: var(--bg-1);
}
.foot-inner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-5);
  flex-wrap: wrap;
}
.foot-inner p {
  font-size: var(--fs-xs);
  max-width: 52em;
}
.foot-links {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.foot-links a:hover {
  color: var(--brand);
}

/* ------------------------------------------------------------------ 响应 */
@media (max-width: 1000px) {
  .hero-inner {
    grid-template-columns: minmax(0, 1fr);
  }
  .features,
  .steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 720px) {
  .hero {
    padding: var(--s-7) 0 var(--s-6);
  }
  .hero-title {
    font-size: var(--fs-3xl);
  }
  .nav-links {
    display: none;
  }
  .nav-inner {
    gap: var(--s-3);
  }
  .nav-actions {
    margin-left: auto;
  }
  .features,
  .steps,
  .hero-stats {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
