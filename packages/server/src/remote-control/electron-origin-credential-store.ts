import { createHash, randomBytes } from "node:crypto";
import type { VerifiedLocalElectronOrigin } from "@nautilo/types";

const TOKEN_PREFIX = "deo_";
const TOKEN_BYTES = 24;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 2_000;

export interface ElectronOriginCredentialBinding {
  readonly requestId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly pairingGeneration: string;
  readonly method: string;
  readonly path: string;
  readonly bodySha256: string;
}

interface StoredCredential extends ElectronOriginCredentialBinding {
  readonly expiresAtMs: number;
}

export interface ElectronOriginCredentialStore {
  issue(binding: ElectronOriginCredentialBinding): { token: string; expiresAt: Date };
  consume(input: {
    readonly token: string;
    readonly userId: string;
    readonly actorId: string;
    readonly method: string;
    readonly path: string;
    readonly bodySha256: string;
    readonly now: Date;
    readonly isCurrentRelaySession: (binding: ElectronOriginCredentialBinding) => boolean;
  }): VerifiedLocalElectronOrigin | null;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Process-local one-use admissions are intentional. Server restart drops all
 * outstanding credentials, and every consume revalidates the exact live Relay
 * session. Only hashes are retained; plaintext crosses Electron main once.
 */
export function createElectronOriginCredentialStore(options: {
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly randomToken?: () => string;
} = {}): ElectronOriginCredentialStore {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const randomToken = options.randomToken ?? (() => randomBytes(TOKEN_BYTES).toString("base64url"));
  const entries = new Map<string, StoredCredential>();

  const cleanup = (atMs: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= atMs) entries.delete(key);
    }
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    issue(binding) {
      const issuedAt = now();
      cleanup(issuedAt.getTime());
      const token = `${TOKEN_PREFIX}${randomToken()}`;
      const expiresAt = new Date(issuedAt.getTime() + ttlMs);
      entries.set(digest(token), { ...binding, expiresAtMs: expiresAt.getTime() });
      return { token, expiresAt };
    },

    consume(input) {
      if (!input.token.startsWith(TOKEN_PREFIX) || input.token.length > 128) return null;
      const key = digest(input.token);
      const stored = entries.get(key);
      // Claim before every comparison/revalidation: a malformed, raced, or
      // stale use burns the credential and can never be retried elsewhere.
      entries.delete(key);
      if (
        !stored ||
        stored.expiresAtMs <= input.now.getTime() ||
        stored.userId !== input.userId ||
        stored.actorId !== input.actorId ||
        stored.method !== input.method ||
        stored.path !== input.path ||
        stored.bodySha256 !== input.bodySha256 ||
        !input.isCurrentRelaySession(stored)
      ) return null;
      return {
        kind: "local_electron",
        userId: stored.userId,
        actorId: stored.actorId,
        relayId: stored.relayId,
        desktopSessionId: stored.desktopSessionId,
        pairingGeneration: stored.pairingGeneration,
        requestId: stored.requestId,
      };
    },
  };
}

let defaultStore = createElectronOriginCredentialStore();

export function getElectronOriginCredentialStore(): ElectronOriginCredentialStore {
  return defaultStore;
}

export function resetElectronOriginCredentialStoreForTests(): void {
  defaultStore = createElectronOriginCredentialStore();
}
