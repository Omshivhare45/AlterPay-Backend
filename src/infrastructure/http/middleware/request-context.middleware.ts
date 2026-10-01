import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { RequestContext, RequestContextStore } from '../../../domain/shared/request-context.js';
import type { Logger } from '../../logging/index.js';

export interface RequestContextMiddlewareOptions {
  store: RequestContextStore;
  logger: Logger;
  headerNames?: {
    requestId?: string;
    correlationId?: string;
  };
}

const REQUEST_ID_HEADER = 'x-request-id';
const CORRELATION_ID_HEADER = 'x-correlation-id';
const SAFE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

function readIdentifier(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return SAFE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Establishes per-request correlation.
 *
 * A client-supplied request/correlation id is honoured when well-formed (so
 * traces span service hops); otherwise a fresh UUID is minted. Ids are echoed
 * back in response headers so a caller can quote them in support requests, and
 * bound into the request-scoped logger plus the async context.
 */
export function createRequestContextMiddleware(
  options: RequestContextMiddlewareOptions,
): RequestHandler {
  const { store, logger } = options;
  const headers = options.headerNames ?? {};

  return function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
    const requestId =
      readIdentifier(req.headers[headers.requestId ?? REQUEST_ID_HEADER]) ?? randomUUID();
    const correlationId =
      readIdentifier(req.headers[headers.correlationId ?? CORRELATION_ID_HEADER]) ?? requestId;

    res.setHeader(headers.requestId ?? REQUEST_ID_HEADER, requestId);
    res.setHeader(headers.correlationId ?? CORRELATION_ID_HEADER, correlationId);

    const context: RequestContext = {
      requestId,
      correlationId,
      startedAt: Date.now(),
    };

    const requestLogger = logger.child({ requestId, correlationId });

    res.on('finish', () => {
      const durationMs = Date.now() - context.startedAt;
      requestLogger.info(
        {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs,
        },
        'request_completed',
      );
    });

    store.run(context, () => {
      (req as Request & { context: RequestContext; log: Logger }).context = context;
      (req as Request & { context: RequestContext; log: Logger }).log = requestLogger;
      next();
    });
  };
}
