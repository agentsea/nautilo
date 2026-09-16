import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type {
  ForegroundAgentEntityCryptoInvocation,
  ForegroundAgentEntityNamespaceAuthority,
  ProtectedAgentMemoryProjectionReference,
} from "@nautilo/lattice-bridge";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";

const DOMAIN = "nautilo/foreground-memory-projection/v1";

/** Encrypted checkpoint payload, not a second store or a reusable capability.
 * The Namespace gateway owns all key access and revocation checks. */
export function createForegroundMemoryProjectionCapsule(input: Readonly<{
  crypto: LatticeCrypto;
  entities: Pick<ForegroundAgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet">;
  namespaceId: string;
  envelope: NamespaceMemoryEnvelope;
  policyRevision: number;
  agentAuthorizationRevision: number;
}>) {
  const aad = (reference: ProtectedAgentMemoryProjectionReference,
    authority: ForegroundAgentEntityNamespaceAuthority) => new TextEncoder().encode(JSON.stringify([
    DOMAIN, reference.referenceVersion, reference.referenceId, reference.toolCallId,
    reference.requesterUserId, reference.requesterActorId, reference.agentId,
    reference.createdAt, reference.expiresAt,
    input.envelope.ownerId, input.envelope.actorId, input.envelope.agentId,
    input.envelope.roomId, [...input.envelope.readableNamespaces].sort(),
    [...input.envelope.mutableNamespaces].sort(), [...input.envelope.writableNamespaces].sort(),
    input.policyRevision, input.agentAuthorizationRevision,
    authority.namespaceId, authority.namespaceKeyGeneration, authority.namespaceAccessRevision,
    authority.domainId, authority.domainKeyGeneration, authority.domainAuthorizationRevision,
    Array.from(authority.namespaceHeadDigest), Array.from(authority.namespaceAudienceFingerprint),
  ]));
  const active = () => {
    if (input.entities.signal.aborted) throw new Error("Projection custody unavailable");
  };
  return {
    async seal(reference: ProtectedAgentMemoryProjectionReference, value: unknown): Promise<string> {
      active();
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      try {
        const result = await input.entities.useCurrentSet({
          operations: ["encrypt"], namespaceIds: [input.namespaceId],
          execute: (items) => {
            const item = items[0];
            if (items.length !== 1 || item?.authority.namespaceId !== input.namespaceId) {
              throw new Error("Projection custody unavailable");
            }
            const key = input.crypto.deriveKey(item.namespaceKey, DOMAIN, 32);
            const binding = aad(reference, item.authority);
            try {
              const ciphertext = input.crypto.aeadSeal(key, bytes, binding);
              try {
                active();
                return JSON.stringify({ version: 1,
                  keyGeneration: item.authority.namespaceKeyGeneration,
                  accessRevision: item.authority.namespaceAccessRevision,
                  ciphertext: Buffer.from(ciphertext).toString("base64"),
                });
              } finally { ciphertext.fill(0); }
            } finally { key.fill(0); binding.fill(0); }
          },
        });
        active();
        if (result.status !== "executed") throw new Error("Projection custody unavailable");
        return result.value;
      } finally { bytes.fill(0); }
    },
    async open(reference: ProtectedAgentMemoryProjectionReference): Promise<unknown> {
      try {
        active();
        if (typeof reference.sealedPreparation !== "string") return null;
        const parsed: unknown = JSON.parse(reference.sealedPreparation);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const cell = parsed as Record<string, unknown>;
        if (Object.keys(cell).sort().join(",") !== "accessRevision,ciphertext,keyGeneration,version"
          || cell["version"] !== 1 || typeof cell["keyGeneration"] !== "number"
          || !Number.isSafeInteger(cell["keyGeneration"]) || cell["keyGeneration"] < 0
          || typeof cell["accessRevision"] !== "number"
          || !Number.isSafeInteger(cell["accessRevision"]) || cell["accessRevision"] < 0
          || typeof cell["ciphertext"] !== "string") return null;
        const ciphertext = Buffer.from(cell["ciphertext"], "base64");
        try {
          if (ciphertext.toString("base64") !== cell["ciphertext"]) return null;
          const result = await input.entities.use({
            operations: ["decrypt"], entity: { namespaceId: input.namespaceId,
              keyGeneration: cell["keyGeneration"], accessRevision: cell["accessRevision"] },
            execute: ({ namespaceKey, authority }) => {
              if (authority.namespaceId !== input.namespaceId
                || authority.namespaceKeyGeneration !== cell["keyGeneration"]
                || authority.namespaceAccessRevision !== cell["accessRevision"]) return null;
              const key = input.crypto.deriveKey(namespaceKey, DOMAIN, 32);
              const binding = aad(reference, authority);
              try {
                const plaintext = input.crypto.aeadOpen(key, ciphertext, binding);
                if (plaintext === null) return null;
                try {
                  active();
                  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
                } finally { plaintext.fill(0); }
              } finally { key.fill(0); binding.fill(0); }
            },
          });
          active();
          return result.status === "executed" ? result.value : null;
        } finally { ciphertext.fill(0); }
      } catch { return null; }
    },
  };
}
