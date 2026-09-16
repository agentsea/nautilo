/**
 * M216 — SHA-guarded accepted local Writer writes on the Electron relay.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";

import { parseRelayLocalFileSha256 } from "@nautilo/relay";

import type { GuardedFileAdapter } from "../local-file-history/file-adapter.ts";
import { sha256Hex } from "../local-file-history/hash.ts";
import { readState } from "../local-file-history/journal.ts";

export class GuardedWriteError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function parseOptionalExpectedSha256(
  args: Record<string, unknown>,
): { ok: true; value?: string } | { ok: false; text: string } {
  if (args["expectedSha256"] === undefined) return { ok: true };
  const parsed = parseRelayLocalFileSha256(args["expectedSha256"]);
  if (!parsed) {
    return {
      ok: false,
      text: JSON.stringify({
        error: "invalid_expected_sha256",
        message: "expectedSha256 must be 64 lowercase hex chars",
      }),
    };
  }
  return { ok: true, value: parsed };
}

export function parseOptionalClientMutationId(args: Record<string, unknown>): string | undefined {
  const raw = args["clientMutationId"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function currentCanonicalSha256(
  adapter: GuardedFileAdapter,
  canonical: string,
): Promise<string> {
  const state = await readState(adapter, canonical);
  return state.kind === "bytes" ? state.sha256 : sha256Hex(new Uint8Array());
}

export async function assertExpectedSha256(
  adapter: GuardedFileAdapter,
  canonical: string,
  expectedSha256: string,
): Promise<void> {
  const actualSha256 = await currentCanonicalSha256(adapter, canonical);
  if (actualSha256 !== expectedSha256) {
    throw new GuardedWriteError("stale_sha256", "canonical file sha256 does not match expectedSha256", {
      expectedSha256,
      actualSha256,
    });
  }
}

function guardedTempPath(canonical: string): string {
  const token = randomBytes(8).toString("hex");
  return path.join(path.dirname(canonical), `.${path.basename(canonical)}.nautilo-${token}.tmp`);
}

/**
 * Same-directory temp write, recheck expected SHA on the live canonical file,
 * then atomic rename into place.
 */
export async function writeGuardedAtomic(
  adapter: GuardedFileAdapter,
  canonical: string,
  data: Uint8Array,
  expectedSha256: string,
): Promise<void> {
  const tempPath = guardedTempPath(canonical);
  try {
    await adapter.writeFile(tempPath, data);
    await assertExpectedSha256(adapter, canonical, expectedSha256);
    await adapter.rename(tempPath, canonical);
  } catch (err) {
    await adapter.remove(tempPath).catch(() => undefined);
    throw err;
  }
}

export function staleSha256Result(details: Record<string, unknown>): string {
  return JSON.stringify({
    error: "stale_sha256",
    message: "canonical file sha256 does not match expectedSha256",
    expectedSha256: details["expectedSha256"],
    actualSha256: details["actualSha256"],
  });
}
