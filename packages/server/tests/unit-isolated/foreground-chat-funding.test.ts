import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentInvocationAdmissionInput } from "@nautilo/trust";

const actualAgent = await import("@nautilo/agent");
const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const MODEL = "openrouter:moonshotai/kimi-k2.6";
const FALLBACK = "openrouter:z-ai/glm-5.2";
const CHINA_ROUTED_MODEL = "venice:z-ai-glm-5-3";

let switchOn = true;
let capabilities = ["use_personal_provider_credentials"];
let roomOwner = HUMAN;
let roomMemberHuman = HUMAN;
let invocationAllowed = true;
let foreignInvocationAllowed = false;
let roomLive = true;
let freshFundingKind: "personal" | "server" = "personal";
const resolveFunding = mock(async (input: {
  humanUserId: string;
  modelId: string;
  priorDecision?: { kind?: unknown };
  fundingKind?: "personal" | "server";
}) => {
  if (input.priorDecision?.kind === "personal"
    && !capabilities.includes("use_personal_provider_credentials")) {
    throw Object.assign(new Error("personal_credentials_forbidden"), {
      code: "personal_credentials_forbidden",
    });
  }
  const kind = input.fundingKind ?? (input.priorDecision?.kind === "server" || input.priorDecision?.kind === "personal"
    ? input.priorDecision.kind
    : freshFundingKind);
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
const assertInvoke = mock(async (input: AgentInvocationAdmissionInput) => {
  if (!invocationAllowed || (input.agentId && roomOwner !== HUMAN && !foreignInvocationAllowed)) {
    throw new actualTrust.AgentInvocationDeniedError(input);
  }
});

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  resolveRetainedModels: actualAgent.resolveRetainedModels,
  getEligibleModels: () => [MODEL, FALLBACK].map((id) => ({ id, availability: "missing-key" })),
  modelHasRunnableCredentials: (modelId: string, env: NodeJS.ProcessEnv) =>
    modelId.startsWith("openrouter:") && Boolean(env["OPENROUTER_API_KEY"]),
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getServerProviderPolicy: async () => ({
    allowPersonalProviderKeys: switchOn,
    fundingPreference: freshFundingKind === "server" ? "server_first" : "personal_first",
  }),
  listPersonalProviderCredentials: async () => [{
    id: "synthetic-openrouter-credential",
    provider: "openrouter",
  }],
}));
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: async () => capabilities,
  findActorByOwnerId: async () => ({ id: "human-actor" }),
  getRoomDetailForMember: async () => ({
    kind: "private",
    members: [
      { kind: "user", userId: roomMemberHuman },
      { kind: "agent", agentId: AGENT, agentOwnerUserId: roomOwner },
    ],
  }),
  assertCanInvokeAgent: assertInvoke,
}));
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => roomLive ? [{ id: ROOM }] : [] }) }) }),
  }),
}));
mock.module("../../src/lib/model-funding", () => ({
  PERSONAL_CHAT_PROVIDER_IDS: [
    "anthropic", "openai", "openrouter", "google", "xai", "fireworks", "together", "venice",
  ],
  ModelFundingError: class ModelFundingError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  resolveModelFunding: resolveFunding,
  readModelFundingPolicy: async () => ({
    allowPersonalProviderKeys: switchOn,
    fundingPreference: freshFundingKind === "server" ? "server_first" : "personal_first",
  }),
  createModelFundingSnapshot: async () => ({ deps: {} }),
  resolveServerFundingRoute: (modelId: string) => actualAgent.modelHasRunnableCredentials(modelId, process.env)
    ? modelId.split(":", 1)[0] : null,
  withAdmittedPersonalCredential: (decision: Record<string, unknown>, run: (credential: { apiKey: string }) => Promise<unknown>, deps: unknown, initial: Record<string, unknown>) => withKey(decision, key => run({ apiKey: key }), deps, initial),
  withAdmittedPersonalProviderKey: withKey,
}));

mock.module("../../src/lib/caller-task-model-context", () => ({
  callerTaskModelIds: async () => [MODEL, FALLBACK],
  personalOnlyTaskModelIds: async (_human: string, ids: string[]) => ids.filter(id => !actualAgent.modelHasRunnableCredentials(id, process.env)),
}));

mock.module("../../src/lib/capability-funding", () => ({
  capabilityFundingBinding: (decision: Record<string, unknown>) => ({
    kind: decision["kind"], providerRoute: decision["providerRoute"],
    ...(decision["kind"] === "personal" ? { credentialId: decision["credentialId"], credentialRevision: decision["credentialRevision"] } : {}),
  }),
  prepareCapabilityFundingSession: async (humanUserId: string) => ({ humanUserId }),
}));

const {
  openForegroundConductorFundingSession,
  openForegroundChatFundingSession,
  isOwnPrivateGenieRoom,
} =
  await import("../../src/lib/foreground-chat-funding");
const { resolveCallerImageInput } = await import("../../src/lib/image-assistance");

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
  roomMemberHuman = HUMAN;
  invocationAllowed = true;
  foreignInvocationAllowed = false;
  roomLive = true;
  freshFundingKind = "personal";
  resolveFunding.mockClear();
  withKey.mockClear();
  assertInvoke.mockClear();
});

afterAll(() => mock.restore());

describe("foreground chat funding admission", () => {
  test("archiving the source Room denies admission and stops an admitted personal retry before key access", async () => {
    const session = await openForegroundChatFundingSession(input);
    if (!session) throw new Error("Expected personal funding session");
    roomLive = false;
    for (const run of [
      () => session.runAttempt(MODEL, async () => "must not run"),
      () => openForegroundChatFundingSession(input),
    ]) {
      let denial: unknown;
      try { await run(); } catch (error) { denial = error; }
      expect(denial).toMatchObject({ code: "unsupported_workload" });
    }
    expect(withKey).not.toHaveBeenCalled();
  });
  test("a missing key never admits a signed image model as personal text chat", async () => {
    expect(openForegroundChatFundingSession({ ...input, modelId: "openai:gpt-image-2" }))
      .rejects.toMatchObject({ code: "unsupported_workload" });
    expect(resolveFunding).not.toHaveBeenCalled();
  });
  test("subscription funding keeps native vision but cannot borrow a separately funded helper", async () => {
    const modelId = "openai:gpt-5.6-luna";
    const catalog = actualAgent.resolveCatalogModel(modelId, { env: {} });
    const funding = {
      kind: "personal" as const,
      humanUserId: HUMAN,
      payerHumanId: HUMAN,
      modelId,
      workload: "foreground_text_chat" as const,
      providerRoute: "openai-chatgpt",
      credentialId: "synthetic-subscription",
      credentialRevision: 3,
    };

    expect(await resolveCallerImageInput({ humanUserId: HUMAN, modelId, funding })).toBe("direct");
    expect(await resolveCallerImageInput({ humanUserId: HUMAN, modelId, funding }, {
      resolveCatalog: () => ({ ...catalog, input: ["text"] }),
      readPreferences: async () => {
        throw new Error("subscription helper exclusion must precede preference projection");
      },
    })).toBe("unavailable");
  });
  test("enforces current operator consent for a signed China-routed foreground model", async () => {
    const previous = process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
    try {
      delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
      expect(await openForegroundChatFundingSession({ ...input, modelId: CHINA_ROUTED_MODEL })
        .then(() => null, (error: unknown) => error)).toMatchObject({ code: "unsupported_provider" });
      expect(resolveFunding).not.toHaveBeenCalled();

      process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
      const session = await openForegroundChatFundingSession({ ...input, modelId: CHINA_ROUTED_MODEL });
      expect(session?.kind).toBe("personal");
      expect(resolveFunding).toHaveBeenCalledTimes(1);

      delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
      expect(await session!.runAttempt(CHINA_ROUTED_MODEL, async () => "must not run")
        .then(() => null, (error: unknown) => error)).toMatchObject({ code: "unsupported_provider" });
      expect(resolveFunding).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
      else process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = previous;
    }
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
    expect(assertInvoke).toHaveBeenCalledTimes(2);
  });

  test("returns server usage without decrypting personal custody when server-first wins", async () => {
    freshFundingKind = "server";
    const session = await openForegroundChatFundingSession(input);

    expect(session?.kind).toBe("server");
    expect(session?.allowUnpinnedSurplusRetry).toBe(true);
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

  test("server-first direct sessions expose exact-model personal recovery without child authority", async () => {
    freshFundingKind = "server";
    capabilities = ["use_server_provider_credentials", "use_personal_provider_credentials"];
    const session = await openForegroundChatFundingSession(input);
    expect(session?.openPersonalRecovery).toBeFunction();

    const recovery = await session!.openPersonalRecovery!(MODEL);
    expect(recovery).toMatchObject({ kind: "personal" });
    expect(recovery.allowUnpinnedSurplusRetry).toBe(true);
    expect(recovery.admission).toBeUndefined();
    expect(recovery.capabilityFunding).toBeUndefined();
    expect(recovery.openPersonalRecovery).toBeUndefined();
    expect(await recovery.runAttempt(MODEL, async (attempt) => attempt)).toMatchObject({
      usageFunding: { kind: "personal", humanUserId: HUMAN, payerHumanId: HUMAN },
      personalCredential: { apiKey: "synthetic-personal-secret" },
    });
    expect(recovery.recheckAttempt(FALLBACK)).rejects.toMatchObject({
      code: "funding_source_changed",
    });
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
    expect(assertInvoke).toHaveBeenCalledTimes(1);
  });

  test("personal capability revocation refuses a personal-only caller before invocation or transport", async () => {
    capabilities = [];
    expect(openForegroundChatFundingSession(input)).rejects.toMatchObject({
      code: "personal_credentials_forbidden",
    });
    expect(resolveFunding).not.toHaveBeenCalled();
    expect(withKey).not.toHaveBeenCalled();
    expect(assertInvoke).toHaveBeenCalledTimes(1);
  });

  test("fresh server authority receives child funding admission even when personal funding is disabled or revoked", async () => {
    switchOn = false;
    freshFundingKind = "server";
    capabilities = ["use_personal_provider_credentials", "use_server_provider_credentials"];
    expect((await openForegroundChatFundingSession(input))?.kind).toBe("server");
    switchOn = true;
    capabilities = ["use_server_provider_credentials"];
    expect((await openForegroundChatFundingSession(input))?.kind).toBe("server");
    expect(withKey).not.toHaveBeenCalled();
  });

  test("room authority revocation stops a later attempt before key custody or provider dispatch", async () => {
    const session = await openForegroundChatFundingSession(input);
    invocationAllowed = false;
    const dispatch = mock(async () => "unexpected");
    expect(session!.runAttempt(MODEL, dispatch)).rejects.toMatchObject({ code: "unsupported_workload" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(withKey).not.toHaveBeenCalled();
    expect(resolveFunding).toHaveBeenCalledTimes(1);
  });

  test("saved personal funding cannot become server spending after switch-off", async () => {
    const session = await openForegroundChatFundingSession(input);
    switchOn = false;
    capabilities = ["use_personal_provider_credentials", "use_server_provider_credentials"];
    expect(openForegroundChatFundingSession({ ...input, prior: session!.admission! }))
      .rejects.toMatchObject({ code: "personal_credentials_disabled" });
  });

  test("a foreign Genie is rejected before any model funding", async () => {
    roomOwner = "foreign-human";
    expect(await isOwnPrivateGenieRoom(HUMAN, ROOM, AGENT)).toBe(false);
    expect(openForegroundChatFundingSession(input)).rejects.toMatchObject({
      code: "unsupported_workload",
    });
    expect(resolveFunding).not.toHaveBeenCalled();
    expect(assertInvoke).toHaveBeenCalledTimes(1);
  });

  test("an authorized member can personally fund another Human's Genie", async () => {
    roomOwner = "foreign-human";
    foreignInvocationAllowed = true;
    const session = await openForegroundChatFundingSession(input);
    expect(session?.kind).toBe("personal");
    expect(resolveFunding).toHaveBeenCalledTimes(1);
    expect(assertInvoke).toHaveBeenCalledTimes(1);
  });

  test("external Room funding requires and rechecks the exact sponsorship authority", async () => {
    let sponsorshipLive = true;
    const assertExternalRoomSponsorship = mock(async () => {
      if (!sponsorshipLive) throw new Error("external_room_sponsorship_withdrawn");
    });
    const externalInput = {
      ...input,
      entrypoint: "foreground.external_room" as const,
      assertExternalRoomSponsorship,
    };

    const session = await openForegroundChatFundingSession(externalInput);
    expect(session?.kind).toBe("personal");
    expect(session?.contentPrivateDiagnostics).toBe(true);
    expect(assertExternalRoomSponsorship).toHaveBeenCalledTimes(1);

    roomMemberHuman = "foreign-human";
    const authorityDispatch = mock(async () => "unexpected");
    expect(session!.runAttempt(MODEL, authorityDispatch)).rejects.toMatchObject({
      code: "unsupported_workload",
    });
    expect(authorityDispatch).not.toHaveBeenCalled();

    roomMemberHuman = HUMAN;
    sponsorshipLive = false;
    const dispatch = mock(async () => "unexpected");
    expect(session!.runAttempt(MODEL, dispatch)).rejects.toThrow(
      "external_room_sponsorship_withdrawn",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(withKey).not.toHaveBeenCalled();
    expect(resolveFunding).toHaveBeenCalledTimes(1);
    expect(assertExternalRoomSponsorship).toHaveBeenCalledTimes(3);
  });

  test("external Room funding rejects a missing sponsorship authority before model funding", async () => {
    expect(openForegroundChatFundingSession({
      ...input,
      entrypoint: "foreground.external_room",
    })).rejects.toMatchObject({ code: "unsupported_workload" });
    expect(resolveFunding).not.toHaveBeenCalled();
    expect(assertInvoke).not.toHaveBeenCalled();
  });

  test("a foreign Room member cannot borrow a payer identity", async () => {
    roomMemberHuman = "foreign-human";
    expect(openForegroundChatFundingSession(input)).rejects.toMatchObject({
      code: "unsupported_workload",
    });
    expect(resolveFunding).not.toHaveBeenCalled();
    expect(assertInvoke).not.toHaveBeenCalled();
  });

  test("a group Conductor pins the initiating Human's personal funding", async () => {
    const session = await openForegroundConductorFundingSession({
      humanUserId: HUMAN,
      modelId: MODEL,
      roomId: ROOM,
      authority: actualTrust.createAcceptedInvocationAuthority(HUMAN),
    });
    expect(session.kind).toBe("personal");
    expect(await session.runAttempt(MODEL, async (attempt) => attempt)).toMatchObject({
      usageFunding: { kind: "personal", humanUserId: HUMAN, payerHumanId: HUMAN },
      personalCredential: { apiKey: "synthetic-personal-secret" },
    });
    expect(assertInvoke.mock.calls.every(([call]) => call.agentId === undefined)).toBe(true);
  });

  test("protected Conductor routing retains server funding", async () => {
    capabilities = ["use_personal_provider_credentials", "use_server_provider_credentials"];
    const session = await openForegroundConductorFundingSession({
      humanUserId: HUMAN,
      modelId: MODEL,
      roomId: ROOM,
      authority: actualTrust.createAcceptedInvocationAuthority(HUMAN),
      protectedTurn: true,
    });
    expect(session.kind).toBe("server");
    expect(session.allowUnpinnedSurplusRetry).toBeUndefined();
    expect(session.openPersonalRecovery).toBeUndefined();
    expect(resolveFunding.mock.calls[0]?.[0]).toMatchObject({ fundingKind: "server" });
    expect(withKey).not.toHaveBeenCalled();
  });

  test("protected foreground funding omits marketplace broadening", async () => {
    freshFundingKind = "server";
    capabilities = ["use_server_provider_credentials"];
    const session = await openForegroundChatFundingSession({ ...input, protectedTurn: true });
    expect(session?.kind).toBe("server");
    expect(session?.allowUnpinnedSurplusRetry).toBeUndefined();
  });

  test("Conductor capability revocation stops a later provider attempt", async () => {
    const session = await openForegroundConductorFundingSession({
      humanUserId: HUMAN,
      modelId: MODEL,
      roomId: ROOM,
      authority: actualTrust.createAcceptedInvocationAuthority(HUMAN),
    });
    capabilities = [];
    const dispatch = mock(async () => "unexpected");

    expect(session.runAttempt(MODEL, dispatch)).rejects.toMatchObject({
      code: "personal_credentials_forbidden",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(withKey).not.toHaveBeenCalled();
  });

  test("Conductor rejects an opaque authority minted for another Human", async () => {
    expect(openForegroundConductorFundingSession({
      humanUserId: HUMAN,
      modelId: MODEL,
      roomId: ROOM,
      authority: actualTrust.createAcceptedInvocationAuthority("foreign-human"),
    })).rejects.toThrow("Accepted invocation authority subject mismatch");
    expect(resolveFunding).not.toHaveBeenCalled();
  });
});
