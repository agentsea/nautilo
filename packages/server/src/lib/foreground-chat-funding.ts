import { resolveRetainedModels, resolveCatalogModel, type ForegroundChatFundingSession } from "@nautilo/agent";
import { getServerProviderPolicy, listPersonalProviderCredentials } from "@nautilo/db";
import {
  assertCanInvokeAgent,
  findActorByOwnerId,
  getRoomDetailForMember,
  getUserCapabilities,
} from "@nautilo/trust";
import {
  ModelFundingError,
  PERSONAL_CHAT_PROVIDER_IDS,
  resolveModelFunding,
  withAdmittedPersonalProviderKey,
  type ModelFundingDecision,
} from "./model-funding";
import { getServerDirectDb } from "./server-direct-db";
import { currentPersonalGatewayDestination } from "./personal-provider-destination";
import { callerTaskModelIds, personalOnlyTaskModelIds } from "./caller-task-model-context";

type FundingPortInput = Readonly<{
  humanUserId: string;
  modelId: string;
  roomId: string;
  agentId: string;
  entrypoint: "foreground.main" | "foreground.fork";
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
  const model = resolveRetainedModels([modelId], { purpose: "chat", env: {} })[0];
  if (!model || (model.availability !== "selectable" && model.availability !== "missing-key")) {
    throw new ModelFundingError("unsupported_provider");
  }
  const catalog = resolveCatalogModel(modelId, { env: {} });
  if (catalog.workload !== "chat" || !catalog.output.includes("text")) {
    throw new ModelFundingError("unsupported_workload");
  }
}

/** A live, exact private Room and the actor mirror establish the supported chat shape. */
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

/** Used only to stop unsupported auxiliary/conductor shapes before they spend. */
export async function callerHasConfiguredPersonalFunding(humanUserId: string): Promise<boolean> {
  const caps = await getUserCapabilities(humanUserId);
  if (!caps.includes("use_personal_provider_credentials")) return false;
  const db = getServerDirectDb();
  const policy = await getServerProviderPolicy(db);
  if (!policy.allowPersonalProviderKeys) return false;
  return (await listPersonalProviderCredentials(db, humanUserId)).some((credential) =>
    (PERSONAL_CHAT_PROVIDER_IDS as readonly string[]).includes(credential.provider));
}

export async function callerMayUsePersonalChat(humanUserId: string): Promise<boolean> {
  const caps = await getUserCapabilities(humanUserId);
  if (!caps.includes("use_personal_provider_credentials")) return false;
  return (await getServerProviderPolicy(getServerDirectDb())).allowPersonalProviderKeys;
}

/**
 * Server-owned funding port. It is installed in the Runtime process only and
 * receives a Human already bound to the opaque accepted invocation authority.
 * Neither the session nor a decrypted credential enters a Job or checkpoint.
 */
export async function openForegroundChatFundingSession(
  input: FundingPortInput,
): Promise<ForegroundChatFundingSession | null> {
  const db = getServerDirectDb();
  const policy = await getServerProviderPolicy(db);
  const caps = await getUserCapabilities(input.humanUserId);
  const serverAllowed = caps.includes("use_server_provider_credentials");
  if (!policy.allowPersonalProviderKeys) {
    if (serverAllowed) return null;
    throw new ModelFundingError("personal_credentials_disabled");
  }
  if (!caps.includes("use_personal_provider_credentials")) {
    if (serverAllowed) return null;
    throw new ModelFundingError("personal_credentials_forbidden");
  }
  if (!(await isOwnPrivateGenieRoom(input.humanUserId, input.roomId, input.agentId))) {
    // A member who also has server funding keeps the established foreign-DM
    // path. Personal-only callers cannot turn a foreign Room into server spend.
    if (serverAllowed) return null;
    throw new ModelFundingError("unsupported_workload");
  }
  await assertCanInvokeAgent({
    humanUserId: input.humanUserId,
    origin: "room_message",
    roomId: input.roomId,
    agentId: input.agentId,
  });

  // Funding can make a missing-key catalogue entry runnable, but it cannot
  // authorize an unsigned, disabled, or non-chat model identifier.
  assertSignedChatModel(input.modelId);

  const admitted = await resolveModelFunding({
    humanUserId: input.humanUserId,
    modelId: input.modelId,
    workload: "foreground_text_chat",
  });
  const resolveCandidate = (modelId: string, transport?: "direct" | "surplus") => {
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
    personalTaskControls: admitted.kind === "personal"
      && resolveCatalogModel(input.modelId, { env: {} }).features.tools === true,
    runnableModelIds,
    personalOnlyTaskModelIds: await personalOnlyTaskModelIds(input.humanUserId, runnableModelIds),
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
      return withAdmittedPersonalProviderKey(
        decision,
        (apiKey) => run({ usageFunding, personalCredential: { apiKey, ...(decision.providerRoute === "gateway"
          ? { destination: currentPersonalGatewayDestination() ?? undefined } : {}) } }),
        undefined,
        admitted,
      );
    },
  };
}
