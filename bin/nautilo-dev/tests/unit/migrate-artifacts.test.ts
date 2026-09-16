/**
 * M088B — `runMigrateArtifacts` unit tests (in-memory fakes, no Postgres).
 */
import { describe, test, expect } from "bun:test";
import path, { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  runMigrateArtifacts,
  type MigrateArtifactsDeps,
  type MigrateArtifactsLogger,
} from "../../src/commands/migrate-artifacts";
import { recordingLogger } from "./logto-migration-helpers";

const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function norm(p: string): string {
  return path.normalize(p);
}

interface FakeArt {
  id: string;
  storageUri: string;
  path?: string | undefined;
  agentId?: string | undefined;
  externalArtifactId?: string | undefined;
  size?: number | undefined;
}

function makeHarness() {
  const documentsNautiloRoot = join("/home", "op", "Documents", "Nautilo");
  const artifactsRoot = join("/srv", "artifacts-root");
  const receiptsDir = join("/tmp", "receipts");
  const userHome = join("/home", "op");

  const artifacts = new Map<string, FakeArt>();
  const junctionNsByArtifact = new Map<string, Set<string>>();
  const files = new Map<string, string>();

  const calls = {
    passARelocate: 0,
    passBIngest: 0,
    writeReceipt: 0,
    passAListRows: 0,
  };

  let uuidN = 0;
  const randomUUID = () => {
    uuidN += 1;
    return `f0000000-0000-4000-8000-${String(10000 + uuidN).padStart(12, "0")}`;
  };

  const log = recordingLogger() as unknown as MigrateArtifactsLogger;

  const deps: MigrateArtifactsDeps = {
    log,
    paths: {
      userHome,
      documentsNautiloRoot,
      artifactsRoot,
      receiptsDir,
    },
    timestampIso: "2026-05-12T12:00:00.000Z",
    randomUUID,
    passAListRows: async ({ legacyStorageUriPrefix, limit }) => {
      calls.passAListRows += 1;
      const rows = [...artifacts.values()]
        .filter((a) => a.storageUri.startsWith(legacyStorageUriPrefix))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({ id: a.id, storageUri: a.storageUri }));
      if (typeof limit === "number" && limit > 0) {
        return rows.slice(0, limit);
      }
      return rows;
    },
    passARelocateRow: async (p) => {
      calls.passARelocate += 1;
      const body = files.get(norm(p.oldFsPath));
      if (body === undefined) {
        throw new Error(`missing source file ${p.oldFsPath}`);
      }
      files.delete(norm(p.oldFsPath));
      files.set(norm(p.newFsPath), body);
      const row = artifacts.get(p.artifactRowId);
      if (!row) throw new Error("artifact row missing");
      row.storageUri = p.newStorageUri;
    },
    passAHasJunction: async (artifactRowId) => {
      return (junctionNsByArtifact.get(artifactRowId)?.size ?? 0) > 0;
    },
    resolveOperatorTarget: async () => ({ namespaceId: NS, agentId: AGENT }),
    listPassBFileEntries: async () => {
      return [...files.entries()]
        .filter(([abs]) => !abs.includes(`${path.sep}.artifacts${path.sep}`))
        .filter(([abs]) => abs.startsWith(documentsNautiloRoot + path.sep))
        .map(([absolutePath, _]) => {
          const relativePosix = path
            .relative(documentsNautiloRoot, absolutePath)
            .split(path.sep)
            .join("/");
          return {
            absolutePath: norm(absolutePath),
            relativePosix,
            size: Buffer.byteLength(files.get(absolutePath) ?? "", "utf-8"),
          };
        })
        .sort((a, b) => a.relativePosix.localeCompare(b.relativePosix));
    },
    passBShouldSkip: async (p) => {
      const absNorm = norm(p.absolutePath);
      for (const art of artifacts.values()) {
        if (art.agentId !== p.agentId) continue;
        const nsSet = junctionNsByArtifact.get(art.id);
        const attached = nsSet?.has(p.namespaceId) ?? false;
        if (!attached) continue;
        if (art.path === p.relativePosix) return true;
        try {
          if (norm(fileURLToPath(art.storageUri)) === absNorm) return true;
        } catch {
          /* ignore */
        }
      }
      return false;
    },
    passBIngest: async (p) => {
      calls.passBIngest += 1;
      const body = files.get(norm(p.sourceAbsolutePath));
      if (body === undefined) throw new Error("missing source for pass B");
      files.set(norm(p.newFsPath), body);
      artifacts.set(p.newArtifactRowId, {
        id: p.newArtifactRowId,
        storageUri: p.newStorageUri,
        path: p.relativePosix,
        agentId: p.agentId,
        externalArtifactId: p.externalArtifactId,
        size: p.size,
      });
      let set = junctionNsByArtifact.get(p.newArtifactRowId);
      if (!set) {
        set = new Set();
        junctionNsByArtifact.set(p.newArtifactRowId, set);
      }
      set.add(p.namespaceId);
    },
    writeReceipt: async () => {
      calls.writeReceipt += 1;
    },
  };

  return {
    deps,
    artifacts,
    junctionNsByArtifact,
    files,
    calls,
    documentsNautiloRoot,
    artifactsRoot,
  };
}

describe("runMigrateArtifacts", () => {
  test("Pass A relocates legacy .artifacts file → artifactsRoot/<row id> and updates storage_uri", async () => {
    const h = makeHarness();
    const oldFs = join(h.documentsNautiloRoot, ".artifacts", "legacy-blob");
    const oldUri = pathToFileURL(oldFs).href;
    h.artifacts.set(ROW_A, { id: ROW_A, storageUri: oldUri });
    h.files.set(norm(oldFs), "payload-a");
    junctionNsByArtifactSet(h, ROW_A, NS);

    const code = await runMigrateArtifacts({}, h.deps);
    expect(code).toBe(0);
    expect(h.calls.passARelocate).toBe(1);
    const newFs = norm(join(h.artifactsRoot, ROW_A));
    expect(h.files.get(newFs)).toBe("payload-a");
    expect(h.artifacts.get(ROW_A)?.storageUri).toBe(pathToFileURL(newFs).href);
    expect(h.calls.writeReceipt).toBe(1);
  });

  test("Pass B inserts artifact + junction for an unindexed flat file", async () => {
    const h = makeHarness();
    const flat = join(h.documentsNautiloRoot, "notes", "hello.txt");
    h.files.set(norm(flat), "hello");

    const code = await runMigrateArtifacts({}, h.deps);
    expect(code).toBe(0);
    expect(h.calls.passBIngest).toBe(1);
    const ingested = [...h.artifacts.values()].find((a) => a.path === "notes/hello.txt");
    expect(ingested).toBeDefined();
    expect(ingested?.agentId).toBe(AGENT);
    expect(h.junctionNsByArtifact.get(ingested!.id)?.has(NS)).toBe(true);
  });

  test("re-run is idempotent (no double relocation, no double insert)", async () => {
    const h = makeHarness();
    const oldFs = join(h.documentsNautiloRoot, ".artifacts", "blob");
    h.artifacts.set(ROW_A, { id: ROW_A, storageUri: pathToFileURL(oldFs).href });
    h.files.set(norm(oldFs), "x");
    junctionNsByArtifactSet(h, ROW_A, NS);

    const flat = join(h.documentsNautiloRoot, "readme.md");
    h.files.set(norm(flat), "readme");

    await runMigrateArtifacts({}, h.deps);
    h.calls.passARelocate = 0;
    h.calls.passBIngest = 0;
    h.calls.writeReceipt = 0;

    await runMigrateArtifacts({}, h.deps);
    expect(h.calls.passARelocate).toBe(0);
    expect(h.calls.passBIngest).toBe(0);
  });

  test("--dry-run performs zero writes (no relocate, no ingest, no receipt)", async () => {
    const h = makeHarness();
    const oldFs = join(h.documentsNautiloRoot, ".artifacts", "b");
    h.artifacts.set(ROW_A, { id: ROW_A, storageUri: pathToFileURL(oldFs).href });
    h.files.set(norm(oldFs), "z");
    junctionNsByArtifactSet(h, ROW_A, NS);
    h.files.set(norm(join(h.documentsNautiloRoot, "a.txt")), "flat");

    const code = await runMigrateArtifacts({ dryRun: true }, h.deps);
    expect(code).toBe(0);
    expect(h.calls.passARelocate).toBe(0);
    expect(h.calls.passBIngest).toBe(0);
    expect(h.calls.writeReceipt).toBe(0);
    expect(h.artifacts.get(ROW_A)?.storageUri).toBe(pathToFileURL(oldFs).href);
  });

  test("Pass B is skipped (with explicit error) when resolveOperatorTarget returns null", async () => {
    const h = makeHarness();
    h.deps.resolveOperatorTarget = async () => null;
    h.files.set(norm(join(h.documentsNautiloRoot, "notes", "x.md")), "x");

    const errors: string[] = [];
    h.deps.log = {
      info: () => {},
      warn: () => {},
      error: (m) => errors.push(m),
    };

    const code = await runMigrateArtifacts({}, h.deps);
    expect(code).toBe(1);
    expect(h.calls.passBIngest).toBe(0);
    expect(errors.some((m) => m.startsWith("Pass B skipped:"))).toBe(true);
  });

  test("--limit 1 bounds Pass A to one row", async () => {
    const h = makeHarness();
    const oldA = join(h.documentsNautiloRoot, ".artifacts", "a");
    const oldB = join(h.documentsNautiloRoot, ".artifacts", "b");
    h.artifacts.set(ROW_A, { id: ROW_A, storageUri: pathToFileURL(oldA).href });
    h.artifacts.set(ROW_B, { id: ROW_B, storageUri: pathToFileURL(oldB).href });
    h.files.set(norm(oldA), "1");
    h.files.set(norm(oldB), "2");
    junctionNsByArtifactSet(h, ROW_A, NS);
    junctionNsByArtifactSet(h, ROW_B, NS);

    await runMigrateArtifacts({ limit: 1 }, h.deps);
    expect(h.calls.passARelocate).toBe(1);
    const relocated = h.calls.passARelocate === 1 && h.files.has(norm(join(h.artifactsRoot, ROW_A)));
    const notRelocatedOther =
      h.artifacts.get(ROW_B)?.storageUri === pathToFileURL(oldB).href;
    expect(relocated).toBe(true);
    expect(notRelocatedOther).toBe(true);
  });
});

function junctionNsByArtifactSet(
  h: ReturnType<typeof makeHarness>,
  artifactId: string,
  ns: string,
): void {
  let s = h.junctionNsByArtifact.get(artifactId);
  if (!s) {
    s = new Set();
    h.junctionNsByArtifact.set(artifactId, s);
  }
  s.add(ns);
}
