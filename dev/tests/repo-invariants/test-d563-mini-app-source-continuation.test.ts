/**
 * D563 3.2.3 — mini-app source continuation invariant.
 *
 * The limit inventory catches newly introduced numeric bounds. This test
 * protects the reviewed architectural decision that `read_source` is an exact,
 * caller-owned UTF-8 range reader rather than a terminal crop hidden behind a
 * generic tool-result projection.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "../../..");
const AGENT_TOOL = "packages/agent/src/tools/apps/mini-app.ts";
const AGENT_RUNTIME = "packages/agent/src/tools/apps/mini-app-runtime.ts";
const SERVER_RUNTIME = "packages/server/src/apps/mini-app-tool-runtime.ts";
const SOURCE_STORE = "packages/server/src/apps/app-source-store.ts";

type Sources = ReadonlyMap<string, string>;

function commandCase(source: string, command: string): string | null {
  const start = source.lastIndexOf(`case "${command}":`);
  if (start < 0) return null;
  const next = source.indexOf("case \"", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function requireText(errors: string[], source: string | undefined, path: string, text: string): void {
  if (source === undefined || !source.includes(text)) {
    errors.push(`${path} must contain ${text}`);
  }
}

function continuationViolations(sources: Sources): string[] {
  const errors: string[] = [];
  const agentTool = sources.get(AGENT_TOOL);
  const agentRuntime = sources.get(AGENT_RUNTIME);
  const serverRuntime = sources.get(SERVER_RUNTIME);
  const sourceStore = sources.get(SOURCE_STORE);

  if (agentTool === undefined) {
    errors.push(`missing protected source: ${AGENT_TOOL}`);
  } else {
    for (const field of ["offsetBytes", "lengthBytes", "expectedSha256"]) {
      requireText(errors, agentTool, AGENT_TOOL, `${field}: z`);
    }
    for (const retiredCrop of ["MAX_READ_CONTENT_CHARS", "boundReadContent"]) {
      if (agentTool.includes(retiredCrop)) {
        errors.push(`${AGENT_TOOL} reintroduces retired terminal crop ${retiredCrop}`);
      }
    }

    const readSourceCase = commandCase(agentTool, "read_source");
    if (readSourceCase === null) {
      errors.push(`${AGENT_TOOL} is missing the read_source dispatch case`);
    } else {
      for (const field of ["offsetBytes", "lengthBytes", "expectedSha256"]) {
        if (!readSourceCase.includes(field)) {
          errors.push(`${AGENT_TOOL} read_source does not forward ${field}`);
        }
      }
      if (!readSourceCase.includes("return JSON.stringify(result)")) {
        errors.push(`${AGENT_TOOL} read_source must return its accepted range intact`);
      }
      if (readSourceCase.includes("boundJson(") || readSourceCase.includes(".slice(") || readSourceCase.includes(".substring(")) {
        errors.push(`${AGENT_TOOL} read_source must not crop or route its accepted range through boundJson`);
      }
    }
  }

  for (const field of [
    "offsetBytes?: number",
    "lengthBytes?: number",
    "expectedSha256?: string",
    "totalBytes?: number",
    "returnedBytes?: number",
    "nextOffsetBytes?: number",
    "complete?: boolean",
  ]) {
    requireText(errors, agentRuntime, AGENT_RUNTIME, field);
  }

  for (const text of [
    "readAppSourceFileRange",
    "AppSourceStaleSourceError",
    "expectedSha256: err.expectedSha256",
    "currentSha256: err.currentSha256",
    "nextOffsetBytes: file.nextOffsetBytes",
    "complete: file.complete",
  ]) {
    requireText(errors, serverRuntime, SERVER_RUNTIME, text);
  }

  for (const text of [
    "export async function readAppSourceFileRange",
    "expectedSha256?: string",
    "totalBytes: number",
    "returnedBytes: number",
    "nextOffsetBytes: number",
    "complete: boolean",
    "throw new AppSourceStaleSourceError",
  ]) {
    requireText(errors, sourceStore, SOURCE_STORE, text);
  }

  return errors;
}

function checkedSources(): Map<string, string> {
  return new Map(
    [AGENT_TOOL, AGENT_RUNTIME, SERVER_RUNTIME, SOURCE_STORE].map((path) => [
      path,
      readFileSync(join(REPOSITORY_ROOT, path), "utf8"),
    ]),
  );
}

describe("D563 mini-app source continuation", () => {
  test("keeps read_source exact, reconstructable, and mutation-safe", () => {
    expect(continuationViolations(checkedSources())).toEqual([]);
  });

  test("rejects reintroducing a terminal source crop", () => {
    const sources = checkedSources();
    sources.set(AGENT_TOOL, `${sources.get(AGENT_TOOL)}\nconst MAX_READ_CONTENT_CHARS = 16000;`);
    expect(continuationViolations(sources).join("\n")).toContain(
      `${AGENT_TOOL} reintroduces retired terminal crop MAX_READ_CONTENT_CHARS`,
    );
  });

  test("rejects routing an accepted source range through the generic result bound", () => {
    const sources = checkedSources();
    sources.set(
      AGENT_TOOL,
      sources.get(AGENT_TOOL)!.replace("return JSON.stringify(result);", "return boundJson(result);"),
    );
    const errors = continuationViolations(sources).join("\n");
    expect(errors).toContain(`${AGENT_TOOL} read_source must return its accepted range intact`);
    expect(errors).toContain(`${AGENT_TOOL} read_source must not crop or route its accepted range through boundJson`);
  });

  test("rejects losing the continuation version guard", () => {
    const sources = checkedSources();
    sources.set(
      SOURCE_STORE,
      sources.get(SOURCE_STORE)!.replace("throw new AppSourceStaleSourceError", "throw new Error"),
    );
    expect(continuationViolations(sources).join("\n")).toContain(
      `${SOURCE_STORE} must contain throw new AppSourceStaleSourceError`,
    );
  });
});
