import { createHmac } from "node:crypto";

import { PUSH_TOKEN_ENCRYPTION_KEY } from "@nautilo/operator-secrets";
import type { RecordRepositorySelection } from "@nautilo/runtime";

const REFLECTION_KEY_DOMAIN = "nautilo/reflection/server-commitment-key/v1";

/**
 * Server-owned projection of the application-wide encryption migration state.
 *
 * The migration is not active yet, so production has one canonical ordinary
 * selection. Reflection workers, tools, and individual jobs receive this
 * value; none of them may inspect configuration or choose a representation.
 * The encryption cutover replaces this resolver's binding when the canonical
 * application migration state exists.
 */
export function resolveCurrentRecordRepositorySelection(): RecordRepositorySelection {
  return Object.freeze({
    selectedRepresentation: "ordinary",
    migrationGeneration: 1,
  });
}

/**
 * Derive a stable, purpose-separated Reflection key from the existing
 * per-instance persisted operator secret. The source secret is installed for
 * every local and packaged Server start, regardless of push-notification use.
 * It is never returned, stored in product rows, or logged.
 */
export function resolveCurrentReflectionCommitmentKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Uint8Array {
  const encoded = environment[PUSH_TOKEN_ENCRYPTION_KEY];
  if (encoded === undefined || !/^[a-f0-9]{64}$/iu.test(encoded)) {
    throw new TypeError("Reflection commitment key source is unavailable");
  }
  return new Uint8Array(
    createHmac("sha256", Buffer.from(encoded, "hex"))
      .update(REFLECTION_KEY_DOMAIN, "utf8")
      .digest(),
  );
}
