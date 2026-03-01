import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import type { Logger } from '../logger/logger';
import type { Tracer } from '../tracer/tracer';
import type { AlertEngine } from '../alerting/alert-engine';

const REDACTED_VALUE = '[REDACTED]';
const TRUNCATED_VALUE = '[TRUNCATED]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function parsePaths(paths: string[]): string[][] {
  return paths
    .map((p) => p.split('.').filter(Boolean))
    .filter((p) => p.length > 0);
}

function isExactPath(candidate: string[], paths: string[][]): boolean {
  return paths.some(
    (path) =>
      candidate.length === path.length &&
      candidate.every((part, idx) => part === path[idx])
  );
}

function hasPathPrefix(candidate: string[], paths: string[][]): boolean {
  return paths.some(
    (path) =>
      candidate.length <= path.length &&
      candidate.every((part, idx) => part === path[idx])
  );
}

function safeStringify(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (isPlainObject(val) || Array.isArray(val)) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch {
    return null;
  }
}

function sanitizeBody(
  body: unknown,
  allowKeys: Set<string> | null,
  denyKeys: Set<string>,
  redactPaths: string[][],
  maxDepth: number
): unknown {
  const visit = (value: unknown, path: string[], depth: number): unknown => {
    if (isExactPath(path, redactPaths)) return REDACTED_VALUE;
    if (depth >= maxDepth) return TRUNCATED_VALUE;

    if (Array.isArray(value)) {
      if (!hasPathPrefix(path, redactPaths) && path.length > 0) return value;
      return value.map((item, index) => visit(item, [...path, String(index)], depth + 1));
    }

    if (isPlainObject(value)) {
      if (!hasPathPrefix(path, redactPaths) && path.length > 0) return value;
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (path.length === 0 && allowKeys && !allowKeys.has(key)) continue;
        if (path.length === 0 && denyKeys.has(key)) {
          output[key] = REDACTED_VALUE;
          continue;
        }
        output[key] = visit(child, [...path, key], depth + 1);
      }
      return output;
    }

    return value;
  };

  return visit(body, [], 0);
}

declare global {
  namespace Express {
    interface Locals {
      logger: Logger;
      traceId: string;
      spanId: string;
      requestId: string;
    }
  }
}

export interface ObserveMiddlewareOptions {
  ignorePaths?: string[];
  logBody?: boolean;
  logBodyAllowKeys?: string[];
  logBodyDenyKeys?: string[];
  logBodyRedactPaths?: string[];
  logBodyMaxDepth?: number;
  logBodyMaxLength?: number;
}

export function createObserveMiddleware(
  logger: Logger,
  tracer: Tracer,
  alertEngine: AlertEngine,
  options: ObserveMiddlewareOptions = {}
) {
  void alertEngine;
  const ignorePaths = new Set(options.ignorePaths ?? ['/health', '/ping', '/metrics']);
  const allowKeys = options.logBodyAllowKeys?.length
    ? new Set(options.logBodyAllowKeys)
    : null;
  const denyKeys = new Set(options.logBodyDenyKeys ?? []);
  const redactPaths = parsePaths(options.logBodyRedactPaths ?? []);
  const maxDepth = options.logBodyMaxDepth ?? 4;
  const maxLength = options.logBodyMaxLength ?? 4096;

  return async function observeMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (ignorePaths.has(req.path)) {
      next();
      return;
    }

    const start = process.hrtime.bigint();
    const requestId = randomUUID();

    const traceparent = req.headers['traceparent'] as string | undefined;
    const incomingCtx = traceparent ? tracer.extractContext(traceparent) : null;

    const activeCtx = incomingCtx ?? tracer.createRootContext();

    const reqLogger = logger.child({
      traceId: activeCtx.traceId,
      spanId: activeCtx.spanId,
      requestId,
      method: req.method,
      path: req.path,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    res.locals.logger = reqLogger;
    res.locals.traceId = activeCtx.traceId;
    res.locals.spanId = activeCtx.spanId;
    res.locals.requestId = requestId;

    res.setHeader('traceparent', `00-${activeCtx.traceId}-${activeCtx.spanId}-01`);
    res.setHeader('x-request-id', requestId);

    let bodyPayload: unknown = undefined;
    if (options.logBody && req.body) {
      const sanitized = sanitizeBody(req.body, allowKeys, denyKeys, redactPaths, maxDepth);
      const stringified = safeStringify(sanitized);
      if (stringified && stringified.length > maxLength) {
        bodyPayload = {
          bodyPreview: stringified.slice(0, maxLength),
          bodyTruncated: true,
        };
      } else {
        bodyPayload = sanitized;
      }
    }

    reqLogger.info('request.start', {
      ...(bodyPayload !== undefined ? { body: bodyPayload } : {}),
    });

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      const level =
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      const context = {
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      };

      if (level === 'error') {
        reqLogger.error('request.complete', undefined, context);
      } else if (level === 'warn') {
        reqLogger.warn('request.complete', context);
      } else {
        reqLogger.info('request.complete', context);
      }
    });

    tracer.runWithContext(activeCtx, () => next());
  };
}
