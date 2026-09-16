/**
 * D448 — fail-closed, pre-spawn candidate extraction for apply_patch.
 *
 * This is deliberately independent of the native parser, but mirrors its
 * pinned line grammar before any artifact read, spawn, or mutation.
 */
import {
  type ApplyPatchError,
  type ApplyPatchPreflightSummary,
  type ApplyPatchPlannedOperation,
  validateApplyPatchPreflight,
  validateApplyPatchRequest,
} from "./contract";

export type ApplyPatchPreflightResult =
  | { readonly ok: true; readonly summary: ApplyPatchPreflightSummary }
  | { readonly ok: false; readonly error: ApplyPatchError };

function failure(message: string): ApplyPatchPreflightResult {
  return { ok: false, error: { code: "parse_error", message, retryable: false } };
}

const linesOf = (patch: string): string[] => patch.trim().split(/\r?\n/);

type Candidate = {
  readonly operation: "add" | "update" | "move" | "delete";
  readonly path: string;
  readonly fromPath?: string;
};

function parseChunk(lines: readonly string[], mayOmitMarker: boolean):
  | { readonly ok: true; readonly consumed: number }
  | { readonly ok: false; readonly message: string } {
  let index = 0;
  const first = lines[0];
  if (first === "@@" || first?.startsWith("@@ ")) {
    index += 1;
  } else if (!mayOmitMarker) {
    return { ok: false, message: `Expected update hunk to start with a @@ context marker, got: '${first ?? ""}'` };
  }

  let count = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line === "*** End of File") {
      index += 1;
      break;
    }
    if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
      // Pinned parser accepts shared context and replacement lines.
    } else if (line.length === 0) {
      // Pinned parser represents a blank shared-context line.
    } else if (count > 0) {
      break;
    } else {
      return { ok: false, message: `Unexpected line found in update hunk: '${line}'` };
    }
    count += 1;
    index += 1;
  }
  if (count === 0) return { ok: false, message: "Update hunk does not contain any lines" };
  return { ok: true, consumed: index };
}

function extract(patch: string):
  | { readonly ok: true; readonly candidates: readonly Candidate[] }
  | { readonly ok: false; readonly message: string } {
  const lines = linesOf(patch);
  if (lines.length < 2 || lines[0]?.trim() !== "*** Begin Patch") {
    return { ok: false, message: "The first line of the patch must be '*** Begin Patch'" };
  }
  if (lines.at(-1)?.trim() !== "*** End Patch") {
    return { ok: false, message: "The last line of the patch must be '*** End Patch'" };
  }

  let index = 1;
  if (lines[index]?.trimStart().startsWith("*** Environment ID: ")) {
    if (lines[index]!.trimStart().slice("*** Environment ID: ".length).trim().length === 0) {
      return { ok: false, message: "apply_patch environment_id cannot be empty" };
    }
    index += 1;
  }

  const candidates: Candidate[] = [];
  while (index < lines.length - 1) {
    const header = lines[index]!.trim();
    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length);
      index += 1;
      while (index < lines.length - 1 && lines[index]!.startsWith("+")) {
        index += 1;
      }
      candidates.push({ operation: "add", path });
      continue;
    }
    if (header.startsWith("*** Delete File: ")) {
      candidates.push({ operation: "delete", path: header.slice("*** Delete File: ".length) });
      index += 1;
      continue;
    }
    if (!header.startsWith("*** Update File: ")) {
      return { ok: false, message: `'${header}' is not a valid hunk header` };
    }

    const source = header.slice("*** Update File: ".length);
    index += 1;
    const destination = lines[index]?.startsWith("*** Move to: ")
      ? lines[index]!.slice("*** Move to: ".length)
      : undefined;
    if (destination !== undefined) index += 1;

    let parsedChunks = 0;
    while (index < lines.length - 1 && !lines[index]!.trimStart().startsWith("*** ")) {
      if (lines[index]!.trim().length === 0) {
        index += 1;
        continue;
      }
      const chunk = parseChunk(lines.slice(index, lines.length - 1), parsedChunks === 0);
      if (!chunk.ok) return chunk;
      index += chunk.consumed;
      parsedChunks += 1;
    }
    if (parsedChunks === 0) return { ok: false, message: `Update file hunk for path '${source}' is empty` };
    candidates.push(
      destination === undefined
        ? { operation: "update", path: source }
        : { operation: "move", fromPath: source, path: destination },
    );
  }
  return candidates.length > 0
    ? { ok: true, candidates }
    : { ok: false, message: "patch contains no hunks" };
}

/**
 * Strictly derive the trusted D448 preflight summary. The shared contract then
 * preserves operation shape only; authority validates filesystem semantics.
 */
export function preflightApplyPatch(patch: string): ApplyPatchPreflightResult {
  const request = validateApplyPatchRequest({ patch });
  if (!request.ok) return request;
  const extracted = extract(patch);
  if (!extracted.ok) return failure(extracted.message);

  const operations: ApplyPatchPlannedOperation[] = extracted.candidates.map((candidate) =>
    candidate.operation === "move"
      ? { operation: "move", fromPath: candidate.fromPath!, path: candidate.path }
      : { operation: candidate.operation, path: candidate.path },
  );
  const summary = { operations } satisfies ApplyPatchPreflightSummary;
  const validated = validateApplyPatchPreflight(summary);
  return validated.ok ? { ok: true, summary: validated.summary } : validated;
}
