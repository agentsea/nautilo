import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as db from "@nautilo/db";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import * as trustAgentDb from "../../src/store/trust-agent-db";
import { setWorkspaceArtifactCreatedSink } from "../../src/tools/file/artifact-store";

// M033 Phase 6 — `applyWorkspaceArtifactRowChange` wraps the artifacts INSERT +
// junction attach in `withAgentTrustContext`, which would otherwise open a real
// postgres-js connection in this unit test. Mock so the wrap fans out to the
// inner fn with a stub conn (the test mocks `insertArtifact` /
// `attachArtifactToNamespace` directly on `@nautilo/db`).
const MOCK_CONN = {} as never;

let artifactsRoot: string;
let nautiloArtifactsBackup: string | undefined;
let skipVeniceRefreshBackup: string | undefined;
const IMAGE_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "VENICE_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
] as const;
let imageProviderKeyBackups: Partial<Record<(typeof IMAGE_PROVIDER_KEYS)[number], string>>;
const restores: Array<() => void> = [];

function mkEnvelope(): NamespaceMemoryEnvelope {
  return {
    ownerId: "10000000-0000-4000-8000-000000000001",
    actorId: "30000000-0000-4000-8000-000000000003",
    agentId: "20000000-0000-4000-8000-000000000002",
    roomId: "room-1",
    readableNamespaces: ["ns-write"],
    mutableNamespaces: ["ns-write"],
    writableNamespaces: ["ns-write"],
    toolPolicy: {},
  };
}

beforeEach(() => {
  nautiloArtifactsBackup = process.env["NAUTILO_ARTIFACTS_ROOT"];
  skipVeniceRefreshBackup = process.env["NAUTILO_SKIP_VENICE_REFRESH"];
  artifactsRoot = mkdtempSync(join(tmpdir(), "genimg-test-"));
  process.env["NAUTILO_ARTIFACTS_ROOT"] = artifactsRoot;
  process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
  imageProviderKeyBackups = {};
  for (const key of IMAGE_PROVIDER_KEYS) {
    const value = process.env[key];
    if (value !== undefined) imageProviderKeyBackups[key] = value;
  }
  const spTrust = spyOn(trustAgentDb, "withAgentTrustContext").mockImplementation(
    async (_ctx, fn) => fn(MOCK_CONN),
  );
  restores.push(() => spTrust.mockRestore());
  const spWrite = spyOn(trust, "assertCanWriteArtifacts").mockResolvedValue();
  restores.push(() => spWrite.mockRestore());
});

afterEach(() => {
  rmSync(artifactsRoot, { recursive: true, force: true });
  if (nautiloArtifactsBackup === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
  else process.env["NAUTILO_ARTIFACTS_ROOT"] = nautiloArtifactsBackup;
  if (skipVeniceRefreshBackup === undefined) delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
  else process.env["NAUTILO_SKIP_VENICE_REFRESH"] = skipVeniceRefreshBackup;
  for (const key of IMAGE_PROVIDER_KEYS) {
    const value = imageProviderKeyBackups[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (restores.length) {
    const fn = restores.pop();
    if (fn) fn();
  }
  setWorkspaceArtifactCreatedSink(null);
});

describe("generate_image tool", () => {
  test("default args call the catalog-selected Venice adapter with gpt-image-2", async () => {
    const calls: unknown[][] = [];
    mock.module("../../src/image-gen/index.ts", () => ({
      generateImages: mock(async (...args: unknown[]) => {
        calls.push(args);
        return {
          bytes: [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
          model: "gpt-image-2",
          mime: "image/png",
        };
      }),
    }));
    process.env["VENICE_API_KEY"] = "vk-test";

    const spFind = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => spFind.mockRestore());
    const spInsert = spyOn(db, "insertArtifact").mockResolvedValue({ id: "row-uuid-1" } as never);
    const spAttach = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(undefined as never);
    restores.push(() => spInsert.mockRestore());
    restores.push(() => spAttach.mockRestore());

    const { createGenerateImageTool } = await import("../../src/tools/media/generate-image");
    const tool = createGenerateImageTool({ memoryAccessEnvelope: mkEnvelope() });
    const out = await tool.invoke({ prompt: "a red circle" });
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(out) as {
      model?: string;
      images?: Array<{ artifactId: string; path: string; zone: string; mime: string; bytes: number }>;
    };
    expect(parsed.model).toBe("venice:gpt-image-2");
    expect(parsed.images?.length).toBe(1);
    const img = parsed.images![0]!;
    expect(img.zone).toBe("workspace");
    expect(img.mime).toBe("image/png");
    expect(img.bytes).toBeGreaterThan(0);
    expect(img.path.startsWith("generated-images/")).toBe(true);
    expect(parsed).not.toHaveProperty("workspaceRoot");

    expect(calls.length).toBe(1);
    const a = calls[0]![0] as { model: string; count: number };
    expect(a.model).toBe("gpt-image-2");
    expect(a.count).toBe(1);

    const diskPath = join(artifactsRoot, img.artifactId);
    const st = statSync(diskPath);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(img.bytes);
  });

  test("catalog-discovered Seedream reaches the Venice adapter", async () => {
    const calls: unknown[][] = [];
    mock.module("../../src/image-gen/index.ts", () => ({
      generateImages: mock(async (...args: unknown[]) => {
        calls.push(args);
        return {
          bytes: [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
          model: "seedream-v5-pro",
          mime: "image/png",
        };
      }),
    }));
    process.env["VENICE_API_KEY"] = "vk-test";

    const spFind = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => spFind.mockRestore());
    const spInsert = spyOn(db, "insertArtifact").mockResolvedValue({ id: "row-uuid-seedream" } as never);
    const spAttach = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(undefined as never);
    restores.push(() => spInsert.mockRestore());
    restores.push(() => spAttach.mockRestore());

    const { createGenerateImageTool } = await import("../../src/tools/media/generate-image");
    const tool = createGenerateImageTool({ memoryAccessEnvelope: mkEnvelope() });
    const out = await tool.invoke({
      prompt: "an infinite city",
      model: "venice:seedream-v5-pro",
      size: "1536x1024",
      quality: "high",
    });
    const parsed = JSON.parse(out) as { model?: string; provider?: string };
    expect(parsed).toMatchObject({
      model: "venice:seedream-v5-pro",
      provider: "venice",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      model: "seedream-v5-pro",
      size: "1536x1024",
      quality: "high",
    });
    expect(calls[0]?.[2]).toBe("venice");
  });

  test("count=3 writes three files with -01 -02 -03 stems", async () => {
    mock.module("../../src/image-gen/index.ts", () => ({
      generateImages: mock(async (args: { count: number }) => ({
        bytes: Array.from({ length: args.count }, (_, i) => Buffer.from(`img${i}`)),
        model: "gpt-image-2",
        mime: "image/png",
      })),
    }));
    process.env["VENICE_API_KEY"] = "vk-test";

    const spFind = spyOn(db, "findArtifactByPathForNamespaces").mockResolvedValue(null);
    restores.push(() => spFind.mockRestore());
    let inserted = 0;
    const spInsert = spyOn(db, "insertArtifact").mockImplementation(async () => {
      inserted += 1;
      return { id: `row-uuid-${inserted}` } as never;
    });
    const spAttach = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(undefined as never);
    restores.push(() => spInsert.mockRestore());
    restores.push(() => spAttach.mockRestore());

    const creationFacts: unknown[] = [];
    setWorkspaceArtifactCreatedSink((fact) => { creationFacts.push(fact); });
    const { createGenerateImageTool } = await import("../../src/tools/media/generate-image");
    const tool = createGenerateImageTool({ memoryAccessEnvelope: mkEnvelope() });
    const out = await tool.invoke({ prompt: "triptych", count: 3, filename: "panel" });
    const parsed = JSON.parse(out) as {
      images?: Array<{ artifactId: string; path: string; bytes: number }>;
    };
    expect(parsed.images?.length).toBe(3);
    const names = parsed.images!.map((i) => i.path.split("/").pop() ?? "");
    expect(names[0]).toMatch(/panel-01\.png$/);
    expect(names[1]).toMatch(/panel-02\.png$/);
    expect(names[2]).toMatch(/panel-03\.png$/);
    for (const img of parsed.images!) {
      const st = statSync(join(artifactsRoot, img.artifactId));
      expect(st.size).toBe(img.bytes);
    }
    expect(creationFacts).toEqual([
      {
        artifactInternalId: "row-uuid-1",
        namespaceId: "ns-write",
        actor: { kind: "agent", agentId: "20000000-0000-4000-8000-000000000002" },
        occurrenceKey: "artifact.added:create:row-uuid-1",
      },
      {
        artifactInternalId: "row-uuid-2",
        namespaceId: "ns-write",
        actor: { kind: "agent", agentId: "20000000-0000-4000-8000-000000000002" },
        occurrenceKey: "artifact.added:create:row-uuid-2",
      },
      {
        artifactInternalId: "row-uuid-3",
        namespaceId: "ns-write",
        actor: { kind: "agent", agentId: "20000000-0000-4000-8000-000000000002" },
        occurrenceKey: "artifact.added:create:row-uuid-3",
      },
    ]);
  });

  test("missing image credentials returns a truthful availability error", async () => {
    mock.module("../../src/image-gen/index.ts", () => ({
      generateImages: mock(async () => {
        throw new Error("should not run");
      }),
    }));
    for (const key of IMAGE_PROVIDER_KEYS) delete process.env[key];

    const { createGenerateImageTool } = await import("../../src/tools/media/generate-image");
    const tool = createGenerateImageTool({ memoryAccessEnvelope: mkEnvelope() });
    const out = await tool.invoke({ prompt: "x" });
    expect(out).toBe("Error: No configured, credentialed image-generation model is runnable.");
  });

  test("envelope with empty writableNamespaces returns error", async () => {
    mock.module("../../src/image-gen/index.ts", () => ({
      generateImages: mock(async () => {
        throw new Error("should not run");
      }),
    }));
    process.env["VENICE_API_KEY"] = "vk-test";

    const { createGenerateImageTool } = await import("../../src/tools/media/generate-image");
    const badEnvelope: NamespaceMemoryEnvelope = {
      ownerId: "10000000-0000-4000-8000-000000000001",
      actorId: "30000000-0000-4000-8000-000000000003",
      agentId: "20000000-0000-4000-8000-000000000002",
      roomId: "room-1",
      readableNamespaces: ["ns-write"],
      mutableNamespaces: ["ns-write"],
      writableNamespaces: [],
      toolPolicy: {},
    };
    const tool = createGenerateImageTool({ memoryAccessEnvelope: badEnvelope });
    const out = await tool.invoke({ prompt: "x" });
    expect(out).toContain("no writable namespace for new workspace artifacts");
  });
});
