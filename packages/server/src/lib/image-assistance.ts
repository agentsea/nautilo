import {
  getEligibleModels,
  resolveCatalogModel,
  resolveModelPrice,
  resolveQualifiedSurplusChatRoute,
  type ForegroundChatFundingSession,
} from "@nautilo/agent";
import { assertCanInvokeAgent } from "@nautilo/trust";
import { isOwnPrivateGenieRoom, usageFundingFor } from "./foreground-chat-funding";
import {
  ModelFundingError,
  resolveModelFunding,
  withAdmittedPersonalProviderKey,
  type ModelFundingDecision,
} from "./model-funding";

export interface ImageAssistanceSelectionDeps {
  readonly listModels?: typeof getEligibleModels;
  readonly resolveCatalog?: typeof resolveCatalogModel;
  readonly resolvePrice?: typeof resolveModelPrice;
  readonly resolveFunding?: typeof resolveModelFunding;
  /** Owned by a single caller catalog response, never shared across requests. */
  readonly selectionCache?: Map<string, Promise<ModelFundingDecision | null>>;
}

export interface ImageAssistanceExecutionDeps extends ImageAssistanceSelectionDeps {
  readonly privateRoom?: typeof isOwnPrivateGenieRoom;
  readonly assertInvocation?: typeof assertCanInvokeAgent;
  readonly withCredential?: typeof withAdmittedPersonalProviderKey;
}

function signedImageModel(modelId: string, deps: ImageAssistanceSelectionDeps): boolean {
  const model = (deps.resolveCatalog ?? resolveCatalogModel)(modelId, { env: {} });
  return (model.availability === "selectable" || model.availability === "missing_credentials")
    && model.workload === "chat" && model.input.includes("image") && model.output.includes("text");
}

function privacyCompatible(mainModelId: string | undefined, modelId: string, deps: ImageAssistanceSelectionDeps): boolean {
  if (mainModelId === undefined) return true;
  const resolve = deps.resolveCatalog ?? resolveCatalogModel;
  const main = resolve(mainModelId, { env: {} });
  // An unsupported/local provider cannot silently acquire a remote helper.
  if (main.availability !== "selectable" && main.availability !== "missing_credentials") return false;
  const candidate = resolve(modelId, { env: {} });
  if (main.features.e2ee === true || main.privacyLabel === "e2ee") {
    return candidate.features.e2ee === true || candidate.privacyLabel === "e2ee";
  }
  if (main.privacyLabel === "anonymized") {
    return candidate.privacyLabel === "anonymized" || candidate.privacyLabel === "e2ee"
      || candidate.features.e2ee === true;
  }
  return true;
}

/** Catalog discovery and funding observation only: no credential decryption or spend. */
export async function selectCallerImageAssistance(
  input: Readonly<{ humanUserId: string; fundingKind: "server" | "personal"; mainModelId?: string }>,
  deps: ImageAssistanceSelectionDeps = {},
): Promise<ModelFundingDecision | null> {
  if (deps.selectionCache) {
    const main = input.mainModelId === undefined ? null
      : (deps.resolveCatalog ?? resolveCatalogModel)(input.mainModelId, { env: {} });
    const privacy = main?.features.e2ee === true || main?.privacyLabel === "e2ee" ? "e2ee"
      : main?.privacyLabel === "anonymized" ? "anonymized" : "standard";
    const key = JSON.stringify([input.humanUserId, input.fundingKind, privacy, main?.availability ?? null]);
    const existing = deps.selectionCache.get(key);
    if (existing) return existing;
    const { selectionCache: _selectionCache, ...uncached } = deps;
    const selection = selectCallerImageAssistance(input, uncached);
    deps.selectionCache.set(key, selection);
    return selection;
  }
  const models = (deps.listModels ?? getEligibleModels)({
    purpose: "vision", includeUnavailable: true, env: {},
  });
  const candidates = models.filter((model) => signedImageModel(model.id, deps)
    && privacyCompatible(input.mainModelId, model.id, deps))
    .map((model) => {
    const resolved = (deps.resolvePrice ?? resolveModelPrice)(model.id);
    const cost = resolved.price.inputPerMtok + resolved.price.outputPerMtok;
    return { model, cost: Number.isFinite(cost) && cost >= 0 ? cost : Number.POSITIVE_INFINITY };
  }).sort((a, b) => a.cost - b.cost || a.model.id.localeCompare(b.model.id));
  for (const { model } of candidates) {
    try {
      return await (deps.resolveFunding ?? resolveModelFunding)({
        humanUserId: input.humanUserId, modelId: model.id,
        workload: "image_assistance", transport: "direct", fundingKind: input.fundingKind,
      });
    } catch (error) {
      if (!(error instanceof ModelFundingError)) throw error;
    }
  }
  return null;
}

/** The public capability stays native; this field describes the usable image route. */
export async function resolveCallerImageInput(
  input: Readonly<{ humanUserId: string; modelId: string; funding: ModelFundingDecision }>,
  deps: ImageAssistanceSelectionDeps = {},
): Promise<"direct" | "assisted" | "unavailable"> {
  if (signedImageModel(input.modelId, deps)) {
    if (input.funding.providerRoute !== "surplus"
      || resolveQualifiedSurplusChatRoute(input.modelId)?.supportsVision === true) return "direct";
    // Native vision execution already owns its transport qualification. The
    // helper runs only for text-only main models, so do not advertise a route
    // that the executor would skip.
    return "unavailable";
  }
  return await selectCallerImageAssistance({
    humanUserId: input.humanUserId, fundingKind: input.funding.kind, mainModelId: input.modelId,
  }, deps) ? "assisted" : "unavailable";
}

export async function openImageAssistance(
  input: Readonly<{
    humanUserId: string; modelId: string; roomId: string; agentId: string;
    entrypoint: "foreground.main" | "foreground.fork";
    fundingKind?: "server" | "personal";
  }>,
  deps: ImageAssistanceExecutionDeps = {},
): Promise<{ modelId: string; fundingSession: ForegroundChatFundingSession } | null> {
  const fundingKind = input.fundingKind ?? "server";
  const recheckAuthority = async () => {
    if (fundingKind === "personal"
      && !(await (deps.privateRoom ?? isOwnPrivateGenieRoom)(input.humanUserId, input.roomId, input.agentId))) {
      throw new ModelFundingError("unsupported_workload");
    }
    await (deps.assertInvocation ?? assertCanInvokeAgent)({
      humanUserId: input.humanUserId, origin: "room_message",
      ...(input.roomId ? { roomId: input.roomId } : {}), agentId: input.agentId,
    });
  };
  await recheckAuthority();
  const admitted = await selectCallerImageAssistance({
    humanUserId: input.humanUserId, fundingKind, mainModelId: input.modelId,
  }, deps);
  if (!admitted) return null;
  const resolveAttempt = async (modelId: string, transport?: "direct" | "surplus") => {
    await recheckAuthority();
    if (modelId !== admitted.modelId || transport === "surplus" || !signedImageModel(modelId, deps)
      || !privacyCompatible(input.modelId, modelId, deps)) {
      throw new ModelFundingError("unsupported_workload");
    }
    return (deps.resolveFunding ?? resolveModelFunding)({
      humanUserId: input.humanUserId, modelId,
      workload: "image_assistance", priorDecision: admitted, transport: "direct", fundingKind,
    });
  };
  return {
    modelId: admitted.modelId,
    fundingSession: {
      kind: admitted.kind,
      async recheckAttempt(modelId, transport) { await resolveAttempt(modelId, transport); },
      async runAttempt(modelId, run, transport) {
        const decision = await resolveAttempt(modelId, transport);
        const usageFunding = usageFundingFor(decision);
        if (decision.kind === "server") return run({ usageFunding });
        return (deps.withCredential ?? withAdmittedPersonalProviderKey)(decision,
          (apiKey) => run({ usageFunding, personalCredential: { apiKey } }), undefined, admitted);
      },
    },
  };
}
