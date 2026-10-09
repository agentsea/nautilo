import { describe, expect, test } from "bun:test";
import {
  parseDurableServiceFundingBinding,
  type DurableServiceFundingBinding,
} from "../../src/service-funding";

const PERSONAL: DurableServiceFundingBinding = {
  humanUserId: "10000000-0000-4000-8000-000000000001",
  provider: "cloudconvert",
  binding: {
    kind: "personal",
    providerRoute: "cloudconvert",
    credentialId: "20000000-0000-4000-8000-000000000002",
    credentialRevision: 3,
  },
  credentialFingerprint: "a".repeat(64),
};

describe("durable service funding binding", () => {
  test("parses exact personal and server bindings", () => {
    expect(parseDurableServiceFundingBinding(PERSONAL)).toEqual(PERSONAL);
    expect(parseDurableServiceFundingBinding({
      humanUserId: PERSONAL.humanUserId,
      provider: "browser-use",
      binding: { kind: "server", providerRoute: "browser-use" },
      credentialFingerprint: "0".repeat(64),
    })).toEqual({
      humanUserId: PERSONAL.humanUserId,
      provider: "browser-use",
      binding: { kind: "server", providerRoute: "browser-use" },
      credentialFingerprint: "0".repeat(64),
    });
  });

  test("rejects widened, mismatched, or malformed persisted values", () => {
    for (const value of [
      { ...PERSONAL, apiKey: "secret" },
      { ...PERSONAL, humanUserId: "not-a-user-id" },
      { ...PERSONAL, provider: "other" },
      { ...PERSONAL, credentialFingerprint: "A".repeat(64) },
      { ...PERSONAL, credentialFingerprint: "short" },
      { ...PERSONAL, binding: { ...PERSONAL.binding, providerRoute: "tavily" } },
    ]) {
      expect(() => parseDurableServiceFundingBinding(value)).toThrow(TypeError);
    }
  });
});
