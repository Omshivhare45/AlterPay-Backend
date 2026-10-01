/**
 * Infrastructure layer barrel.
 *
 * Adapters for external systems: database, HTTP, logging, config, context.
 * This is the only layer allowed to import from every other layer.
 */
export * from './config/index.js';
export * from './context/index.js';
export * from './database/index.js';
export * from './http/index.js';
export * from './logging/index.js';
export * from './observability/index.js';
