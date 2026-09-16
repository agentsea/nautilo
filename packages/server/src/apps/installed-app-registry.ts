import { scanInstalledApps, type RegisteredMiniApp } from "./app-registry";

export type InstalledAppSnapshot = readonly RegisteredMiniApp[];

export interface InstalledAppRegistryDeps {
  scan?: (appsRoot: string) => Promise<RegisteredMiniApp[]>;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value);
}

function freezeSnapshot(apps: RegisteredMiniApp[]): InstalledAppSnapshot {
  return Object.freeze(
    apps.map((app) =>
      Object.freeze({
        ...app,
        ...(app.manifest ? { manifest: deepFreeze(structuredClone(app.manifest)) } : {}),
      }),
    ),
  ) as InstalledAppSnapshot;
}

/**
 * Server-owned installed-app registry. Caches scan results per appsRoot,
 * coalesces concurrent scans for the same generation, and returns immutable
 * snapshots safe for concurrent readers.
 */
export class InstalledAppRegistry {
  private readonly scanFn: (appsRoot: string) => Promise<RegisteredMiniApp[]>;
  private generation = 0;
  private cachedAppsRoot: string | null = null;
  private cachedSnapshot: InstalledAppSnapshot | null = null;
  private inFlight: Promise<InstalledAppSnapshot> | null = null;
  private inFlightAppsRoot: string | null = null;
  private inFlightGeneration: number | null = null;

  constructor(deps?: InstalledAppRegistryDeps) {
    this.scanFn = deps?.scan ?? scanInstalledApps;
  }

  /** Drop the cached snapshot so the next read performs a fresh scan. */
  invalidate(): void {
    this.generation += 1;
    this.cachedAppsRoot = null;
    this.cachedSnapshot = null;
  }

  /** Current cache generation; useful for concurrency tests. */
  getGeneration(): number {
    return this.generation;
  }

  async getSnapshot(appsRoot: string): Promise<InstalledAppSnapshot> {
    if (this.cachedSnapshot && this.cachedAppsRoot === appsRoot) {
      return this.cachedSnapshot;
    }

    if (
      this.inFlight &&
      this.inFlightAppsRoot === appsRoot &&
      this.inFlightGeneration === this.generation
    ) {
      return this.inFlight;
    }

    const scanGeneration = this.generation;
    const promise = this.scanFn(appsRoot)
      .then((apps) => {
        const snapshot = freezeSnapshot(apps);
        if (scanGeneration === this.generation) {
          this.cachedAppsRoot = appsRoot;
          this.cachedSnapshot = snapshot;
        }
        return snapshot;
      })
      .finally(() => {
        if (this.inFlight === promise) {
          this.inFlight = null;
          this.inFlightAppsRoot = null;
          this.inFlightGeneration = null;
        }
      });

    this.inFlight = promise;
    this.inFlightAppsRoot = appsRoot;
    this.inFlightGeneration = scanGeneration;
    return promise;
  }
}

/** Process-wide installed-app registry shared by HTTP routes and authoring mutations. */
export const installedAppRegistry = new InstalledAppRegistry();

/** Drop cached snapshots after any authoritative appsRoot filesystem mutation. */
export function invalidateInstalledAppRegistry(): void {
  installedAppRegistry.invalidate();
}

export function resetInstalledAppRegistryForTests(): void {
  installedAppRegistry.invalidate();
}
