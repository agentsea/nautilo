import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { REVIEWED_PROTECTED_TASK_EXTERNAL_REQUEST_COVERAGE as entries } from "../../baseline/reviewed-protected-task-external-request-coverage";
import { validateCoverageEntry } from "../../src/model";

const root = resolve(import.meta.dir, "../../../..");
const source = (path: string) => readFile(resolve(root, path), "utf8");

describe("protected live external Task request coverage", () => {
  test("covers exactly the mounted private routes and availability event without new debt", async () => {
    const routes = await source("packages/server/src/routes/protected-task-external-request-routes.ts");
    const mounted = [...routes.matchAll(/app\.post\("([^"]+)"/gu)]
      .map(match => `http:request_response:POST ${match[1]}`);
    expect(mounted).toHaveLength(4);
    expect(entries.map(entry => entry.locator).sort()).toEqual([
      ...mounted, "ws:server_to_client:task.external_request.changed",
    ].sort());
    for (const entry of entries) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
      expect(BASELINE_REGISTRY.entries.filter(item => item.locator === entry.locator))
        .toEqual([entry]);
      expect(BASELINE_REGISTRY.debt.some(item => item.locator === entry.locator)).toBe(false);
      for (const evidence of entry.testEvidence) await access(resolve(root, evidence));
    }
  });

  test("never classifies provider questions, tool input or Human responses as metadata", async () => {
    for (const action of ["read", "respond"]) {
      const entry = entries.find(item => item.locator.endsWith(`/${action}`));
      expect(entry?.classification).toBe("protected");
      if (entry?.classification !== "protected") throw new Error("Missing content coverage");
      expect(entry.keyFamily).toBe("namespace_ai");
      expect(entry.retention).toContain("transient plaintext");
      expect(entry.negativeTestEvidence).toContain("packages/server/tests/unit/protected-task-external-requests.test.ts");
      expect(entry.negativeTestEvidence).toContain("packages/server/tests/unit/protected-task-external-request-routes.test.ts");
      await access(resolve(root, entry.bridgeRepository));
    }
    const schemas = await source("packages/api-client/src/schemas/protected-task-external-requests.ts");
    expect(schemas).toContain("event: codexRequestEventSchema");
    expect(schemas).toContain("response: z.union([codexRequestResponseSchema, codexPermissionSelectionResponseSchema])");
    const bounded = entries.filter(entry => entry.classification === "bounded_metadata");
    expect(bounded).toHaveLength(3);
    for (const entry of bounded) {
      if (entry.classification !== "bounded_metadata") throw new Error("Wrong classification");
      expect(entry.metadataAllowlist.some(field => /^(event|response|prompt|tools|args|content)(\.|$)/u.test(field))).toBe(false);
    }
  });

  test("availability metadata enumerates every actual realtime field and its owner-only routing", async () => {
    const text = await source("packages/types/src/realtime.ts");
    const ast = ts.createSourceFile("realtime.ts", text, ts.ScriptTarget.Latest, true);
    const event = ast.statements.find(statement => ts.isInterfaceDeclaration(statement)
      && statement.name.text === "TaskExternalRequestChangedEvent");
    if (event === undefined || !ts.isInterfaceDeclaration(event)) throw new Error("Missing event");
    const fields = event.members.map(member => {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) throw new Error("Unreviewed event shape");
      return member.name.text;
    });
    const entry = entries.find(item => item.locator.startsWith("ws:"));
    if (entry?.classification !== "bounded_metadata") throw new Error("Missing availability classification");
    expect([...entry.metadataAllowlist].sort()).toEqual(fields.sort());
    expect(entry.testEvidence).toContain("packages/server/tests/unit/task-external-request-audience.test.ts");
    const publisher = await source("packages/server/src/realtime/ws-publisher.ts");
    const branch = publisher.match(/if \(event\.type === "task\.external_request\.changed"\) \{([\s\S]*?)\n {2}\}/u)?.[1];
    expect(branch).toContain('{ kind: "user", userId: event.ownerId }');
    expect(branch).toContain('{ kind: "none" }');
    expect(branch).not.toContain('kind: "room"');
  });
});
