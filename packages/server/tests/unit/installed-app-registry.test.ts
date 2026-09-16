import { describe, expect, test } from "bun:test";
import type { RegisteredMiniApp } from "../../src/apps/app-registry";
import { InstalledAppRegistry } from "../../src/apps/installed-app-registry";

function sampleApp(id: string): RegisteredMiniApp {
  return {
    id,
    root: `/apps/${id}`,
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      entry: "./main.ts",
      html: "./index.html",
      styles: ["./styles.css"],
      fileAssociations: {},
      capabilities: {},
    },
    status: "ready",
    sourceHash: "abc123",
    installedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
  };
}

describe("InstalledAppRegistry", () => {
  test("coalesces concurrent scans for the same generation", async () => {
    let scanCount = 0;
    const registry = new InstalledAppRegistry({
      scan: async () => {
        scanCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [sampleApp("alpha")];
      },
    });

    const [a, b, c] = await Promise.all([
      registry.getSnapshot("/apps"),
      registry.getSnapshot("/apps"),
      registry.getSnapshot("/apps"),
    ]);

    expect(scanCount).toBe(1);
    expect(a).toHaveLength(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test("reuses cached snapshot until invalidated", async () => {
    let scanCount = 0;
    const registry = new InstalledAppRegistry({
      scan: async () => {
        scanCount += 1;
        return [sampleApp(`app-${scanCount}`)];
      },
    });

    const first = await registry.getSnapshot("/apps");
    const second = await registry.getSnapshot("/apps");
    expect(scanCount).toBe(1);
    expect(first[0]?.id).toBe("app-1");
    expect(second).toBe(first);

    registry.invalidate();
    const third = await registry.getSnapshot("/apps");
    expect(scanCount).toBe(2);
    expect(third[0]?.id).toBe("app-2");
    expect(third).not.toBe(first);
  });

  test("returns immutable snapshots that do not mutate the cache", async () => {
    const registry = new InstalledAppRegistry({
      scan: async () => [sampleApp("alpha")],
    });

    const snapshot = await registry.getSnapshot("/apps");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);

    const cachedAgain = await registry.getSnapshot("/apps");
    expect(() => {
      (snapshot[0] as { enabled: boolean }).enabled = false;
    }).toThrow();
    expect(cachedAgain[0]?.enabled).toBe(true);
  });

  test("deep-freezes manifests without rescanning", async () => {
    let scanCount = 0;
    const registry = new InstalledAppRegistry({
      scan: async () => {
        scanCount += 1;
        return [sampleApp("alpha")];
      },
    });

    const first = await registry.getSnapshot("/apps");
    const manifest = first[0]?.manifest;
    expect(manifest).not.toBeNull();
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest?.styles)).toBe(true);

    expect(() => {
      manifest!.styles!.push("./poisoned.css");
    }).toThrow();

    const later = await registry.getSnapshot("/apps");
    expect(scanCount).toBe(1);
    expect(later).toBe(first);
    expect(later[0]?.manifest?.styles).toEqual(["./styles.css"]);
  });

  test("does not apply stale in-flight scan results after invalidation", async () => {
    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let scanCount = 0;

    const registry = new InstalledAppRegistry({
      scan: async () => {
        scanCount += 1;
        await scanGate;
        return [sampleApp(`gen-${scanCount}`)];
      },
    });

    const inFlight = registry.getSnapshot("/apps");
    registry.invalidate();
    releaseScan?.();

    const staleResult = await inFlight;
    expect(staleResult[0]?.id).toBe("gen-1");

    const fresh = await registry.getSnapshot("/apps");
    expect(scanCount).toBe(2);
    expect(fresh[0]?.id).toBe("gen-2");
  });
});
