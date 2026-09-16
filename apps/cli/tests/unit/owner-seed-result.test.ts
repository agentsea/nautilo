import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OWNER_SEED_RESULT_SCHEMA,
  OwnerSeedResultError,
  preflightOwnerSeedResultDestination,
  publishOwnerSeedResult,
  readOwnerSeedResult,
  validateOwnerSeedResult,
  type OwnerSeedResult,
  type OwnerSeedResultErrorCode,
  type OwnerSeedResultFileHandle,
  type OwnerSeedResultFilesystem,
} from "../../src/lib/owner-seed-result.ts";

const result: OwnerSeedResult = {
  schema: OWNER_SEED_RESULT_SCHEMA,
  profile: "production",
  targetFingerprint: "0".repeat(64),
  handle: "server_admin",
  recoveryCodes: Array.from({ length: 8 }, (_, index) => index.toString(16).padStart(24, "0")),
};

let root: string;
let outputDirectory: string;
let outputPath: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "owner-seed-result-")));
  outputDirectory = join(root, "operator-results");
  outputPath = join(outputDirectory, "owner.json");
  await mkdir(outputDirectory, { mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function expectOwnerError(run: () => unknown, code: OwnerSeedResultErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerSeedResultError);
    expect((error as OwnerSeedResultError).code).toBe(code);
    return;
  }
  throw new Error(`Expected OwnerSeedResultError(${code})`);
}

async function expectOwnerRejection(
  promise: Promise<unknown>,
  code: OwnerSeedResultErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerSeedResultError);
    expect((error as OwnerSeedResultError).code).toBe(code);
    return;
  }
  throw new Error(`Expected OwnerSeedResultError(${code})`);
}

function nativeFilesystem(onBoundary?: (boundary: string) => Promise<void>): OwnerSeedResultFilesystem {
  const boundary = onBoundary ?? (() => Promise.resolve());
  let parentOpenCount = 0;
  return {
    lstat: (path): Promise<Stats> => lstat(path),
    realpath,
    open: async (path, flags, mode): Promise<OwnerSeedResultFileHandle> => {
      const handle = await open(path, flags, mode);
      const kind = path.includes(".tmp-")
        ? "temporary"
        : path === outputDirectory
          ? `parent-${++parentOpenCount}`
          : "result";
      try {
        await boundary(`open-${kind}`);
      } catch (error) {
        await handle.close();
        throw error;
      }
      return {
        writeFile: async (data, encoding) => {
          await handle.writeFile(data, encoding);
          await boundary(`write-${kind}`);
        },
        readFile: async () => handle.readFile(),
        stat: async () => handle.stat(),
        chmod: async (fileMode) => {
          await handle.chmod(fileMode);
          await boundary(`chmod-${kind}`);
        },
        sync: async () => {
          await handle.sync();
          await boundary(`sync-${kind}`);
        },
        close: async () => {
          await handle.close();
          await boundary(`close-${kind}`);
        },
      };
    },
    link: async (existingPath, newPath) => {
      await link(existingPath, newPath);
      await boundary("link-result");
    },
    unlink: async (path) => {
      await unlink(path);
      await boundary("unlink-temporary");
    },
  };
}

describe("owner seed result schema", () => {
  test("accepts only the bounded exact recovery result schema", () => {
    expect(validateOwnerSeedResult(result)).toEqual(result);
    expectOwnerError(() => validateOwnerSeedResult({ ...result, password: "do-not-store" }), "invalid-result");
    expectOwnerError(() => validateOwnerSeedResult({ ...result, sessionToken: "do-not-store" }), "invalid-result");
    expectOwnerError(() => validateOwnerSeedResult({ ...result, handle: "UPPERCASE" }), "invalid-result");
    expectOwnerError(() => validateOwnerSeedResult({ ...result, targetFingerprint: "A".repeat(64) }), "invalid-result");
    expectOwnerError(() => validateOwnerSeedResult({ ...result, recoveryCodes: [] }), "invalid-result");
    expectOwnerError(() => validateOwnerSeedResult({
      ...result,
      recoveryCodes: Array.from({ length: 7 }, (_, index) => index.toString(16).padStart(24, "0")),
    }), "invalid-result");
  });
});

describe("owner seed result destination preflight", () => {
  test("requires an absolute safe operator-owned parent outside known server roots", async () => {
    await expectOwnerRejection(
      preflightOwnerSeedResultDestination({ path: "owner.json" }),
      "invalid-destination",
    );

    const unsafe = join(root, "unsafe");
    await mkdir(unsafe, { mode: 0o777 });
    await chmod(unsafe, 0o777);
    await expectOwnerRejection(
      preflightOwnerSeedResultDestination({ path: join(unsafe, "owner.json") }),
      "unsafe-parent",
    );

    await expectOwnerRejection(
      preflightOwnerSeedResultDestination({ path: outputPath, serverRootPaths: [root] }),
      "server-root-target",
    );
  });

  test("rejects symlink targets and observes an existing valid result", async () => {
    const elsewhere = join(root, "elsewhere.json");
    await writeFile(elsewhere, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    await symlink(elsewhere, outputPath);
    await expectOwnerRejection(readOwnerSeedResult({ path: outputPath }), "result-read-failed");
    await unlink(outputPath);

    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    expect(await preflightOwnerSeedResultDestination({ path: outputPath })).toEqual({
      kind: "existing",
      path: outputPath,
      result,
    });
  });

  test("revalidates the opened result handle instead of trusting lstat", async () => {
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const filesystem = nativeFilesystem();
    const openNative = filesystem.open.bind(filesystem);
    filesystem.open = async (path, flags, mode) => {
      const handle = await openNative(path, flags, mode);
      if (path !== outputPath) return handle;
      return {
        ...handle,
        stat: async () => {
          const status = await handle.stat();
          return new Proxy(status, {
            get(target, property) {
              if (property === "mode") return (target.mode & ~0o777) | 0o644;
              return Reflect.get(target, property, target) as unknown;
            },
          });
        },
      };
    };
    await expectOwnerRejection(
      readOwnerSeedResult({ path: outputPath, filesystem }),
      "result-read-failed",
    );
  });
});

describe("owner seed result durable publication", () => {
  test("publishes mode 0600, fsyncs, and reads the exact result", async () => {
    const boundaries: string[] = [];
    expect(await publishOwnerSeedResult({
      path: outputPath,
      result,
      temporarySuffix: () => "fixedsuffix",
      filesystem: nativeFilesystem((event) => {
        boundaries.push(event);
        return Promise.resolve();
      }),
    })).toEqual({ kind: "published", path: outputPath, result });

    expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(result);
    expect(boundaries).toEqual([
      "open-temporary",
      "write-temporary",
      "chmod-temporary",
      "sync-temporary",
      "close-temporary",
      "link-result",
      "open-parent-1",
      "sync-parent-1",
      "close-parent-1",
      "unlink-temporary",
      "open-parent-2",
      "sync-parent-2",
      "close-parent-2",
    ]);
  });

  test("never overwrites and treats only the identical existing result as idempotent", async () => {
    await publishOwnerSeedResult({ path: outputPath, result, temporarySuffix: () => "firstwrite" });
    expect(await publishOwnerSeedResult({ path: outputPath, result, temporarySuffix: () => "retrywrite" })).toEqual({
      kind: "existing",
      path: outputPath,
      result,
    });
    await expectOwnerRejection(publishOwnerSeedResult({
      path: outputPath,
      result: {
        ...result,
        recoveryCodes: result.recoveryCodes.map((code, index) => index === 0 ? "f".repeat(24) : code),
      },
      temporarySuffix: () => "otherwrite",
    }), "destination-exists");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(result);
  });

  test("a racing identical publication is observed without clobbering", async () => {
    let raced = false;
    const filesystem = nativeFilesystem(async (event) => {
      if (event === "sync-temporary" && !raced) {
        raced = true;
        await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
          flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          mode: 0o600,
        });
      }
    });
    expect(await publishOwnerSeedResult({
      path: outputPath,
      result,
      temporarySuffix: () => "racewrite",
      filesystem,
    })).toEqual({ kind: "existing", path: outputPath, result });
  });

  test("crashes before publish leave no result; crashes after atomic link leave an observable valid result", async () => {
    const crashBoundaries = [
      "open-temporary",
      "write-temporary",
      "chmod-temporary",
      "sync-temporary",
      "close-temporary",
      "link-result",
      "open-parent-1",
      "sync-parent-1",
      "close-parent-1",
      "unlink-temporary",
      "open-parent-2",
      "sync-parent-2",
      "close-parent-2",
    ] as const;

    for (const crashAt of crashBoundaries) {
      await rm(outputPath, { force: true });
      let crashed = false;
      const filesystem = nativeFilesystem((event) => {
        if (!crashed && event === crashAt) {
          crashed = true;
          return Promise.reject(new Error(`crash after ${event}`));
        }
        return Promise.resolve();
      });
      await expectOwnerRejection(publishOwnerSeedResult({
        path: outputPath,
        result,
        temporarySuffix: () => `crash-${crashAt.replaceAll("-", "_")}`,
        filesystem,
      }), "result-publish-failed");

      const existing = await readOwnerSeedResult({ path: outputPath });
      if (crashBoundaries.indexOf(crashAt) < crashBoundaries.indexOf("link-result")) {
        expect(existing, crashAt).toBeUndefined();
      } else {
        expect(existing, crashAt).toEqual(result);
      }
    }
  });
});
