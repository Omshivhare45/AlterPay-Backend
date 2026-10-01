/**
 * Validates environment configuration without starting the server.
 *
 * Run in CI or a container entrypoint to fail fast on a missing or malformed
 * variable instead of discovering it at the first request.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigError, loadConfig } from '../src/infrastructure/config/index.js';

function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  // Node's native loader avoids adding dotenv as a runtime dependency.
  process.loadEnvFile(path);
}

function main(): void {
  try {
    loadDotEnv();
    const config = loadConfig();
    process.stdout.write(
      `Configuration valid: ${config.app.name}@${config.app.version} (${config.env})\n`,
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main();