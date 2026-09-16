import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyDocumentOperations,
  parseWriterHtml,
  serializeCanonicalWriterHtml,
  writerLiveReviewExtension,
} from "@nautilo/writer-proposal-core";
import "../../src/apps/first-party-live-review-extensions";
import { createLiveArtifactProposalAcceptance } from
  "../../src/apps/live-artifact-proposal-acceptance";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function writerHtml(text: string): string {
  return writerHtmlBlocks([text]);
}

function writerHtmlBlocks(texts: readonly string[]): string {
  return `<!doctype html><html><head>
<script type="application/vnd.nautilo.document+json" id="manifest">${JSON.stringify({
    documentType: "document",
    editor: "wafflebase",
    payloadId: "wafflebase-document",
    payloadFormat: "application/vnd.wafflebase.document+json",
    version: "1.0",
  })}</script>
<script type="application/vnd.wafflebase.document+json" id="wafflebase-document">${JSON.stringify({
    blocks: texts.map((text, index) => ({
      id: `p${index + 1}`,
      type: "paragraph",
      inlines: [{ text, style: {} }],
      style: {},
    })),
  })}</script>
</head><body></body></html>`;
}

const artifact = {
  id: "artifact-row-1",
  artifactId: "artifact-public-1",
  path: "draft.html",
  storageUri: "file:///not-read",
  mimeType: "text/html",
  size: 10,
  revision: 7,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const envelope = {
  memoryMode: "namespace" as const,
  ownerId: "owner-1",
  actorId: "owner-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: ["namespace-1"],
  mutableNamespaces: ["namespace-1"],
  writableNamespaces: ["namespace-1"],
  toolPolicy: {},
};

const operation = {
  kind: "replace",
  blockId: "p1",
  scope: { kind: "range", start: 0, end: 5 },
  range: { start: 0, end: 5 },
  text: "world",
  operationIndex: 0,
};

function acceptanceInput(acceptedContent: string) {
  return {
    envelope,
    binding: {
      targetKind: "artifact" as const,
      appId: "nautilo-writer",
      userId: "owner-1",
      namespaceIds: ["namespace-1"],
      artifactId: artifact.id,
      documentId: artifact.id,
      documentVersion: { kind: "artifact_revision" as const, revision: 7 },
    },
    sessionId: "session-1",
    proposalId: "proposal-1",
    requestId: "request-1",
    documentVersion: { kind: "artifact_revision" as const, revision: 7 },
    acceptedContent,
    selectedOperations: [operation],
  };
}

describe("live Artifact proposal acceptance", () => {
  test("uses the canonical Workspace save service with server-replayed Writer bytes", async () => {
    const canonical = writerHtml("hello");
    const accepted = writerHtml("world").replace(
      "<body>",
      '<body><aside data-untrusted="true">ignored</aside>',
    );
    let saveCalls = 0;
    let mutationId = "";
    const accept = createLiveArtifactProposalAcceptance({
      findArtifact: async ({ internalId, readableNamespaceIds }) =>
        internalId === artifact.id && readableNamespaceIds.includes("namespace-1")
          ? artifact
          : null,
      readCanonicalContent: async () => canonical,
      saveSnapshot: async (input) => {
        saveCalls++;
        mutationId = input.clientMutationId ?? "";
        expect(input.artifact).toBe(artifact);
        expect(input.baseRevision).toBe(7);
        expect(input.baseSha256).toBe(sha256(canonical));
        expect(input.newText).toContain("world");
        expect(input.newText).not.toContain("data-untrusted");
        return {
          ok: true as const,
          revision: 8,
          size: Buffer.byteLength(input.newText),
          sha256: sha256(input.newText),
        };
      },
      onCommitted: () => {},
    });

    const first = await accept(acceptanceInput(accepted));
    expect(first).toMatchObject({
      ok: true,
      result: { documentVersion: { kind: "artifact_revision", revision: 8 } },
    });
    expect(saveCalls).toBe(1);
    expect(mutationId).toMatch(/^live-review:[a-f0-9]{64}$/);

    await accept(acceptanceInput(accepted));
    expect(saveCalls).toBe(2);
    expect(mutationId).toMatch(/^live-review:[a-f0-9]{64}$/);
  });

  test("rejects client bytes that are not the selected proposal result", async () => {
    let saveCalls = 0;
    const accept = createLiveArtifactProposalAcceptance({
      findArtifact: async () => artifact,
      readCanonicalContent: async () => writerHtml("hello"),
      saveSnapshot: async () => {
        saveCalls++;
        return { ok: true as const, revision: 8, size: 0, sha256: "0".repeat(64) };
      },
      onCommitted: () => {},
    });

    expect(await accept(acceptanceInput(writerHtml("not-world"))))
      .toEqual({ ok: false, code: "acceptance_conflict" });
    expect(saveCalls).toBe(0);
  });

  test("persists one exact document-wide review beyond the outline and twenty edits", async () => {
    const before = Array.from(
      { length: 36 },
      (_, index) => `Block ${index + 1} contains teh known typo.`,
    );
    const after = before.map((text) => text.replace("teh", "the"));
    const selectedOperations = before.map((text, index) => {
      const start = text.indexOf("teh");
      return {
        kind: "replace",
        blockId: `p${index + 1}`,
        scope: { kind: "range", start, end: start + 3 },
        range: { start, end: start + 3 },
        text: "the",
        operationIndex: index,
      };
    });
    const canonical = writerHtmlBlocks(before);
    const preflight = writerLiveReviewExtension.preflightProposal(canonical, selectedOperations);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const parsedCanonical = parseWriterHtml(canonical);
    expect(parsedCanonical.ok).toBe(true);
    if (!parsedCanonical.ok) return;
    const applied = applyDocumentOperations(
      parsedCanonical.document.document as Parameters<typeof applyDocumentOperations>[0],
      preflight.operations as Parameters<typeof applyDocumentOperations>[1],
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const accepted = serializeCanonicalWriterHtml(
      parsedCanonical.document.manifest,
      applied.document,
    );
    let persisted = "";
    const accept = createLiveArtifactProposalAcceptance({
      findArtifact: async () => artifact,
      readCanonicalContent: async () => canonical,
      saveSnapshot: async (input) => {
        persisted = input.newText;
        return {
          ok: true as const,
          revision: 8,
          size: Buffer.byteLength(input.newText),
          sha256: sha256(input.newText),
        };
      },
      onCommitted: () => {},
    });

    expect(await accept({
      ...acceptanceInput(accepted),
      selectedOperations,
    })).toMatchObject({
      ok: true,
      result: { documentVersion: { kind: "artifact_revision", revision: 8 } },
    });
    const reread = parseWriterHtml(persisted);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    const exactTexts = (reread.document.document.blocks as Array<{
      inlines?: Array<{ text: string }>;
    }>).map((block) => block.inlines?.map((inline) => inline.text).join("") ?? "");
    expect(exactTexts).toEqual(after);
    expect(exactTexts.slice(30)).toHaveLength(6);
    expect(exactTexts.join("\n")).not.toContain("teh");
  });
});
