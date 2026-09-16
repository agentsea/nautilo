import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readLaunchReceipt,
  updateLaunchReceipt,
  writeLaunchReceipt,
  type LaunchReceipt,
} from "../../src";

const t0 = "2026-08-03T12:00:00.000Z";
const t1 = "2026-08-03T12:01:00.000Z";

function initial(overrides: Partial<LaunchReceipt> = {}): LaunchReceipt {
  return {
    schemaVersion: 1,
    launchId: "launch-488",
    backend: "railway",
    revision: 0,
    stage: "planned",
    resources: [],
    cleanup: { state: "not-required" },
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
}

let directory: string;
let receiptPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nautilo-launch-receipt-"));
  receiptPath = join(directory, "receipt.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("launch receipt store", () => {
  test("creates and reads an owner-only canonical initial receipt", async () => {
    await writeLaunchReceipt(receiptPath, initial());

    expect(await readLaunchReceipt(receiptPath)).toEqual(initial());
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
  });

  test("is create-only and rejects noncanonical initial state", async () => {
    await writeLaunchReceipt(receiptPath, initial());
    expect(await rejected(writeLaunchReceipt(receiptPath, initial()))).toMatchObject({
      code: "revision-conflict",
    });
    expect(
      await rejected(
        writeLaunchReceipt(receiptPath, initial({ revision: 1, updatedAt: t1 })),
      ),
    ).toMatchObject({ code: "invalid-receipt" });
    expect(await readLaunchReceipt(receiptPath)).toEqual(initial());
  });

  test("updates under an expected revision and persists exact resources", async () => {
    await writeLaunchReceipt(receiptPath, initial());
    const updated = await updateLaunchReceipt(
      receiptPath,
      { expectedRevision: 0 },
      (current) => ({
        ...current,
        revision: 1,
        stage: "authorized",
        resources: [{ kind: "project", id: "project-1", name: "Nautilo" }],
        updatedAt: t1,
      }),
    );

    expect(updated.revision).toBe(1);
    expect(await readLaunchReceipt(receiptPath)).toEqual(updated);
    expect(
      await rejected(
        updateLaunchReceipt(receiptPath, { expectedRevision: 0 }, (current) => current),
      ),
    ).toMatchObject({ code: "revision-conflict" });
  });

  test("an interruption before rename preserves the last good receipt", async () => {
    await writeLaunchReceipt(receiptPath, initial());
    let unpublishedMode: number | undefined;
    const interruption = await rejected(
      updateLaunchReceipt(
        receiptPath,
        {
          expectedRevision: 0,
          hooks: {
            beforeRename: async () => {
              const unpublished = (await readdir(directory)).find((entry) =>
                entry.endsWith(".tmp"),
              );
              if (unpublished === undefined) throw new Error("missing durable temp");
              unpublishedMode = (await stat(join(directory, unpublished))).mode & 0o777;
              throw new Error("simulated interruption");
            },
          },
        },
        (current) => ({
          ...current,
          revision: 1,
          stage: "authorized",
          updatedAt: t1,
        }),
      ),
    );
    expect(interruption).toMatchObject({
      code: "io-failure",
      message: "Launch receipt store failed: io-failure",
    });
    expect(unpublishedMode).toBe(0o600);
    expect(interruption).not.toHaveProperty("cause");

    expect(await readLaunchReceipt(receiptPath)).toEqual(initial());
    expect(await readdir(directory)).toEqual(["receipt.json"]);
  });

  test("an exclusive lock prevents two writers from passing the same revision", async () => {
    await writeLaunchReceipt(receiptPath, initial());
    const lock = join(directory, ".receipt.json.lock");
    await writeFile(lock, "", { mode: 0o600 });

    expect(
      await rejected(
        updateLaunchReceipt(receiptPath, { expectedRevision: 0 }, (current) => ({
          ...current,
          revision: 1,
          stage: "authorized",
          updatedAt: t1,
        })),
      ),
    ).toMatchObject({ code: "revision-conflict" });
    expect(await readLaunchReceipt(receiptPath)).toEqual(initial());
  });

  test("distinguishes truncated JSON, invalid schema, and future versions", async () => {
    await writeFile(receiptPath, "{\"schemaVersion\":", { mode: 0o600 });
    expect(await rejected(readLaunchReceipt(receiptPath))).toMatchObject({
      code: "invalid-json",
    });

    await writeFile(receiptPath, JSON.stringify({ ...initial(), unknown: true }), {
      mode: 0o600,
    });
    expect(await rejected(readLaunchReceipt(receiptPath))).toMatchObject({
      code: "invalid-receipt",
      validationCode: "unknown-field",
    });

    await writeFile(receiptPath, JSON.stringify({ ...initial(), schemaVersion: 2 }), {
      mode: 0o600,
    });
    expect(await rejected(readLaunchReceipt(receiptPath))).toMatchObject({
      code: "invalid-receipt",
      validationCode: "unsupported-version",
    });
  });

  test("refuses insecure permissions, symlinks, non-regular targets, and symlink parents", async () => {
    await writeFile(receiptPath, JSON.stringify(initial()), { mode: 0o644 });
    await chmod(receiptPath, 0o644);
    expect(await rejected(readLaunchReceipt(receiptPath))).toMatchObject({
      code: "unsafe-permissions",
    });

    await rm(receiptPath);
    const actual = join(directory, "actual.json");
    await writeFile(actual, JSON.stringify(initial()), { mode: 0o600 });
    await symlink(actual, receiptPath);
    expect(await rejected(readLaunchReceipt(receiptPath))).toMatchObject({
      code: "unsafe-path",
    });
    expect(await rejected(writeLaunchReceipt(receiptPath, initial()))).toMatchObject(
      { code: "unsafe-path" },
    );

    await rm(receiptPath);
    await mkdir(receiptPath);
    expect(await rejected(readLaunchReceipt(receiptPath))).toMatchObject({
      code: "unsafe-path",
    });

    const actualParent = join(directory, "real-parent");
    const linkedParent = join(directory, "linked-parent");
    await mkdir(actualParent);
    await symlink(actualParent, linkedParent);
    expect(
      await rejected(writeLaunchReceipt(join(linkedParent, "receipt.json"), initial())),
    ).toMatchObject({ code: "unsafe-path" });
  });

  test("refuses a receipt directory that is not owner-only", async () => {
    const unsafeParent = join(directory, "shared");
    await mkdir(unsafeParent, { mode: 0o755 });
    await chmod(unsafeParent, 0o755);
    const target = join(unsafeParent, "receipt.json");

    expect(await rejected(writeLaunchReceipt(target, initial()))).toMatchObject({
      code: "unsafe-permissions",
    });
    expect(await rejected(readLaunchReceipt(target))).toMatchObject({
      code: "unsafe-permissions",
    });
  });
});
