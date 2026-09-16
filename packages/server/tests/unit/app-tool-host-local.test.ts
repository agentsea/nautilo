import { beforeEach, describe, expect, it, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LOCAL_HISTORY_INPUT_REQUIRED,
  sha256Hex,
  setRelayRegistry,
  type ToolRelayRegistry,
} from "@nautilo/agent";
import { RELAY_PROTOCOL_VERSION, type RelayCapabilities } from "@nautilo/relay";
import { createAppToolHost } from "../../src/apps/app-tool-host";
import { createAppOperationId, isAppOperationId } from "../../src/apps/app-operation-id";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";

const CURRENT = "/tmp/nautilo-test-current";

function makeManifest(): MiniAppManifest {
  return {
    id: "writer-local-test",
    name: "Writer Local Test",
    version: "1.0.0",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: { extensions: [], mimeTypes: [] },
    capabilities: {
      document: { artifact: "readwrite", currentFolder: "readwrite" },
      office: "convert",
    },
    createActions: [
      {
        id: "new-doc",
        label: "New",
        defaultFilename: "doc.html",
        mimeType: "text/html",
        targetSurfaces: ["workspace", "currentFolder"],
        template: { kind: "file", path: "template.html" },
      },
    ],
  };
}

async function productionDesignManifest(): Promise<MiniAppManifest> {
  return Bun.file(
    resolve(import.meta.dir, "../../../first-party-apps/design/app.json"),
  ).json() as Promise<MiniAppManifest>;
}

function baseContext(overrides?: Partial<AppToolRunnerContext>): AppToolRunnerContext {
  return {
    ownerId: "owner-1",
    userId: "user-1",
    agentId: "agent-1",
    memoryAccessEnvelope: {} as never,
    currentFolder: CURRENT,
    workspacePath: "/tmp/workspace",
    roomId: "room-1",
    turnId: "turn-agent-1",
    ...overrides,
  };
}

function desktopCaps(): RelayCapabilities {
  return {
    profile: "desktop-agent",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    localFileExecution: true,
    canRunOffice: true,
    allowedRoots: [CURRENT],
  };
}

type LocalFileHandler = (
  command: string,
  args: Record<string, unknown>,
) => unknown;

function makeFileRegistry(handler: LocalFileHandler): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => ["relay-1"],
    getCapabilities: () => desktopCaps(),
    getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
    async dispatch() {
      return { status: "error", error: "fs dispatch must not be used" };
    },
    async localFileDispatch(_relayId, req, meta) {
      if (req.operation.kind === "office") {
        return { ok: false, message: "unexpected office op in file registry" };
      }
      if (req.operation.kind !== "file") {
        return { ok: false, message: "expected file op" };
      }
      expect(meta.mutating).toBe(req.operation.command === "write");
      if (req.operation.command === "write") {
        expect(meta.approvalObtained).toBe(true);
      }
      return {
        ok: true,
        result: handler(req.operation.command, req.operation.args),
      };
    },
  };
}

function makeOfficeRegistry(
  handler: (subkind: string, op: Record<string, unknown>) => unknown,
): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => ["relay-1"],
    getCapabilities: () => desktopCaps(),
    getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
    async dispatch() {
      return { status: "error", error: "fs dispatch must not be used" };
    },
    async localFileDispatch(_relayId, req, meta) {
      if (req.operation.kind !== "office") {
        return { ok: false, message: "expected office op" };
      }
      const op = req.operation.operation;
      if (op["mode"] === "write") {
        expect(meta.approvalObtained).toBe(true);
        expect(meta.mutating).toBe(true);
      }
      return { ok: true, result: handler(String(op["subkind"]), op) };
    },
  };
}

beforeEach(() => {
  setRelayRegistry(null);
});

describe("app-tool-host currentFolder static guard (M206)", () => {
  test("createProductionDocumentOperations does not call selectFileBackend for current zone", async () => {
    const src = await readFile(
      join(import.meta.dir, "../../src/apps/app-tool-host.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/selectFileBackend\(\s*\{[^}]*zone:\s*["']current["']/);
    expect(src).not.toMatch(/selectBackend\(\s*["']current["']/);
    expect(src).not.toMatch(/zone:\s*["']current["'][^}]*selectFileBackend/);
  });
});

describe("currentFolder document operations via local-file dispatch (M206)", () => {
  it("writeBound refuses a human save raced before relay commit without overwriting it", async () => {
    const inspectedSha256 = "a".repeat(64);
    const humanSha256 = "b".repeat(64);
    let disk = "human save";
    setRelayRegistry(
      makeFileRegistry((command, args) => {
        expect(command).toBe("write");
        expect(args["expectedSha256"]).toBe(inspectedSha256);
        if (args["expectedSha256"] !== humanSha256) {
          return JSON.stringify({
            error: "stale_sha256",
            message: "canonical file sha256 does not match expectedSha256",
            expectedSha256: args["expectedSha256"],
            actualSha256: humanSha256,
          });
        }
        disk = String(args["content"]);
        return JSON.stringify({
          applied: true,
          revisionId: "local:relay-1:write",
          sha256: humanSha256,
        });
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext(),
      liveMutationBinding: {
        targetKind: "currentFile",
        appId: "writer-local-test",
        userId: "user-1",
        localTargetId: "opaque-current-target",
        relayId: "relay-1",
        canonicalPath: `${CURRENT}/doc.html`,
        currentFolderRoot: CURRENT,
        relativePath: "doc.html",
        documentVersion: { kind: "local_sha", sha256: inspectedSha256 },
      },
      liveReviewCurrentFileIdentity: async () => `${CURRENT}/doc.html`,
    });

    const result = await host.document.writeBound({ content: "agent save" });
    expect(result).toEqual({ kind: "conflict", currentSha256: humanSha256 });
    expect(disk).toBe("human save");
  });

  it("writeBound commits when the relay's canonical SHA still matches", async () => {
    const inspectedSha256 = "a".repeat(64);
    let disk = "inspected save";
    setRelayRegistry(
      makeFileRegistry((command, args) => {
        expect(command).toBe("write");
        expect(args["expectedSha256"]).toBe(inspectedSha256);
        disk = String(args["content"]);
        return JSON.stringify({
          applied: true,
          revisionId: "local:relay-1:write",
          sha256: "b".repeat(64),
        });
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext(),
      liveMutationBinding: {
        targetKind: "currentFile",
        appId: "writer-local-test",
        userId: "user-1",
        localTargetId: "opaque-current-target",
        relayId: "relay-1",
        canonicalPath: `${CURRENT}/doc.html`,
        currentFolderRoot: CURRENT,
        relativePath: "doc.html",
        documentVersion: { kind: "local_sha", sha256: inspectedSha256 },
      },
      liveReviewCurrentFileIdentity: async () => `${CURRENT}/doc.html`,
    });

    expect(await host.document.writeBound({ content: "agent save" })).toMatchObject({
      kind: "saved",
    });
    expect(disk).toBe("agent save");
  });

  it("writeBound never writes when the relay cannot read the guarded canonical file", async () => {
    const inspectedSha256 = "a".repeat(64);
    const disk = "unreadable canonical save";
    setRelayRegistry(
      makeFileRegistry((command, args) => {
        expect(command).toBe("write");
        expect(args["expectedSha256"]).toBe(inspectedSha256);
        return JSON.stringify({
          error: "read_failed",
          message: "could not read canonical bytes for guarded write",
        });
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext(),
      liveMutationBinding: {
        targetKind: "currentFile",
        appId: "writer-local-test",
        userId: "user-1",
        localTargetId: "opaque-current-target",
        relayId: "relay-1",
        canonicalPath: `${CURRENT}/doc.html`,
        currentFolderRoot: CURRENT,
        relativePath: "doc.html",
        documentVersion: { kind: "local_sha", sha256: inspectedSha256 },
      },
      liveReviewCurrentFileIdentity: async () => `${CURRENT}/doc.html`,
    });

    expect(await host.document.writeBound({ content: "agent save" })).toEqual({
      kind: "error",
      message: "read_failed: could not read canonical bytes for guarded write",
    });
    expect(disk).toBe("unreadable canonical save");
  });

  it("createFromAction binds retries to host authority and reports structured relay failures honestly", async () => {
    const requestIds: string[] = [];
    let fail = false;
    setRelayRegistry(
      makeFileRegistry((command, args) => {
        expect(command).toBe("write");
        expect(args["expectedSha256"]).toBeNull();
        expect(args["encoding"]).toBe("base64");
        requestIds.push(
          String((args["_routing"] as { mutationRequestId?: string }).mutationRequestId),
        );
        return fail
          ? JSON.stringify({ error: "unknown", code: "unknown", message: "outcome unknown" })
          : JSON.stringify({ applied: true, revisionId: "local:relay-1:create", sha256: sha256Hex(Buffer.from(String(args["content"]), "base64")) });
      }),
    );
    const manifest = await productionDesignManifest();
    const appsRoot = resolve(import.meta.dir, "../../../first-party-apps");
    const create = async (overrides?: Partial<AppToolRunnerContext>) =>
      createAppToolHost({
        appId: "nautilo-design",
        appsRoot,
        manifest,
        context: baseContext(overrides),
      }).document.createFromAction("new-design", {
        targetSurface: "currentFolder",
        filename: "Hero.design.html",
      });

    expect(await create()).toMatchObject({
      target: { surface: "currentFolder", relativePath: "Hero.design.html" },
      opened: false,
    });
    expect(await create()).toMatchObject({ displayPath: "Hero.design.html" });
    expect(requestIds[0]).toBe(requestIds[1]);

    expect(await create({ userId: "user-2", ownerId: "owner-2" })).toBeDefined();
    expect(await create({ roomId: "room-2" })).toBeDefined();
    expect(await create({ currentFolder: "/tmp/other-current" })).toBeDefined();
    expect(new Set(requestIds).size).toBe(4);

    fail = true;
    let thrown: unknown;
    try {
      await create({ turnId: "turn-agent-2" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("outcome unknown");
  });

  it("Slides creation is exclusive, offers its original folder, and never claims navigation", async () => {
    let disk: string | null = null;
    let calls = 0;
    setRelayRegistry(makeFileRegistry((command, args) => {
      expect(command).toBe("write");
      expect(args["expectedSha256"]).toBeNull();
      calls += 1;
      if (disk !== null) return JSON.stringify({ error: "destination_exists", message: "Already exists" });
      disk = Buffer.from(String(args["content"]), "base64").toString("utf8");
      return JSON.stringify({ applied: true, revisionId: "local:create", sha256: sha256Hex(Buffer.from(disk)) });
    }));
    const manifest = await Bun.file(resolve(import.meta.dir, "../../../first-party-apps/presentation/app.json")).json() as MiniAppManifest;
    const host = createAppToolHost({ appId: manifest.id, manifest,
      appsRoot: resolve(import.meta.dir, "../../../first-party-apps"), context: baseContext(),
      liveReviewCurrentFileIdentity: async () => null });
    const result = await host.document.createFromAction("new-presentation", {
      targetSurface: "currentFolder", filename: "New deck.presentation.html", openAfterCreate: true,
    });
    expect(result).toMatchObject({ opened: false, openInApp: {
      appId: "nautilo-presentation", appName: "Slides", target: {
        surface: "currentFolder", relativePath: "New deck.presentation.html", currentFolderRoot: CURRENT,
      },
    }});
    const saved = disk;
    let failure: unknown;
    try { await host.document.createFromAction("new-presentation", {
      targetSurface: "currentFolder", filename: "New deck.presentation.html",
    }); } catch (error) { failure = JSON.parse((error as Error).message); }
    expect(failure).toMatchObject({ ok: false, code: "destination_exists", stateChanged: false,
      recoveryActions: ["choose_another_filename", "inspect_existing_document"] });
    expect(disk).toBe(saved);
    expect(calls).toBe(2);
  });

  it("read routes through local-file read without selectFileBackend", async () => {
    let sawRead = false;
    setRelayRegistry(
      makeFileRegistry((command, args) => {
        expect(command).toBe("read");
        expect(args["binary"]).toBe(true);
        sawRead = true;
        return JSON.stringify({
          content: Buffer.from("<html>doc</html>", "utf8").toString("base64"),
          binary: true,
        });
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext(),
    });
    const result = await host.document.read({ surface: "currentFolder", relativePath: "doc.html" });
    expect(sawRead).toBe(true);
    expect(result.content).toBe("<html>doc</html>");
  });

  it("stat routes through local-file stat", async () => {
    setRelayRegistry(
      makeFileRegistry((command) => {
        expect(command).toBe("stat");
        return JSON.stringify({ path: "doc.html", size: 42, mimeType: "text/html" });
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext(),
    });
    const result = await host.document.stat({ surface: "currentFolder", relativePath: "doc.html" });
    expect(result.exists).toBe(true);
    expect(result.size).toBe(42);
  });

  it("write fails before dispatch without turnId or appOperationId", async () => {
    let dispatched = false;
    setRelayRegistry(
      makeFileRegistry(() => {
        dispatched = true;
        return JSON.stringify({ applied: true });
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: { ...baseContext(), turnId: null },
    });
    const result = await host.document.write(
      { surface: "currentFolder", relativePath: "doc.html" },
      { content: "<html>next</html>" },
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain(LOCAL_HISTORY_INPUT_REQUIRED);
    expect(dispatched).toBe(false);
  });

  it("write journals with host appOperationId when turnId is absent", async () => {
    const appOpId = createAppOperationId("writer-local-test");
    let routingAppOpId: string | undefined;
    let mutationRequestId: string | undefined;
    const content = "<html>ui-export</html>";
    setRelayRegistry(
      makeFileRegistry((command, args) => {
        if (command === "write") {
          routingAppOpId = (args["_routing"] as { appOperationId?: string })?.appOperationId;
          mutationRequestId = (args["_routing"] as { mutationRequestId?: string })?.mutationRequestId;
          expect((args["_routing"] as { turnId?: string })?.turnId).toBeUndefined();
          return JSON.stringify({
            applied: true,
            revisionId: "local:relay-1:rev-ui",
          });
        }
        return JSON.stringify({
          content: Buffer.from("<html>old</html>", "utf8").toString("base64"),
          binary: true,
        });
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext({ turnId: null, appOperationId: appOpId }),
    });
    const result = await host.document.write(
      { surface: "currentFolder", relativePath: "doc.html" },
      { content },
    );
    expect(routingAppOpId).toBe(appOpId);
    expect(mutationRequestId).toMatch(/^d448:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(isAppOperationId(appOpId)).toBe(true);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.localRevisionId).toBe("local:relay-1:rev-ui");
  });

  it("write propagates turnId and returns local revision id", async () => {
    let routingTurnId: string | undefined;
    const content = "<html>next</html>";
    setRelayRegistry(
      makeFileRegistry((command, args) => {
        if (command === "write") {
          routingTurnId = (args["_routing"] as { turnId?: string })?.turnId;
          return JSON.stringify({
            applied: true,
            revisionId: "local:relay-1:rev-abc",
          });
        }
        return JSON.stringify({
          content: Buffer.from("<html>old</html>", "utf8").toString("base64"),
          binary: true,
        });
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext({ turnId: "turn-write-1" }),
    });
    const result = await host.document.write(
      { surface: "currentFolder", relativePath: "doc.html" },
      { content },
    );
    expect(routingTurnId).toBe("turn-write-1");
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.localRevisionId).toBe("local:relay-1:rev-abc");
  });
});

describe("Writer office.run currentFolder routing (M206)", () => {
  it("import read threads appOperationId through office read dispatch", async () => {
    const appOpId = createAppOperationId("writer-local-test");
    let routingAppOpId: string | undefined;
    setRelayRegistry(
      makeOfficeRegistry((subkind, op) => {
        expect(subkind).toBe("officeRun");
        expect(op["mode"]).toBe("read");
        routingAppOpId = (op["_routing"] as { appOperationId?: string })?.appOperationId;
        expect((op["_routing"] as { turnId?: string })?.turnId).toBeUndefined();
        return { json: { body: [] } };
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext({ turnId: null, appOperationId: appOpId }),
    });
    const res = await host.office.run({
      input: { surface: "currentFolder", path: "source.docx" },
      readArgv: ["get", "/body", "--json"],
    });
    expect(res.ok).toBe(true);
    expect(routingAppOpId).toBe(appOpId);
  });

  it("import read dispatches officeRun read locally and threads agent turnId", async () => {
    let sawRoutingTurnId: string | undefined;
    setRelayRegistry(
      makeOfficeRegistry((subkind, op) => {
        expect(subkind).toBe("officeRun");
        expect(op["mode"]).toBe("read");
        sawRoutingTurnId = (op["_routing"] as { turnId?: string })?.turnId;
        return { json: { body: [] } };
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext({ turnId: "turn-import-1" }),
    });
    const res = await host.office.run({
      input: { surface: "currentFolder", path: "source.docx" },
      readArgv: ["get", "/body", "--json"],
    });
    expect(res.ok).toBe(true);
    expect(sawRoutingTurnId).toBe("turn-import-1");
  });

  it("export write requires turnId or appOperationId before dispatch", async () => {
    let dispatched = false;
    setRelayRegistry(
      makeOfficeRegistry(() => {
        dispatched = true;
        return { sha256: "abc", byteLength: 3, displayPath: "out.docx" };
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext({ turnId: null }),
    });
    const res = await host.office.run({
      ops: [],
      output: { surface: "currentFolder", path: "out.docx" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(LOCAL_HISTORY_INPUT_REQUIRED);
    expect(dispatched).toBe(false);
  });

  it("export write journals with one appOperationId for UI operations", async () => {
    const appOpId = createAppOperationId("writer-local-test");
    let routingAppOpId: string | undefined;
    let mutationRequestId: string | undefined;
    setRelayRegistry(
      makeOfficeRegistry((subkind, op) => {
        expect(subkind).toBe("officeRun");
        routingAppOpId = (op["_routing"] as { appOperationId?: string })?.appOperationId;
        mutationRequestId = (op["_routing"] as { mutationRequestId?: string })?.mutationRequestId;
        expect((op["_routing"] as { turnId?: string })?.turnId).toBeUndefined();
        return { sha256: "abc", byteLength: 3, displayPath: "out.docx" };
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext({ turnId: null, appOperationId: appOpId }),
    });
    const res = await host.office.run({
      ops: [{ command: "add", parent: "/", type: "paragraph", props: { text: "hi" } }],
      output: { surface: "currentFolder", path: "out.docx" },
    });
    expect(res.ok).toBe(true);
    expect(routingAppOpId).toBe(appOpId);
    expect(mutationRequestId).toMatch(/^d448:[a-f0-9]{64}:[a-f0-9]{64}$/);
  });

  it("export write propagates turnId through office routing", async () => {
    let routingTurnId: string | undefined;
    setRelayRegistry(
      makeOfficeRegistry((subkind, op) => {
        expect(subkind).toBe("officeRun");
        routingTurnId = (op["_routing"] as { turnId?: string })?.turnId;
        return { sha256: "abc", byteLength: 3, displayPath: "out.docx" };
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext({ turnId: "turn-export-1" }),
    });
    const res = await host.office.run({
      ops: [{ command: "add", parent: "/", type: "paragraph", props: { text: "hi" } }],
      output: { surface: "currentFolder", path: "out.docx" },
    });
    expect(res.ok).toBe(true);
    expect(routingTurnId).toBe("turn-export-1");
  });

  it("rejects unsupported workspace source with currentFolder output mix", async () => {
    setRelayRegistry(makeOfficeRegistry(() => ({ json: {} })));
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext(),
    });
    const res = await host.office.run({
      input: { surface: "workspace", path: "missing.docx" },
      readArgv: ["get", "/body", "--json"],
      output: { surface: "currentFolder", path: "out.docx" },
      ops: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("READ_FAILED");
  });

  // Stack 198 regression: a missing/unsupported workspace source must surface
  // READ_FAILED even when the OfficeCLI binary is unavailable. Before the
  // fix, `executeOfficeRun` resolved the binary first and returned UNAVAILABLE,
  // masking the real input error. Receiving READ_FAILED here (not UNAVAILABLE)
  // proves the input is read/validated BEFORE binary resolution — no installed
  // binary is required to report a source error honestly.
  it("returns READ_FAILED for a missing workspace source without resolving the OfficeCLI binary", async () => {
    setRelayRegistry(null);
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext(),
    });
    const res = await host.office.run({
      input: { surface: "workspace", path: "missing.docx" },
      readArgv: ["get", "/body", "--json"],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("READ_FAILED");
    expect(res.code).not.toBe("UNAVAILABLE");
  });

  // Stack 198 regression: the currentFolder read path must be unchanged — it
  // dispatches the officeRun read locally and returns BEFORE any binary
  // resolution, so it works without an installed OfficeCLI binary.
  it("currentFolder read path is unchanged and does not resolve the OfficeCLI binary", async () => {
    let sawOfficeRun = false;
    setRelayRegistry(
      makeOfficeRegistry((subkind, op) => {
        expect(subkind).toBe("officeRun");
        expect(op["mode"]).toBe("read");
        sawOfficeRun = true;
        return { json: { body: [] } };
      }),
    );
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: baseContext({ turnId: "turn-cf-read-1" }),
    });
    const res = await host.office.run({
      input: { surface: "currentFolder", path: "source.docx" },
      readArgv: ["get", "/body", "--json"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(sawOfficeRun).toBe(true);
    expect(res.json).toEqual({ body: [] });
  });
});

describe("workspace document operations regression (M206)", () => {
  it("workspace routes are unchanged and do not require relay registry", async () => {
    setRelayRegistry(null);
    const host = createAppToolHost({
      appId: "writer-local-test",
      appsRoot: "/tmp/apps",
      manifest: makeManifest(),
      context: { ...baseContext(), currentFolder: null },
    });
    expect(() => host.document.read({ surface: "workspace", path: "notes.html" })).toThrow();
  });
});

describe("explicit local read scan policy on registered Writer tools (M206)", () => {
  test("inspect-document remains read-only with never scan; mutation tools scan on-suspicious", async () => {
    const raw = await readFile(
      join(import.meta.dir, "../../../first-party-apps/writer/app.json"),
      "utf8",
    );
    const manifest = JSON.parse(raw) as {
      agent?: {
        tools?: Array<{ id: string; impact: string; resultScanPolicy?: string }>;
      };
    };
    const inspect = manifest.agent?.tools?.find((t) => t.id === "inspect-document");
    const replace = manifest.agent?.tools?.find((t) => t.id === "replace-text");
    expect(inspect?.impact).toBe("read-only");
    expect(inspect?.resultScanPolicy).toBe("never");
    expect(replace?.impact).not.toBe("read-only");
    expect(replace?.resultScanPolicy).toBe("on-suspicious");
  });
});
