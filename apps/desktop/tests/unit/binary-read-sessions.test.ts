import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asBinaryReadSessionResult,
  BinaryReadSessionError,
  BinaryReadSessionManager,
} from "../../electron/binary-read-sessions";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "binary-read-session-"));
  temporaryRoots.push(root);
  return await fs.realpath(root);
}

function managerFor(root: string, overrides: Partial<ConstructorParameters<typeof BinaryReadSessionManager>[0]> = {}) {
  return new BinaryReadSessionManager({
    assertPathInAllowedRoot: (candidate) => {
      if (candidate !== root && !candidate.startsWith(`${root}/`)) {
        throw new Error("outside allowed root");
      }
    },
    chunkBytes: 4,
    maxFileBytes: 16,
    maxTotalBytes: 16,
    maxSessions: 3,
    maxSessionsPerSender: 2,
    inactivityTtlMs: 100,
    ...overrides,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("Expected binary-read request to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(BinaryReadSessionError);
    expect((error as BinaryReadSessionError).code).toBe(code);
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("BinaryReadSessionManager (D431)", () => {
  test("converts internal failures to a serializable sanitized IPC envelope", async () => {
    const root = await makeRoot();
    const target = join(root, "too-large.docx");
    await fs.writeFile(target, Buffer.alloc(17));
    const manager = managerFor(root);

    const sizeFailure = await asBinaryReadSessionResult(() => manager.open(1, target));
    expect(sizeFailure).toEqual({ ok: false, error: { code: "size_limit" } });
    expect(JSON.parse(JSON.stringify(sizeFailure))).toEqual({
      ok: false,
      error: { code: "size_limit" },
    });

    const unknownFailure = await asBinaryReadSessionResult(async () => {
      throw new Error(target);
    });
    expect(unknownFailure).toEqual({ ok: false, error: { code: "unavailable" } });
  });

  test("returns fixed-size, ordered Uint8Array chunks and closes at EOF", async () => {
    const root = await makeRoot();
    const target = join(root, "slides.pptx");
    await fs.writeFile(target, Buffer.from("0123456789"));
    const manager = managerFor(root);

    const opened = await manager.open(41, target);
    expect(opened.size).toBe(10);
    expect(opened.chunkSize).toBe(4);

    const first = await manager.read(41, opened.id, 0);
    expect(first.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(first.bytes).toString()).toBe("0123");
    expect(first).toMatchObject({ position: 4, done: false });
    await expectCode(manager.read(41, opened.id, 0), "out_of_order");

    const second = await manager.read(41, opened.id, 4);
    expect(Buffer.from(second.bytes).toString()).toBe("4567");
    const last = await manager.read(41, opened.id, 8);
    expect(Buffer.from(last.bytes).toString()).toBe("89");
    expect(last).toMatchObject({ position: 10, done: true });
    expect(manager.activeSessionCount).toBe(0);
    await manager.close(41, opened.id); // EOF cleanup makes explicit close safe.
  });

  test("binds sessions to one sender and cleans them up when that sender is destroyed", async () => {
    const root = await makeRoot();
    const target = join(root, "owned.docx");
    await fs.writeFile(target, "abcdefgh");
    const manager = managerFor(root);
    const opened = await manager.open(7, target);

    await expectCode(manager.read(8, opened.id, 0), "sender_mismatch");
    await expectCode(manager.close(8, opened.id), "sender_mismatch");
    await manager.closeForSender(7);
    expect(manager.activeSessionCount).toBe(0);
    await expectCode(manager.read(7, opened.id, 0), "session_not_found");

    await manager.open(9, target);
    await manager.closeAll();
    expect(manager.activeSessionCount).toBe(0);
  });

  test("fails closed for oversized files, directories, and canonical paths outside the allowed root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const oversized = join(root, "too-large.xlsx");
    await fs.writeFile(oversized, Buffer.alloc(17));
    const manager = managerFor(root);

    await expectCode(manager.open(1, oversized), "size_limit");
    await expectCode(manager.open(1, root), "not_file");
    await expectCode(manager.open(1, join(outside, "missing.pptx")), "not_found");
    const foreign = join(outside, "foreign.pptx");
    await fs.writeFile(foreign, "foreign");
    await expectCode(manager.open(1, foreign), "unavailable");
  });

  test("enforces per-sender and aggregate session budgets", async () => {
    const root = await makeRoot();
    const first = join(root, "one.docx");
    const second = join(root, "two.docx");
    const third = join(root, "three.docx");
    await Promise.all([first, second, third].map((file) => fs.writeFile(file, "12345678")));
    const manager = managerFor(root, { maxTotalBytes: 15, maxSessionsPerSender: 1 });

    const opened = await manager.open(1, first);
    await expectCode(manager.open(1, second), "session_limit");
    await expectCode(manager.open(2, second), "session_limit");
    await manager.close(1, opened.id);
    expect((await manager.open(2, third)).id).toEqual(expect.any(String));
  });

  test("rejects a file version change and expires idle sessions without retaining handles", async () => {
    const root = await makeRoot();
    const target = join(root, "changing.pptx");
    const replacement = join(root, "replacement.pptx");
    await fs.writeFile(target, "abcdefgh");
    const manager = managerFor(root);
    const opened = await manager.open(3, target);
    await fs.writeFile(replacement, "ijklmnop");
    await fs.rename(replacement, target);
    await expectCode(manager.read(3, opened.id, 0), "mutated");
    expect(manager.activeSessionCount).toBe(0);

    let now = 0;
    const expiring = managerFor(root, { now: () => now, inactivityTtlMs: 10 });
    const idle = await expiring.open(3, target);
    now = 10;
    await expectCode(expiring.read(3, idle.id, 0), "expired");
    expect(expiring.activeSessionCount).toBe(0);
    await expiring.closeAll();
  });
});
