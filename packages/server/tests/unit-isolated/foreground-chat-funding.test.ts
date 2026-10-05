import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const MODEL = "openrouter:moonshotai/kimi-k2.6";
const FALLBACK = "openrouter:z-ai/glm-5.2";

let switchOn = true;
let capabilities = ["use_personal_provider_credentials"];
let roomOwner = HUMAN;
let personalProviders = ["openrouter"];
let freshFundingKind: "personal" | "server" = "personal";
const resolveFunding = mock(async (input: {
  humanUserId: string;
  modelId: string;
  priorDecision?: { kind?: unknown };
}) => {
  const kind = input.priorDecision?.kind === "server" || input.priorDecision?.kind === "personal"
    ? input.priorDecision.kind
    : freshFundingKind;
  return kind === "server"
    ? {
        kind: "server" as const,
        humanUserId: input.humanUserId,
        modelId: input.modelId,
        workload: "foreground_text_chat" as const,
        providerRoute: "openrouter",
      }
    : {
        kind: "personal" as const,
        humanUserId: input.humanUserId,
        payerHumanId: input.humanUserId,
        modelId: input.modelId,
        workload: "foreground_text_chat" as const,
        providerRoute: "openrouter",
        credentialId: "synthetic-credential",
        credentialRevision: 4,
      };
});
const withKey = mock(async (
  _decision: Record<string, unknown>,
  run: (key: string) => Promise<unknown>,
  _deps: unknown,
  _initial: Record<string, unknown>,
) => run("synthetic-personal-secret"));
const assertInvoke = mock(async () => undefined);

const actualAgent = await import("@nautilo/agent");
const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  resolveRetainedModels: (ids: string[]) => ids.map((id) => ({ id, availability: "missing-key" })),
  getEligibleModels: ({ env }: { env: NodeJS.ProcessEnv }) =>
    env["OPENROUTER_API_KEY"]
      ? [MODEL, FALLBACK].map((id) => ({ id }))
      : [],
  modelHasRunnableCredentials: (modelId: string, env: NodeJS.ProcessEnv) =>
    modelId.startsWith("openrouter:") && Boolean(env["OPENROUTER_API_KEY"]),
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getServerProviderPolicy: async () => ({
    allowPersonalProviderKeys: switchOn,
    fundingPreference: freshFundingKind === "server" ? "server_first" : "personal_first",
  }),
  listPersonalProviderCredentials: async () => personalProviders.map((provider) => ({
    id: `synthetic-${provider}-credential`,
    provider,
  })),
}));
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: async () => capabilities,
  findActorByOwnerId: async () => ({ id: "human-actor" }),
  getRoomDetailForMember: async () => ({
    kind: "private",
    members: [
      { kind: "user", userId: HUMAN },
      { kind: "agent", agentId: AGENT, agentOwnerUserId: roomOwner },
    ],
  }),
  assertCanInvokeAgent: assertInvoke,
}));
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => ({}) }));
mock.module("../../src/lib/model-funding", () => ({
  PERSONAL_CHAT_PROVIDER_IDS: [
    "anthropic", "openai", "openrouter", "google", "xai", "fireworks", "together", "venice",
  ],
  ModelFundingError: class ModelFundingError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  resolveModelFunding: resolveFunding,
  withAdmittedPersonalProviderKey: withKey,
}));

const {
  callerHasConfiguredPersonalFunding,
  openForegroundChatFundingSession,
  isOwnPrivateGenieRoom,
} =
  await import("../../src/lib/foreground-chat-funding");

const input = {
  humanUserId: HUMAN,
  modelId: MODEL,
  roomId: ROOM,
  agentId: AGENT,
  entrypoint: "foreground.main" as const,
};

beforeEach(() => {
  switchOn = true;
  capabilities = ["use_personal_provider_credentials"];
  roomOwner = HUMAN;
  personalProviders = ["openrouter"];
  freshFundingKind = "personal";
  resolveFunding.mockClear();
  withKey.mockClear();
  assertInvoke.mockClear();
});

afterAll(() => mock.restore());

describe("foreground chat funding admission", () => {
  test("counts only runnable chat credentials as configured personal funding", async () => {
    personalProviders = ["tavily", "elevenlabs"];
    expect(await callerHasConfiguredPersonalFunding(HUMAN)).toBe(false);

    personalProviders = ["tavily", "openai"];
    expect(await callerHasConfiguredPersonalFunding(HUMAN)).toBe(true);
  });

  test("pins the original Human and credential across a different fallback model", async () => {
    const session = await openForegroundChatFundingSession(input);
    expect(session?.kind).toBe("personal");
    const result = await session!.runAttempt(FALLBACK, async (attempt) => attempt);
    expect(result).toEqual({
      usageFunding: {
        kind: "personal", humanUserId: HUMAN, payerHumanId: HUMAN,
        providerRoute: "openrouter", credentialId: "synthetic-credential",
        credentialRevision: 4,
      },
      personalCredential: { apiKey: "synthetic-personal-secret" },
    });
    expect(resolveFunding.mock.calls[1]?.[0]).toMatchObject({
      humanUserId: HUMAN, modelId: FALLBACK,
      priorDecision: { kind: "personal", modelId: MODEL, credentialRevision: 4 },
    });
    expect(withKey.mock.calls[0]?.[3]).toMatchObject({ modelId: MODEL });
    expect(assertInvoke).toHaveBeenCalledTimes(1);
  });

  test("returns server usage without decrypting personal custody when server-first wins", async () => {
    freshFundingKind = "server";
    const session = await openForegroundChatFundingSession(input);

    expect(session?.kind).toBe("server");
    expect(await session!.runAttempt(FALLBACK, async (attempt) => attempt)).toEqual({
      usageFunding: {
        kind: "server",
        humanUserId: HUMAN,
        providerRoute: "openrouter",
      },
    });
    expect(resolveFunding.mock.calls[1]?.[0]).toMatchObject({
      modelId: FALLBACK,
      priorDecision: { kind: "server", modelId: MODEL },
    });
    expect(withKey).not.toHaveBeenCalled();
  });

  test("a live session keeps its admitted payer after the saved preference changes", async () => {
    const session = await openForegroundChatFundingSession(input);
    expect(session?.kind).toBe("personal");
    freshFundingKind = "server";

    const attempt = await session!.runAttempt(FALLBACK, async (funding) => funding);
    expect(attempt.usageFunding).toMatchObject({
      kind: "personal",
      payerHumanId: HUMAN,
      credentialId: "synthetic-credential",
      credentialRevision: 4,
    });
    expect(resolveFunding.mock.calls[1]?.[0]).toMatchObject({
      priorDecision: { kind: "personal", modelId: MODEL },
    });

    const nextSession = await openForegroundChatFundingSession(input);
    expect(nextSession?.kind).toBe("server");
  });

  test("policy switch-off refuses a personal-only caller before invocation or transport", async () => {
    switchOn = false;
    expect(openForegroundChatFundingSession(input)).rejects.toMatchObject({
      code: "personal_credentials_disabled",
    });
    expect(resolveFunding).not.toHaveBeenCalled();
    expect(withKey).not.toHaveBeenCalled();
    expect(assertInvoke).not.toHaveBeenCalled();
  });

  test("personal capability revocation refuses a personal-only caller before invocation or transport", async () => {
    capabilities = [];
    expect(openForegroundChatFundingSession(input)).rejects.toMatchObject({
      code: "personal_credentials_forbidden",
    });
    expect(resolveFunding).not.toHaveBeenCalled();
    expect(withKey).not.toHaveBeenCalled();
    expect(assertInvoke).not.toHaveBeenCalled();
  });

  test("fresh server authority retains the legacy path when personal funding is disabled or revoked", async () => {
    switchOn = false;
    capabilities = ["use_personal_provider_credentials", "use_server_provider_credentials"];
    expect(await openForegroundChatFundingSession(input)).toBeNull();

    switchOn = true;
    capabilities = ["use_server_provider_credentials"];
    expect(await openForegroundChatFundingSession(input)).toBeNull();

    expect(resolveFunding).not.toHaveBeenCalled();
    expect(withKey).not.toHaveBeenCalled();
    expect(assertInvoke).not.toHaveBeenCalled();
  });

  test("a foreign Genie is rejected before any model funding", async () => {
    roomOwner = "foreign-human";
    expect(await isOwnPrivateGenieRoom(HUMAN, ROOM, AGENT)).toBe(false);
    expect(openForegroundChatFundingSession(input)).rejects.toMatchObject({
      code: "unsupported_workload",
    });
    expect(resolveFunding).not.toHaveBeenCalled();
    expect(assertInvoke).not.toHaveBeenCalled();
  });

  test("a server-funded member keeps the foreign Genie path", async () => {
    roomOwner = "foreign-human";
    capabilities = ["use_personal_provider_credentials", "use_server_provider_credentials"];
    expect(await openForegroundChatFundingSession(input)).toBeNull();
    expect(resolveFunding).not.toHaveBeenCalled();
    expect(assertInvoke).not.toHaveBeenCalled();
  });
});
