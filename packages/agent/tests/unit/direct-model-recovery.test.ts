import { describe, expect, test } from "bun:test";
import { runAdmittedDirectModelRecovery } from "../../src/runtime/direct-model-recovery";
import type { ForegroundChatFundingSession } from "../../src/runtime/foreground-chat-funding";

const MODEL = "openrouter:openai/gpt-5.6-sol";
const missing = () => Object.assign(new Error("missing server direct"), { code: "provider_credentials_missing" });

function sessions(options: { directAvailable?: boolean; source?: "server" | "personal" } = {}) {
  const order: string[] = [];
  const recovery: ForegroundChatFundingSession = {
    kind: "personal",
    async recheckAttempt() {},
    async runAttempt(_modelId, run) {
      order.push("personal-direct");
      return run({ usageFunding: { kind: "personal", humanUserId: "human", payerHumanId: "human",
        providerRoute: "openrouter", credentialId: "credential", credentialRevision: 1 },
        personalCredential: { apiKey: "synthetic" } });
    },
  };
  const primary: ForegroundChatFundingSession = {
    kind: options.source ?? "server",
    async recheckAttempt() {},
    async runAttempt(_modelId, run, transport) {
      expect(transport).toBe("direct");
      order.push("server-direct-admission");
      if (!options.directAvailable) throw missing();
      return run({ usageFunding: { kind: "server", humanUserId: "human", providerRoute: "openrouter" } });
    },
    async openPersonalDirectRecovery(candidate) {
      expect(candidate).toBe(MODEL);
      order.push("personal-admission");
      return recovery;
    },
  };
  return { primary, recovery, order };
}

describe("direct model recovery admission", () => {
  test("server direct keeps priority when available", async () => {
    const h = sessions({ directAvailable: true });
    expect(await runAdmittedDirectModelRecovery(h.primary, MODEL, async ({ usageFunding }, session) => {
      expect(session).toBe(h.primary);
      return usageFunding.kind;
    })).toBe("server");
    expect(h.order).toEqual(["server-direct-admission"]);
  });

  test("absent server direct may enter only the explicit personal recovery session", async () => {
    const h = sessions();
    expect(await runAdmittedDirectModelRecovery(h.primary, MODEL, async ({ usageFunding }, session) => {
      expect(session).toBe(h.recovery);
      return usageFunding.kind;
    })).toBe("personal");
    expect(h.order).toEqual(["server-direct-admission", "personal-admission", "personal-direct"]);
    expect(h.primary.kind).toBe("server");
  });

  test("a callback failure cannot authorize another payer even if it uses a missing-key code", async () => {
    const h = sessions({ directAvailable: true });
    expect(runAdmittedDirectModelRecovery(h.primary, MODEL, async () => { throw missing(); })).rejects.toThrow();
    expect(h.order).toEqual(["server-direct-admission"]);
  });

  test.each(["personal_credentials_disabled", "server_credentials_forbidden", "funding_source_changed", "personal_credential_unavailable"])("%s is terminal before dispatch", async (code) => {
    const h = sessions();
    h.primary.runAttempt = async () => { throw Object.assign(new Error(code), { code }); };
    expect(runAdmittedDirectModelRecovery(h.primary, MODEL, async () => "unexpected")).rejects.toThrow(code);
    expect(h.order).toEqual([]);
  });

  test("a personal primary cannot request a second payer", async () => {
    const h = sessions({ source: "personal" });
    expect(runAdmittedDirectModelRecovery(h.primary, MODEL, async () => "unexpected")).rejects.toThrow();
    expect(h.order).toEqual(["server-direct-admission"]);
  });
});
