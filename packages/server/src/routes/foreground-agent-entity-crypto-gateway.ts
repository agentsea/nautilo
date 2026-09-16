import type {
  DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  createProtectedCheckpointCellCrypto,
  ProtectedCheckpointCryptoError,
  type ForegroundAgentEntityCryptoInvocation,
  type ForegroundAgentEntityCryptoOperation,
  type ForegroundAgentEntityCryptoResult,
  type ProtectedCheckpointCellAuthorityPort,
  type ProtectedCheckpointNamespaceOperationContext,
} from "@nautilo/lattice-bridge";
import {
  inspectDomainCompressedLiveShadowSessionCapability,
  withDomainCompressedLiveShadowSessionCapabilityEntries,
  type DomainCompressedLiveShadowSessionCapability,
  type DomainCompressedLiveShadowSessionCapabilityDescription,
  type DomainForegroundNamespaceAuthorityInspectionV2,
  type LiveShadowForegroundAuthorizationScope,
} from "@nautilo/lattice-bridge/server";
import type {
  ForegroundAuthorizationExecutionResult,
} from "@nautilo/runtime";

import type {
  LiveShadowForegroundAuthorizationSessions,
} from "./live-shadow-foreground-authorization-sessions";

type ForegroundGrantSessions = Pick<
  LiveShadowForegroundAuthorizationSessions,
  "execute"
>;
type NamespaceAuthority = Omit<
  DomainForegroundNamespaceAuthorityInspectionV2,
  "status"
>;
type Operation = ForegroundAgentEntityCryptoOperation;

interface ForegroundNamespaceKeys {
  inspectForegroundNamespaceAuthority(input: Readonly<{
    namespaceId: string;
    keyClass: "ai";
  }>): Promise<
    | DomainForegroundNamespaceAuthorityInspectionV2
    | Readonly<{ status: "unavailable"; reason: string }>
  >;
  withOpenedForegroundNamespaceKey<Value>(input: Readonly<{
    authority: NamespaceAuthority;
    domainKey: Uint8Array;
    keyGeneration?: number;
    accessRevision?: number;
    use(key: Uint8Array): Value | Promise<Value>;
  }>): Promise<Value | null>;
}

export type {
  ForegroundAgentEntityCryptoInvocation,
  ForegroundAgentEntityCryptoResult,
};

export interface ForegroundAgentEntityCryptoRequest<Value> {
  sessionReference: string;
  scope: LiveShadowForegroundAuthorizationScope;
  /**
   * Optional narrower deadline for the complete callback. When omitted, the
   * retained foreground authorization's own expiry remains the hard limit.
   */
  operationDeadline?: number;
  entrypointId: "foreground.conductor" | "foreground.main" | "foreground.fork";
  operations: readonly Operation[];
  execute(context: Readonly<{
    entities: ForegroundAgentEntityCryptoInvocation;
    grant: DomainCompressedLiveShadowSessionCapabilityDescription;
  }>): Promise<Value> | Value;
}

export interface ForegroundAgentEntityCryptoGateway {
  /** Keep one live foreground authorization around the complete invocation. */
  readonly execute: <Value>(
    input: Readonly<ForegroundAgentEntityCryptoRequest<Value>>,
  ) => Promise<ForegroundAuthorizationExecutionResult<Value>>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function matchingDomain(
  authority: NamespaceAuthority,
  entries: ReadonlyMap<
    string,
    DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry
  >,
): DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry | undefined {
  const entry = entries.get(authority.domainId);
  return entry !== undefined
    && entry.domainKeyGeneration === authority.domainKeyGeneration
    && entry.authorizationRevision === authority.domainAuthorizationRevision
    && equalBytes(entry.headDigest, authority.domainHeadDigest)
    ? entry
    : undefined;
}

function wipeAuthority(authority: NamespaceAuthority): void {
  authority.namespaceHeadDigest.fill(0);
  authority.namespacePublicationDigest.fill(0);
  authority.namespacePublicationSetDigest.fill(0);
  authority.namespaceAudienceFingerprint.fill(0);
  authority.domainHeadDigest.fill(0);
  authority.bundleDigest.fill(0);
}

function canonicalOperations(
  operations: readonly Operation[],
): readonly Operation[] {
  if (
    operations.length < 1
    || operations.some((operation, index) =>
      (operation !== "decrypt" && operation !== "encrypt")
      || (index > 0 && operations[index - 1]! >= operation)
    )
  ) throw new TypeError("Agent entity operations are not canonical");
  return Object.freeze([...operations]);
}

function operationsAllowed(
  requested: readonly Operation[],
  granted: readonly Operation[],
): boolean {
  return requested.length > 0
    && !requested.some((operation, index) =>
      (operation !== "decrypt" && operation !== "encrypt")
      || (index > 0 && requested[index - 1]! >= operation)
      || !granted.includes(operation)
    );
}

type ClosableInvocation = ForegroundAgentEntityCryptoInvocation & Readonly<{
  close(): void;
}>;

function checkpointUnavailable(reason: string): ProtectedCheckpointCryptoError {
  return new ProtectedCheckpointCryptoError(
    "authorization_unavailable",
    `foreground checkpoint authority is unavailable: ${reason}`,
  );
}

/**
 * Adapt the family-neutral entity gateway to the existing encrypted LangGraph
 * checkpoint cell format. Only the current Namespace generation is needed:
 * every fresh foreground turn starts from an empty encrypted checkpoint
 * thread, while within-turn checkpoints share this one retained authority.
 */
export function createForegroundEntityCheckpointAuthorization(input: Readonly<{
  crypto: LatticeCrypto;
  entities: ForegroundAgentEntityCryptoInvocation;
  namespaceId: string;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  domainId: string;
  agentAuthorizationRevision: number;
  authorizationDeadlineAt: number;
  entrypointId: "foreground.main" | "foreground.fork";
}>): Readonly<{
  crypto: ReturnType<typeof createProtectedCheckpointCellCrypto>;
  namespaceId: string;
  namespaceAccessRevision: number;
  agentAuthorizationRevision: number;
  authorizationSession: object;
}> {
  const authorizationSession = Object.freeze({});
  const assertActive = (): void => {
    if (
      input.entities.signal.aborted
      || !Number.isSafeInteger(input.authorizationDeadlineAt)
      || Date.now() >= input.authorizationDeadlineAt
    ) throw checkpointUnavailable("session_expired");
  };
  const inspectCurrent = async (): Promise<void> => {
    assertActive();
    const inspected = await input.entities.use({
      operations: ["decrypt"],
      entity: {
        namespaceId: input.namespaceId,
        keyGeneration: input.namespaceKeyGeneration,
        accessRevision: input.namespaceAccessRevision,
      },
      execute: ({ authority }) => {
        if (
          authority.domainId !== input.domainId
          || authority.namespaceAccessRevision
            !== input.namespaceAccessRevision
          || authority.namespaceKeyGeneration
            !== input.namespaceKeyGeneration
        ) throw checkpointUnavailable("authority_changed");
      },
    });
    if (inspected.status !== "executed") {
      throw checkpointUnavailable(inspected.reason);
    }
    assertActive();
  };
  const authority: ProtectedCheckpointCellAuthorityPort = Object.freeze({
    execute: async <Value>(request: Readonly<{
      authorizationSession: unknown;
      entrypointId: "foreground.main" | "foreground.fork";
      operation: "decrypt" | "encrypt";
      namespaceId: string;
      domainId: string;
      expectedAccessRevision: number;
      expectedPolicyRevision: number;
      execute(
        context: ProtectedCheckpointNamespaceOperationContext,
      ): Promise<Value>;
    }>): Promise<Value> => {
      if (
        request.authorizationSession !== authorizationSession
        || request.namespaceId !== input.namespaceId
        || request.domainId !== input.domainId
        || request.expectedAccessRevision !== input.namespaceAccessRevision
        || request.expectedPolicyRevision
          !== input.agentAuthorizationRevision
      ) throw checkpointUnavailable("scope_changed");
      assertActive();
      const opened = await input.entities.use<Value>({
        operations: [request.operation],
        entity: {
          namespaceId: input.namespaceId,
          keyGeneration: input.namespaceKeyGeneration,
          accessRevision: input.namespaceAccessRevision,
        },
        execute: async ({ namespaceKey, authority: current }) => {
          if (current.domainId !== input.domainId) {
            throw checkpointUnavailable("domain_changed");
          }
          // The grant belongs to the invocation; the crypto lease belongs to
          // this one operation. LangGraph overlaps checkpoint and task writes.
          const operation = new AbortController();
          const parent = input.entities.signal;
          const cancel = (): void => operation.abort(parent.reason);
          parent.addEventListener("abort", cancel, { once: true });
          if (parent.aborted) cancel();
          const assertOperationActive = (): void => {
            assertActive();
            if (operation.signal.aborted) {
              throw checkpointUnavailable("operation_closed");
            }
          };
          const context = Object.freeze({
            signal: operation.signal,
            assertActive: assertOperationActive,
            assertCommitAllowed: async () => {
              assertOperationActive();
              await inspectCurrent();
              assertOperationActive();
            },
            remainingMs: () => {
              assertOperationActive();
              return Math.max(
                1,
                Math.floor(input.authorizationDeadlineAt - Date.now()),
              );
            },
            material: Object.freeze({
              namespaceId: current.namespaceId,
              domainId: current.domainId,
              domainEpoch: current.domainKeyGeneration,
              accessRevision: current.namespaceAccessRevision,
              agentAuthorizationRevision:
                input.agentAuthorizationRevision,
              bindingHash: current.namespaceHeadDigest,
              currentGeneration: current.namespaceKeyGeneration,
              generations: Object.freeze([Object.freeze({
                generation: current.namespaceKeyGeneration,
                key: namespaceKey,
              })]),
            }),
          });
          try {
            assertOperationActive();
            return await request.execute(context);
          } finally {
            parent.removeEventListener("abort", cancel);
            operation.abort();
          }
        },
      });
      if (opened.status !== "executed") {
        throw checkpointUnavailable(opened.reason);
      }
      return opened.value;
    },
  });
  return Object.freeze({
    crypto: createProtectedCheckpointCellCrypto({
      crypto: input.crypto,
      authority,
      domainId: input.domainId,
      entrypointId: input.entrypointId,
    }),
    namespaceId: input.namespaceId,
    namespaceAccessRevision: input.namespaceAccessRevision,
    agentAuthorizationRevision: input.agentAuthorizationRevision,
    authorizationSession,
  });
}

function createInvocation(input: Readonly<{
  operations: readonly Operation[];
  namespaceIds: readonly string[];
  entries: readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry[];
  namespaceKeys: ForegroundNamespaceKeys;
  signal: AbortSignal;
}>): ClosableInvocation {
  let live = true;
  const allowedNamespaceIds = new Set(input.namespaceIds);
  const entriesByDomain = new Map(input.entries.map((entry) => [
    entry.grantDomainId,
    entry,
  ]));
  const use = async <Value>(request: Readonly<{
      operations: readonly Operation[];
      entity: Readonly<{
        namespaceId: string;
        keyGeneration: number;
        accessRevision: number;
      }>;
      execute(context: Readonly<{
        namespaceKey: Uint8Array;
        authority: NamespaceAuthority;
      }>): Promise<Value> | Value;
    }>): Promise<ForegroundAgentEntityCryptoResult<Value>> => {
      if (
        !live
        || input.signal.aborted
        || !operationsAllowed(request.operations, input.operations)
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      if (!allowedNamespaceIds.has(request.entity.namespaceId)) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      const inspected = await input.namespaceKeys
        .inspectForegroundNamespaceAuthority({
          namespaceId: request.entity.namespaceId,
          keyClass: "ai",
        });
      if (inspected.status !== "ready") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      try {
        if (inspected.namespaceId !== request.entity.namespaceId) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          });
        }
        if (input.signal.aborted) return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
        if (
          request.operations.includes("encrypt")
          && (
            request.entity.keyGeneration !== inspected.namespaceKeyGeneration
            || request.entity.accessRevision
              !== inspected.namespaceAccessRevision
          )
        ) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          });
        }
        const domain = matchingDomain(inspected, entriesByDomain);
        if (domain === undefined) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          });
        }
        const aborted = Symbol("foreground-agent-entity-aborted");
        const opened = await input.namespaceKeys
          .withOpenedForegroundNamespaceKey<
            Readonly<{ status: "executed"; value: Value }> | typeof aborted
          >({
            authority: inspected,
            domainKey: domain.domainAiGrantKey,
            keyGeneration: request.entity.keyGeneration,
            accessRevision: request.entity.accessRevision,
            use: async (namespaceKey) => input.signal.aborted
              ? aborted
              : Object.freeze({
                status: "executed" as const,
                value: await request.execute({
                  namespaceKey,
                  authority: inspected,
                }),
              }),
          });
        if (opened === aborted) return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
        return opened === null
          ? Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          })
          : Object.freeze({
            status: "executed" as const,
            value: opened.value,
          });
      } finally {
        wipeAuthority(inspected);
      }
    };
  return Object.freeze({
    signal: input.signal,
    use,
    useCurrentSet: async <Value>(request: Readonly<{
      operations: readonly Operation[];
      namespaceIds: readonly string[];
      execute(items: readonly Readonly<{
        namespaceKey: Uint8Array;
        authority: NamespaceAuthority;
      }>[]): Promise<Value> | Value;
    }>): Promise<ForegroundAgentEntityCryptoResult<Value>> => {
      if (
        request.namespaceIds.length < 1
        || request.namespaceIds.some((namespaceId, index) =>
          !allowedNamespaceIds.has(namespaceId)
          || (index > 0 && request.namespaceIds[index - 1]! >= namespaceId)
        )
      ) return Object.freeze({
        status: "unavailable" as const,
        reason: "content_unavailable" as const,
      });
      const inspected: NamespaceAuthority[] = [];
      try {
        if (
          !live
          || input.signal.aborted
          || !operationsAllowed(request.operations, input.operations)
        ) return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
        for (const currentNamespaceId of request.namespaceIds) {
          const authority = await input.namespaceKeys
            .inspectForegroundNamespaceAuthority({
              namespaceId: currentNamespaceId,
              keyClass: "ai",
            });
          if (authority.status !== "ready") return Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          });
          if (authority.namespaceId !== currentNamespaceId) {
            wipeAuthority(authority);
            return Object.freeze({
              status: "unavailable" as const,
              reason: "content_unavailable" as const,
            });
          }
          if (input.signal.aborted) {
            wipeAuthority(authority);
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            });
          }
          inspected.push(authority);
        }
        const opened: Array<Readonly<{
          namespaceKey: Uint8Array;
          authority: NamespaceAuthority;
        }>> = [];
        const next = async (
          index: number,
        ): Promise<ForegroundAgentEntityCryptoResult<Value>> => {
          if (input.signal.aborted) return Object.freeze({
            status: "unavailable" as const,
            reason: "authorization_unavailable" as const,
          });
          if (index === inspected.length) return Object.freeze({
            status: "executed" as const,
            value: await request.execute(Object.freeze([...opened])),
          });
          const authority = inspected[index]!;
          const domain = matchingDomain(authority, entriesByDomain);
          if (domain === undefined) return Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          });
          const result = await input.namespaceKeys
            .withOpenedForegroundNamespaceKey<
              ForegroundAgentEntityCryptoResult<Value>
            >({
              authority,
              domainKey: domain.domainAiGrantKey,
              keyGeneration: authority.namespaceKeyGeneration,
              accessRevision: authority.namespaceAccessRevision,
              use: async (namespaceKey) => {
                opened.push(Object.freeze({ namespaceKey, authority }));
                try {
                  return await next(index + 1);
                } finally {
                  opened.pop();
                }
              },
            });
          return result ?? Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          });
        };
        // Keep inspected digests alive until asynchronous key use completes.
        return await next(0);
      } finally {
        inspected.forEach(wipeAuthority);
      }
    },
    close: () => {
      live = false;
    },
  });
}

/**
 * Production Agent crypto boundary: one live Grant owns an invocation; each
 * entity supplies only Namespace coordinates and its canonical byte transform.
 */
export function createForegroundAgentEntityCryptoGateway(input: Readonly<{
  authorizations: ForegroundGrantSessions;
  namespaceKeys: ForegroundNamespaceKeys;
  openCapabilityEntries?: typeof withDomainCompressedLiveShadowSessionCapabilityEntries;
}>): ForegroundAgentEntityCryptoGateway {
  const openCapabilityEntries = input.openCapabilityEntries
    ?? withDomainCompressedLiveShadowSessionCapabilityEntries;
  return Object.freeze({
    execute: async <Value>(
      request: Readonly<ForegroundAgentEntityCryptoRequest<Value>>,
    ) => {
      const operations = canonicalOperations(request.operations);
      return input.authorizations.execute<Value>({
        sessionReference: request.sessionReference,
        scope: request.scope,
        ...(request.operationDeadline === undefined
          ? {}
          : { operationDeadline: request.operationDeadline }),
        entrypointId: request.entrypointId,
        operations,
        execute: async (
          capability: DomainCompressedLiveShadowSessionCapability,
          signal: AbortSignal,
        ) => {
          if (signal.aborted) return Object.freeze({
            status: "unavailable" as const,
            reason: "authorization_unavailable" as const,
          });
          const grant = inspectDomainCompressedLiveShadowSessionCapability(
            capability,
          );
          if (grant === null) {
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            });
          }
          try {
            const opened = await openCapabilityEntries<Readonly<{
              value: Value;
            }>>(capability, async (entries) => {
              const entities = createInvocation({
                operations,
                namespaceIds: grant.namespaceIds,
                entries,
                namespaceKeys: input.namespaceKeys,
                signal,
              });
              try {
                return Object.freeze({
                  value: await request.execute({ entities, grant }),
                });
              } finally {
                entities.close();
              }
            });
            return opened === null
              ? Object.freeze({
                status: "unavailable" as const,
                reason: "authorization_unavailable" as const,
              })
              : Object.freeze({
                status: "executed" as const,
                value: opened.value,
              });
          } finally {
            grant.authorizationDigest.fill(0);
          }
        },
      });
    },
  });
}
