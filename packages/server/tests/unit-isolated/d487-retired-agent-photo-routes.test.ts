import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";

import { profileAvatarRoutes } from "../../src/routes/profile-avatar";
import { profileRoutes } from "../../src/routes/profile";

const OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";

describe("D487 retired Agent-photo bypasses", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  test("the six superseded Agent-photo endpoints are absent", async () => {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    profileRoutes(app, { ownerId: OWNER_USER_ID });
    profileAvatarRoutes(app, { ownerId: OWNER_USER_ID });
    apps.push(app);

    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/profile/agent-avatar" }),
      app.inject({ method: "POST", url: "/api/profile/agent-avatar/select" }),
      app.inject({ method: "POST", url: "/api/profile/generate-avatar" }),
      app.inject({ method: "POST", url: "/api/profile/generate-avatar/stream" }),
      app.inject({ method: "GET", url: "/api/profile/avatar/candidate/arbitrary-blob" }),
      app.inject({ method: "GET", url: "/api/profile/avatar-gen-status" }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
  });

  test("production source cannot restore old route strings or client symbols", () => {
    const repoRoot = resolve(import.meta.dir, "../../../..");
    const sourceFiles = ["apps", "packages"].flatMap((root) =>
      productionSourceFiles(join(repoRoot, root)),
    );
    const forbiddenRoutes = [
      "/api/profile/agent-avatar",
      "/api/profile/agent-avatar/select",
      "/api/profile/generate-avatar",
      "/api/profile/generate-avatar/stream",
      "/api/profile/avatar/candidate/",
      "/api/profile/avatar-gen-status",
    ];
    const forbiddenSymbols = [
      "uploadAgentAvatar",
      "selectAgentAvatarCandidate",
      "generateProfileAvatar",
      "getAvatarCandidateObjectUrl",
      "revokeAvatarCandidateObjectUrl",
      "avatarCandidateObjectUrlCache",
    ];
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const token of [...forbiddenRoutes, ...forbiddenSymbols]) {
        if (source.includes(token)) violations.push(`${file.slice(repoRoot.length + 1)}: ${token}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

function productionSourceFiles(root: string): string[] {
  if (!statSync(root).isDirectory()) return [];
  const files: string[] = [];
  for (const packageName of readdirSync(root)) {
    const sourceRoot = join(root, packageName, "src");
    try {
      collectSourceFiles(sourceRoot, files);
    } catch {
      // Packages and apps without a src directory have no production source.
    }
  }
  return files;
}

function collectSourceFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(path, files);
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) && !/\.test\.[^.]+$/.test(entry.name)) {
      files.push(path);
    }
  }
}
