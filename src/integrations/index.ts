/**
 * `src/integrations/` — outbound provider adapters and their contracts.
 *
 * Rule from the architecture: provider-specific code lives here only. Core
 * layers depend on the contracts, never on a concrete adapter. The barrel
 * re-exports contracts for adapter authors; it does not make them reachable from
 * the core, which imports `src/application/providers/` directly.
 */
export * from './adapters/index.js';
export * from './artifacts/index.js';
export * from './contracts/index.js';
export * from './credentials/index.js';
export * from './mocks/index.js';
export * from './notifications/index.js';
export * from './registry/index.js';
export * from './transport/index.js';