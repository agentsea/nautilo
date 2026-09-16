import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  setWorkspaceFileContentCommitExecution,
  setWorkspaceFileContentRecoveryExecution,
  type WorkspaceFileContentCommitRequest,
} from "@nautilo/agent";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import { createProductionDocumentOperations } from "../../src/apps/app-tool-host";
import type { AppToolRunnerContext } from "../../src/apps/app-tool-types";

const textBytes = (value: string) => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function context(overrides: Partial<AppToolRunnerContext> = {}): AppToolRunnerContext {
  return {
    ownerId: "owner-1",
    userId: "owner-1",
    agentId: "agent-1",
    roomId: "room-1",
    turnId: "turn-1",
    memoryAccessEnvelope: {
      ownerId: "owner-1",
      actorId: "human-1",
      agentId: "agent-1",
      roomId: "room-1",
      readableNamespaces: ["namespace-1"],
      mutableNamespaces: ["namespace-1"],
      writableNamespaces: ["namespace-1"],
      toolPolicy: {},
    },
    ...overrides,
  } as AppToolRunnerContext;
}

function operations(ctx = context(), initial = "", current?: () => { content: string; revision: number }) {
  return createProductionDocumentOperations({
    appId: "test-canvas",
    appsRoot: "/unused",
    manifest: TEST_MINI_APP_MANIFEST,
    context: ctx,
    relayRegistry: null,
    resolveWorkspaceArtifactFn: (async () => ({
      ok: true,
      artifact: {
        id: "11111111-1111-4111-8111-111111111111",
        artifactId: "public-artifact-1",
        path: "notes/a.txt",
        revision: current?.().revision ?? 7,
        mimeType: "text/plain",
      },
      physicalPath: "/must-not-be-written",
    })) as never,
    readWorkspaceFile: async () => Buffer.from(current?.().content ?? initial, "utf8"),
  });
}

afterEach(() => {
  setWorkspaceFileContentCommitExecution(undefined);
  setWorkspaceFileContentRecoveryExecution(undefined);
});

describe("production app-tool Workspace canonical writes", () => {
  test("routes an empty base through the coordinator and requires a fresh read of its merged postimage", async () => {
    const requests: WorkspaceFileContentCommitRequest[] = [];
    let call = 0;
    let current = { content: "", revision: 7 };
    setWorkspaceFileContentCommitExecution(async (request) => {
      requests.push(request);
      call += 1;
      const committedText = call === 1 ? "human\nagent\n" : "second\n";
      const committed = textBytes(committedText);
      current = { content: committedText, revision: 7 + call };
      return {
        ok: true,
        revisionId: `revision-${call}`,
        ...(call === 1 ? { rebased: true as const } : {}),
        committed: {
          bytes: committed,
          sha256: sha256(committed),
          revision: 7 + call,
          size: committed.byteLength,
        },
      };
    });
    const ops = operations(context(), "", () => current);

    expect(await ops.write(
      { surface: "workspace", path: "notes/a.txt" },
      { content: "agent\n" },
    )).toEqual({
      kind: "saved",
      sha256: sha256(textBytes("human\nagent\n")),
      revision: 8,
      size: 12,
    });
    expect(requests[0]!.source?.bytes).toEqual(textBytes(""));

    const blocked = await ops.write(
      { surface: "workspace", path: "notes/a.txt" },
      { content: "second\n" },
    );
    expect(blocked.kind).toBe("error");
    if (blocked.kind !== "error") throw new Error("A merged postimage must require a fresh read");
    expect(blocked.message).toContain("Read the Workspace document again");
    expect(requests).toHaveLength(1);
    expect(await ops.read({ surface: "workspace", path: "notes/a.txt" })).toMatchObject({
      content: "human\nagent\n", baseRevision: 8,
    });
    expect(await ops.write(
      { surface: "workspace", path: "notes/a.txt" },
      { content: "second\n" },
    )).toMatchObject({ kind: "saved", revision: 9 });
    expect(requests[1]!.source?.bytes).toEqual(textBytes("human\nagent\n"));
    expect(requests[1]!.source?.revision).toBe(8);
  });

  test("fails before coordinator execution without trusted Room or turn authority", async () => {
    let calls = 0;
    setWorkspaceFileContentCommitExecution(async () => {
      calls += 1;
      throw new Error("must not execute");
    });
    const withoutRoom = context({
      roomId: null,
      memoryAccessEnvelope: {
        ...context().memoryAccessEnvelope,
        roomId: undefined,
      } as never,
    });
    expect(await operations(withoutRoom, "base").write(
      { surface: "workspace", path: "notes/a.txt" },
      { content: "next" },
    )).toMatchObject({ kind: "error" });
    expect(await operations(context({ turnId: null }), "base").write(
      { surface: "workspace", path: "notes/a.txt" },
      { content: "next" },
    )).toMatchObject({ kind: "error" });
    expect(calls).toBe(0);
  });

  test("recovers an unknown commit with the exact same mutation identity", async () => {
    let committedRequest: WorkspaceFileContentCommitRequest | undefined;
    let recoveredRequestId = "";
    setWorkspaceFileContentCommitExecution(async (request) => {
      committedRequest = request;
      return {
        ok: false,
        code: "unknown",
        message: "response lost",
        retryable: true,
        mutationRequestId: request.mutationRequestId,
      };
    });
    const committed = textBytes("recovered\n");
    setWorkspaceFileContentRecoveryExecution(async (request) => {
      recoveredRequestId = request.mutationRequestId;
      return {
        ok: true,
        revisionId: "revision-recovered",
        committed: {
          bytes: committed,
          sha256: sha256(committed),
          revision: 8,
          size: committed.byteLength,
        },
      };
    });

    expect(await operations(context(), "base\n").write(
      { surface: "workspace", path: "notes/a.txt" },
      { content: "next\n" },
    )).toEqual({
      kind: "saved",
      sha256: sha256(committed),
      revision: 8,
      size: committed.byteLength,
    });
    expect(committedRequest).toBeDefined();
    expect(recoveredRequestId).toBe(committedRequest!.mutationRequestId);
  });
});
