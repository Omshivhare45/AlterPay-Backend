/**
 * `src/integrations/` — outbound provider adapters and their contracts.
 *
 * Rule from the architecture: provider-specific code lives here only. Core
 * layers depend on the contracts, never on a concrete adapter.
 */
export * from './notifications/index.js';