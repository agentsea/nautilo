import { expect, test } from "bun:test";
import { ProviderCredentialApiError } from "@nautilo/api-client/browser";
import { readPersonalChatReadiness } from "./personal-chat-readiness";

test("a saved personal key and caller-selectable model make chat ready", async () => {
  const result = await readPersonalChatReadiness({
    listCredentials: async () => ({ credentials: [{ requiresReplacement: false }] }),
    getCallerModels: async () => [{ availability: "selectable" }],
  });
  expect(result).toBe("ready");
});

test("stored non-chat keys do not count as a personal chat setup", async () => {
  const providers = [
    { id: "openai", personalCapabilities: ["chat"] },
    { id: "elevenlabs", personalCapabilities: [] },
  ];
  const getCallerModels = async () => [{ availability: "selectable" }];
  const nonChat = { provider: "elevenlabs", requiresReplacement: true };
  expect(await readPersonalChatReadiness({
    listCredentials: async () => ({ credentials: [nonChat], providers }),
    getCallerModels,
  })).toBe("missing-key");
  expect(await readPersonalChatReadiness({
    listCredentials: async () => ({
      credentials: [nonChat, { provider: "openai", requiresReplacement: false }], providers,
    }),
    getCallerModels,
  })).toBe("ready");
});

test("retained chat keys and older servers defer readiness to the caller model catalogue", async () => {
  for (const providers of [[], [{ id: "openai", personalCapabilities: ["chat"] }]]) {
    expect(await readPersonalChatReadiness({
      listCredentials: async () => ({
        credentials: [{ provider: "xai", requiresReplacement: false }], providers,
      }),
      getCallerModels: async () => [{ availability: "selectable" }],
    })).toBe("ready");
  }
});

test("missing or disaster-reset keys cannot be replaced by a server model", async () => {
  let modelLookupCount = 0;
  const result = await readPersonalChatReadiness({
    listCredentials: async () => ({ credentials: [{ requiresReplacement: true }] }),
    getCallerModels: async () => {
      modelLookupCount++;
      return [{ availability: "selectable" }];
    },
  });
  expect(result).toBe("missing-key");
  expect(modelLookupCount).toBe(0);
});

test("a dual-capability caller uses server chat only when no personal row takes precedence", async () => {
  const listCredentials = async () => ({ credentials: [] as { requiresReplacement: boolean }[] });
  const getCallerModels = async () => [{ availability: "selectable" }];
  expect(await readPersonalChatReadiness({ listCredentials, getCallerModels }, {
    serverFallbackAvailable: true,
  })).toBe("ready");
  expect(await readPersonalChatReadiness({
    listCredentials: async () => ({ credentials: [{ requiresReplacement: true }] }),
    getCallerModels,
  }, { serverFallbackAvailable: true })).toBe("missing-key");
});

test("a configured key without a caller-eligible model needs model repair", async () => {
  const result = await readPersonalChatReadiness({
    listCredentials: async () => ({ credentials: [{ requiresReplacement: false }] }),
    getCallerModels: async () => [{ availability: "missing-key" }],
  });
  expect(result).toBe("missing-model");
});

test("switch-off and transport failure have distinct recovery states", async () => {
  const disabled = await readPersonalChatReadiness({
    listCredentials: async () => {
      throw new ProviderCredentialApiError(403, "personal_credentials_disabled", false, false, null);
    },
    getCallerModels: async () => [],
  });
  expect(disabled).toBe("disabled");
  const unavailable = await readPersonalChatReadiness({
    listCredentials: async () => { throw new Error("network unavailable"); },
    getCallerModels: async () => [],
  });
  expect(unavailable).toBe("unavailable");
});


test("policy-off metadata remains cleanup-only and does not make personal chat ready", async () => {
  let lookups = 0;
  const deps = {
    listCredentials: async () => ({ allowPersonalProviderKeys: false, credentials: [{ requiresReplacement: false }] }),
    getCallerModels: async () => { lookups++; return [{ availability: "selectable" }]; },
  };
  expect(await readPersonalChatReadiness(deps)).toBe("disabled");
  expect(await readPersonalChatReadiness(deps, { serverFallbackAvailable: true })).toBe("ready");
  expect(lookups).toBe(0);
});
