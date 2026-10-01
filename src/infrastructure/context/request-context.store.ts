import { AsyncLocalStorage } from 'node:async_hooks';

import type { RequestContext, RequestContextStore } from '../../domain/shared/request-context.js';

const storage = new AsyncLocalStorage<RequestContext>();

export const asyncLocalContextStore: RequestContextStore = {
  get: (): RequestContext | undefined => storage.getStore(),
  run: <T>(context: RequestContext, callback: () => T): T => storage.run(context, callback),
};

/** Test helper: an isolated store that never leaks state between test cases. */
export function createInMemoryContextStore(): RequestContextStore {
  const isolated = new AsyncLocalStorage<RequestContext>();
  return {
    get: (): RequestContext | undefined => isolated.getStore(),
    run: <T>(context: RequestContext, callback: () => T): T => isolated.run(context, callback),
  };
}
