import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LiveMiniAppSessionRegistry } from "../apps/live-mini-app-session-registry";
import { resolveTrustedLiveMiniAppSession } from "./live-mini-app-session-context";

const LOCAL_SHA = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const roots: string[] = [];
async function appRoot(instructions?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trusted-live-context-"));
  roots.push(root);
  const dir = join(root, "writer");
  await mkdir(dir);
  await writeFile(join(dir, "app.json"), JSON.stringify({
    id: "nautilo-writer", name: "Writer", version: "1", entry: "./main.ts", html: "./index.html",
    fileAssociations: {}, capabilities: {}, liveReview: { enabled: true },
    ...(instructions ? { agent: { instructions } } : {}),
  }));
  await writeFile(join(dir, "main.ts"), "");
  await writeFile(join(dir, "index.html"), "");
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("resolveTrustedLiveMiniAppSession", () => {
  test("accepts only a matching registry capability and installed instructions", async () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue({
      targetKind: "artifact",
      appId: "nautilo-writer",
      userId: "u1",
      namespaceIds: ["n"],
      artifactId: "a",
      documentId: "d",
      documentVersion: { kind: "artifact_revision", revision: 4 },
    });
    expect(await resolveTrustedLiveMiniAppSession({
      raw: {
        sessionToken: issued.token,
        sessionId: issued.sessionId,
        documentVersion: { kind: "artifact_revision", revision: 4 },
      },
      userId: "u1", appsRoot: await appRoot("installed-only instruction"), registry,
    })).toEqual({
      appId: "nautilo-writer", sessionToken: issued.token, sessionId: issued.sessionId,
      documentVersion: { kind: "artifact_revision", revision: 4 },
      instructions: "installed-only instruction",
    });
  });

  test("accepts local_sha documentVersion union entries", async () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue({
      targetKind: "currentFile",
      appId: "nautilo-writer",
      userId: "u1",
      localTargetId: "local-target",
      relayId: "relay-1",
      canonicalPath: "/Users/alice/project/docs/report.html",
      currentFolderRoot: "/Users/alice/project",
      relativePath: "docs/report.html",
      documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
    });
    const trusted = await resolveTrustedLiveMiniAppSession({
      raw: {
        sessionToken: issued.token,
        sessionId: issued.sessionId,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
      },
      userId: "u1",
      appsRoot: await appRoot("local writer instruction"),
      registry,
    });
    expect(trusted).toEqual({
      appId: "nautilo-writer",
      sessionToken: issued.token,
      sessionId: issued.sessionId,
      documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
      instructions: "local writer instruction",
    });
    expect(JSON.stringify(trusted)).not.toContain("/Users/alice");
    expect(JSON.stringify(trusted)).not.toContain("relay-1");
    expect(JSON.stringify(trusted)).not.toContain("local-target");
  });

  test("rejects malformed, forged, foreign, stale, and mismatched capabilities", async () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue({
      targetKind: "artifact",
      appId: "nautilo-writer",
      userId: "u1",
      namespaceIds: ["n"],
      artifactId: "a",
      documentId: "d",
      documentVersion: { kind: "artifact_revision", revision: 4 },
    });
    const root = await appRoot("safe");
    for (const [raw, userId] of [
      [null, "u1"],
      [{ sessionToken: "forged".padEnd(32, "x"), sessionId: "x", documentVersion: { kind: "artifact_revision", revision: 4 } }, "u1"],
      [{ sessionToken: issued.token, sessionId: "wrong", documentVersion: { kind: "artifact_revision", revision: 4 } }, "u1"],
      [{ sessionToken: issued.token, sessionId: issued.sessionId, documentVersion: { kind: "artifact_revision", revision: 4 } }, "u2"],
      [{ sessionToken: issued.token, sessionId: issued.sessionId, documentVersion: { kind: "artifact_revision", revision: 5 } }, "u1"],
      [{ sessionToken: issued.token, sessionId: issued.sessionId, documentVersion: { kind: "local_sha", sha256: LOCAL_SHA } }, "u1"],
    ] as const) {
      expect(await resolveTrustedLiveMiniAppSession({ raw, userId, appsRoot: root, registry })).toBeNull();
    }
  });

  test("rejects unregistered manifests and manifests without instructions", async () => {
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue({
      targetKind: "artifact",
      appId: "nautilo-writer",
      userId: "u1",
      namespaceIds: ["n"],
      artifactId: "a",
      documentId: "d",
      documentVersion: { kind: "artifact_revision", revision: 4 },
    });
    const raw = {
      sessionToken: issued.token,
      sessionId: issued.sessionId,
      documentVersion: { kind: "artifact_revision", revision: 4 },
    };
    expect(await resolveTrustedLiveMiniAppSession({ raw, userId: "u1", appsRoot: await appRoot(), registry })).toBeNull();
    expect(await resolveTrustedLiveMiniAppSession({ raw, userId: "u1", appsRoot: await appRoot("safe"), registry: new LiveMiniAppSessionRegistry() })).toBeNull();
  });
});
