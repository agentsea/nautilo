import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const MODEL = "openrouter:moonshotai/kimi-k2.6";
const FALLBACK = "openrouter:z-ai/glm-5.2";

let switchOn = true;
let capabilities = ["use_personal_provider_credentials"];
let roomOwner = HUMAN;
const resolveFunding = mock(async (input: {
  humanUserId: string;
  modelId: string;
  priorDecision?: Record<string, unknown>;
}) => ({
  kind: "personal" as const,
  humanUserId: input.humanUserId,
  payerHumanId: input.humanUserId,
  modelId: input.modelId,
  workload: "foreground_text_chat" as const,
  providerRoute: "openrouter",
  credentialId: "synthetic-credential",
  credentialRevision: 4,
}));
const withKey = mock(async (
  _decision: Record<string, unknown>,
  run: (key: string) => Promise<unknown>,
  _deps: unknown,
  _initial: Record<string, unknown>,
) => run("synthetic-personal-secret"));
const assertInvoke = mock(async () => undefined);

mock.module("@nautilo/agent", () => ({
  resolveRetainedModels: (ids: string[]) => ids.map((id) => ({ id, availability: "missing-key" })),
}));
mock.module("@nautilo/db", () => ({
  getServerProviderPolicy: async () => ({ allowPersonalProviderKeys: switchOn }),
  listPersonalProviderCredentials: async () => [{ id: "synthetic-credential" }],
}));
mock.module("@nautilo/trust", () => ({
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
  ModelFundingError: class ModelFundingError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  resolveModelFunding: resolveFunding,
  withAdmittedPersonalProviderKey: withKey,
}));

const { openForegroundChatFundingSession, isOwnPrivateGenieRoom } =
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
  resolveFunding.mockClear();
  withKey.mockClear();
  assertInvoke.mockClear();
});

afterAll(() => mock.restore());

describe("foreground chat funding admission", () => {
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

  test("the off switch and missing capability leave the server path unchanged", async () => {
    switchOn = false;
    expect(await openForegroundChatFundingSession(input)).toBeNull();
    switchOn = true;
    capabilities = [];
    expect(await openForegroundChatFundingSession(input)).toBeNull();
    expect(resolveFunding).not.toHaveBeenCalled();
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
