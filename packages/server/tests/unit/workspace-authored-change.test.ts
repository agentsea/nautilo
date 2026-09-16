import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact, WorkspaceDocumentHistoryRecord } from "@nautilo/db";
import {
  readWorkspaceAuthoredChange,
  type WorkspaceAuthoredChangeDependencies,
  type WorkspaceAuthoredChangeInput,
} from "../../src/document-mutations/workspace-authored-change";

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const before = "before project";
const after = "after Genie edit";
const humanHead = "after Genie edit plus later human work";
const input: WorkspaceAuthoredChangeInput = {
  envelope: {
    memoryMode: "namespace", ownerId: "owner", actorId: "human-actor", agentId: "agent",
    roomId: "room", readableNamespaces: ["stale-envelope-ns"], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {},
  },
  sessionUserId: "human-user", artifactId: "artifact", expectedRevision: 3, expectedSha256: sha(humanHead),
};
function record(id = "entry", overrides: {
  mutation?: Partial<WorkspaceDocumentHistoryRecord["mutation"]>;
  entry?: Partial<WorkspaceDocumentHistoryRecord["entry"]>;
} = {}): WorkspaceDocumentHistoryRecord {
  return {
    mutation: {
      id: `mutation-${id}`, operationId: `operation-${id}`, ownerId: "owner", agentId: "agent", roomId: "room",
      actorKind: "agent", actorId: "agent", turnId: `turn-${id}`, ...overrides.mutation,
    },
    entry: {
      id, artifactInternalId: "artifact", mutationKind: "update", historyEligible: true,
      historyOperation: "file_tool", restoreFromEntryId: null,
      beforeLogicalPath: "cut.video.html", afterLogicalPath: "cut.video.html",
      beforeRevision: 1, afterRevision: 2, beforeStorageUri: "file:///before", afterStorageUri: "file:///after",
      beforeSize: bytes(before).length, afterSize: bytes(after).length, beforeSha256: sha(before), afterSha256: sha(after),
      ...overrides.entry,
    }, revisionId: `revision-${id}`,
  } as WorkspaceDocumentHistoryRecord;
}
function fixture(records: readonly WorkspaceDocumentHistoryRecord[] = [record()]) {
  const artifact = {
    id: "artifact", path: "cut.video.html", storageUri: "file:///head", size: bytes(humanHead).length,
    revision: 3, deletedAt: null,
  } as Artifact;
  const reads: string[] = [];
  const bodies = new Map([["file:///before", bytes(before)], ["file:///after", bytes(after)], ["file:///head", bytes(humanHead)]]);
  let proofs = 0;
  const deps: WorkspaceAuthoredChangeDependencies = {
    resolveCurrentArtifact: async (scope) => {
      expect(scope).toEqual({ humanActorId: "human-actor", agentId: "agent", roomId: "room", artifactInternalId: "artifact" });
      proofs++;
      return artifact;
    },
    listHistory: async () => records,
    readContent: async (uri) => {
      reads.push(uri);
      const body = bodies.get(uri);
      if (!body) throw new Error("private retained path must never be returned");
      return body;
    },
  };
  return { artifact, deps, reads, bodies, proofs: () => proofs };
}

describe("Workspace retained authored UI recovery", () => {
  test("returns verified original authored snapshots at a later human head, no receipt metadata", async () => {
    const f = fixture();
    expect(await readWorkspaceAuthoredChange(input, f.deps)).toEqual({
      kind: "ready", operationId: "operation-entry", author: { kind: "agent", displayName: "Genie" },
      before: { content: before, sha256: sha(before) }, after: { content: after, sha256: sha(after) }, currentSha256: sha(humanHead),
    });
    expect(f.reads).toEqual(["file:///head", "file:///before", "file:///after", "file:///head"]);
    expect(f.proofs()).toBe(3);
  });

  test.each(["roomId", "agentId"] as const)("never selects or reads same-artifact foreign %s history", async (field) => {
    const foreign = record("foreign", { mutation: { [field]: "private-elsewhere" }, entry: { beforeStorageUri: "file:///secret" } });
    const f = fixture([foreign, record()]);
    expect((await readWorkspaceAuthoredChange(input, f.deps)).kind).toBe("ready");
    expect(f.reads).not.toContain("file:///secret");
    const onlyForeign = fixture([foreign]);
    expect(await readWorkspaceAuthoredChange(input, onlyForeign.deps)).toEqual({ kind: "none" });
  });

  test("a second currently authorized human in the same Room can recover its Genie receipt", async () => {
    const f = fixture([record("collaborator", { mutation: { ownerId: "original-owner", userId: "original-human" } })]);
    const result = await readWorkspaceAuthoredChange(input, f.deps);
    expect(result.kind === "ready" && result.operationId).toBe("operation-collaborator");
    expect(JSON.stringify(result)).not.toContain("original-owner");
    expect(JSON.stringify(result)).not.toContain("original-human");
  });

  test("ignores other-artifact and noneligible rows without hiding the active agent behind a human checkpoint", async () => {
    const f = fixture([
      record("other", { entry: { artifactInternalId: "another", beforeStorageUri: "file:///secret" } }),
      record("autosave", { mutation: { actorKind: "human", actorId: "human-user" }, entry: { historyEligible: false } }),
      record("checkpoint", { mutation: { actorKind: "human", actorId: "human-user" } }), record(),
    ]);
    const result = await readWorkspaceAuthoredChange(input, f.deps);
    expect(result.kind === "ready" && result.operationId).toBe("operation-entry");
    expect(f.reads).not.toContain("file:///secret");
    const humanOnly = fixture([record("human", { mutation: { actorKind: "human", actorId: "human-user" } })]);
    expect(await readWorkspaceAuthoredChange(input, humanOnly.deps)).toEqual({ kind: "none" });
  });

  test.each(["undo", "undo_turn"])("does not resurrect canonical %s", async (operation) => {
    const f = fixture([record("undo", { entry: { historyOperation: operation, restoreFromEntryId: "entry" } }), record()]);
    expect(await readWorkspaceAuthoredChange(input, f.deps)).toEqual({ kind: "none" });
    expect(f.reads).toEqual(["file:///head", "file:///head"]);
  });

  test("canonical redo is a fresh authored update whose inverse can be shown", async () => {
    const f = fixture([
      record("redo", { entry: { historyOperation: "redo", restoreFromEntryId: "undo" } }),
      record("undo", { entry: { historyOperation: "undo", restoreFromEntryId: "entry" } }), record(),
    ]);
    const result = await readWorkspaceAuthoredChange(input, f.deps);
    expect(result.kind === "ready" && result.operationId).toBe("operation-redo");
  });

  test("broken lineage and mismatched agent authorship fail closed", async () => {
    for (const records of [
      [record("undo", { entry: { historyOperation: "undo", restoreFromEntryId: "pruned" } }), record()],
      [record("spoof", { mutation: { actorId: "another-agent" } })],
    ]) {
      const f = fixture(records);
      expect(await readWorkspaceAuthoredChange(input, f.deps)).toEqual({ kind: "unavailable", code: "history_unavailable" });
      expect(f.reads).toEqual(["file:///head"]);
    }
  });

  test.each([0, 1, 2])("missing/revoked current Room authority at proof %i withholds content", async (denyAt) => {
    const f = fixture();
    let call = 0;
    const result = await readWorkspaceAuthoredChange(input, { ...f.deps,
      resolveCurrentArtifact: async () => call++ === denyAt ? null : f.artifact,
    });
    expect(result).toEqual({ kind: "unavailable", code: "history_unavailable" });
    if (denyAt === 0) expect(f.reads).toEqual([]);
  });

  test("no session or Room cannot read retained bytes even with an envelope namespace snapshot", async () => {
    const f = fixture();
    expect((await readWorkspaceAuthoredChange({ ...input, sessionUserId: "" }, f.deps)).kind).toBe("unavailable");
    expect((await readWorkspaceAuthoredChange({ ...input, envelope: { ...input.envelope, roomId: "" } }, f.deps)).kind).toBe("unavailable");
    expect(f.reads).toEqual([]);
  });

  test.each(["beforeSha256", "afterSha256", "beforeSize", "afterSize", "beforeStorageUri", "afterStorageUri"] as const)("corrupt/missing %s is unavailable, never a partial snapshot", async (field) => {
    const value = field.endsWith("Size") ? 123 : field.endsWith("Sha256") ? "0".repeat(64) : "file:///missing";
    const f = fixture([record("bad", { entry: { [field]: value } })]);
    expect(await readWorkspaceAuthoredChange(input, f.deps)).toEqual({ kind: "unavailable", code: "history_unavailable" });
  });

  test("only current-path update shapes are recoverable", async () => {
    for (const entry of [{ mutationKind: "rename" }, { beforeLogicalPath: "old-name" }, { afterRevision: 8 }]) {
      const f = fixture([record("unsupported", { entry })]);
      expect((await readWorkspaceAuthoredChange(input, f.deps)).kind).toBe("unavailable");
      expect(f.reads).toEqual(["file:///head"]);
    }
  });

  test("version or bytes changing during snapshot load fails closed", async () => {
    for (const changeBytes of [false, true]) {
      const f = fixture();
      const result = await readWorkspaceAuthoredChange(input, { ...f.deps, readContent: async (uri, size) => {
        const value = await f.deps.readContent!(uri, size);
        if (uri === "file:///after") {
          if (changeBytes) f.bodies.set("file:///head", bytes("changed"));
          else f.artifact.revision++;
        }
        return value;
      } });
      expect(result).toEqual({ kind: "unavailable", code: "document_changed" });
    }
  });

  test("stale expected hash/revision reads no history payloads", async () => {
    for (const drift of [{ expectedSha256: "0".repeat(64) }, { expectedRevision: 4 }]) {
      const f = fixture();
      expect(await readWorkspaceAuthoredChange({ ...input, ...drift }, f.deps)).toEqual({ kind: "unavailable", code: "document_changed" });
      expect(f.reads.every((uri) => uri === "file:///head")).toBe(true);
    }
  });

  test("uses real retained raw file URIs with # and %, preserves BOM, rejects invalid UTF-8", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-authored-"));
    try {
      const retained = join(root, "snapshot #%.html");
      const head = join(root, "head.html");
      await writeFile(head, humanHead);
      for (const content of [bytes("\uFEFFbefore"), new Uint8Array([255])]) {
        await writeFile(retained, content);
        const uri = `file://${retained}`;
        const f = fixture([record("real", { entry: {
          beforeStorageUri: uri, afterStorageUri: uri, beforeSize: content.length, afterSize: content.length,
          beforeSha256: sha(content), afterSha256: sha(content),
        } })]);
        f.artifact.storageUri = `file://${head}`;
        const result = await readWorkspaceAuthoredChange(input, {
          resolveCurrentArtifact: f.deps.resolveCurrentArtifact!, listHistory: f.deps.listHistory!,
        });
        if (content[0] === 255) expect(result.kind).toBe("unavailable");
        else expect(result.kind === "ready" && result.before.content).toBe("\uFEFFbefore");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
