import { describe, expect, test } from "bun:test";

import {
  ConnectedWebOperationSecretError,
  ConnectedWebOperationSecrets,
  isConnectedWebOperationSealedEnvelope,
  mintConnectedWebOperationId,
} from "../../src/connected-web-accounts/operation-secrets";

const context = {
  operationId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  accountId: "33333333-3333-4333-8333-333333333333",
};

function secrets(): ConnectedWebOperationSecrets {
  let byte = 0;
  return new ConnectedWebOperationSecrets({
    stableServerSecret: "a stable server-only test secret that is never persisted",
    nonce: (length) => Buffer.alloc(length, byte++),
  });
}

function failureMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectedWebOperationSecretError);
    return (error as Error).message;
  }
  throw new Error("Expected operation secret failure");
}

describe("D568 supervised operation secret codec", () => {
  test("mints a UUID before binding and round-trips intent plus every provider coordinate", () => {
    const operationId = mintConnectedWebOperationId();
    expect(operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

    const codec = secrets();
    const sealedIntent = codec.sealIntent({ context, intent: "Research a connected website without changes." });
    const references = codec.sealProviderReferences({
      context,
      coordinates: {
        runId: "run-private-coordinate",
        sessionId: "session-private-coordinate",
        workspaceId: "workspace-private-coordinate",
        browserId: "browser-private-coordinate",
      },
    });

    expect(isConnectedWebOperationSealedEnvelope(sealedIntent)).toBe(true);
    expect(sealedIntent).not.toContain("Research a connected website");
    expect(Object.values(references)).not.toContain("run-private-coordinate");
    expect(codec.unsealIntent({ context, sealedIntent })).toBe("Research a connected website without changes.");
    expect(codec.unsealProviderReferences({ context, references })).toEqual({
      runId: "run-private-coordinate",
      sessionId: "session-private-coordinate",
      workspaceId: "workspace-private-coordinate",
      browserId: "browser-private-coordinate",
    });
  });

  test("uses versioned canonical envelopes with fresh nonces and rejects malformed ones", () => {
    const codec = secrets();
    const first = codec.sealIntent({ context, intent: "same intent" });
    const second = codec.sealIntent({ context, intent: "same intent" });
    expect(first).not.toBe(second);
    expect(first.split(".")).toHaveLength(4);
    expect(first).toStartWith("cwo1.");
    expect(isConnectedWebOperationSealedEnvelope(first)).toBe(true);
    expect(isConnectedWebOperationSealedEnvelope("sealed:opaque")).toBe(false);
    expect(isConnectedWebOperationSealedEnvelope("cwo1.a.b.c.extra")).toBe(false);
    expect(isConnectedWebOperationSealedEnvelope("cwo1.!!!!.!!!!.!!!!")).toBe(false);
  });

  test("uses UTF-8 byte limits that fit the existing sealed intent and provider-ref store bounds", () => {
    const codec = secrets();
    const intentAtBoundary = "😀".repeat(3_063); // 12,252 bytes; encrypted envelope is <= 16,384 bytes.
    const sealedIntent = codec.sealIntent({ context, intent: intentAtBoundary });
    expect(Buffer.byteLength(sealedIntent, "utf8")).toBeLessThanOrEqual(16_384);
    expect(codec.unsealIntent({ context, sealedIntent })).toBe(intentAtBoundary);
    expect(() => codec.sealIntent({ context, intent: "😀".repeat(3_064) })).toThrow(ConnectedWebOperationSecretError);

    const providerAtBoundary = "😀".repeat(375); // 1,500 bytes; encrypted ref is <= 2,048 bytes.
    const references = codec.sealProviderReferences({ context, coordinates: { runId: providerAtBoundary } });
    expect(Buffer.byteLength(references.runRef!, "utf8")).toBeLessThanOrEqual(2_048);
    expect(() => codec.sealProviderReferences({ context, coordinates: { runId: "😀".repeat(376) } })).toThrow(ConnectedWebOperationSecretError);
  });

  test("fails closed and does not disclose provider coordinates for tamper, field swap, or context swap", () => {
    const codec = secrets();
    const references = codec.sealProviderReferences({ context, coordinates: { runId: "run-private-coordinate" } });
    const runRef = references.runRef!;
    const tampered = `${runRef.slice(0, -1)}${runRef.endsWith("A") ? "B" : "A"}`;
    const tamperMessage = failureMessage(() => codec.unsealProviderReferences({
      context,
      references: { version: 1, runRef: tampered },
    }));
    expect(tamperMessage).not.toContain("run-private-coordinate");

    const fieldSwapMessage = failureMessage(() => codec.unsealProviderReferences({
      context,
      references: { version: 1, sessionRef: runRef },
    }));
    expect(fieldSwapMessage).not.toContain("run-private-coordinate");

    for (const swappedContext of [
      { ...context, operationId: "44444444-4444-4444-8444-444444444444" },
      { ...context, ownerUserId: "55555555-5555-4555-8555-555555555555" },
      { ...context, accountId: "66666666-6666-4666-8666-666666666666" },
    ]) {
      const message = failureMessage(() => codec.unsealProviderReferences({
        context: swappedContext,
        references,
      }));
      expect(message).not.toContain("run-private-coordinate");
    }
  });

  test("uses supplied stable secret across codec instances and rejects invalid context or plaintext", () => {
    const first = secrets();
    const sealedIntent = first.sealIntent({ context, intent: "server restart should open this" });
    const second = new ConnectedWebOperationSecrets({
      stableServerSecret: "a stable server-only test secret that is never persisted",
    });
    expect(second.unsealIntent({ context, sealedIntent })).toBe("server restart should open this");
    expect(() => first.sealIntent({
      context: { ...context, accountId: "not-a-uuid" },
      intent: "never seal",
    })).toThrow(ConnectedWebOperationSecretError);
    expect(() => first.sealIntent({ context, intent: "" })).toThrow(ConnectedWebOperationSecretError);
    expect(() => new ConnectedWebOperationSecrets({ stableServerSecret: "" })).toThrow(ConnectedWebOperationSecretError);
  });
});
