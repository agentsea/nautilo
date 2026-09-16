import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleRead } from "../../src/tools/file/commands/read";
import {
  captureFileToolResult,
  fileToolError,
  type FileResultStatus,
} from "../../src/tools/file/file-result-status";

/**
 * Stack 208 P3 — file-tool-owned explicit result status.
 *
 * These tests pin the new out-of-band contract:
 *   - `captureFileToolResult` wraps a `file` invocation in an
 *     AsyncLocalStorage context and returns `{ result, status }`.
 *   - `fileToolError(content)` flips the captured status to `"error"`
 *     inside a capture context and returns the identical string; outside
 *     a capture context it is a NO-OP that returns the identical string
 *     (so direct handler unit tests keep observing the exact error bytes).
 *   - A successful read whose actual file contents begin with `Error:`
 *     stays `success` because the read handler never calls
 *     `fileToolError` on the success-content path (pinned by the real
 *     `handleRead` test below).
 *
 * Plus a static source-scan invariant that catches future top-level
 * unified-file error returns which bypass `fileToolError`.
 */

describe("file-result-status (Stack 208 P3 explicit contract)", () => {
  // --- fileToolError: outside a capture context is a no-op ---------

  test("fileToolError outside a capture context returns the identical string (no-op)", () => {
    const content = "Error: file not found: /ws/missing.txt";
    expect(fileToolError(content)).toBe(content);
    // Identity, byte-for-byte.
    expect(fileToolError("")).toBe("");
    expect(fileToolError("plain prose")).toBe("plain prose");
  });

  test("fileToolError outside a capture context has no status side-effect to observe", () => {
    // Calling it bare must not throw and must not leak any global state.
    fileToolError("Error: anything");
    fileToolError("Error: again");
    // No assertion beyond "did not throw" — there is no global to read.
    expect(true).toBe(true);
  });

  // --- captureFileToolResult: default success ---------------------

  test("captureFileToolResult defaults to success when no marker fires", async () => {
    const { result, status } = await captureFileToolResult(async () => "hello world");
    expect(result).toBe("hello world");
    expect(status).toBe("success");
  });

  test("captureFileToolResult preserves a non-string result (multimodal block)", async () => {
    const block = [{ type: "text", text: "img" }];
    const { result, status } = await captureFileToolResult(async () => block);
    expect(result).toBe(block);
    expect(status).toBe("success");
  });

  test("captureFileToolResult preserves a thrown exception (does not swallow)", async () => {
    const boom = new Error("handler crashed");
    let caught: unknown = null;
    try {
      await captureFileToolResult(async () => {
        throw boom;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });

  // --- captureFileToolResult: marker flips status ------------------

  test("a single fileToolError marker flips status to error and preserves content", async () => {
    const { result, status } = await captureFileToolResult(async () =>
      fileToolError("Error: file not found: /ws/missing.txt"),
    );
    expect(result).toBe("Error: file not found: /ws/missing.txt");
    expect(status).toBe("error");
  });

  test("a JSON-envelope error returned via fileToolError flips status to error", async () => {
    const body = JSON.stringify({ error: "no_revisions", path: "/x", hint: "none" });
    const { result, status } = await captureFileToolResult(async () =>
      fileToolError(body),
    );
    expect(result).toBe(body);
    expect(status).toBe("error");
  });

  test("the marker survives an awaited inner async hop (deeply-nested handler)", async () => {
    // Models the real call chain: tools node -> file func -> dispatch ->
    // handler -> staged-patch helper. The AsyncLocalStorage context
    // must survive every `await` on that chain.
    const { result, status } = await captureFileToolResult(async () => {
      await Promise.resolve();
      const inner = await (async () => {
        await Promise.resolve();
        return fileToolError("Error: drift");
      })();
      return inner;
    });
    expect(result).toBe("Error: drift");
    expect(status).toBe("error");
  });

  test("a marker on an error path does NOT stain an adjacent success capture", async () => {
    // Each capture is its own context; a prior error capture must not
    // leak into a later success capture.
    const first = await captureFileToolResult(async () =>
      fileToolError("Error: one"),
    );
    expect(first.status).toBe("error");
    const second = await captureFileToolResult(async () => "ok");
    expect(second.status).toBe("success");
    expect(second.result).toBe("ok");
  });

  test("parallel captures isolate a marked error from an awaited success", async () => {
    const [marked, successful] = await Promise.all([
      captureFileToolResult(async () => {
        await Promise.resolve();
        return fileToolError("Error: isolated failure");
      }),
      captureFileToolResult(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return "awaited success";
      }),
    ]);

    expect(marked).toEqual({
      result: "Error: isolated failure",
      status: "error",
    });
    expect(successful).toEqual({
      result: "awaited success",
      status: "success",
    });
  });

  test("multiple markers in one capture keep status error (idempotent flip)", async () => {
    const { result, status } = await captureFileToolResult(async () => {
      const a = fileToolError("Error: a");
      const b = fileToolError("Error: b");
      return a + "\n" + b;
    });
    expect(result).toBe("Error: a\nError: b");
    expect(status).toBe("error");
  });

  // --- The load-bearing success pin --------------------------------

  test("real handleRead keeps file content beginning with 'Error:' successful", async () => {
    // The explicit marker contract distinguishes successful file bytes
    // from handler-emitted errors: handleRead preserves these source bytes at
    // content field of its successful result and adds authoritative range
    // metadata, without calling fileToolError, so no marker flips the status.
    const fileBody = "Error: file not found: /tmp/missing\nline two\n";
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-file-status-read-"));
    const filePath = path.join(tempDir, "error-prefixed.txt");

    try {
      await fsp.writeFile(filePath, fileBody);
      const captured = await captureFileToolResult(() =>
        handleRead(
          { command: "read", path: filePath, zone: "absolute" },
          { resolved: filePath, resolvedZone: "absolute" },
          {
            zoneCtx: { workspaceRoot: tempDir, currentFolder: null },
            ownerId: "file-result-status-test",
            activeModelId: "anthropic:claude-sonnet-4-6",
          },
        ),
      );

      if (typeof captured.result !== "string") throw new Error("expected a text file result");
      expect(JSON.parse(captured.result)).toMatchObject({ content: fileBody, startLine: 1, endLine: 2, startByte: 0, endByte: Buffer.byteLength(fileBody) });
      expect(captured.status).toBe("success");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("contrast: a handler that DOES mark the same-shaped body flips to error", async () => {
    // Same bytes as the success case above, but the handler calls
    // fileToolError because it IS a handler-emitted error. The status
    // now flips. This is the distinction content-guessing could never
    // make reliably; the explicit marker makes it exact.
    const errBody = "Error: file not found: /tmp/missing\n";
    const { result, status } = await captureFileToolResult(async () =>
      fileToolError(errBody),
    );
    expect(result).toBe(errBody);
    expect(status).toBe("error");
  });

  // --- type export sanity ------------------------------------------

  test("FileResultStatus type is the success|error union", () => {
    const s: FileResultStatus = "success";
    const e: FileResultStatus = "error";
    expect([s, e]).toEqual(["success", "error"]);
  });
});

// ---------------------------------------------------------------------------
// Static source-scan invariant — catches future top-level unified-file error
// returns which bypass `fileToolError`.
//
// The contract: every TOP-LEVEL error return that becomes the unified `file`
// tool result MUST be wrapped in `fileToolError(...)` so the out-of-band
// status flips to "error". A future handler that adds `return `Error: …``
// or `return JSON.stringify({ error: … })` WITHOUT the wrapper would silently
// regress to "success" at the tools-node seam — the exact bug this stack
// eliminates.
//
// To avoid brittle matching of INTERNAL helper result unions (e.g.
// `return { ok: false, reason: … }` from `prepareWorkspaceArtifactTarget`
// or `return { kind: "error", body: … }` from `stageUndoForRevision`), the
// scan matches ONLY direct string error returns — `return "Error:…`,
// `return `Error:…`, and `return JSON.stringify({ error: … })` envelopes.
// Helper-internal object-union returns do not match and are not flagged.
//
// A small, stable allowlist of helper functions that legitimately produce
// unwrapped error strings (their CALLERS wrap with `fileToolError`) is
// excluded: `formatRelayError` and `formatRoutingError` in
// `local-file-dispatch.ts`. These are the only string-returning error
// helpers in the owned surface; their returns are passthrough bodies the
// caller stamps, not final unified-file results.
// ---------------------------------------------------------------------------

const FILE_DIR = path.join(import.meta.dir, "..", "..", "src", "tools", "file");

const OWNED_HANDLER_FILES: readonly string[] = [
  "file-tool.ts",
  "dispatch.ts",
  "workspace-commands.ts",
  "local-file-dispatch.ts",
  "commands/read.ts",
  "commands/write.ts",
  "commands/str-replace.ts",
  "commands/stat.ts",
  "commands/list.ts",
  "commands/insert.ts",
  "commands/pin-revision.ts",
  "commands/list-revisions.ts",
  "blocks/commands.ts",
];

/**
 * Helper functions whose unwrapped error-string returns are EXPECTED —
 * they produce passthrough bodies the caller wraps in `fileToolError`.
 * Add here ONLY named helpers that exist solely to format error strings
 * for a caller to stamp; never a top-level handler return.
 */
const HELPER_ALLOWLIST: ReadonlySet<string> = new Set([
  "formatRelayError",
  "formatRoutingError",
]);

/**
 * Match a DIRECT string error return that is NOT wrapped in `fileToolError`.
 *   - `return "Error:…"` / `return `Error:…``
 *   - `return JSON.stringify({ error: … })` envelopes
 * A wrapped return (`return fileToolError(...)`) does NOT match because
 * the token after `return` is `fileToolError`, not the error content.
 */
const UNMARKED_ERROR_RETURN = /return\s+(JSON\.stringify\(\s*\{\s*error\s*:|`Error:|"Error)/;

function isMarkedReturn(line: string): boolean {
  return /return\s+fileToolError\s*\(/.test(line);
}

/**
 * Walk a file's lines tracking the enclosing function name (heuristic:
 * a `function NAME(` or `const NAME = (` arrow form sets the current
 * function). Returns every line that looks like an unmarked top-level
 * error return, with the enclosing function name so the allowlist can
 * exclude passthrough helpers.
 */
function findUnmarkedErrorReturns(
  source: string,
): Array<{ line: number; text: string; fn: string }> {
  const lines = source.split("\n");
  const out: Array<{ line: number; text: string; fn: string }> = [];
  let currentFn = "<module>";
  // function NAME( ... )  |  function NAME<...>( ... )  |  const NAME = ( ... ) =>
  const fnDecl = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/;
  const constArrow = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fn = fnDecl.exec(line);
    if (fn) {
      currentFn = fn[1]!;
      continue;
    }
    const arrow = constArrow.exec(line);
    if (arrow) {
      currentFn = arrow[1]!;
      continue;
    }
    if (UNMARKED_ERROR_RETURN.test(line) && !isMarkedReturn(line)) {
      out.push({ line: i + 1, text: line.trim(), fn: currentFn });
    }
  }
  return out;
}

describe("file-result-status static invariant — top-level error returns are marked", () => {
  test("every owned handler file marks its top-level error returns", () => {
    const violations: Array<{ file: string; line: number; text: string; fn: string }> = [];
    for (const rel of OWNED_HANDLER_FILES) {
      const full = path.join(FILE_DIR, rel);
      if (!fs.existsSync(full)) continue;
      const source = fs.readFileSync(full, "utf-8");
      for (const v of findUnmarkedErrorReturns(source)) {
        if (HELPER_ALLOWLIST.has(v.fn)) continue;
        violations.push({ file: rel, ...v });
      }
    }
    if (violations.length > 0) {
      const rendered = violations
        .map((v) => `  ${v.file}:${v.line} [${v.fn}] — ${v.text}`)
        .join("\n");
      throw new Error(
        "Top-level unified-file error return(s) bypass fileToolError — would " +
          "regress to nautilo_tool_status:\"success\" at the tools-node seam:\n" +
          rendered +
          "\nWrap each in fileToolError(...) so the out-of-band status flips to \"error\".",
      );
    }
    expect(violations).toEqual([]);
  });

  test("the helper allowlist is exactly the known passthrough formatters", () => {
    // Pin the allowlist so a future addition is a conscious decision,
    // not a quiet widening. If someone adds a helper here, this test
    // forces them to read why the others are here.
    expect([...HELPER_ALLOWLIST].sort()).toEqual([
      "formatRelayError",
      "formatRoutingError",
    ]);
  });
});
