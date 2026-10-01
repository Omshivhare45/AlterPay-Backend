import pino, { type Logger, type LoggerOptions } from 'pino';

import type { AppConfig } from '../config/index.js';

export type { Logger } from 'pino';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-signature"]',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'signature',
];

export function createLogger(config: AppConfig): Logger {
  const options: LoggerOptions = {
    name: config.app.name,
    level: config.logLevel,
    base: {
      service: config.app.name,
      version: config.app.version,
      env: config.env,
    },
    redact: {
      paths: redactPaths,
      remove: true,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  const usePretty = config.logPretty && !config.isProduction;

  return usePretty
    ? pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname,service,version,env',
          },
        },
      })
    : pino(options);
}
