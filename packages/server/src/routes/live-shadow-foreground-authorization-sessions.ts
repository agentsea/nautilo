import {
  ForegroundAuthorizationSessionRegistry,
  createForegroundAuthorizationCapabilityPort,
  type ForegroundAuthorizationExecutionResult,
} from "@nautilo/runtime";
import {
  destroyDomainCompressedLiveShadowSessionCapability,
  inspectDomainCompressedLiveShadowSessionCapability,
  type DomainCompressedLiveShadowSessionCapability,
  type LiveShadowForegroundAuthorizationPlanPort,
  type LiveShadowForegroundAuthorizationScope,
  type LiveShadowReusableForegroundAuthorization,
} from "@nautilo/lattice-bridge/server";

type Retained = Readonly<{
  readonly expiresAt: number;
  readonly sessionReference: string;
  readonly scope: LiveShadowForegroundAuthorizationScope;
  readonly publicEvidence: LiveShadowReusableForegroundAuthorization;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function scopeKey(scope: LiveShadowForegroundAuthorizationScope): string {
  return "recipientAgentId" in scope
    ? [scope.subjectHumanId, scope.issuingDeviceId, "agent",
      scope.recipientAgentId, scope.sessionId, scope.roomId].join("\u0000")
    : [scope.subjectHumanId, scope.issuingDeviceId, scope.recipientKind,
      scope.browserSessionId, scope.topLevelRoomId].join("\u0000");
}

function sameScope(
  left: LiveShadowForegroundAuthorizationScope,
  right: LiveShadowForegroundAuthorizationScope,
): boolean {
  if (
    left.subjectHumanId !== right.subjectHumanId
    || left.issuingDeviceId !== right.issuingDeviceId
    || left.policyRevision !== right.policyRevision
    || left.hostAuthorizationRevision !== right.hostAuthorizationRevision
  ) return false;
  if ("recipientAgentId" in left !== "recipientAgentId" in right) return false;
  if (
    "recipientAgentId" in left
    && "recipientAgentId" in right
    && (
      left.recipientAgentId !== right.recipientAgentId
      || left.sessionId !== right.sessionId
      || left.roomId !== right.roomId
      || left.agentAuthorizationRevision !== right.agentAuthorizationRevision
    )
  ) return false;
  if (
    !("recipientAgentId" in left)
    && !("recipientAgentId" in right)
    && (
      left.recipientKind !== right.recipientKind
      || left.browserSessionId !== right.browserSessionId
      || left.topLevelRoomId !== right.topLevelRoomId
    )
  ) return false;
  return sameIds(left.namespaceIds, right.namespaceIds)
    && sameIds(left.grantDomainIds, right.grantDomainIds)
    && sameBytes(
      left.domainAuthoritySetDigest,
      right.domainAuthoritySetDigest,
    );
}

function binding(scope: LiveShadowForegroundAuthorizationScope) {
  return "recipientAgentId" in scope
    ? Object.freeze({
      humanId: scope.subjectHumanId,
      issuingDeviceId: scope.issuingDeviceId,
      recipientAgentId: scope.recipientAgentId,
    })
    : Object.freeze({
      humanId: scope.subjectHumanId,
      issuingDeviceId: scope.issuingDeviceId,
      recipientKind: scope.recipientKind,
      browserSessionId: scope.browserSessionId,
      topLevelRoomId: scope.topLevelRoomId,
    });
}

function copyScope(
  scope: LiveShadowForegroundAuthorizationScope,
): LiveShadowForegroundAuthorizationScope {
  return Object.freeze({
    ...scope,
    namespaceIds: Object.freeze([...scope.namespaceIds]),
    grantDomainIds: Object.freeze([...scope.grantDomainIds]),
    domainAuthoritySetDigest: scope.domainAuthoritySetDigest.slice(),
  });
}

function copyEvidence(
  evidence: LiveShadowReusableForegroundAuthorization,
): LiveShadowReusableForegroundAuthorization {
  return Object.freeze({
    ...evidence,
    authorizationDigest: evidence.authorizationDigest.slice(),
    authorizationPlanBytes: evidence.authorizationPlanBytes.slice(),
    authorizationPlanDigest: evidence.authorizationPlanDigest.slice(),
    recipientPublicKey: evidence.recipientPublicKey.slice(),
  });
}

function destroyRetained(retained: Retained): void {
  retained.scope.domainAuthoritySetDigest.fill(0);
  retained.publicEvidence.authorizationDigest.fill(0);
  retained.publicEvidence.authorizationPlanBytes.fill(0);
  retained.publicEvidence.authorizationPlanDigest.fill(0);
  retained.publicEvidence.recipientPublicKey.fill(0);
}

/**
 * Process-local index around Runtime's canonical bounded lifecycle. The index
 * is content-free and exists only so a fresh plan can discover the exact live
 * session for its current authority snapshot.
 */
export class LiveShadowForegroundAuthorizationSessions
  implements LiveShadowForegroundAuthorizationPlanPort {
  readonly #registry: ForegroundAuthorizationSessionRegistry<
    DomainCompressedLiveShadowSessionCapability
  >;
  readonly #byScope = new Map<string, Retained>();

  constructor(options: Readonly<{
    now?: () => number;
    startSweep?: boolean;
  }> = {}) {
    this.#registry = new ForegroundAuthorizationSessionRegistry({
      capabilityPort: createForegroundAuthorizationCapabilityPort({
        inspect: (capability) => {
          const description =
            inspectDomainCompressedLiveShadowSessionCapability(capability);
          if (description === null) return null;
          try {
            const recipient = "recipientAgentId" in description
              ? Object.freeze({
                recipientAgentId: description.recipientAgentId,
              })
              : Object.freeze({
                recipientKind: description.recipientKind,
                browserSessionId: description.browserSessionId,
                topLevelRoomId: description.topLevelRoomId,
              });
            return Object.freeze({
              authorizationId: description.authorizationId,
              issuedAt: description.issuedAt,
              expiresAt: description.expiresAt,
              issuingHumanId: description.subjectHumanId,
              issuingDeviceId: description.issuingDeviceId,
              ...recipient,
              recipientKeyId: description.recipientKeyId,
              namespaceIds: description.namespaceIds,
              domainIds: description.grantDomainIds,
            });
          } finally {
            description.authorizationDigest.fill(0);
          }
        },
        destroy: destroyDomainCompressedLiveShadowSessionCapability,
      }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.startSweep === undefined
        ? {}
        : { startSweep: options.startSweep }),
    });
  }

  inspectReusable(
    scope: LiveShadowForegroundAuthorizationScope,
    minimumDeadlineAt?: number,
  ): LiveShadowReusableForegroundAuthorization | null {
    const key = scopeKey(scope);
    const retained = this.#byScope.get(key);
    if (retained === undefined) return null;
    const resolved = this.#registry.resolve({
      sessionId: retained.sessionReference,
      authenticatedBinding: binding(scope),
    });
    if (resolved.status !== "resolved" || !sameScope(retained.scope, scope)) {
      this.#cancel(retained);
      this.#byScope.delete(key);
      return null;
    }
    if (minimumDeadlineAt !== undefined && (
      !Number.isSafeInteger(minimumDeadlineAt) || minimumDeadlineAt < 0
      || retained.expiresAt < minimumDeadlineAt
    )) {
      // A new invocation must not inherit the final seconds of an older grant.
      // Keep that grant alive for work already using it; the caller's existing
      // fresh-authorization path owns any replacement.
      return null;
    }
    return copyEvidence(retained.publicEvidence);
  }

  register(input: Readonly<{
    capability: DomainCompressedLiveShadowSessionCapability;
    scope: LiveShadowForegroundAuthorizationScope;
    publicEvidence: Omit<
      LiveShadowReusableForegroundAuthorization,
      "sessionReference"
    >;
    now: number;
  }>): LiveShadowReusableForegroundAuthorization | null {
    this.#pruneRetained();
    const description = inspectDomainCompressedLiveShadowSessionCapability(
      input.capability,
    );
    if (description === null) return null;
    const expiresAt = description.expiresAt;
    description.authorizationDigest.fill(0);
    const key = scopeKey(input.scope);
    const previous = this.#byScope.get(key);
    if (previous !== undefined) {
      this.#cancel(previous);
      this.#byScope.delete(key);
    }
    const registration = this.#registry.register({
      capability: input.capability,
      authenticatedBinding: binding(input.scope),
      allowedOperations: Object.freeze(["decrypt", "encrypt"]),
    });
    if (registration.status !== "registered") return null;
    const publicEvidence = copyEvidence(Object.freeze({
      ...input.publicEvidence,
      sessionReference: registration.sessionId,
    }));
    this.#byScope.set(key, Object.freeze({
      expiresAt,
      sessionReference: registration.sessionId,
      scope: copyScope(input.scope),
      publicEvidence,
    }));
    return copyEvidence(publicEvidence);
  }

  async execute<Value>(input: Readonly<{
    sessionReference: string;
    scope: LiveShadowForegroundAuthorizationScope;
    operationDeadline?: number;
    entrypointId?:
      | "foreground.conductor"
      | "foreground.main"
      | "foreground.fork";
    operations?: readonly ("decrypt" | "encrypt")[];
    execute(
      capability: DomainCompressedLiveShadowSessionCapability,
      signal: AbortSignal,
    ): Promise<
      | Readonly<{ status: "executed"; value: Value }>
      | Readonly<{
        status: "unavailable";
        reason: "authorization_unavailable" | "content_unavailable";
      }>
    >;
  }>): Promise<ForegroundAuthorizationExecutionResult<Value>> {
    const retained = this.#byScope.get(scopeKey(input.scope));
    if (
      retained === undefined
      || retained.sessionReference !== input.sessionReference
      || !sameScope(retained.scope, input.scope)
    ) return Object.freeze({ status: "unavailable", reason: "session_cancelled" });
    const resolved = this.#registry.resolve({
      sessionId: input.sessionReference,
      authenticatedBinding: binding(input.scope),
    });
    if (resolved.status !== "resolved") {
      this.#byScope.delete(scopeKey(input.scope));
      destroyRetained(retained);
      return Object.freeze({
        status: "unavailable",
        reason: resolved.reason === "session_expired"
            || resolved.reason === "session_idle_expired"
          ? "session_expired"
          : "session_cancelled",
      });
    }
    const leased = this.#registry.leaseAuthorizationSetOperation({
      view: resolved.view,
      entrypointId: input.entrypointId ?? "foreground.main",
      operations: input.operations ?? Object.freeze(["decrypt", "encrypt"]),
      namespaceIds: input.scope.namespaceIds,
      domainIds: input.scope.grantDomainIds,
      ...(input.operationDeadline === undefined
        ? {}
        : { executionDeadline: input.operationDeadline }),
    });
    if (leased.status !== "leased") {
      return Object.freeze({
        status: "unavailable",
        reason: leased.reason === "session_expired"
            || leased.reason === "session_idle_expired"
          ? "session_expired"
          : "session_cancelled",
      });
    }
    return this.#registry.executeWithCapability(leased.lease, {
      execute: ({ capability, signal }) => input.execute(capability, signal),
    });
  }

  cancelForDevice(input: Readonly<{
    subjectHumanId: string;
    issuingDeviceId: string;
  }>): number {
    let cancelled = 0;
    for (const [key, retained] of this.#byScope) {
      if (
        retained.scope.subjectHumanId === input.subjectHumanId
        && retained.scope.issuingDeviceId === input.issuingDeviceId
      ) {
        this.#cancel(retained);
        this.#byScope.delete(key);
        cancelled++;
      }
    }
    return cancelled;
  }

  cancelScope(scope: LiveShadowForegroundAuthorizationScope): boolean {
    const key = scopeKey(scope);
    const retained = this.#byScope.get(key);
    if (retained === undefined || !sameScope(retained.scope, scope)) {
      return false;
    }
    this.#cancel(retained);
    this.#byScope.delete(key);
    return true;
  }

  cancelForHuman(subjectHumanId: string): number {
    let cancelled = 0;
    for (const [key, retained] of this.#byScope) {
      if (retained.scope.subjectHumanId === subjectHumanId) {
        this.#cancel(retained);
        this.#byScope.delete(key);
        cancelled++;
      }
    }
    return cancelled;
  }

  close(): void {
    this.#registry.close();
    for (const retained of this.#byScope.values()) destroyRetained(retained);
    this.#byScope.clear();
  }

  #cancel(retained: Retained): void {
    this.#registry.cancelSession({
      sessionId: retained.sessionReference,
      authenticatedBinding: binding(retained.scope),
    });
    destroyRetained(retained);
  }

  #pruneRetained(): void {
    for (const [key, retained] of this.#byScope) {
      const resolved = this.#registry.resolve({
        sessionId: retained.sessionReference,
        authenticatedBinding: binding(retained.scope),
      });
      if (resolved.status === "resolved") continue;
      destroyRetained(retained);
      this.#byScope.delete(key);
    }
  }
}
