import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  RELAY_FS_MAX_BYTES,
  RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
} from "@nautilo/relay";
import { MAX_DOCUMENT_BYTES } from "@nautilo/writer-proposal-core";
import type { RelayLocalFileRequest, RelayLocalFileResult } from "@nautilo/relay";
import {
  LiveLocalDocumentAuthority,
  isPathContainedInAllowedRoots,
  isPathContainedInRoot,
  resolveLiveCurrentFileCanonicalPath,
  validateLiveCurrentFileRelativePath,
  type LiveLocalRelayRegistryPort,
  type LiveLocalRelaySnapshot,
} from "../../src/apps/live-local-document-authority";
import type { LiveMiniAppSessionCurrentFileBinding } from "../../src/apps/live-mini-app-session-registry";

const CURRENT = "/Users/alice/project";
const WINDOWS_ROOT = "C:\\Users\\Alice\\project";
const WINDOWS_CANONICAL = `${WINDOWS_ROOT}\\docs\\report.html`;
const RELAY_ID = "relay-desktop-1";
const RELATIVE = "docs/report.html";
const CANONICAL = `${CURRENT}/${RELATIVE}`;
const LOCAL_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LOCAL_SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const DESKTOP_SNAPSHOT: LiveLocalRelaySnapshot = {
  ownedByActor: true,
  protocolVersion: 4,
  profile: "desktop-agent",
  localFileExecution: true,
  allowedRoots: [CURRENT],
};

function makeRegistry(
  snapshots: Record<string, LiveLocalRelaySnapshot | null>,
): LiveLocalRelayRegistryPort {
  return {
    snapshotForFocusedResource(relayId: string, _actorId: string) {
      return snapshots[relayId] ?? null;
    },
  };
}

function makeDispatch(
  handler: (
    relayId: string,
    req: RelayLocalFileRequest,
  ) => RelayLocalFileResult | Promise<RelayLocalFileResult>,
) {
  return {
    async fsDispatch(
      _relayId: string,
      req: { op: string; path: string },
      _opts: { mutating: boolean },
    ) {
      if (req.op !== "realpath") {
        return { ok: false as const, code: "EINVAL", message: "unexpected fs op" };
      }
      return { ok: true as const, realpath: req.path };
    },
    async localFileDispatch(
      relayId: string,
      req: RelayLocalFileRequest,
      _opts: { mutating: boolean; approvalObtained: boolean },
    ): Promise<RelayLocalFileResult> {
      return handler(relayId, req);
    },
  };
}

function statOk(size: number): RelayLocalFileResult {
  return {
    ok: true,
    result: JSON.stringify({
      path: CANONICAL,
      size,
      mtimeMs: 1,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    }),
  };
}

function readOk(content: string): RelayLocalFileResult {
  return {
    ok: true,
    result: JSON.stringify({
      content: Buffer.from(content, "utf8").toString("base64"),
      binary: true,
      byteLength: Buffer.byteLength(content),
      sha256: sha256Hex(content),
    }),
  };
}

describe("live-local-document-authority path helpers", () => {
  test("rejects absolute and traversal relative paths", () => {
    expect(validateLiveCurrentFileRelativePath("../secret.txt")).toMatch(/traversal/);
    expect(validateLiveCurrentFileRelativePath("/etc/passwd")).toMatch(/relative/);
    expect(validateLiveCurrentFileRelativePath("docs/report.html")).toBeNull();
  });

  test("resolves canonical paths and containment", () => {
    expect(resolveLiveCurrentFileCanonicalPath(CURRENT, RELATIVE)).toBe(CANONICAL);
    expect(isPathContainedInRoot(CANONICAL, CURRENT)).toBe(true);
    expect(isPathContainedInRoot("/Users/alice/other/file", CURRENT)).toBe(false);
    expect(isPathContainedInAllowedRoots(CANONICAL, [CURRENT])).toBe(true);
    expect(isPathContainedInAllowedRoots(CANONICAL, ["/Users/alice/other"])).toBe(false);
  });
});

describe("LiveLocalDocumentAuthority issue", () => {
  test("issues an opaque currentFile binding when relay, path, and SHA match", async () => {
    const content = "<html>writer</html>";
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((relayId, req) => {
        expect(relayId).toBe(RELAY_ID);
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          expect(req.operation.args["_routing"]).toMatchObject({
            ownerId: "user-1",
            currentFolder: CURRENT,
          });
          return statOk(Buffer.byteLength(content));
        }
        if (req.operation.kind === "file" && req.operation.command === "read") {
          return readOk(content);
        }
        return { ok: false, message: "unexpected op" };
      }),
    });

    const resolved = await authority.resolveCurrentFileIssue({
      appId: "nautilo-writer",
      userId: "user-1",
      relayIdHint: RELAY_ID,
      currentFolder: CURRENT,
      relativePath: RELATIVE,
      documentVersion: { kind: "local_sha", sha256: sha256Hex(content) },
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.binding.targetKind).toBe("currentFile");
    expect(resolved.binding.relayId).toBe(RELAY_ID);
    expect(resolved.binding.localTargetId.length).toBeGreaterThan(20);
    expect(resolved.binding.documentVersion).toEqual({
      kind: "local_sha",
      sha256: sha256Hex(content),
    });
  });

  test("rejects stale SHA, wrong relay hint, incapable relay, and traversal", async () => {
    const content = "hello";
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({
        [RELAY_ID]: DESKTOP_SNAPSHOT,
        "relay-other": { ...DESKTOP_SNAPSHOT, ownedByActor: false },
        "relay-headless": {
          ...DESKTOP_SNAPSHOT,
          profile: "device-relay",
        },
      }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          return statOk(Buffer.byteLength(content));
        }
        return readOk(content);
      }),
    });

    expect(
      await authority.resolveCurrentFileIssue({
        appId: "nautilo-writer",
        userId: "user-1",
        relayIdHint: RELAY_ID,
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA_B },
      }),
    ).toEqual({ ok: false, code: "stale_version" });

    expect(
      await authority.resolveCurrentFileIssue({
        appId: "nautilo-writer",
        userId: "user-1",
        relayIdHint: "missing-relay",
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: sha256Hex(content) },
      }),
    ).toEqual({ ok: false, code: "relay_unavailable" });

    expect(
      await authority.resolveCurrentFileIssue({
        appId: "nautilo-writer",
        userId: "user-1",
        relayIdHint: "relay-other",
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: sha256Hex(content) },
      }),
    ).toEqual({ ok: false, code: "relay_unavailable" });

    expect(
      await authority.resolveCurrentFileIssue({
        appId: "nautilo-writer",
        userId: "user-1",
        relayIdHint: "relay-headless",
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: sha256Hex(content) },
      }),
    ).toEqual({ ok: false, code: "relay_unavailable" });

    expect(
      await authority.resolveCurrentFileIssue({
        appId: "nautilo-writer",
        userId: "user-1",
        relayIdHint: RELAY_ID,
        currentFolder: CURRENT,
        relativePath: "../outside.html",
        documentVersion: { kind: "local_sha", sha256: sha256Hex(content) },
      }),
    ).toEqual({ ok: false, code: "local_target_forbidden" });
  });

  test("assembles ordered document chunks above the generic 16 MiB cap", async () => {
    const bytes = Buffer.alloc(RELAY_FS_MAX_BYTES + 1, 97);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const chunkCount = Math.ceil(bytes.byteLength / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES);
    const commands: string[] = [];
    let sessionId = "";
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          return statOk(bytes.byteLength);
        }
        if (req.operation.kind === "document" && req.operation.command === "read_meta") {
          commands.push(req.operation.command);
          sessionId = req.operation.args["sessionId"] as string;
          expect(req.operation.args["_routing"]).toMatchObject({
            ownerId: "user-1",
            currentFolder: CURRENT,
          });
          return {
            ok: true,
            result: JSON.stringify({
              sessionId,
              totalBytes: bytes.byteLength,
              chunkCount,
              sha256,
            }),
          };
        }
        if (req.operation.kind === "document" && req.operation.command === "read_chunk") {
          commands.push(req.operation.command);
          const index = req.operation.args["index"] as number;
          const offset = req.operation.args["offset"] as number;
          const chunk = bytes.subarray(
            offset,
            Math.min(bytes.byteLength, offset + RELAY_LOCAL_DOCUMENT_CHUNK_BYTES),
          );
          return {
            ok: true,
            result: JSON.stringify({
              sessionId,
              index,
              chunkCount,
              totalBytes: bytes.byteLength,
              data: chunk.toString("base64"),
            }),
          };
        }
        return { ok: false, message: "unexpected operation" };
      }),
    });

    const result = await authority.resolveCurrentFileIssue({
      appId: "nautilo-writer",
      userId: "user-1",
      relayIdHint: RELAY_ID,
      currentFolder: CURRENT,
      relativePath: RELATIVE,
      documentVersion: { kind: "local_sha", sha256 },
    });
    expect(result.ok).toBe(true);
    expect(commands).toEqual([
      "read_meta",
      ...Array.from({ length: chunkCount }, () => "read_chunk"),
    ]);
  });

  test("keeps the Writer live-session semantic cap even when chunk transport is available", async () => {
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          return statOk(MAX_DOCUMENT_BYTES + 1);
        }
        return { ok: false, message: "Writer cap must reject before document read" };
      }),
    });

    const result = await authority.resolveCurrentFileIssue({
      appId: "nautilo-writer",
      userId: "user-1",
      relayIdHint: RELAY_ID,
      currentFolder: CURRENT,
      relativePath: RELATIVE,
      documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
    });
    expect(result).toEqual({ ok: false, code: "local_target_forbidden" });
  });

  test("rejects malformed document chunk identity without accepting bytes", async () => {
    const totalBytes = RELAY_FS_MAX_BYTES + 1;
    const chunkCount = Math.ceil(totalBytes / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES);
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind === "file") return statOk(totalBytes);
        if (req.operation.kind !== "document") {
          return { ok: false, message: "unexpected operation" };
        }
        const sessionId = req.operation.args["sessionId"] as string;
        if (req.operation.command === "read_meta") {
          return {
            ok: true,
            result: JSON.stringify({
              sessionId,
              totalBytes,
              chunkCount,
              sha256: LOCAL_SHA,
            }),
          };
        }
        return {
          ok: true,
          result: JSON.stringify({
            sessionId: "00000000-0000-4000-8000-000000000000",
            index: req.operation.args["index"],
            chunkCount,
            totalBytes,
            data: Buffer.alloc(RELAY_LOCAL_DOCUMENT_CHUNK_BYTES).toString("base64"),
          }),
        };
      }),
    });

    expect(
      await authority.resolveCurrentFileIssue({
        appId: "nautilo-writer",
        userId: "user-1",
        relayIdHint: RELAY_ID,
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
      }),
    ).toEqual({ ok: false, code: "local_target_forbidden" });
  });

  test("rejects symlink/missing targets from relay preflight", async () => {
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          return {
            ok: true,
            result: JSON.stringify({
              path: CANONICAL,
              size: 10,
              isFile: true,
              isDirectory: false,
              isSymbolicLink: true,
            }),
          };
        }
        return { ok: false, message: "read must not run" };
      }),
    });

    expect(
      await authority.resolveCurrentFileIssue({
        appId: "nautilo-writer",
        userId: "user-1",
        relayIdHint: RELAY_ID,
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
      }),
    ).toEqual({ ok: false, code: "local_target_forbidden" });
  });
});

describe("LiveLocalDocumentAuthority accepted writes", () => {
  const binding: LiveMiniAppSessionCurrentFileBinding = {
    targetKind: "currentFile",
    appId: "nautilo-writer",
    userId: "user-1",
    localTargetId: "opaque-target",
    relayId: RELAY_ID,
    canonicalPath: CANONICAL,
    currentFolderRoot: CURRENT,
    relativePath: RELATIVE,
    documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
  };

  test("rejects a relay success carrying the wrong written SHA", async () => {
    const bytes = Buffer.from("server-authoritative-content", "utf8");
    let dispatchedBase64: string | undefined;
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind !== "file" || req.operation.command !== "write") {
          return { ok: false, message: "unexpected operation" };
        }
        dispatchedBase64 = req.operation.args["content"] as string;
        return {
          ok: true,
          result: JSON.stringify({
            applied: true,
            revisionId: "local:opaque-revision",
            sha256: LOCAL_SHA_B,
          }),
        };
      }),
    });

    expect(await authority.writeAccepted({
      binding,
      bytes,
      agentId: "agent-1",
      turnId: "agent-turn-1",
      clientMutationId: "request-1",
    })).toEqual({ ok: false, code: "relay_unavailable" });
    expect(dispatchedBase64).toBe(bytes.toString("base64"));
  });
});

describe("LiveLocalDocumentAuthority refresh", () => {
  const existing: LiveMiniAppSessionCurrentFileBinding = {
    targetKind: "currentFile",
    appId: "nautilo-writer",
    userId: "user-1",
    localTargetId: "opaque-target",
    relayId: RELAY_ID,
    canonicalPath: CANONICAL,
    currentFolderRoot: CURRENT,
    relativePath: RELATIVE,
    documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
  };

  test("revalidates pinned relay/target and updated SHA without relay hint", async () => {
    const content = "updated";
    const readRelayIds: string[] = [];
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((relayId, req) => {
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          return statOk(Buffer.byteLength(content));
        }
        if (req.operation.kind === "file" && req.operation.command === "read") {
          readRelayIds.push(relayId);
          return readOk(content);
        }
        return { ok: false, message: "unexpected op" };
      }),
    });

    const refreshed = await authority.refreshCurrentFileBinding({
      appId: "nautilo-writer",
      userId: "user-1",
      currentFolder: CURRENT,
      relativePath: RELATIVE,
      documentVersion: { kind: "local_sha", sha256: sha256Hex(content) },
      existing,
    });

    expect(refreshed.ok).toBe(true);
    expect(readRelayIds).toEqual([RELAY_ID]);
    if (refreshed.ok) {
      expect(refreshed.binding.relayId).toBe(RELAY_ID);
      expect(refreshed.binding.localTargetId).toBe("opaque-target");
    }
  });
});

describe("LiveLocalDocumentAuthority read-only canonical snapshots", () => {
  test("derives canonical identity and bytes without issuing a live session", async () => {
    const content = "lease snapshot";
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          return statOk(Buffer.byteLength(content));
        }
        if (req.operation.kind === "file" && req.operation.command === "read") {
          return readOk(content);
        }
        return { ok: false, message: "unexpected operation" };
      }),
    });

    const result = await authority.readCanonicalSnapshot({
      ownerId: "user-1",
      relayId: RELAY_ID,
      candidatePath: CANONICAL,
    });
    expect(result).toEqual({
      ok: true,
      relayId: RELAY_ID,
      canonicalPath: CANONICAL,
      bytes: Buffer.from(content),
      sha256: sha256Hex(content),
    });
  });

  test("fails closed for a relay not owned by the authenticated user", async () => {
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({
        [RELAY_ID]: { ...DESKTOP_SNAPSHOT, ownedByActor: false },
      }),
      localFileDispatch: makeDispatch(() => ({ ok: false, message: "must not read" })),
    });

    const result = await authority.readCanonicalSnapshot({
      ownerId: "user-1",
      relayId: RELAY_ID,
      candidatePath: CANONICAL,
    });
    expect(result).toEqual({ ok: false, code: "relay_unavailable" });
  });

  test("uses Windows relay path semantics instead of the server host path API", async () => {
    const content = "windows relay snapshot";
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({
        [RELAY_ID]: { ...DESKTOP_SNAPSHOT, allowedRoots: [WINDOWS_ROOT] },
      }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          expect(req.operation.args["_routing"]).toMatchObject({
            currentFolder: WINDOWS_ROOT,
          });
          expect(req.operation.args["path"]).toBe("docs/report.html");
          return statOk(Buffer.byteLength(content));
        }
        if (req.operation.kind === "file" && req.operation.command === "read") {
          return readOk(content);
        }
        return { ok: false, message: "unexpected operation" };
      }),
    });

    const result = await authority.readCanonicalSnapshot({
      ownerId: "user-1",
      relayId: RELAY_ID,
      candidatePath: "C:/Users/Alice/project/docs/report.html",
    });
    expect(result).toMatchObject({
      ok: true,
      relayId: RELAY_ID,
      canonicalPath: WINDOWS_CANONICAL,
      sha256: sha256Hex(content),
    });
  });

  test("uses chunk transport above the Writer cap without inheriting that editor limit", async () => {
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 97);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const chunkCount = Math.ceil(bytes.byteLength / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES);
    let sessionId = "";
    let chunkReads = 0;
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: makeRegistry({ [RELAY_ID]: DESKTOP_SNAPSHOT }),
      localFileDispatch: makeDispatch((_relayId, req) => {
        if (req.operation.kind === "file" && req.operation.command === "stat") {
          return statOk(bytes.byteLength);
        }
        if (req.operation.kind === "document" && req.operation.command === "read_meta") {
          sessionId = req.operation.args["sessionId"] as string;
          return {
            ok: true,
            result: JSON.stringify({ sessionId, totalBytes: bytes.byteLength, chunkCount, sha256 }),
          };
        }
        if (req.operation.kind === "document" && req.operation.command === "read_chunk") {
          chunkReads += 1;
          const offset = req.operation.args["offset"] as number;
          const index = req.operation.args["index"] as number;
          const chunk = bytes.subarray(
            offset,
            Math.min(bytes.byteLength, offset + RELAY_LOCAL_DOCUMENT_CHUNK_BYTES),
          );
          return {
            ok: true,
            result: JSON.stringify({
              sessionId,
              index,
              chunkCount,
              totalBytes: bytes.byteLength,
              data: chunk.toString("base64"),
            }),
          };
        }
        return { ok: false, message: "unexpected operation" };
      }),
    });

    const result = await authority.readCanonicalSnapshot({
      ownerId: "user-1",
      relayId: RELAY_ID,
      candidatePath: CANONICAL,
    });
    expect(result).toMatchObject({
      ok: true,
      canonicalPath: CANONICAL,
      sha256,
    });
    expect(chunkReads).toBe(chunkCount);
  });
});


describe("LiveLocalDocumentAuthority canonical folder aliases", () => {
  for (const outcome of ["allowed", "escape", "denied"] as const) {
    test(`resolves an alias through the pinned relay before authorizing: ${outcome}`, async () => {
      const folder = "/tmp/sheets-test";
      const canonicalRoot = "/private/tmp/sheets-test";
      const relativePath = "book.spreadsheet.html";
      const content = "native sheet";
      let reads = 0;
      const dispatch = makeDispatch(() => {
        reads += 1;
        throw new Error("injected canonical reader owns content reads");
      });
      const authority = new LiveLocalDocumentAuthority({
        relayRegistry: makeRegistry({ [RELAY_ID]: { ...DESKTOP_SNAPSHOT, allowedRoots: [canonicalRoot] } }),
        localFileDispatch: {
          ...dispatch,
          fsDispatch: async (relayId, request, options) => {
            expect(relayId).toBe(RELAY_ID);
            expect(options.mutating).toBe(false);
            expect(request).toMatchObject({ op: "realpath", path: `${folder}/${relativePath}`, allowedRoots: [canonicalRoot] });
            if (outcome === "denied") return { ok: false, code: "EACCES", message: "grant denied" };
            return { ok: true, realpath: outcome === "escape" ? "/private/tmp/outside/book.html" : `${canonicalRoot}/${relativePath}` };
          },
        },
        readCanonical: async (input) => {
          reads += 1;
          expect(input.canonicalPath).toBe(`${canonicalRoot}/${relativePath}`);
          expect(input.allowedRoots).toEqual([canonicalRoot]);
          return { ok: true, bytes: Buffer.from(content), sha256: sha256Hex(content) };
        },
      });
      const result = await authority.resolveCurrentFileIssue({
        appId: "nautilo-spreadsheet", userId: "user-1", relayIdHint: RELAY_ID,
        currentFolder: folder, relativePath,
        documentVersion: { kind: "local_sha", sha256: sha256Hex(content) },
      });
      if (outcome === "allowed") {
        expect(result).toMatchObject({ ok: true, binding: { canonicalPath: `${canonicalRoot}/${relativePath}`, currentFolderRoot: folder, relativePath } });
        expect(reads).toBe(1);
      } else {
        expect(result).toEqual({ ok: false, code: "local_target_forbidden" });
        expect(reads).toBe(0);
      }
    });
  }
});
