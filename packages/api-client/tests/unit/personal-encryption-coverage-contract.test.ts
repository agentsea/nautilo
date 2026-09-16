import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NautiloApiClient } from "../../src/client";
import {
  personalEncryptionCoverageV1Schema,
  type PersonalEncryptionCoverageV1,
} from "../../src/schemas/personal-encryption-coverage";

const active: PersonalEncryptionCoverageV1 = {
  dtoVersion: 1,
  policy: "shadow_encryption",
  computedAt: "2026-09-03T09:15:00.000Z",
  families: [
    { family: "message", measurement: "measured", accessible: "4731", plaintextPresent: "4731", encryptedCounterpart: "127" },
    { family: "memory", measurement: "measured", accessible: "241", plaintextPresent: "241", encryptedCounterpart: "0" },
    { family: "journal_event", measurement: "measured", accessible: "1013", plaintextPresent: "1013", encryptedCounterpart: "0" },
    { family: "reflection_record", measurement: "unavailable", accessible: null, plaintextPresent: null, encryptedCounterpart: null },
    { family: "artifact", measurement: "measured", accessible: "156", plaintextPresent: "156", encryptedCounterpart: "0" },
    { family: "task", measurement: "unsupported", accessible: "34", plaintextPresent: "34", encryptedCounterpart: null },
  ],
};

describe("M308 personal encryption coverage contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("accepts the inactive plaintext-only shape and stable active family tuple", () => {
    expect(personalEncryptionCoverageV1Schema.parse({
      dtoVersion: 1,
      policy: "plaintext_only",
      computedAt: null,
      families: [],
    }).policy).toBe("plaintext_only");
    expect(personalEncryptionCoverageV1Schema.parse(active)).toEqual(active);
  });

  test("rejects missing, reordered, unknown, and extra families", () => {
    const missing = { ...active, families: active.families.slice(0, -1) };
    expect(personalEncryptionCoverageV1Schema.safeParse(missing).success).toBe(false);

    const reordered = {
      ...active,
      families: [active.families[1], active.families[0], ...active.families.slice(2)],
    };
    expect(personalEncryptionCoverageV1Schema.safeParse(reordered).success).toBe(false);

    const unknown = structuredClone(active) as unknown as { families: Array<Record<string, unknown>> };
    unknown.families[0]!["family"] = "attachment";
    expect(personalEncryptionCoverageV1Schema.safeParse(unknown).success).toBe(false);

    expect(personalEncryptionCoverageV1Schema.safeParse({
      ...active,
      extra: true,
    }).success).toBe(false);
  });

  test("never permits unsupported or unavailable measurements to masquerade as zero", () => {
    const unsupportedWithZero = structuredClone(active) as unknown as {
      families: Array<Record<string, unknown>>;
    };
    unsupportedWithZero.families[5]!["encryptedCounterpart"] = "0";
    expect(personalEncryptionCoverageV1Schema.safeParse(unsupportedWithZero).success).toBe(false);

    const unavailableWithZero = structuredClone(active) as unknown as {
      families: Array<Record<string, unknown>>;
    };
    unavailableWithZero.families[3]!["accessible"] = "0";
    expect(personalEncryptionCoverageV1Schema.safeParse(unavailableWithZero).success).toBe(false);
  });

  test("preserves arbitrarily large unsigned decimal counts and rejects malformed counts", () => {
    const large = structuredClone(active);
    large.families[0].accessible = "184467440737095516160000";
    const parsed = personalEncryptionCoverageV1Schema.parse(large);
    expect(parsed.policy).toBe("shadow_encryption");
    if (parsed.policy !== "plaintext_only") {
      expect(parsed.families[0].accessible).toBe("184467440737095516160000");
    }

    const malformed = structuredClone(active);
    malformed.families[0].accessible = "01";
    expect(personalEncryptionCoverageV1Schema.safeParse(malformed).success).toBe(false);
  });

  test("client uses the authenticated ordinary GET and forwards cancellation", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = Object.assign(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      seenUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      seenInit = init;
      return new Response(JSON.stringify(active), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("personal-token");
    const controller = new AbortController();
    expect(await client.encryptionCoverage.getPersonal({ signal: controller.signal }))
      .toEqual(active);
    expect(seenUrl).toBe("http://127.0.0.1:9/api/encryption/coverage/me");
    expect(seenInit?.method).toBe("GET");
    expect(new Headers(seenInit?.headers).get("authorization")).toBe("Bearer personal-token");
    expect(seenInit?.signal).toBe(controller.signal);
  });
});
