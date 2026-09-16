/** D446 — Desktop host adapter for the shared native-search runner. */

import * as path from "node:path";
import type {
  RelayLocalSearchOp,
  RelaySearchResult,
} from "@nautilo/relay";
import {
  runNativeSearch,
  type NativeSearchExecutor,
} from "@nautilo/relay/native-search";
import { spawnSandboxed, type Sandbox } from "@nautilo/sandbox";
import { resolvePathArg, type LocalPathResolutionContext } from "./commands.ts";

export interface LocalSearchExecutionContext extends LocalPathResolutionContext {
  readonly sandbox: Sandbox;
  readonly binaryPath: string;
  readonly engineVersion: string;
  readonly signal?: AbortSignal;
  /** Unit-test seam; production always uses the existing Sandbox adapter. */
  readonly execute?: NativeSearchExecutor;
}

function reusablePath(zone: RelayLocalSearchOp["zone"], root: string, relativePath: string): string {
  if (zone === "absolute") return path.join(root, relativePath);
  if (root === ".") return relativePath;
  return path.join(root, relativePath).replaceAll(path.sep, "/");
}

export async function executeLocalSearchOperation(
  operation: RelayLocalSearchOp,
  ctx: LocalSearchExecutionContext,
): Promise<RelaySearchResult> {
  const resolved = await resolvePathArg(operation.zone, { ...operation.args }, ctx);
  if (!resolved.ok) {
    return {
      ok: false,
      command: operation.command,
      error: { code: "SEARCH_DENIED_ROOT", message: resolved.text.replace(/^Error:\s*/, "") },
    };
  }
  const stat = await ctx.adapter.stat(resolved.canonical);
  const searchesExactFile = operation.command === "grep" && stat?.isFile === true;
  if (stat?.isDirectory !== true && !searchesExactFile) {
    return {
      ok: false,
      command: operation.command,
      error: {
        code: "SEARCH_INVALID_ARGS",
        message: operation.command === "grep"
          ? "Search path must be a directory or exact file."
          : "Search path must be a directory.",
      },
    };
  }

  const cwd = searchesExactFile ? path.dirname(resolved.canonical) : resolved.canonical;
  const target = searchesExactFile ? path.basename(resolved.canonical) : ".";
  const exactRelativePath = operation.zone === "current"
    ? operation.args.path.replace(/^\.\//, "").replaceAll(path.sep, "/")
    : path.basename(resolved.canonical);

  const common = {
    binaryPath: ctx.binaryPath,
    cwd,
    target,
    engineVersion: ctx.engineVersion,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    mapPath: (relativePath: string) => searchesExactFile
      ? (relativePath === target
          ? { relativePath: exactRelativePath, path: operation.args.path }
          : null)
      : ({
          relativePath,
          path: reusablePath(operation.zone, operation.args.path, relativePath),
        }),
    execute: ctx.execute ?? (async (input) => {
      const result = await spawnSandboxed(ctx.sandbox, input.program, [...input.argv], {
        cwd: input.cwd,
        timeoutMs: null,
        ...(input.signal ? { abortSignal: input.signal } : {}),
        onStdoutChunk: input.onStdoutChunk,
      });
      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stoppedEarly: result.stoppedEarly,
      };
    }),
  };
  return operation.command === "glob"
    ? runNativeSearch({ ...common, command: "glob", args: operation.args })
    : runNativeSearch({ ...common, command: "grep", args: operation.args });
}
