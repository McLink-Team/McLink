/**
 * 路由表。
 *  - 玩家侧：落地页 `/`、登录注册
 *  - 管理侧：`/console/*`（需要管理员角色）
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { isAdmin, isAuthLoaded, isLoggedIn, loadCurrentUser } from './lib/session.ts';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'landing',
    component: () => import('./pages/LandingPage.vue'),
    meta: { public: true, title: 'McLink · 和朋友一起开黑' },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('./pages/LoginPage.vue'),
    meta: { public: true, title: '登录 · McLink' },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('./pages/LoginPage.vue'),
    props: { initialMode: 'register' },
    meta: { public: true, title: '注册 · McLink' },
  },
  {
    path: '/download',
    name: 'download',
    component: () => import('./pages/DownloadPage.vue'),
    meta: { public: true, title: '下载客户端 · McLink' },
  },
  {
    path: '/console',
    component: () => import('./console/ConsoleLayout.vue'),
    meta: { requiresAdmin: true },
    children: [
      { path: '', redirect: '/console/dashboard' },
      {
        path: 'dashboard',
        name: 'console-dashboard',
        component: () => import('./console/pages/DashboardPage.vue'),
        meta: { title: '仪表盘' },
      },
      {
        path: 'nodes',
        name: 'console-nodes',
        component: () => import('./console/pages/NodesPage.vue'),
        meta: { title: '中继节点' },
      },
      {
        path: 'rooms',
        name: 'console-rooms',
        component: () => import('./console/pages/RoomsPage.vue'),
        meta: { title: '房间管理' },
      },
      {
        path: 'users',
        name: 'console-users',
        component: () => import('./console/pages/UsersPage.vue'),
        meta: { title: '用户管理' },
      },
      {
        path: 'traffic',
        name: 'console-traffic',
        component: () => import('./console/pages/TrafficPage.vue'),
        meta: { title: '流量监控' },
      },
      {
        path: 'relay',
        name: 'console-relay',
        component: () => import('./console/pages/RelayPage.vue'),
        meta: { title: '主控中继' },
      },
      {
        path: 'audit',
        name: 'console-audit',
        component: () => import('./console/pages/AuditPage.vue'),
        meta: { title: '审计日志' },
      },
      {
        path: 'settings',
        name: 'console-settings',
        component: () => import('./console/pages/SettingsPage.vue'),
        meta: { title: '平台设置' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('./pages/NotFoundPage.vue'),
    meta: { public: true, title: '页面不存在' },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    if (to.hash) return { el: to.hash, behavior: 'smooth' };
    return { top: 0 };
  },
});

router.beforeEach(async (to) => {
  if (!isAuthLoaded()) await loadCurrentUser();
  const requiresAdmin = to.matched.some((r) => r.meta.requiresAdmin);

  if (requiresAdmin && !isLoggedIn.value) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (requiresAdmin && !isAdmin.value) {
    return { name: 'landing', query: { forbidden: '1' } };
  }
  if (to.name === 'login' && isLoggedIn.value && isAdmin.value) {
    return { name: 'console-dashboard' };
  }
  return true;
});

router.afterEach((to) => {
  const title = to.meta.title as string | undefined;
  document.title = title ?? 'mclink';
});
