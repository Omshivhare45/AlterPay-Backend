/**
 * Credential rotation, artifact retention and log redaction.
 *
 * These are the three places where a provider integration is most likely to leak
 * a secret, a customer's document or a live credential somewhere it should never
 * be. Each is tested against the behaviour that would actually hurt.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_REDACTION,
  DEFAULT_RETENTION_DAYS,
  describeCredentialShape,
  fingerprint,
  resolveRetentionDays,
  type ApiKeyCredential,
  type ProviderCredentialValue,
  type ProviderArtifactPutInput,
  type StageCredentialInput,
} from "../../../../src/application/providers/index.js";
import {
  CipherbackedProviderCredentialStore,
  InMemoryProviderCredentialStore,
} from "../../../../src/integrations/credentials/index.js";
import {
  InMemoryObjectStorageClient,
  S3ArtifactStore,
} from "../../../../src/integrations/artifacts/index.js";
import {
  countRedactedFields,
  redactBody,
  redactHeaders,
  redactPayload,
  redactUrl,
} from "../../../../src/integrations/transport/index.js";

const API_KEY: ApiKeyCredential = {
  kind: "API_KEY",
  key: "sk-live-super-secret-value",
  secret: null,
  headerName: "X-Api-Key",
};

/** Reads the key out of the credential union without pretending it is narrower. */
function keyOf(value: ProviderCredentialValue | undefined): string | null {
  return value !== undefined && value.kind === "API_KEY" ? value.key : null;
}

function cipher(): {
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
} {
  // Reversible stand-in: what matters here is that the store round-trips through
  // the cipher and that no plaintext is retained outside it.
  return {
    encrypt: async (value) => Buffer.from(value, "utf8").toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString("utf8"),
  };
}

function store(): CipherbackedProviderCredentialStore {
  return new CipherbackedProviderCredentialStore({
    cipher: cipher(),
    clock: { now: () => new Date("2026-03-01T00:00:00.000Z") },
  });
}

function staged(
  overrides: Partial<StageCredentialInput> = {},
): StageCredentialInput {
  return {
    providerId: "lender-x",
    family: "LENDING",
    value: API_KEY,
    validFrom: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("credential rotation", () => {
  it("resolves the first staged credential as active", async () => {
    const credentials = store();
    await credentials.stage(staged());

    const resolved = await credentials.resolveAt(
      "lender-x",
      new Date("2026-03-02T00:00:00.000Z"),
    );
    expect(resolved?.value).toEqual(API_KEY);
    expect(resolved?.metadata.status).toBe("ACTIVE");
  });

  it("keeps the previous version active while a new one is staged", async () => {
    const credentials = store();
    await credentials.stage(staged());

    const pending = await credentials.stage(
      staged({
        value: {
          kind: "API_KEY",
          key: "sk-live-rotated-value",
          secret: null,
          headerName: "X-Api-Key",
        },
      }),
    );

    // Two-phase rotation: the new secret must not be trusted until it works.
    expect(pending.metadata.status).toBe("PENDING_ROTATION");
    expect(
      keyOf(
        (
          await credentials.resolveAt(
            "lender-x",
            new Date("2026-03-02T00:00:00.000Z"),
          )
        )?.value,
      ),
    ).toBe("sk-live-super-secret-value");
  });

  it("promotes a staged credential on activation and revokes its predecessor", async () => {
    const credentials = store();
    await credentials.stage(staged());
    await credentials.stage(
      staged({
        value: {
          kind: "API_KEY",
          key: "sk-live-rotated-value",
          secret: null,
          headerName: "X-Api-Key",
        },
      }),
    );

    const activated = await credentials.activate(
      "lender-x",
      new Date("2026-03-02T00:00:00.000Z"),
    );

    expect(activated.metadata.status).toBe("ACTIVE");
    expect(
      keyOf(
        (
          await credentials.resolveAt(
            "lender-x",
            new Date("2026-03-03T00:00:00.000Z"),
          )
        )?.value,
      ),
    ).toBe("sk-live-rotated-value");

    const history = await credentials.history("lender-x");
    expect(history.map((entry) => entry.metadata.status)).toEqual([
      "ACTIVE",
      "REVOKED",
    ]);
  });

  it("revokes explicitly, by version", async () => {
    const credentials = store();
    await credentials.stage(staged());

    await credentials.revoke(
      "lender-x",
      1,
      new Date("2026-03-02T00:00:00.000Z"),
    );

    expect((await credentials.history("lender-x"))[0]?.metadata.status).toBe(
      "REVOKED",
    );
  });

  it("does not resolve a credential before its validFrom", async () => {
    const credentials = store();
    await credentials.stage(
      staged({ validFrom: new Date("2026-06-01T00:00:00.000Z") }),
    );

    expect(
      await credentials.resolveAt(
        "lender-x",
        new Date("2026-03-02T00:00:00.000Z"),
      ),
    ).toBeNull();
    expect(
      (
        await credentials.resolveAt(
          "lender-x",
          new Date("2026-06-02T00:00:00.000Z"),
        )
      )?.value,
    ).toEqual(API_KEY);
  });

  it("describes a credential without exposing it", () => {
    const shape = describeCredentialShape(API_KEY);

    expect(JSON.stringify(shape)).not.toContain("sk-live-super-secret-value");
    expect(shape["kind"]).toBe("API_KEY");
    expect(fingerprint(API_KEY.key)).toHaveLength(8);
  });

  it("supports the same rotation flow in the in-memory store", async () => {
    const credentials = new InMemoryProviderCredentialStore();
    await credentials.stage(staged());

    expect(
      keyOf(
        (
          await credentials.resolveAt(
            "lender-x",
            new Date("2026-03-02T00:00:00.000Z"),
          )
        )?.value,
      ),
    ).toBe("sk-live-super-secret-value");
  });
});

describe("artifact retention and integrity", () => {
  const artifacts = new S3ArtifactStore({
    client: new InMemoryObjectStorageClient(),
    bucket: "alterpay-provider-artifacts",
    now: () => new Date("2026-03-01T00:00:00.000Z"),
    idGenerator: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `artifact-${counter}`;
      };
    })(),
  });

  const put: ProviderArtifactPutInput = {
    providerId: "bureau-y",
    family: "CREDIT_BUREAU",
    providerReferenceId: "enq-1",
    kind: "CREDIT_REPORT",
    classification: "FINANCIAL",
    contentType: "application/json",
    body: '{"score":742}',
    merchantId: "merch-1",
    retentionDays: 30,
    requestId: "req-1",
    correlationId: "cor-1",
  };

  it("stores and reads back an artifact with a content hash", async () => {
    const ref = await artifacts.put(put);
    const payload = await artifacts.get(ref.artifactId);

    expect(Buffer.from(payload?.body ?? []).toString("utf8")).toBe(
      '{"score":742}',
    );
    expect(ref.sha256).toHaveLength(64);
    expect(payload?.ref.sha256).toBe(ref.sha256);
  });

  it("encrypts at rest by default", async () => {
    const ref = await artifacts.put(put);

    expect(ref.encrypted).toBe(true);
  });

  it("refuses to return an artifact it does not hold", async () => {
    expect(await artifacts.get("artifact-does-not-exist")).toBeNull();
    expect(await artifacts.head("artifact-does-not-exist")).toBeNull();
  });

  it("deletes an artifact so a retention or erasure request can be honoured", async () => {
    const ref = await artifacts.put(put);

    expect(await artifacts.delete(ref.artifactId)).toBe(true);
    expect(await artifacts.delete(ref.artifactId)).toBe(false);
    expect(await artifacts.get(ref.artifactId)).toBeNull();
  });

  it("holds a document for at least the classification minimum", async () => {
    const ref = await artifacts.put(put);

    // A shorter request than the regulatory floor is raised, not honoured:
    // financial records have a minimum retention obligation.
    expect(ref.retentionDays).toBe(DEFAULT_RETENTION_DAYS.FINANCIAL);
    expect(ref.expiresAt?.toISOString()).toBe("2033-02-27T00:00:00.000Z");
  });

  it("clamps an absurd retention request to the store ceiling", async () => {
    const ref = await artifacts.put({ ...put, retentionDays: 100_000 });

    expect(
      resolveRetentionDays(ref.classification, ref.retentionDays, 2555),
    ).toBe(2555);
    expect(ref.retentionDays).toBe(2555);
  });

  it("expires PII sooner than a financial artifact", () => {
    expect(resolveRetentionDays("PII", 1, 2555)).toBeLessThan(
      resolveRetentionDays("FINANCIAL", 1, 2555),
    );
  });
});

describe("outbound redaction", () => {
  it("redacts credentials in a header bag while keeping the names", () => {
    const redacted = redactHeaders(
      {
        authorization: "Bearer sk-live-secret",
        "x-api-key": "sk-live-secret",
        "content-type": "application/json",
      },
      DEFAULT_REDACTION,
    );

    expect(redacted["authorization"]).not.toContain("sk-live-secret");
    expect(redacted["x-api-key"]).not.toContain("sk-live-secret");
    expect(redacted["content-type"]).toBe("application/json");
  });

  it("redacts customer identifiers at any depth", () => {
    const redacted = redactPayload(
      {
        pan: "ABCDE1234F",
        mobile: "+919876543210",
        nested: { client_secret: "shhh", safe: "ok" },
      },
      DEFAULT_REDACTION,
    ) as Record<string, unknown>;

    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain("ABCDE1234F");
    expect(serialised).not.toContain("919876543210");
    expect(serialised).not.toContain("shhh");
    expect((redacted["nested"] as { safe: string }).safe).toBe("ok");
  });

  it("matches sensitive keys case-insensitively", () => {
    const redacted = redactPayload(
      { ClientSecret: "shhh" },
      DEFAULT_REDACTION,
    ) as Record<string, string>;

    expect(redacted["ClientSecret"]).toBe(DEFAULT_REDACTION.placeholder);
  });

  it("counts what it removed so a gap is visible", () => {
    expect(
      countRedactedFields(
        { pan: "ABCDE1234F", nested: { mobile: "+91" }, ok: 1 },
        DEFAULT_REDACTION,
      ),
    ).toBe(2);
  });

  it("redacts a serialised body structurally", () => {
    const redacted = redactBody(
      '{"pan":"ABCDE1234F","score":742}',
      DEFAULT_REDACTION,
    );

    expect(redacted).not.toContain("ABCDE1234F");
    expect(redacted).toContain("742");
  });

  it("never logs an unparseable body verbatim", () => {
    // An unparseable body may be a binary document or an error page containing an
    // account number, so only its length is reported.
    const redacted = redactBody(
      "not json at all 9988776655",
      DEFAULT_REDACTION,
    );

    expect(redacted).not.toContain("9988776655");
  });

  it("redacts a query string that carries customer data", () => {
    expect(
      redactUrl("https://bureau.example.com/report?pan=ABCDE1234F"),
    ).not.toContain("ABCDE1234F");
  });

  it("leaves a URL without a query string alone", () => {
    expect(redactUrl("https://bureau.example.com/report")).toBe(
      "https://bureau.example.com/report",
    );
  });

  it("tolerates a circular payload without hanging", () => {
    const payload: Record<string, unknown> = { pan: "ABCDE1234F" };
    payload["self"] = payload;

    expect(() => redactPayload(payload, DEFAULT_REDACTION)).not.toThrow();
  });
});
