/**
 * Payload redaction for provider logging.
 *
 * Provider traffic is the single largest source of regulated data in the
 * system: PANs, Aadhaar numbers, account numbers, one-time codes. None of it may
 * reach a log sink, and the temptation to "just log the response body for
 * debugging" is exactly how it gets there.
 *
 * Redaction is therefore applied structurally — recursively, by key name, before
 * anything is serialised — rather than by remembering to be careful at each call
 * site.
 */

import type { RedactionRule } from "../../application/providers/index.js";

/** Longest payload fragment kept in a log line before it is elided. */
export const MAX_LOGGED_BODY_LENGTH = 2_000;

export const ELIDED_MARKER = "[elided]";

export interface RedactionSummary {
  /** Number of fields whose values were replaced. */
  redactedFieldCount: number;
}

/**
 * Deep-copies a payload, replacing sensitive values with the placeholder.
 *
 * Matching is case-insensitive on the whole key, so `client_secret`,
 * `clientSecret` and `CLIENTSECRET` are all covered. Cycles are tolerated: a
 * provider payload that references itself must not hang the logger.
 */
/**
 * Normalises a key for matching: lowercase with separators removed.
 *
 * So `client_secret`, `clientSecret`, `CLIENT-SECRET` and `Client.Secret` all
 * reduce to `clientsecret` and match the same rule. Matching on the raw key
 * misses every one of the vendor spellings, which is the whole reason a secret
 * ends up in a log in the first place.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Builds the matcher for a rule.
 *
 * Containment rather than equality: `xApiKey`, `x-api-key` and `apiKeyHeader`
 * all contain `apikey`. Over-redacting an innocuous field costs a debugging
 * minute; under-redacting a credential costs a breach, so the bias is deliberate.
 */
function sensitiveMatcher(rule: RedactionRule): (key: string) => boolean {
  const normalised = rule.sensitiveKeys
    .map((key) => normalizeKey(key))
    .filter((key) => key.length > 0);

  return (key: string): boolean => {
    const candidate = normalizeKey(key);
    if (candidate.length === 0) return false;
    return normalised.some((sensitive) => candidate.includes(sensitive));
  };
}

export function redactPayload(
  value: unknown,
  rule: RedactionRule,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item, rule, seen));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  const isSensitive = sensitiveMatcher(rule);
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitive(key)) {
      output[key] = rule.placeholder;
      continue;
    }
    output[key] = redactPayload(entry, rule, seen);
  }

  return output;
}

/** Counts how many fields a redaction pass replaced. Used by the contract tests. */
export function countRedactedFields(
  value: unknown,
  rule: RedactionRule,
): number {
  const isSensitive = sensitiveMatcher(rule);

  const walk = (node: unknown): number => {
    if (Array.isArray(node))
      return node.reduce<number>((sum, item) => sum + walk(item), 0);
    if (node === null || typeof node !== "object") return 0;

    let count = 0;
    for (const [key, entry] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (isSensitive(key)) {
        count += 1;
        continue;
      }
      count += walk(entry);
    }
    return count;
  };

  return walk(value);
}

/**
 * Redacts a serialised payload for logging.
 *
 * JSON is parsed, redacted structurally and re-serialised. Anything that is not
 * valid JSON is never logged verbatim — an unparseable body may be a binary
 * document or an error page containing an account number, so only its length is
 * reported.
 */
export function redactBody(body: string, rule: RedactionRule): string {
  if (body.length === 0) return "";

  try {
    const parsed: unknown = JSON.parse(body);
    const serialised = JSON.stringify(redactPayload(parsed, rule));
    return truncate(serialised ?? ELIDED_MARKER);
  } catch {
    return `${ELIDED_MARKER} non-json body of ${body.length} bytes`;
  }
}

export function truncate(
  value: string,
  limit = MAX_LOGGED_BODY_LENGTH,
): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** Redacts a header bag, preserving the header names for diagnosis. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  rule: RedactionRule,
): Record<string, string> {
  const isSensitive = sensitiveMatcher(rule);
  const output: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    // Header names are matched on content rather than exact equality, because
    // vendors ship `X-Api-Key`, `X-APIKEY` and `api-key` interchangeably.
    output[key] = isSensitive(key) ? rule.placeholder : value;
  }

  return output;
}
