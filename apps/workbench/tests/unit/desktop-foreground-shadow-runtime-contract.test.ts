import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runtime = readFileSync(
  join(import.meta.dir, "../../src/adapters/nautilo-runtime.tsx"),
  "utf8",
);

describe("M300 Desktop foreground Shadow runtime selection", () => {
  test("replaces the Browser-only exclusions with the complete Desktop port", () => {
    expect(runtime).not.toContain("if (isDesktop || typeof window");
    expect(runtime).toContain("desktopForegroundShadow.send(roomId, body)");
    expect(runtime).toContain("desktopForegroundShadow.recoverPending()");
    expect(runtime).toContain("desktopForegroundShadow.authorize(event)");
    expect(runtime).toContain("desktopForegroundShadow.synchronizeRecipients(roomId, namespaceId)");
    for (const kind of [
      "standard",
      "human_peer",
      "shared_agent",
      "shared_agent_output",
    ]) expect(runtime).toContain(`kind: "${kind}"`);
  });

  test("keeps Browser local composition and delegates Desktop history to main", () => {
    expect(runtime).toContain("createBrowserLiveShadowMessageClient({");
    expect(runtime).toContain("createBrowserRoomHistoryShadowMessageReader({");
    expect(runtime).toContain("desktopHistory.reconcile({ readerInput, acknowledgement })");
    expect(runtime).toContain("let readerDeviceId: string");
    expect(runtime).not.toContain("@nautilo/lattice-bridge/client/electron");
  });

  test("constructs Task repair custody only for Shadow mode", () => {
    const start = runtime.indexOf("const taskContentBackfill = useMemo(() => {");
    const end = runtime.indexOf("const localExecutionHistoryScopeRef", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const composition = runtime.slice(start, end);
    const modeGate = composition.indexOf(
      'shadowPolicyMode !== "shadow_encryption"',
    );
    const desktopFactory = composition.indexOf(
      "createDesktopTaskContentBackfillSchedulerClient({",
    );
    const browserCustody = composition.indexOf(
      "readOrCreateBrowserCryptoInstallationId({",
    );
    const browserFactory = composition.indexOf(
      "createBrowserTaskContentBackfillClient({",
    );

    expect(modeGate).toBeGreaterThanOrEqual(0);
    expect(desktopFactory).toBeGreaterThan(modeGate);
    expect(browserCustody).toBeGreaterThan(modeGate);
    expect(browserFactory).toBeGreaterThan(browserCustody);
    expect(composition.slice(composition.lastIndexOf("}, [")))
      .toContain("shadowPolicyMode");
  });
});
