import { describe, expect, it } from "bun:test";
import { validateMiniAppManifest } from "../../src/apps/app-manifest";

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
};

function baseManifest() {
  return {
    id: "test-app",
    name: "Test App",
    version: "0.1.0",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: {
      extensions: [],
      mimeTypes: [],
    },
    capabilities: {
      document: {
        artifact: "readwrite" as const,
        currentFolder: "readwrite" as const,
      },
      state: "readwrite" as const,
    },
    agent: {
      tools: [
        {
          id: "import-docx",
          description: "Import a DOCX file",
          runtime: "server" as const,
          module: "./agent-tools.ts",
          handler: "importDocx",
          inputSchema: VALID_TOOL_INPUT_SCHEMA,
          impact: "high" as const,
        },
      ],
    },
  };
}

function validConversionImport() {
  return {
    id: "import-docx",
    label: "Import DOCX",
    from: { extensions: [".docx"] },
    sourceSurfaces: ["currentFolder", "workspace"] as const,
    tool: "import-docx",
    target: { surface: "workspace" as const, extension: ".html" },
  };
}

describe("app-manifest conversions validation", () => {
  it("accepts a semantic Office transformation declaration for an office-capable tool", () => {
    const base = baseManifest();
    const manifest = {
      ...base,
      capabilities: { ...base.capabilities, office: "convert" as const },
      agent: {
        ...base.agent,
        tools: [{ ...base.agent.tools[0]!, officeTransform: { format: "docx", operation: "import" } }],
      },
    };

    const result = validateMiniAppManifest(manifest);

    expect(result.ok).toBe(true);
  });

  it("accepts XLSX and rejects an unknown Office transformation operation", () => {
    const base = baseManifest();
    const xlsxManifest = {
      ...base,
      capabilities: { ...base.capabilities, office: "convert" as const },
      agent: {
        ...base.agent,
        tools: [{ ...base.agent.tools[0]!, officeTransform: { format: "xlsx", operation: "import" } }],
      },
    };
    expect(validateMiniAppManifest(xlsxManifest).ok).toBe(true);

    const manifest = {
      ...xlsxManifest,
      agent: {
        ...xlsxManifest.agent,
        tools: [{ ...base.agent.tools[0]!, officeTransform: { format: "xlsx", operation: "convert" } }],
      },
    };

    const result = validateMiniAppManifest(manifest);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('expected one of "import"|"export"|"inspect"|"mutate"');
  });

  it("requires office convert capability for a tool transformation declaration", () => {
    const base = baseManifest();
    const manifest = {
      ...base,
      agent: {
        ...base.agent,
        tools: [{ ...base.agent.tools[0]!, officeTransform: { format: "docx", operation: "import" } }],
      },
    };

    const result = validateMiniAppManifest(manifest);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("requires capabilities.office to be convert");
  });

  it("accepts a valid conversions block", () => {
    const result = validateMiniAppManifest({
      ...baseManifest(),
      conversions: {
        import: [validConversionImport()],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown key in conversions (strict)", () => {
    const result = validateMiniAppManifest({
      ...baseManifest(),
      conversions: {
        import: [validConversionImport()],
        bogus: 1,
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a conversions tool that does not reference an existing agent tool id", () => {
    const result = validateMiniAppManifest({
      ...baseManifest(),
      conversions: {
        import: [
          {
            ...validConversionImport(),
            tool: "does-not-exist",
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("unknown agent tool id");
  });

  it("rejects from with neither extensions nor mimeTypes", () => {
    const result = validateMiniAppManifest({
      ...baseManifest(),
      conversions: {
        import: [
          {
            ...validConversionImport(),
            from: {},
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a bad extension in from", () => {
    const result = validateMiniAppManifest({
      ...baseManifest(),
      conversions: {
        import: [
          {
            ...validConversionImport(),
            from: { extensions: ["docx"] },
          },
        ],
      },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts capabilities.office convert", () => {
    const result = validateMiniAppManifest({
      ...baseManifest(),
      capabilities: {
        ...baseManifest().capabilities,
        office: "convert",
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid capabilities.office value", () => {
    const result = validateMiniAppManifest({
      ...baseManifest(),
      capabilities: {
        ...baseManifest().capabilities,
        office: "bogus",
      },
    });
    expect(result.ok).toBe(false);
  });
});
