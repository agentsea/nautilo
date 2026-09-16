import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as db from "@nautilo/db";
import * as trust from "@nautilo/trust";
import { resolveWorkspaceArtifact, type EnvelopeFacts } from "../../src/tools/file/artifact-store";
import * as trustAgentDb from "../../src/store/trust-agent-db";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const MOCK_CONN = {} as never;

function facts(over?: Partial<EnvelopeFacts>): EnvelopeFacts {
  return {
    userId: USER_ID,
    agentId: AGENT_ID,
    readableNamespaces: ["read-ns"],
    mutableNamespaces: ["mut-ns"],
    writableNamespaces: ["write-ns"],
    ...over,
  };
}

function baseRow() {
  const physical = path.join(os.tmpdir(), "m088b-artifact-resolve", "art1");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agentId: AGENT_ID,
    artifactId: "art-uuid-1",
    path: "notes.md",
    mimeType: "text/markdown",
    size: 42,
    storageUri: `file://${physical}`,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null as Date | null,
  };
}

function artifactRow(over?: Partial<ReturnType<typeof baseRow>>) {
  return { ...baseRow(), ...over };
}

describe("resolveWorkspaceArtifact (M088B junction shape)", () => {
  const restores: Array<() => void> = [];
  let tmpRoot: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m088b-art-root-"));
    prevEnv = process.env["NAUTILO_ARTIFACTS_ROOT"];
    process.env["NAUTILO_ARTIFACTS_ROOT"] = tmpRoot;
    const spTrust = spyOn(trustAgentDb, "withAgentTrustContext").mockImplementation(
      async (_ctx, fn) => fn({} as never),
    );
    restores.push(() => spTrust.mockRestore());
    const spWrite = spyOn(trust, "assertCanWriteArtifacts").mockResolvedValue();
    restores.push(() => spWrite.mockRestore());
  });

  afterEach(async () => {
    while (restores.length) restores.pop()!();
    if (prevEnv === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
    else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevEnv;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test("read + existing row → ok with physicalPath from storage_uri", async () => {
    const row = artifactRow();
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(row as never);
    restores.push(() => sp.mockRestore());

    const r = await resolveWorkspaceArtifact({
      logicalPath: "notes.md",
      facts: facts(),
      intent: "read",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact).toEqual(row);
      expect(r.artifactId).toBe("art-uuid-1");
      expect(r.storageUri).toBe(row.storageUri);
      expect(r.physicalPath).toBe(row.storageUri.replace(/^file:\/\//, ""));
    }
    expect(sp).toHaveBeenCalledWith(
      {
        path: "notes.md",
        readableNamespaceIds: ["read-ns"],
      },
      MOCK_CONN,
    );
  });

  test("read + missing row → ok:false with expected message", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    const r = await resolveWorkspaceArtifact({
      logicalPath: "missing.md",
      facts: facts(),
      intent: "read",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('No workspace artifact found at "missing.md"');
    }
  });

  test("mutate uses mutableNamespaces for lookup (readableNamespaceIds arg)", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    await resolveWorkspaceArtifact({
      logicalPath: "x.md",
      facts: facts({ mutableNamespaces: ["m-a", "m-b"] }),
      intent: "mutate",
    });
    expect(sp).toHaveBeenCalledWith(
      {
        path: "x.md",
        readableNamespaceIds: ["m-a", "m-b"],
      },
      MOCK_CONN,
    );
  });

  test("mutate checks write capability only after the exact Artifact resolves", async () => {
    const row = artifactRow();
    const spFind = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(
      row as never,
    );
    restores.push(() => spFind.mockRestore());
    const denial = new trust.ArtifactWriteDeniedError({
      humanUserId: USER_ID,
      artifactId: row.id,
    });
    const spWrite = spyOn(trust, "assertCanWriteArtifacts").mockRejectedValue(
      denial,
    );
    restores.push(() => spWrite.mockRestore());

    let caught: unknown;
    try {
      await resolveWorkspaceArtifact({
        logicalPath: "notes.md",
        facts: facts(),
        intent: "mutate",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(denial);
    expect(spFind).toHaveBeenCalledTimes(1);
    expect(spWrite).toHaveBeenCalledWith({
      humanUserId: USER_ID,
      artifactId: row.id,
    });
  });

  test("create + existing row → ok:false already exists", async () => {
    const row = artifactRow();
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(row as never);
    restores.push(() => sp.mockRestore());

    const r = await resolveWorkspaceArtifact({
      logicalPath: "notes.md",
      facts: facts(),
      intent: "create",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("already exists at workspace path");
    }
    expect(sp).toHaveBeenCalledWith(
      {
        path: "notes.md",
        readableNamespaceIds: ["mut-ns"],
      },
      MOCK_CONN,
    );
  });

  test("create + mints new artifactId and physical path under getArtifactsRoot()", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    const r = await resolveWorkspaceArtifact({
      logicalPath: "new.md",
      facts: facts(),
      intent: "create",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact).toBeNull();
      expect(r.storageUri.startsWith("file://")).toBe(true);
      // Path lives under the server-owned root, NOT under any
      // client-supplied workspaceRoot.
      expect(r.physicalPath).toBe(path.join(tmpRoot, r.artifactId));
      expect(r.artifactId).toMatch(/^[0-9a-f-]{36}$/i);
    }
    expect(sp).toHaveBeenCalled();
  });

  test("create_or_update + existing → ok with existing row", async () => {
    const row = artifactRow();
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(row as never);
    restores.push(() => sp.mockRestore());

    const r = await resolveWorkspaceArtifact({
      logicalPath: "notes.md",
      facts: facts(),
      intent: "create_or_update",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact).toEqual(row);
      expect(r.artifactId).toBe("art-uuid-1");
    }
  });

  test("create_or_update + no existing → mints fresh id under server root", async () => {
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => sp.mockRestore());

    const r = await resolveWorkspaceArtifact({
      logicalPath: "fresh.md",
      facts: facts(),
      intent: "create_or_update",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact).toBeNull();
      expect(r.artifactId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(r.storageUri.startsWith("file://")).toBe(true);
      expect(r.physicalPath.startsWith(tmpRoot)).toBe(true);
    }
  });

  test("row with non-file storage_uri → ok:false unrecognized scheme", async () => {
    const row = artifactRow({ storageUri: "s3://bucket/key" });
    const sp = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(row as never);
    restores.push(() => sp.mockRestore());

    const r = await resolveWorkspaceArtifact({
      logicalPath: "notes.md",
      facts: facts(),
      intent: "read",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("unrecognized storage_uri scheme");
    }
  });
});
