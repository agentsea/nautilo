import { describe, expect, test } from "bun:test";
import {
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  RELAY_PROTOCOL_VERSION,
  type RelayCapabilities,
  type RelayDispatchResult,
  type RelayLocalFileRequest,
  type RelayLocalFileResult,
} from "@nautilo/relay";
import type { ResolvedFocusedResource } from "@nautilo/types";
import { setRelayRegistry } from "../../src/nodes/tools";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import { executeLocalFileCommand } from "../../src/tools/file/local-file-dispatch";
import { createFileTool } from "../../src/tools/file/file-tool";
import {
  runWithRequiredOrdinaryHostContext,
  runWithRequiredOrdinaryHostRelay,
} from "../../src/runtime/ordinary-host-dispatch-context";
import {
  buildFocusedLocalFileHints,
  canonicalLocalFilePath,
  FOCUSED_RELAY_MISMATCH_MESSAGE,
  getFocusedLocalFileHints,
  RELAY_OWNERSHIP_MISMATCH,
  resolveFocusedRelayHintForPath,
  resolveLocalFileRelay,
  runWithFocusedLocalFileHints,
} from "../../src/tools/file/local-file-routing";
import { executeLocalOfficeOperation } from "../../src/tools/office/local-office-dispatch";
import { createExtractAudioFromVideoTool } from "../../src/tools/media/extract-audio-from-video";

const ownerId = "user-1";

function caps(over: Partial<RelayCapabilities> = {}): RelayCapabilities {
  return {
    profile: "desktop-agent",
    workspaceRoot: "/Users/alice/project",
    dataDir: "/Users/alice/.nautilo",
    toolsBin: "/opt/nautilo/tools",
    userHome: "/Users/alice",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    localFileExecution: true,
    canRunOffice: true,
    allowedRoots: ["/Users/alice/project"],
    ...over,
  };
}

/**
 * Multi-relay registry: `findByCapabilityForUser` returns every relay that
 * advertises the requested capability for `ownerId`, preserving insertion
 * order so the default `candidates.find(...)` selection is deterministic
 * (relay-A wins by default).
 */
function makeRegistry(
  relays: Record<string, RelayCapabilities>,
  options: {
    protocolVersion?: number;
    localFileDispatch?: (
      relayId: string,
      req: RelayLocalFileRequest,
    ) => Promise<RelayLocalFileResult>;
    dispatch?: (relayId: string) => Promise<RelayDispatchResult>;
  } = {},
): ToolRelayRegistry {
  const version = options.protocolVersion ?? RELAY_PROTOCOL_VERSION;
  return {
    findByCapabilityForUser(capability, userId) {
      if (userId !== ownerId) return [];
      return Object.entries(relays)
        .filter(([, c]) => (c as Record<string, unknown>)[capability] === true)
        .map(([id]) => id);
    },
    getCapabilities(id) {
      return relays[id];
    },
    getProtocolVersion() {
      return version;
    },
    async dispatch(relayId) {
      return options.dispatch
        ? options.dispatch(relayId)
        : ({ status: "error", error: "dispatch not mocked" } as RelayDispatchResult);
    },
    async localFileDispatch(relayId, req) {
      return options.localFileDispatch
        ? options.localFileDispatch(relayId, req)
        : { ok: true, result: "ok" };
    },
  };
}

function localFileResource(
  relayId: string,
  absPath: string,
  name = "deck.pptx",
): ResolvedFocusedResource {
  return {
    kind: "local-file",
    displayName: name,
    location: "relay",
    lifetime: "turn",
    capabilities: ["read", "edit"],
    toolTarget: { tool: "file", zone: "absolute", path: absPath },
    locator: { relayId, path: absPath },
  };
}

describe("buildFocusedLocalFileHints (D423 Phase 5)", () => {
  test("only local-file entries contribute; paths are canonicalized", () => {
    const manifest: ResolvedFocusedResource[] = [
      {
        kind: "workspace-artifact",
        displayName: "note.md",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read", "edit"],
        locator: { artifactId: "art-1" },
      },
      {
        kind: "message-attachment",
        displayName: "upload.pdf",
        location: "server",
        lifetime: "message",
        capabilities: ["read"],
        locator: { attachmentId: "att-1" },
      },
      localFileResource("relay-B", "/Users/alice/project/../project/deck.pptx"),
    ];
    const hints = buildFocusedLocalFileHints(manifest);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.relayId).toBe("relay-B");
    expect(hints[0]?.path).toBe(canonicalLocalFilePath("/Users/alice/project/../project/deck.pptx"));
  });

  test("undefined / empty manifest yields no hints", () => {
    expect(buildFocusedLocalFileHints(undefined)).toEqual([]);
    expect(buildFocusedLocalFileHints([])).toEqual([]);
  });

  test("local-file entry missing locator fields is skipped", () => {
    const broken = {
      ...localFileResource("relay-B", "/x/y.pptx"),
      locator: { relayId: "relay-B" },
    } as ResolvedFocusedResource;
    expect(buildFocusedLocalFileHints([broken])).toEqual([]);
  });
});

describe("resolveFocusedRelayHintForPath (D423 Phase 5)", () => {
  const hints = buildFocusedLocalFileHints([
    localFileResource("relay-B", "/Users/alice/project/deck.pptx"),
  ]);

  test("no hints bound => undefined", () => {
    expect(getFocusedLocalFileHints()).toHaveLength(0);
    expect(
      resolveFocusedRelayHintForPath({
        path: "/Users/alice/project/deck.pptx",
        zone: "absolute",
        currentFolder: null,
      }),
    ).toBeUndefined();
  });

  test("absolute zone matches a focused canonical path", () => {
    runWithFocusedLocalFileHints(hints, () => {
      expect(
        resolveFocusedRelayHintForPath({
          path: "/Users/alice/project/deck.pptx",
          zone: "absolute",
          currentFolder: null,
        }),
      ).toBe("relay-B");
    });
  });

  test("current zone reconstructs against currentFolder and matches", () => {
    runWithFocusedLocalFileHints(hints, () => {
      expect(
        resolveFocusedRelayHintForPath({
          path: "deck.pptx",
          zone: "current",
          currentFolder: "/Users/alice/project",
        }),
      ).toBe("relay-B");
    });
  });

  test("current zone without currentFolder cannot reconstruct => undefined", () => {
    runWithFocusedLocalFileHints(hints, () => {
      expect(
        resolveFocusedRelayHintForPath({
          path: "deck.pptx",
          zone: "current",
          currentFolder: null,
        }),
      ).toBeUndefined();
    });
  });

  test("non-matching path => undefined (preserves default routing)", () => {
    runWithFocusedLocalFileHints(hints, () => {
      expect(
        resolveFocusedRelayHintForPath({
          path: "/Users/alice/project/other.pptx",
          zone: "absolute",
          currentFolder: null,
        }),
      ).toBeUndefined();
    });
  });
});

describe("executeLocalFileCommand — exact-relay routing (D423 Phase 5)", () => {
  function fileCtx(currentFolder: string | null = "/Users/alice/project") {
    return {
      ownerId,
      agentId: "agent-1",
      turnId: "turn-1",
      zoneCtx: { workspaceRoot: "/srv/ws", currentFolder },
      approvalObtained: true,
    };
  }

  test("no hints => default relay-A selection preserved", async () => {
    const calls: Array<{ relayId: string }> = [];
    setRelayRegistry(
      makeRegistry(
        { "relay-A": caps(), "relay-B": caps() },
        {
          localFileDispatch: async (relayId) => {
            calls.push({ relayId });
            return { ok: true, result: JSON.stringify({ matches: [] }) };
          },
        },
      ),
    );
    const out = await executeLocalFileCommand(
      { command: "grep", zone: "current", path: "deck.pptx", query: "x" },
      fileCtx(),
    );
    expect(typeof out).toBe("string");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.relayId).toBe("relay-A");
  });

  test("matching absolute ref => dispatches to focused relay-B", async () => {
    const calls: Array<{ relayId: string }> = [];
    setRelayRegistry(
      makeRegistry(
        { "relay-A": caps(), "relay-B": caps() },
        {
          localFileDispatch: async (relayId) => {
            calls.push({ relayId });
            return { ok: true, result: JSON.stringify({ matches: [] }) };
          },
        },
      ),
    );
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-B", "/Users/alice/other/deck.pptx"),
    ]);
    await runWithFocusedLocalFileHints(hints, async () => {
      await executeLocalFileCommand(
        { command: "read", zone: "absolute", path: "/Users/alice/other/deck.pptx" },
        fileCtx(null),
      );
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.relayId).toBe("relay-B");
  });

  test("matching current ref (relative path) => dispatches to focused relay-B", async () => {
    const calls: Array<{ relayId: string }> = [];
    setRelayRegistry(
      makeRegistry(
        { "relay-A": caps(), "relay-B": caps() },
        {
          localFileDispatch: async (relayId) => {
            calls.push({ relayId });
            return { ok: true, result: "ok" };
          },
        },
      ),
    );
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-B", "/Users/alice/project/deck.pptx"),
    ]);
    await runWithFocusedLocalFileHints(hints, async () => {
      await executeLocalFileCommand(
        { command: "read", zone: "current", path: "deck.pptx" },
        fileCtx("/Users/alice/project"),
      );
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.relayId).toBe("relay-B");
  });

  test("D458 required host pins dispatch to the selected relay, never first eligible", async () => {
    const calls: Array<{ relayId: string }> = [];
    setRelayRegistry(
      makeRegistry(
        { "relay-A": caps(), "relay-B": caps() },
        { localFileDispatch: async (relayId) => {
          calls.push({ relayId });
          return { ok: true, result: "ok" };
        } },
      ),
    );
    await runWithRequiredOrdinaryHostRelay("relay-B", () =>
      executeLocalFileCommand(
        { command: "read", zone: "current", path: "notes.md" },
        fileCtx(),
      ),
    );
    expect(calls).toEqual([{ relayId: "relay-B" }]);
  });

  test("paired-mobile host context supplies Current Folder and Workspace roots to the file tool", async () => {
    const calls: Array<{ relayId: string; request: RelayLocalFileRequest }> = [];
    setRelayRegistry(
      makeRegistry(
        { "relay-A": caps(), "relay-B": caps() },
        { localFileDispatch: async (relayId, request) => {
          calls.push({ relayId, request });
          return { ok: true, result: "ok" };
        } },
      ),
    );
    const tool = createFileTool({
      ownerId,
      agentId: "agent-1",
      roomId: "room-1",
      currentFolder: "",
      workspacePath: "",
      activeModelId: "",
      memoryAccessEnvelope: null,
    });

    await runWithRequiredOrdinaryHostContext({
      relayId: "relay-B",
      currentFolderRoot: "/Users/alice/project",
      workspaceRoot: "/Users/alice/workspace",
    }, () => tool.invoke({ command: "list", zone: "current", path: "." }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.relayId).toBe("relay-B");
    expect(JSON.stringify(calls[0]?.request)).toContain('"currentFolder":"/Users/alice/project"');
    expect(JSON.stringify(calls[0]?.request)).toContain('"workspaceRoot":"/Users/alice/workspace"');
  });

  test("D458 required host conflict with focused file fails closed without dispatch", async () => {
    const calls: Array<{ relayId: string }> = [];
    setRelayRegistry(
      makeRegistry(
        { "relay-A": caps(), "relay-B": caps() },
        { localFileDispatch: async (relayId) => {
          calls.push({ relayId });
          return { ok: true, result: "ok" };
        } },
      ),
    );
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-A", "/Users/alice/project/notes.md"),
    ]);
    const out = await runWithFocusedLocalFileHints(hints, () =>
      runWithRequiredOrdinaryHostRelay("relay-B", () =>
        executeLocalFileCommand(
          { command: "read", zone: "current", path: "notes.md" },
          fileCtx(),
        ),
      ),
    );
    const content = typeof out === "string" ? out : JSON.stringify(out.content);
    expect(content).toContain(RELAY_OWNERSHIP_MISMATCH);
    expect(calls).toHaveLength(0);
  });

  test("hints bound but path not focused => default relay-A", async () => {
    const calls: Array<{ relayId: string }> = [];
    setRelayRegistry(
      makeRegistry(
        { "relay-A": caps(), "relay-B": caps() },
        {
          localFileDispatch: async (relayId) => {
            calls.push({ relayId });
            return { ok: true, result: "ok" };
          },
        },
      ),
    );
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-B", "/Users/alice/other/deck.pptx"),
    ]);
    await runWithFocusedLocalFileHints(hints, async () => {
      await executeLocalFileCommand(
        { command: "read", zone: "absolute", path: "/Users/alice/project/unrelated.txt" },
        fileCtx(null),
      );
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.relayId).toBe("relay-A");
  });

  test("focused relay not paired for owner => fail closed RELAY_OWNERSHIP_MISMATCH, no dispatch", async () => {
    const calls: Array<{ relayId: string }> = [];
    setRelayRegistry(
      makeRegistry(
        { "relay-A": caps() },
        {
          localFileDispatch: async (relayId) => {
            calls.push({ relayId });
            return { ok: true, result: "ok" };
          },
        },
      ),
    );
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-impostor", "/Users/alice/project/deck.pptx"),
    ]);
    const out = await runWithFocusedLocalFileHints(hints, async () => {
      return executeLocalFileCommand(
        { command: "read", zone: "absolute", path: "/Users/alice/project/deck.pptx" },
        fileCtx(null),
      );
    });
    expect(typeof out).toBe("string");
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain(RELAY_OWNERSHIP_MISMATCH);
    expect(text).toContain(FOCUSED_RELAY_MISMATCH_MESSAGE);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveLocalFileRelay — hint mismatch message (D423 Phase 5)", () => {
  test("focus hint miss uses the focused mismatch message, not the revision message", () => {
    const reg = makeRegistry({ "relay-A": caps() });
    const sel = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: reg,
      relayIdHint: "relay-impostor",
      relayHintMismatchMessage: FOCUSED_RELAY_MISMATCH_MESSAGE,
    });
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.code).toBe(RELAY_OWNERSHIP_MISMATCH);
      expect(sel.error).toBe(FOCUSED_RELAY_MISMATCH_MESSAGE);
    }
  });

  test("unsupported registry still reports LOCAL_FILE_EXECUTION_UNSUPPORTED", () => {
    const sel = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: null,
      relayIdHint: "relay-B",
    });
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.code).toBe(LOCAL_FILE_EXECUTION_UNSUPPORTED);
  });
});

describe("executeLocalOfficeOperation — exact-relay routing (D423 Phase 5)", () => {
  function officeCtx(currentFolder: string | null = null) {
    return {
      ownerId,
      agentId: "agent-1",
      turnId: "turn-1",
      zoneCtx: { workspaceRoot: "/srv/ws", currentFolder },
      approvalObtained: true,
    };
  }

  test("matching absolute convert source => dispatches to focused relay-B", async () => {
    const calls: Array<{ relayId: string }> = [];
    setRelayRegistry(
      makeRegistry(
        {
          "relay-A": caps({ allowedRoots: ["/Users/alice/a"] }),
          "relay-B": caps({ allowedRoots: ["/Users/alice/b"] }),
        },
        {
          localFileDispatch: async (relayId) => {
            calls.push({ relayId });
            return { ok: true, result: { ok: true } };
          },
        },
      ),
    );
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-B", "/Users/alice/b/deck.pptx"),
    ]);
    await runWithFocusedLocalFileHints(hints, async () => {
      await executeLocalOfficeOperation(
        {
          subkind: "convert",
          sourceZone: "absolute",
          sourcePath: "/Users/alice/b/deck.pptx",
          destinationZone: "absolute",
          destinationPath: "/Users/alice/b/deck.pdf",
          inputFormat: "pptx",
          outputFormat: "pdf",
          backend: "local",
          summary: "convert deck",
          _routing: {
            ownerId,
            agentId: "agent-1",
            turnId: "turn-1",
            currentFolder: null,
            workspaceRoot: "/srv/ws",
          },
        },
        officeCtx(null),
      );
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.relayId).toBe("relay-B");
  });

  test("focused office relay not paired => fail closed RELAY_OWNERSHIP_MISMATCH", async () => {
    setRelayRegistry(makeRegistry({ "relay-A": caps() }));
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-impostor", "/Users/alice/a/deck.pptx"),
    ]);
    const out = await runWithFocusedLocalFileHints(hints, async () => {
      return executeLocalOfficeOperation(
        {
          subkind: "convert",
          sourceZone: "absolute",
          sourcePath: "/Users/alice/a/deck.pptx",
          destinationZone: "absolute",
          destinationPath: "/Users/alice/a/deck.pdf",
          inputFormat: "pptx",
          outputFormat: "pdf",
          backend: "local",
          summary: "convert deck",
          _routing: {
            ownerId,
            agentId: "agent-1",
            turnId: "turn-1",
            currentFolder: null,
            workspaceRoot: "/srv/ws",
          },
        },
        officeCtx(null),
      );
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe(RELAY_OWNERSHIP_MISMATCH);
      expect(out.error).toBe(FOCUSED_RELAY_MISMATCH_MESSAGE);
    }
  });
});

describe("extract_audio_from_video — exact-relay routing (D423 Phase 5)", () => {
  const mp4Bytes = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x10]), // size
    Buffer.from("ftyp"), // ISO BMFF file type box
    Buffer.from("mp42"),
    Buffer.from("\u0000\u0000\u0000\u0000"),
  ]);

  test("matching absolute source forwards the focused relay hint to extraction", async () => {
    let captured: { relayIdHint: string | undefined } | undefined;
    const tool = createExtractAudioFromVideoTool(
      {
        ownerId,
        agentId: "agent-1",
        currentFolder: "",
        workspacePath: "/srv/ws",
        memoryAccessEnvelope: { actorId: ownerId } as never,
      },
      {
        readLocalZoneBytes: async () => ({ ok: true, bytes: mp4Bytes }),
        dispatch: async (_source, _ownerId, relayIdHint) => {
          captured = { relayIdHint };
          return { ok: true, audio: Buffer.from("audio") };
        },
        createWorkspaceBinaryArtifact: async () => ({
          ok: true,
          artifactId: "art-1",
          artifactInternalId: "1",
          displayPath: "x/a.m4a",
          revision: null,
          size: 5,
          sha256: "hash",
        }),
      },
    );
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-B", "/Users/alice/other/clip.mp4", "clip.mp4"),
    ]);
    let result: string = "";
    await runWithFocusedLocalFileHints(hints, async () => {
      result = await tool.invoke({
        sourcePath: "/Users/alice/other/clip.mp4",
        sourceZone: "absolute",
        artifactPath: "clip.m4a",
      });
    });
    expect(result).not.toContain("Error:");
    expect(captured?.relayIdHint).toBe("relay-B");
  });

  test("focused extraction relay not paired => fail closed via real dispatchExtraction", async () => {
    setRelayRegistry(makeRegistry({ "relay-A": caps() }));
    const tool = createExtractAudioFromVideoTool(
      {
        ownerId,
        agentId: "agent-1",
        currentFolder: "",
        workspacePath: "/srv/ws",
        memoryAccessEnvelope: { actorId: ownerId } as never,
      },
      {
        readLocalZoneBytes: async () => ({ ok: true, bytes: mp4Bytes }),
        // deps.dispatch intentionally unset so the real dispatchExtraction runs
        // and exercises the hint-vs-candidate fail-closed path.
        createWorkspaceBinaryArtifact: async () => ({
          ok: true,
          artifactId: "art-1",
          artifactInternalId: "1",
          displayPath: "x/a.m4a",
          revision: null,
          size: 5,
          sha256: "hash",
        }),
      },
    );
    const hints = buildFocusedLocalFileHints([
      localFileResource("relay-impostor", "/Users/alice/other/clip.mp4", "clip.mp4"),
    ]);
    let result = "";
    await runWithFocusedLocalFileHints(hints, async () => {
      result = await tool.invoke({
        sourcePath: "/Users/alice/other/clip.mp4",
        sourceZone: "absolute",
        artifactPath: "clip.m4a",
      });
    });
    expect(result).toContain("Error:");
    expect(result).toContain(FOCUSED_RELAY_MISMATCH_MESSAGE);
  });
});
