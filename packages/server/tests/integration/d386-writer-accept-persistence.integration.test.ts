import { resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "@nautilo/api-client";
import {
  artifactNamespaces,
  artifacts,
  eq,
  inArray,
  workspaceDocumentMutationEntries,
  workspaceDocumentMutations,
} from "@nautilo/db";
import {
  createTableBlock,
  type DocStore,
  type Document,
} from "@nautilo/office-docs/node";
import { deriveAnchoredTextPatch } from "@nautilo/types";
import type { LiveDocumentVersion } from "@nautilo/types";
import {
  createDefaultManifest,
  parseWriterHtml,
  serializeWriterHtml,
} from "../../../first-party-apps/writer/src/office-document";
import { NautiloDocStore } from "../../../first-party-apps/writer/src/nautilo-doc-store";
import { persistAcceptedProposal } from "../../../first-party-apps/writer/src/accept-proposal-persistence";
import { SuggestionController } from "../../../first-party-apps/writer/src/suggestion-controller";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

const WRITER_MIME = "application/vnd.nautilo.writer+html";
const originalFetch = globalThis.fetch;
let fx: AppFixture;
let baseUrl: string;
let client: NautiloApiClient;
const createdArtifactIds = new Set<string>();

function artifactDocumentVersion(revision: number): LiveDocumentVersion {
  return { kind: "artifact_revision", revision };
}

type WriterWriteSession = {
  envelope: {
    content: string;
    mimeType: string;
    path: string;
    baseSha256: string | null;
    baseRevision: number | null;
  };
};

async function writeWriterArtifactContent(
  artifactId: string,
  path: string,
  roomId: string,
  nextContent: string,
  session: WriterWriteSession,
): Promise<boolean> {
  const remembered = session.envelope;
  if (remembered.content === nextContent) return true;
  const patch = deriveAnchoredTextPatch(remembered.content, nextContent);
  if (!patch || remembered.baseSha256 === null || remembered.baseRevision === null) return false;
  const applied = await client.applyWorkspaceArtifactPatch(artifactId, {
    requestId: crypto.randomUUID(),
    target: {
      kind: "artifact",
      artifactInternalId: artifactId,
      path,
      roomId,
      mimeType: WRITER_MIME,
    },
    baseRevision: remembered.baseRevision,
    baseSha256: remembered.baseSha256,
    patch,
    checkpoint: true,
    mimeType: WRITER_MIME,
  }, { roomId });
  session.envelope = {
    ...remembered,
    content: applied.content ?? nextContent,
    baseSha256: applied.sha256,
    baseRevision: applied.revision,
  };
  return true;
}

function writerHtml(text: string): string {
  return serializeWriterHtml(createDefaultManifest(), {
    blocks: [{ id: "paragraph-1", type: "paragraph", inlines: [{ text, style: {} }] }],
  });
}

function tableHtml(): string {
  const table = createTableBlock(2, 2);
  table.id = "table";
  for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
    const cell = table.tableData!.rows[row]!.cells[col]!;
    cell.blocks[0]!.id = `table-${row}-${col}`;
    cell.blocks[0]!.inlines = [{ text: `${row}:${col}`, style: {} }];
  }
  return serializeWriterHtml(createDefaultManifest(), { blocks: [table] });
}

function inMemoryDocStore(initial: Document): DocStore {
  let document = initial;
  return {
    getDocument: () => document,
    setDocument: (next: Document) => {
      document = next;
    },
    snapshot: () => undefined,
  } as unknown as DocStore;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createWriterArtifact(content: string) {
  const roomId = fx.defaultRoomId;
  if (!roomId) throw new Error("fixture did not create a default room");
  const artifact = await client.createWorkspaceArtifact(
    new Blob([content], { type: WRITER_MIME }),
    { path: `d386-${crypto.randomUUID()}.writer.html`, mimeType: WRITER_MIME, roomId },
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
  const mutationRows = await fx.db
    .select({ mutationId: workspaceDocumentMutationEntries.mutationId })
    .from(workspaceDocumentMutationEntries)
    .where(inArray(workspaceDocumentMutationEntries.artifactInternalId, artifactIds));
  const mutationIds = [...new Set(mutationRows.map(({ mutationId }) => mutationId))];
  if (mutationIds.length > 0) {
    await fx.db
      .delete(workspaceDocumentMutations)
      .where(inArray(workspaceDocumentMutations.id, mutationIds));
  }
  await fx.db.delete(artifactNamespaces).where(inArray(artifactNamespaces.artifactId, artifactIds));
  await fx.db.delete(artifacts).where(inArray(artifacts.id, artifactIds));
  await Promise.all(rows.map(({ storageUri }) => rm(new URL(storageUri!), { force: true })));
}

async function mutationEntriesFor(artifactId: string) {
  return fx.db
    .select({
      mutationKind: workspaceDocumentMutationEntries.mutationKind,
      historyEligible: workspaceDocumentMutationEntries.historyEligible,
      checkpoint: workspaceDocumentMutationEntries.checkpoint,
    })
    .from(workspaceDocumentMutationEntries)
    .where(eq(workspaceDocumentMutationEntries.artifactInternalId, artifactId));
}

beforeAll(async () => {
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
});

afterAll(async () => {
  try {
    await cleanupCreatedArtifacts();
  } finally {
    globalThis.fetch = originalFetch;
    await fx?.cleanup();
  }
});

describe("D386 Writer accepted proposal persistence", () => {
  test("accept-all persists one checkpoint through Writer, Workbench, and M193", async () => {
    const initialHtml = writerHtml("before");
    const artifact = await createWriterArtifact(initialHtml);
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("fixture did not create a default room");
    const session: WriterWriteSession = {
      envelope: {
        content: initialHtml,
        mimeType: WRITER_MIME,
        path: artifact.path,
        baseSha256: await sha256Hex(initialHtml),
        baseRevision: artifact.revision,
      },
    };
    const store = new NautiloDocStore(initialHtml, {
      createStore: inMemoryDocStore,
      writePatch: async ({ container }) =>
        writeWriterArtifactContent(artifact.id, artifact.path, roomId, container, session),
    });
    await store.initBase();

    const controller = new SuggestionController();
    controller.receive(
      {
        proposalId: "proposal-accept",
        sessionToken: "opaque-bearer-token",
        baseRevision: artifact.revision,
        operations: [{
          kind: "replace",
          blockId: "paragraph-1",
          scope: { kind: "range", start: 0, end: 6 },
          text: "after",
        }],
      },
      store.getDocument(),
      artifactDocumentVersion(artifact.revision),
    );

    const persisted = await persistAcceptedProposal({
      controller,
      store,
      currentDocumentVersion: artifactDocumentVersion(artifact.revision),
      liveSession: {
        sessionToken: "opaque-bearer-token",
        sessionId: "non-authorizing-session-id",
        documentVersion: artifactDocumentVersion(artifact.revision),
      },
    });
    expect(persisted).toEqual({ kind: "artifact_persisted" });
    expect(controller.getState()).toMatchObject({
      kind: "completed",
      proposalId: "proposal-accept",
      outcome: "accepted",
    });

    const [persistedArtifact] = await fx.db
      .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(eq(artifacts.id, artifact.id));
    expect(persistedArtifact?.revision).toBe(artifact.revision + 1);
    const diskHtml = await readFile(new URL(persistedArtifact!.storageUri!), "utf8");
    const parsed = parseWriterHtml(diskHtml);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect((parsed.document.document.blocks[0] as { inlines: Array<{ text: string }> }).inlines[0]?.text).toBe("after");
    }

    expect(await mutationEntriesFor(artifact.id)).toEqual([{
      mutationKind: "update",
      historyEligible: true,
      checkpoint: true,
    }]);
  });

  test("propose then reject leaves bytes, revision, and durable history unchanged", async () => {
    const initialHtml = writerHtml("before");
    const artifact = await createWriterArtifact(initialHtml);
    const parsedInitial = parseWriterHtml(initialHtml);
    if (!parsedInitial.ok) throw new Error(parsedInitial.error);
    const controller = new SuggestionController();
    controller.receive(
      {
        proposalId: "proposal-reject",
        sessionToken: "opaque-bearer-token",
        baseRevision: artifact.revision,
        operations: [{
          kind: "replace",
          blockId: "paragraph-1",
          scope: { kind: "range", start: 0, end: 6 },
          text: "after",
        }],
      },
      parsedInitial.document.document as Document,
      artifactDocumentVersion(artifact.revision),
    );
    controller.rejectAll();

    const [persistedArtifact] = await fx.db
      .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(eq(artifacts.id, artifact.id));
    expect(persistedArtifact?.revision).toBe(artifact.revision);
    expect(await readFile(new URL(persistedArtifact!.storageUri!), "utf8")).toBe(initialHtml);
    expect(await mutationEntriesFor(artifact.id)).toHaveLength(0);
    expect(controller.getState()).toMatchObject({
      kind: "completed",
      proposalId: "proposal-reject",
      outcome: "rejected",
    });
  });

  test("rejects hazardous table mixes and persists safe table batches separately", async () => {
    const initialHtml = tableHtml();
    const artifact = await createWriterArtifact(initialHtml);
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("fixture did not create a default room");
    const session: WriterWriteSession = {
      envelope: {
        content: initialHtml,
        mimeType: WRITER_MIME,
        path: artifact.path,
        baseSha256: await sha256Hex(initialHtml),
        baseRevision: artifact.revision,
      },
    };
    const store = new NautiloDocStore(initialHtml, {
      createStore: inMemoryDocStore,
      writePatch: async ({ container }) =>
        writeWriterArtifactContent(artifact.id, artifact.path, roomId, container, session),
    });
    await store.initBase();
    const mixed = new SuggestionController();
    mixed.receive(
      {
        proposalId: "table-proposal",
        sessionToken: "opaque-bearer-token",
        baseRevision: artifact.revision,
        operations: [
          { kind: "replace", blockId: "table-0-0", scope: { kind: "range", start: 0, end: 3 }, text: "changed" },
          { kind: "insert-table-row", tableBlockId: "table", rowIndex: 2 },
        ],
      },
      store.getDocument(),
      artifactDocumentVersion(artifact.revision),
    );

    expect(mixed.getState()).toMatchObject({ kind: "error", reason: "resolver_error" });
    expect(await persistAcceptedProposal({
      controller: mixed,
      store,
      currentDocumentVersion: artifactDocumentVersion(artifact.revision),
      liveSession: {
        sessionToken: "opaque-bearer-token",
        sessionId: "non-authorizing-session-id",
        documentVersion: artifactDocumentVersion(artifact.revision),
      },
    })).toEqual({ kind: "not_persisted" });

    const [rejectedArtifact] = await fx.db
      .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(eq(artifacts.id, artifact.id));
    expect(rejectedArtifact?.revision).toBe(artifact.revision);
    expect(await readFile(new URL(rejectedArtifact!.storageUri!), "utf8")).toBe(initialHtml);
    expect(await mutationEntriesFor(artifact.id)).toHaveLength(0);

    const text = new SuggestionController();
    text.receive({
      proposalId: "table-text",
      sessionToken: "opaque-bearer-token",
      baseRevision: artifact.revision,
      operations: [{ kind: "replace", blockId: "table-0-0", scope: { kind: "range", start: 0, end: 3 }, text: "changed" }],
    }, store.getDocument(), artifactDocumentVersion(artifact.revision));
    expect(await persistAcceptedProposal({
      controller: text,
      store,
      currentDocumentVersion: artifactDocumentVersion(artifact.revision),
      liveSession: {
        sessionToken: "opaque-bearer-token",
        sessionId: "non-authorizing-session-id",
        documentVersion: artifactDocumentVersion(artifact.revision),
      },
    })).toEqual({ kind: "artifact_persisted" });

    const [textArtifact] = await fx.db
      .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(eq(artifacts.id, artifact.id));
    expect(textArtifact?.revision).toBe(artifact.revision + 1);
    expect(await mutationEntriesFor(artifact.id)).toEqual([{
      mutationKind: "update",
      historyEligible: true,
      checkpoint: true,
    }]);

    const shape = new SuggestionController();
    shape.receive({
      proposalId: "table-shape",
      sessionToken: "opaque-bearer-token",
      baseRevision: textArtifact!.revision,
      operations: [
        { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { backgroundColor: "#abc" } },
        { kind: "insert-table-row", tableBlockId: "table", rowIndex: 2 },
        { kind: "delete-table-row", tableBlockId: "table", rowIndex: 2 },
      ],
    }, store.getDocument(), artifactDocumentVersion(textArtifact!.revision));
    expect(await persistAcceptedProposal({
      controller: shape,
      store,
      currentDocumentVersion: artifactDocumentVersion(textArtifact!.revision),
      liveSession: {
        sessionToken: "opaque-bearer-token",
        sessionId: "non-authorizing-session-id",
        documentVersion: artifactDocumentVersion(textArtifact!.revision),
      },
    })).toEqual({ kind: "artifact_persisted" });

    const [persistedArtifact] = await fx.db
      .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(eq(artifacts.id, artifact.id));
    expect(persistedArtifact?.revision).toBe(artifact.revision + 2);
    const parsed = parseWriterHtml(await readFile(new URL(persistedArtifact!.storageUri!), "utf8"));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    const table = (parsed.document.document as Document).blocks[0]!.tableData!;
    expect(table.rows).toHaveLength(2);
    expect(table.columnWidths).toHaveLength(2);
    expect(table.rows[0]!.cells[0]!.blocks[0]!.inlines[0]!.text).toBe("changed");
    expect(table.rows[0]!.cells[0]!.style).toMatchObject({ backgroundColor: "#abc" });
    expect(table.rows.flatMap((row: (typeof table.rows)[number]) => row.cells).every((cell: (typeof table.rows)[number]["cells"][number]) => cell.colSpan !== 0)).toBe(true);

    expect(await mutationEntriesFor(artifact.id)).toEqual([
      { mutationKind: "update", historyEligible: true, checkpoint: true },
      { mutationKind: "update", historyEligible: true, checkpoint: true },
    ]);
  });

  test("accepting table deletion persists one checkpoint and removes durable table bytes", async () => {
    const initialHtml = tableHtml();
    const artifact = await createWriterArtifact(initialHtml);
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("fixture did not create a default room");
    const session: WriterWriteSession = {
      envelope: {
        content: initialHtml,
        mimeType: WRITER_MIME,
        path: artifact.path,
        baseSha256: await sha256Hex(initialHtml),
        baseRevision: artifact.revision,
      },
    };
    const store = new NautiloDocStore(initialHtml, {
      createStore: inMemoryDocStore,
      writePatch: async ({ container }) =>
        writeWriterArtifactContent(artifact.id, artifact.path, roomId, container, session),
    });
    await store.initBase();
    const controller = new SuggestionController();
    controller.receive(
      {
        proposalId: "delete-table-proposal",
        sessionToken: "opaque-bearer-token",
        baseRevision: artifact.revision,
        operations: [{ kind: "delete-table", tableBlockId: "table" }],
      },
      store.getDocument(),
      artifactDocumentVersion(artifact.revision),
    );

    expect(await persistAcceptedProposal({
      controller,
      store,
      currentDocumentVersion: artifactDocumentVersion(artifact.revision),
      liveSession: {
        sessionToken: "opaque-bearer-token",
        sessionId: "non-authorizing-session-id",
        documentVersion: artifactDocumentVersion(artifact.revision),
      },
    })).toEqual({ kind: "artifact_persisted" });

    const [persistedArtifact] = await fx.db
      .select({ revision: artifacts.revision, storageUri: artifacts.storageUri })
      .from(artifacts)
      .where(eq(artifacts.id, artifact.id));
    expect(persistedArtifact?.revision).toBe(artifact.revision + 1);
    const parsed = parseWriterHtml(await readFile(new URL(persistedArtifact!.storageUri!), "utf8"));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.document.document.blocks).toHaveLength(0);
    expect(await mutationEntriesFor(artifact.id)).toEqual([{
      mutationKind: "update",
      historyEligible: true,
      checkpoint: true,
    }]);
  });
});
