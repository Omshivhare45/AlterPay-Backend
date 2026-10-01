import type { ErrorRequestHandler, Request, RequestHandler } from 'express';

import { NotFoundError } from '../../../domain/shared/errors.js';
import type { RequestContext } from '../../../domain/shared/request-context.js';
import { translatePrismaError } from '../../database/prisma-errors.js';
import type { Logger } from '../../logging/index.js';
import { captureException } from '../../observability/index.js';
import { normalizeError, PROBLEM_CONTENT_TYPE } from '../problem/problem-details.js';

export interface ErrorHandlerOptions {
  logger: Logger;
  /** Overrides instance derivation; defaults to `METHOD path`. */
  instanceResolver?: (req: Request) => string;
}

type ContextualRequest = Request & {
  context?: RequestContext;
  log?: Logger;
};

function defaultInstanceResolver(req: Request): string {
  return `${req.method} ${req.path}`;
}

/**
 * Terminal 404 for unmatched routes, expressed as a problem document so clients
 * see one consistent error shape regardless of how the route failed.
 */
export function createNotFoundHandler(logger: Logger): RequestHandler {
  return function notFoundHandler(req, res) {
    const contextual = req as ContextualRequest;
    const { problem } = normalizeError(new NotFoundError(`Route not found: ${req.path}`), {
      instance: defaultInstanceResolver(req),
      requestId: contextual.context?.requestId,
      correlationId: contextual.context?.correlationId,
    });
    logger.debug({ path: req.path }, 'route_not_found');
    res.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  };
}

/**
 * Centralized error handler. Every failure path in the app funnels through here,
 * so response shape, log level, and error exposure are decided in exactly one
 * place. Nothing else in the codebase writes an error response.
 */
export function createErrorHandler(options: ErrorHandlerOptions): ErrorRequestHandler {
  const resolveInstance = options.instanceResolver ?? defaultInstanceResolver;

  return function errorHandler(error, req, res, next) {
    if (res.headersSent) {
      next(error);
      return;
    }

    const contextual = req as ContextualRequest;
    const logger = contextual.log ?? options.logger;
    const context = {
      instance: resolveInstance(req),
      requestId: contextual.context?.requestId,
      correlationId: contextual.context?.correlationId,
    };

    const translated = translatePrismaError(error);
    const { problem } = normalizeError(translated, context);

    const logPayload = {
      err: translated,
      method: req.method,
      path: req.originalUrl,
      status: problem.status,
      code: problem.code,
    };

    if (problem.status >= 500) {
      logger.error(logPayload, 'request_failed');
      captureException(translated, logger);
    } else if (problem.status >= 400) {
      logger.warn(logPayload, 'request_rejected');
    } else {
      logger.info(logPayload, 'request_failed');
    }

    res.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  };
}
