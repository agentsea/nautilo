import type {
  VerifiedAgentMemoryCryptoRevisionContent,
} from "./agent-memory-session-content.ts";
import type { AgentMemoryEmbedding } from "./active-memory-composition.ts";

export type ProtectedAgentBackgroundProductAuthority = Readonly<{
  readonly subjectUserId: string;
  readonly agentId: string;
}>;

export type ProtectedAgentBackgroundMemoryProductAuthority =
  | Readonly<{ readonly mode: "namespace" }>
  | Readonly<{
    readonly mode: "scope";
    readonly scopeId: string;
    readonly originWritableNamespaceId: string;
  }>;

export type ProtectedAgentBackgroundMemoryRevisionReference =
  ProtectedAgentBackgroundProductAuthority & Readonly<{
    readonly memoryId: string;
    readonly contentRevision: number;
    readonly cryptoAccessRevision: number;
    readonly accessKind: "namespace" | "scope_seed" | "scope_origin";
    readonly productAuthority: ProtectedAgentBackgroundMemoryProductAuthority;
    readonly objectId: string;
    readonly selectedNamespaceId: string;
  }>;

export type VerifiedAgentBackgroundMemoryRevisionContent =
  VerifiedAgentMemoryCryptoRevisionContent & Readonly<{
    cryptoAccessRevision: number;
    importance: number;
    tier: 1 | 2 | 3;
    createdAt: number;
    embedding: AgentMemoryEmbedding;
  }>;

/**
 * Product-authenticated Memory read. The implementation resolves the complete
 * M:N authority set itself; callers provide only the descriptor-selected
 * Namespace through which the object will be opened.
 */
export interface ProtectedAgentBackgroundMemoryRevisionReader {
  read(
    reference: ProtectedAgentBackgroundMemoryRevisionReference,
  ): Promise<VerifiedAgentBackgroundMemoryRevisionContent | null>;
}

export type ProtectedAgentBackgroundMessageRevisionReference =
  ProtectedAgentBackgroundProductAuthority & Readonly<{
    readonly productId: string;
    readonly productRevision: number;
    readonly objectId: string;
    readonly selectedNamespaceId: string;
  }>;

export type VerifiedAgentBackgroundMessageRevisionContent = Readonly<{
  readonly productId: string;
  readonly productRevision: number;
  readonly objectId: string;
  readonly namespaceId: string;
  readonly role: "user" | "assistant" | "tool" | "system";
  /** Ownership transfers to the caller, which must wipe both arrays. */
  readonly payloadBytes: Uint8Array;
  readonly namespaceEnvelopeBytes: Uint8Array;
}>;

export interface ProtectedAgentBackgroundMessageRevisionReader {
  read(
    reference: ProtectedAgentBackgroundMessageRevisionReference,
  ): Promise<VerifiedAgentBackgroundMessageRevisionContent | null>;
}
