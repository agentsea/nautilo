export interface BrowserStorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserStorageScope {
  readonly origin: string;
  readonly humanId: string | null;
}

export interface BrowserStorageSnapshot<T> {
  readonly value: T | null;
  readonly revision: number;
}

interface StoredEnvelope<T> {
  readonly v: 1;
  readonly revision: number;
  readonly origin: string;
  readonly humanId: string | null;
  readonly value: T;
}

const mutationTails = new Map<string, Promise<void>>();

function normalizeOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function segment(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

function storageKey(namespace: string, scope: BrowserStorageScope): string {
  const human = scope.humanId === null ? "origin" : `human.${segment(scope.humanId)}`;
  return `nautilo.web.v1.${segment(namespace)}.${segment(scope.origin)}.${human}`;
}

function enqueue<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
  const prior = mutationTails.get(key) ?? Promise.resolve();
  const result = prior.catch(() => {}).then(operation);
  const tail = result.then(() => {}, () => {});
  mutationTails.set(key, tail);
  void tail.finally(() => {
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  });
  return result;
}

export interface BrowserScopedStore<T> {
  read(): Promise<BrowserStorageSnapshot<T>>;
  replace(value: T, expectedRevision?: number): Promise<boolean>;
  clear(expectedRevision?: number): Promise<boolean>;
}

/**
 * Origin- and Human-bound ordinary browser storage. It is not credential,
 * Keychain, device-identity, or protected-file custody. Blocked/corrupt
 * storage fails closed to an empty snapshot and is cleaned up best effort.
 */
export function createBrowserScopedStore<T>(input: {
  readonly namespace: string;
  readonly scope: BrowserStorageScope;
  readonly storage: BrowserStorageArea | null;
  readonly validate: (value: unknown) => value is T;
}): BrowserScopedStore<T> {
  const origin = normalizeOrigin(input.scope.origin);
  if (!origin || !input.namespace.trim() || (input.scope.humanId !== null && !input.scope.humanId.trim())) {
    throw new Error("Browser storage requires an exact HTTP(S) origin, namespace, and optional Human id.");
  }
  const scope = { origin, humanId: input.scope.humanId } as const;
  const key = storageKey(input.namespace, scope);

  const readNow = (): BrowserStorageSnapshot<T> => {
    if (!input.storage) return { value: null, revision: 0 };
    let raw: string | null;
    try {
      raw = input.storage.getItem(key);
    } catch {
      return { value: null, revision: 0 };
    }
    if (!raw) return { value: null, revision: 0 };
    try {
      const parsed = JSON.parse(raw) as Partial<StoredEnvelope<unknown>>;
      if (
        parsed.v !== 1
        || !Number.isSafeInteger(parsed.revision)
        || (parsed.revision ?? 0) < 1
        || parsed.origin !== scope.origin
        || parsed.humanId !== scope.humanId
        || !input.validate(parsed.value)
      ) throw new Error("invalid browser storage envelope");
      return { value: parsed.value, revision: parsed.revision! };
    } catch {
      try { input.storage.removeItem(key); } catch { /* blocked storage stays fail-closed */ }
      return { value: null, revision: 0 };
    }
  };

  return {
    async read() {
      await mutationTails.get(key)?.catch(() => {});
      return readNow();
    },
    replace(value, expectedRevision) {
      return enqueue(key, () => {
        if (!input.storage || !input.validate(value)) return false;
        const current = readNow();
        if (expectedRevision !== undefined && current.revision !== expectedRevision) return false;
        const revision = current.revision + 1;
        const envelope: StoredEnvelope<T> = { v: 1, revision, ...scope, value };
        try {
          input.storage.setItem(key, JSON.stringify(envelope));
        } catch {
          return false;
        }
        const committed = readNow();
        return committed.revision === revision;
      });
    },
    clear(expectedRevision) {
      return enqueue(key, () => {
        if (!input.storage) return false;
        const current = readNow();
        if (expectedRevision !== undefined && current.revision !== expectedRevision) return false;
        try {
          input.storage.removeItem(key);
          return readNow().value === null;
        } catch {
          return false;
        }
      });
    },
  };
}

export function browserLocalStorage(): BrowserStorageArea | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const probe = "__nautilo_web_storage_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}
