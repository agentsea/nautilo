import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MiniAppConversionRunRequest } from "@nautilo/api-client/browser";
import { apiClient } from "../lib/api";
import { ConversionConflictDialog } from "./conversion-conflict-dialog";
import {
  ConversionWarningDialog,
  type ConversionWarningConfirmation,
  type WorkspaceDestination,
} from "./conversion-warning-dialog";

export type ConversionRunOutcome =
  | { status: "ok"; result: unknown }
  | { status: "cancelled" }
  | { status: "error"; message: string };

type ConflictChoice =
  | { kind: "overwrite" }
  | { kind: "rename"; name: string }
  | { kind: "cancel" };

type ConflictInfo = {
  surface: "workspace" | "currentFolder";
  path: string;
  message: string;
};

type ConflictToolResult = {
  status?: string;
  target?: { surface: "workspace" | "currentFolder"; path: string };
  message?: string;
};

type WarningChoice = { kind: "confirm"; selection?: ConversionWarningConfirmation } | { kind: "cancel" };

type WarningInfo = {
  sourceSha256: string;
  warnings: string[];
  message?: string;
  workspaceChoice?: {
    filename: string;
    extension: string;
    initialLocation: WorkspaceDestination;
  };
};

const SHA256_RE = /^[a-f0-9]{64}$/;

function warningInfo(value: unknown): WarningInfo | "malformed" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result["status"] !== "confirmation_required") return null;
  if (
    typeof result["sourceSha256"] !== "string" ||
    !SHA256_RE.test(result["sourceSha256"]) ||
    !Array.isArray(result["warnings"]) ||
    !result["warnings"].every((warning) => typeof warning === "string") ||
    (result["message"] !== undefined && typeof result["message"] !== "string")
  ) return "malformed";
  return {
    sourceSha256: result["sourceSha256"],
    warnings: [...result["warnings"]],
    ...(typeof result["message"] === "string" ? { message: result["message"] } : {}),
  };
}

function replaceBasename(path: string, basename: string): string {
  const slash = path.lastIndexOf("/");
  const backslash = path.lastIndexOf("\\");
  const index = Math.max(slash, backslash);
  if (index < 0) return basename;
  return `${path.slice(0, index + 1)}${basename}`;
}

function pathBasename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function pathDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? "" : path.slice(0, index + 1);
}

function filenameExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : "";
}

/**
 * M205 — single conflict-resolution loop shared by every conversion caller
 * (import from the reader / workspace tree, export from the mini-app chrome).
 * `run` posts the conversion; when the server returns `status:"conflict"` it
 * pops the shared Overwrite / Rename / Cancel dialog and retries accordingly,
 * so all surfaces behave identically for both artifacts and current-folder
 * files. Callers render `conflictDialog` and act only on a terminal outcome.
 */
export function useConversionRunner(): {
  run: (appId: string, body: MiniAppConversionRunRequest, options?: {
    signal?: AbortSignal;
    selectWorkspaceDestination?: boolean;
  }) => Promise<ConversionRunOutcome>;
  conflictDialog: ReactNode;
} {
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [warning, setWarning] = useState<WarningInfo | null>(null);
  const resolverRef = useRef<((choice: ConflictChoice) => void) | null>(null);
  const warningResolverRef = useRef<((choice: WarningChoice) => void) | null>(null);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      resolverRef.current?.({ kind: "cancel" });
      resolverRef.current = null;
      warningResolverRef.current?.({ kind: "cancel" });
      warningResolverRef.current = null;
    };
  }, []);

  const ask = useCallback(
    (info: ConflictInfo): Promise<ConflictChoice> =>
      new Promise<ConflictChoice>((resolve) => {
        resolverRef.current = resolve;
        setConflict(info);
      }),
    [],
  );

  const settle = useCallback((choice: ConflictChoice) => {
    setConflict(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(choice);
  }, []);

  const askWarning = useCallback(
    (info: WarningInfo): Promise<WarningChoice> =>
      new Promise<WarningChoice>((resolve) => {
        warningResolverRef.current = resolve;
        setWarning(info);
      }),
    [],
  );

  const settleWarning = useCallback((choice: WarningChoice) => {
    setWarning(null);
    const resolve = warningResolverRef.current;
    warningResolverRef.current = null;
    resolve?.(choice);
  }, []);

  const run = useCallback(
    async (
      appId: string,
      body: MiniAppConversionRunRequest,
      options?: { signal?: AbortSignal; selectWorkspaceDestination?: boolean },
    ): Promise<ConversionRunOutcome> => {
      if (!mountedRef.current || options?.signal?.aborted) return { status: "cancelled" };
      if (busyRef.current) {
        return { status: "error", message: "Another conversion is already in progress." };
      }
      busyRef.current = true;
      const abort = () => {
        resolverRef.current?.({ kind: "cancel" });
        warningResolverRef.current?.({ kind: "cancel" });
        if (mountedRef.current) { setConflict(null); setWarning(null); }
      };
      options?.signal?.addEventListener("abort", abort, { once: true });
      try {
        let current: MiniAppConversionRunRequest = { ...body };
        for (;;) {
          if (options?.signal?.aborted) return { status: "cancelled" };
          let response: { ok: true; result: unknown };
          try {
            response = await apiClient.runMiniAppConversion(appId, current);
          } catch (err) {
            if (!mountedRef.current || options?.signal?.aborted) return { status: "cancelled" };
            return { status: "error", message: err instanceof Error ? err.message : String(err) };
          }
          if (!mountedRef.current || options?.signal?.aborted) return { status: "cancelled" };

          const result = response.result as ConflictToolResult | null;
          const confirmation = warningInfo(response.result);
          if (confirmation === "malformed") {
            return { status: "error", message: "The conversion returned an invalid confirmation request." };
          }
          if (confirmation) {
            if (!mountedRef.current || options?.signal?.aborted) return { status: "cancelled" };
            const workspaceChoice = options?.selectWorkspaceDestination &&
              current.source.surface === "workspace" && current.target?.surface === "workspace" && body.target
              ? {
                  filename: pathBasename(current.target.path),
                  extension: filenameExtension(pathBasename(body.target.path)),
                  initialLocation: (current.workspaceDestination ?? "current") as WorkspaceDestination,
                }
              : undefined;
            const choice = await askWarning({ ...confirmation, workspaceChoice });
            if (!mountedRef.current || options?.signal?.aborted || choice.kind === "cancel") return { status: "cancelled" };
            if (choice.selection) {
              const path = choice.selection.workspaceDestination === "source"
                ? `${pathDirectory(body.source.path)}${choice.selection.filename}`
                : choice.selection.filename;
              current = {
                ...current,
                target: { surface: "workspace", path },
                workspaceDestination: choice.selection.workspaceDestination,
                overwrite: false,
                acknowledgedSourceSha256: confirmation.sourceSha256,
              };
            } else {
              current = { ...current, acknowledgedSourceSha256: confirmation.sourceSha256 };
            }
            continue;
          }
          if (result && result.status === "conflict" && result.target) {
            const target = result.target;
            if (!mountedRef.current || options?.signal?.aborted) return { status: "cancelled" };
            const choice = await ask({
              surface: target.surface,
              path: target.path,
              message: result.message ?? "A file already exists at the target.",
            });
            if (!mountedRef.current || options?.signal?.aborted || choice.kind === "cancel") return { status: "cancelled" };
            if (choice.kind === "overwrite") {
              current = { ...current, overwrite: true, target };
              continue;
            }
            current = {
              ...current,
              overwrite: false,
              target: { surface: target.surface, path: replaceBasename(target.path, choice.name) },
            };
            continue;
          }

          return { status: "ok", result: response.result };
        }
      } finally {
        options?.signal?.removeEventListener("abort", abort);
        busyRef.current = false;
      }
    },
    [ask, askWarning],
  );

  const conflictDialog: ReactNode = conflict ? (
    <ConversionConflictDialog
      targetPath={conflict.path}
      message={conflict.message}
      onOverwrite={() => settle({ kind: "overwrite" })}
      onRename={(name) => settle({ kind: "rename", name })}
      onCancel={() => settle({ kind: "cancel" })}
    />
  ) : warning ? (
    <ConversionWarningDialog
      key={warning.sourceSha256}
      warnings={warning.warnings}
      {...(warning.message === undefined ? {} : { message: warning.message })}
      {...(warning.workspaceChoice === undefined ? {} : { workspaceDestination: warning.workspaceChoice })}
      onConfirm={(selection) => settleWarning({ kind: "confirm", ...(selection ? { selection } : {}) })}
      onCancel={() => settleWarning({ kind: "cancel" })}
    />
  ) : null;

  return { run, conflictDialog };
}
