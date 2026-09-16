import type { DocumentCommitPlan, DocumentIdentity } from "@nautilo/types";

interface LockState {
  locked: boolean;
  readonly waiters: Array<() => void>;
}

export interface DocumentLockLease {
  /** Sorted and deduplicated keys held by this lease. */
  readonly keys: readonly string[];
  /** Idempotent. Releases held locks in reverse acquisition order. */
  release(): void | Promise<void>;
}

/**
 * Injectable lock boundary. Server adapters can supply transaction-scoped
 * database/advisory locks; Desktop can use a relay-local implementation.
 */
export interface DocumentLockManager {
  acquire(requestedKeys: readonly string[]): Promise<DocumentLockLease>;
}

export function deriveDocumentIdentityLockKeys(
  identity: DocumentIdentity,
): readonly string[] {
  return identity.kind === "workspace_artifact"
    ? [
        `workspace:artifact:${identity.artifactId}`,
        `workspace:path:${identity.logicalPath}`,
      ]
    : [`local:${identity.relayId}:path:${identity.canonicalPath}`];
}

export function deriveDocumentLockKeys(plan: DocumentCommitPlan): readonly string[] {
  const keys = new Set<string>();
  const addIdentity = (identity: DocumentIdentity) => {
    for (const key of deriveDocumentIdentityLockKeys(identity)) keys.add(key);
  };
  for (const entry of plan.entries) {
    switch (entry.kind) {
      case "create":
        addIdentity(entry.after.identity);
        break;
      case "update":
        addIdentity(entry.before.identity);
        break;
      case "move":
        addIdentity(entry.source.identity);
        addIdentity(entry.after.identity);
        if (entry.destinationBefore !== undefined) {
          addIdentity(entry.destinationBefore.identity);
        }
        break;
      case "delete":
        addIdentity(entry.before.identity);
        break;
    }
  }
  // Preconditions are read-only CAS inputs, but must share the same lock
  // domain as mutations so their exact snapshot remains valid through publish.
  for (const precondition of plan.preconditions ?? []) {
    addIdentity(precondition.identity);
  }
  return [...keys].sort();
}

/**
 * Browser-safe, process-local lock manager.
 *
 * Multi-document acquisitions sort and deduplicate keys before waiting, which
 * prevents lock-order cycles among users of this manager.
 *
 * Production adapters may instead hold a session-scoped database/advisory
 * lease for this entire lifetime; the backend need not share that session as
 * long as every coordinator writer honors the same global lock keys.
 */
export class InMemoryDocumentLockManager implements DocumentLockManager {
  readonly #states = new Map<string, LockState>();

  async acquire(requestedKeys: readonly string[]): Promise<DocumentLockLease> {
    const keys = [...new Set(requestedKeys)].sort();
    const releases: Array<() => void> = [];

    for (const key of keys) {
      releases.push(await this.#acquireOne(key));
    }

    let released = false;
    return {
      keys,
      release: () => {
        if (released) return;
        released = true;
        for (let index = releases.length - 1; index >= 0; index -= 1) {
          releases[index]!();
        }
      },
    };
  }

  async #acquireOne(key: string): Promise<() => void> {
    let state = this.#states.get(key);
    if (state === undefined) {
      state = { locked: false, waiters: [] };
      this.#states.set(key, state);
    }

    if (state.locked) {
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    } else {
      state.locked = true;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next !== undefined) {
        next();
      } else {
        state.locked = false;
        this.#states.delete(key);
      }
    };
  }
}
