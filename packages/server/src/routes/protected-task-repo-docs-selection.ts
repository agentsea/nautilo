import { isDeepStrictEqual } from "node:util";
import { sql, tasks } from "@nautilo/db";
import {
  type ProtectedTaskMetadataProjectionV1,
} from "@nautilo/types";
import type {
  ProtectedRepoDocsOpenedSelection,
} from "@nautilo/agent";

export type ProtectedTaskRepoDocsSelection = Readonly<{
  mode: "init" | "update" | "auto";
  publish: "branch" | "push" | "pr";
}>;

/** Content-free operational projection; target and instructions remain encrypted. */
export function protectedTaskRepoDocsSelectionProjection() {
  return sql<unknown>`case
    when ${tasks.preset} = 'repo_docs'
      and jsonb_typeof(${tasks.metadata}) = 'object'
      and (${tasks.metadata} - 'target' - 'instructions' - 'mode' - 'publish'
        - 'preparation' - 'lastInterruption') = '{}'::jsonb
      and jsonb_typeof(${tasks.metadata}->'target') = 'string'
      and btrim(${tasks.metadata}->>'target') <> ''
      and (not (${tasks.metadata} ? 'instructions')
        or jsonb_typeof(${tasks.metadata}->'instructions') = 'string')
      and jsonb_typeof(${tasks.metadata}->'mode') = 'string'
      and ${tasks.metadata}->>'mode' in ('init', 'update', 'auto')
      and jsonb_typeof(${tasks.metadata}->'publish') = 'string'
      and ${tasks.metadata}->>'publish' in ('branch', 'push', 'pr')
    then jsonb_build_object(
      'mode', ${tasks.metadata}->>'mode',
      'publish', ${tasks.metadata}->>'publish'
    )
    else null
  end`.as("repo_docs_selection");
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === Object.keys(value).length;
}

export function parseProtectedTaskRepoDocsSelection(
  value: unknown,
): ProtectedTaskRepoDocsSelection | null {
  if (!plainRecord(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "mode")
    || !Object.hasOwn(value, "publish")
    || !["init", "update", "auto"].includes(String(value["mode"]))
    || !["branch", "push", "pr"].includes(String(value["publish"]))) return null;
  return Object.freeze({
    mode: value["mode"] as ProtectedTaskRepoDocsSelection["mode"],
    publish: value["publish"] as ProtectedTaskRepoDocsSelection["publish"],
  });
}

export function sameProtectedTaskRepoDocsSelection(
  left: ProtectedTaskRepoDocsSelection | null | undefined,
  right: ProtectedTaskRepoDocsSelection,
): boolean {
  return left !== null && left !== undefined && isDeepStrictEqual(left, right);
}

/** Rejoin the already-opened encrypted content with the current operational selector. */
export function openProtectedTaskRepoDocsSelection(
  selection: ProtectedTaskRepoDocsSelection,
  protectedMetadata: ProtectedTaskMetadataProjectionV1,
): ProtectedRepoDocsOpenedSelection | null {
  const allowed = new Set(["target", "instructions", "preparation", "lastInterruption"]);
  if (Reflect.ownKeys(protectedMetadata).some(key =>
    typeof key !== "string" || !allowed.has(key)
  )) return null;
  const target = protectedMetadata["target"];
  const instructions = protectedMetadata["instructions"];
  if (typeof target !== "string" || target.trim().length === 0
    || (instructions !== undefined && typeof instructions !== "string")) return null;
  return Object.freeze({
    target,
    mode: selection.mode,
    publish: selection.publish,
    ...(instructions === undefined ? {} : { instructions }),
  });
}
