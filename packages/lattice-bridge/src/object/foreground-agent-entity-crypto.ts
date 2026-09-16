export type ForegroundAgentEntityCryptoOperation = "decrypt" | "encrypt";

export type ForegroundAgentEntityNamespaceAuthority = Readonly<{
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

export type ForegroundAgentEntityCryptoResult<Value> =
  | Readonly<{ status: "executed"; value: Value }>
  | Readonly<{
      status: "unavailable";
      reason: "authorization_unavailable" | "content_unavailable";
    }>;

export interface ForegroundAgentEntityCryptoInvocation {
  /** Aborts with the retained foreground authorization that owns this view. */
  readonly signal: AbortSignal;
  readonly use: <Value>(input: Readonly<{
    operations: readonly ForegroundAgentEntityCryptoOperation[];
    entity: Readonly<{
      namespaceId: string;
      keyGeneration: number;
      accessRevision: number;
    }>;
    execute(context: Readonly<{
      namespaceKey: Uint8Array;
      authority: ForegroundAgentEntityNamespaceAuthority;
    }>): Promise<Value> | Value;
  }>) => Promise<ForegroundAgentEntityCryptoResult<Value>>;

  readonly useCurrentSet: <Value>(input: Readonly<{
    operations: readonly ForegroundAgentEntityCryptoOperation[];
    namespaceIds: readonly string[];
    execute(items: readonly Readonly<{
      namespaceKey: Uint8Array;
      authority: ForegroundAgentEntityNamespaceAuthority;
    }>[]): Promise<Value> | Value;
  }>) => Promise<ForegroundAgentEntityCryptoResult<Value>>;
}
