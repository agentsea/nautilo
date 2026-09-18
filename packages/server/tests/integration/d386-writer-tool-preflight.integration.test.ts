import { join } from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { config } from "dotenv";

config({ path: join(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "@nautilo/api-client";
import { ToolCatalog } from "@nautilo/catalog";
import {
  artifactNamespaces,
  artifacts,
  eq,
  fileRevisions,
  inArray,
  rooms,
} from "@nautilo/db";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";
import {
  createDefaultManifest,
  serializeWriterHtml,
} from "../../../first-party-apps/writer/src/office-document";
import { registerAppToolsForApp } from "../../src/apps/app-tool-registration";
import { computeAppSourceHash } from "../../src/apps/app-registry";
import { LiveMiniAppSessionRegistry } from "../../src/apps/live-mini-app-session-registry";
import { seedFirstPartyApps } from "../../src/apps/seed-first-party-apps";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

const WRITER_MIME = "application/vnd.nautilo.writer+html";
const originalFetch = globalThis.fetch;
const createdArtifactIds = new Set<string>();
let fixtureRoot = "";
let appsRoot = "";
let baseUrl = "";
let client: NautiloApiClient;
let fx: AppFixture;

// Boundary: this seeds the first-party Writer source, builds its installed
// manifest, and invokes its bundled worker without an invoke or canonical-read
// seam. The shared app fixture alone stubs Logto/JWKS administration; artifact
// storage, registration, session gating, and the worker result are real.
function canonicalWriterHtml(text: string): string {
  return serializeWriterHtml(createDefaultManifest(), {
    blocks: [{
      id: "block-1",
      type: "paragraph",
      inlines: [{ text, style: {} }],
    }],
  });
}

async function createWriterArtifact(content: string) {
  const roomId = fx.defaultRoomId;
  if (!roomId) throw new Error("fixture did not create a default room");
  const artifact = await client.createWorkspaceArtifact(
    new Blob([content], { type: WRITER_MIME }),
    {
      path: `d386-preflight-${crypto.randomUUID()}.writer.html`,
      mimeType: WRITER_MIME,
      roomId,
    },
  );
  createdArtifactIds.add(artifact.id);
  return artifact;
}

async function cleanupCreatedArtifacts(): Promise<void> {
  const artifactIds = [...createdArtifactIds];
  if (artifactIds.length === 0) return;

  const rows = await fx.db
    .select({ id: artifacts.id, storageUri: artifacts.storageUri })
    .from(artifacts)
    .where(inArray(artifacts.id, artifactIds));
  const absolutePaths = rows.map(({ storageUri }) => new URL(storageUri!).pathname);
  if (absolutePaths.length > 0) {
    await fx.db.delete(fileRevisions).where(inArray(fileRevisions.absolutePath, absolutePaths));
  }
  await fx.db.delete(artifactNamespaces).where(inArray(artifactNamespaces.artifactId, artifactIds));
  await fx.db.delete(artifacts).where(inArray(artifacts.id, artifactIds));
  await Promise.all(rows.map(({ storageUri }) => rm(new URL(storageUri!), { force: true })));
}

function parseToolResult(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected app tool to return a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function rejectProposal(
  registry: LiveMiniAppSessionRegistry,
  sessionId: string,
  result: Record<string, unknown>,
): void {
  const review = result["__nautiloLiveReview"];
  if (!review || typeof review !== "object" || !("proposalId" in review)) {
    throw new Error("proposal result did not include review identity");
  }
  const proposalId = (review as { proposalId?: unknown }).proposalId;
  if (typeof proposalId !== "string") {
    throw new Error("proposal result included an invalid review identity");
  }
  expect(registry.completeProposalReview({
    sessionId,
    proposalId,
    outcome: "rejected",
  }).ok).toBe(true);
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "nautilo-d386-fixture-"));
  process.env["NAUTILO_ARTIFACTS_ROOT"] = join(fixtureRoot, "artifacts");
  appsRoot = join(fixtureRoot, "apps");

  // The fixture helper derives its agent handle from the first 12 sanitized
  // suite-name characters; keep this entropy at the front for interrupted
  // or repeated local runs which may leave a prior fixture row behind.
  const suiteName = `d386${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  fx = await setupOwnerAppFixture({ suiteName, withDefaultAgentGraph: true });
  baseUrl = (await fx.app.listen({ port: 0, host: "127.0.0.1" })).replace(/\/$/, "");
  const bearer = await fx.mintOwnerBearer();
  client = new NautiloApiClient(baseUrl);
  client.setToken(bearer);
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return originalFetch(new URL(raw, baseUrl), init);
    },
    { preconnect: originalFetch.preconnect.bind(originalFetch) },
  );

  await seedFirstPartyApps({ appsRoot });
});

afterAll(async () => {
  try {
    await cleanupCreatedArtifacts();
  } finally {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
      appsRoot = "";
    }
    globalThis.fetch = originalFetch;
    await fx?.cleanup();
  }
});

describe("D386 real Writer preflight", () => {
  test("seeded Writer worker bundles the current workspace writer-proposal-core identity", async () => {
    const writerRoot = join(appsRoot, "nautilo-writer");
    const seededCoreRoot = join(writerRoot, "node_modules", "@nautilo", "writer-proposal-core");
    const workspaceCoreRoot = join(import.meta.dirname, "../../../writer-proposal-core");

    await stat(seededCoreRoot);
    await stat(workspaceCoreRoot);

    const [seededCoreIdentity, workspaceCoreIdentity] = await Promise.all([
      computeAppSourceHash(seededCoreRoot),
      computeAppSourceHash(workspaceCoreRoot),
    ]);
    expect(seededCoreIdentity).toBe(workspaceCoreIdentity);
  });

  test("preflights ambiguous anchors, hides locator ranges, and forwards a validated handle to the real Worker", async () => {
    const initialHtml = canonicalWriterHtml("first ac second ac");
    const artifact = await createWriterArtifact(initialHtml);
    const [room] = await fx.db
      .select({ namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, fx.defaultRoomId!));
    if (!room?.namespaceId || !fx.defaultAgentId) {
      throw new Error("fixture did not create an authorized Writer room context");
    }
    const [persistedBefore] = await fx.db
      .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(eq(artifacts.id, artifact.id));
    if (!persistedBefore) throw new Error("created Writer artifact was not persisted");

    const registry = new LiveMiniAppSessionRegistry();
    const { token, sessionId } = registry.issue({
      targetKind: "artifact",
      appId: "nautilo-writer",
      userId: fx.ownerId,
      namespaceIds: [room.namespaceId],
      artifactId: artifact.id,
      documentId: artifact.id,
      documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
    });
    const envelope: NamespaceMemoryEnvelope = {
      ownerId: fx.ownerId,
      actorId: fx.ownerActorId,
      agentId: fx.defaultAgentId,
      roomId: fx.defaultRoomId!,
      readableNamespaces: [room.namespaceId],
      mutableNamespaces: [room.namespaceId],
      writableNamespaces: [room.namespaceId],
      toolPolicy: {},
    };
    const context: AppToolRunnerContext = {
      ownerId: fx.ownerId,
      userId: fx.ownerId,
      agentId: fx.defaultAgentId,
      turnId: `d386-preflight-${crypto.randomUUID()}`,
      ...(fx.defaultRoomId ? { roomId: fx.defaultRoomId } : {}),
      memoryAccessEnvelope: envelope,
    };
    const catalog = new ToolCatalog();

    const registration = await registerAppToolsForApp(appsRoot, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
    });
    expect(registration).toMatchObject({ status: "registered", appId: "nautilo-writer" });

    const tools = new Map(catalog.getToolsForActor(context).map((tool) => [tool.name, tool]));
    const edit = tools.get("app_nautilo_writer__edit_open_writer");
    const locate = tools.get("app_nautilo_writer__locate_open_writer_text");
    expect(edit).toBeDefined();
    expect(locate).toBeDefined();

    const shortenedWithProperties = parseToolResult(await edit!.invoke({
      sessionToken: token,
      documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
      operations: [
        {
          kind: "replace",
          blockId: "block-1",
          scope: { kind: "block" },
          text: "short",
        },
        {
          kind: "set-block-type",
          blockId: "block-1",
          scope: { kind: "block" },
          blockType: { type: "heading", headingLevel: 1 },
        },
        {
          kind: "format-block",
          blockId: "block-1",
          scope: { kind: "block" },
          style: { alignment: "center" },
        },
      ],
    }));
    expect(shortenedWithProperties).toMatchObject({
      ok: true,
      status: "proposal_ready",
      operations: [
        { kind: "replace", blockId: "block-1", text: "short" },
        { kind: "set-block-type", blockId: "block-1" },
        { kind: "format-block", blockId: "block-1" },
      ],
    });
    rejectProposal(registry, sessionId, shortenedWithProperties);

    const ambiguous = parseToolResult(await edit!.invoke({
      sessionToken: token,
      documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
      operations: [{
        kind: "replace",
        blockId: "block-1",
        scope: { kind: "match", anchor: "ac" },
        text: "fixed",
      }],
    }));
    expect(ambiguous).toMatchObject({
      ok: false,
      status: "proposal_invalid",
      code: "anchor_ambiguous",
      operationIndex: 0,
    });

    const located = parseToolResult(await locate!.invoke({
      sessionToken: token,
      documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
      blockId: "block-1",
      before: "first",
      target: "ac",
      after: "second",
    }));
    expect(located).toMatchObject({
      ok: true,
      status: "locator_resolved",
      documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
      blockId: "block-1",
    });
    expect(typeof located["locatorHandle"]).toBe("string");
    expect(Object.keys(located).sort()).toEqual([
      "blockId",
      "documentVersion",
      "locatorHandle",
      "ok",
      "status",
    ]);
    expect(JSON.stringify(located)).not.toContain("__range");
    expect(JSON.stringify(located)).not.toContain("first ac second ac");

    const proposal = parseToolResult(await edit!.invoke({
      sessionToken: token,
      documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
      operations: [{
        kind: "replace",
        blockId: "block-1",
        scope: { kind: "locator", handle: located["locatorHandle"] },
        text: "fixed",
      }],
    }));
    expect(proposal).toMatchObject({
      ok: true,
      status: "proposal_ready",
      documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
      operations: [{
        kind: "replace",
        blockId: "block-1",
        scope: { kind: "range", start: 6, end: 8 },
        text: "fixed",
      }],
      __nautiloLiveReview: {
        kind: "proposal_ready",
        appId: "nautilo-writer",
        sessionId,
        documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
      },
    });
    const liveReview = proposal["__nautiloLiveReview"];
    expect(
      liveReview &&
        typeof liveReview === "object" &&
        "proposalId" in liveReview &&
        typeof liveReview.proposalId === "string",
    ).toBe(true);
    rejectProposal(registry, sessionId, proposal);

    for (const operations of [
      [
        { kind: "replace", blockId: "block-1", scope: { kind: "locator", handle: located["locatorHandle"] }, text: "fixed" },
        { kind: "format-inline", blockId: "block-1", scope: { kind: "match", anchor: "second" }, style: { bold: true } },
      ],
      [
        { kind: "format-inline", blockId: "block-1", scope: { kind: "match", anchor: "second" }, style: { bold: true } },
        { kind: "replace", blockId: "block-1", scope: { kind: "locator", handle: located["locatorHandle"] }, text: "fixed" },
      ],
    ]) {
      const independentProposal = parseToolResult(await edit!.invoke({
        sessionToken: token,
        documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
        operations,
      }));
      expect(independentProposal).toMatchObject({ ok: true, status: "proposal_ready" });
      rejectProposal(registry, sessionId, independentProposal);
    }

    const conflict = parseToolResult(await edit!.invoke({
      sessionToken: token,
      documentVersion: { kind: "artifact_revision", revision: persistedBefore.revision },
      operations: [
        { kind: "replace", blockId: "block-1", scope: { kind: "locator", handle: located["locatorHandle"] }, text: "fixed" },
        { kind: "format-inline", blockId: "block-1", scope: { kind: "match", anchor: "first ac" }, style: { bold: true } },
      ],
    }));
    expect(conflict).toMatchObject({
      ok: false,
      status: "proposal_invalid",
      code: "proposal_conflict",
      operationIndex: 1,
      conflictingOperationIndexes: [0, 1],
    });

    const [persistedAfter] = await fx.db
      .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(eq(artifacts.id, artifact.id));
    expect(persistedAfter?.revision).toBe(persistedBefore.revision);
    expect(await readFile(new URL(persistedAfter!.storageUri!), "utf8")).toBe(initialHtml);
    const revisions = await fx.db
      .select({ id: fileRevisions.id })
      .from(fileRevisions)
      .where(eq(fileRevisions.absolutePath, new URL(persistedAfter!.storageUri!).pathname));
    expect(revisions).toHaveLength(0);
  });
});
