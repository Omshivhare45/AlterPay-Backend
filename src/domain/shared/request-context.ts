/**
 * Ambient execution context propagated across async boundaries.
 *
 * The concrete storage mechanism (AsyncLocalStorage) lives in infrastructure; the
 * domain only depends on this read/write contract.
 */

export interface RequestContext {
  requestId: string;
  correlationId: string;
  startedAt: number;
}

export interface RequestContextStore {
  get(): RequestContext | undefined;
  run<T>(context: RequestContext, callback: () => T): T;
}
