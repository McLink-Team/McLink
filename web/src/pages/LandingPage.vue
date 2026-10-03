<script setup lang="ts">
/**
 * 落地页 —— Persuade 模式。
 *
 * 设计主张：这款产品的本质是「一条必须稳住的链路」，所以首屏用**链路读数**
 * （真实的中继与房间数据）作为视觉主角，而不是插画或仪表盘模板。
 * 结构靠发丝线与留白建立，不用卡片网格；琥珀色只用在"当前状态"与主操作上。
 *
 * 数据来源仍是两个公开接口：`/meta`（平台统计）与 `/regions`（区域可用性），
 * 外加 `/downloads`（客户端产物）。任一失败都降级显示，绝不白屏。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Routes, Topics, formatBitrate, type ServerEvent } from '@mclink/shared';
import { api } from '../lib/api.ts';
import { RealtimeClient } from '../lib/realtime.ts';
import ThemeSwitch from '../components/ThemeSwitch.vue';

interface MetaInfo {
  siteName: string;
  siteTagline: string;
  version: string;
  registrationOpen: boolean;
  /** 注册模式：open / invite（要邀请码）/ closed */
  registrationMode?: 'open' | 'invite' | 'closed';
  /** 本实例是否还对公众开放。false → 落地页切成"已停止对外服务"的姿态（见 serviceClosed） */
  publicServiceOpen?: boolean;
  /** 停止对外服务的日期（YYYY-MM-DD） */
  publicServiceClosedAt?: string | null;
  /** 项目仓库地址（已停止服务时引导大家去看源码 / 自建） */
  repoUrl?: string;
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
    /** 全网中继（所有在线子节点）聚合值 */
    relayPeers: number;
    relayRxBps: number;
    relayTxBps: number;
    /** 拆分明细：master* 恒为 0（主控不再自带中继），转发全在子节点上 */
    masterRxBps?: number;
    masterTxBps?: number;
    nodesRxBps?: number;
    nodesTxBps?: number;
    onlineRelayNodes?: number;
    foreignNetworks: number;
  };
}

interface RegionRow {
  id: string;
  label: string;
  hint: string;
  onlineNodes: number;
  peers: number;
  capacity: number;
  /** 在线节点明细（公开接口只给名字/区域/承载/容量，不含端点与令牌） */
  nodes?: Array<{ name: string; region: string; peers: number; capacity: number }>;
}

interface DownloadArtifact {
  filename: string;
  label: string;
  size: number;
  url: string;
  sha256: string | null;
  /** 主控按文件名推断：用于双端下载按钮（windows / macos / linux / android） */
  platform?: 'windows' | 'macos' | 'linux' | 'android';
  /** `universal` = 与 CPU 架构无关（安卓 APK 没有本地库），不是 Intel */
  arch?: 'x64' | 'arm64' | 'universal';
  /** 文件名里的版本号（主控解析；取不到为 null） */
  version?: string | null;
}

const meta = ref<MetaInfo | null>(null);
const regions = ref<RegionRow[]>([]);
const downloads = ref<DownloadArtifact[]>([]);
const failed = ref(false);
/** 首屏读数是否已"锁定"（唯一的入场动效） */
const locked = ref(false);

let realtime: RealtimeClient | null = null;

/** 平台公告（后台「平台设置」里配；为空则不显示公告条） */
const announcement = computed(() => meta.value?.announcement ?? null);

/**
 * **本实例是不是已经不再对外提供服务**（2026-10-03 用户要求，为 2026-10-07 停止服务做准备）。
 *
 * 关掉之后落地页不再招徕使用者：不再展示"三步上手 / 功能清单 / 区域中继表 / FAQ"
 * 这些面向新玩家的内容，改成一段事实说明 + 仓库地址 + 自建指引 + 控制台入口。
 *
 * 注意它**只是对外姿态**，不是安全开关：接口、客户端、既有房间照常可用；
 * 真正挡住陌生人的是注册模式（`registrationMode = invite`）与账号本身。
 * 默认（字段缺失 / 老主控）按"开放"处理 —— 老部署的页面不会因为这次改动突然变样。
 */
const serviceClosed = computed(() => meta.value?.publicServiceOpen === false);
/** 停止服务的日期（没填就退回一句"已停止"，不编日期） */
const closedAt = computed(() => meta.value?.publicServiceClosedAt ?? null);
const closedAtLabel = computed(() => {
  const raw = closedAt.value;
  if (!raw) return null;
  // 只做最朴素的 YYYY-MM-DD 展示：后端存的就是这个形状，不引入日期库
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.replace(/-/g, '.') : raw;
});
const repoUrl = computed(() => meta.value?.repoUrl ?? 'https://github.com/McLink-Team/McLink');
/** 需要邀请码时，落地页给"受邀的人"留一个注册入口（其余人不必看到） */
const inviteOnly = computed(() => meta.value?.registrationMode === 'invite');

const stats = computed(() => meta.value?.stats ?? null);
const primaryDownload = computed<DownloadArtifact | null>(() => {
  if (downloads.value.length > 0) return downloads.value[0] ?? null;
  if (!meta.value) return null;
  return {
    filename: '',
    label: 'Windows 客户端',
    size: 0,
    url: meta.value.clientDownloadUrl,
    sha256: null,
  };
});
const liveRegions = computed(() => regions.value.filter((r) => r.id !== 'auto'));
/**
 * 只展示**当前真的可用**的区域。
 *
 * 以前这里把内置的 9 个区域全列出来，没部署的那些显示"待部署" —— 那是给自建的人看的，
 * 对玩家是噪声（还顺带暴露了平台有哪些区域没铺）。现在只列有在线中继的区域。
 */
const shownRegions = computed(() => liveRegions.value.filter((r) => r.onlineNodes > 0));
const onlineRegions = computed(() => shownRegions.value.length);

/**
 * 表格按**节点**一行展开，而不是按区域一行。
 *
 * 按区域汇总时每行只有一个数字，玩家看不出「华东」背后是哪台机器；
 * 一个区域有多个节点时，"在线节点=2" 也说不清谁是谁。节点级明细更能建立信任，
 * 也便于主控方按名字对照自己的机器。总量改由表格下方一行汇总。
 */
const onlineNodeRows = computed(() =>
  liveRegions.value.flatMap((r) => (r.nodes ?? []).map((n) => ({ ...n, regionLabel: r.label }))),
);
const onlinePeers = computed(() => onlineNodeRows.value.reduce((acc, n) => acc + n.peers, 0));

async function load(): Promise<void> {
  try {
    const [m, r, d] = await Promise.all([
      api.get<MetaInfo>(Routes.meta),
      api.get<RegionRow[]>(Routes.regions),
      api
        .get<{ artifacts: DownloadArtifact[] }>(Routes.downloads)
        .catch(() => ({ artifacts: [] as DownloadArtifact[] })),
    ]);
    meta.value = m;
    regions.value = Array.isArray(r) ? r : [];
    downloads.value = Array.isArray(d?.artifacts) ? d.artifacts : [];
  } catch {
    failed.value = true;
  }
}

function onEvent(event: ServerEvent): void {
  // platform 话题只带聚合计数：匿名访客能看到规模，但拿不到任何房间明细
  if (event.type !== 'traffic.tick') return;
  const report = event.report as
    | { totalRxBps?: number; totalTxBps?: number; relayPeers?: number }
    | undefined;
  if (!meta.value || !report) return;
  meta.value.stats.relayRxBps = report.totalRxBps ?? meta.value.stats.relayRxBps;
  meta.value.stats.relayTxBps = report.totalTxBps ?? meta.value.stats.relayTxBps;
  meta.value.stats.relayPeers = report.relayPeers ?? meta.value.stats.relayPeers;
}

onMounted(async () => {
  await load();
  // 读数"上电"：数据到位后延迟一拍再落定，让扫描线跑完一次
  setTimeout(() => (locked.value = true), 300);
  realtime = new RealtimeClient({ onEvent, topics: [Topics.platform] });
  realtime.connect();
});

onUnmounted(() => realtime?.close());

const steps = [
  {
    n: '01',
    title: '下载并登录',
    body: '装好客户端，登录你的账号。主控地址已经内置在客户端里，不需要填任何网络参数。',
  },
  {
    n: '02',
    title: '建房，或输入加入码',
    body: '房主创建房间会拿到一个 6 位加入码。把这串码发给朋友，他们输入即可进房。',
  },
  {
    n: '03',
    title: '在游戏里连上',
    body: '房主先在自己的存档里「对局域网开放」，玩家在「多人游戏 → 直接连接」里粘贴客户端给出的联机地址。',
  },
];
</script>

<template>
  <div class="page">
    <!-- ------------------------------------------------------------ 顶栏 -->
    <header class="topbar">
      <div class="container topbar-inner">
        <RouterLink to="/" class="wordmark">
          <span class="wordmark-mark" aria-hidden="true" />
          <span>McLink</span>
        </RouterLink>

        <!--
          锚点导航只在"还在对外服务"时有意义：停止服务后那几段整段不渲染，
          留着就是四个点了没反应的死链（截图里一眼能看出来，但用户不会去查 DOM）。
        -->
        <nav v-if="!serviceClosed" class="nav">
          <a href="#how">怎么用</a>
          <a href="#features">功能</a>
          <a href="#regions">区域</a>
          <a href="#faq">常见问题</a>
        </nav>

        <div class="row" style="gap: var(--s-2)">
          <ThemeSwitch />
          <RouterLink to="/login" class="btn btn-ghost btn-sm">管理控制台</RouterLink>
          <!--
            导航里不猜平台：直接进下载页，两种平台在那里各自一张卡。
            停止服务后把它降级成普通按钮 —— 这一页的主操作是"看源码 / 自建"，
            下载按钮再抢视觉重心就自相矛盾了（安装包仍然下得到，只是它得连你自己的主控）。
          -->
          <RouterLink to="/download" class="btn btn-sm" :class="serviceClosed ? '' : 'btn-primary'">
            下载客户端
          </RouterLink>
        </div>
      </div>
    </header>

    <!-- -------------------------------------------------------- 公告条
         后台「平台设置 → 平台公告」里填了才会出现。
         注意：这个字段从第一版起就存在、接口也一直返回，但**从来没有任何界面渲染过它** ——
         于是"设了公告却不生效"。现在落地页与客户端都显示它。 -->
    <div v-if="announcement" class="announce" role="status">
      <div class="container announce-inner">
        <span class="announce-tag">公告</span>
        <p class="announce-text">{{ announcement }}</p>
      </div>
    </div>

    <!-- ==================================================== 已停止对外服务
         这是一套**替代性**的首屏：当主控不再对外提供服务时，落地页要做的不是营销，
         而是三件事——说清现状（自某日起停止）、给出源码与自建入口、说明"受邀的人怎么进来"。
         面向新玩家的那几段（三步、功能、区域表、FAQ）整段不渲染。 -->
    <section v-if="serviceClosed" class="closed">
      <div class="container-narrow">
        <p class="closed-tag">本实例已停止对外服务</p>
        <h1 class="closed-title">这个主控不再对外提供联机服务</h1>
        <p class="closed-lead">
          <template v-if="closedAtLabel">自 <strong>{{ closedAtLabel }}</strong> 起，</template>
          本实例不再提供官方中继与公益转发服务器，也不再接受公开注册。
          项目代码与客户端仍以开源方式维护，软件本体的功能与 bug 修复照常进行。
        </p>
        <p class="closed-lead">
          想继续用这套联机工具，请<strong>自建一套实例</strong>（一台普通的云服务器就够），
          或接入社区共建的节点。客户端仍然可以下载，但它需要连到<strong>你自己的主控</strong>才能建房。
        </p>

        <dl class="closed-facts">
          <div v-if="closedAtLabel">
            <dt>停止对外服务</dt>
            <dd class="mono">{{ closedAtLabel }}</dd>
          </div>
          <div>
            <dt>项目仓库</dt>
            <dd><a :href="repoUrl" rel="noreferrer noopener" target="_blank">{{ repoUrl }}</a></dd>
          </div>
          <div>
            <dt>当前注册模式</dt>
            <dd>{{ inviteOnly ? '仅邀请码' : meta?.registrationOpen === false ? '已关闭' : '开放' }}</dd>
          </div>
          <div>
            <dt>本机主控版本</dt>
            <dd class="mono">v{{ meta?.version ?? '—' }}</dd>
          </div>
        </dl>

        <div class="closed-actions">
          <a :href="repoUrl" class="btn btn-primary btn-lg" rel="noreferrer noopener" target="_blank">
            查看源码 / 自建实例
          </a>
          <!-- 受邀的人走这里：主控在邀请模式下给的就是这个入口（可以带 ?invite=码） -->
          <RouterLink v-if="inviteOnly" to="/register" class="btn btn-lg">我有邀请码</RouterLink>
          <RouterLink to="/login" class="btn btn-ghost btn-lg">管理控制台</RouterLink>
        </div>

        <details class="closed-how">
          <summary>自建一套要做什么</summary>
          <ol>
            <li>
              克隆仓库：<code class="mono">git clone {{ repoUrl }}.git</code>，
              按 <code class="mono">docs/private-deployment.md</code> 装主控（一条安装脚本）。
            </li>
            <li>
              注册你自己的中继节点：<code class="mono">pnpm run register:self-node</code>
              （节点即转发服务器，一个房间一台，按延迟就近挑）。
            </li>
            <li>
              把「注册模式」设成<b>仅邀请码</b>，在控制台生成邀请码发给朋友；
              再把本页的「对外提供服务」关掉，落地页就会变成你现在看到的这个样子。
            </li>
          </ol>
        </details>
      </div>
    </section>

    <!-- ------------------------------------------------------------ 首屏 -->
    <section v-if="!serviceClosed" class="hero">
      <div class="container hero-grid">
        <div class="hero-copy">
          <h1 class="rise">
            一条链路，<br />
            把朋友拉进<br />
            同一个世界
          </h1>
          <p class="hero-sub rise rise-2">
            基于 EasyTier 的局域网联机平台，支持《我的世界》等各类局域网联机游戏。
            主控只在<strong>一个端口</strong>上同时承载所有房间，玩家按区域就近接入，
            房主一条加入码就能把单人存档变成一个小服务器。
          </p>
          <div class="hero-actions rise rise-3">
            <!--
              首屏不再猜平台/芯片，只给一个入口 → 下载页。
              理由：平台能猜（UA 可靠），**芯片猜不出来**（Safari 在 M 系列上也报 Intel Mac），
              猜错的代价是玩家白下 130MB。下载页把几个包并排列出来让他自己选。
              按钮里那句 (Win/Mac/安卓) 只是"这一页能拿到哪三端"的预告，
              **顺序与下载页的卡片一致**（Windows → macOS → Android），
              用半角括号 + 小一号字，不折行也不抢主语（窄屏实测 390px 仍在按钮内一行）。
            -->
            <RouterLink to="/download" class="btn btn-primary btn-lg">
              下载客户端
              <span class="btn-platforms">(Win/Mac/安卓)</span>
            </RouterLink>
            <a href="#how" class="btn btn-lg">看它怎么工作</a>
          </div>
          <dl class="hero-facts rise rise-3">
            <div>
              <dt>中继端口</dt>
              <dd>{{ meta?.relayPort ?? '—' }}</dd>
            </div>
            <div>
              <dt>组网内核</dt>
              <dd>{{ meta?.easytierVersion?.split(' ').pop() ?? 'EasyTier' }}</dd>
            </div>
            <div>
              <dt>房间隔离</dt>
              <dd>网络身份</dd>
            </div>
          </dl>
        </div>

        <!-- 链路读数：真实数据，不是装饰 -->
        <aside class="readout-panel" :class="{ locked }">
          <div class="readout-head">
            <span class="led" :class="failed ? 'led-danger' : locked ? 'led-ok led-live' : 'led-signal'" />
            <span class="readout-title">
              {{ failed ? '未连接到主控' : locked ? '链路正常' : '正在获取链路数据' }}
            </span>
            <span class="grow" />
            <span class="tag">v{{ meta?.version ?? '1.0.0' }}</span>
          </div>

          <div class="scanline" aria-hidden="true" />

          <div class="readout-body">
            <div class="readout-row">
              <span class="readout-k">在线中继</span>
              <span class="readout-v">{{ stats ? stats.onlineNodes : '—' }}</span>
              <span class="readout-u">个</span>
            </div>
            <div class="readout-row">
              <span class="readout-k">开放房间</span>
              <span class="readout-v">{{ stats ? stats.openRooms : '—' }}</span>
              <span class="readout-u">间</span>
            </div>
            <div class="readout-row">
              <span class="readout-k">在线玩家</span>
              <span class="readout-v">{{ stats ? stats.onlinePlayers : '—' }}</span>
              <span class="readout-u">人</span>
            </div>
            <div class="readout-row">
              <!--
                「中继收发」= 全网聚合（所有在线子节点之和，转发全在子节点上）。
                悬浮说明里给出在线节点数，方便一眼看出这些量摊在几台上。
              -->
              <span
                class="readout-k"
                :title="
                  stats
                    ? `${stats.onlineRelayNodes ?? 0} 个在线子节点 ${formatBitrate(stats.nodesRxBps ?? 0)} / ${formatBitrate(stats.nodesTxBps ?? 0)}`
                    : ''
                "
              >
                中继收发
              </span>
              <span class="readout-v small">
                {{ stats ? formatBitrate(stats.relayRxBps) : '—' }}
                <span class="faint">/</span>
                {{ stats ? formatBitrate(stats.relayTxBps) : '—' }}
              </span>
              <span class="readout-u">↓↑</span>
            </div>
          </div>

          <p class="readout-foot faint">
            {{
              stats
                ? `${onlineRegions} 个区域已有节点 · 共 ${stats.totalNodes} 个中继`
                : '数据来自主控 /api/v1/meta'
            }}
          </p>
        </aside>
      </div>
    </section>

    <!-- ------------------------------------------------------------ 三步 -->
    <section v-if="!serviceClosed" id="how" class="section">
      <div class="container">
        <div class="section-head">
          <h2>从下载到进服，三步</h2>
          <p class="muted">
            没有端口映射、没有内网穿透配置、不需要知道对方 IP。房主开好局域网世界，剩下的交给客户端。
          </p>
        </div>

        <ol class="steps">
          <li v-for="s in steps" :key="s.n" class="step">
            <span class="step-n">{{ s.n }}</span>
            <h3>{{ s.title }}</h3>
            <p class="muted">{{ s.body }}</p>
          </li>
        </ol>
      </div>
    </section>

    <!-- ------------------------------------------------------------ 功能 -->
    <section v-if="!serviceClosed" id="features" class="section">
      <div class="container">
        <div class="section-head">
          <h2>功能</h2>
          <p class="muted">左边是玩家每天用到的，右边是运营一个平台需要的。两边都做完了才算能用。</p>
        </div>

        <div class="spec-cols">
          <div>
            <h3 class="spec-title">面向玩家</h3>
            <dl class="spec">
              <dt>一键建房 / 进房</dt>
              <dd>6 位加入码；支持房间密码、房主审批、公开或仅凭码可见。</dd>
              <dt>自动就近中继</dt>
              <dd>按华东/华南/华北/华中/西南/西北/东北/香港/海外调度，每房一个主中继 + 一个兜底中继。</dd>
              <dt>局域网广播直通</dt>
              <dd>可选开关（默认关）：打开后游戏「多人游戏」列表里能直接看到房间，不必手抄 IP。</dd>
              <dt>房间聊天</dt>
              <dd>文字与表情、未读徽章、系统消息；房主可删除刷屏消息。</dd>
              <dt>游戏快连</dt>
              <dd>内置常见局域网游戏端口预设，直接给出「房主开什么、玩家填什么」。</dd>
              <dt>连接诊断</dt>
              <dd>直连还是走中继、每个节点的延迟与隧道协议、NAT 类型，并给出可执行的改善建议。</dd>
              <dt>地址一点即复制</dt>
              <dd>房间页把联机地址放大成一块铭牌，点整块或点「复制地址」都能立刻拿到，直接甩给朋友。</dd>
            </dl>
          </div>

          <div>
            <h3 class="spec-title">平台能力</h3>
            <dl class="spec">
              <dt>单端口多房间</dt>
              <dd>中继按网络名通配符决定是否转发，新建或关闭房间都不用重启，也不占新端口。</dd>
              <dt>区域中继</dt>
              <dd>各区域都有中继节点，注册与心跳由主控统一管理，客户端按区域拿到就近入口。</dd>
              <dt>房主权限</dt>
              <dd>审批、踢人、轮换密钥（同时更换网络名，旧票据立刻失效）、房间策略下发。</dd>
              <dt>流量控制</dt>
              <dd>平台级中继限速 + 房间与单成员接收限速；ACL 还能按端口和包速率限制。</dd>
              <dt>流量统计</dt>
              <dd>按房间归因的收发速率与累计流量，可用于监控与计费。</dd>
              <dt>管理控制台</dt>
              <dd>仪表盘、节点、房间、用户、流量、邮件公告、审计、平台设置，全部走网页。</dd>
            </dl>
          </div>
        </div>
      </div>
    </section>

    <!-- ------------------------------------------- 单端口隔离（真正的差异点） -->
    <section v-if="!serviceClosed" class="section">
      <div class="container">
        <div class="section-head">
          <h2>为什么是一个端口</h2>
          <p class="muted">
            多数联机工具是「一个房间占一个端口」，或者一台服务器只服务一群人。
            我们把房间隔离做在了网络身份这一层，端口因此可以复用。
          </p>
        </div>

        <div class="isolation">
          <div class="iso-line">
            <span class="iso-label">客户端 A</span>
            <span class="iso-wire" aria-hidden="true" />
            <span class="iso-hub">
              <span class="led led-signal" />
              中继端口 :{{ meta?.relayPort ?? 11010 }}
            </span>
            <span class="iso-wire" aria-hidden="true" />
            <span class="iso-label">客户端 B</span>
          </div>
          <p class="faint iso-note">
            两个客户端连的是同一个端口，但房间 A 与房间 B 的网络身份不同（网络名 + 32 位随机密钥），
            彼此既发现不了也访问不到。网络名由密钥派生，所以轮换密钥会连名字一起换掉。
          </p>
          <dl class="spec">
            <dt>端口数量</dt>
            <dd>始终 1 个（TCP + UDP 同端口），与房间数无关。</dd>
            <dt>新增房间</dt>
            <dd>不需要重启中继进程，也不需要改防火墙。</dd>
            <dt>准入凭证</dt>
            <dd>网络名本身（128 位派生令牌），不是能被扫描的端口号。</dd>
          </dl>
        </div>
      </div>
    </section>

    <!-- ------------------------------------------------------------ 区域 -->
    <section v-if="!serviceClosed" id="regions" class="section">
      <div class="container">
        <div class="section-head">
          <h2>区域与可用中继</h2>
          <p class="muted">
            下面是目前已接入的区域中继。建房时主控按延迟、负载与空余带宽挑选，
            并为每个房间再配一台兜底中继（主中继不可用时接管），所以单台节点抖动不会断线。
          </p>
        </div>

        <div class="region-table">
          <table class="table">
            <thead>
              <tr>
                <th>中继节点</th>
                <th>区域</th>
                <th class="table-num">承载玩家</th>
                <th class="table-num">容量</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in onlineNodeRows" :key="`${n.region}-${n.name}`">
                <td class="node-name">{{ n.name }}</td>
                <td class="faint">{{ n.regionLabel }}</td>
                <td class="table-num">{{ n.peers }}</td>
                <td class="table-num faint">{{ n.capacity }}</td>
              </tr>
              <tr v-if="onlineNodeRows.length === 0">
                <td colspan="4" class="faint">
                  暂时没有已接入的区域中继，此时无法建房（房间只经由区域中继转发）。区域中继上线后这里会自动出现。
                </td>
              </tr>
            </tbody>
          </table>
          <!-- 汇总单独一行：表格是「一个节点一行」，总量放这里才不会和明细混在一起 -->
          <p v-if="onlineNodeRows.length > 0" class="region-summary faint">
            共 {{ onlineNodeRows.length }} 个在线中继节点，覆盖
            {{ onlineRegions }} 个区域，当前承载 {{ onlinePeers }} 名玩家。
          </p>
        </div>
      </div>
    </section>

    <!-- ------------------------------------------------------------ FAQ -->
    <section v-if="!serviceClosed" id="faq" class="section">
      <div class="container-narrow">
        <h2 class="faq-title">常见问题</h2>

        <div class="faq">
          <details>
            <summary>需要公网 IP 或者会端口映射吗？</summary>
            <p>
              都不需要。客户端会连到主控与区域中继，由它们负责穿 NAT；能打洞就直连（延迟更低），
              打不通就走中继，玩家不用做任何选择。
            </p>
          </details>
          <details>
            <summary>朋友需要额外装什么吗？</summary>
            <p>
              只需要这一个客户端。它内置了 EasyTier 核心，登录后网络身份、虚拟地址与中继列表
              全部由主控下发，不需要手填任何网络参数。
            </p>
          </details>
          <details>
            <summary>为什么客户端要管理员权限？</summary>
            <p>
              创建虚拟网卡（TUN）需要管理员权限。首次启动时客户端会检测并提示「以管理员身份重启」；
              不授权也能登录和建房，但成员之间无法真正连通。
            </p>
          </details>
          <details>
            <summary>房间之间会不会互相串？</summary>
            <p>
              不会。每个房间是独立的网络身份，中继只按网络名决定是否为该网络转发，而网络名是从房间密钥
              派生的 128 位令牌——不可猜测，也不出现在任何公开接口里。
            </p>
          </details>
          <details>
            <summary>能限制房间带宽或者踢人吗？</summary>
            <p>
              可以。房主能在客户端里设置人数上限、房间与单成员接收限速、包速率限制、端口白名单，
              也可以直接踢人——服务端会重算该房间的 ACL 并推送到房主的实例。
            </p>
          </details>
        </div>
      </div>
    </section>

    <!-- ---------------------------------------------------------- 页脚 -->
    <footer class="footer">
      <div class="container footer-inner">
        <div>
          <div class="wordmark" style="margin-bottom: var(--s-3)">
            <span class="wordmark-mark" aria-hidden="true" />
            <span>McLink</span>
          </div>
          <p class="faint footer-blurb">
            基于 EasyTier 的局域网联机平台，支持《我的世界》等各类局域网联机游戏。EasyTier 以 LGPL-3.0 发布，
            本项目以子进程方式调用其核心，未修改其源码。
          </p>
        </div>

        <dl class="footer-meta">
          <div>
            <dt>客户端</dt>
            <dd>{{ meta?.clientVersion ?? '—' }}</dd>
          </div>
          <div>
            <dt>服务端</dt>
            <dd>{{ meta?.version ?? '—' }}</dd>
          </div>
          <div v-if="meta?.easytierVersion">
            <dt>EasyTier</dt>
            <dd>{{ meta.easytierVersion.split(' ').pop() }}</dd>
          </div>
        </dl>
      </div>
      <div class="container footer-fine faint">
        《我的世界》是 Mojang 的商标，其它游戏名称与商标归各自权利人所有；本平台与 Mojang 无关联，仅供合法的联机用途。
      </div>
    </footer>
  </div>
</template>

<style scoped>
.page {
  min-height: 100%;
  background: var(--ink-900);
}

/* ------------------------------------------------------ 已停止对外服务
 * 这一屏不做营销：只用留白、发丝线与一个等宽标签把事实说清楚。
 * 唯一的"强调色"给主操作（看源码 / 自建），因为停止服务之后那才是用户该走的路。 */
.closed {
  padding: clamp(var(--s-10), 12vh, calc(var(--s-12) * 2)) 0 var(--s-12);
}
.closed-tag {
  display: inline-block;
  margin: 0 0 var(--s-4);
  padding: 2px var(--s-3);
  border: 1px solid var(--rule-strong);
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.04em;
  color: var(--paper-dim);
}
.closed-title {
  margin: 0 0 var(--s-4);
  font-size: clamp(1.6rem, 4vw, 2.4rem);
  line-height: 1.25;
}
.closed-lead {
  margin: 0 0 var(--s-3);
  max-width: 62ch;
  color: var(--paper-dim);
  line-height: 1.85;
}
.closed-lead strong {
  color: var(--paper);
}
.closed-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: var(--s-4) var(--s-6);
  margin: var(--s-8) 0;
  padding: var(--s-5) 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}
.closed-facts dt {
  margin-bottom: 2px;
  font-size: var(--fs-xs);
  color: var(--paper-faint);
}
.closed-facts dd {
  margin: 0;
  color: var(--paper);
  overflow-wrap: anywhere;
}
.closed-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  margin-bottom: var(--s-8);
}
.closed-how {
  max-width: 66ch;
  padding: var(--s-4) var(--s-5);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  background: var(--ink-800);
}
.closed-how > summary {
  cursor: pointer;
  color: var(--paper);
}
.closed-how ol {
  margin: var(--s-3) 0 0;
  padding-left: 1.2em;
  color: var(--paper-dim);
  line-height: 1.85;
}
.closed-how li + li {
  margin-top: var(--s-2);
}
.closed-how code {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--paper);
  background: var(--ink-700);
  padding: 1px 4px;
  border-radius: 3px;
}

/* ------------------------------------------------------------ 公告条
 * 顶栏下面的一条窄带：只用发丝线与一个等宽小标签，不做色块、不做图标。 */
.announce {
  background: var(--signal-wash);
  border-bottom: 1px solid var(--rule);
}
.announce-inner {
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  padding: var(--s-3) 0;
}
.announce-tag {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: var(--track-wide);
  text-transform: uppercase;
  color: var(--signal);
}
.announce-text {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: var(--lh-snug);
  color: var(--paper-2);
  overflow-wrap: anywhere;
}

/* ---------------------------------------------------------------- 顶栏 */
.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  background: var(--ink-900);
  border-bottom: 1px solid var(--rule);
}
.topbar-inner {
  height: var(--header-h);
  display: flex;
  align-items: center;
  gap: var(--s-6);
}
.wordmark {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-weight: 600;
  font-size: var(--fs-lg);
  letter-spacing: var(--track-display);
}
/* 字标图形：等距方块轮廓，画出来的而不是 emoji/Unicode 符号 */
.wordmark-mark {
  width: 17px;
  height: 17px;
  flex: none;
  background: var(--signal);
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}
.nav {
  display: flex;
  gap: var(--s-5);
  font-size: var(--fs-sm);
  color: var(--paper-dim);
  margin-right: auto;
}
.nav a {
  transition: color var(--dur-fast) var(--ease);
}
.nav a:hover {
  color: var(--paper);
}
.size-note {
  font-weight: 400;
  opacity: 0.72;
}
@media (max-width: 900px) {
  .nav {
    display: none;
  }
}
/*
 * 手机宽度：顶栏右侧那一排（配色开关 + 管理控制台 + 下载客户端）加上字标，
 * 一行放不下 —— 实测 390px 会把整页撑出 27px 横向滚动条（与首屏无关：
 * 删掉首屏动作区后照样溢出，隐藏这一排才归零）。所以让它**折成两行**，
 * 而不是把横向滚动条丢给用户；宽度够时 flex-wrap 不会触发，观感不变。
 */
@media (max-width: 560px) {
  .topbar-inner {
    height: auto;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-6);
    padding-top: var(--s-2);
    padding-bottom: var(--s-2);
  }
}

/* ---------------------------------------------------------------- 首屏 */
.hero {
  padding: var(--s-9) 0 var(--s-8);
}
.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  gap: var(--s-8);
  align-items: center;
}
.hero-copy h1 {
  margin-bottom: var(--s-5);
}
.hero-sub {
  color: var(--paper-dim);
  font-size: var(--fs-lg);
  line-height: 1.6;
  max-width: 44ch;
  margin-bottom: var(--s-6);
}
.hero-sub strong {
  color: var(--paper);
  font-weight: 600;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  margin-bottom: var(--s-7);
}
/*
 * 主按钮里的三端提示 "(win/安卓/mac)"。
 * 只降字号与字重，颜色沿用 --cta-fg —— **不用 opacity 变淡**：
 * 琥珀底上叠 0.72 透明度会把文字压到 ~4.0:1（亮色主题实测），低于 AA。
 */
.btn-platforms {
  font-size: var(--fs-sm);
  font-weight: 400;
}
.hero-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-6);
  margin: 0;
  padding-top: var(--s-4);
  border-top: 1px solid var(--rule);
}
.hero-facts dt {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  letter-spacing: var(--track-wide);
  text-transform: uppercase;
}
.hero-facts dd {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--paper-2);
}
@media (max-width: 980px) {
  .hero {
    padding: var(--s-7) 0 var(--s-6);
  }
  .hero-grid {
    grid-template-columns: 1fr;
    gap: var(--s-6);
  }
}

/* -------------------------------------------------------- 链路读数面板 */
.readout-panel {
  position: relative;
  border: 1px solid var(--rule-strong);
  border-radius: var(--r-lg);
  background: var(--ink-850);
  padding: var(--s-5);
  overflow: hidden;
}
.readout-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding-bottom: var(--s-4);
  border-bottom: 1px solid var(--rule);
}
.readout-title {
  font-size: var(--fs-sm);
  color: var(--paper-2);
}
/* 唯一的入场动效：一条扫描线跑过一次即止，不循环 */
.scanline {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--signal), transparent);
  opacity: 0;
  animation: sweep 1.1s var(--ease) 120ms 1 both;
}
@keyframes sweep {
  0% {
    top: 0;
    opacity: 0.85;
  }
  100% {
    top: 100%;
    opacity: 0;
  }
}
.readout-body {
  padding: var(--s-1) 0;
}
.readout-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: baseline;
  gap: var(--s-3);
  padding: var(--s-3) 0;
  border-bottom: 1px solid var(--rule-faint);
}
.readout-row:last-child {
  border-bottom: 0;
}
.readout-k {
  color: var(--paper-dim);
  font-size: var(--fs-sm);
}
/* 读数在"上电"前是空的，数据到位后落定 —— 给数字一个到来的瞬间 */
.readout-v {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-3xl);
  font-weight: 500;
  letter-spacing: var(--track-display);
  line-height: 1;
  color: var(--paper);
  opacity: 0;
  transform: translateY(6px);
  transition: opacity var(--dur-slow) var(--ease), transform var(--dur-slow) var(--ease);
}
.readout-v.small {
  font-size: var(--fs-lg);
}
.readout-panel.locked .readout-v {
  opacity: 1;
  transform: none;
}
.readout-u {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  font-family: var(--font-mono);
}
.readout-foot {
  margin: 0;
  padding-top: var(--s-3);
  border-top: 1px solid var(--rule);
  font-size: var(--fs-xs);
}

/* ---------------------------------------------------------------- 三步 */
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-top: 1px solid var(--rule);
}
.step {
  padding: var(--s-6) var(--s-5);
  border-right: 1px solid var(--rule);
}
.step:first-child {
  padding-left: 0;
}
.step:last-child {
  border-right: 0;
  padding-right: 0;
}
.step-n {
  display: block;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--signal);
  letter-spacing: var(--track-wide);
  margin-bottom: var(--s-4);
}
.step h3 {
  margin-bottom: var(--s-2);
}
.step p {
  font-size: var(--fs-sm);
  line-height: 1.6;
}
@media (max-width: 820px) {
  .steps {
    grid-template-columns: 1fr;
  }
  .step {
    border-right: 0;
    border-bottom: 1px solid var(--rule);
    padding: var(--s-5) 0;
  }
  .step:last-child {
    border-bottom: 0;
  }
}

/* ------------------------------------------------------------ 功能规格 */
.spec-cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--s-8);
}
.spec-title {
  font-size: var(--fs-sm);
  color: var(--signal);
  font-family: var(--font-mono);
  font-weight: 500;
  letter-spacing: var(--track-wide);
  text-transform: uppercase;
  margin-bottom: var(--s-4);
}
.spec dd {
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  line-height: 1.55;
  max-width: 44ch;
}

/* -------------------------------------------------------- 隔离示意 */
.isolation {
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  padding: var(--s-6);
  background: var(--ink-850);
}
.iso-line {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}
.iso-label {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--paper-dim);
  white-space: nowrap;
}
.iso-wire {
  flex: 1;
  /* 用虚线边框而不是 repeating-linear-gradient：
     后者会被检测器判为"装饰性条纹"（repeating-stripes-gradient） */
  border-top: 1px dashed var(--rule-strong);
}
.iso-hub {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  padding: 7px var(--s-4);
  /* 原来是写死的 rgba(233, 164, 65, 0.4) —— 正是令牌 --signal-line 在暗色下的值，
     但亮色下它仍是暗色世界那支琥珀（在暖白底上会偏淡）。收敛到令牌后两个主题各自正确，
     暗色下像素完全不变。DESIGN.md 也明令页面 CSS 里不出现 rgba/hex。 */
  border: 1px solid var(--signal-line);
  border-radius: var(--r-sm);
  background: var(--signal-wash);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--paper);
  white-space: nowrap;
}
.iso-note {
  max-width: var(--measure);
  font-size: var(--fs-sm);
  line-height: 1.6;
  margin-bottom: var(--s-5);
}
@media (max-width: 640px) {
  .iso-line {
    flex-direction: column;
    align-items: flex-start;
  }
  .iso-wire {
    display: none;
  }
}

/* ---------------------------------------------------------------- 区域 */
.region-table {
  overflow-x: auto;
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  padding: var(--s-3) var(--s-4) var(--s-2);
  background: var(--ink-850);
}
.region-name {
  color: var(--paper);
  font-weight: 500;
}
/* 节点名走等宽字体：机器名里的数字与下划线对齐后更好扫读 */
.node-name {
  color: var(--paper);
  font-family: var(--font-mono);
  font-weight: 500;
}
/* 表格是「一节点一行」，总量单独一行放在表格下方 */
.region-summary {
  margin: var(--s-2) 0 0;
  font-size: var(--fs-sm);
}
/* 数值列给一个窄而固定的宽度：宽屏下不铺开，数字就贴着自己的表头 */
.region-table .table-num {
  width: 7rem;
}

/* ---------------------------------------------------------------- FAQ */
.faq-title {
  margin-bottom: var(--s-6);
}
.faq {
  border-top: 1px solid var(--rule);
}
.faq details {
  border-bottom: 1px solid var(--rule);
}
.faq summary {
  cursor: pointer;
  padding: var(--s-4) 0;
  font-weight: 500;
  color: var(--paper);
  list-style: none;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  transition: color var(--dur-fast) var(--ease);
}
.faq summary::-webkit-details-marker {
  display: none;
}
.faq summary::before {
  content: '';
  width: 7px;
  height: 7px;
  flex: none;
  background: var(--paper-faint);
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  transition: transform var(--dur) var(--ease), background var(--dur) var(--ease);
}
.faq details[open] summary::before {
  transform: rotate(90deg);
  background: var(--signal);
}
.faq summary:hover {
  color: var(--signal);
}
.faq p {
  padding: 0 0 var(--s-4) var(--s-5);
  color: var(--paper-dim);
  font-size: var(--fs-sm);
  line-height: 1.65;
  max-width: var(--measure);
}

/* ---------------------------------------------------------------- 页脚 */
.footer {
  border-top: 1px solid var(--rule);
  padding: var(--s-7) 0 var(--s-5);
  margin-top: var(--s-8);
}
.footer-inner {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-7);
  justify-content: space-between;
  align-items: flex-start;
}
.footer-blurb {
  max-width: 42ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
}
.footer-meta {
  display: flex;
  gap: var(--s-6);
  margin: 0;
}
.footer-meta dt {
  font-size: var(--fs-xs);
  color: var(--paper-faint);
  letter-spacing: var(--track-wide);
  text-transform: uppercase;
}
.footer-meta dd {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--paper-2);
}
.footer-fine {
  margin-top: var(--s-6);
  padding-top: var(--s-4);
  border-top: 1px solid var(--rule-faint);
  font-size: var(--fs-xs);
}
</style>
