/**
 * M206 — convert tool must not touch server fsp for local source/destination.
 *
 * Lives in unit-isolated because it mocks `node:fs/promises` process-globally
 * (`mock.module`). Bun cannot un-replace a module, so this runs in its own
 * `bun test` process per the unit-isolated convention.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayCapabilities, RelayDispatchResult } from "@nautilo/relay";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import { setRelayRegistry, type ToolRelayRegistry } from "../../src/nodes/tools";
import { createConvertTool } from "../../src/tools/convert/convert-tool";

const OWNER = "00000000-0000-4000-8000-000000000002";
let currentFolder = "";
const localDispatches: Array<{ kind: string; subkind?: string; mutating: boolean; hadBytes?: boolean }> = [];
const fspReadFile = mock(nodeFsPromises.readFile);
const fspWriteFile = mock(nodeFsPromises.writeFile);
const fspMkdtemp = mock(nodeFsPromises.mkdtemp);

mock.module("node:fs/promises", () => ({
  ...nodeFsPromises,
  readFile: fspReadFile,
  writeFile: fspWriteFile,
  mkdtemp: fspMkdtemp,
}));

function makeRegistry(): ToolRelayRegistry {
  const caps: RelayCapabilities = {
    profile: "desktop-agent",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    localFileExecution: true,
    canRunOffice: true,
    allowedRoots: ["/"],
  };
  return {
    findByCapabilityForUser(capability: string): string[] {
      return (caps as unknown as Record<string, unknown>)[capability] === true ? ["relay-1"] : [];
    },
    getCapabilities(): RelayCapabilities {
      return caps;
    },
    getProtocolVersion(): number {
      return RELAY_PROTOCOL_VERSION;
    },
    async dispatch(): Promise<RelayDispatchResult> {
      return { status: "error", error: "not used" };
    },
    async localFileDispatch(_relayId, req, meta) {
      const op = req.operation;
      if (op.kind === "office") {
        const wire = op.operation;
        const subkind = String(wire["subkind"]);
        localDispatches.push({
          kind: op.kind,
          subkind,
          mutating: meta.mutating,
          hadBytes: "contentBase64" in wire,
        });
        return {
          ok: true,
          result: JSON.stringify({
            applied: true,
            revisionId: "local:relay-1:abc",
            path: wire["destinationPath"] ?? "out/report.pdf",
          }),
        };
      }
      localDispatches.push({ kind: op.kind, mutating: meta.mutating });
      return { ok: true, result: JSON.stringify({ applied: true }) };
    },
  };
}

beforeEach(() => {
  currentFolder = join(tmpdir(), `convert-local-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(currentFolder, { recursive: true });
  localDispatches.length = 0;
  fspReadFile.mockClear();
  fspWriteFile.mockClear();
  fspMkdtemp.mockClear();
  setRelayRegistry(makeRegistry());
  writeFileSync(join(currentFolder, "notes.md"), "# Title\n");
});

describe("convert local zone routing (M206)", () => {
  test("cloud conversion rejects missing server-funding authority before provider dispatch", async () => {
    let providerCalls = 0;
    let fundingSubject = "";
    const tool = createConvertTool(
      { ownerId: OWNER, causalHumanUserId: "calling-human", agentId: "agent-1", currentFolder, workspacePath: "/tmp/ws", memoryAccessEnvelope: null },
      {
        isCloudConvertConfigured: () => true,
        assertServerFunding: async (humanUserId) => { fundingSubject = humanUserId; throw new Error("server_provider_credentials_required"); },
        cloudConvert: async () => { providerCalls++; return Buffer.from("pdf"); },
      },
    );
    const out = String(await tool.invoke({
      markdown: "# Hi",
      format: "pdf",
      destinationPath: "report.pdf",
      destinationZone: "workspace",
      backend: "cloud",
    }));
    expect(out).toContain("server_provider_credentials_required");
    expect(fundingSubject).toBe("calling-human");
    expect(providerCalls).toBe(0);
  });

  test("local md source + local pdf dest uses one relay convert op (no server bytes)", async () => {
    const tool = createConvertTool({
      ownerId: OWNER,
      agentId: "agent-1",
      currentFolder,
      workspacePath: "/tmp/ws",
      memoryAccessEnvelope: null,
    });

    const out = String(
      await tool.invoke({
        sourcePath: "notes.md",
        sourceZone: "current",
        format: "pdf",
        destinationPath: "out/report.pdf",
        destinationZone: "current",
      }),
    );

    expect(out.toLowerCase()).toContain("applied");
    expect(localDispatches).toHaveLength(1);
    expect(localDispatches[0]?.kind).toBe("office");
    expect(localDispatches[0]?.subkind).toBe("convert");
    expect(localDispatches[0]?.mutating).toBe(true);
    expect(localDispatches[0]?.hadBytes).toBe(false);
    expect(fspReadFile).not.toHaveBeenCalled();
    expect(fspWriteFile).not.toHaveBeenCalled();
    expect(fspMkdtemp).not.toHaveBeenCalled();
  });

  test("cloud convert with local destination fails closed", async () => {
    const tool = createConvertTool(
      {
        ownerId: OWNER,
        agentId: "agent-1",
        currentFolder,
        workspacePath: "/tmp/ws",
        memoryAccessEnvelope: null,
      },
      {
        isCloudConvertConfigured: () => true,
        cloudConvert: async () => Buffer.from("pdf"),
      },
    );

    const out = String(
      await tool.invoke({
        markdown: "# Hi",
        format: "pdf",
        destinationPath: "out/report.pdf",
        destinationZone: "current",
        backend: "cloud",
      }),
    );

    expect(out).toContain("cloud conversion with local source or destination");
  });

  test("inline markdown with local destination fails closed (mixed route)", async () => {
    const tool = createConvertTool({
      ownerId: OWNER,
      agentId: "agent-1",
      currentFolder,
      workspacePath: "/tmp/ws",
      memoryAccessEnvelope: null,
    });

    const out = String(
      await tool.invoke({
        markdown: "# Hi",
        format: "pdf",
        destinationPath: "out/report.pdf",
        destinationZone: "current",
        backend: "local",
      }),
    );

    expect(out).toContain("local destination conversion requires a local-zone source file");
    expect(localDispatches).toHaveLength(0);
  });
});
