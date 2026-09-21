<script setup lang="ts">
/**
 * 管理控制台外壳：固定侧边栏 + 顶部条 + 子路由出口。
 * 窄屏（<900px）侧边栏折叠为抽屉，避免在平板上挤掉内容区。
 */
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { currentUser, logout } from '../lib/session.ts';
import { notifyError, notifyOk } from '../lib/toast.ts';
import { friendlyError } from '../lib/api.ts';

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const route = useRoute();
const router = useRouter();

const navItems: NavItem[] = [
  { to: '/console/dashboard', label: '仪表盘', icon: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z' },
  { to: '/console/nodes', label: '中继节点', icon: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01' },
  { to: '/console/rooms', label: '房间管理', icon: 'M4 20V9.5L12 4l8 5.5V20M9.5 20v-6h5v6' },
  { to: '/console/users', label: '用户管理', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8a8 8 0 0 1 16 0' },
  { to: '/console/traffic', label: '流量监控', icon: 'M4 19V5m0 14h16M8 19v-6m4 6V9m4 10v-4' },
  { to: '/console/relay', label: '主控中继', icon: 'M12 3v4m0 10v4M3 12h4m10 0h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z' },
  { to: '/console/audit', label: '审计日志', icon: 'M6 3h9l4 4v14H6zM15 3v4h4M9.5 12h6M9.5 16h6' },
  {
    to: '/console/settings',
    label: '平台设置',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3c0-.4 0-.8-.1-1.2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2-1.2L14.6 3h-3.9l-.4 2.5a7.6 7.6 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2 1.2l.4 2.5h3.9l.4-2.5a7.6 7.6 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z',
  },
];

const drawerOpen = ref(false);
const loggingOut = ref(false);

const pageTitle = computed(() => {
  const title = route.meta.title;
  return typeof title === 'string' && title.length > 0 ? title : '控制台';
});

const user = computed(() => currentUser.value);
const roleLabel = computed(() => (user.value?.role === 'admin' ? '管理员' : '玩家'));

watch(
  () => route.path,
  () => {
    drawerOpen.value = false;
  },
);

function isActive(to: string): boolean {
  return route.path === to || route.path.startsWith(`${to}/`);
}

async function handleLogout(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await logout();
    notifyOk('已退出登录');
    await router.push('/login');
  } catch (err) {
    notifyError(friendlyError(err));
  } finally {
    loggingOut.value = false;
  }
}
</script>

<template>
  <div class="shell">
    <!-- 移动端抽屉遮罩 -->
    <div v-if="drawerOpen" class="overlay" @click="drawerOpen = false" />

    <aside class="sidebar" :class="{ open: drawerOpen }">
      <RouterLink class="side-brand" to="/console/dashboard">
        <span class="brand-mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M4 16.5c0-1.2 1-2.1 2.2-1.9l3.1.5 3-5.4-2.4-2.6 1.6-3.1 3.4 1 1.4 3.2 3.2.7c1.5.3 2.5 1.6 2.5 3.1" />
            <path d="M3 20h18" />
          </svg>
        </span>
        <span class="side-brand-text">
          <strong>mclink</strong>
          <span class="faint">管理控制台</span>
        </span>
      </RouterLink>

      <nav class="side-nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ active: isActive(item.to) }"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path :d="item.icon" />
          </svg>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="side-foot">
        <RouterLink class="btn btn-ghost btn-block btn-sm" to="/">← 返回站点</RouterLink>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <button class="btn btn-ghost btn-sm drawer-toggle" type="button" aria-label="打开导航" @click="drawerOpen = !drawerOpen">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>

        <h1 class="topbar-title">{{ pageTitle }}</h1>

        <div class="topbar-right">
          <div v-if="user" class="who">
            <span class="who-name truncate">{{ user.displayName }}</span>
            <span class="badge" :class="user.role === 'admin' ? 'badge-brand' : 'badge-neutral'">{{ roleLabel }}</span>
          </div>
          <span v-else class="faint" style="font-size: var(--fs-sm)">未登录</span>
          <button class="btn btn-sm" type="button" :disabled="loggingOut" @click="handleLogout">
            <span v-if="loggingOut" class="spinner" />
            退出登录
          </button>
        </div>
      </header>

      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  background: var(--bg-0);
}
.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer);
  background: rgba(3, 5, 12, 0.6);
  backdrop-filter: blur(2px);
}

/* ------------------------------------------------------------------ 侧栏 */
.sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: var(--sidebar-w);
  z-index: var(--z-drawer);
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  padding: var(--s-4) var(--s-3);
  background: var(--bg-1);
  border-right: 1px solid var(--border);
}
.side-brand {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2) var(--s-2) var(--s-3);
}
.brand-mark {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--grad-brand);
  color: #04121a;
}
.brand-mark svg {
  width: 20px;
  height: 20px;
}
.side-brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}
.side-brand-text strong {
  font-size: var(--fs-base);
}
.side-brand-text span {
  font-size: var(--fs-xs);
}
.side-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 9px var(--s-3);
  border-radius: var(--r-sm);
  color: var(--text-dim);
  font-size: var(--fs-sm);
  font-weight: 540;
  border: 1px solid transparent;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.nav-item svg {
  flex: none;
  opacity: 0.85;
}
.nav-item:hover {
  background: var(--surface);
  color: var(--text);
}
.nav-item.active {
  background: var(--surface-strong);
  color: var(--text);
  border-color: var(--border-strong);
  box-shadow: var(--glow-brand);
}
.nav-item.active svg {
  color: var(--brand);
  opacity: 1;
}
.side-foot {
  margin-top: auto;
  padding-top: var(--s-3);
  border-top: 1px solid var(--border);
}

/* ------------------------------------------------------------------ 主区 */
.main {
  margin-left: var(--sidebar-w);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  height: var(--header-h);
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 0 var(--s-5);
  background: rgba(5, 7, 15, 0.82);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--border);
}
.topbar-title {
  font-size: var(--fs-lg);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.who {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  max-width: 260px;
}
.who-name {
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.drawer-toggle {
  display: none;
}
.content {
  flex: 1;
  min-width: 0;
  padding: var(--s-5);
}

/* ------------------------------------------------------------------ 响应 */
@media (max-width: 900px) {
  .sidebar {
    transform: translateX(-102%);
    transition: transform var(--dur) var(--ease);
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open {
    transform: none;
  }
  .main {
    margin-left: 0;
  }
  .drawer-toggle {
    display: inline-flex;
  }
  .topbar,
  .content {
    padding-left: var(--s-4);
    padding-right: var(--s-4);
  }
  .who {
    max-width: 140px;
  }
}
</style>
