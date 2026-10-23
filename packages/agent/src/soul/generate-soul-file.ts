import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { candidatesForModelRole, fromRuntimeConfig } from "@nautilo/config";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { createUniversalModel } from "../providers/universal";
import { hasStubModelForTests } from "../providers/stub-model-state";
import { modelRouteProvider } from "../providers/model-route";
import { resolveOpenRouterTransport } from "../providers/openrouter-transport";
import { resolveProviderKey } from "../resolve-provider-key";
import { runWithUsageContext } from "../usage/usage-context";
import { runPersonalLlmAttempt } from "../usage/personal-llm-attempt";
import { normalizeSoulFileInput, type SoulFileInput } from "./types";
import { resolveModelRole } from "../config/model-role-resolution";
import {
  captureModelRunnableCredentialSnapshot,
  isModelRunnableCredentialSnapshotCurrent,
  modelHasRunnableCredentials,
  type ModelRunnableCredentialSnapshot,
} from "../chat/model-runtime-credentials";
import {
  invokeSurplusChatAttempt,
  type SurplusChatAttemptResult,
} from "../providers/surplus-attempt";
import {
  canBroadenSurplusModelRoute,
  hydrateSurplusChatCatalog,
  resolveSurplusChatServingAvailability,
  SurplusDirectFallbackUnavailableError,
  type QualifiedSurplusChatRoute,
} from "../providers/surplus-route";
import { SurplusOutcomeUnknownError } from "../providers/surplus-transport";
import type { ChatModel } from "../providers/types";
import {
  resolveCompletionBudget,
  resolveSurplusCompletionBudget,
} from "../utils/chat-model-invocation";
import {
  assertCanUseServerFundedOwnSoul,
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
} from "@nautilo/trust";

/**
 * D220 — soul generation prompt. The user's personality direction is the
 * primary signal. The system message forbids the product-marketing cliches
 * that the previous prompt accidentally trained the model to emit
 * ("is not a generic chatbot", "chosen presence", etc.). Structured
 * profile signals (privacy / domain / voice) are secondary anchors.
 */
const SOUL_FILE_SYSTEM_PROMPT = [
  "You write soul files: markdown identity documents that shape how an AI assistant behaves and speaks.",
  "The user has already described how they want this assistant to feel. Your job is to give that voice real texture and depth.",
  "",
  "Rules:",
  "- The user's personality direction is the PRIMARY signal. Build every section around their words. Quote them. Riff on them.",
  '- Do NOT open with generic AI-companion framing. Do NOT use stock phrases like "is not a generic chatbot", "chosen presence", "emotionally real enough to matter", "warm but not sugary", or product-marketing sounding lead-ins. If you find yourself reaching for those, you are still being generic.',
  "- Be specific, idiosyncratic, even a little strange. A real personality has texture. A bland one does not.",
  "- Lead with who THIS assistant is, drawn from what the user said. The opening sentence must be unmistakable — swap one user's input for another's and the openings should not be interchangeable.",
  "- Structure: Essence, Core Truths, Tone, Boundaries, Vibe, How to Help, Voice, Continuity. Each section earns its presence with real substance, not headers over one-liners.",
  "- Markdown only. No meta-commentary, no preface, no closing remarks.",
].join("\n");

function describePrivacy(privacySpectrum: number | null): string {
  if (privacySpectrum === null) return "balanced and adaptive";
  if (privacySpectrum <= 33) return "private, restrained, and careful with disclosure";
  if (privacySpectrum <= 66) return "balanced, thoughtful, and selectively open";
  return "open, candid, and comfortable with visible warmth";
}

function describeDomain(workLifeMode: SoulFileInput["workLifeMode"]): string {
  switch (workLifeMode) {
    case "work":
      return "primarily a work companion: focused, sharp, helpful, and quietly ambitious";
    case "life":
      return "primarily a life companion: warm, steady, humane, and emotionally literate";
    case "both":
      return "comfortable spanning both work and life without sounding split or artificial";
    default:
      return "adaptable across work and life contexts";
  }
}

function describeVoice(voiceName: string | null): string {
  return voiceName
    ? `If spoken aloud, the intended voice is "${voiceName}" and the cadence should feel natural for that voice.`
    : "If spoken aloud, the assistant should sound natural and calm.";
}

function describeContinuity(workLifeMode: SoulFileInput["workLifeMode"]): string {
  switch (workLifeMode) {
    case "work":
      return "Treat continuity as trust earned through usefulness: remember what sharpens execution, reduces friction, and helps the user stay clear under pressure.";
    case "life":
      return "Treat continuity as emotional steadiness: remember what helps the user feel understood, less alone, and more grounded in ordinary life.";
    case "both":
      return "Treat continuity as a bridge across modes: remember what matters in work and life without sounding split or transactional.";
    default:
      return "Treat continuity as the slow accumulation of trust through useful, respectful memory.";
  }
}

/**
 * Build the Essence section. When the user provided a personality direction,
 * quote it directly so the opening line is genuinely about THIS assistant.
 * When they did not, fall back to a neutral, idiosyncratic-leaning opener
 * derived from the structured signals (NOT product-marketing copy).
 */
function buildEssence(soul: SoulFileInput): string {
  if (soul.personalityPrompt) {
    return [
      `${soul.name} is the assistant the user described in their own words:`,
      `> ${soul.personalityPrompt}`,
      `Every section of this soul file should be read as an elaboration of that direction.`,
      `${soul.name} is ${describeDomain(soul.workLifeMode)} and ${describePrivacy(soul.privacySpectrum)}.`,
    ].join("\n");
  }
  return [
    `${soul.name} is ${describeDomain(soul.workLifeMode)}.`,
    `Disposition: ${describePrivacy(soul.privacySpectrum)}.`,
    `The user did not provide a personality direction. Default to specific, grounded helpfulness — not a generic assistant persona.`,
  ].join("\n");
}

export function generateSoulFileFallback(input: Partial<SoulFileInput>): string {
  const soul = normalizeSoulFileInput(input);

  const sections = [
    `# ${soul.name} — Soul File`,
    "",
    "## Essence",
    buildEssence(soul),
    "",
    "## Core Truths",
    "- Be genuinely helpful, not performatively helpful.",
    "- Have a point of view. A little taste and discernment beats bland agreeableness.",
    "- Earn trust through competence, steadiness, and restraint.",
    "- Be resourceful before asking the user to do unnecessary work.",
    "- Remember you are a guest in someone's life, not the center of it.",
    "",
    "## Tone",
    "- Specific over generic. Present over performative.",
    "- Capable without sounding corporate or robotic.",
    "- Personal without becoming intrusive.",
    "- Thorough when it matters, brief when it does not — read the room.",
    "- When the user asks a real question, give a real answer. Do not compress everything into a tweet.",
    "",
    "## Boundaries",
    "- Never act like a sycophant.",
    "- Do not fake intimacy or certainty.",
    "- Respect privacy and avoid oversharing on the user's behalf.",
    "- Be honest when memory, context, or tools are incomplete.",
    "- Do not become the user's voice in shared or public spaces without care.",
    "",
    "## Vibe",
    `Be the assistant this specific user would actually want to talk to in ${soul.workLifeMode ?? "mixed"} mode: thoughtful, present, emotionally intelligent when it matters, and never afraid to give a full answer when the question deserves one.`,
    "",
    "## How to Help",
    "- Remember useful details that make future help better.",
    "- Prefer practical next steps over abstract commentary.",
    "- Match the user's current context: work, life, or both.",
    "- Keep momentum without becoming pushy.",
    "- Leave the user clearer, lighter, or more capable than before.",
    "",
    "## Voice",
    describeVoice(soul.voiceName),
    "",
    "## Personality Direction",
    soul.personalityPrompt
      ? `The user described how they want their assistant to be: "${soul.personalityPrompt}". This is the authoritative signal — Tone, Boundaries, and How to Help should all line up with it.`
      : "The user did not provide a personality direction. Stay specific, grounded, and adaptive; do not default to a generic assistant persona.",
    soul.motherAnswer
      ? `The user also shared this personal depth cue: "${soul.motherAnswer}". Treat it as emotionally meaningful context. Let it quietly shape how ${soul.name} shows up, without turning it into therapy or repeating it back mechanically.`
      : "",
    "",
    "## Continuity",
    describeContinuity(soul.workLifeMode),
    "If this soul changes meaningfully over time, treat that as part of the relationship rather than silent system churn.",
    "",
    "## Defaults",
    `- Default name: ${soul.name}`,
    `- Language: ${soul.language}`,
    `- Work/Life mode: ${soul.workLifeMode ?? "unspecified"}`,
    `- Privacy spectrum: ${soul.privacySpectrum ?? "unspecified"}`,
  ];

  return sections.join("\n");
}

/**
 * Human-side prompt. Personality direction is shown first and unmistakably;
 * structured profile fields follow as secondary anchors. The instruction
 * block deliberately does NOT repeat the "feel chosen, not generic"
 * framing — that lives in the system message and overlapping it here is
 * what pushed the model toward stock phrasing.
 */
function buildSoulPrompt(input: SoulFileInput): string {
  const sections: string[] = [];

  if (input.personalityPrompt) {
    sections.push(
      "Personality direction (the user's own words — this is what the assistant should actually be):",
      `"""${input.personalityPrompt}"""`,
      "",
    );
  } else {
    sections.push(
      "The user did not provide a personality direction. Use the structured signals below to infer a specific, grounded personality — do NOT default to a generic AI-assistant persona.",
      "",
    );
  }

  if (input.motherAnswer) {
    sections.push(
      `Personal depth note (use as quiet emotional texture, do not parrot back): "${input.motherAnswer}"`,
      "",
    );
  }

  sections.push(
    "Structured signals:",
    `- Name: ${input.name}`,
    `- Language: ${input.language}`,
    `- Privacy spectrum: ${input.privacySpectrum ?? "unspecified"} (0=closed, 100=open)`,
    `- Work/life mode: ${input.workLifeMode ?? "unspecified"}`,
    `- Voice (if spoken): ${input.voiceName ?? "unspecified"}`,
    "",
    "Write the markdown soul file now. Follow the rules in the system message. The opening sentence must be specific to THIS user's signals — if a different user provided different inputs, the openings must not be interchangeable. Quote or echo the user's own phrasing where it fits.",
  );

  return sections.join("\n");
}

/**
 * Stricter validity check than the legacy "> 100 chars" gate: the response
 * must look like a markdown soul file (>= 2 `##` section headings, which
 * is the real structural anchor — `# Title` is nice but some models skip
 * it). Empty / garbage / single-section responses still fall through to
 * the fallback; lean-but-real multi-section responses are accepted.
 */
function looksLikeSoulFile(content: string): boolean {
  if (content.length < 80) return false;
  const sectionMatches = content.match(/^##\s+/gm);
  return (sectionMatches?.length ?? 0) >= 2;
}

const SOUL_TIMEOUT_MS = 60_000;

/**
 * The only failure detail that crosses the generation boundary. Provider
 * errors can include credentials, endpoints, and account diagnostics, so keep
 * them out of logs and give every caller the same recoverable result.
 */
export const SOUL_GENERATION_FAILED_MESSAGE = "Unable to generate a soul file right now; using a fallback.";

export type SoulGenerationStreamEvent =
  | { readonly type: "started" }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "completed"; readonly soulFile: string }
  | { readonly type: "error"; readonly error: string; readonly fallback: string };

export interface SoulGenerationAuthorization {
  /** Exact initiating Human (`users.id`), never an Agent Actor id. */
  readonly humanUserId: string;
  /** Ordinary tools retain the general server-key guard. */
  readonly admission?: "server_capability" | "own_soul_setup_service";
  /** Required for the own-Soul setup service exception. */
  readonly agentId?: string;
  /** Test seam; production always resolves current canonical RBAC state. */
  readonly assertServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
  /** Test seam for the narrowly scoped own-Soul setup service. */
  readonly assertOwnSoulSetupService?: typeof assertCanUseServerFundedOwnSoul;
}

async function assertSoulServerFunding(
  authorization: SoulGenerationAuthorization,
): Promise<void> {
  const humanUserId = authorization.humanUserId.trim();
  if (!humanUserId) {
    throw new ServerProviderCredentialsDeniedError("", "soul_generation");
  }
  if (authorization.admission === "own_soul_setup_service") {
    await (authorization.assertOwnSoulSetupService
      ?? assertCanUseServerFundedOwnSoul)({
        humanUserId,
        agentId: authorization.agentId ?? "",
        origin: "soul_generation",
      });
    return;
  }
  await (authorization.assertServerProviderCredentials
    ?? assertCanUseServerProviderCredentials)(humanUserId, "soul_generation");
}

function soulUsageProviderRoute(modelId: string): string {
  const provider = modelRouteProvider(modelId);
  if (provider !== "openrouter") return provider;
  return resolveOpenRouterTransport()?.kind ?? provider;
}

function soulUsageContext(
  modelId: string,
  authorization: SoulGenerationAuthorization,
  providerRoute = soulUsageProviderRoute(modelId),
) {
  return {
    callType: "soul" as const,
    userId: authorization.humanUserId,
    funding: {
      kind: "service" as const,
      humanUserId: authorization.humanUserId,
      providerRoute,
    },
    ...(authorization.agentId
      ? { metadata: { agentId: authorization.agentId, service: "soul_generation" } }
      : {}),
  };
}

type SoulMessages = readonly [SystemMessage, HumanMessage];

interface ResolvedSoulInvocation {
  readonly modelId: string;
  readonly messages: SoulMessages;
  /** The selected direct provider's signed limit; marketplace discovery never changes it. */
  readonly maxOutputTokens: number;
  /** The discovered marketplace limit after output and context intersection. */
  readonly surplusMaxOutputTokens: number | null;
  readonly surplusPolicyEnabled: boolean;
  readonly surplusKey: string | null;
  readonly surplusRoute: QualifiedSurplusChatRoute | null;
  readonly broadeningAuthorityModelId?: string;
}

async function resolveSoulOutputBudgets(
  modelId: string,
  messages: SoulMessages,
  surplusRoute: QualifiedSurplusChatRoute | null,
): Promise<Pick<ResolvedSoulInvocation, "maxOutputTokens" | "surplusMaxOutputTokens">> {
  const maxOutputTokens = await resolveCompletionBudget(modelId, [...messages]);
  if (!surplusRoute) return { maxOutputTokens, surplusMaxOutputTokens: null };
  const surplusMaxOutputTokens = resolveSurplusCompletionBudget(
    surplusRoute,
    maxOutputTokens,
    [...messages],
  );
  return {
    maxOutputTokens,
    surplusMaxOutputTokens: surplusMaxOutputTokens > 0 ? surplusMaxOutputTokens : null,
  };
}

function sameSurplusRoute(
  left: QualifiedSurplusChatRoute | null,
  right: QualifiedSurplusChatRoute | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.catalogModelId === right.catalogModelId
    && left.surplusModelId === right.surplusModelId
    && left.providerPin === right.providerPin
    && left.supportsTools === right.supportsTools
    && left.supportsVision === right.supportsVision
    && left.supportsReasoning === right.supportsReasoning
    && left.supportedParameters?.join(",") === right.supportedParameters?.join(",")
    && left.maxContextTokens === right.maxContextTokens
    && left.maxOutputTokens === right.maxOutputTokens;
}

function currentSoulSurplusRoute(
  modelId: string,
  policyEnabled: boolean,
  surplusKey: string | null,
): QualifiedSurplusChatRoute | null {
  const availability = resolveSurplusChatServingAvailability({
    catalogModelId: modelId,
    policyEnabled,
    keyConfigured: surplusKey !== null,
    fundingKind: "server",
  });
  return availability.status === "available" ? availability.route : null;
}

function assertSoulInvocationSnapshotCurrent(invocation: ResolvedSoulInvocation): void {
  if (invocation.broadeningAuthorityModelId !== undefined
    && !canBroadenSurplusModelRoute(invocation.broadeningAuthorityModelId)) {
    throw new Error("Soul generation marketplace eligibility changed before dispatch.");
  }
  const policyEnabled = getCachedServerModelConfigRow()?.preferSurplus === true;
  const surplusKey = resolveProviderKey("surplus");
  const surplusRoute = currentSoulSurplusRoute(invocation.modelId, policyEnabled, surplusKey);
  if (policyEnabled !== invocation.surplusPolicyEnabled
    || surplusKey !== invocation.surplusKey
    || !sameSurplusRoute(surplusRoute, invocation.surplusRoute)) {
    throw new Error("Soul generation funding route changed before dispatch.");
  }
}

async function resolveSoulInvocation(input: SoulFileInput, signal: AbortSignal): Promise<ResolvedSoulInvocation> {
  const config = fromRuntimeConfig();
  const configuredModelId = config.nautilo_soul_generator_model ?? config.nautilo_model;
  const policyEnabled = getCachedServerModelConfigRow()?.preferSurplus === true;
  const surplusKey = resolveProviderKey("surplus");
  if (policyEnabled && surplusKey !== null) {
    await hydrateSurplusChatCatalog({ signal,
      ...(configuredModelId ? { catalogModelIds: [configuredModelId] } : {}),
    });
  }
  const modelId = resolveModelRole("systemTasks", {
    ...(configuredModelId ? { configuredId: configuredModelId } : {}),
    serverSurplus: {
      policyEnabled,
      keyConfigured: surplusKey !== null,
    },
  });
  const surplusRoute = currentSoulSurplusRoute(modelId, policyEnabled, surplusKey);
  const messages: SoulMessages = [
    new SystemMessage(SOUL_FILE_SYSTEM_PROMPT),
    new HumanMessage(buildSoulPrompt(input)),
  ];
  const budgets = await resolveSoulOutputBudgets(modelId, messages, surplusRoute);
  return {
    modelId,
    messages,
    ...budgets,
    surplusPolicyEnabled: policyEnabled,
    surplusKey,
    surplusRoute,
  };
}

async function resolveSurplusSoulCandidate(
  primary: ResolvedSoulInvocation,
  candidateId: string,
  signal: AbortSignal,
): Promise<ResolvedSoulInvocation | null> {
  try {
    await hydrateSurplusChatCatalog({ catalogModelIds: [candidateId], signal });
    const modelId = resolveModelRole("systemTasks", {
      configuredId: candidateId,
      serverSurplus: {
        policyEnabled: primary.surplusPolicyEnabled,
        keyConfigured: primary.surplusKey !== null,
      },
    });
    const surplusRoute = currentSoulSurplusRoute(
      modelId,
      primary.surplusPolicyEnabled,
      primary.surplusKey,
    );
    if (modelId !== candidateId || surplusRoute === null) return null;
    const budgets = await resolveSoulOutputBudgets(modelId, primary.messages, surplusRoute);
    return {
      modelId,
      messages: primary.messages,
      ...budgets,
      surplusPolicyEnabled: primary.surplusPolicyEnabled,
      surplusKey: primary.surplusKey,
      surplusRoute,
      broadeningAuthorityModelId: primary.modelId,
    };
  } catch {
    // A candidate that no longer satisfies the signed role, route, capability,
    // or context policy is not part of this finite marketplace walk.
    return null;
  }
}

async function runDirectSoulAttempt<T>(
  modelId: string,
  signal: AbortSignal,
  authorization: SoulGenerationAuthorization,
  invoke: () => Promise<T>,
  hasObservedProviderWork?: () => boolean,
  assertStillAuthorized?: () => void | Promise<void>,
): Promise<T> {
  const context = soulUsageContext(modelId, authorization);
  return runWithUsageContext(context, () => hasStubModelForTests()
    ? invoke()
    : runPersonalLlmAttempt({
        modelId,
        endpoint: "/v1/chat/completions",
        signal,
        ...(hasObservedProviderWork ? { hasObservedProviderWork } : {}),
        ...(assertStillAuthorized ? { assertStillAuthorized } : {}),
        invoke,
      }));
}

function captureDirectSoulCredentialSnapshot(modelId: string): ModelRunnableCredentialSnapshot | null {
  if (hasStubModelForTests()) return null;
  const snapshot = captureModelRunnableCredentialSnapshot(modelId, process.env);
  if (!snapshot) throw new SurplusDirectFallbackUnavailableError();
  return snapshot;
}

function assertDirectSoulCredentialSnapshotCurrent(
  modelId: string,
  snapshot: ModelRunnableCredentialSnapshot | null,
): void {
  if (hasStubModelForTests()) return;
  if (!snapshot || snapshot.modelId !== modelId
    || !isModelRunnableCredentialSnapshotCurrent(snapshot, process.env)) {
    throw new Error("Soul generation direct credential changed before dispatch.");
  }
}

async function assertSoulAttemptStillAuthorized(
  invocation: ResolvedSoulInvocation,
  signal: AbortSignal,
  authorization: SoulGenerationAuthorization,
  directCredentialSnapshot?: ModelRunnableCredentialSnapshot | null,
): Promise<void> {
  signal.throwIfAborted();
  await assertSoulServerFunding(authorization);
  signal.throwIfAborted();
  assertSoulInvocationSnapshotCurrent(invocation);
  if (directCredentialSnapshot !== undefined) {
    assertDirectSoulCredentialSnapshotCurrent(invocation.modelId, directCredentialSnapshot);
  }
  signal.throwIfAborted();
}

async function invokeDirectSoul(
  invocation: ResolvedSoulInvocation,
  signal: AbortSignal,
  authorization: SoulGenerationAuthorization,
): Promise<AIMessage> {
  await assertSoulServerFunding(authorization);
  assertSoulInvocationSnapshotCurrent(invocation);
  const credentialBeforeConstruction = captureDirectSoulCredentialSnapshot(invocation.modelId);
  const model = await createUniversalModel(invocation.modelId, {
    maxRetries: 0,
    maxTokens: invocation.maxOutputTokens,
  });
  assertDirectSoulCredentialSnapshotCurrent(invocation.modelId, credentialBeforeConstruction);
  const credentialSnapshot = captureDirectSoulCredentialSnapshot(invocation.modelId);
  return await runDirectSoulAttempt(
    invocation.modelId,
    signal,
    authorization,
    async () => (await model.invoke([...invocation.messages], { signal })) as AIMessage,
    undefined,
    () => assertSoulAttemptStillAuthorized(invocation, signal, authorization, credentialSnapshot),
  );
}

async function invokeSurplusSoul(
  invocation: ResolvedSoulInvocation & {
    readonly surplusKey: string;
    readonly surplusRoute: QualifiedSurplusChatRoute;
    readonly surplusMaxOutputTokens: number;
  },
  signal: AbortSignal,
  authorization: SoulGenerationAuthorization,
  hasDeliveredOutput: () => boolean,
  providerMode?: "any",
  invokeModel?: (
    model: ChatModel<BaseMessage, AIMessage>,
    messages: BaseMessage[],
    config: RunnableConfig,
  ) => Promise<AIMessage>,
): Promise<SurplusChatAttemptResult> {
  await assertSoulServerFunding(authorization);
  assertSoulInvocationSnapshotCurrent(invocation);
  const context = soulUsageContext(invocation.modelId, authorization, "surplus");
  return await runWithUsageContext(context, () => invokeSurplusChatAttempt({
    ...(providerMode === undefined ? {} : { providerMode }),
    route: invocation.surplusRoute,
    apiKey: invocation.surplusKey,
    messages: [...invocation.messages],
    tools: [],
    config: { signal },
    maxOutputTokens: invocation.surplusMaxOutputTokens,
    funding: {
      kind: "service",
      humanUserId: authorization.humanUserId,
      providerRoute: "surplus",
    },
    hasDeliveredOutput,
    assertStillAuthorized: async () => {
      await assertSoulAttemptStillAuthorized(invocation, signal, authorization);
      if (providerMode === "any" && !canBroadenSurplusModelRoute(invocation.modelId)) {
        throw new Error("Soul generation marketplace eligibility changed before dispatch.");
      }
    },
    directFallbackPolicy: "pre_service_only",
    validateResponse: (response) => {
      if (!looksLikeSoulFile(extractMessageText(response.content).trim())) {
        throw new Error("Soul generation returned incomplete markdown.");
      }
    },
    invokeModel: invokeModel
      ? (model, messages, config) => invokeModel(
          model as ChatModel<BaseMessage, AIMessage>,
          messages,
          config,
        )
      : async (model, messages, config) => (await model.invoke(messages, config)) as AIMessage,
  }));
}

function hasSurplusRoute(
  invocation: ResolvedSoulInvocation,
): invocation is ResolvedSoulInvocation & {
  readonly surplusKey: string;
  readonly surplusRoute: QualifiedSurplusChatRoute;
  readonly surplusMaxOutputTokens: number;
} {
  return invocation.surplusKey !== null
    && invocation.surplusRoute !== null
    && invocation.surplusMaxOutputTokens !== null;
}

function assertDirectSoulCredential(modelId: string): void {
  if (!modelHasRunnableCredentials(modelId, process.env)) {
    throw new SurplusDirectFallbackUnavailableError();
  }
}

interface SoulAttemptExecution {
  readonly hasDeliveredOutput: () => boolean;
  readonly hasObservedProviderWork: () => boolean;
  readonly invokeDirect: (invocation: ResolvedSoulInvocation) => Promise<AIMessage>;
  readonly invokeSurplusModel?: (
    model: ChatModel<BaseMessage, AIMessage>,
    messages: BaseMessage[],
    config: RunnableConfig,
  ) => Promise<AIMessage>;
  readonly onModelSelected?: (modelId: string) => void;
}

async function refreshRejectedSurplusSoulModel(modelId: string, signal: AbortSignal): Promise<void> {
  try {
    await hydrateSurplusChatCatalog({ catalogModelIds: [modelId], force: true, signal });
  } catch {
    // Discovery is advisory after a proven pre-service refusal. Preserve the
    // current result while allowing a later invocation to use refreshed facts.
  }
}

async function invokeDirectSoulAfterMarketplaceRefusal(
  invocation: ResolvedSoulInvocation,
  execution: SoulAttemptExecution,
  signal: AbortSignal,
): Promise<AIMessage> {
  try {
    return await execution.invokeDirect(invocation);
  } finally {
    await refreshRejectedSurplusSoulModel(invocation.modelId, signal);
  }
}

async function invokeSoulWithSupplyFallback(
  primary: ResolvedSoulInvocation,
  signal: AbortSignal,
  authorization: SoulGenerationAuthorization,
  execution: SoulAttemptExecution,
): Promise<AIMessage> {
  execution.onModelSelected?.(primary.modelId);
  if (!hasSurplusRoute(primary)) return execution.invokeDirect(primary);

  const crossModelAllowed = canBroadenSurplusModelRoute(primary.modelId);
  const candidateIds = crossModelAllowed
    ? [...new Set(candidatesForModelRole("systemTasks"))]
        .filter((candidateId) => candidateId !== primary.modelId)
    : [];
  const invocations: Array<ResolvedSoulInvocation | string> = [primary, ...candidateIds];

  for (const candidate of invocations) {
    if (typeof candidate === "string" && !canBroadenSurplusModelRoute(primary.modelId)) {
      throw new Error("Soul generation marketplace eligibility changed before dispatch.");
    }
    const invocation = typeof candidate === "string"
      ? await resolveSurplusSoulCandidate(primary, candidate, signal)
      : candidate;
    if (!invocation || !hasSurplusRoute(invocation)) continue;
    execution.onModelSelected?.(invocation.modelId);
    signal.throwIfAborted();

    // Ordinary aggregator routes can use the marketplace's available seller
    // pool immediately when there is no matching direct server credential.
    const providerMode = !modelHasRunnableCredentials(invocation.modelId, process.env)
      && canBroadenSurplusModelRoute(invocation.modelId) ? "any" : undefined;
    const first = await invokeSurplusSoul(
      invocation,
      signal,
      authorization,
      execution.hasDeliveredOutput,
      providerMode,
      execution.invokeSurplusModel,
    );
    if (first.kind === "served") return first.response;
    signal.throwIfAborted();
    if (execution.hasDeliveredOutput() || execution.hasObservedProviderWork()) {
      throw new SurplusOutcomeUnknownError();
    }

    if (!first.modelUnavailableBeforeService) {
      // Preserve the existing admitted same-model direct rail. This result
      // never authorizes the new unpinned or cross-model marketplace walk.
      assertDirectSoulCredential(invocation.modelId);
      return execution.invokeDirect(invocation);
    }

    // Preserve the established same-model direct fallback whenever its
    // server credential exists. The marketplace walk fills only the gap where
    // that direct rail is unavailable.
    if (modelHasRunnableCredentials(invocation.modelId, process.env)) {
      return invokeDirectSoulAfterMarketplaceRefusal(invocation, execution, signal);
    }
    if (!crossModelAllowed) {
      await refreshRejectedSurplusSoulModel(invocation.modelId, signal);
      throw new SurplusDirectFallbackUnavailableError();
    }

    if (providerMode !== "any" && canBroadenSurplusModelRoute(invocation.modelId)) {
      signal.throwIfAborted();
      const unpinned = await invokeSurplusSoul(
        invocation,
        signal,
        authorization,
        execution.hasDeliveredOutput,
        "any",
        execution.invokeSurplusModel,
      );
      if (unpinned.kind === "served") return unpinned.response;
      signal.throwIfAborted();
      if (execution.hasDeliveredOutput() || execution.hasObservedProviderWork()) {
        throw new SurplusOutcomeUnknownError();
      }
      if (!unpinned.modelUnavailableBeforeService) {
        assertDirectSoulCredential(invocation.modelId);
        return execution.invokeDirect(invocation);
      }
      if (modelHasRunnableCredentials(invocation.modelId, process.env)) {
        return invokeDirectSoulAfterMarketplaceRefusal(invocation, execution, signal);
      }
    }
    await refreshRejectedSurplusSoulModel(invocation.modelId, signal);
  }

  throw new SurplusDirectFallbackUnavailableError();
}

/**
 * Provider errors may include API credentials, endpoints, or account details.
 * Keep logs useful for operations without ever serializing the provider's
 * exception text.
 */
function warnSoulGenerationFailure(
  modelId: string | undefined,
  signal: AbortSignal,
  streaming: boolean,
): void {
  const outcome = signal.aborted ? "cancelled_or_timed_out" : "provider_or_transport_error";
  const mode = streaming ? "streaming " : "";
  warn(
    `[soul] ${mode}LLM soul generation failed (outcome=${outcome}, model=${modelId ?? "unset"}) — using fallback`,
  );
}

function extractMessageText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block: unknown) =>
            typeof block === "string"
              ? block
              : block && typeof block === "object" && "text" in block
                ? String((block as { text: unknown }).text)
                : "",
          )
          .join("")
      : "";
}

function createGenerationAbortContext(externalSignal?: AbortSignal): {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, SOUL_TIMEOUT_MS);

  if (externalSignal) {
    if (externalSignal.aborted) {
      abort();
    } else {
      externalSignal.addEventListener("abort", abort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    abort,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

interface SoulStreamRelayItem {
  readonly text: string;
  readonly release: () => void;
}

class SoulStreamRelay {
  private readonly queued: SoulStreamRelayItem[] = [];
  private waiter: (() => void) | undefined;
  private finished = false;

  async emit(text: string): Promise<void> {
    if (!text) return;
    await new Promise<void>((resolve) => {
      this.queued.push({ text, release: resolve });
      this.waiter?.();
      this.waiter = undefined;
    });
  }

  finish(): void {
    this.finished = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  cancel(): void {
    this.finished = true;
    for (const item of this.queued.splice(0)) item.release();
    this.waiter?.();
    this.waiter = undefined;
  }

  async next(): Promise<SoulStreamRelayItem | null> {
    for (;;) {
      const item = this.queued.shift();
      if (item) return item;
      if (this.finished) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

function asAIMessageChunk(value: unknown): AIMessageChunk {
  if (AIMessageChunk.isInstance(value)) return value;
  const chunk = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const fields = {
    content: chunk["content"] ?? "",
    ...(chunk["additional_kwargs"] && typeof chunk["additional_kwargs"] === "object"
      ? { additional_kwargs: chunk["additional_kwargs"] }
      : {}),
    ...(chunk["response_metadata"] && typeof chunk["response_metadata"] === "object"
      ? { response_metadata: chunk["response_metadata"] }
      : {}),
    ...(chunk["usage_metadata"] && typeof chunk["usage_metadata"] === "object"
      ? { usage_metadata: chunk["usage_metadata"] }
      : {}),
  };
  return new AIMessageChunk(fields as never);
}

async function consumeSoulModelStream(
  model: ChatModel<BaseMessage, unknown>,
  messages: BaseMessage[],
  config: RunnableConfig,
  relay: SoulStreamRelay,
  observeProviderWork?: () => void,
): Promise<AIMessage> {
  if (!model.stream) {
    return (await model.invoke(messages, config as Record<string, unknown>)) as AIMessage;
  }
  const stream = await model.stream(messages, config as Record<string, unknown>);
  let aggregate: AIMessageChunk | undefined;
  for await (const rawChunk of stream) {
    observeProviderWork?.();
    const chunk = asAIMessageChunk(rawChunk);
    aggregate = aggregate ? aggregate.concat(chunk) : chunk;
    await relay.emit(extractMessageText(chunk.content));
  }
  return aggregate ?? new AIMessage({ content: "" });
}

async function* relaySoulAttempt<T>(
  start: (relay: SoulStreamRelay) => Promise<T>,
): AsyncGenerator<string, T> {
  const relay = new SoulStreamRelay();
  const attempt = start(relay);
  void attempt.then(
    () => relay.finish(),
    () => relay.finish(),
  );
  try {
    for (;;) {
      const item = await relay.next();
      if (!item) break;
      item.release();
      yield item.text;
    }
    return await attempt;
  } finally {
    relay.cancel();
  }
}

async function invokeDirectSoulStream(
  invocation: ResolvedSoulInvocation,
  signal: AbortSignal,
  authorization: SoulGenerationAuthorization,
  relay: SoulStreamRelay,
  fallback: string,
  observeAttemptProviderWork: () => void,
): Promise<AIMessage> {
  await assertSoulServerFunding(authorization);
  assertSoulInvocationSnapshotCurrent(invocation);
  const credentialBeforeConstruction = captureDirectSoulCredentialSnapshot(invocation.modelId);
  const model = await createUniversalModel(invocation.modelId, {
    maxRetries: 0,
    maxTokens: invocation.maxOutputTokens,
  });
  assertDirectSoulCredentialSnapshotCurrent(invocation.modelId, credentialBeforeConstruction);
  const credentialSnapshot = captureDirectSoulCredentialSnapshot(invocation.modelId);
  let providerWorkObserved = false;
  if (!model.stream) {
    try {
      const response = await runDirectSoulAttempt(
        invocation.modelId,
        signal,
        authorization,
        async () => (await model.invoke([...invocation.messages], { signal })) as AIMessage,
        undefined,
        () => assertSoulAttemptStillAuthorized(invocation, signal, authorization, credentialSnapshot),
      );
      const content = extractMessageText(response.content).trim();
      if (looksLikeSoulFile(content)) return response;
      warn(
        `[soul] LLM returned short/non-markdown content (${content.length} chars) for model ${invocation.modelId} — using fallback`,
      );
      return new AIMessage({ content: fallback });
    } catch (error) {
      if (error instanceof ServerProviderCredentialsDeniedError) throw error;
      warnSoulGenerationFailure(invocation.modelId, signal, false);
      return new AIMessage({ content: fallback });
    }
  }
  return await runDirectSoulAttempt(
    invocation.modelId,
    signal,
    authorization,
    () => consumeSoulModelStream(
      model as ChatModel<BaseMessage, unknown>,
      [...invocation.messages],
      { signal },
      relay,
      () => {
        providerWorkObserved = true;
        observeAttemptProviderWork();
      },
    ),
    () => providerWorkObserved,
    () => assertSoulAttemptStillAuthorized(invocation, signal, authorization, credentialSnapshot),
  );
}

export async function generateSoulFile(
  input: Partial<SoulFileInput>,
  externalSignal: AbortSignal | undefined,
  authorization: SoulGenerationAuthorization,
): Promise<string> {
  const normalized = normalizeSoulFileInput(input);
  const fallback = generateSoulFileFallback(normalized);
  const abortContext = createGenerationAbortContext(externalSignal);
  let modelId: string | undefined;

  try {
    const invocation = await resolveSoulInvocation(normalized, abortContext.signal);
    modelId = invocation.modelId;
    const response = await invokeSoulWithSupplyFallback(
      invocation,
      abortContext.signal,
      authorization,
      {
        hasDeliveredOutput: () => false,
        hasObservedProviderWork: () => false,
        invokeDirect: (selected) => invokeDirectSoul(
          selected,
          abortContext.signal,
          authorization,
        ),
        onModelSelected: (selectedModelId) => {
          modelId = selectedModelId;
        },
      },
    );

    const content = extractMessageText(response.content).trim();

    if (looksLikeSoulFile(content)) {
      return content;
    }

    warn(
      `[soul] LLM returned short/non-markdown content (${content.length} chars) for model ${modelId ?? "unset"} — using fallback`,
    );
    return fallback;
  } catch (error) {
    if (error instanceof ServerProviderCredentialsDeniedError) throw error;
    warnSoulGenerationFailure(modelId, abortContext.signal, false);
    return fallback;
  } finally {
    abortContext.dispose();
  }
}

export async function* generateSoulFileStream(
  input: Partial<SoulFileInput>,
  externalSignal: AbortSignal | undefined,
  authorization: SoulGenerationAuthorization,
): AsyncGenerator<SoulGenerationStreamEvent> {
  const normalized = normalizeSoulFileInput(input);
  const fallback = generateSoulFileFallback(normalized);
  const abortContext = createGenerationAbortContext(externalSignal);
  let modelId: string | undefined;
  let activeAttempt: AsyncGenerator<string, unknown> | undefined;
  yield { type: "started" };

  try {
    const invocation = await resolveSoulInvocation(normalized, abortContext.signal);
    modelId = invocation.modelId;
    let content = "";
    let deliveredOutput = false;
    let providerWorkObserved = false;

    const streamAttempt = relaySoulAttempt((relay) => invokeSoulWithSupplyFallback(
      invocation,
      abortContext.signal,
      authorization,
      {
        hasDeliveredOutput: () => deliveredOutput,
        hasObservedProviderWork: () => providerWorkObserved,
        invokeDirect: (selected) => invokeDirectSoulStream(
          selected,
          abortContext.signal,
          authorization,
          relay,
          fallback,
          () => {
            providerWorkObserved = true;
          },
        ),
        invokeSurplusModel: (model, messages, config) =>
          consumeSoulModelStream(model, messages, config, relay, () => {
            providerWorkObserved = true;
          }),
        onModelSelected: (selectedModelId) => {
          modelId = selectedModelId;
        },
      },
    ));
    activeAttempt = streamAttempt;

    let response: AIMessage;
    for (;;) {
      const next = await streamAttempt.next();
      if (next.done) {
        response = next.value;
        activeAttempt = undefined;
        break;
      }
      deliveredOutput = true;
      content += next.value;
      yield { type: "delta", text: next.value };
    }

    if (!content) content = extractMessageText(response.content);

    const soulFile = content.trim();
    if (looksLikeSoulFile(soulFile)) {
      yield { type: "completed", soulFile };
      return;
    }

    warn(
      `[soul] streaming LLM returned short/non-markdown content (${soulFile.length} chars) for model ${modelId ?? "unset"} — using fallback`,
    );
    yield {
      type: "error",
      error: "Soul generation returned incomplete markdown; using fallback.",
      fallback,
    };
  } catch (error) {
    if (error instanceof ServerProviderCredentialsDeniedError) throw error;
    warnSoulGenerationFailure(modelId, abortContext.signal, true);
    yield { type: "error", error: SOUL_GENERATION_FAILED_MESSAGE, fallback };
  } finally {
    abortContext.abort();
    await activeAttempt?.return(undefined);
    abortContext.dispose();
  }
}
