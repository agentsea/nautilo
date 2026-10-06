export type AgentEntityCryptoOperation = "decrypt" | "encrypt";

export type AgentEntityNamespaceAuthority = Readonly<{
  namespaceId: string;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  domainId: string;
  domainKeyGeneration: number;
  domainAuthorizationRevision: number;
  domainHeadDigest: Uint8Array;
  namespaceHeadDigest: Uint8Array;
  namespacePublicationDigest: Uint8Array;
  namespacePublicationSetDigest: Uint8Array;
  namespaceAudienceFingerprint: Uint8Array;
}>;

export type AgentEntityCryptoResult<Value> =
  | Readonly<{ status: "executed"; value: Value }>
  | Readonly<{
      status: "unavailable";
      reason: "authorization_unavailable" | "content_unavailable";
    }>;

export interface AgentEntityCryptoInvocation {
  /** Aborts with the invocation authorization that owns this view. */
  readonly signal: AbortSignal;
  readonly use: <Value>(input: Readonly<{
    operations: readonly AgentEntityCryptoOperation[];
    entity: Readonly<{
      namespaceId: string;
      keyGeneration: number;
      accessRevision: number;
    }>;
    execute(context: Readonly<{
      namespaceKey: Uint8Array;
      authority: AgentEntityNamespaceAuthority;
    }>): Promise<Value> | Value;
  }>) => Promise<AgentEntityCryptoResult<Value>>;

  readonly useCurrentSet: <Value>(input: Readonly<{
    operations: readonly AgentEntityCryptoOperation[];
    namespaceIds: readonly string[];
    execute(items: readonly Readonly<{
      namespaceKey: Uint8Array;
      authority: AgentEntityNamespaceAuthority;
    }>[]): Promise<Value> | Value;
  }>) => Promise<AgentEntityCryptoResult<Value>>;
}
