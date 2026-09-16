/**
 * M206 — construct OfficeCLI argv locally from structured officecli payload fields.
 */

import {
  buildAddArgv,
  buildAddPartArgv,
  buildCloseArgv,
  buildDumpArgv,
  buildGetArgv,
  buildMoveArgv,
  buildOpenArgv,
  buildQueryArgv,
  buildRawArgv,
  buildRawSetArgv,
  buildRefreshArgv,
  buildRemoveArgv,
  buildSaveArgv,
  buildSetArgv,
  buildSwapArgv,
  buildValidateArgv,
  buildViewArgv,
  type RawSetAction,
  type ViewMode,
} from "@nautilo/config/officecli";
import type { OfficeRunReadSpec } from "./office-read-spec.ts";

function requireString(value: unknown, label: string): string | { error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${label} is required` };
  }
  return value;
}

function propsToStrings(props: unknown): Record<string, string> | undefined {
  if (!props || typeof props !== "object" || Array.isArray(props)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildOfficeCliDirectArgv(
  command: string,
  payload: Record<string, unknown>,
  file: string,
): string[] | { error: string } {
  const json = payload["json"] !== false;
  const target = typeof payload["target"] === "string" ? payload["target"] : undefined;
  const props = propsToStrings(payload["props"]);

  switch (command) {
    case "view":
      return buildViewArgv({
        file,
        mode: (typeof payload["mode"] === "string" ? payload["mode"] : "text") as ViewMode,
        ...(typeof payload["start"] === "number" ? { start: payload["start"] } : {}),
        ...(typeof payload["end"] === "number" ? { end: payload["end"] } : {}),
        ...(typeof payload["maxLines"] === "number" ? { maxLines: payload["maxLines"] } : {}),
        ...(typeof payload["type"] === "string" ? { type: payload["type"] } : {}),
        ...(typeof payload["limit"] === "number" ? { limit: payload["limit"] } : {}),
        ...(typeof payload["cols"] === "string" ? { cols: payload["cols"] } : {}),
        ...(typeof payload["page"] === "string" ? { page: payload["page"] } : {}),
        ...(payload["browser"] === true ? { browser: true } : {}),
        ...(typeof payload["out"] === "string" ? { out: payload["out"] } : {}),
        ...(typeof payload["screenshotWidth"] === "number" ? { screenshotWidth: payload["screenshotWidth"] } : {}),
        ...(typeof payload["screenshotHeight"] === "number" ? { screenshotHeight: payload["screenshotHeight"] } : {}),
        ...(typeof payload["grid"] === "string" ? { grid: payload["grid"] } : {}),
        ...(typeof payload["render"] === "string" ? { render: payload["render"] as "auto" | "native" | "html" } : {}),
        ...(payload["pageCount"] === true ? { pageCount: true } : {}),
        json,
      });
    case "get":
      return buildGetArgv({
        file,
        ...(target !== undefined ? { path: target } : {}),
        ...(typeof payload["depth"] === "number" ? { depth: payload["depth"] } : {}),
        json,
      });
    case "query": {
      const selector = requireString(payload["selector"], "selector");
      if (typeof selector !== "string") return selector;
      return buildQueryArgv({
        file,
        selector,
        ...(typeof payload["find"] === "string" ? { find: payload["find"] } : {}),
        json,
      });
    }
    case "set": {
      const pathArg = requireString(target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return buildSetArgv({
        file,
        path: pathArg,
        ...(props !== undefined ? { props } : {}),
        ...(typeof payload["find"] === "string" ? { find: payload["find"] } : {}),
        ...(typeof payload["replace"] === "string" ? { replace: payload["replace"] } : {}),
        ...(payload["force"] === true ? { force: true } : {}),
        json,
      });
    }
    case "add": {
      const parent = requireString(payload["parent"], "parent");
      if (typeof parent !== "string") return parent;
      return buildAddArgv({
        file,
        parent,
        ...(typeof payload["type"] === "string" ? { type: payload["type"] } : {}),
        ...(typeof payload["from"] === "string" ? { from: payload["from"] } : {}),
        ...(typeof payload["index"] === "number" ? { index: payload["index"] } : {}),
        ...(typeof payload["after"] === "string" ? { after: payload["after"] } : {}),
        ...(typeof payload["before"] === "string" ? { before: payload["before"] } : {}),
        ...(props !== undefined ? { props } : {}),
        ...(payload["force"] === true ? { force: true } : {}),
        json,
      });
    }
    case "remove": {
      const pathArg = requireString(target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return buildRemoveArgv({ file, path: pathArg, ...(props !== undefined ? { props } : {}), json });
    }
    case "move": {
      const pathArg = requireString(target, "target");
      if (typeof pathArg !== "string") return pathArg;
      return buildMoveArgv({
        file,
        path: pathArg,
        ...(typeof payload["to"] === "string" ? { to: payload["to"] } : {}),
        ...(typeof payload["index"] === "number" ? { index: payload["index"] } : {}),
        ...(typeof payload["after"] === "string" ? { after: payload["after"] } : {}),
        ...(typeof payload["before"] === "string" ? { before: payload["before"] } : {}),
        ...(props !== undefined ? { props } : {}),
        json,
      });
    }
    case "swap": {
      const path1 = requireString(target, "target");
      if (typeof path1 !== "string") return path1;
      const path2 = requireString(payload["path2"], "path2");
      if (typeof path2 !== "string") return path2;
      return buildSwapArgv({ file, path1, path2, json });
    }
    case "validate":
      return buildValidateArgv({ file, json });
    case "dump":
      return buildDumpArgv({
        file,
        ...(target !== undefined ? { path: target } : {}),
        ...(typeof payload["format"] === "string" ? { format: payload["format"] } : {}),
        ...(typeof payload["out"] === "string" ? { out: payload["out"] } : {}),
        json,
      });
    case "raw": {
      const part = requireString(payload["part"], "part");
      if (typeof part !== "string") return part;
      return buildRawArgv({ file, part, json });
    }
    case "raw_set": {
      const part = requireString(payload["part"], "part");
      if (typeof part !== "string") return part;
      const xpath = requireString(payload["xpath"], "xpath");
      if (typeof xpath !== "string") return xpath;
      const action = requireString(payload["action"], "action");
      if (typeof action !== "string") return action;
      return buildRawSetArgv({
        file,
        part,
        xpath,
        action: action as RawSetAction,
        ...(typeof payload["xml"] === "string" ? { xml: payload["xml"] } : {}),
        json,
      });
    }
    case "add_part": {
      const parent = requireString(payload["parent"], "parent");
      if (typeof parent !== "string") return parent;
      const type = requireString(payload["type"], "type");
      if (typeof type !== "string") return type;
      return buildAddPartArgv({ file, parent, type, json });
    }
    case "open":
      return buildOpenArgv({ file, json });
    case "save":
      return buildSaveArgv({ file, json });
    case "close":
      return buildCloseArgv({ file, json });
    case "refresh":
      return buildRefreshArgv({ file, json });
    default:
      return { error: `unsupported direct command ${command}` };
  }
}

export function buildOfficeRunReadArgv(file: string, spec: OfficeRunReadSpec): string[] | { error: string } {
  switch (spec.verb) {
    case "get":
      return buildGetArgv({
        file,
        ...(spec.target !== undefined ? { path: spec.target } : {}),
        ...(spec.depth !== undefined ? { depth: spec.depth } : {}),
        json: spec.json !== false,
      });
    case "dump":
      return buildDumpArgv({
        file,
        ...(spec.target !== undefined ? { path: spec.target } : {}),
        json: spec.json !== false,
      });
    case "view":
      return buildViewArgv({
        file,
        mode: (spec.mode ?? spec.target ?? "text") as ViewMode,
        json: spec.json !== false,
      });
    case "query": {
      const selector = spec.target ?? spec.find;
      if (!selector) return { error: "officeRun query read requires selector target" };
      return buildQueryArgv({
        file,
        selector,
        ...(spec.find !== undefined ? { find: spec.find } : {}),
        json: spec.json !== false,
      });
    }
    case "validate":
      return buildValidateArgv({ file, json: spec.json !== false });
    case "raw": {
      return { error: "officeRun raw read is not supported via readSpec" };
    }
    default:
      return { error: `unsupported officeRun read verb: ${String(spec.verb)}` };
  }
}
