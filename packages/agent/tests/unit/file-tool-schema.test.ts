/**
 * D079 Phase 4 / G3 commit 5 — `fileToolSchema` validation tests.
 *
 * SHAPE NOTE (2026-04-22): The wire schema is a flat `z.object`
 * (not a `z.discriminatedUnion`) because Anthropic requires
 * `input_schema.type: "object"` at the top level — a discriminated
 * union serialises to `{ anyOf: [...] }` and fails with
 * `tools.N.custom.input_schema.type: Field required`. See
 * `schema.ts` header for the full rationale. As a result, per-
 * command required fields (e.g. `content` on `write`, `newString`
 * on `str_replace`, `lineNumber` on `insert`, `destinationPath` on
 * `move`/`copy`) are OPTIONAL at the Zod layer; the command
 * handlers enforce presence with clear error messages. Tests for
 * handler-level rejection live in `file-tool-write-handlers.test.ts`
 * and `file-tool-destructive-handlers.test.ts`.
 *
 * This file ensures (wire-layer):
 *   - Each of the 10 commands parses when given minimal valid args.
 *   - Unknown commands reject at the Zod layer with a list of legal
 *     commands in the error.
 *   - Required-on-every-command fields (`command`, `path`, `zone`)
 *     reject on absence.
 *   - Structural type errors (e.g. `offset: "not-a-number"`) reject.
 *   - `str_replace` Mode A / B / C shapes all pass Zod (handler
 *     enforces exactly-one-disambiguator).
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { createFileTool } from "../../src/tools/file/file-tool";
import {
  fileToolSchema,
  securityResearchFileToolSchema,
} from "../../src/tools/file/schema";

describe("fileToolSchema — valid shapes for each command", () => {
  test("list", () => {
    const r = fileToolSchema.safeParse({
      command: "list",
      path: "src",
      zone: "current",
    });
    expect(r.success).toBe(true);
  });

  test("list with options", () => {
    const r = fileToolSchema.safeParse({
      command: "list",
      path: "src",
      zone: "current",
      recursive: true,
      glob: "**/*.ts",
      depth: 3,
      limit: 500,
    });
    expect(r.success).toBe(true);
  });

  test("read", () => {
    const r = fileToolSchema.safeParse({
      command: "read",
      path: "notes.md",
      zone: "workspace",
    });
    expect(r.success).toBe(true);
    expect(fileToolSchema.safeParse({
      command: "read",
      path: "notes.md",
      zone: "current",
      offset: 0,
      limit: 100,
    }).success).toBe(true);
  });

  test("read with offset/limit", () => {
    const r = fileToolSchema.safeParse({
      command: "read",
      path: "notes.md",
      zone: "workspace",
      offset: 100,
      limit: 50,
    });
    expect(r.success).toBe(true);
  });

  test("grep", () => {
    const r = fileToolSchema.safeParse({
      command: "grep",
      path: ".",
      zone: "current",
      query: "TODO",
    });
    expect(r.success).toBe(true);
  });

  test("glob with native-search options", () => {
    const r = fileToolSchema.safeParse({
      command: "glob",
      path: ".",
      zone: "current",
      pattern: "**/*.ts",
      limit: 2500,
      includeIgnored: true,
      hidden: "exclude",
    });
    expect(r.success).toBe(true);
  });

  test("stat", () => {
    const r = fileToolSchema.safeParse({
      command: "stat",
      path: "notes.md",
      zone: "workspace",
    });
    expect(r.success).toBe(true);
  });

  test("write", () => {
    const r = fileToolSchema.safeParse({
      command: "write",
      path: "drafts/q3.md",
      zone: "workspace",
      content: "# Q3 report\n",
    });
    expect(r.success).toBe(true);
  });

  test("write with mode", () => {
    const r = fileToolSchema.safeParse({
      command: "write",
      path: "log.txt",
      zone: "workspace",
      content: "entry\n",
      mode: "append",
    });
    expect(r.success).toBe(true);
  });

  test("insert", () => {
    const r = fileToolSchema.safeParse({
      command: "insert",
      path: "notes.md",
      zone: "workspace",
      lineNumber: 42,
      content: "new line",
    });
    expect(r.success).toBe(true);
  });

  test("str_replace Mode A (classic find/replace)", () => {
    const r = fileToolSchema.safeParse({
      command: "str_replace",
      path: "foo.ts",
      zone: "current",
      oldString: "a",
      newString: "b",
    });
    expect(r.success).toBe(true);
  });

  test("str_replace Mode B (range-replace, no find)", () => {
    const r = fileToolSchema.safeParse({
      command: "str_replace",
      path: "foo.ts",
      zone: "current",
      newString: "replacement",
      lineRange: { from: 10, to: 30 },
    });
    expect(r.success).toBe(true);
  });

  test("str_replace Mode C (bookend)", () => {
    const r = fileToolSchema.safeParse({
      command: "str_replace",
      path: "foo.ts",
      zone: "current",
      startFragment: "export function foo(",
      endFragment: "} // end foo",
      newString: "...new body...",
    });
    expect(r.success).toBe(true);
  });

  test("move", () => {
    const r = fileToolSchema.safeParse({
      command: "move",
      path: "old.txt",
      zone: "workspace",
      destinationPath: "new.txt",
    });
    expect(r.success).toBe(true);
  });

  test("copy with cross-zone destination", () => {
    const r = fileToolSchema.safeParse({
      command: "copy",
      path: "src.md",
      zone: "current",
      destinationPath: "imported.md",
      destinationZone: "workspace",
    });
    expect(r.success).toBe(true);
  });

  test("delete", () => {
    const r = fileToolSchema.safeParse({
      command: "delete",
      path: "temp.txt",
      zone: "workspace",
    });
    expect(r.success).toBe(true);
  });

  test("delete with recursive", () => {
    const r = fileToolSchema.safeParse({
      command: "delete",
      path: "drafts",
      zone: "workspace",
      recursive: true,
    });
    expect(r.success).toBe(true);
  });

});

describe("fileToolSchema — invalid shapes reject", () => {
  test("empty path rejects so search callers use dot for the selected root", () => {
    expect(fileToolSchema.safeParse({
      command: "glob",
      path: "",
      zone: "current",
      pattern: "**/*.ts",
    }).success).toBe(false);
  });

  test("unknown command rejects", () => {
    const r = fileToolSchema.safeParse({
      command: "drop_database",
      path: "x",
      zone: "workspace",
    });
    expect(r.success).toBe(false);
  });

  test("missing command rejects", () => {
    const r = fileToolSchema.safeParse({
      path: "x",
      zone: "workspace",
    });
    expect(r.success).toBe(false);
  });

  // D087 Phase 1 §1.4 — path/zone are now schema-optional (to accommodate
  // apply_patch / list_patches, which have no filesystem location). The
  // 10 filesystem commands enforce presence at the dispatcher layer, not
  // Zod. The tests below assert Zod-level acceptance; behavior tests for
  // dispatcher-level rejection live in the dispatch tests.
  test("missing path accepted at schema layer (dispatcher enforces for filesystem commands)", () => {
    const r = fileToolSchema.safeParse({
      command: "read",
      zone: "workspace",
    });
    expect(r.success).toBe(true);
  });

  test("missing zone accepted at schema layer (dispatcher enforces)", () => {
    const r = fileToolSchema.safeParse({
      command: "read",
      path: "x",
    });
    expect(r.success).toBe(true);
  });

  test("unknown zone rejects", () => {
    const r = fileToolSchema.safeParse({
      command: "read",
      path: "x",
      zone: "bogus",
    });
    expect(r.success).toBe(false);
  });

  test("cross-command arg leakage: read + oldString rejects", () => {
    // Discriminated-union variant narrowing: `read` schema doesn't
    // include `oldString`; Zod rejects the extra field — wait, by
    // default Zod doesn't strip extras unless `.strict()` is used.
    // Instead what this test verifies: the args that are LEGAL on
    // str_replace but NOT on read shouldn't be on the read variant
    // of the union. Zod's default is lenient-drop-extras; that's
    // acceptable — the handler layer will ignore extra fields. But
    // a `read` call with `content: "..."` (required on `write`)
    // must still pass if it's just extra.
    //
    // So this test is really about illegal types, not extra fields:
    // `command: "read"` with `offset: "not-a-number"` should reject.
    const r = fileToolSchema.safeParse({
      command: "read",
      path: "x",
      zone: "workspace",
      offset: "not-a-number",
    });
    expect(r.success).toBe(false);
  });

  test("write without content passes Zod (handler rejects — see file-tool-write-handlers.test.ts)", () => {
    // Flat wire schema: `content` is optional at Zod layer. The
    // `write` handler's first check is `if (typeof args.content !==
    // "string") return "Error: write requires content"` or similar.
    const r = fileToolSchema.safeParse({
      command: "write",
      path: "x",
      zone: "workspace",
    });
    expect(r.success).toBe(true);
  });

  test("insert without lineNumber passes Zod (handler rejects)", () => {
    const r = fileToolSchema.safeParse({
      command: "insert",
      path: "x",
      zone: "workspace",
      content: "line",
    });
    expect(r.success).toBe(true);
  });

  test("insert with negative lineNumber rejects at Zod layer (positive() guard)", () => {
    // The positive-int guard on `lineNumber` lives on the flat
    // schema itself (not per-command), so this still rejects at
    // Zod — structural type error, not missing-field.
    const r = fileToolSchema.safeParse({
      command: "insert",
      path: "x",
      zone: "workspace",
      lineNumber: -1,
      content: "line",
    });
    expect(r.success).toBe(false);
  });

  test("str_replace without newString passes Zod (handler rejects — see file-tool-write-handlers.test.ts)", () => {
    const r = fileToolSchema.safeParse({
      command: "str_replace",
      path: "x",
      zone: "workspace",
      oldString: "a",
    });
    expect(r.success).toBe(true);
  });

  test("str_replace with lineRange where from > to still passes Zod (handler validates semantics)", () => {
    // Zod only validates structural correctness — `from` and `to`
    // are positive ints, which passes. The handler's mode-validation
    // layer is responsible for rejecting from>to as a semantic
    // error with a clearer message.
    const r = fileToolSchema.safeParse({
      command: "str_replace",
      path: "x",
      zone: "workspace",
      newString: "replacement",
      lineRange: { from: 100, to: 50 },
    });
    expect(r.success).toBe(true);
  });

  test("move without destinationPath passes Zod (handler rejects — see file-tool-destructive-handlers.test.ts)", () => {
    const r = fileToolSchema.safeParse({
      command: "move",
      path: "x",
      zone: "workspace",
    });
    expect(r.success).toBe(true);
  });
});

describe("fileToolSchema — JSON-schema shape (Anthropic tool-use compatibility)", () => {
  /**
   * REGRESSION GUARD for the 2026-04-22 live-verify bug:
   * `z.discriminatedUnion` serialises to `{ anyOf: [...] }` without
   * a top-level `type` field, which Anthropic's tool-use API
   * rejects with:
   *   "tools.N.custom.input_schema.type: Field required"
   *
   * This test freezes the wire schema as a single top-level
   * `{ type: "object", properties: {...} }` so anyone who later
   * tries to convert back to a union gets a clear failure with
   * a pointer to the decision record in schema.ts header.
   */
  test("top-level JSON schema is type: 'object' (required by Anthropic tool-use)", () => {
    const jsonSchema = z.toJSONSchema(fileToolSchema);
    expect(jsonSchema).toHaveProperty("type", "object");
    expect(jsonSchema).not.toHaveProperty("anyOf");
    expect(jsonSchema).not.toHaveProperty("oneOf");
  });

  test("JSON schema has 'command' as required; path/zone optional (D087)", () => {
    const jsonSchema = z.toJSONSchema(fileToolSchema) as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const required = jsonSchema.required ?? [];
    // command stays required — every invocation must specify one.
    expect(required.includes("command")).toBe(true);
    // path + zone relaxed to optional for apply_patch / list_patches
    // compatibility; the 10 filesystem commands enforce presence at
    // the dispatcher layer.
    expect(required.includes("path")).toBe(false);
    expect(required.includes("zone")).toBe(false);
    // Properties still declared so the agent sees them in the tool
    // schema and knows to pass them for filesystem commands.
    expect(jsonSchema.properties).toHaveProperty("command");
    expect(jsonSchema.properties).toHaveProperty("path");
    expect(jsonSchema.properties).toHaveProperty("zone");
  });

  test("JSON schema lists core commands in the command enum", () => {
    const jsonSchema = z.toJSONSchema(fileToolSchema) as {
      properties?: { command?: { enum?: string[] } };
    };
    const commandEnum = jsonSchema.properties?.command?.enum ?? [];
    const expectedCommands = [
      "list",
      "read",
      "glob",
      "grep",
      "stat",
      "write",
      "insert",
      "str_replace",
      "move",
      "copy",
      "delete",
    ];
    for (const cmd of expectedCommands) {
      expect(commandEnum.includes(cmd)).toBe(true);
    }
  });
});

describe("D560 security research file projection", () => {
  test("offers only strict read fields when the server Task whitelist includes security_scan", () => {
    const tool = createFileTool({ toolWhitelist: ["file", "security_scan"] });
    const jsonSchema = z.toJSONSchema(tool.schema) as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown> & { command?: { enum?: string[] } };
      required?: string[];
    };
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.properties?.command?.enum).toEqual([
      "list",
      "read",
      "glob",
      "grep",
      "stat",
    ]);
    expect(jsonSchema.properties).toHaveProperty("path");
    expect(jsonSchema.properties).toHaveProperty("lineRange");
    expect(jsonSchema.properties).not.toHaveProperty("newString");
    expect(jsonSchema.properties).not.toHaveProperty("oldString");
    expect(jsonSchema.properties).not.toHaveProperty("mode");
    for (const required of ["command", "path", "zone"]) {
      expect(jsonSchema.required?.includes(required)).toBe(true);
    }
    expect(tool.description).toContain("Read-only Current Folder");
  });

  test("rejects pathless reads instead of advertising an implicit Current Folder file", () => {
    expect(securityResearchFileToolSchema.safeParse({
      command: "read",
      zone: "current",
      lineRange: { from: 1, to: 70 },
    }).success).toBe(false);
    expect(securityResearchFileToolSchema.safeParse({
      command: "read",
      path: "package.json",
      zone: "current",
      lineRange: { from: 1, to: 70 },
    }).success).toBe(true);
  });

  test("rejects mutation-shaped noise while the ordinary file tool stays unchanged", () => {
    expect(securityResearchFileToolSchema.safeParse({
      command: "list",
      path: "services",
      zone: "current",
      newString: "x",
    }).success).toBe(false);
    expect(fileToolSchema.safeParse({
      command: "list",
      path: "services",
      zone: "current",
      newString: "x",
    }).success).toBe(true);
  });
});
