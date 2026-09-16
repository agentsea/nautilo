import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceDocumentMutationContentHashMismatchError,
  writeWorkspaceDocumentMutationContent,
  writeWorkspaceDocumentMutationLiveContent,
  type WorkspaceDocumentMutationContentFileOps,
} from "../../src/lib/workspace-document-mutation-content";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nautilo-d448-content-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const nodeOps: WorkspaceDocumentMutationContentFileOps = {
  mkdir,
  readFile,
  open,
  rename,
  unlink,
};

describe("writeWorkspaceDocumentMutationContent", () => {
  test("mints distinct verified mutable live objects for identical content", async () => {
    await withTempRoot(async (root) => {
      const bytes = new TextEncoder().encode("same bytes");
      const digest = sha256(bytes);
      const receipt = await writeWorkspaceDocumentMutationContent({ artifactsRoot: root, bytes, sha256: digest });
      const first = await writeWorkspaceDocumentMutationLiveContent({ artifactsRoot: root, bytes, sha256: digest });
      const second = await writeWorkspaceDocumentMutationLiveContent({ artifactsRoot: root, bytes, sha256: digest });
      expect(first.storageUri).not.toBe(second.storageUri);
      expect(first.storageUri).not.toBe(receipt.storageUri);
      await writeFile(first.absolutePath, "overwritten");
      expect(await readFile(second.absolutePath)).toEqual(Buffer.from(bytes));
      expect(await readFile(receipt.absolutePath)).toEqual(Buffer.from(bytes));
    });
  });
  test("writes content-addressed bytes atomically and verifies reuse", async () => {
    await withTempRoot(async (root) => {
      const bytes = new TextEncoder().encode("candidate post-image\n");
      const digest = sha256(bytes);
      const first = await writeWorkspaceDocumentMutationContent({
        artifactsRoot: root,
        bytes,
        sha256: digest,
      });
      expect(first.reused).toBe(false);
      expect(first.storageUri).toStartWith("file://");
      expect(await readFile(first.absolutePath)).toEqual(Buffer.from(bytes));

      const second = await writeWorkspaceDocumentMutationContent({
        artifactsRoot: root,
        bytes,
        sha256: digest,
      });
      expect(second).toMatchObject({
        absolutePath: first.absolutePath,
        sha256: digest,
        size: bytes.byteLength,
        reused: true,
      });
    });
  });

  test("rejects a declared hash mismatch before it writes anything", async () => {
    await withTempRoot(async (root) => {
      const bytes = new TextEncoder().encode("candidate");
      expect(writeWorkspaceDocumentMutationContent({
        artifactsRoot: root,
        bytes,
        sha256: "0".repeat(64),
      })).rejects.toBeInstanceOf(WorkspaceDocumentMutationContentHashMismatchError);
    });
  });

  test("uses the existing raw file URI convention for roots containing spaces", async () => {
    await withTempRoot(async (root) => {
      const spacedRoot = join(root, "artifact root with spaces");
      const bytes = new TextEncoder().encode("spaced candidate");
      const result = await writeWorkspaceDocumentMutationContent({
        artifactsRoot: spacedRoot,
        bytes,
        sha256: sha256(bytes),
      });
      expect(result.storageUri).toBe(`file://${result.absolutePath}`);
      expect(result.storageUri).toContain("artifact root with spaces");
      expect(result.storageUri).not.toContain("%20");
    });
  });

  test("refuses a corrupt object already at the content-addressed path", async () => {
    await withTempRoot(async (root) => {
      const bytes = new TextEncoder().encode("expected candidate");
      const digest = sha256(bytes);
      const path = join(root, "workspace-document-mutation-content", "sha256", digest.slice(0, 2), digest);
      await mkdir(join(root, "workspace-document-mutation-content", "sha256", digest.slice(0, 2)), { recursive: true });
      await writeFile(path, "corrupt");
      expect(writeWorkspaceDocumentMutationContent({
        artifactsRoot: root,
        bytes,
        sha256: digest,
      })).rejects.toBeInstanceOf(WorkspaceDocumentMutationContentHashMismatchError);
    });
  });

  test("surfaces write failure and leaves no visible final object", async () => {
    await withTempRoot(async (root) => {
      const bytes = new TextEncoder().encode("candidate");
      const digest = sha256(bytes);
      const failingOps: WorkspaceDocumentMutationContentFileOps = {
        ...nodeOps,
        open: async (path, flags, mode) => {
          if (flags === "wx") throw new Error("simulated durable write failure");
          return nodeOps.open(path, flags, mode);
        },
      };
      expect(writeWorkspaceDocumentMutationContent({
        artifactsRoot: root,
        bytes,
        sha256: digest,
        fileOps: failingOps,
      })).rejects.toThrow("simulated durable write failure");
      expect(readFile(
        join(root, "workspace-document-mutation-content", "sha256", digest.slice(0, 2), digest),
      )).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
