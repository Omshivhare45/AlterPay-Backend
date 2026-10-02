/**
 * Provider callback (webhook) contract.
 *
 * Providers push state changes asynchronously: a disbursement clears, an
 * application is sanctioned, an EMI posts. Those events are unreliable in
 * specific, well-known ways — they arrive twice, and they arrive out of order —
 * and both are handled here rather than by each consumer.
 *
 * Classification is a pure function of the event and the last applied state, so
 * the same event always yields the same decision and the decision can be tested
 * without a transport, a database or a clock.
 */

import type { ProviderFamily } from "./capabilities.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const PROVIDER_EVENT_TYPES = [
  "APPLICATION_STATUS",
  "OFFER_UPDATED",
  "LOAN_DISBURSED",
  "EMI_POSTED",
  "REPAYMENT_RECEIVED",
  "LOAN_CLOSED",
  "OTP_DELIVERY_STATUS",
] as const;

export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

/**
 * An inbound provider event, normalised.
 *
 * `payload` holds only the fields the core acts on. Anything else the vendor
 * sends belongs in artifact storage, keyed by `eventId`, rather than here.
 */
export interface ProviderCallbackEvent {
  /** Vendor event id. The de-duplication key. */
  eventId: string;
  providerId: string;
  family: ProviderFamily;
  type: ProviderEventType;
  /** The vendor's handle for the affected application, loan or OTP. */
  referenceId: string | null;
  /** Monotonic version the vendor asserts. Lower values are late arrivals. */
  sequence: number | null;
  occurredAt: Date;
  payload: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Ordering state
// ---------------------------------------------------------------------------

export interface ProviderEventState {
  /** Highest sequence applied so far. Null before the first event. */
  lastSequence: number | null;
  /**
   * Recently applied event ids.
   *
   * Bounded: unbounded set membership is a memory leak with a very long
   * half-life, and providers do not resend indefinitely.
   */
  recentEventIds: readonly string[];
}

export const EMPTY_EVENT_STATE: ProviderEventState = {
  lastSequence: null,
  recentEventIds: [],
};

export const MAX_REMEMBERED_EVENT_IDS = 256;

export const PROVIDER_EVENT_DISPOSITIONS = [
  "APPLY",
  "DUPLICATE",
  "OUT_OF_ORDER",
] as const;

export type ProviderEventDisposition =
  (typeof PROVIDER_EVENT_DISPOSITIONS)[number];

export interface ProviderEventDecision {
  disposition: ProviderEventDisposition;
  /** State to persist when the disposition is APPLY; otherwise unchanged. */
  nextState: ProviderEventState;
  /** Why this decision was taken. Surfaced in logs, never in responses. */
  rationale: string;
}

function remember(
  state: ProviderEventState,
  eventId: string,
): readonly string[] {
  if (state.recentEventIds.includes(eventId)) return state.recentEventIds;
  const appended = [...state.recentEventIds, eventId];
  return appended.slice(-MAX_REMEMBERED_EVENT_IDS);
}

/**
 * Decides what to do with an event.
 *
 * Duplicates are dropped first: an event that has already been applied is
 * dropped whatever its sequence, because re-applying it would double-count a
 * repayment. Then sequence is checked, so a late event cannot roll state
 * backwards.
 */
export function classifyProviderEvent(
  event: ProviderCallbackEvent,
  state: ProviderEventState = EMPTY_EVENT_STATE,
): ProviderEventDecision {
  if (state.recentEventIds.includes(event.eventId)) {
    return {
      disposition: "DUPLICATE",
      nextState: state,
      rationale: "event id already applied",
    };
  }

  if (event.sequence !== null && state.lastSequence !== null) {
    if (event.sequence <= state.lastSequence) {
      return {
        disposition: "OUT_OF_ORDER",
        nextState: state,
        rationale: `sequence ${event.sequence} is not ahead of ${state.lastSequence}`,
      };
    }
  }

  const highest = Math.max(
    state.lastSequence ?? Number.NEGATIVE_INFINITY,
    event.sequence ?? 0,
  );

  return {
    disposition: "APPLY",
    nextState: {
      lastSequence: Number.isFinite(highest) ? highest : null,
      recentEventIds: remember(state, event.eventId),
    },
    rationale: "first delivery and sequence is ahead of applied state",
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type WebhookVerificationFailure =
  | "SIGNATURE_MISSING"
  | "SIGNATURE_INVALID"
  | "TIMESTAMP_OUTSIDE_WINDOW"
  | "PROVIDER_UNKNOWN";

export type WebhookVerification =
  { verified: true } | { verified: false; reason: WebhookVerificationFailure };

/**
 * Verifies a webhook signature.
 *
 * Deliberately returns a decision rather than throwing: an unverifiable
 * callback is a routine, expected condition that must be answered with a
 * rejection, not a 500.
 */
export interface ProviderWebhookVerifier {
  readonly providerId: string;
  verify(input: {
    body: string;
    signature: string | null;
    timestamp: string | null;
    receivedAt: Date;
    /** Replay window. Outside it, reject even a correctly signed body. */
    toleranceSeconds: number;
  }): WebhookVerification;
}
