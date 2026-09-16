import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const packageRoot = resolve(import.meta.dir, "../..");

function source(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf8");
}

describe("M306 native V2 production authority", () => {
  test("physically removes retired authority implementations and schema", () => {
    for (const relativePath of [
      "src/delivery/client-namespace-bootstrap.ts",
      "src/server/delivery/postgres-namespace-bootstrap-repository.ts",
      "src/server/delivery/postgres-namespace-key-authority.ts",
      "src/server/delivery/postgres-grant-domain-authority.ts",
      "src/server/message/postgres-live-shadow-authority.ts",
      "../server/src/routes/device-wrapped-namespace-authority.ts",
      "../server/src/routes/grant-domain-authority.ts",
      "../db/src/schema/namespace-key-authority.ts",
      "../db/src/schema/device-wrapped-grant-domain-authority.ts",
    ]) {
      expect(existsSync(resolve(packageRoot, relativePath)), relativePath)
        .toBeFalse();
    }
  });

  test("keeps retired routes, client methods, and tables out of production", () => {
    const production = [
      "../server/src/app.ts",
      "../server/src/routes/live-shadow-message.ts",
      "../api-client/src/client.ts",
      "../api-client/src/browser.ts",
      "../api-client/src/index.ts",
      "../db/src/schema/index.ts",
    ].map(source).join("\n");
    for (const rejected of [
      "/live-shadow/namespace-authority/",
      "/live-shadow/grant-domain/",
      "/live-shadow/namespace/:operationId/",
      "planLiveShadowPrivateRoomNamespace",
      "stageLiveShadowPrivateRoomNamespace",
      "createDeviceWrappedNamespaceAuthorityClient",
      "createDeviceWrappedGrantDomainAuthorityClient",
      "namespaceKeyGenerationHeads",
      "grantDomainHeads",
    ]) expect(production).not.toContain(rejected);
  });

  test("keeps foreground clients free of M282, M290, and M291 bootstraps", () => {
    const foreground = source(
      "src/client/message/foreground-shadow-client-composition.ts",
    );
    const namespace = source(
      "src/client/message/domain-namespace-authority-client.ts",
    );
    for (const rejected of [
      "createPrivateRoomLiveShadowNamespaceReadiness",
      "createDeviceWrappedNamespaceAuthorityClient",
      "createDeviceWrappedGrantDomainAuthorityClient",
      "ensureNamespaceReady",
      "legacyBootstrap",
    ]) {
      expect(`${foreground}\n${namespace}`).not.toContain(rejected);
    }
  });

  test("keeps Human-only planning and Room history on the V2 repository", () => {
    const production = [
      "src/server/message/postgres-human-peer-live-shadow-plan.ts",
      "src/server/message/postgres-room-history-shadow-projection.ts",
      "../server/src/routes/live-shadow-message-composition.ts",
    ].map(source).join("\n");
    expect(production).toContain("PostgresDomainKeyAuthorityRepository");
    expect(production).not.toContain("PostgresGrantDomainAuthorityRepository");
    expect(production).not.toContain("PostgresNamespaceKeyAuthorityRepository");
  });

  test("commits Agent output against native V2 authority", () => {
    const storage = source(
      "src/server/storage/postgres-lattice-storage.ts",
    );
    const start = storage.indexOf(
      'authorization.kind\n            === "device-wrapped-live-shadow-agent-genesis"',
    );
    const end = storage.indexOf(
      '} else if (authorization.kind === "human-v5-genesis")',
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const deviceWrappedCommit = storage.slice(start, end);
    expect(deviceWrappedCommit).toContain("namespaceDomainKeyHeads");
    expect(deviceWrappedCommit).toContain("namespaceDomainKeyBindings");
    expect(deviceWrappedCommit).not.toContain("namespace_key_generation_heads");
    expect(deviceWrappedCommit).not.toContain(
      "namespace_key_publication_operations",
    );
  });

  test("rejects the retired provider-root live-turn authorization variant", () => {
    const production = [
      "src/message/conversation-prepared-revision.ts",
      "src/server/storage/postgres-conversation-crypto-completion.ts",
      "src/server/storage/postgres-lattice-storage.ts",
      "../lattice-crypto/src/index.ts",
      "../lattice-crypto/src/object/authorized-write.ts",
      "../lattice-crypto/src/object/agent-storage-coordinator.ts",
      "../lattice-crypto/src/storage/in-memory-v2-store.ts",
      "../lattice-crypto/src/storage/v2-record-policy.ts",
    ].map(source).join("\n");
    expect(production).not.toContain('"live-shadow-agent-genesis"');
    expect(production).not.toContain(
      "prepareLiveShadowAgentObjectAccessManifestGenesis",
    );
    expect(production).toContain(
      '"device-wrapped-live-shadow-agent-genesis"',
    );
  });
});
