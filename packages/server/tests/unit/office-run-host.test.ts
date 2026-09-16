import { beforeEach, describe, expect, it } from "bun:test";
import { setRelayRegistry, LOCAL_HISTORY_INPUT_REQUIRED, type ToolRelayRegistry } from "@nautilo/agent";
import { RELAY_PROTOCOL_VERSION, type RelayCapabilities } from "@nautilo/relay";
import { createAppToolHost, HostOperationError } from "../../src/apps/app-tool-host";
import type { AppDocumentOperations } from "../../src/apps/app-tool-host";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";

const noopOps = {
  createFromAction: async () => {
    throw new Error("unused");
  },
  read: async () => {
    throw new Error("unused");
  },
  stat: async () => {
    throw new Error("unused");
  },
  write: async () => {
    throw new Error("unused");
  },
  getState: async () => undefined,
  setState: async () => undefined,
} as unknown as AppDocumentOperations;

function makeManifest(office?: "none" | "convert"): MiniAppManifest {
  return {
    id: "office-test-app",
    name: "Office Test App",
    version: "1.0.0",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: { extensions: [], mimeTypes: [] },
    capabilities: {
      document: { artifact: "readwrite", currentFolder: "readwrite" },
      ...(office !== undefined ? { office } : {}),
    },
  } as MiniAppManifest;
}

const context = {
  ownerId: "owner-1",
  userId: "user-1",
  agentId: "agent-1",
  memoryAccessEnvelope: {} as never,
} as AppToolRunnerContext;

function makeLocalFileRegistry(handler: (command: string) => unknown): ToolRelayRegistry {
  const caps: RelayCapabilities = {
    profile: "desktop-agent",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    localFileExecution: true,
    canRunOffice: true,
    allowedRoots: ["/tmp/nautilo-test-current"],
  };
  return {
    findByCapabilityForUser: () => ["relay-1"],
    getCapabilities: () => caps,
    getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
    async dispatch() {
      return { status: "error", error: "not used" };
    },
    async localFileDispatch(_relayId, req, _meta) {
      if (req.operation.kind !== "file") {
        return { ok: false, message: "expected file op" };
      }
      return { ok: true, result: handler(req.operation.command) };
    },
  };
}

beforeEach(() => {
  setRelayRegistry(null);
});

describe("office.run host primitive — capability gate (M205)", () => {
  it("throws HostOperationError when capabilities.office is absent", async () => {
    const host = createAppToolHost({
      appId: "office-test-app",
      appsRoot: "/tmp/does-not-matter",
      manifest: makeManifest(undefined),
      context,
      documentOps: noopOps,
      relayRegistry: null,
    });
    let error: unknown;
    try {
      await host.office.run({
        input: { surface: "workspace", path: "x.docx" },
        readArgv: ["get", "/body", "--json"],
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HostOperationError);
  });

  it('throws HostOperationError when capabilities.office is "none"', async () => {
    const host = createAppToolHost({
      appId: "office-test-app",
      appsRoot: "/tmp/does-not-matter",
      manifest: makeManifest("none"),
      context,
      documentOps: noopOps,
      relayRegistry: null,
    });
    let error: unknown;
    try {
      await host.office.run({ ops: [], output: { surface: "workspace", path: "x.docx" } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HostOperationError);
  });
});

describe("office.run host primitive — currentFolder local relay (M206)", () => {
  function makeOfficeRegistry(handler: (subkind: string, op: Record<string, unknown>) => unknown) {
    const caps: RelayCapabilities = {
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      localFileExecution: true,
      canRunOffice: true,
      allowedRoots: ["/tmp/nautilo-test-current"],
    };
    const registry: ToolRelayRegistry = {
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => caps,
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() {
        return { status: "error", error: "not used" };
      },
      async localFileDispatch(_relayId, req, _meta) {
        if (req.operation.kind !== "office") {
          return { ok: false, message: "expected office op" };
        }
        const op = req.operation.operation;
        return { ok: true, result: handler(String(op["subkind"]), op) };
      },
    };
    setRelayRegistry(registry);
    return registry;
  }

  it("read path dispatches officeRun read without server staging", async () => {
    let sawOfficeRun = false;
    makeOfficeRegistry((subkind) => {
      expect(subkind).toBe("officeRun");
      sawOfficeRun = true;
      return { json: { body: "hello" } };
    });
    const host = createAppToolHost({
      appId: "office-test-app",
      appsRoot: "/tmp/does-not-matter",
      manifest: makeManifest("convert"),
      context: { ...context, currentFolder: "/tmp/nautilo-test-current" },
      documentOps: noopOps,
      relayRegistry: null,
    });
    const res = await host.office.run({
      input: { surface: "currentFolder", path: "doc.docx" },
      readArgv: ["get", "/body", "--json"],
    });
    expect(res.ok).toBe(true);
    expect(sawOfficeRun).toBe(true);
  });

  it("write path dispatches officeRun write without writeOfficeOutputBytes", async () => {
    let sawWrite = false;
    makeOfficeRegistry((subkind, op) => {
      expect(subkind).toBe("officeRun");
      expect(op["mode"]).toBe("write");
      sawWrite = true;
      return { sha256: "abc", byteLength: 42, displayPath: "out.docx" };
    });
    const host = createAppToolHost({
      appId: "office-test-app",
      appsRoot: "/tmp/does-not-matter",
      manifest: makeManifest("convert"),
      context: { ...context, currentFolder: "/tmp/nautilo-test-current", turnId: "turn-office-write" },
      documentOps: noopOps,
      relayRegistry: null,
    });
    const res = await host.office.run({
      ops: [{ command: "add", parent: "/", type: "paragraph", props: { text: "hi" } }],
      output: { surface: "currentFolder", path: "out.docx" },
    });
    expect(res.ok).toBe(true);
    expect(sawWrite).toBe(true);
  });

  it("write path forwards structured imageInputs to local officeRun dispatch", async () => {
    let capturedImageInputs: unknown = undefined;
    makeOfficeRegistry((subkind, op) => {
      expect(subkind).toBe("officeRun");
      capturedImageInputs = op["imageInputs"];
      return { sha256: "abc", byteLength: 42, displayPath: "out.docx" };
    });
    const host = createAppToolHost({
      appId: "office-test-app",
      appsRoot: "/tmp/does-not-matter",
      manifest: makeManifest("convert"),
      context: { ...context, currentFolder: "/tmp/nautilo-test-current", turnId: "turn-office-write" },
      documentOps: noopOps,
      relayRegistry: null,
    });
    const res = await host.office.run({
      ops: [{ command: "add", parent: "/body/p[1]", type: "picture", props: { _imageIndex: "0" } }],
      imageInputs: [{ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }],
      output: { surface: "currentFolder", path: "out.docx" },
    });
    expect(res.ok).toBe(true);
    expect(Array.isArray(capturedImageInputs)).toBe(true);
  });
});

describe("createDocument host primitive — current folder (M205/M206)", () => {
  it("requires turnId before writing to current folder", async () => {
    setRelayRegistry(null);
    const host = createAppToolHost({
      appId: "office-test-app",
      appsRoot: "/tmp/does-not-matter",
      manifest: makeManifest("convert"),
      context: { ...context, currentFolder: "/tmp/nautilo-test-current" },
      documentOps: noopOps,
      relayRegistry: null,
    });
    const res = await host.document.createDocument({
      surface: "currentFolder",
      path: "imported.html",
      content: "<html></html>",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(LOCAL_HISTORY_INPUT_REQUIRED);
    expect(res.message).toContain(LOCAL_HISTORY_INPUT_REQUIRED);
  });

  it("writes current-folder documents via local-file dispatch when turnId is present", async () => {
    let sawTurnId = false;
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/nautilo-test-current"],
      }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      async dispatch() {
        return { status: "error", error: "not used" };
      },
      async localFileDispatch(_relayId, req) {
        if (req.operation.kind !== "file") {
          return { ok: false, message: "expected file op" };
        }
        if (req.operation.command === "stat") {
          return { ok: true, result: "Error: ENOENT fresh.html" };
        }
        if (req.operation.command === "create") {
          const routing = req.operation.args["_routing"] as {
            turnId?: string;
            mutationRequestId?: string;
          } | undefined;
          sawTurnId = routing?.turnId === "turn-writer-1";
          expect(routing?.mutationRequestId).toMatch(/^d448:[a-f0-9]{64}:[a-f0-9]{64}$/);
          return {
            ok: true,
            result: JSON.stringify({ applied: true, revisionId: "local:relay-1:fresh" }),
          };
        }
        return { ok: false, message: "unexpected" };
      },
    });
    const host = createAppToolHost({
      appId: "office-test-app",
      appsRoot: "/tmp/does-not-matter",
      manifest: makeManifest("convert"),
      context: {
        ...context,
        currentFolder: "/tmp/nautilo-test-current",
        turnId: "turn-writer-1",
      },
      documentOps: noopOps,
      relayRegistry: null,
    });
    const res = await host.document.createDocument({
      surface: "currentFolder",
      path: "fresh.html",
      content: "<html></html>",
    });
    expect(res.ok).toBe(true);
    expect(sawTurnId).toBe(true);
  });
});

describe("createDocument current folder — conflict policy (M205/M206)", () => {
  function makeHost(registry: ToolRelayRegistry) {
    setRelayRegistry(registry);
    return createAppToolHost({
      appId: "office-test-app",
      appsRoot: "/tmp/does-not-matter",
      manifest: makeManifest("convert"),
      context: {
        ...context,
        currentFolder: "/tmp/nautilo-test-current",
        turnId: "turn-create-doc",
      },
      documentOps: noopOps,
      relayRegistry: registry,
    });
  }

  it("returns EXISTS (and does not write) when the target exists and overwrite is unset", async () => {
    let wrote = false;
    const host = makeHost(
      makeLocalFileRegistry((command) => {
        if (command === "create") {
          return JSON.stringify({ error: "EXISTS", message: "Destination already exists" });
        }
        if (command === "write") {
          wrote = true;
          return JSON.stringify({ applied: true, revisionId: "local:relay-1:exists" });
        }
        return "Error: unexpected";
      }),
    );
    const res = await host.document.createDocument({
      surface: "currentFolder",
      path: "imported.html",
      content: "<html></html>",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("EXISTS");
    expect(wrote).toBe(false);
  });

  it("overwrites in place when overwrite is true", async () => {
    let wrote = false;
    const host = makeHost(
      makeLocalFileRegistry((command) => {
        if (command === "write") {
          wrote = true;
          return JSON.stringify({ applied: true, revisionId: "local:relay-1:overwrite" });
        }
        return JSON.stringify({ path: "imported.html", size: 10, isFile: true });
      }),
    );
    const res = await host.document.createDocument({
      surface: "currentFolder",
      path: "imported.html",
      content: "<html></html>",
      overwrite: true,
    });
    expect(res.ok).toBe(true);
    expect(wrote).toBe(true);
  });

  it("writes when the target does not exist (ENOENT) without overwrite", async () => {
    let wrote = false;
    const host = makeHost(
      makeLocalFileRegistry((command) => {
        if (command === "stat") return "Error: ENOENT imported.html";
        if (command === "create") {
          wrote = true;
          return JSON.stringify({ applied: true, revisionId: "local:relay-1:fresh" });
        }
        return "Error: unexpected";
      }),
    );
    const res = await host.document.createDocument({
      surface: "currentFolder",
      path: "fresh.html",
      content: "<html></html>",
    });
    expect(res.ok).toBe(true);
    expect(wrote).toBe(true);
  });

  it("does not report success when Desktop returns a mutation error envelope", async () => {
    const host = makeHost(
      makeLocalFileRegistry((command) => {
        if (command === "stat") return "Error: ENOENT imported.html";
        if (command === "create") {
          return JSON.stringify({
            error: "missing_mutation_request_id",
            message: "trusted file-tool mutation request identity is unavailable",
          });
        }
        return "Error: unexpected";
      }),
    );
    const res = await host.document.createDocument({
      surface: "currentFolder",
      path: "fresh.html",
      content: "<html></html>",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("WRITE_FAILED");
    expect(res.message).toContain("missing_mutation_request_id");
  });
});
