/**
 * 「必须验证邮箱」这条规则只写一次。
 *
 * 两个地方要用它：账号服务（接口层的显式检查）与房间服务（建房/进房的硬门禁）。
 * 各写一份迟早会漂——一处放行、另一处拒绝，排查起来非常费劲。
 *
 * 规则（**严格**，与"要求验证邮箱"的字面意思一致）：
 *   开关打开后，任何账号都必须先绑定并验证邮箱，才能建房/进房。
 *   没绑邮箱的历史账号同样被挡——错误信息会明确告诉它"去绑定邮箱"。
 *
 * 为什么不做"历史账号豁免"：豁免听起来温和，实际会造出一个说不清的状态——
 * 同一个开关下，有的账号需要验证、有的不需要，而"为什么他不用验"没有可解释的依据。
 * 真要放行历史账号，管理员应该关掉开关，或者让那些账号自己绑一次邮箱。
 */
import { ErrorCodes } from '@mclink/shared';
import { HttpError } from '../util/errors.ts';
import type { UserRow } from '../db/users.ts';

export function emailGateProblem(user: UserRow, required: boolean): HttpError | null {
  if (!required) return null;
  if (user.email === null) {
    return new HttpError(403, ErrorCodes.EMAIL_NOT_VERIFIED, '请先在账号里绑定并验证邮箱', {
      email: '请先绑定邮箱',
    });
  }
  if (user.email_verified !== 1) {
    return new HttpError(403, ErrorCodes.EMAIL_NOT_VERIFIED, '邮箱尚未验证，请先完成验证再建房/进房', {
      email: '邮箱尚未验证',
    });
  }
  return null;
}

/** 不通过就抛；用于房间服务这种"错了就中断"的位置 */
export function assertEmailVerified(user: UserRow, required: boolean): void {
  const problem = emailGateProblem(user, required);
  if (problem) throw problem;
}
