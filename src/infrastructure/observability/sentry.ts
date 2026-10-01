import * as Sentry from '@sentry/node';

import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/index.js';

let initialized = false;

/**
 * Sentry is optional: without a DSN the app still boots and logs locally.
 * Failure to initialize must never take the process down.
 */
export function initSentry(config: AppConfig, logger: Logger): boolean {
  if (initialized || !config.observability.sentryDsn) {
    return initialized;
  }

  try {
    Sentry.init({
      dsn: config.observability.sentryDsn,
      environment: config.env,
      release: `alterpay-api@${config.app.version}`,
      tracesSampleRate: config.observability.sentryTracesSampleRate,
      sendDefaultPii: false,
    });
    initialized = true;
    logger.info('sentry_initialized');
  } catch (error) {
    logger.error({ err: error }, 'sentry_initialization_failed');
  }

  return initialized;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export function shutdownSentry(logger: Logger): Promise<void> {
  if (!initialized) {
    return Promise.resolve();
  }
  return Sentry.close(2_000).then(
    () => undefined,
    (error: unknown) => {
      logger.error({ err: error }, 'sentry_shutdown_failed');
    },
  );
}

export function captureException(error: unknown, logger: Logger): void {
  if (!initialized) return;
  Sentry.captureException(error);
  logger.debug('exception_captured_to_sentry');
}

export { Sentry };
