import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';

import { buildApplication, type Application } from './composition/bootstrap.js';

/**
 * Loads `.env` when present so local runs match CI. Uses Node's native loader,
 * keeping dotenv out of the runtime dependency tree.
 */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

/**
 * Process entrypoint.
 *
 * Boots the application, starts listening, and installs signal handlers for
 * graceful shutdown. Kept separate from `composition/bootstrap.ts` so the
 * application graph can be built in tests without binding a port.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const application = buildApplication();
  const { app, config, logger } = application;

  const server: Server = createServer(app);

  await listen(server, config.http.port, config.http.host);

  logger.info(
    {
      host: config.http.host,
      port: config.http.port,
      apiPrefix: config.app.apiPrefix,
      env: config.env,
    },
    'server_started',
  );

  installShutdownHandlers({ server, application, logger });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/**
 * Stops accepting connections, drains in-flight requests, then releases
 * resources. A forced exit after the timeout prevents a hung connection from
 * blocking deploys indefinitely.
 */
function installShutdownHandlers({
  server,
  application,
  logger,
}: {
  server: Server;
  application: Application;
  logger: Application['logger'];
}): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown_started');

    const forceExit = setTimeout(() => {
      logger.error({ signal }, 'shutdown_forced');
      process.exit(1);
    }, application.config.shutdown.timeoutMs);
    forceExit.unref();

    server.close((error) => {
      if (error) {
        logger.error({ err: error }, 'http_server_close_failed');
      }
      void application
        .shutdown()
        .catch((shutdownError: unknown) => {
          logger.error({ err: shutdownError }, 'shutdown_failed');
        })
        .finally(() => {
          clearTimeout(forceExit);
          logger.info({ signal }, 'shutdown_completed');
          process.exit(error ? 1 : 0);
        });
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled_rejection');
  });

  // An uncaught exception leaves the process in an unknown state, so log it
  // fatally and shut down rather than continuing to serve traffic.
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught_exception');
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet if config parsing failed, so write directly.
  process.stderr.write(
    `Fatal error during startup: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
