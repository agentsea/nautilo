/**
 * One-time compatibility migration for journals created before Desktop relay
 * identity became scoped to the `(instance, profile)` tuple.
 *
 * The old identity is accepted only when it is the caller-proven historical
 * shared relay id. Actionable mutation/outbox work is never reassigned.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { journalRootLockKey, withJournalRootLock } from "./journal-root-lock.ts";
import { createJournalStorage } from "./storage.ts";
import type { AnyLocalFileHistoryManifest } from "./types.ts";

export type LocalHistoryRelayRebindResult =
  | { readonly status: "no_history" | "already_bound" }
  | {
      readonly status: "rebound";
      readonly previousRelayId: string;
      readonly relayId: string;
      readonly backupPath: string;
    }
  | {
      readonly status: "refused";
      readonly reason: "unexpected_relay" | "unfinished_history";
      readonly manifestRelayId: string;
    };

function hasUnfinishedHistory(manifest: AnyLocalFileHistoryManifest): boolean {
  if (manifest.v === 1) return false;
  return manifest.mutations.some((row) =>
    row.state === "pending" || row.state === "recovery_required"
  ) || manifest.outbox.some((row) =>
    row.state === "held" || row.state === "pending" || row.state === "claimed"
  );
}

function replaceExactRelayId(value: unknown, previousRelayId: string, relayId: string): unknown {
  if (value === previousRelayId) return relayId;
  if (Array.isArray(value)) {
    return value.map((item) => replaceExactRelayId(item, previousRelayId, relayId));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        replaceExactRelayId(child, previousRelayId, relayId),
      ]),
    );
  }
  return value;
}

async function preserveManifestBackup(
  rootDir: string,
  previousRelayId: string,
  original: Uint8Array,
): Promise<string> {
  const suffix = createHash("sha256").update(previousRelayId, "utf8").digest("hex").slice(0, 16);
  const backupPath = path.join(rootDir, `manifest.before-relay-rebind-${suffix}.json`);
  try {
    const handle = await fs.open(backupPath, "wx", 0o600);
    try {
      await handle.writeFile(original);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(backupPath);
    if (!existing.equals(Buffer.from(original))) {
      throw new Error(`local history relay-rebind backup already exists with different content: ${backupPath}`);
    }
  }
  let directory: fs.FileHandle | undefined;
  try {
    directory = await fs.open(rootDir, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    await directory?.close();
  }
  return backupPath;
}

export async function rebindLegacyLocalFileHistoryRelay(input: {
  readonly rootDir: string;
  readonly previousRelayId: string;
  readonly relayId: string;
}): Promise<LocalHistoryRelayRebindResult> {
  const rootDir = path.resolve(input.rootDir);
  const storage = createJournalStorage(rootDir);
  await storage.ensureRoot();
  const rootKey = journalRootLockKey(await fs.realpath(rootDir));

  return withJournalRootLock(rootKey, async () => {
    const manifest = await storage.readManifest();
    if (manifest === null) return { status: "no_history" };
    if (manifest.relayId === input.relayId) return { status: "already_bound" };
    if (manifest.relayId !== input.previousRelayId) {
      return {
        status: "refused",
        reason: "unexpected_relay",
        manifestRelayId: manifest.relayId,
      };
    }
    if (hasUnfinishedHistory(manifest)) {
      return {
        status: "refused",
        reason: "unfinished_history",
        manifestRelayId: manifest.relayId,
      };
    }

    const manifestPath = path.join(rootDir, "manifest.json");
    const original = await fs.readFile(manifestPath);
    const backupPath = await preserveManifestBackup(rootDir, input.previousRelayId, original);
    const rebound = replaceExactRelayId(
      manifest,
      input.previousRelayId,
      input.relayId,
    ) as AnyLocalFileHistoryManifest;
    await storage.writeManifest(rebound);

    // Re-read through the strict decoder before declaring the migration done.
    const verified = await storage.readManifest();
    if (verified?.relayId !== input.relayId) {
      throw new Error("local history relay rebind did not persist the target relay identity");
    }
    return {
      status: "rebound",
      previousRelayId: input.previousRelayId,
      relayId: input.relayId,
      backupPath,
    };
  });
}
