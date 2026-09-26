/** 账号接口 */
import { ErrorCodes, Routes } from '@mclink/shared';
import type { App } from '../app.ts';
import type { Router } from '../http/kit.ts';
import { bearerToken, req, requireAuth } from './helpers.ts';
import { HttpError } from '../util/errors.ts';
import { logger } from '../logger.ts';

const log = logger('api:auth');

export function registerAuthRoutes(router: Router, app: App): void {
  router.post(Routes.register, async (ctx) => {
    const body = await ctx.body();
    const result = await app.auth.register({
      username: req(body, 'username', '用户名'),
      password: req(body, 'password', '密码'),
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
      ip: ctx.ip,
    });
    log.info('用户注册', { username: req(body, 'username'), ip: ctx.ip });
    return result;
  });

  router.post(Routes.login, async (ctx) => {
    const body = await ctx.body();
    return app.auth.login({
      username: req(body, 'username', '用户名'),
      password: req(body, 'password', '密码'),
      ip: ctx.ip,
      userAgent: (ctx.req.headers['user-agent'] ?? null) as string | null,
    });
  });

  router.post(Routes.logout, async (ctx) => {
    const token = bearerToken(ctx);
    if (token) app.auth.logout(token);
    return { ok: true };
  }, { auth: true });

  router.get(Routes.me, (ctx) => {
    const auth = requireAuth(ctx);
    const row = app.users.findById(auth.userId);
    if (!row) throw HttpError.unauthorized();
    return app.users.toSelf(row);
  }, { auth: true });

  router.post(Routes.changePassword, async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    await app.auth.changePassword(
      auth.userId,
      req(body, 'oldPassword', '原密码'),
      req(body, 'newPassword', '新密码'),
    );
    return { ok: true, message: '密码已更新，请重新登录' };
  }, { auth: true });

  /** 更新自己的显示名/邮箱 */
  router.patch(Routes.profile, async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 32) : undefined;
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 120) : body.email === null ? null : undefined;
    if (displayName !== undefined && displayName.length === 0) {
      throw HttpError.badRequest('显示名不能为空', { displayName: '显示名不能为空' });
    }
    app.users.updateProfile(auth.userId, { displayName, email });
    const row = app.users.findById(auth.userId);
    return app.users.toSelf(row!);
  }, { auth: true });

  /* ------------------------------------------------------------ 邮箱验证 */

  /** 邮箱验证状态（界面靠它决定显示"去验证"还是"已验证"） */
  router.get('/auth/email', (ctx) => {
    const auth = requireAuth(ctx);
    return app.auth.emailStatus(auth.userId);
  }, { auth: true });

  /** 绑定邮箱并寄出验证码 */
  router.post(Routes.emailStart, async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    const email = req(body, 'email', '邮箱');
    const result = await app.auth.startEmailVerification(auth.userId, email, ctx.ip);
    if (!result.sent) {
      // 账号/邮箱已经写好了，只是信没寄出去；把 SMTP 的原话带回去，用户才知道要不要重试
      throw new HttpError(
        502,
        ErrorCodes.SMTP_FAILED,
        result.error ?? '验证码发送失败，请稍后重试或联系管理员',
      );
    }
    return result;
  }, { auth: true });

  /** 提交验证码 */
  router.post(Routes.emailVerify, async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await ctx.body();
    return app.auth.verifyEmail(auth.userId, req(body, 'code', '验证码'), ctx.ip);
  }, { auth: true });
}
