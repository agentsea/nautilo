/**
 * Isolated because Bun's mock.module replacements are process-global and sticky.
 * Exercises the binary writer with real filesystem bytes while keeping artifact
 * resolution and authoritative row persistence hermetic.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const testRoot = await mkdtemp(join(tmpdir(), "nautilo-binary-partial-write-"));
let physicalPath = join(testRoot, "artifact.bin");
let logicalPath = "exports/artifact.bin";
let existingArtifact = true;
let rowOutcome: "throw" | "null" = "throw";

const applyWorkspaceArtifactRowChange = mock(async () => {
  if (rowOutcome === "throw") throw new Error("row transaction unavailable");
  return null;
});

const resolveWorkspaceArtifact = mock(async (input: {
  logicalPath: string;
  intent: "read" | "mutate" | "create" | "create_or_update";
}) => ({
  ok: true as const,
  artifact: existingArtifact ? { id: "row-1" } : null,
  physicalPath,
  artifactId: "artifact-1",
  storageUri: `file://${physicalPath}`,
  logicalPath: input.logicalPath,
}));

mock.module("../../../agent/src/tools/file/artifact-store", () => ({
  applyWorkspaceArtifactRowChange,
  envelopeFactsForArtifacts: () => ({
    ok: true as const,
    facts: {
      userId: "user-1",
      agentId: "agent-1",
      readableNamespaces: ["namespace-1"],
      mutableNamespaces: ["namespace-1"],
      writableNamespaces: ["namespace-1"],
    },
  }),
  resolveWorkspaceArtifact,
  validateLogicalPath: (value: unknown) =>
    typeof value === "string" && value.length > 0
      ? { ok: true as const, path: value }
      : { ok: false as const, reason: "path is required" },
}));

const { createWorkspaceBinaryArtifact } = await import(
  "../../../agent/src/tools/file/workspace-binary-artifact"
);

const NEW_BYTES = Buffer.from("new binary output");

beforeEach(() => {
  applyWorkspaceArtifactRowChange.mockClear();
  resolveWorkspaceArtifact.mockClear();
  physicalPath = join(testRoot, `${randomUUID()}.bin`);
  logicalPath = "exports/artifact.bin";
  existingArtifact = true;
  rowOutcome = "throw";
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function create(overwrite: boolean) {
  return createWorkspaceBinaryArtifact({
    envelope: {} as never,
    actor: { kind: "agent", agentId: "agent-1" },
    logicalPath,
    mimeType: "image/png",
    overwrite,
    bytes: NEW_BYTES,
  });
}

function expectPartialWrite(result: Awaited<ReturnType<typeof create>>) {
  if (result.ok) throw new Error("Expected an uncertain partial-write failure.");
  expect(result).toMatchObject({
    ok: false,
    code: "PARTIAL_WRITE",
    displayPath: logicalPath,
    bytesWritten: NEW_BYTES.byteLength,
    metadataConfirmed: false,
    stateChanged: true,
    retrySafe: false,
  });
  expect(result.message).toContain(logicalPath);
  expect(result.message).toContain(`${NEW_BYTES.byteLength} bytes`);
  expect(result.message).toContain("reconciled before retrying");
  expect(result).not.toHaveProperty("artifactId");
  expect(result).not.toHaveProperty("sha256");
  return result;
}

describe("workspace binary artifact partial writes", () => {
  test("retains intentionally overwritten bytes when row persistence throws", async () => {
    await mkdir(dirname(physicalPath), { recursive: true });
    await writeFile(physicalPath, "old bytes");

    const result = await create(true);

    expectPartialWrite(result);
    expect(await readFile(physicalPath)).toEqual(NEW_BYTES);
    expect(resolveWorkspaceArtifact).toHaveBeenCalledWith(expect.objectContaining({
      intent: "create_or_update",
    }));
  });

  test("retains fresh bytes when row creation throws", async () => {
    existingArtifact = false;

    const result = await create(false);

    expectPartialWrite(result);
    expect(await readFile(physicalPath)).toEqual(NEW_BYTES);
    expect(resolveWorkspaceArtifact).toHaveBeenCalledWith(expect.objectContaining({
      intent: "create",
    }));
  });

  test("treats a null row result as an uncertain partial write", async () => {
    rowOutcome = "null";
    await mkdir(dirname(physicalPath), { recursive: true });
    await writeFile(physicalPath, "old bytes");

    const result = await create(true);

    const failure = expectPartialWrite(result);
    expect(failure.message).toContain("row changed or disappeared");
    expect(await readFile(physicalPath)).toEqual(NEW_BYTES);
  });
});
