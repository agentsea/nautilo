import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("D458 app remote-host presence composition", () => {
  test("one owner-scoped stream is shared by REST, WS, registry, and relay revoke", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const source = await Bun.file(
      join(repoRoot, "packages/server/src/app.ts"),
    ).text();

    expect(source.match(/new RemoteHostPresenceStream\(/g)).toHaveLength(1);
    expect(source).toContain(
      "publishToUser: publishRemoteHostPresenceFrame",
    );
    expect(source).toContain(
      "await remoteHostPresenceStream.authoritativeSnapshotForUser(userId)",
    );
    expect(source).toContain("onRemoteHostMutation: async (userId)");
    expect(source).toContain(
      "onRemoteHostRevoked: async ({ userId, remoteHostId })",
    );
    expect(source).toContain("remoteHostPresenceStream.revokeRemoteHost({");
    expect(source).toContain("remoteHostPresenceStream,");
    expect(source).toContain(
      "remoteHostPresenceStream.invalidatePairingGenerations(input)",
    );
    expect(source).toContain(
      "remoteHostPresenceStream.reconcileUser(userId)",
    );
    expect(source).toContain(
      "if (input.previous !== null) affectedUserIds.add(input.previous.userId)",
    );
    expect(source).toContain(
      "if (input.current !== null) affectedUserIds.add(input.current.userId)",
    );
  });

  test("the stream is assigned before the relay registry becomes externally reachable", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const source = await Bun.file(
      join(repoRoot, "packages/server/src/app.ts"),
    ).text();

    // The separate DB-less harness has no production presence stream. Check
    // the production composition's registry, not the earlier isolated helper.
    const productionStart = source.indexOf("export async function createApp");
    expect(productionStart).toBeGreaterThan(-1);
    const productionSource = source.slice(productionStart);
    const streamAssignment = productionSource.indexOf(
      "remoteHostPresenceStream = new RemoteHostPresenceStream",
    );
    const registryStart = productionSource.indexOf("relayRegistry.start()");
    const registryPublish = productionSource.indexOf("setRelayRegistry(relayRegistry)");

    expect(streamAssignment).toBeGreaterThan(-1);
    expect(registryStart).toBeGreaterThan(streamAssignment);
    expect(registryPublish).toBeGreaterThan(streamAssignment);
  });
});
