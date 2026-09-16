import { randomUUID } from "node:crypto";
import { selectLiveEncryptionRepresentationPolicy } from "@nautilo/lattice-bridge";
import { createHumanMemoryProtectedRoutePortsFromTrustedPorts } from "@nautilo/lattice-bridge/server";
import { isScopeMemoryEnvelope, type MemoryAccessEnvelope } from "@nautilo/trust";
import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy";
import { deliverCommittedHumanMemoryEffect } from "./foreground-memory-effect-receipts";
import { withHumanMemoryMutationEffects } from "./human-memory-mutation-effects";
import {
  assertHumanMemoryRequestBinding,
  createHumanMemoryRequestServices,
} from "./human-memory-request-services";
import type {
  ProtectedMemoryRouteAuthority,
  ProtectedMemoryRouteFactory,
  ProtectedMemoryRoutePorts,
} from "./protected-memory-composition";

type AssemblyRequest = Readonly<{
  authority: ProtectedMemoryRouteAuthority;
  envelope: MemoryAccessEnvelope;
  policy: Awaited<ReturnType<typeof currentStrictShadowPolicy>>;
  serverId: string;
  wakeRecovery: () => void;
}>;

/** One live request, one current Human authority. Plaintext never acquires
 * crypto handles; protected modes never reuse another request's composition. */
export function createProductionHumanMemoryRouteFactory(input: Readonly<{
  wakeRecovery: () => void;
  loadPolicy?: typeof currentStrictShadowPolicy;
  assemble?: (request: AssemblyRequest) => Promise<ProtectedMemoryRoutePorts>;
}>): ProtectedMemoryRouteFactory {
  const loadPolicy = input.loadPolicy ?? currentStrictShadowPolicy;
  const assemble = input.assemble ?? assembleHumanMemoryRequest;
  return async (authority, envelope) => {
    const policy = await loadPolicy();
    if (policy.mode === "plaintext_only" || envelope === null
      || isScopeMemoryEnvelope(envelope) || authority.memoryMode !== "namespace"
      || authority.agentId !== null) return null;
    const request = { authority, envelope, policy,
      // The same canonical Domain audience identity used by foreground chat.
      serverId: process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001",
      wakeRecovery: input.wakeRecovery };
    assertHumanMemoryRequestBinding(request);
    const ports = await assemble(request);
    if (!selectLiveEncryptionRepresentationPolicy(policy).allowOrdinaryFallback) return ports;
    return {
      ...ports,
      async detail(operation) {
        const response = await ports.detail(operation);
        if ("status" in response || !response.actionAuthority.canEdit) return response;
        return { ...response, ordinaryFallbackAuthorization: { policyRevision: policy.revision } };
      },
    };
  };
}

async function assembleHumanMemoryRequest(input: AssemblyRequest): Promise<ProtectedMemoryRoutePorts> {
  const { createHumanMemoryExactAccessServices } = await import("./human-memory-exact-access-services");
  const { createHumanMemoryRepairServices } = await import("./human-memory-repair-services");
  const services = await createHumanMemoryRequestServices(input);
  const exact = createHumanMemoryExactAccessServices({ ...input, services });
  const embedding = services.embedding.descriptor();
  const ports = createHumanMemoryProtectedRoutePortsFromTrustedPorts({
    target: input.authority,
    now: Date.now,
    createRequestId: randomUUID,
    createAccessOperationId: randomUUID,
    accessDeadlineAt: exact.accessDeadlineAt,
    queryProvider: embedding.provider,
    queryModel: embedding.model,
    resolveHumanId: services.resolveHumanId,
    foregroundEmbeddingProcessor: services.embedding.processor,
    product: services.product,
    preparedCreate: services.preparedCreate,
    preparedUpdate: services.preparedUpdate,
    exactAccessProduct: exact.exactAccessProduct,
    exactAccessCrypto: exact.exactAccessCrypto,
    resolveNamespaceAuthority: services.resolveNamespaceAuthority,
  });
  const mutations = withHumanMemoryMutationEffects({
    ports: { ...ports, embeddingConfiguration: embedding },
    deliver: ({ authority, operationId, memoryId }) => deliverCommittedHumanMemoryEffect({
      canonicalRunner: services.context.canonicalRunner,
      publication: services.publication,
      authority,
      operationId,
      memoryId,
    }),
    wakeRecovery: input.wakeRecovery,
  });
  // Representation repair is not a semantic edit: never dispatch embedding,
  // reinforcement, or edit follow-up effects for it.
  return { ...mutations, repair: createHumanMemoryRepairServices({ ...input, services }) };
}
