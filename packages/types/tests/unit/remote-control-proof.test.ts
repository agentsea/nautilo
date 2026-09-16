import { describe, expect, test } from "bun:test";
import {
  canonicalRemotePairingTranscript,
  canonicalRemoteOrdinaryRequestTranscript,
  canonicalRemoteOrdinaryRequestBody,
  isLowercaseHex,
  normalizeRemoteOrdinaryRequestBody,
} from "../../src/remote-control-proof";

const input = {
  challengeId: "11111111-1111-4111-8111-111111111111",
  ceremonyContext: "ab".repeat(32),
  installationId: "22222222-2222-4222-8222-222222222222",
  algorithm: "Ed25519" as const,
  publicKey: "cd".repeat(32),
};

describe("remote pairing proof transcript", () => {
  test("is a stable JSON array rather than an object", () => {
    expect(canonicalRemotePairingTranscript(input)).toBe(
      '["nautilo.remote-pairing.consume.v1","11111111-1111-4111-8111-111111111111","' +
        "ab".repeat(32) +
        '","22222222-2222-4222-8222-222222222222","Ed25519","' +
        "cd".repeat(32) +
        '"]',
    );
  });

  test("rejects mutations and non-canonical encodings", () => {
    expect(() => canonicalRemotePairingTranscript({ ...input, publicKey: input.publicKey.toUpperCase() })).toThrow();
    expect(() => canonicalRemotePairingTranscript({ ...input, ceremonyContext: "0".repeat(63) })).toThrow();
    expect(() => canonicalRemotePairingTranscript({
      ...input,
      installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(),
    })).toThrow();
    expect(isLowercaseHex("00", 1)).toBe(true);
    expect(isLowercaseHex("0A", 1)).toBe(false);
  });
});

describe("remote ordinary request proof transcript", () => {
  const ordinary = {
    serverInstanceId: "11111111-1111-4111-8111-111111111111",
    serverBindingGeneration: 2,
    controllerInstallationId: "22222222-2222-4222-8222-222222222222",
    installationId: "33333333-3333-4333-8333-333333333333",
    installationGeneration: 4,
    requestId: "44444444-4444-4444-8444-444444444444",
    issuedAtMs: 1_800_000_000_000,
    method: "POST",
    path: "/api/rooms/55555555-5555-4555-8555-555555555555/messages",
    bodySha256: "ab".repeat(32),
  };

  test("binds exact server, installation, request, method, path, and body bytes", () => {
    expect(canonicalRemoteOrdinaryRequestTranscript(ordinary)).toBe(
      JSON.stringify([
        "nautilo.remote-origin.ordinary-request.v1",
        ordinary.serverInstanceId,
        2,
        ordinary.controllerInstallationId,
        ordinary.installationId,
        4,
        ordinary.requestId,
        ordinary.issuedAtMs,
        "POST",
        ordinary.path,
        ordinary.bodySha256,
      ]),
    );
  });

  test("rejects ambiguous wire representations", () => {
    expect(() => canonicalRemoteOrdinaryRequestTranscript({ ...ordinary, method: "post" })).toThrow();
    expect(() => canonicalRemoteOrdinaryRequestTranscript({ ...ordinary, path: `${ordinary.path}?x=1` })).toThrow();
    expect(() => canonicalRemoteOrdinaryRequestTranscript({ ...ordinary, bodySha256: "AB".repeat(32) })).toThrow();
    expect(() => canonicalRemoteOrdinaryRequestTranscript({
      ...ordinary,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(),
    })).toThrow();
  });

  test("canonicalizes JSON object keys without reordering arrays", () => {
    expect(canonicalRemoteOrdinaryRequestBody({ z: [3, 1], a: { y: true, x: null } })).toBe(
      '{"a":{"x":null,"y":true},"z":[3,1]}',
    );
    expect(canonicalRemoteOrdinaryRequestBody({ b: 2, a: 1 })).toBe(
      canonicalRemoteOrdinaryRequestBody({ a: 1, b: 2 }),
    );
    expect(() => canonicalRemoteOrdinaryRequestBody({ nope: undefined })).toThrow();
    expect(() => canonicalRemoteOrdinaryRequestBody(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("local Electron ordinary request body normalization", () => {
  test("omits the Writer tableCellRange undefined field before canonicalizing and sending", () => {
    const normalized = normalizeRemoteOrdinaryRequestBody({
      content: "Please summarize the selected table.",
      activeMiniApp: {
        selection: {
          anchor: { blockId: "writer-block-1", offset: 0 },
          focus: { blockId: "writer-block-2", offset: 19 },
          tableCellRange: undefined,
        },
      },
    });

    expect(normalized).toEqual({
      content: "Please summarize the selected table.",
      activeMiniApp: {
        selection: {
          anchor: { blockId: "writer-block-1", offset: 0 },
          focus: { blockId: "writer-block-2", offset: 19 },
        },
      },
    });
    expect(canonicalRemoteOrdinaryRequestBody(normalized)).toBe(
      '{"activeMiniApp":{"selection":{"anchor":{"blockId":"writer-block-1","offset":0},"focus":{"blockId":"writer-block-2","offset":19}}},"content":"Please summarize the selected table."}',
    );
  });

  test("uses JSON array null semantics and leaves canonical ordering to the canonicalizer", () => {
    expect(normalizeRemoteOrdinaryRequestBody({ z: [undefined, 2], a: 1 })).toEqual({
      z: [null, 2],
      a: 1,
    });
    const left = normalizeRemoteOrdinaryRequestBody({ b: 2, a: { z: true, x: null } });
    const right = normalizeRemoteOrdinaryRequestBody({ a: { x: null, z: true }, b: 2 });
    expect(canonicalRemoteOrdinaryRequestBody(left)).toBe(
      canonicalRemoteOrdinaryRequestBody(right),
    );
  });

  test("preserves a JSON __proto__ own key without changing the normalized object prototype", () => {
    const body = JSON.parse(
      '{"content":"Preserve a JSON key.","activeMiniApp":{"selection":{"z":2,"__proto__":{"preserved":true}}}}',
    ) as Record<string, unknown>;

    const normalized = normalizeRemoteOrdinaryRequestBody(body);
    const selection = (
      normalized["activeMiniApp"] as Record<string, unknown>
    )["selection"] as Record<string, unknown>;

    expect(Object.getPrototypeOf(selection)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(selection, "__proto__")).toBe(true);
    expect(selection["__proto__"]).toEqual({ preserved: true });
    expect(canonicalRemoteOrdinaryRequestBody(normalized)).toBe(
      '{"activeMiniApp":{"selection":{"__proto__":{"preserved":true},"z":2}},"content":"Preserve a JSON key."}',
    );
  });

  test("fails closed for unsupported values with bounded value-free structural diagnostics", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    const cases: Array<[unknown, string]> = [
      [{ function: () => {} }, "function at $.function"],
      [{ symbol: Symbol("selected content must not leak") }, "symbol at $.symbol"],
      [{ bigint: 1n }, "bigint at $.bigint"],
      [{ infinity: Number.POSITIVE_INFINITY }, "non-finite number at $.infinity"],
      [cyclic, "cyclic reference at $.self"],
      [undefined, "undefined at $"],
      ["chat body", "string at $"],
      [[], "array at $"],
      [null, "null at $"],
      [new Date(), "unsupported object at $"],
    ];

    for (const [value, diagnostic] of cases) {
      expect(() => normalizeRemoteOrdinaryRequestBody(value)).toThrow(diagnostic);
    }

    try {
      normalizeRemoteOrdinaryRequestBody({
        activeMiniApp: {
          selection: { tableCellRange: () => "secret selected text" },
        },
      });
      throw new Error("expected normalization to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("$.activeMiniApp.selection.tableCellRange");
      expect(message).not.toContain("secret selected text");
    }
  });
});
