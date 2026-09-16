/**
 * D362 Milestone A — hermetic unit tests for `zone: "workspace"` support
 * on the `office` tool.
 *
 * Scope:
 *   (a) the `zone` schema accepts `"workspace"`.
 *   (b) a workspace READ (`extract`) resolves the input via
 *       `resolveWorkspaceArtifact` and reads bytes off the resolved
 *       physical path (no live engine — `LofficeClient` is mocked).
 *   (c) a workspace WRITE (`find_replace` with `out`) mints a NEW
 *       workspace artifact: `applyWorkspaceArtifactRowChange` is called
 *       with `mode: "create"` for `out`, and the INPUT artifact's
 *       physical bytes are NOT modified.
 *
 * The office.live.test.ts file is skipIf-guarded on a live engine and is
 * left untouched. This file mocks `@nautilo/loffice` and the
 * artifact-store DB-touching functions so it runs without a DB / engine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { CreateOfficeToolDeps } from "./office";

// Spread-the-real-module pattern: keep all exports the office tool
// imports (validateLogicalPath, envelopeFactsForArtifacts, types) real,
// only stub the DB-touching functions. This avoids "Export named 'X'
// not found" errors from bun:test's sticky mock.module.
const realArtifactStore = await import("../file/artifact-store");

const USER_A = "00000000-0000-0000-0000-0000000000a0";
const AGENT_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NS_A1 = "11111111-1111-1111-1111-111111111101";
const NS_A2 = "11111111-1111-1111-1111-111111111102";
const ROOM_1 = "00000000-0000-0000-0000-0000000000a2";

function namespaceEnvelope(): MemoryAccessEnvelope {
  return {
    ownerId: USER_A,
    actorId: "00000000-0000-0000-0000-0000000000a1",
    agentId: AGENT_1,
    roomId: ROOM_1,
    readableNamespaces: [NS_A1, NS_A2],
    mutableNamespaces: [NS_A1, NS_A2],
    writableNamespaces: [NS_A1],
    toolPolicy: {},
  };
}

// Capture calls to the mocked DB-touching functions.
const resolveWorkspaceArtifactMock = mock(
  async (params: {
    logicalPath: string;
    facts: unknown;
    intent: "read" | "mutate" | "create" | "create_or_update";
  }): Promise<unknown> => {
    // Per-call behavior is overridden in each test via `nextResolution`.
    return nextResolution(params);
  },
);

const applyWorkspaceArtifactRowChangeMock = mock(
  async (_meta: unknown, _size: number, _userId: string, _agentId: string): Promise<unknown> => {
    return { internalId: "row-internal-id", artifactId: "row-artifact-id", path: "row-path", revision: 1, previousRevision: null };
  },
);

// Per-test resolver behavior. Default: return a not-found resolution.
let nextResolution: (params: {
  logicalPath: string;
  facts: unknown;
  intent: "read" | "mutate" | "create" | "create_or_update";
}) => Promise<unknown> = async () => ({
  ok: false,
  reason: "no resolution configured",
});

const { createOfficeTool } = await import("./office");

// Fake engine client injected via `createOfficeTool(ctx, { makeClient })`.
// This avoids a global `mock.module("@nautilo/loffice")`, which bun applies
// process-wide and would clobber the real LofficeClient for co-running files
// (office.live.test.ts). Only the DB-touching artifact-store fns are mocked
// below; office.live uses the home zone (getArtifactZone), not those, so that
// mock is harmless to it — and it's restored in afterAll for hygiene.
type EngineClient = ReturnType<NonNullable<CreateOfficeToolDeps["makeClient"]>>;
const makeClient: NonNullable<CreateOfficeToolDeps["makeClient"]> = () =>
  ({
    async info() {
      return { unoserver: "mock", api: "mock", export_filters: { a: 1 }, import_filters: { b: 1 } };
    },
    async convert() {
      return new Uint8Array([0xc0, 0xff, 0xee]);
    },
    async findReplace() {
      return new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    },
    async getStructured() {
      return { paragraphs: ["hello"], sheets: [] };
    },
    async getMeta() {
      return { title: "mock-doc" };
    },
  }) as unknown as EngineClient;

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "office-workspace-test-"));
  mock.module("../file/artifact-store", () => ({
    ...realArtifactStore,
    resolveWorkspaceArtifact: resolveWorkspaceArtifactMock,
    applyWorkspaceArtifactRowChange: applyWorkspaceArtifactRowChangeMock,
  }));
});

beforeEach(() => {
  resolveWorkspaceArtifactMock.mockClear();
  applyWorkspaceArtifactRowChangeMock.mockClear();
});

afterAll(() => {
  resolveWorkspaceArtifactMock.mockReset();
  applyWorkspaceArtifactRowChangeMock.mockReset();
  // Restore the process-global artifact-store mock so other files in the
  // same `bun test` run see the real module again.
  mock.module("../file/artifact-store", () => realArtifactStore);
});

describe("office tool — zone: workspace", () => {
  test("(a) zone schema accepts 'workspace' and routes through the workspace path", async () => {
    // If the schema rejected "workspace", invoke would throw at Zod parse
    // time. If routing fell through to getArtifactZone, the workspace zone
    // (not registered) would surface "artifact zone ... is not initialised".
    // We point the resolver at a missing artifact so we get the
    // workspace-shaped "No workspace artifact at ..." error — proving
    // the workspace branch was taken AND the schema accepted the value.
    nextResolution = async () => ({
      ok: true,
      artifact: null,
      physicalPath: join(tmpRoot, "none"),
      artifactId: "none-id",
      storageUri: "file://" + join(tmpRoot, "none"),
      logicalPath: "in.docx",
    });

    const tool = createOfficeTool({ memoryAccessEnvelope: namespaceEnvelope() }, { makeClient });
    const res = String(await tool.invoke({
      command: "extract",
      zone: "workspace",
      path: "in.docx",
    }));
    expect(res).toContain("No workspace artifact at");
    expect(res).not.toContain("artifact zone");
  });

  test("(b) workspace READ (extract) resolves via resolveWorkspaceArtifact and reads bytes", async () => {
    const inPhysical = join(tmpRoot, "in-extract.docx");
    const inputBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // a fake docx
    await writeFile(inPhysical, inputBytes);

    nextResolution = async (params) => {
      expect(params.intent).toBe("read");
      expect(params.logicalPath).toBe("docs/in.docx");
      return {
        ok: true,
        artifact: {
          id: "row-1",
          artifactId: "art-1",
          path: "docs/in.docx",
          storageUri: "file://" + inPhysical,
          size: inputBytes.byteLength,
          revision: 1,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        physicalPath: inPhysical,
        artifactId: "art-1",
        storageUri: "file://" + inPhysical,
        logicalPath: "docs/in.docx",
      };
    };

    const tool = createOfficeTool({ memoryAccessEnvelope: namespaceEnvelope() }, { makeClient });
    const res = String(await tool.invoke({
      command: "extract",
      zone: "workspace",
      path: "docs/in.docx",
    }));

    const parsed = JSON.parse(res) as { paragraphs: string[] };
    expect(parsed.paragraphs).toEqual(["hello"]);
    expect(resolveWorkspaceArtifactMock).toHaveBeenCalledTimes(1);
    // Read-only: no row mint.
    expect(applyWorkspaceArtifactRowChangeMock).not.toHaveBeenCalled();
  });

  test("(c) workspace WRITE (find_replace with out) mints a NEW artifact; input not modified", async () => {
    const inPhysical = join(tmpRoot, "in-findreplace.docx");
    const outPhysical = join(tmpRoot, "out-findreplace.docx");
    const inputBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22]);
    await writeFile(inPhysical, inputBytes);

    nextResolution = async (params) => {
      if (params.intent === "read") {
        expect(params.logicalPath).toBe("docs/in.docx");
        return {
          ok: true,
          artifact: {
            id: "row-in",
            artifactId: "art-in",
            path: "docs/in.docx",
            storageUri: "file://" + inPhysical,
            size: inputBytes.byteLength,
            revision: 1,
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          physicalPath: inPhysical,
          artifactId: "art-in",
          storageUri: "file://" + inPhysical,
          logicalPath: "docs/in.docx",
        };
      }
      if (params.intent === "create") {
        expect(params.logicalPath).toBe("docs/out.docx");
        return {
          ok: true,
          artifact: null,
          physicalPath: outPhysical,
          artifactId: "art-out",
          storageUri: "file://" + outPhysical,
          logicalPath: "docs/out.docx",
        };
      }
      return { ok: false, reason: `unexpected intent ${params.intent}` };
    };

    const tool = createOfficeTool({ memoryAccessEnvelope: namespaceEnvelope() }, { makeClient });
    const res = String(await tool.invoke({
      command: "find_replace",
      zone: "workspace",
      path: "docs/in.docx",
      out: "docs/out.docx",
      find: "FOO",
      replace: "BAR",
    }));

    const parsed = JSON.parse(res) as {
      ok: boolean;
      command: string;
      zone: string;
      out: string;
      artifactId: string;
      inputArtifactId: string;
      inputPath: string;
      bytes: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.zone).toBe("workspace");
    expect(parsed.out).toBe("docs/out.docx");
    expect(parsed.artifactId).toBe("art-out");
    expect(parsed.inputArtifactId).toBe("art-in");
    expect(parsed.inputPath).toBe("docs/in.docx");
    expect(parsed.bytes).toBe(4);

    // Row mint called exactly once, with mode:"create" and the OUT
    // logical path (NOT the input path).
    expect(applyWorkspaceArtifactRowChangeMock).toHaveBeenCalledTimes(1);
    const mintCall = applyWorkspaceArtifactRowChangeMock.mock.calls[0]!;
    const meta = mintCall[0] as { mode: string; logicalPath: string; artifactId: string; namespaceId: string };
    expect(meta.mode).toBe("create");
    expect(meta.logicalPath).toBe("docs/out.docx");
    expect(meta.artifactId).toBe("art-out");
    expect(meta.namespaceId).toBe(NS_A1); // writableNamespaces[0]
    expect(mintCall[1]).toBe(4); // bytes
    expect(mintCall[2]).toBe(USER_A);
    expect(mintCall[3]).toBe(AGENT_1);

    // resolveWorkspaceArtifact called twice: read input + create out.
    expect(resolveWorkspaceArtifactMock).toHaveBeenCalledTimes(2);

    // Zero-clobber: input physical bytes are unchanged.
    const afterInput = await readFile(inPhysical);
    expect(Array.from(afterInput)).toEqual(Array.from(inputBytes));

    // Output bytes were written to the OUT physical path.
    const afterOutput = await readFile(outPhysical);
    expect(Array.from(afterOutput)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test("workspace zone without envelope returns a clear error", async () => {
    const tool = createOfficeTool(); // no context
    const res = String(await tool.invoke({
      command: "extract",
      zone: "workspace",
      path: "in.docx",
    }));
    expect(res).toContain("Error: workspace zone requires room/namespace context");
  });
});
