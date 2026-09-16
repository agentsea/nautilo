import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  generateMiniAppAgentToolName,
  validateMiniAppManifest,
} from "../../src/apps/app-manifest";
import {
  TEST_GROUPED_MINI_APP_MANIFEST,
  TEST_MINI_APP_MANIFEST,
} from "../helpers/test-mini-app-manifest";

const FIRST_PARTY_APPS_ROOT = join(
  import.meta.dirname,
  "../../../../packages/first-party-apps",
);

/** D372 — every first-party document mini-app manifest that ships from this
 * repo must pass `validateMiniAppManifest`. If a manifest drifts into an
 * invalid shape (bad impact, bad requiredCapability, oversized enum, etc.) we
 * want it to fail here, before it ships to the seeded-apps path. */
const FIRST_PARTY_MANIFEST_PATHS: Array<{ appId: string; rel: string }> = [
  { appId: "nautilo-writer", rel: "writer/app.json" },
  { appId: "nautilo-spreadsheet", rel: "spreadsheet/app.json" },
  { appId: "nautilo-presentation", rel: "presentation/app.json" },
  { appId: "nautilo-design", rel: "design/app.json" },
  { appId: "nautilo-video", rel: "video/app.json" },
];

describe("app-manifest validation", () => {
  test("accepts the neutral test manifest", () => {
    const result = validateMiniAppManifest(TEST_MINI_APP_MANIFEST);
    expect(result).toEqual({ ok: true, manifest: TEST_MINI_APP_MANIFEST });
  });

  test("declares semantic Writer DOCX transformations without selecting profile ids", async () => {
    const raw = JSON.parse(
      await readFile(join(FIRST_PARTY_APPS_ROOT, "writer/app.json"), "utf8"),
    ) as { agent?: { tools?: Array<{ id: string; officeTransform?: unknown }> } };
    const transforms = new Map(
      raw.agent?.tools
        ?.filter((tool) => tool.officeTransform !== undefined)
        .map((tool) => [tool.id, tool.officeTransform]) ?? [],
    );

    expect(transforms).toEqual(new Map([
      ["import-docx", { format: "docx", operation: "import" }],
      ["export-docx", { format: "docx", operation: "export" }],
    ]));
  });

  test("rejects unknown top-level keys", () => {
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("extra");
  });

  test("rejects unknown nested keys", () => {
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      capabilities: {
        ...TEST_MINI_APP_MANIFEST.capabilities,
        network: "readwrite",
      },
    });
    expect(result.ok).toBe(false);
  });

  test("accepts only the bounded live-review request", () => {
    expect(validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      liveReview: { enabled: true },
    }).ok).toBe(true);
    expect(validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      liveReview: { enabled: false },
    }).ok).toBe(false);
    expect(validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      liveReview: { enabled: true, module: "./agent-tools.ts" },
    }).ok).toBe(false);
  });

  test("accepts test-owned create actions", () => {
    expect(TEST_MINI_APP_MANIFEST.createActions?.[0]).toEqual({
      id: "new-canvas",
      label: "New canvas",
      defaultFilename: "Untitled canvas.html",
      mimeType: "text/html",
      targetSurfaces: ["workspace", "currentFolder"],
      template: {
        kind: "file",
        path: "templates/empty-canvas.html",
      },
      openAfterCreate: true,
    });
  });

  test("accepts test-owned content associations", () => {
    expect(TEST_MINI_APP_MANIFEST.contentAssociations?.[0]).toEqual({
      id: "canvas-html",
      kind: "html-script-json",
      scriptId: "manifest",
      scriptType: "application/vnd.nautilo.document+json",
      match: {
        documentType: "canvas",
        editor: "test-canvas",
        payloadFormat: "application/vnd.nautilo.test-canvas+json",
      },
    });
  });

  test("rejects malformed create actions", () => {
    expect(
      validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        createActions: [
          {
            id: "bad",
            label: "Bad",
            defaultFilename: "../bad.html",
            mimeType: "text/html",
            targetSurfaces: ["workspace"],
            template: { kind: "file", path: "./templates/empty.html" },
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        createActions: [
          {
            id: "bad",
            label: "Bad",
            defaultFilename: "bad.html",
            mimeType: "text/html",
            targetSurfaces: [],
            template: { kind: "file", path: "../bad.html" },
          },
        ],
      }).ok,
    ).toBe(false);
  });

  test("rejects malformed ids", () => {
    const badIds = ["Canvas", "-test-canvas", "", "a".repeat(65)];
    for (const id of badIds) {
      const result = validateMiniAppManifest({ ...TEST_MINI_APP_MANIFEST, id });
      expect(result.ok).toBe(false);
    }
  });

  test("rejects absolute and parent-traversal paths", () => {
    for (const entry of ["/main.ts", "../main.ts", ""]) {
      expect(validateMiniAppManifest({ ...TEST_MINI_APP_MANIFEST, entry }).ok).toBe(false);
    }
    for (const html of ["/index.html", "..\\index.html"]) {
      expect(validateMiniAppManifest({ ...TEST_MINI_APP_MANIFEST, html }).ok).toBe(false);
    }
    expect(
      validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        styles: ["../evil.css"],
      }).ok,
    ).toBe(false);
  });

  test("rejects malformed extensions", () => {
    for (const extension of ["canvas.json", ".", ".bad/path"]) {
      const result = validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        fileAssociations: {
          extensions: [extension],
        },
      });
      expect(result.ok).toBe(false);
    }
  });

  test("rejects unsupported capability strings", () => {
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      capabilities: {
        document: {
          artifact: "write",
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  test("omitted optional sections remain omitted", () => {
    const minimal = {
      id: "notes",
      name: "Notes",
      version: "0.0.1",
      entry: "./main.ts",
      html: "./index.html",
      fileAssociations: {},
      capabilities: {},
    };
    const result = validateMiniAppManifest(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.styles).toBeUndefined();
    expect(result.manifest.agent).toBeUndefined();
    expect(result.manifest.capabilities.document).toBeUndefined();
    expect(result.manifest.capabilities.state).toBeUndefined();
    expect(result.manifest.description).toBeUndefined();
  });

  test("accepts manifest with a valid description", () => {
    const description = "A neutral document fixture that opens HTML files in the workspace.";
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      description,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.description).toBe(description);
  });

  test("accepts manifest without description", () => {
    const { description: _description, ...withoutDescription } = TEST_MINI_APP_MANIFEST;
    const result = validateMiniAppManifest(withoutDescription);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.description).toBeUndefined();
  });

  test("rejects description longer than 280 characters", () => {
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      description: "a".repeat(281),
    });
    expect(result.ok).toBe(false);
  });

  test("test manifest has a non-empty description", () => {
    expect(typeof TEST_MINI_APP_MANIFEST.description).toBe("string");
    expect(TEST_MINI_APP_MANIFEST.description!.length).toBeGreaterThan(0);
  });
});

describe("first-party document mini-app manifests (D372 regression)", () => {
  // Anchor path resolution at the repo root so the test is robust to wherever
  // `bun test` is invoked from (it should be `packages/server`), and assert
  // the resolved path matches the per-file `import.meta.dirname` path used
  // elsewhere in this suite.
  test("first-party manifest paths resolve under the repo root", async () => {
    const { stat } = await import("node:fs/promises");
    for (const { rel } of FIRST_PARTY_MANIFEST_PATHS) {
      const path = join(FIRST_PARTY_APPS_ROOT, rel);
      const info = await stat(path);
      expect(info.isFile()).toBe(true);
    }
  });

  for (const { appId, rel } of FIRST_PARTY_MANIFEST_PATHS) {
    test(`accepts first-party ${appId} app.json from disk`, async () => {
      const raw: unknown = JSON.parse(
        await readFile(join(FIRST_PARTY_APPS_ROOT, rel), "utf8"),
      );
      const result = validateMiniAppManifest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifest.id).toBe(appId);
      // Document mini-apps must ship at least one workspace create action —
      // that's the whole UX point of theApps panel primary button (D372).
      const workspaceCreateActions = (result.manifest.createActions ?? []).filter(
        (action) => action.targetSurfaces.includes("workspace"),
      );
      expect(workspaceCreateActions.length).toBeGreaterThan(0);
    });
  }

  test("Video mutations use project-content authority without lowering approval impact", async () => {
    const raw: unknown = JSON.parse(
      await readFile(join(FIRST_PARTY_APPS_ROOT, "video/app.json"), "utf8"),
    );
    const result = validateMiniAppManifest(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tools = result.manifest.agent?.tools ?? [];
    expect(tools.length).toBe(19);
    for (const tool of tools) {
      if (tool.id === "inspect-timeline" || tool.id === "preview-timeline-edit") {
        expect(tool.requiredCapability).toBeNull();
        expect(tool.impact).toBe("read-only");
      } else if (["control-open-video", "review-generation", "inspect-generation", "inspect-video-media"].includes(tool.id)) {
        expect(tool.requiredCapability).toBe("use_project_content");
        expect(tool.impact).toBe("low");
      } else {
        expect(tool.requiredCapability).toBe("use_project_content");
        expect(tool.impact).toBe("high");
      }
    }
  });

  test("Video advertises bounded Current Folder preview without claiming export", async () => {
    const raw = JSON.parse(
      await readFile(join(FIRST_PARTY_APPS_ROOT, "video/app.json"), "utf8"),
    ) as {
      description?: string;
      agent?: { tools?: Array<{ id: string }> };
      contentAssociations?: Array<{
        id: string;
        kind: string;
        scriptId: string;
        scriptType: string;
        match?: {
          documentType?: string;
          editor?: string;
          payloadFormat?: string;
        };
      }>;
    };

    expect(raw.description).toContain("reusable Media Bin");
    expect(raw.description).toContain("supported host capabilities");
    expect(raw.agent?.tools?.map((tool) => tool.id)).not.toContain("render-preview");
    expect(raw.agent?.tools?.map((tool) => tool.id)).not.toContain("export-video");
    expect(raw.contentAssociations).toContainEqual({
      id: "video-html",
      kind: "html-script-json",
      scriptId: "manifest",
      scriptType: "application/vnd.nautilo.document+json",
      match: {
        documentType: "video",
        editor: "nautilo-video",
        payloadFormat: "application/vnd.nautilo.video-edl+json",
      },
    });
  });

  test("rejects invalid impact value 'write' (not in enum)", () => {
    const result = validateMiniAppManifest({
      ...TEST_GROUPED_MINI_APP_MANIFEST,
      agent: {
        tools: [
          {
            id: "bad-impact",
            description: "Bad impact enum",
            runtime: "server",
            module: "./agent-tools.ts",
            handler: "badImpact",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                target: { type: "string" },
              },
              required: ["target"],
            },
            // intentionally invalid literal for the test (validated at runtime)
            impact: "write",
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("impact");
  });

  test("rejects malformed requiredCapability shape (object instead of slug/null)", () => {
    const result = validateMiniAppManifest({
      ...TEST_GROUPED_MINI_APP_MANIFEST,
      agent: {
        tools: [
          {
            id: "bad-cap",
            description: "Bad requiredCapability",
            runtime: "server",
            module: "./agent-tools.ts",
            handler: "badCap",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                target: { type: "string" },
              },
              required: ["target"],
            },
            impact: "high",
            // intentionally invalid shape for the test (validated at runtime)
            requiredCapability: { slug: "use_project_content" },
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects inputSchema enum with more than 128 values", () => {
    const oversizedEnum = Array.from({ length: 129 }, (_, i) => `option-${i}`);
    const result = validateMiniAppManifest({
      ...TEST_GROUPED_MINI_APP_MANIFEST,
      agent: {
        tools: [
          {
            id: "big-enum",
            description: "Oversized enum",
            runtime: "server",
            module: "./agent-tools.ts",
            handler: "bigEnum",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                choice: { type: "string", enum: oversizedEnum },
              },
              required: ["choice"],
            },
            impact: "read-only",
            requiredCapability: null,
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("enum");
  });
});

const VALID_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: {
      type: "object",
      additionalProperties: false,
      properties: {
        surface: { type: "string", enum: ["workspace", "currentFolder"] },
      },
      required: ["surface"],
    },
  },
  required: ["target"],
} as const;

const SAMPLE_AGENT_TOOLS = [
  {
    id: "create-file",
    description: "Create a test document",
    runtime: "server" as const,
    module: "./agent-tools.ts",
    handler: "createFile",
    inputSchema: VALID_TOOL_INPUT_SCHEMA,
    impact: "high" as const,
    requiredCapability: "use_project_content" as const,
    approvalMode: "hybrid" as const,
    resultScanPolicy: "on-suspicious" as const,
  },
  {
    id: "inspect-document",
    title: "Inspect document",
    description: "Inspect a test document",
    runtime: "server" as const,
    module: "./agent-tools.ts",
    handler: "canvas.inspect",
    inputSchema: VALID_TOOL_INPUT_SCHEMA,
    impact: "read-only" as const,
    requiredCapability: null,
    resultScanPolicy: "never" as const,
  },
  {
    id: "set-cells",
    description: "Update bounded canvas items",
    runtime: "server" as const,
    module: "./agent-tools.ts",
    handler: "setCells",
    inputSchema: VALID_TOOL_INPUT_SCHEMA,
    impact: "high" as const,
    requiredCapability: "use_project_content" as const,
  },
];

describe("agent.tools manifest validation", () => {
  test("accepts manifest with three test tools", () => {
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      agent: {
        contextProvider: "testCanvas.activeContext",
        tools: SAMPLE_AGENT_TOOLS,
      },
    });
    expect(result.ok).toBe(true);
  });

  test("generated tool names are deterministic and provider-safe", () => {
    expect(generateMiniAppAgentToolName("test-canvas", "inspect-document")).toBe(
      "app_test_canvas__inspect_document",
    );
    expect(generateMiniAppAgentToolName("test-canvas", "inspect-document")).toBe(
      generateMiniAppAgentToolName("test-canvas", "inspect-document"),
    );
  });

  test("rejects duplicate agent tool ids", () => {
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      agent: {
        tools: [
          SAMPLE_AGENT_TOOLS[0]!,
          {
            ...SAMPLE_AGENT_TOOLS[0]!,
            description: "Duplicate create-file tool",
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("duplicate agent tool id");
  });

  test("generated tool name helper flags hyphen normalization collisions", () => {
    expect(generateMiniAppAgentToolName("test-canvas", "inspect-doc")).toBe(
      generateMiniAppAgentToolName("test-canvas", "inspect_doc"),
    );
  });

  test("rejects unsafe module paths", () => {
    for (const modulePath of ["../agent-tools.ts", "node_modules/evil.ts", ".cache/tools.ts", "dist/tools.ts"]) {
      const result = validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        agent: {
          tools: [
            {
              ...SAMPLE_AGENT_TOOLS[0]!,
              module: modulePath,
            },
          ],
        },
      });
      expect(result.ok).toBe(false);
    }
  });

  test("rejects invalid capability slug", () => {
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      agent: {
        tools: [
          {
            ...SAMPLE_AGENT_TOOLS[0]!,
            requiredCapability: "use_test_canvas_tools",
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("requiredCapability");
  });

  test("rejects unsupported JSON schema features", () => {
    expect(
      validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        agent: {
          tools: [
            {
              ...SAMPLE_AGENT_TOOLS[0]!,
              inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  target: { $ref: "#/definitions/Target" },
                },
              },
            },
          ],
        },
      }).ok,
    ).toBe(false);

    expect(
      validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        agent: {
          tools: [
            {
              ...SAMPLE_AGENT_TOOLS[0]!,
              inputSchema: {
                type: "string",
                additionalProperties: false,
              },
            },
          ],
        },
      }).ok,
    ).toBe(false);

    expect(
      validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        agent: {
          tools: [
            {
              ...SAMPLE_AGENT_TOOLS[0]!,
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
          ],
        },
      }).ok,
    ).toBe(false);
  });

  test("accepts a bounded strict discriminated oneOf operation union", () => {
    const operationUnion = {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "replace" },
            blockId: { type: "string", maxLength: 200 },
            text: { type: "string", maxLength: 20_000 },
          },
          required: ["kind", "blockId", "text"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "delete" },
            blockId: { type: "string", maxLength: 200 },
          },
          required: ["kind", "blockId"],
        },
      ],
    };
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      agent: {
        tools: [{
          ...SAMPLE_AGENT_TOOLS[0]!,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              operations: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: operationUnion,
              },
            },
            required: ["operations"],
          },
        }],
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts op as the common strict oneOf discriminator", () => {
    const branch = (op: string) => ({
      type: "object",
      additionalProperties: false,
      properties: { op: { const: op }, value: { type: "string" } },
      required: ["op"],
    });
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      agent: {
        tools: [{
          ...SAMPLE_AGENT_TOOLS[0]!,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              operations: {
                type: "array",
                maxItems: 20,
                items: { oneOf: [branch("create"), branch("delete")] },
              },
            },
            required: ["operations"],
          },
        }],
      },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects ambiguous, duplicate, nested, and unbounded oneOf variants", () => {
    const branch = (kind: unknown, additionalProperties = false) => ({
      type: "object",
      additionalProperties,
      properties: { kind: { const: kind }, value: { type: "string" } },
      required: ["kind"],
    });
    const withOperationItems = (items: unknown) =>
      validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        agent: {
          tools: [{
            ...SAMPLE_AGENT_TOOLS[0]!,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                operations: { type: "array", maxItems: 20, items },
              },
              required: ["operations"],
            },
          }],
        },
      });

    expect(withOperationItems({ oneOf: [branch("a"), {
      ...branch("b"),
      required: [],
    }] }).ok).toBe(false);
    expect(withOperationItems({ oneOf: [branch("same"), branch("same")] }).ok).toBe(false);
    expect(withOperationItems({ oneOf: [branch("kind"), {
      type: "object",
      additionalProperties: false,
      properties: { kind: { const: "kind-two" }, op: { const: "op-two" } },
      required: ["kind", "op"],
    }] }).ok).toBe(false);
    expect(withOperationItems({ oneOf: [branch("kind"), {
      type: "object",
      additionalProperties: false,
      properties: { op: { const: "op" } },
      required: ["op"],
    }] }).ok).toBe(false);
    expect(withOperationItems({ oneOf: [branch("a"), branch("b", true)] }).ok).toBe(false);
    expect(withOperationItems({
      oneOf: [
        branch("a"),
        {
          ...branch("b"),
          properties: {
            kind: { const: "b" },
            nested: { oneOf: [branch("x"), branch("y")] },
          },
        },
      ],
    }).ok).toBe(false);
    expect(withOperationItems({
      oneOf: [
        branch("a"),
        {
          ...branch("b"),
          properties: {
            kind: { const: "b" },
            nested: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
        },
      ],
    }).ok).toBe(false);
    expect(withOperationItems({
      type: "object",
      properties: {},
      oneOf: [branch("a"), branch("b")],
    }).ok).toBe(false);
    expect(withOperationItems({
      oneOf: Array.from({ length: 17 }, (_, i) => branch(`kind-${i}`)),
    }).ok).toBe(false);
  });

  test("rejects malformed handler names", () => {
    for (const handler of ["", "spread sheet", "../escape", "handler[]"]) {
      const result = validateMiniAppManifest({
        ...TEST_MINI_APP_MANIFEST,
        agent: {
          tools: [
            {
              ...SAMPLE_AGENT_TOOLS[0]!,
              handler,
            },
          ],
        },
      });
      expect(result.ok).toBe(false);
    }
  });

  test("rejects unknown agent tool keys", () => {
    const result = validateMiniAppManifest({
      ...TEST_MINI_APP_MANIFEST,
      agent: {
        tools: [
          {
            ...SAMPLE_AGENT_TOOLS[0]!,
            executor: "evil",
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });
});
