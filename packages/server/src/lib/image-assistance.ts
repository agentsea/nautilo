import {
  hydrateSurplusChatCatalog,
  resolveQualifiedSurplusChatRoute,
  resolveCatalogModel,
  type ForegroundChatFundingSession,
  type QualifiedSurplusChatRoute,
} from "@nautilo/agent";
import {
  getCachedServerModelConfigRow,
  getPersonalCapabilityPreferences,
  readImageAssistanceAdmissionWith,
  pinImageAssistanceAdmissionWith,
  claimImageAssistanceDispatchWith,
  type ImageAssistanceAdmissionIdentity,
  resolveModelAttemptReplaySafety,
} from "@nautilo/db";
import type {
  PersonalCapabilityPreferences,
  ImageAssistanceAdmission,
} from "@nautilo/types";
import { assertForegroundRoomAuthority, usageFundingFor } from "./foreground-chat-funding";
import {
  ModelFundingError, resolveModelFunding, withAdmittedPersonalCredential,
  withAdmittedPersonalProviderKey,
  type ModelFundingDecision,
} from "./model-funding";
import { imageAssistanceInputCommitment } from "./image-assistance-input-commitment";
import { getServerDirectDb } from "./server-direct-db";
import {
  isSignedImageUnderstandingModel, isImageUnderstandingPrivacyCompatible,
  isImageUnderstandingRoutingAllowed,
  mainModelRequiresDirectImageUnderstanding,
  resolveImageUnderstandingModel,
  type ImageUnderstandingPreferenceDeps,
} from "./image-model-preferences";

export interface ImageAssistanceSelectionDeps extends ImageUnderstandingPreferenceDeps {
  readonly readPreferences?: (humanUserId: string) => Promise<PersonalCapabilityPreferences>;
  /** Request-local only. Its identity includes both saved selections and revisions. */
  readonly selectionCache?: Map<string, Promise<ModelFundingDecision | null>>;
  readonly hydrateSurplusChatCatalog?: typeof hydrateSurplusChatCatalog;
  /** Pure offline seam for exact vendor-confirmed route tests. */
  readonly getQualifiedSurplusChatRoutes?: () => readonly QualifiedSurplusChatRoute[];
}

export interface ImageAssistanceExecutionDeps extends ImageAssistanceSelectionDeps {
  readonly commitInput?: typeof imageAssistanceInputCommitment;
  readonly assertRoomAuthority?: typeof assertForegroundRoomAuthority;
  readonly withCredential?: typeof withAdmittedPersonalProviderKey;
  readonly readAdmission?: (identity: ImageAssistanceAdmissionIdentity) => Promise<ImageAssistanceAdmission | null>;
  readonly pinAdmission?: (identity: ImageAssistanceAdmissionIdentity, admission: ImageAssistanceAdmission) => Promise<ImageAssistanceAdmission>;
  readonly assertReplaySafe?: (operationId: string, roomId: string) => Promise<void>;
  readonly claimDispatch?: (identity: ImageAssistanceAdmissionIdentity, admission: ImageAssistanceAdmission) => Promise<boolean>;
}

function readPreferences(humanUserId: string, deps: ImageAssistanceSelectionDeps) {
  return (deps.readPreferences ?? ((id: string) => getPersonalCapabilityPreferences(getServerDirectDb(), id)))(humanUserId);
}

/** Discovery never decrypts a credential or starts paid work. */
export async function selectCallerImageAssistance(
  input: Readonly<{ humanUserId: string; fundingKind: "server" | "personal"; mainModelId?: string }>,
  deps: ImageAssistanceSelectionDeps = {},
): Promise<ModelFundingDecision | null> {
  const preferences = await readPreferences(input.humanUserId, deps);
  const serverSelection = (deps.getServerSelection ? deps.getServerSelection() : getCachedServerModelConfigRow()?.imageUnderstandingModel)?.trim() || null;
  const resolve = async () => {
    try {
      return (await resolveImageUnderstandingModel({
        humanUserId: input.humanUserId, preferences,
        parentFundingKind: input.fundingKind,
        ...(input.mainModelId === undefined ? {} : { mainModelId: input.mainModelId }),
      }, { ...deps, getServerSelection: () => serverSelection })).funding;
    } catch (error) {
      if (!(error instanceof ModelFundingError)) throw error;
      return null;
    }
  };
  if (!deps.selectionCache) return resolve();
  const main = input.mainModelId ? (deps.resolveCatalog ?? resolveCatalogModel)(input.mainModelId, { env: {} }) : null;
  const key = JSON.stringify([input.humanUserId, input.fundingKind,
    main?.availability, main?.privacyLabel, main?.features.e2ee,
    preferences.revision, preferences.overrides.imageUnderstanding ?? null, serverSelection]);
  const existing = deps.selectionCache.get(key);
  if (existing) return existing;
  const selection = resolve();
  deps.selectionCache.set(key, selection);
  return selection;
}

/** Native modality and the caller's auxiliary image route remain distinct. */
export async function resolveCallerImageInput(
  input: Readonly<{ humanUserId: string; modelId: string; funding: ModelFundingDecision }>,
  deps: ImageAssistanceSelectionDeps = {},
): Promise<"direct" | "assisted" | "unavailable"> {
  if (isSignedImageUnderstandingModel(input.modelId, deps)) {
    const routes = deps.getQualifiedSurplusChatRoutes?.();
    if (input.funding.providerRoute === "surplus" && routes === undefined) {
      try {
        await (deps.hydrateSurplusChatCatalog ?? hydrateSurplusChatCatalog)({
          catalogModelIds: [input.modelId],
        });
      } catch {
        // The exact route lookup below remains fail-closed on the last
        // verified snapshot while direct image-capable funding still works.
      }
    }
    return input.funding.providerRoute !== "surplus"
      || resolveQualifiedSurplusChatRoute(input.modelId, routes)?.supportsVision === true ? "direct" : "unavailable";
  }
  if (input.funding.providerRoute === "openai-chatgpt") return "unavailable";
  try {
    return await selectCallerImageAssistance({ humanUserId: input.humanUserId,
      fundingKind: input.funding.kind, mainModelId: input.modelId }, deps) ? "assisted" : "unavailable";
  } catch {
    // Auxiliary readiness cannot make an otherwise admitted text model unusable.
    // Execution resolves the helper again and still fails closed before spending.
    return "unavailable";
  }
}

export async function openImageAssistance(
  input: Readonly<{
    humanUserId: string; modelId: string; roomId: string; agentId: string;
    entrypoint: "foreground.main" | "foreground.fork";
    jobId: string; turnId: string; inputDigest: string;
    fundingKind?: "server" | "personal";
  }>,
  deps: ImageAssistanceExecutionDeps = {},
): Promise<{ modelId: string; fundingSession: ForegroundChatFundingSession;
  preferenceRevision: number; operationId: string } | null> {
  const parentFundingKind = input.fundingKind ?? "server";
  const identity: ImageAssistanceAdmissionIdentity = {
    jobId: input.jobId, humanUserId: input.humanUserId, roomId: input.roomId,
    agentId: input.agentId, turnId: input.turnId, entrypoint: input.entrypoint,
    mainModelId: input.modelId, inputCommitment: (deps.commitInput ?? imageAssistanceInputCommitment)(input.jobId, input.inputDigest), parentFundingKind,
  };
  const recheckAuthority = () => (deps.assertRoomAuthority ?? assertForegroundRoomAuthority)(input);
  await recheckAuthority();
  let retained = await (deps.readAdmission ?? ((id) => readImageAssistanceAdmissionWith(getServerDirectDb(), id)))(identity);
  if (!retained) {
    const preferences = await readPreferences(input.humanUserId, deps);
    const choice = await resolveImageUnderstandingModel({ humanUserId: input.humanUserId,
      preferences, parentFundingKind, mainModelId: input.modelId }, deps);
    const funding = choice.funding.kind === "personal"
      ? { kind: "personal" as const, providerRoute: choice.funding.providerRoute,
          credentialId: choice.funding.credentialId, credentialRevision: choice.funding.credentialRevision }
      : { kind: "server" as const, providerRoute: choice.funding.providerRoute };
    retained = await (deps.pinAdmission ?? ((id, snapshot) => pinImageAssistanceAdmissionWith(getServerDirectDb(), id, snapshot)))(identity, {
      formatVersion: 1, jobId: identity.jobId, humanUserId: identity.humanUserId,
      roomId: identity.roomId, agentId: identity.agentId, turnId: identity.turnId,
      entrypoint: identity.entrypoint, mainModelId: identity.mainModelId, inputCommitment: identity.inputCommitment,
      operationId: `image-assistance:${input.jobId}`,
      modelId: choice.modelId, preferenceRevision: choice.preferenceRevision,
      serverSelection: choice.serverSelection, funding, state: "admitted",
    });
  }
  // Once dispatch began, a missing retained transcript result is ambiguous.
  // Recovery never manufactures another paid observation for that same Job.
  if (retained.state !== "admitted") throw new ModelFundingError("funding_source_changed");
  const snapshot = retained;
  const admitted: ModelFundingDecision = { ...snapshot.funding,
    humanUserId: input.humanUserId, modelId: snapshot.modelId, workload: "image_assistance",
    ...(snapshot.funding.kind === "personal" ? { payerHumanId: input.humanUserId } : {}),
  } as ModelFundingDecision;
  let ownsDispatch = false;
  let lastAttempt: ModelFundingDecision | undefined;
  const resolveAttempt = async (modelId: string, transport?: "direct" | "surplus") => {
    await recheckAuthority();
    if (modelId !== snapshot.modelId || !isSignedImageUnderstandingModel(modelId, deps)
      || !isImageUnderstandingRoutingAllowed(modelId, deps)
      || !isImageUnderstandingPrivacyCompatible(input.modelId, modelId, deps)) {
      throw new ModelFundingError("unsupported_workload");
    }
    const requestedTransport = transport ?? (admitted.providerRoute === "surplus" ? "surplus" : "direct");
    if (requestedTransport === "surplus"
      && (admitted.providerRoute !== "surplus" || mainModelRequiresDirectImageUnderstanding(input.modelId, deps))) {
      throw new ModelFundingError("funding_source_changed");
    }
    const decision = await (deps.resolveFunding ?? resolveModelFunding)({
      humanUserId: input.humanUserId, modelId, workload: "image_assistance",
      priorDecision: admitted, fundingKind: parentFundingKind,
      transport: requestedTransport,
    });
    if (lastAttempt?.kind === "personal" && decision.kind === "personal"
      && lastAttempt.providerRoute === decision.providerRoute
      && (lastAttempt.credentialId !== decision.credentialId
        || lastAttempt.credentialRevision !== decision.credentialRevision)) throw new ModelFundingError("personal_credential_stale");
    return decision;
  };
  return {
    modelId: snapshot.modelId, preferenceRevision: snapshot.preferenceRevision,
    operationId: snapshot.operationId,
    fundingSession: {
      kind: admitted.kind, workload: "image_assistance", contentPrivateDiagnostics: true,
      admission: { modelId: admitted.modelId, binding: snapshot.funding },
      async recheckAttempt(modelId, transport) { await resolveAttempt(modelId, transport); },
      async runAttempt(modelId, run, transport) {
        const decision = await resolveAttempt(modelId, transport);
        if (!ownsDispatch) {
          if (deps.assertReplaySafe) await deps.assertReplaySafe(snapshot.operationId, input.roomId);
          else if ((await resolveModelAttemptReplaySafety({ kind: "operation", callType: "image_assistance",
            roomId: input.roomId, operationId: snapshot.operationId }, { db: getServerDirectDb() })).decision !== "allow") {
            throw new ModelFundingError("funding_source_changed");
          }
          ownsDispatch = await (deps.claimDispatch ?? ((id, value) => claimImageAssistanceDispatchWith(getServerDirectDb(), id, value)))(identity, snapshot);
          if (!ownsDispatch) throw new ModelFundingError("funding_source_changed");
        }
        lastAttempt = decision;
        const usageFunding = usageFundingFor(decision);
        if (decision.kind === "server") return run({ usageFunding });
        if (deps.withCredential) {
          return deps.withCredential(decision,
            (apiKey) => run({ usageFunding, personalCredential: { apiKey } }), undefined, admitted);
        }
        return withAdmittedPersonalCredential(decision,
          (personalCredential) => run({ usageFunding, personalCredential }), undefined, admitted);
      },
    },
  };
}
