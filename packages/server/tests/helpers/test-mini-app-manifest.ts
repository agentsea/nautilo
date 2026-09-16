import type { MiniAppManifest } from "../../src/apps/app-manifest";

/** Test-owned manifest with the capabilities exercised by generic app tests. */
export const TEST_MINI_APP_MANIFEST: MiniAppManifest = {
  id: "test-canvas",
  name: "Test Canvas",
  description: "Neutral document app fixture for server tests.",
  version: "1.0.0",
  entry: "./main.ts",
  html: "./index.html",
  styles: ["./styles.css"],
  fileAssociations: { extensions: [], mimeTypes: [] },
  capabilities: {
    document: { artifact: "readwrite", currentFolder: "readwrite" },
    state: "readwrite",
  },
  agent: {
    contextProvider: "testCanvas.activeContext",
    tools: [{
      id: "inspect-document",
      title: "Inspect document",
      description: "Inspect a test document",
      runtime: "server",
      module: "./agent-tools.ts",
      handler: "inspectDocument",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: {
            type: "object",
            additionalProperties: false,
            properties: {
              surface: { type: "string", enum: ["workspace", "currentFolder"] },
              path: { type: "string" },
              relativePath: { type: "string" },
            },
            required: ["surface"],
          },
        },
        required: ["target"],
      },
      impact: "read-only",
      requiredCapability: null,
      resultScanPolicy: "never",
    }],
  },
  createActions: [{
    id: "new-canvas",
    label: "New canvas",
    defaultFilename: "Untitled canvas.html",
    mimeType: "text/html",
    targetSurfaces: ["workspace", "currentFolder"],
    template: { kind: "file", path: "templates/empty-canvas.html" },
    openAfterCreate: true,
  }],
  contentAssociations: [{
    id: "canvas-html",
    kind: "html-script-json",
    scriptId: "manifest",
    scriptType: "application/vnd.nautilo.document+json",
    match: {
      documentType: "canvas",
      editor: "test-canvas",
      payloadFormat: "application/vnd.nautilo.test-canvas+json",
    },
  }],
};

export const TEST_GROUPED_MINI_APP_MANIFEST: MiniAppManifest = {
  ...TEST_MINI_APP_MANIFEST,
  id: "test-gallery",
  name: "Test Gallery",
  display: {
    groupId: "test-fixtures",
    groupName: "Test Fixtures",
    groupOrder: 90,
    appOrder: 10,
    defaultCollapsed: true,
  },
};
