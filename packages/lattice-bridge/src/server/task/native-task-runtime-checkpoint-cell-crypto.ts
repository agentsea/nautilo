import {
  and,
  domainKeyHeads,
  eq,
  humanCryptoDevices,
  namespaceDomainKeyBindings,
  namespaceDomainKeyHeads,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  accessRevision,
  assertAuthenticTaskRuntimeExecutionEvidence,
  authorizationRevision,
  cryptoDomainId,
  namespaceGeneration,
  namespaceId,
  withOpenedDomainNamespaceBundle,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  createProtectedCheckpointCellCrypto,
  type ProtectedCheckpointCellAuthorityPort,
} from "../../checkpoint/protected-checkpoint-cell-crypto.ts";
import type {
  TaskRuntimeCheckpointCellCrypto,
  TaskRuntimeCheckpointCellIdentity,
} from "../../checkpoint/task-runtime-checkpoint-cell-crypto.ts";
import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  readCryptoStorageInteger,
  verifyCryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

export type NativeTaskRuntimeCheckpointCellCryptoInput = Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  evidence: TaskRuntimeExecutionEvidence;
  identity: TaskRuntimeCheckpointCellIdentity;
  domains: readonly DomainForegroundSecretEntry[];
  signal: AbortSignal;
  now(): number;
  /** Reprove the exact running TaskRun, source Room, graph thread and policy. */
  assertCurrentTaskAuthority(): Promise<void>;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}
function destroyAuthority(
  authority: DomainForegroundNamespaceAuthorityInspectionV2,
): void {
  for (const bytes of [
    authority.namespaceHeadDigest,
    authority.namespacePublicationDigest,
    authority.namespacePublicationSetDigest,
    authority.namespaceAudienceFingerprint,
    authority.domainHeadDigest,
    authority.bundleDigest,
  ])
    bytes.fill(0);
}
function sameAuthority(
  left: DomainForegroundNamespaceAuthorityInspectionV2,
  right: DomainForegroundNamespaceAuthorityInspectionV2,
): boolean {
  return (
    left.namespaceId === right.namespaceId &&
    left.namespaceAccessRevision === right.namespaceAccessRevision &&
    left.namespaceKeyGeneration === right.namespaceKeyGeneration &&
    left.domainId === right.domainId &&
    left.domainKeyGeneration === right.domainKeyGeneration &&
    left.domainAuthorizationRevision === right.domainAuthorizationRevision &&
    left.bundleRevision === right.bundleRevision &&
    sameBytes(left.namespaceHeadDigest, right.namespaceHeadDigest) &&
    sameBytes(left.domainHeadDigest, right.domainHeadDigest) &&
    sameBytes(left.bundleDigest, right.bundleDigest)
  );
}

/** Unmounted Task cell owner; native retained generation keys never leave an operation callback. */
export function createNativeTaskRuntimeCheckpointCellCrypto(
  input: NativeTaskRuntimeCheckpointCellCryptoInput,
): TaskRuntimeCheckpointCellCrypto {
  const identity = Object.freeze({ ...input.identity });
  const evidence = input.evidence;
  const domains = Object.freeze([...input.domains]);
  if (
    identity.graphThreadId.length === 0 ||
    !(input.signal instanceof AbortSignal)
  ) {
    throw new TypeError("Native Task checkpoint graph identity is invalid");
  }
  const authorizationSession = Object.freeze({});
  const scope = Object.freeze({
    logicalThreadId: identity.graphThreadId,
    namespaceId: identity.namespaceId,
    keyClass: "ai" as const,
    expectedAccessRevision: identity.expectedAccessRevision,
    expectedPolicyRevision: identity.expectedPolicyRevision,
    authorizationSession,
  });
  const authority: ProtectedCheckpointCellAuthorityPort = {
    execute: async (request) => {
      if (
        request.entrypointId !== "task.execute" ||
        request.authorizationSession !== authorizationSession ||
        request.namespaceId !== identity.namespaceId ||
        request.domainId !== identity.domainId ||
        request.expectedAccessRevision !== identity.expectedAccessRevision ||
        request.expectedPolicyRevision !== identity.expectedPolicyRevision ||
        (request.operation !== "encrypt" && request.operation !== "decrypt")
      ) {
        throw new TypeError(
          "Native Task checkpoint operation identity was substituted",
        );
      }
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(input.signal.reason);
      if (input.signal.aborted) forwardAbort();
      else input.signal.addEventListener("abort", forwardAbort, { once: true });
      let active = true;
      const assertActive = (): void => {
        if (!active)
          throw new TypeError("Native Task checkpoint operation has ended");
        controller.signal.throwIfAborted();
        assertAuthenticTaskRuntimeExecutionEvidence(evidence);
      };
      const owned: Uint8Array[] = [];
      let namespace: DomainForegroundNamespaceAuthorityInspectionV2 | undefined;
      try {
        assertActive();
        const requirements = evidence.namespaceRequirements.filter(
          (entry) => entry.namespaceId === identity.namespaceId,
        );
        const requirement = requirements[0];
        const expectedDomains = evidence.domainRequirements.filter(
          (entry) => entry.domainId === identity.domainId,
        );
        const expectedDomain = expectedDomains[0];
        const matching = domains.filter(
          (entry) => entry.domainId === identity.domainId,
        );
        const domain = matching[0];
        if (
          evidence.purpose !== "task.runtime.execution" ||
          evidence.result.taskId !== identity.taskId ||
          evidence.result.taskRunId !== identity.taskRunId ||
          evidence.workId !== identity.taskRunId ||
          evidence.sourceRoomId !== identity.sourceRoomId ||
          evidence.policyRevision !== identity.expectedPolicyRevision ||
          evidence.result.namespace.namespaceId !== identity.namespaceId ||
          evidence.result.namespace.domainId !== identity.domainId ||
          evidence.result.namespace.expectedAccessRevision !==
            identity.expectedAccessRevision ||
          evidence.result.namespace.expectedPolicyRevision !==
            identity.expectedPolicyRevision ||
          requirements.length !== 1 ||
          requirement === undefined ||
          requirement.domainId !== identity.domainId ||
          requirement.expectedAccessRevision !==
            identity.expectedAccessRevision ||
          requirement.expectedPolicyRevision !==
            identity.expectedPolicyRevision ||
          requirement.operations.length !== 2 ||
          requirement.operations[0] !== "decrypt" ||
          requirement.operations[1] !== "encrypt" ||
          expectedDomains.length !== 1 ||
          expectedDomain === undefined ||
          matching.length !== 1 ||
          domain === undefined ||
          domain.keyClass !== "ai" ||
          expectedDomain.keyClass !== "ai" ||
          domain.sourceNamespaceId !== expectedDomain.sourceNamespaceId ||
          domain.domainKeyGeneration !== expectedDomain.domainKeyGeneration ||
          domain.authorizationRevision !==
            expectedDomain.authorizationRevision ||
          domain.participantCount !== expectedDomain.participantCount ||
          !sameBytes(
            domain.participantDigest,
            expectedDomain.participantDigest,
          ) ||
          !sameBytes(domain.headDigest, expectedDomain.headDigest)
        ) {
          throw new TypeError(
            "Native Task checkpoint evidence or Domain was substituted",
          );
        }
        await input.assertCurrentTaskAuthority();
        assertActive();
        const handle = await verifyCryptoPostgresHandle(input.restricted);
        const repository = new PostgresDomainKeyAuthorityRepository(
          input.restricted,
          input.crypto,
          input.serverScope,
        );
        const inspected = await repository.inspectForegroundNamespaceAuthority({
          namespaceId: identity.namespaceId,
          keyClass: "ai",
        });
        if (inspected.status !== "ready")
          throw new TypeError(
            "Native Task checkpoint Namespace is unavailable",
          );
        namespace = inspected;
        if (
          namespace.namespaceId !== identity.namespaceId ||
          namespace.namespaceAccessRevision !==
            identity.expectedAccessRevision ||
          namespace.domainId !== domain.domainId ||
          namespace.domainKeyGeneration !== domain.domainKeyGeneration ||
          namespace.domainAuthorizationRevision !==
            domain.authorizationRevision ||
          !sameBytes(namespace.domainHeadDigest, domain.headDigest)
        ) {
          throw new TypeError(
            "Native Task checkpoint Namespace authority changed",
          );
        }
        const initial = namespace;
        const assertCurrentDomain = async (): Promise<void> => {
          const rows = await executeTypedCryptoQuery(
            handle,
            cryptoTypedDb
              .select({
                domain_id: domainKeyHeads.domainId,
                domain_key_generation: domainKeyHeads.domainKeyGeneration,
                authorization_revision: domainKeyHeads.authorizationRevision,
                head_digest: domainKeyHeads.headDigest,
                participant_digest: domainKeyHeads.participantDigest,
                participant_count: domainKeyHeads.participantCount,
              })
              .from(domainKeyHeads)
              .where(
                and(
                  eq(domainKeyHeads.domainId, domain.domainId),
                  eq(domainKeyHeads.keyClass, "ai"),
                ),
              )
              .limit(2),
          );
          const head = rows[0];
          assertActive();
          if (
            rows.length !== 1 ||
            head === undefined ||
            head.domain_id !== domain.domainId ||
            readCryptoStorageInteger(head, "domain_key_generation") !== domain.domainKeyGeneration ||
            readCryptoStorageInteger(head, "authorization_revision") !== domain.authorizationRevision ||
            readCryptoStorageInteger(head, "participant_count") !== domain.participantCount ||
            !(head.head_digest instanceof Uint8Array) ||
            !sameBytes(head.head_digest, domain.headDigest) ||
            !(head.participant_digest instanceof Uint8Array) ||
            !sameBytes(head.participant_digest, domain.participantDigest)
          )
            throw new TypeError(
              "Native Task checkpoint Domain authority changed",
            );
        };
        const assertCommitAllowed = async (): Promise<void> => {
          assertActive();
          await input.assertCurrentTaskAuthority();
          assertActive();
          const current = await repository.inspectForegroundNamespaceAuthority({
            namespaceId: identity.namespaceId,
            keyClass: "ai",
          });
          if (current.status !== "ready")
            throw new TypeError(
              "Native Task checkpoint Namespace is unavailable",
            );
          try {
            if (!sameAuthority(initial, current))
              throw new TypeError(
                "Native Task checkpoint Namespace authority changed",
              );
          } finally {
            destroyAuthority(current);
          }
          await assertCurrentDomain();
          assertActive();
        };
        await assertCurrentDomain();
        const rows = await executeTypedCryptoQuery(
          handle,
          cryptoTypedDb
            .select({
              binding_bytes: namespaceDomainKeyBindings.bindingBytes,
              binding_digest: namespaceDomainKeyBindings.bindingDigest,
              signing_public_key: humanCryptoDevices.signingPublicKey,
            })
            .from(namespaceDomainKeyHeads)
            .innerJoin(
              namespaceDomainKeyBindings,
              eq(
                namespaceDomainKeyBindings.operationId,
                namespaceDomainKeyHeads.bindingOperationId,
              ),
            )
            .innerJoin(
              humanCryptoDevices,
              and(
                eq(
                  humanCryptoDevices.deviceId,
                  namespaceDomainKeyBindings.issuerDeviceId,
                ),
                eq(
                  humanCryptoDevices.humanId,
                  namespaceDomainKeyBindings.issuerHumanId,
                ),
                eq(
                  humanCryptoDevices.deviceGeneration,
                  namespaceDomainKeyBindings.issuerDeviceSigningGeneration,
                ),
              ),
            )
            .where(
              and(
                eq(namespaceDomainKeyHeads.namespaceId, identity.namespaceId),
                eq(namespaceDomainKeyHeads.keyClass, "ai"),
                eq(
                  namespaceDomainKeyHeads.bindingDigest,
                  namespace.bundleDigest,
                ),
                eq(namespaceDomainKeyHeads.domainId, domain.domainId),
                eq(
                  namespaceDomainKeyHeads.domainKeyGeneration,
                  domain.domainKeyGeneration,
                ),
                eq(
                  namespaceDomainKeyHeads.domainAuthorizationRevision,
                  domain.authorizationRevision,
                ),
              ),
            )
            .limit(2),
        );
        const row = rows[0];
        if (
          rows.length !== 1 ||
          row === undefined ||
          !(row.binding_bytes instanceof Uint8Array) ||
          !(row.binding_digest instanceof Uint8Array) ||
          !(row.signing_public_key instanceof Uint8Array) ||
          !sameBytes(row.binding_digest, namespace.bundleDigest)
        )
          throw new TypeError("Native Task checkpoint binding is unavailable");
        const bindingBytes = row.binding_bytes.slice();
        const signingKey = row.signing_public_key.slice();
        owned.push(bindingBytes, signingKey);
        assertActive();
        const opened = await withOpenedDomainNamespaceBundle(input.crypto, {
          bindingBytes,
          expectedBindingDigest: namespace.bundleDigest,
          issuerSigningPublicKey: signingKey,
          domainKey: domain.domainKey,
          current: {
            serverId: input.serverScope,
            cryptoDomainId: cryptoDomainId(domain.domainId),
            participantDigest: domain.participantDigest,
            participantCount: domain.participantCount,
            keyClass: "ai",
            domainKeyGeneration: domain.domainKeyGeneration,
            domainAuthorizationRevision: authorizationRevision(
              domain.authorizationRevision,
            ),
            domainHeadDigest: domain.headDigest,
            namespaceId: namespaceId(identity.namespaceId),
            namespaceAccessRevision: accessRevision(
              identity.expectedAccessRevision,
            ),
            namespaceCurrentGeneration: namespaceGeneration(
              namespace.namespaceKeyGeneration,
            ),
            bundleRevision: namespace.bundleRevision,
            retainedAuthoritySetDigest: namespace.namespaceHeadDigest,
          },
          operation: async (retained) => {
            if (
              !retained.some(
                (entry) =>
                  entry.generation === initial.namespaceKeyGeneration &&
                  entry.accessRevision === identity.expectedAccessRevision,
              )
            ) {
              throw new TypeError(
                "Native Task checkpoint current generation revision disagrees",
              );
            }
            // Match Lattice's stream KDF convention: domain label plus a hash
            // of canonical identity bytes, using HKDF-SHA256.
            const identityBytes = new TextEncoder().encode(
              JSON.stringify([
                identity.taskId,
                identity.taskRunId,
                identity.sourceRoomId,
                identity.graphThreadId,
              ]),
            );
            const digest = input.crypto.hash(identityBytes);
            const generations: Array<
              Readonly<{ generation: number; key: Uint8Array }>
            > = [];
            try {
              const label = `nautilo/lattice-crypto/task-runtime-checkpoint-key/v1:${Buffer.from(digest).toString("hex")}`;
              for (const entry of retained)
                generations.push(
                  Object.freeze({
                    generation: entry.generation,
                    key: input.crypto.deriveKey(entry.generationKey, label, 32),
                  }),
                );
              await assertCommitAllowed();
              const value = await request.execute(
                Object.freeze({
                  signal: controller.signal,
                  assertActive,
                  assertCommitAllowed,
                  remainingMs: () => evidence.expiresAt - input.now(),
                  material: Object.freeze({
                    namespaceId: identity.namespaceId,
                    domainId: identity.domainId,
                    accessRevision: identity.expectedAccessRevision,
                    agentAuthorizationRevision: identity.expectedPolicyRevision,
                    currentGeneration: initial.namespaceKeyGeneration,
                    generations: Object.freeze(generations),
                  }),
                }),
              );
              await assertCommitAllowed();
              return value;
            } finally {
              identityBytes.fill(0);
              digest.fill(0);
              for (const entry of generations) entry.key.fill(0);
            }
          },
        });
        if (opened.status !== "opened")
          throw new TypeError("Native Task checkpoint bundle is unavailable");
        assertActive();
        return opened.value;
      } finally {
        active = false;
        input.signal.removeEventListener("abort", forwardAbort);
        controller.abort();
        for (const bytes of owned) bytes.fill(0);
        if (namespace !== undefined) destroyAuthority(namespace);
      }
    },
  };
  return Object.freeze({
    crypto: createProtectedCheckpointCellCrypto({
      crypto: input.crypto,
      authority,
      domainId: identity.domainId,
      entrypointId: "task.execute",
    }),
    scope,
  });
}
