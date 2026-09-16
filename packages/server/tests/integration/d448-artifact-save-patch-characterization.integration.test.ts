/**
 * D448 Phase 12 — prove the Workspace editor compatibility routes preserve
 * their HTTP contracts while committing through the canonical coordinator.
 *
 * This uses the real Fastify routes, Namespace-authorized artifact queries,
 * artifact bytes, and runtime event bus against the fixture's disposable
 * `test-cruft` database. It intentionally does not mock route or DB behavior.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  attachArtifactToNamespace,
  artifacts,
  artifactNamespaces,
  eq,
  inArray,
  insertArtifact,
  rooms,
  workspaceDocumentMutationEntries,
  workspaceDocumentMutations,
} from "@nautilo/db";
import { eventBus } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function documentPatchPayload(input: {
  artifactId: string;
  path: string;
  baseRevision: number;
  baseSha256: string;
  oldString: string;
  newString: string;
  requestId: string;
}) {
  return {
    requestId: input.requestId,
    target: {
      kind: "artifact" as const,
      artifactInternalId: input.artifactId,
      path: input.path,
    },
    baseRevision: input.baseRevision,
    baseSha256: input.baseSha256,
    patch: {
      kind: "anchored_text" as const,
      oldString: input.oldString,
      newString: input.newString,
    },
  };
}

async function namespaceIdForRoom(fixture: AppFixture, roomId: string): Promise<string> {
  const [room] = await fixture.db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!room?.namespaceId) throw new Error("fixture default room has no namespace");
  return room.namespaceId;
}

let fx: AppFixture;
let bearer: string;
let baseUrl: string;
let artifactRoot: string;
let previousArtifactRoot: string | undefined;
const createdArtifactIds: string[] = [];

beforeAll(async () => {
  previousArtifactRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
  artifactRoot = await mkdtemp(join(tmpdir(), "d448-artifact-save-patch-"));
  process.env["NAUTILO_ARTIFACTS_ROOT"] = artifactRoot;
  fx = await setupOwnerAppFixture({
    suiteName: `d448asp${Date.now().toString(36)}`,
    withDefaultAgentGraph: true,
  });
  baseUrl = (await fx.app.listen({ port: 0, host: "127.0.0.1" })).replace(/\/$/, "");
  bearer = await fx.mintOwnerBearer();
});

afterAll(async () => {
  if (createdArtifactIds.length > 0) {
    const mutationRows = await fx.db
      .select({ mutationId: workspaceDocumentMutationEntries.mutationId })
      .from(workspaceDocumentMutationEntries)
      .where(inArray(workspaceDocumentMutationEntries.artifactInternalId, createdArtifactIds));
    const mutationIds = [...new Set(mutationRows.map((row) => row.mutationId))];
    if (mutationIds.length > 0) {
      await fx.db
        .delete(workspaceDocumentMutations)
        .where(inArray(workspaceDocumentMutations.id, mutationIds));
    }
    await fx.db
      .delete(artifactNamespaces)
      .where(inArray(artifactNamespaces.artifactId, createdArtifactIds));
    await fx.db.delete(artifacts).where(inArray(artifacts.id, createdArtifactIds));
  }
  if (fx) await fx.cleanup();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  if (previousArtifactRoot === undefined) {
    delete process.env["NAUTILO_ARTIFACTS_ROOT"];
  } else {
    process.env["NAUTILO_ARTIFACTS_ROOT"] = previousArtifactRoot;
  }
});

async function readCurrentArtifactContent(artifactId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/workspace/artifacts/${artifactId}/bytes`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(response.status).toBe(200);
  return response.text();
}

async function waitForEventCount(
  events: readonly ServerEvent[],
  count: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(events).toHaveLength(count);
}

async function seedArtifact(content: string): Promise<{
  id: string;
  path: string;
  revision: number;
  sha256: string;
}> {
  const roomId = fx.defaultRoomId;
  if (!roomId) throw new Error("default agent graph was not installed");
  const namespaceId = await namespaceIdForRoom(fx, roomId);
  const artifactId = `d448-artifact-${randomUUID()}`;
  const absPath = join(artifactRoot, artifactId);
  const path = `d448/${randomUUID()}.md`;
  await writeFile(absPath, content, "utf8");
  const row = await insertArtifact(
    {
      artifactId,
      path,
      storageUri: `file://${absPath}`,
      mimeType: "text/markdown",
      size: Buffer.byteLength(content, "utf8"),
    },
    fx.db as unknown as NonNullable<Parameters<typeof insertArtifact>[1]>,
  );
  createdArtifactIds.push(row.id);
  await attachArtifactToNamespace(
    { artifactId: row.id, namespaceId },
    fx.db as unknown as NonNullable<Parameters<typeof attachArtifactToNamespace>[1]>,
  );
  return {
    id: row.id,
    path,
    revision: row.revision,
    sha256: sha256Hex(content),
  };
}

describe("D448 Workspace artifact save and patch characterization", () => {
  test("anchored patch and snapshot save preserve their route contracts and emit canonical commits", async () => {
    const original = "title\nbody\n";
    const seeded = await seedArtifact(original);
    const patchRequestId = randomUUID();
    const committedEvents: ServerEvent[] = [];
    const legacyEvents: ServerEvent[] = [];
    const handler = (event: ServerEvent) => {
      if (
        event.type === "document.mutation.committed" &&
        event.mutation === "update" &&
        event.after.identity.kind === "workspace_artifact" &&
        event.after.identity.artifactId === seeded.id
      ) {
        committedEvents.push(event);
      } else if (
        (event.type === "document.patch.applied" &&
          event.target.kind === "artifact" &&
          event.target.artifactInternalId === seeded.id) ||
        (event.type === "workspace.artifact.changed" && event.id === seeded.id)
      ) {
        legacyEvents.push(event);
      }
    };
    eventBus.on(handler);

    try {
      const patchedText = "title\npatched body\n";
      const patchResponse = await authedInject(fx.app, {
        method: "POST",
        url: `/api/workspace/artifacts/${seeded.id}/patch`,
        bearer,
        payload: documentPatchPayload({
          artifactId: seeded.id,
          path: seeded.path,
          baseRevision: seeded.revision,
          baseSha256: seeded.sha256,
          oldString: "body",
          newString: "patched body",
          requestId: patchRequestId,
        }),
      });
      expect(patchResponse.statusCode).toBe(200);
      const patched = JSON.parse(patchResponse.body) as {
        kind: string;
        revision: number;
        sha256: string;
        requestId: string;
        rebased: boolean;
      };
      expect(patched).toMatchObject({
        kind: "applied",
        revision: seeded.revision + 1,
        sha256: sha256Hex(patchedText),
        requestId: patchRequestId,
        rebased: false,
      });
      expect(await readCurrentArtifactContent(seeded.id)).toBe(patchedText);
      await waitForEventCount(committedEvents, 1);
      expect(committedEvents[0]).toMatchObject({
        type: "document.mutation.committed",
        mutation: "update",
        outcome: "applied",
        actor: { kind: "human" },
        before: {
          identity: {
            kind: "workspace_artifact",
            artifactId: seeded.id,
            logicalPath: seeded.path,
          },
          backendVersion: { kind: "artifact_revision", revision: seeded.revision },
          sha256: seeded.sha256,
        },
        after: {
          identity: {
            kind: "workspace_artifact",
            artifactId: seeded.id,
            logicalPath: seeded.path,
          },
          backendVersion: { kind: "artifact_revision", revision: patched.revision },
          sha256: patched.sha256,
        },
        editorSave: {
          requestId: patchRequestId,
          anchoredPatch: {
            kind: "anchored_text",
            oldString: "body",
            newString: "patched body",
          },
        },
      });

      const snapshotText = "title\nsnapshot save\n";
      const saveResponse = await authedInject(fx.app, {
        method: "PUT",
        url: `/api/workspace/artifacts/${seeded.id}/content`,
        bearer,
        payload: snapshotText,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "if-match": String(patched.revision),
          "x-base-sha256": patched.sha256,
          "x-client-mutation-id": "d448-snapshot-save",
        },
      });
      expect(saveResponse.statusCode).toBe(200);
      const saved = JSON.parse(saveResponse.body) as {
        id: string;
        revision: number;
        size: number;
        sha256: string;
      };
      expect(saved).toEqual({
        id: seeded.id,
        revision: patched.revision + 1,
        size: Buffer.byteLength(snapshotText, "utf8"),
        sha256: sha256Hex(snapshotText),
      });
      expect(await readCurrentArtifactContent(seeded.id)).toBe(snapshotText);
      await waitForEventCount(committedEvents, 2);
      expect(committedEvents[1]).toMatchObject({
        type: "document.mutation.committed",
        mutation: "update",
        outcome: "applied",
        actor: { kind: "human" },
        before: {
          identity: {
            kind: "workspace_artifact",
            artifactId: seeded.id,
            logicalPath: seeded.path,
          },
          backendVersion: { kind: "artifact_revision", revision: patched.revision },
          sha256: patched.sha256,
        },
        after: {
          identity: {
            kind: "workspace_artifact",
            artifactId: seeded.id,
            logicalPath: seeded.path,
          },
          backendVersion: { kind: "artifact_revision", revision: saved.revision },
          sha256: saved.sha256,
        },
        editorSave: {
          clientMutationId: "d448-snapshot-save",
          checkpoint: false,
        },
      });
      expect(legacyEvents).toHaveLength(0);
    } finally {
      eventBus.off(handler);
    }
  });
});
