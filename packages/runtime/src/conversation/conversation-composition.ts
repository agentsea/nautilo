import type {
  ProtectedExecutionEntrypointId,
} from "../protected-execution/broker";
import type {
  ConversationExecutionServices,
  ProtectedConversationExecutionServices,
} from "./conversation-execution-services";

const conversationCompositionBrand = Symbol(
  "nautilo.runtime.conversation-composition",
);
const protectedTestShadowAuthorityBrand = Symbol(
  "nautilo.runtime.protected-test-shadow-authority",
);

const recognizedCompositions = new WeakSet<object>();
const recognizedTestAuthorities = new WeakSet<object>();

export type ProtectedTestShadowAuthority = Readonly<{
  readonly [protectedTestShadowAuthorityBrand]: true;
}>;

export type LegacyConversationComposition = Readonly<{
  readonly mode: "legacy";
  readonly services: ConversationExecutionServices;
  readonly [conversationCompositionBrand]: true;
}>;

export type ProtectedTestShadowConversationComposition = Readonly<{
  readonly mode: "protected_test_shadow";
  readonly namespaceId: string;
  readonly legacyServices: ConversationExecutionServices;
  readonly protectedServices: ProtectedConversationExecutionServices;
  readonly [conversationCompositionBrand]: true;
}>;

export type ConversationComposition =
  | LegacyConversationComposition
  | ProtectedTestShadowConversationComposition;

type ModeIndependentEntrypointId = Exclude<
  ProtectedExecutionEntrypointId,
  "subagent.scope" | "resume.await_reply" | "compaction.model"
>;

export type ConversationExecutionOrigin =
  | Readonly<{ readonly entrypointId: ModeIndependentEntrypointId }>
  | Readonly<{
    readonly entrypointId: "subagent.scope";
    readonly mode: "invocation_bound" | "task";
  }>
  | Readonly<{
    readonly entrypointId: "resume.await_reply";
    readonly mode: "foreground_session" | "task";
  }>
  | Readonly<{
    readonly entrypointId: "compaction.model";
    readonly mode: "invocation_bound" | "background";
  }>
  | Readonly<{ readonly entrypointId: "background.job" }>;

export type ConversationExecutionSelection =
  | Readonly<{
    readonly mode: "legacy";
    readonly reason:
      | "default_legacy"
      | "legacy_composition"
      | "protected_namespace_mismatch"
      | "protected_boundary_fallback";
    readonly services: ConversationExecutionServices;
  }>
  | Readonly<{
    readonly mode: "protected_test_shadow";
    readonly reason: "protected_active";
    readonly services: ProtectedConversationExecutionServices;
  }>;

const wave9ForegroundEntrypoints = new Set<ProtectedExecutionEntrypointId>([
  "foreground.main",
  "foreground.fork",
  "resume.approval",
  "resume.approval_ask",
  "resume.identity",
]);

function assertPortableNamespaceId(namespaceId: string): void {
  if (
    typeof namespaceId !== "string"
    || namespaceId.length === 0
    || new TextEncoder().encode(namespaceId).length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(namespaceId)
  ) {
    throw new TypeError(
      "Protected test shadow Namespace must be a portable identifier",
    );
  }
}

function isWave9ActiveOrigin(origin: ConversationExecutionOrigin): boolean {
  if (origin.entrypointId === "background.job") return false;
  if (origin.entrypointId === "subagent.scope") {
    return origin.mode === "invocation_bound";
  }
  if (origin.entrypointId === "resume.await_reply") {
    return origin.mode === "foreground_session";
  }
  if (origin.entrypointId === "compaction.model") {
    return origin.mode === "invocation_bound";
  }
  return wave9ForegroundEntrypoints.has(origin.entrypointId);
}

export function createLegacyConversationComposition(
  services: ConversationExecutionServices,
): LegacyConversationComposition {
  const composition = Object.freeze({
    mode: "legacy" as const,
    services,
    [conversationCompositionBrand]: true as const,
  });
  recognizedCompositions.add(composition);
  return composition;
}

export function createProtectedTestShadowConversationComposition(
  input: Readonly<{
    readonly authority: ProtectedTestShadowAuthority;
    readonly namespaceId: string;
    readonly legacyServices: ConversationExecutionServices;
    readonly protectedServices: ProtectedConversationExecutionServices;
  }>,
): ProtectedTestShadowConversationComposition {
  if (!recognizedTestAuthorities.has(input.authority)) {
    throw new TypeError(
      "Protected test shadow composition requires recognized test authority",
    );
  }
  assertPortableNamespaceId(input.namespaceId);
  if (input.legacyServices === input.protectedServices) {
    throw new TypeError(
      "Protected test shadow services must be distinct from legacy services",
    );
  }
  if (
    typeof input.protectedServices.protectedAgentMessagePreparer?.prepare
      !== "function"
  ) {
    throw new TypeError(
      "Protected test shadow services require an authorized Agent message preparer",
    );
  }
  if (
    typeof input.protectedServices.checkpointSavers?.createForInvocation
      !== "function"
  ) {
    throw new TypeError(
      "Protected test shadow services require an encrypted checkpoint saver provider",
    );
  }
  const composition = Object.freeze({
    mode: "protected_test_shadow" as const,
    namespaceId: input.namespaceId,
    legacyServices: input.legacyServices,
    protectedServices: input.protectedServices,
    [conversationCompositionBrand]: true as const,
  });
  recognizedCompositions.add(composition);
  return composition;
}

export function resolveConversationExecutionServices(input: Readonly<{
  readonly defaultLegacyServices: ConversationExecutionServices;
  readonly composition?: ConversationComposition;
  readonly origin: ConversationExecutionOrigin;
  readonly resolvedNamespaceId: string | null;
}>): ConversationExecutionSelection {
  const { composition } = input;
  if (composition === undefined) {
    return Object.freeze({
      mode: "legacy",
      reason: "default_legacy",
      services: input.defaultLegacyServices,
    });
  }
  if (!recognizedCompositions.has(composition)) {
    throw new TypeError("Expected a recognized conversation composition");
  }
  if (composition.mode === "legacy") {
    return Object.freeze({
      mode: "legacy",
      reason: "legacy_composition",
      services: composition.services,
    });
  }
  if (!isWave9ActiveOrigin(input.origin)) {
    return Object.freeze({
      mode: "legacy",
      reason: "protected_boundary_fallback",
      services: composition.legacyServices,
    });
  }
  if (input.resolvedNamespaceId !== composition.namespaceId) {
    return Object.freeze({
      mode: "legacy",
      reason: "protected_namespace_mismatch",
      services: composition.legacyServices,
    });
  }
  return Object.freeze({
    mode: "protected_test_shadow",
    reason: "protected_active",
    services: composition.protectedServices,
  });
}

/**
 * Internal test-harness mint. It is intentionally absent from
 * `@nautilo/runtime`'s public exports; only the adjacent testing module imports
 * it. The runtime registry makes a type assertion or deserialized object
 * insufficient to construct the protected composition.
 */
export function __mintProtectedTestShadowAuthorityForTesting(
): ProtectedTestShadowAuthority {
  const authority = Object.freeze({
    [protectedTestShadowAuthorityBrand]: true as const,
  });
  recognizedTestAuthorities.add(authority);
  return authority;
}

/** Internal constructor guard shared by dormant protected test services. */
export function __assertProtectedTestShadowAuthority(
  authority: ProtectedTestShadowAuthority,
): void {
  if (!recognizedTestAuthorities.has(authority)) {
    throw new TypeError(
      "Protected test shadow service requires recognized test authority",
    );
  }
}
