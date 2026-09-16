/**
 * D448 Phase 6 — characterize Writer's three durable mutation boundaries
 * through the canonical document-mutation coordinator.
 *
 * Workspace saves use the production Fastify route, Writer's actual accepted
 * proposal store, and the production app-tool host. Current Folder intentionally
 * stops at the typed relay boundary: Electron is not required for this server
 * characterization, but the relay command and its exact write acknowledgement
 * remain part of the contract.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  artifactNamespaces,
  artifacts,
  attachArtifactToNamespace,
  eq,
  fileRevisions,
  inArray,
  insertArtifact,
  rooms,
  workspaceDocumentMutationEntries,
  workspaceDocumentMutations,
} from "@nautilo/db";
import { eventBus } from "@nautilo/runtime";
import { COORDINATED_LOCAL_MUTATION_PROTOCOL_VERSION } from "@nautilo/relay";
import type { ServerEvent } from "@nautilo/types";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";
import type { DocStore, Document } from "@nautilo/office-docs/node";
import {
  createDefaultManifest,
  parseWriterHtml,
  serializeWriterHtml,
} from "../../../first-party-apps/writer/src/office-document";
import { NautiloDocStore } from "../../../first-party-apps/writer/src/nautilo-doc-store";
import { persistAcceptedProposal } from "../../../first-party-apps/writer/src/accept-proposal-persistence";
import { SuggestionController } from "../../../first-party-apps/writer/src/suggestion-controller";
import { parseMiniAppManifestJson } from "../../src/apps/app-manifest";
import { createAppToolHost } from "../../src/apps/app-tool-host";
import {
  LiveLocalDocumentAuthority,
  type LiveLocalRelaySnapshot,
} from "../../src/apps/live-local-document-authority";
import type { LiveMiniAppSessionCurrentFileBinding } from "../../src/apps/live-mini-app-session-registry";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const WRITER_MIME = "application/vnd.nautilo.writer+html";
const createdArtifactIds: string[] = [];
let fx: AppFixture;
let bearer: string;
let baseUrl: string;
let artifactRoot = "";

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function writerHtml(text: string): string {
  return serializeWriterHtml(createDefaultManifest(), {
    blocks: [{
      id: "paragraph-1",
      type: "paragraph",
      inlines: [{ text, style: {} }],
    }],
  });
}

function inMemoryDocStore(initial: Document): DocStore {
  let document = initial;
  // NautiloDocStore's accepted-batch path needs only these three editor-store
  // methods. Persistence remains the production Writer host below.
  return {
    getDocument: () => document,
    setDocument: (next: Document) => {
      document = next;
    },
    snapshot: () => undefined,
  } as unknown as DocStore;
}

async function namespaceIdForDefaultRoom(): Promise<string> {
  if (!fx.defaultRoomId) throw new Error("fixture did not create a default room");
  const [room] = await fx.db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, fx.defaultRoomId));
  if (!room?.namespaceId) throw new Error("fixture default room has no namespace");
  return room.namespaceId;
}

async function seedWriterArtifact(content: string): Promise<{
  id: string;
  path: string;
  absPath: string;
  revision: number;
  sha256: string;
}> {
  const artifactId = `d448-writer-${randomUUID()}`;
  const absPath = join(artifactRoot, artifactId);
  const path = `d448/${randomUUID()}.writer.html`;
  await writeFile(absPath, content, "utf8");
  const artifact = await insertArtifact(
    {
      artifactId,
      path,
      storageUri: `file://${absPath}`,
      mimeType: WRITER_MIME,
      size: Buffer.byteLength(content, "utf8"),
    },
    fx.db as unknown as NonNullable<Parameters<typeof insertArtifact>[1]>,
  );
  createdArtifactIds.push(artifact.id);
  await attachArtifactToNamespace(
    { artifactId: artifact.id, namespaceId: await namespaceIdForDefaultRoom() },
    fx.db as unknown as NonNullable<Parameters<typeof attachArtifactToNamespace>[1]>,
  );
  return {
    id: artifact.id,
    path,
    absPath,
    revision: artifact.revision,
    sha256: sha256Hex(content),
  };
}

async function writerManifest() {
  const raw = JSON.parse(await readFile(
    resolve(import.meta.dirname, "../../../first-party-apps/writer/app.json"),
    "utf8",
  )) as unknown;
  const parsed = parseMiniAppManifestJson(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.manifest;
}

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

beforeAll(async () => {
  fx = await setupOwnerAppFixture({
    suiteName: `d448wr${Date.now().toString(36)}`,
    withDefaultAgentGraph: true,
  });
  baseUrl = (await fx.app.listen({ port: 0, host: "127.0.0.1" })).replace(/\/$/, "");
  bearer = await fx.mintOwnerBearer();
  artifactRoot = await mkdtemp(join(tmpdir(), "d448-writer-mutations-"));
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
    const rows = await fx.db
      .select({ storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(inArray(artifacts.id, createdArtifactIds));
    const paths = rows.map((row) => new URL(row.storageUri!).pathname);
    if (paths.length > 0) {
      await fx.db.delete(fileRevisions).where(inArray(fileRevisions.absolutePath, paths));
    }
    await fx.db.delete(artifactNamespaces).where(inArray(artifactNamespaces.artifactId, createdArtifactIds));
    await fx.db.delete(artifacts).where(inArray(artifacts.id, createdArtifactIds));
  }
  if (fx) await fx.cleanup();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

describe("D448 Writer mutation characterization", () => {
  test("persists Workspace human save and Writer agent acceptance, rejects a stale write, and dispatches accepted Current Folder bytes through the typed relay", async () => {
    const initial = writerHtml("before");
    const seeded = await seedWriterArtifact(initial);
    const events: ServerEvent[] = [];
    const handler = (event: ServerEvent) => {
      if (
        (event.type === "document.mutation.committed" &&
          event.mutation === "update" &&
          event.after.identity.kind === "workspace_artifact" &&
          event.after.identity.artifactId === seeded.id) ||
        (event.type === "document.patch.applied" &&
          event.target.kind === "artifact" &&
          event.target.artifactInternalId === seeded.id)
      ) {
        events.push(event);
      }
    };
    eventBus.on(handler);

    try {
      // Workspace Writer human save: production conditional content route.
      const humanContent = writerHtml("human save");
      const humanSave = await authedInject(fx.app, {
        method: "PUT",
        url: `/api/workspace/artifacts/${seeded.id}/content`,
        bearer,
        payload: humanContent,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "if-match": String(seeded.revision),
          "x-base-sha256": seeded.sha256,
          "x-client-mutation-id": "d448-writer-human-save",
        },
      });
      expect(humanSave.statusCode).toBe(200);
      const human = JSON.parse(humanSave.body) as { revision: number; sha256: string };
      expect(human).toMatchObject({
        revision: seeded.revision + 1,
        sha256: sha256Hex(humanContent),
      });
      expect(await readCurrentArtifactContent(seeded.id)).toBe(humanContent);
      await waitForEventCount(events, 1);
      expect(events[0]).toMatchObject({
        type: "document.mutation.committed",
        mutation: "update",
        outcome: "applied",
        actor: { kind: "human" },
        after: {
          identity: {
            kind: "workspace_artifact",
            artifactId: seeded.id,
            logicalPath: seeded.path,
          },
          backendVersion: { kind: "artifact_revision", revision: human.revision },
          sha256: human.sha256,
        },
        editorSave: { clientMutationId: "d448-writer-human-save" },
      });

      // Workspace Writer agent proposal acceptance: real Writer store plus
      // the production document.write host and artifact patch persistence.
      const manifest = await writerManifest();
      const [room] = await fx.db
        .select({ namespaceId: rooms.namespaceId })
        .from(rooms)
        .where(eq(rooms.id, fx.defaultRoomId!));
      if (!room?.namespaceId || !fx.defaultAgentId || !fx.defaultRoomId) {
        throw new Error("fixture did not create an agent-authorized room");
      }
      const envelope: NamespaceMemoryEnvelope = {
        ownerId: fx.ownerId,
        actorId: fx.ownerActorId,
        agentId: fx.defaultAgentId,
        roomId: fx.defaultRoomId,
        readableNamespaces: [room.namespaceId],
        mutableNamespaces: [room.namespaceId],
        writableNamespaces: [room.namespaceId],
        toolPolicy: {},
      };
      const host = createAppToolHost({
        appId: "nautilo-writer",
        appsRoot: resolve(import.meta.dirname, "../../../first-party-apps"),
        manifest,
        context: {
          ownerId: fx.ownerId,
          userId: fx.ownerId,
          agentId: fx.defaultAgentId,
          roomId: fx.defaultRoomId,
          memoryAccessEnvelope: envelope,
          turnId: "d448-workspace-acceptance",
        },
      });
      const target = { surface: "workspace" as const, path: seeded.path };
      const base = await host.document.read(target);
      expect(base).toMatchObject({
        content: humanContent,
        baseSha256: human.sha256,
        baseRevision: human.revision,
      });

      const store = new NautiloDocStore(humanContent, {
        createStore: inMemoryDocStore,
        writePatch: async ({ container }) => {
          const result = await host.document.write(target, { content: container }, {
            baseSha256: base.baseSha256,
            baseRevision: base.baseRevision,
          });
          expect(result).toMatchObject({ kind: "saved" });
          return result.kind === "saved";
        },
      });
      await store.initBase();
      const controller = new SuggestionController();
      controller.receive(
        {
          proposalId: "d448-workspace-agent-proposal",
          sessionToken: "d448-workspace-session",
          baseRevision: human.revision,
          operations: [{
            kind: "replace",
            blockId: "paragraph-1",
            scope: { kind: "range", start: 0, end: "human save".length },
            text: "agent accepted",
          }],
        },
        store.getDocument(),
        { kind: "artifact_revision", revision: human.revision },
      );
      expect(controller.getState()).toMatchObject({ kind: "pending" });
      const acceptance = await persistAcceptedProposal({
        controller,
        store,
        currentDocumentVersion: { kind: "artifact_revision", revision: human.revision },
        liveSession: {
          sessionToken: "d448-workspace-session",
          sessionId: "non-authorizing-session-id",
          documentVersion: { kind: "artifact_revision", revision: human.revision },
        },
      });
      expect({ acceptance, state: controller.getState() }).toMatchObject({ acceptance: { kind: "artifact_persisted" }, state: { kind: "completed" } });

      const [afterAcceptance] = await fx.db
        .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
        .from(artifacts)
        .where(eq(artifacts.id, seeded.id));
      expect(afterAcceptance?.revision).toBe(human.revision + 1);
      const acceptedBytes = await readFile(afterAcceptance!.storageUri!.slice("file://".length), "utf8");
      const acceptedDocument = parseWriterHtml(acceptedBytes);
      expect(acceptedDocument).toMatchObject({ ok: true });
      if (acceptedDocument.ok) {
        expect((acceptedDocument.document.document.blocks[0] as {
          inlines: Array<{ text: string }>;
        }).inlines[0]?.text).toBe("agent accepted");
      }
      await waitForEventCount(events, 2);
      expect(events[1]).toMatchObject({
        type: "document.mutation.committed",
        mutation: "update", outcome: "applied",
        before: {
          identity: { kind: "workspace_artifact", artifactId: seeded.id, logicalPath: seeded.path },
          backendVersion: { kind: "artifact_revision", revision: human.revision },
          sha256: human.sha256,
        },
        after: {
          identity: { kind: "workspace_artifact", artifactId: seeded.id, logicalPath: seeded.path },
          backendVersion: { kind: "artifact_revision", revision: afterAcceptance!.revision },
          sha256: sha256Hex(acceptedBytes),
        },
        actor: { kind: "agent", agentId: fx.defaultAgentId },
        revisionGroupId: "workspace-file-turn:d448-workspace-acceptance",
      });

      // A newly-created host with an out-of-date base must decline before
      // persistence: revision, bytes, and mutation event count stay exact.
      const staleHost = createAppToolHost({
        appId: "nautilo-writer",
        appsRoot: resolve(import.meta.dirname, "../../../first-party-apps"),
        manifest,
        context: {
          ownerId: fx.ownerId,
          userId: fx.ownerId,
          agentId: fx.defaultAgentId,
          roomId: fx.defaultRoomId,
          memoryAccessEnvelope: envelope,
          turnId: "d448-workspace-stale-write",
        },
      });
      expect(await staleHost.document.write(target, { content: writerHtml("must not persist") }, {
        baseSha256: "0".repeat(64),
        baseRevision: afterAcceptance!.revision,
      })).toEqual({ kind: "conflict", currentSha256: sha256Hex(acceptedBytes) });
      const [afterRejection] = await fx.db
        .select({ revision: artifacts.revision })
        .from(artifacts)
        .where(eq(artifacts.id, seeded.id));
      expect(afterRejection?.revision).toBe(afterAcceptance!.revision);
      expect(await readCurrentArtifactContent(seeded.id)).toBe(acceptedBytes);
      expect(events.filter((event) => event.type === "document.mutation.committed")).toHaveLength(2);
      expect(events.filter((event) => event.type === "document.patch.applied")).toHaveLength(0);

      // Current Folder accepted proposal boundary. The fake relay is typed and
      // stateful so only Electron/desktop transport is substituted, not the
      // server validation, routing, expected-SHA, or write acknowledgement.
      const currentFolder = "/tmp/d448-writer-current-folder";
      const relativePath = "accepted.writer.html";
      const canonicalPath = join(currentFolder, relativePath);
      const relayId = "d448-writer-relay";
      let localContent = writerHtml("local before");
      let relayWrites = 0;
      const relaySnapshot: LiveLocalRelaySnapshot = {
        ownedByActor: true,
        protocolVersion: COORDINATED_LOCAL_MUTATION_PROTOCOL_VERSION,
        profile: "desktop-agent",
        localFileExecution: true,
        allowedRoots: [currentFolder],
      };
      const authority = new LiveLocalDocumentAuthority({
        relayRegistry: {
          snapshotForFocusedResource(candidateRelayId, candidateActorId) {
            return candidateRelayId === relayId && candidateActorId === fx.ownerId
              ? relaySnapshot
              : null;
          },
        },
        localFileDispatch: {
          async fsDispatch(candidateRelayId, request) {
            expect(candidateRelayId).toBe(relayId);
            expect(request).toEqual({
              op: "realpath",
              path: canonicalPath,
              allowedRoots: [currentFolder],
            });
            return { ok: true as const, realpath: canonicalPath };
          },
          async localFileDispatch(candidateRelayId, request, options) {
            expect(candidateRelayId).toBe(relayId);
            expect(options).toEqual({ mutating: true, approvalObtained: true });
            expect(request.operation).toMatchObject({
              kind: "file",
              command: "write",
              zone: "current",
              args: {
                path: relativePath,
                expectedSha256: sha256Hex(localContent),
                clientMutationId: "d448-local-accepted-request",
                _routing: {
                  ownerId: fx.ownerId,
                  turnId: "d448-agent-turn",
                  currentFolder,
                },
              },
            });
            if (request.operation.kind !== "file") {
              return { ok: false as const, message: "unexpected relay operation" };
            }
            localContent = Buffer.from(request.operation.args["content"] as string, "base64").toString("utf8");
            relayWrites++;
            return {
              ok: true as const,
              result: JSON.stringify({
                applied: true,
                revisionId: "local:d448-accepted-revision",
                sha256: sha256Hex(localContent),
              }),
            };
          },
        },
      });
      const localBinding: LiveMiniAppSessionCurrentFileBinding = {
        targetKind: "currentFile",
        appId: "nautilo-writer",
        userId: fx.ownerId,
        localTargetId: "d448-local-target",
        relayId,
        canonicalPath,
        currentFolderRoot: currentFolder,
        relativePath,
        documentVersion: { kind: "local_sha", sha256: sha256Hex(localContent) },
      };
      const localAccepted = writerHtml("local accepted");
      expect(await authority.writeAccepted({
        binding: localBinding,
        bytes: Buffer.from(localAccepted, "utf8"),
        agentId: fx.defaultAgentId,
        turnId: "d448-agent-turn",
        clientMutationId: "d448-local-accepted-request",
      })).toEqual({
        ok: true,
        sha256: sha256Hex(localAccepted),
        localRevisionRef: "local:d448-accepted-revision",
      });
      expect(localContent).toBe(localAccepted);
      expect(relayWrites).toBe(1);

      const rejectedBinding = { ...localBinding, canonicalPath: join(currentFolder, "other.writer.html") };
      expect(await authority.writeAccepted({
        binding: rejectedBinding,
        bytes: Buffer.from(writerHtml("must not dispatch"), "utf8"),
        agentId: fx.defaultAgentId,
        turnId: "d448-agent-turn",
        clientMutationId: "d448-local-rejected-request",
      })).toEqual({ ok: false, code: "local_target_forbidden" });
      expect(relayWrites).toBe(1);
      expect(localContent).toBe(localAccepted);
    } finally {
      eventBus.off(handler);
    }
  });
});
