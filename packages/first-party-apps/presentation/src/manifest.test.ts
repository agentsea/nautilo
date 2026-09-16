import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator, type Schema } from "@cfworker/json-schema";
import { validateMiniAppManifest } from "../../../server/src/apps/app-manifest";
import * as handlers from "../agent-tools";
import { MemSlidesStore } from "../engine/node.js";
import { assertSlideAdoptionPreserves, parseSlideHtml } from "./slide-document";
import { presentationLiveToolExtension } from "./live-tool-contract";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type ToolManifest = {
  id: string;
  inputSchema: unknown;
  impact: string;
  requiredCapability: string | null;
  module: string;
  handler: string;
};

describe("presentation app tool manifest", () => {
  test("update-shape schemas reject no-op and empty-frame requests", async () => {
    const parsed = JSON.parse(await readFile(join(root, "app.json"), "utf8")) as {
      agent: { tools: ToolManifest[] };
    };
    // Generic JSON Schema validity is insufficient: the app host accepts a
    // deliberately smaller schema dialect when registering installed apps.
    expect(validateMiniAppManifest(parsed)).toMatchObject({ ok: true });
    for (const id of ["edit-presentation", "edit-open-presentation"]) {
      const tool = parsed.agent.tools.find((candidate) => candidate.id === id);
      if (!tool) throw new Error(`missing ${id}`);
      const validator = new Validator(tool.inputSchema as Schema);
      const base = id === "edit-presentation"
        ? { target: { surface: "workspace", path: "Deck.presentation.html" }, expectedSha256: "a".repeat(64) }
        : { expectedVersion: JSON.stringify({ kind: "artifact_revision", revision: 2 }) };
      const operation = { op: "update-shape", slideId: "slide", elementId: "shape" };
      expect(validator.validate({ ...base, operations: [operation] }).valid).toBe(false);
      expect(validator.validate({ ...base, operations: [{ ...operation, frame: {} }] }).valid).toBe(false);
      expect(validator.validate({ ...base, operations: [{ ...operation, fill: "#123456" }] }).valid).toBe(true);
      expect(validator.validate({ ...base, operations: [{ ...operation, frame: { x: 1 } }] }).valid).toBe(true);
    }
  });

  test("keeps host-owned live fields out of model-visible schemas", async () => {
    const parsed = JSON.parse(
      await readFile(join(root, "app.json"), "utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || !("agent" in parsed))
      throw new Error("manifest agent missing");
    const agent = parsed.agent;
    if (
      !agent ||
      typeof agent !== "object" ||
      !("tools" in agent) ||
      !Array.isArray(agent.tools)
    )
      throw new Error("manifest tools missing");
    const tools = new Map<string, ToolManifest>(
      agent.tools.map((tool: unknown) => {
        if (
          !tool ||
          typeof tool !== "object" ||
          !("id" in tool) ||
          typeof tool.id !== "string"
        )
          throw new Error("invalid tool manifest");
        return [tool.id, tool as ToolManifest];
      }),
    );
    for (const id of ["inspect-open-presentation", "edit-open-presentation", "save-open-template"]) {
      const tool = tools.get(id);
      if (!tool) throw new Error(`missing ${id}`);
      const schema = JSON.stringify(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties));
      for (const field of [
        "sessionToken",
        "documentVersion",
        "idempotencyKey",
        "__canonicalContent",
        "target",
        "path",
        "relativePath",
      ])
        expect(schema).not.toContain(field);
      expect(tool.module).toBe("./agent-tools.ts");
      expect(typeof handlers[tool.handler as keyof typeof handlers]).toBe(
        "function",
      );
    }
    expect(tools.get("edit-open-presentation")).toMatchObject({
      impact: "high",
      requiredCapability: "use_project_content",
    });
    expect(tools.get("edit-presentation")).toMatchObject({
      impact: "high",
      requiredCapability: "use_project_content",
    });
  });

  test("registers the host-bound document tools and independent template capture", () => {
    expect(presentationLiveToolExtension).toMatchObject({
      appId: "nautilo-presentation",
      mode: "direct_mutation",
      liveToolIds: ["inspect-open-presentation", "edit-open-presentation", "save-open-template"],
      directMutationToolIds: ["edit-open-presentation"],
      hostOwnsSessionBinding: true,
      hostOwnsIdempotencyKey: true,
    });
  });

  test("canonical create template parses and survives engine adoption exactly", async () => {
    const source = parseSlideHtml(
      await readFile(join(root, "templates/empty-presentation.html"), "utf8"),
    );
    expect(() =>
      assertSlideAdoptionPreserves(source, new MemSlidesStore(source).read()),
    ).not.toThrow();
  });
});
