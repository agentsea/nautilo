import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const preload = readFileSync(
  join(desktopRoot, "electron/preload.ts"),
  "utf8",
);
const workbenchDesktop = readFileSync(
  join(desktopRoot, "../workbench/src/lib/desktop.ts"),
  "utf8",
);

describe("M300 foreground Shadow preload contract", () => {
  test("exposes only the bounded data operations on exact IPC channels", () => {
    const start = preload.indexOf("const foregroundShadowAPI = {");
    const end = preload.indexOf("\n};", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const surface = preload.slice(start, end);

    for (const channel of [
      "foregroundShadow:inspect",
      "foregroundShadow:send",
      "foregroundShadow:edit",
      "foregroundShadow:recoverPending",
      "foregroundShadow:recoverRoomPendingAttention",
      "foregroundShadow:authorize",
      "foregroundShadow:receive",
      "foregroundShadow:synchronizeRecipients",
      "foregroundShadow:serviceDomainKeyBacklog",
      "foregroundShadow:backgroundAuthorization:service",
      "foregroundShadow:messageBackfill:service",
      "foregroundShadow:messageBackfill:cancel",
      "foregroundShadow:protectedRoomAccess",
      "foregroundShadow:history:reconcile",
    ]) expect(surface).toContain(`"${channel}"`);

    expect(surface).not.toContain("profileBytes");
    expect(surface).not.toContain("generationKey");
    expect(surface).not.toContain("grantBytes");
    expect(surface).not.toContain("recoveryWords");
    expect(surface).not.toContain("StoredSessionMessageDto");
    expect(surface).not.toContain("encrypt(");
    expect(surface).not.toContain("decrypt(");
    expect(surface).not.toContain("claimId");
    expect(surface).not.toContain("payloadBytes");
    expect(surface).toContain("MessageBackfillBatchResult");
    expect(surface).toContain("ProtectedRoomAccessStateV2");
  });

  test("keeps receive topology discriminated and public types browser-safe", () => {
    for (const kind of [
      "standard",
      "human_peer",
      "shared_agent",
      "shared_agent_output",
    ]) {
      expect(preload).toContain(`kind: "${kind}"`);
      expect(workbenchDesktop).toContain(`kind: "${kind}"`);
    }
    expect(workbenchDesktop).toContain(
      "foregroundShadow?: DesktopForegroundShadowAPI",
    );
    expect(workbenchDesktop).not.toContain(
      "@nautilo/lattice-bridge/client/electron",
    );
    expect(workbenchDesktop).toContain(
      "readerInput: VaultRoomHistoryShadowReadInputV1",
    );
    expect(workbenchDesktop).not.toContain(
      "DesktopForegroundShadowStoredMessage",
    );
  });
});
