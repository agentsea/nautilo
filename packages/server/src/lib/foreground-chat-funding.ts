import { prepareCapabilityFundingSession, capabilityFundingBinding } from "./capability-funding";
import { resolveRetainedModels, resolveCatalogModel, type ForegroundChatFundingSession, type ForegroundFundingSnapshot } from "@nautilo/agent";
import { and, eq, isNull, rooms, getServerProviderPolicy } from "@nautilo/db";
import {
  AgentInvocationDeniedError,
  assertAcceptedInvocationAuthoritySubject,
  assertCanInvokeAgent,
  findActorByOwnerId,
  getRoomDetailForMember,
  getUserCapabilities,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import {
  ModelFundingError,
  resolveModelFunding,
  withAdmittedPersonalCredential,
  type ModelFundingDecision,
} from "./model-funding";
import { getServerDirectDb } from "./server-direct-db";
import { callerTaskModelIds, personalOnlyTaskModelIds } from "./caller-task-model-context";
import {
  openServerFirstPersonalRecovery,
  openSurplusPersonalDirectRecovery,
} from "./surplus-personal-recovery";

type FundingPortInput = Readonly<{
  humanUserId: string;
  modelId: string;
  roomId: string;
  agentId: string;
  entrypoint: "foreground.main" | "foreground.fork" | "foreground.external_room";
  assertExternalRoomSponsorship?: () => Promise<void>;
  protectedTurn?: boolean;
  prior?: ForegroundFundingSnapshot;
}>;

type ConductorFundingPortInput = Readonly<{
  humanUserId: string;
  modelId: string;
  roomId: string;
  authority: AcceptedInvocationAuthority;
  protectedTurn?: boolean;
}>;

export function usageFundingFor(decision: ModelFundingDecision) {
  return decision.kind === "personal"
    ? {
        kind: "personal" as const,
        humanUserId: decision.humanUserId,
        payerHumanId: decision.payerHumanId,
        providerRoute: decision.providerRoute,
        credentialId: decision.credentialId,
        credentialRevision: decision.credentialRevision,
      }
    : {
        kind: "server" as const,
        humanUserId: decision.humanUserId,
        providerRoute: decision.providerRoute,
      };
}

function assertSignedChatModel(modelId: string): void {
  const model = resolveRetainedModels([modelId], {
    purpose: "chat",
    env: { NAUTILO_ALLOW_CHINA_UPSTREAM: process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] },
  })[0];
  if (!model || (model.availability !== "selectable" && model.availability !== "missing-key")) {
    throw new ModelFundingError("unsupported_provider");
  }
  const catalog = resolveCatalogModel(modelId, { env: {} });
  if (catalog.workload !== "chat" || !catalog.output.includes("text")) {
    throw new ModelFundingError("unsupported_workload");
  }
}

/** Narrow topology predicate retained for workload adapters that still require an own private Genie. */
export async function isOwnPrivateGenieRoom(
  humanUserId: string,
  roomId: string,
  agentId: string,
): Promise<boolean> {
  const actor = await findActorByOwnerId(humanUserId);
  if (!actor) return false;
  const room = await getRoomDetailForMember(roomId, actor.id);
  if (!room || room.kind !== "private" || room.members.length !== 2) return false;
  const human = room.members.find((member) => member.kind === "user");
  const genie = room.members.find((member) => member.kind === "agent");
  return human?.userId === humanUserId
    && genie?.agentId === agentId
    && genie.agentOwnerUserId === humanUserId;
}

export async function assertForegroundRoomAuthority(input: Readonly<{
  humanUserId: string;
  roomId: string;
  agentId?: string;
}>): Promise<void> {
  const actor = await findActorByOwnerId(input.humanUserId);
  if (!actor) throw new ModelFundingError("unsupported_workload");
  const [liveRoom] = await getServerDirectDb().select({ id: rooms.id }).from(rooms)
    .where(and(eq(rooms.id, input.roomId), isNull(rooms.archivedAt))).limit(1);
  if (!liveRoom) throw new ModelFundingError("unsupported_workload");
  const room = await getRoomDetailForMember(input.roomId, actor.id);
  if (!room || !room.members.some((member) =>
    member.kind === "user" && member.userId === input.humanUserId
  )) throw new ModelFundingError("unsupported_workload");
  if (input.agentId && !room.members.some((member) =>
    member.kind === "agent" && member.agentId === input.agentId
  )) throw new ModelFundingError("unsupported_workload");
  try {
    await assertCanInvokeAgent({
      humanUserId: input.humanUserId,
      origin: "room_message",
      roomId: input.roomId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  } catch (error) {
    if (!(error instanceof AgentInvocationDeniedError)) throw error;
    throw new ModelFundingError("unsupported_workload");
  }
}

/**
 * Server-owned funding port. It is installed in the Runtime process only and
 * receives a Human already bound to the opaque accepted invocation authority.
 * Neither the session nor a decrypted credential enters a Job or checkpoint.
 */
export async function openForegroundChatFundingSession(
  input: FundingPortInput,
): Promise<ForegroundChatFundingSession | null> {
  const external = input.entrypoint === "foreground.external_room";
  const recheckAuthority = async () => {
    if (external) {
      if (!input.assertExternalRoomSponsorship) {
        throw new ModelFundingError("unsupported_workload");
      }
      await input.assertExternalRoomSponsorship();
    }
    await assertForegroundRoomAuthority(input);
  };
  await recheckAuthority();
  const db = getServerDirectDb();
  const policy = await getServerProviderPolicy(db);
  const caps = await getUserCapabilities(input.humanUserId);
  const serverAllowed = caps.includes("use_server_provider_credentials");
  if (!policy.allowPersonalProviderKeys) {
    if (!serverAllowed || input.prior?.binding.kind === "personal") throw new ModelFundingError("personal_credentials_disabled");
  }
  if (!caps.includes("use_personal_provider_credentials")) {
    if (!serverAllowed || input.prior?.binding.kind === "personal") throw new ModelFundingError("personal_credentials_forbidden");
  }
  // Funding can make a missing-key catalogue entry runnable, but it cannot
  // authorize an unsigned, disabled, or non-chat model identifier.
  assertSignedChatModel(input.modelId);

  const prior = input.prior;
  if (prior && prior.modelId !== input.modelId) throw new ModelFundingError("funding_source_changed");
  const priorDecision: ModelFundingDecision | undefined = prior ? prior.binding.kind === "personal"
    ? { ...prior.binding, humanUserId: input.humanUserId, payerHumanId: input.humanUserId, modelId: prior.modelId, workload: "foreground_text_chat" }
    : { ...prior.binding, humanUserId: input.humanUserId, modelId: prior.modelId, workload: "foreground_text_chat" } : undefined;
  const admitted = await resolveModelFunding({
    humanUserId: input.humanUserId,
    modelId: input.modelId,
    workload: "foreground_text_chat",
    ...(priorDecision ? { priorDecision } : {}),
  });
  const resolveCandidate = async (modelId: string, transport?: "direct" | "surplus") => {
    await recheckAuthority();
    assertSignedChatModel(modelId);
    return resolveModelFunding({
      humanUserId: input.humanUserId,
      modelId,
      workload: "foreground_text_chat",
      priorDecision: admitted,
      ...(transport ? { transport } : {}),
    });
  };
  const runnableModelIds = await callerTaskModelIds(input.humanUserId);
  let lastAttempt: ModelFundingDecision | undefined;
  return {
    kind: admitted.kind,
    ...(input.protectedTurn !== true ? { allowUnpinnedSurplusRetry: true as const } : {}),
    ...(external ? { contentPrivateDiagnostics: true as const } : {}),
    admission: { modelId: admitted.modelId, binding: capabilityFundingBinding(admitted) },
    capabilityFunding: await prepareCapabilityFundingSession(input.humanUserId, recheckAuthority,
      admitted.kind, capabilityFundingBinding(admitted),
      input.protectedTurn !== true ? true : undefined),
    personalTaskControls: admitted.kind === "personal"
      && resolveCatalogModel(input.modelId, { env: {} }).features.tools === true,
    runnableModelIds,
    personalOnlyTaskModelIds: await personalOnlyTaskModelIds(input.humanUserId, runnableModelIds),
    ...(admitted.kind === "server" && admitted.providerRoute === "surplus" ? {
      openPersonalDirectRecovery: (modelId: string) => openSurplusPersonalDirectRecovery({
        humanUserId: input.humanUserId,
        modelId,
        workload: "foreground_text_chat",
        primaryDecision: admitted,
        ...(input.protectedTurn !== true ? { allowUnpinnedSurplusRetry: true as const } : {}),
        recheckPrimary: () => resolveCandidate(modelId),
      }),
    } : {}),
    ...(admitted.kind === "server" && policy.fundingPreference === "server_first" ? {
      openPersonalRecovery: (modelId: string) => openServerFirstPersonalRecovery({
        humanUserId: input.humanUserId,
        modelId,
        workload: "foreground_text_chat",
        primaryDecision: admitted,
        ...(input.protectedTurn !== true ? { allowUnpinnedSurplusRetry: true as const } : {}),
        recheckPrimary: () => resolveCandidate(modelId),
      }),
    } : {}),
    async recheckAttempt(modelId, transport) {
      const current = await resolveCandidate(modelId, transport);
      if (transport && lastAttempt?.kind === "personal" && current.kind === "personal"
        && lastAttempt.modelId === modelId && lastAttempt.providerRoute === current.providerRoute
        && (lastAttempt.credentialId !== current.credentialId
          || lastAttempt.credentialRevision !== current.credentialRevision)) {
        throw new ModelFundingError("personal_credential_stale");
      }
    },
    async runAttempt(modelId, run, transport) {
      const decision = await resolveCandidate(modelId, transport);
      lastAttempt = decision;
      const usageFunding = usageFundingFor(decision);
      if (decision.kind === "server") return run({ usageFunding });
      return withAdmittedPersonalCredential(
        decision,
        (personalCredential) => run({ usageFunding, personalCredential }),
        undefined,
        admitted,
      );
    },
  };
}

/**
 * Open funding only when ambiguous Room routing actually needs the Conductor
 * model. The initiating Human remains the payer; the administrator-selected
 * Conductor model remains authoritative.
 */
export async function openForegroundConductorFundingSession(
  input: ConductorFundingPortInput,
): Promise<ForegroundChatFundingSession> {
  assertAcceptedInvocationAuthoritySubject(input.authority, input.humanUserId);
  const recheckAuthority = () => assertForegroundRoomAuthority(input);
  await recheckAuthority();
  assertSignedChatModel(input.modelId);
  const admitted = await resolveModelFunding({
    humanUserId: input.humanUserId,
    modelId: input.modelId,
    workload: "foreground_text_chat",
    ...(input.protectedTurn ? { fundingKind: "server" as const } : {}),
  });
  const policy = admitted.kind === "server"
    ? await getServerProviderPolicy(getServerDirectDb())
    : null;
  let lastAttempt: ModelFundingDecision | undefined;
  const resolveCandidate = async (modelId: string, transport?: "direct" | "surplus") => {
    await recheckAuthority();
    assertSignedChatModel(modelId);
    return resolveModelFunding({
      humanUserId: input.humanUserId,
      modelId,
      workload: "foreground_text_chat",
      priorDecision: admitted,
      ...(transport ? { transport } : {}),
    });
  };
  return {
    kind: admitted.kind,
    ...(!input.protectedTurn ? { allowUnpinnedSurplusRetry: true as const } : {}),
    admission: { modelId: admitted.modelId, binding: capabilityFundingBinding(admitted) },
    ...(!input.protectedTurn && admitted.kind === "server" && admitted.providerRoute === "surplus" ? {
      openPersonalDirectRecovery: (modelId: string) => openSurplusPersonalDirectRecovery({
        humanUserId: input.humanUserId,
        modelId,
        workload: "foreground_text_chat",
        primaryDecision: admitted,
        allowUnpinnedSurplusRetry: true,
        recheckPrimary: () => resolveCandidate(modelId),
      }),
    } : {}),
    ...(!input.protectedTurn && admitted.kind === "server"
      && policy?.fundingPreference === "server_first" ? {
        openPersonalRecovery: (modelId: string) => openServerFirstPersonalRecovery({
          humanUserId: input.humanUserId,
          modelId,
          workload: "foreground_text_chat",
          primaryDecision: admitted,
          allowUnpinnedSurplusRetry: true,
          recheckPrimary: () => resolveCandidate(modelId),
        }),
      } : {}),
    async recheckAttempt(modelId, transport) {
      const current = await resolveCandidate(modelId, transport);
      if (transport && lastAttempt?.kind === "personal" && current.kind === "personal"
        && lastAttempt.modelId === modelId && lastAttempt.providerRoute === current.providerRoute
        && (lastAttempt.credentialId !== current.credentialId
          || lastAttempt.credentialRevision !== current.credentialRevision)) {
        throw new ModelFundingError("personal_credential_stale");
      }
    },
    async runAttempt(modelId, run, transport) {
      const decision = await resolveCandidate(modelId, transport);
      lastAttempt = decision;
      const usageFunding = usageFundingFor(decision);
      if (decision.kind === "server") return run({ usageFunding });
      return withAdmittedPersonalCredential(
        decision,
        (personalCredential) => run({ usageFunding, personalCredential }),
        undefined,
        admitted,
      );
    },
  };
}
