/** 带语义的 HTTP 错误；被 http 层统一转换为 ApiError 响应体 */
import { ErrorCodes, type ErrorCode } from '@mclink/shared';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fields?: Record<string, string>;

  constructor(status: number, code: ErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }

  static badRequest(message = '请求参数有误', fields?: Record<string, string>): HttpError {
    return new HttpError(400, ErrorCodes.BAD_REQUEST, message, fields);
  }

  static unauthorized(message = '请先登录'): HttpError {
    return new HttpError(401, ErrorCodes.UNAUTHORIZED, message);
  }

  static forbidden(message = '没有权限执行该操作'): HttpError {
    return new HttpError(403, ErrorCodes.FORBIDDEN, message);
  }

  static notFound(message = '资源不存在'): HttpError {
    return new HttpError(404, ErrorCodes.NOT_FOUND, message);
  }

  static conflict(message = '与现有资源冲突'): HttpError {
    return new HttpError(409, ErrorCodes.CONFLICT, message);
  }

  static rateLimited(message = '请求过于频繁，请稍后再试'): HttpError {
    return new HttpError(429, ErrorCodes.RATE_LIMITED, message);
  }

  static internal(message = '服务器内部错误'): HttpError {
    return new HttpError(500, ErrorCodes.INTERNAL, message);
  }

  static unavailable(message = '服务暂不可用'): HttpError {
    return new HttpError(503, ErrorCodes.SERVICE_UNAVAILABLE, message);
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}
