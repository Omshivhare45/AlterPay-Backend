/**
 * Presentation layer barrel.
 *
 * HTTP controllers, routers, and request/response translation. Depends on
 * `application` and `domain` only; never on `infrastructure`.
 */
export * from './api/index.js';
export * from './health/index.js';
export * from './http/index.js';
