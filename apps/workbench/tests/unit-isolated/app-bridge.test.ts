/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { DocumentPatchConflictError } from "@nautilo/api-client";
import { deriveAnchoredTextPatch } from "@nautilo/types";
import { createEmptyVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
} from "../../src/components/browser-column/open-file-target";


async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 2_000, intervalMs = 5 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}


const getArtifactMock = mock(async () => ({
  id: "art-internal-1",
  revision: 3,
  path: "budget.document.json",
}));
const getBytesMock = mock(async () =>
  new Blob(['{"sheets":[]}'], { type: "application/vnd.nautilo.document+json" }),
);
const saveArtifactMock = mock(async () => ({
  id: "art-internal-1",
  revision: 4,
  size: 14,
  sha256: "saved-sha256",
}));
const applyPatchMock = mock(async () => ({
  kind: "applied" as const,
  sha256: "patch-sha256",
  revision: 5,
  patchId: "patch-1",
  requestId: "req-1",
  target: {
    kind: "artifact" as const,
    artifactInternalId: "art-internal-1",
    path: "budget.document.json",
  },
  author: { kind: "human" as const, displayName: "user" },
  patch: { kind: "anchored_text" as const, oldString: "x", newString: "y" },
  unifiedDiff: "",
  rebased: false,
}));
const getArtifactStateMock = mock(async () => ({
  artifactId: "art-internal-1",
  key: "app:sample-app:view",
  value: { zoom: 1 },
  namespaceId: "ns-1",
  updatedAt: "2026-06-22T00:00:00.000Z",
}));
const setArtifactStateMock = mock(async () => ({
  artifactId: "art-internal-1",
  key: "app:sample-app:view",
  value: { zoom: 2 },
  namespaceId: "ns-1",
  updatedAt: "2026-06-22T00:00:01.000Z",
}));

const statMock = mock(async () => ({
  exists: true,
  isFile: true,
  isDirectory: false,
  size: 5,
  modified: null,
}));
const readFileMock = mock(async () => "hello");
const readAuthoredChangeMock = mock(async (_input: { path: string; expectedSha256: string }): Promise<unknown> => ({ kind: "none" }));
const getWorkspaceArtifactAuthoredChangeMock = mock(async (
  _id: string,
  _input: { roomId: string; expectedSha256: string; expectedRevision: number },
): Promise<unknown> => ({ kind: "none" }));
const writeFileMock = mock(async () => ({
  ok: true as const,
  sha256: "fs-saved-sha",
  size: 5,
}));
const startMediaExportMock = mock(async () => ({ ok: true as const, data: { status: "cancelled" as const } }));
const getMiniAppCreateTemplateMock = mock(async () => ({
  content: '{"sheets":[]}',
  mimeType: "application/vnd.nautilo.document+json",
}));
const applyAcceptedLiveProposalMock = mock(async () => ({
  documentVersion: { kind: "local_sha" as const, sha256: "b".repeat(64) },
  contentSha256: "b".repeat(64),
  localRevisionRef: "local:opaque-ref",
}));
const resolveLiveProposalReviewMock = mock(async () => ({
  ok: true as const,
  taskStatus: "completed",
}));

mock.module("../../src/lib/api", () => ({
  WS_URL: "ws://127.0.0.1:3001/ws",
  apiClient: {
    getWorkspaceArtifact: getArtifactMock,
    getWorkspaceArtifactBytes: getBytesMock,
    getWorkspaceArtifactAuthoredChange: getWorkspaceArtifactAuthoredChangeMock,
    saveWorkspaceArtifactContent: saveArtifactMock,
    applyWorkspaceArtifactPatch: applyPatchMock,
    getArtifactState: getArtifactStateMock,
    setArtifactState: setArtifactStateMock,
    getMiniAppCreateTemplate: getMiniAppCreateTemplateMock,
    applyAcceptedLiveProposal: applyAcceptedLiveProposalMock,
    resolveLiveProposalReview: resolveLiveProposalReviewMock,
  },
}));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  canSwitchDesktopServer: () => false,
  desktopAPI: {
    documentMutations: { readAuthoredChange: readAuthoredChangeMock },
    mediaExport: { supportsWorkspacePublication: true, supportsExportSettings: true, startWorkspace: startMediaExportMock, start: startMediaExportMock, cancel: mock(async () => ({ ok: true, data: null })), onProgress: () => () => {} },
    fs: {
      stat: statMock,
      readFile: readFileMock,
      writeFile: writeFileMock,
    },
  },
  getDesktopRelayId: mock(async () => "relay-test-1"),
  getShellStateOnBoot: () => null,
  computeInitialLastOpenAtSeed: (input: {
    hasEverBeenOpen: boolean;
    shellStateOnBoot: unknown;
    now: number;
  }) => (input.hasEverBeenOpen ? input.now : null),
}));

const {
  appStateKey,
  applyDocumentPatchToWriteSession,
  canonicalVideoGenerationTakeStatus,
  applyVerifiedDocumentPatchToWriteSession,
  getAppState,
  installAppBridge,
  isAppBridgeRequest,
  mapAcceptProposalBridgeFailure,
  normalizeAppContextSummary,
  postAppDocumentChanged,
  postAppLiveSession,
  postAppLiveProposal,
  readBoundDocument,
  readDocumentSession,
  rejectsHostOwnedKeys,
  rejectsVideoGenerationHostOwnedKeys,
  resolveBoundRasterPath,
  rasterMimeType,
  setAppState,
  statBoundDocument,
  writeBoundDocument,
  validateAuthoredChange,
} = await import("../../src/apps/app-bridge");

const { sha256HexForText: sha256FromEditorIo } = await import("../../src/editors/editor-io");
const {
  clearPendingAcceptMutationsForTests,
  observePendingAcceptMutationEvent,
  registerPendingAcceptMutation,
} = await import("../../src/apps/local-fs-accept-mutations");

const artifactTarget = artifactOpenFileTarget({
  id: "art-internal-1",
  path: "budget.document.json",
  mimeType: "application/vnd.nautilo.document+json",
  roomId: "room-7",
});

describe("retained authored-change boundary", () => {
  test("accepts only a path-free read request", () => {
    const request = { type: "nautilo.app.document.req", requestId: "history", op: "authoredChange" };
    expect(isAppBridgeRequest(request)).toBe(true);
    for (const extra of [{ path: "/private/other.html" }, { expectedSha256: "a".repeat(64) }, { operationId: "another-operation" }, { author: { kind: "agent" } }]) {
      expect(isAppBridgeRequest({ ...request, ...extra })).toBe(false);
    }
  });

  test("verifies both retained byte hashes and the current revision, with no actor inference", async () => {
    const currentSha256 = await sha256FromEditorIo("current");
    const row = { kind: "ready", operationId: "operation", author: { kind: "agent", displayName: "Provider name" },
      before: { content: "before", sha256: await sha256FromEditorIo("before") },
      after: { content: "after", sha256: await sha256FromEditorIo("after") }, currentSha256 };
    expect(await validateAuthoredChange(row, currentSha256)).toEqual({ ...row, author: { kind: "agent", displayName: "Genie" } });
    for (const candidate of [
      { ...row, author: { kind: "human", displayName: "Genie" } },
      { ...row, before: { ...row.before, content: "tampered" } },
      { ...row, after: { ...row.after, sha256: "a".repeat(64) } },
      { ...row, currentSha256: "b".repeat(64) },
      { ...row, localPath: "/private/secret" },
      { ...row, after: { ...row.after, storageUri: "file:///private/history" } },
      { kind: "none", retainedPath: "/private/history" },
    ]) expect(await validateAuthoredChange(candidate, currentSha256)).toEqual({ kind: "unavailable", code: "history_unavailable" });
    expect(await validateAuthoredChange({ kind: "none" }, currentSha256)).toEqual({ kind: "none" });
  });
});

describe("Video generation bridge grammar", () => {
  const request = {
    type: "nautilo.app.video-generation.request",
    requestId: "req-video-1",
    document: { sha256: "a".repeat(64), revision: 3 },
    sourceFingerprint: `sha256:${"b".repeat(64)}`,
    job: {
      source: { kind: "shot", shotId: "shot-opening" },
      shotLabel: "Opening shot",
      prompt: "A tide rises behind the subject.",
      modelId: "venice:seedance-2-5-text-to-video-basic",
      requestedSettings: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audio: true },
    },
  };

  test("reference generation uses only a take selector; raw reference transport remains host-owned", () => {
    const reference = { ...request, job: { ...request.job, modelId: "venice:seedance-2-5-reference-to-video-basic", continuationTakeId: "take_abcdefghijklmnop" } };
    expect(isAppBridgeRequest(reference)).toBe(true);
    expect(isAppBridgeRequest({ ...reference, job: { ...reference.job, referenceVideos: [{ path: "private.mp4" }] } })).toBe(false);
    expect(isAppBridgeRequest({ ...reference, job: { ...reference.job, continuationTakeId: "https://foreign/video" } })).toBe(false);
  });
  test("accepts document-bound compiler output without a duplicate prompt byte quota", () => {
    expect(isAppBridgeRequest(request)).toBe(true);
    expect(isAppBridgeRequest({ ...request, job: { ...request.job, prompt: "景".repeat(15_000) } })).toBe(true);
    expect(isAppBridgeRequest({ ...request, job: { ...request.job, prompt: "x".repeat(15_001) } })).toBe(true);
    expect(rejectsVideoGenerationHostOwnedKeys(request)).toBe(false);
  });

  test("rejects recursively smuggled parent authority and empty prompts", () => {
    expect(isAppBridgeRequest({ ...request, job: { ...request.job, nested: { receiptId: "secret" } } })).toBe(false);
    expect(rejectsVideoGenerationHostOwnedKeys({ ...request, job: { ...request.job, source: { kind: "shot", shotId: "shot", token: "secret" } } })).toBe(true);
    expect(isAppBridgeRequest({ ...request, job: { ...request.job, prompt: "   " } })).toBe(false);
    expect(isAppBridgeRequest({ ...request, job: { ...request.job, source: { kind: "shot", shotId: "1-invalid" } } })).toBe(false);
    expect(isAppBridgeRequest({ ...request, job: { ...request.job, shotLabel: "界".repeat(1000) } })).toBe(true);
    expect(isAppBridgeRequest({ ...request, document: { ...request.document, path: "/private" } })).toBe(false);
  });

  test("accepts only opaque generated-take read operations", () => {
    expect(isAppBridgeRequest({ type: "nautilo.app.video-generation.req", requestId: "take-read", op: "listTakes" })).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.video-generation.req", requestId: "take-read", op: "previewTake", takeId: "take_abcdefghijklmnop" })).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.video-generation.req", requestId: "take-read", op: "previewTake", takeId: "take_abcdefghijklmnop", path: "private.mp4" })).toBe(false);
    expect(isAppBridgeRequest({ type: "nautilo.app.video-generation.req", requestId: "take-read", op: "listTakes", takeId: "take_abcdefghijklmnop" })).toBe(false);
  });

  test("saved reference selectors and batch import have closed request grammar", () => {
    const preview = { type: "nautilo.app.media.req", requestId: "ref-preview", op: "openPreview", referenceId: "ref_cast" };
    expect(isAppBridgeRequest(preview)).toBe(true);
    for (const extra of [{ path: "refs/image.png" }, { mediaId: "media_cast" }, { ref: "image.png" }, { referenceId: "../secret" }]) expect(isAppBridgeRequest({ ...preview, ...extra })).toBe(false);
    const batch = { type: "nautilo.app.video-generation.req", requestId: "batch", op: "importReferences", mediaKind: "image" };
    expect(isAppBridgeRequest(batch)).toBe(true);
    expect(isAppBridgeRequest({ ...batch, mediaKind: "video" })).toBe(false);
    expect(isAppBridgeRequest({ ...batch, roomId: "other-room" })).toBe(false);
  });

  test("accepts only the exact reference-import request grammar", () => {
    const referenceImport = {
      type: "nautilo.app.video-generation.req",
      requestId: "reference-import",
      op: "importReference",
      mediaKind: "image",
    };
    expect(isAppBridgeRequest(referenceImport)).toBe(true);
    for (const request of [
      { ...referenceImport, path: "/private/reference.png" },
      { ...referenceImport, artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53" },
      { ...referenceImport, base64: "c2VjcmV0" },
      { ...referenceImport, mediaKind: "document" },
      { ...referenceImport, extra: { token: "secret" } },
      { ...referenceImport, op: "importReference", takeId: "take_abcdefghijklmnop" },
    ]) {
      expect(isAppBridgeRequest(request)).toBe(false);
    }
  });

  test("canonicalizes status deeply and rejects leaked action/provider fields", () => {
    const status = {
      kind: "ready", status: {
        takeId: "take_abcdefghijklmnop", revision: 4, mediaKind: "video", state: "needs-action", modelId: "seedance-2-5-text-to-video-basic", settings: { durationSeconds: 5 },
        failure: { code: "QUEUE_FAILED", message: "Queue retry is available.", phase: "queue", retrySafe: true, stateChanged: true, completionCertainty: "not_started", chargeCertainty: "not_charged" },
        recoveryActions: [{ kind: "fresh_generation", label: "Generate again", newSpend: true }],
      },
    };
    expect(canonicalVideoGenerationTakeStatus(status, "take_abcdefghijklmnop")).toEqual(status);
    expect(canonicalVideoGenerationTakeStatus({ ...status, status: { ...status.status, recoveryActions: [{ ...status.status.recoveryActions[0], actionId: "opaque-action" }] } }, "take_abcdefghijklmnop")).toBeNull();
    expect(canonicalVideoGenerationTakeStatus({ ...status, status: { ...status.status, progress: { phase: "queue", message: "https://provider.example/job" } } }, "take_abcdefghijklmnop")).toBeNull();
    expect(canonicalVideoGenerationTakeStatus({ ...status, status: { ...status.status, failure: { ...status.status.failure, providerUrl: "https://provider.example/job" } } }, "take_abcdefghijklmnop")).toBeNull();
    expect(canonicalVideoGenerationTakeStatus(status, "take_qrstuvwxyzabcdef")).toBeNull();
  });
});

describe("applyDocumentPatchToWriteSession", () => {
  test("verified apply rejects a missed predecessor and a false postimage", async () => {
    const session = {
      envelope: {
        content: "alpha\n",
        mimeType: "text/plain",
        path: "notes.txt",
        baseSha256: "retained",
        baseRevision: 2,
      },
    };
    const baseEvent = {
      patchId: "patch-verified",
      revision: 3,
      previousRevision: 2,
      previousSha256: "different-predecessor",
      sha256: await sha256FromEditorIo("beta\n"),
      patch: { kind: "anchored_text" as const, oldString: "alpha\n", newString: "beta\n" },
      rebased: false,
    };
    expect(await applyVerifiedDocumentPatchToWriteSession(session, baseEvent)).toBeNull();
    expect(session.envelope.content).toBe("alpha\n");
    expect(await applyVerifiedDocumentPatchToWriteSession(session, {
      ...baseEvent,
      previousSha256: "retained",
      sha256: "f".repeat(64),
    })).toBeNull();
    expect(session.envelope.content).toBe("alpha\n");
  });

  test("delayed verified A-to-B cannot regress a session already advanced through B-to-C", async () => {
    const alphaSha = await sha256FromEditorIo("alpha\n");
    const betaSha = await sha256FromEditorIo("beta\n");
    const gammaSha = await sha256FromEditorIo("gamma\n");
    const session = {
      envelope: {
        content: "alpha\n",
        mimeType: "text/plain",
        path: "notes.txt",
        baseSha256: alphaSha,
        baseRevision: 1,
      },
    };
    const eventAB = {
      patchId: "patch-a-b",
      revision: 2,
      previousRevision: 1,
      previousSha256: alphaSha,
      sha256: betaSha,
      patch: { kind: "anchored_text" as const, oldString: "alpha\n", newString: "beta\n" },
      rebased: false,
    };
    const eventBC = {
      patchId: "patch-b-c",
      revision: 3,
      previousRevision: 2,
      previousSha256: betaSha,
      sha256: gammaSha,
      patch: { kind: "anchored_text" as const, oldString: "beta\n", newString: "gamma\n" },
      rebased: false,
    };
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseDigest!: () => void;
    let signalDigestEntered!: () => void;
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const digestEntered = new Promise<void>((resolve) => { signalDigestEntered = resolve; });
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        if (new TextDecoder().decode(data) === "beta\n") {
          signalDigestEntered();
          await digestGate;
        }
        return originalDigest(algorithm, data);
      },
    });
    try {
      const delayedAB = applyVerifiedDocumentPatchToWriteSession(session, eventAB);
      await digestEntered;
      expect(applyDocumentPatchToWriteSession(session, eventAB)).not.toBeNull();
      expect(applyDocumentPatchToWriteSession(session, eventBC)).not.toBeNull();
      releaseDigest();
      expect(await delayedAB).toBeNull();
      expect(session.envelope).toMatchObject({
        content: "gamma\n",
        baseSha256: gammaSha,
        baseRevision: 3,
      });
    } finally {
      releaseDigest();
      Object.defineProperty(crypto.subtle, "digest", {
        configurable: true,
        value: originalDigest,
      });
    }
  });

  test("applies patch to remembered session and returns sanitized patch_applied event", () => {
    const session = {
      envelope: {
        content: "alpha\nbeta\ngamma\n",
        mimeType: "text/plain",
        path: "notes.txt",
        baseSha256: "prev-sha",
        baseRevision: 2,
      },
    };
    const patch = {
      kind: "anchored_text" as const,
      oldString: "beta\n",
      newString: "BETA\n",
    };
    const event = {
      type: "document.patch.applied" as const,
      target: {
        kind: "artifact" as const,
        artifactInternalId: "art-internal-1",
        path: "notes.txt",
      },
      patchId: "patch-remote-1",
      revision: 3,
      sha256: "next-sha",
      previousRevision: 2,
      previousSha256: "prev-sha",
      patch,
      author: { kind: "agent" as const, displayName: "Genie" },
      rebased: true,
      clientMutationId: "remote-mutation",
      requestId: "remote-req",
    };

    const result = applyDocumentPatchToWriteSession(session, event);

    expect(result).toEqual({
      type: "patch_applied",
      path: "notes.txt",
      patchId: "patch-remote-1",
      revision: 3,
      sha256: "next-sha",
      previousRevision: 2,
      previousSha256: "prev-sha",
      patch,
      author: { kind: "agent", displayName: "Genie" },
      rebased: true,
      envelope: {
        content: "alpha\nBETA\ngamma\n",
        mimeType: "text/plain",
        path: "notes.txt",
        baseSha256: "next-sha",
        baseRevision: 3,
      },
    });
    expect(session.envelope?.content).toBe("alpha\nBETA\ngamma\n");
    expect(session.envelope?.baseSha256).toBe("next-sha");
    expect("target" in (result ?? {})).toBe(false);
    expect("artifactInternalId" in (result ?? {})).toBe(false);
    expect("clientMutationId" in (result ?? {})).toBe(false);
    expect("requestId" in (result ?? {})).toBe(false);
    expect("unifiedDiff" in (result ?? {})).toBe(false);
  });

  test("returns null when session is empty or patch cannot apply", () => {
    const patch = {
      kind: "anchored_text" as const,
      oldString: "missing\n",
      newString: "found\n",
    };
    const event = {
      type: "document.patch.applied" as const,
      target: {
        kind: "artifact" as const,
        artifactInternalId: "art-internal-1",
        path: "notes.txt",
      },
      patchId: "patch-remote-2",
      revision: 4,
      sha256: "next-sha-2",
      previousRevision: 3,
      previousSha256: "prev-sha-2",
      patch,
      author: { kind: "human" as const, displayName: "User" },
    };

    expect(applyDocumentPatchToWriteSession({ envelope: null }, event)).toBeNull();

    const session = {
      envelope: {
        content: "alpha\nbeta\n",
        mimeType: "text/plain",
        path: "notes.txt",
        baseSha256: "prev-sha-2",
        baseRevision: 3,
      },
    };
    expect(applyDocumentPatchToWriteSession(session, event)).toBeNull();
    expect(session.envelope?.content).toBe("alpha\nbeta\n");
  });
});


describe("bound raster asset policy", () => {
  const target = fsOpenFileTarget("/project/cuts/rough.video.html", "/project");

  test("derives only project-relative sibling paths", () => {
    expect(resolveBoundRasterPath(target, "media/poster.png")).toBe("/project/cuts/media/poster.png");
    for (const ref of ["../poster.png", "/tmp/poster.png", "file:///tmp/a.png", "C:\\a.png", "media//a.png", "./a.png"]) {
      expect(resolveBoundRasterPath(target, ref)).toBeNull();
    }
  });

  test("admits only closed raster magic and refuses SVG", () => {
    expect(rasterMimeType(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
    expect(rasterMimeType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(rasterMimeType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
  });
});

describe("protocol validation", () => {
  test("accepts only a saved identity for export, never a plan or path", () => {
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "export-1", op: "exportVideo", sha256: "a".repeat(64), revision: 2 })).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "export-workspace", op: "exportVideo", sha256: "a".repeat(64), revision: 2, publishToWorkspace: true })).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "export-profile", op: "exportVideo", sha256: "a".repeat(64), revision: 2, exportSettings: { resolution: "720p", quality: "custom", videoBitrateKbps: 4500 } })).toBe(true);
    for (const exportSettings of [null, { resolution: "8k" }, { quality: "custom", videoBitrateKbps: -1 }, { quality: "high", videoBitrateKbps: 4500 }, { ffmpegArgs: "-i /private" }]) {
      expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "export-invalid-profile", op: "exportVideo", sha256: "a".repeat(64), revision: 2, exportSettings })).toBe(false);
    }
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "export-invalid-workspace", op: "exportVideo", sha256: "a".repeat(64), revision: 2, publishToWorkspace: "yes" })).toBe(false);
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "export-2", op: "exportVideo", sha256: "a".repeat(64), revision: 2, path: "/private" })).toBe(false);
    expect(isAppBridgeRequest({ type: "nautilo.app.media.req", requestId: "export-3", op: "exportVideo", sha256: "a".repeat(64), revision: 2, plan: {} })).toBe(false);
  });
  test("accepts a closed opaque Workspace media selector without artifact authority", () => {
    expect(isAppBridgeRequest({
      type: "nautilo.app.media.req",
      requestId: "workspace-preview",
      op: "openPreview",
      mediaId: "media_generated_take",
    })).toBe(true);
    for (const request of [
      { type: "nautilo.app.media.req", requestId: "bad-both", op: "openPreview", mediaId: "media_generated_take", ref: "generated/take.mp4" },
      { type: "nautilo.app.media.req", requestId: "bad-source", op: "openPreview", mediaId: "media_generated_take", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53" },
      { type: "nautilo.app.media.req", requestId: "bad-path", op: "openPreview", mediaId: "media_generated_take", path: "generated/take.mp4" },
      { type: "nautilo.app.media.req", requestId: "bad-id", op: "openPreview", mediaId: "../take" },
    ]) expect(isAppBridgeRequest(request)).toBe(false);
  });

  test("accepts only the closed Video host-layout request", () => {
    expect(isAppBridgeRequest({
      type: "nautilo.app.video-host-layout.req",
      requestId: "video-layout-1",
      op: "setFullWidth",
      enabled: true,
    })).toBe(true);
    expect(isAppBridgeRequest({
      type: "nautilo.app.video-host-layout.req",
      requestId: "video-layout-2",
      op: "setFullWidth",
      enabled: false,
      path: "/private",
    })).toBe(false);
    expect(isAppBridgeRequest({
      type: "nautilo.app.video-host-layout.req",
      requestId: "video-layout-3",
      op: "setFullWidth",
      enabled: "true",
    })).toBe(false);
  });

  test("accepts document read/stat/write", () => {
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.document.req",
        requestId: "r1",
        op: "read",
      }),
    ).toBe(true);
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.document.req",
        requestId: "r2",
        op: "stat",
      }),
    ).toBe(true);
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.document.req",
        requestId: "r3",
        op: "write",
        value: "next",
        baseSha256: "abc",
        baseRevision: 1,
      }),
    ).toBe(true);
  });

  test("accepts state get/set, bounded preferences, and context update", () => {
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.state.req",
        requestId: "s1",
        op: "get",
        key: "view",
      }),
    ).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.preferences.req", requestId: "pref-1", op: "get", key: "writer.spellcheck" })).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.preferences.req", requestId: "pref-2", op: "get", key: "video.agentReceipts" })).toBe(true);
    expect(isAppBridgeRequest({ type: "nautilo.app.preferences.subscribe", key: "writer.spellcheck" })).toBe(true);
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.state.req",
        requestId: "s2",
        op: "set",
        key: "view",
        value: { zoom: 1 },
      }),
    ).toBe(true);
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.context.update",
        summary: { title: "Sheet1" },
      }),
    ).toBe(true);
  });

  test("accepts only targetless human-edit draft truth", () => {
    expect(isAppBridgeRequest({
      type: "nautilo.app.human-edit.update",
      update: {
        state: "dirty",
        draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
      },
    })).toBe(true);
    expect(isAppBridgeRequest({
      type: "nautilo.app.human-edit.update",
      update: { state: "clean" },
    })).toBe(true);

    for (const spoof of [
      { target: { kind: "workspace_artifact" } },
      { path: "other.html" },
      { roomId: "other-room" },
      { relayId: "other-relay" },
      { baseVersion: { kind: "artifact_revision", revision: 99 } },
      { sessionToken: "stolen" },
    ]) {
      expect(isAppBridgeRequest({
        type: "nautilo.app.human-edit.update",
        update: {
          state: "dirty",
          draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
          ...spoof,
        },
      })).toBe(false);
    }
    expect(isAppBridgeRequest({
      type: "nautilo.app.human-edit.update",
      update: {
        state: "clean",
        draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
      },
    })).toBe(false);
    expect(isAppBridgeRequest({
      type: "nautilo.app.human-edit.update",
      update: { state: "dirty" },
    })).toBe(true);
    expect(isAppBridgeRequest({
      type: "nautilo.app.human-edit.update",
      update: { state: "saving" },
    })).toBe(true);
    expect(isAppBridgeRequest({
      type: "nautilo.app.human-edit.update",
      update: { state: "conflict" },
    })).toBe(true);
    expect(isAppBridgeRequest({
      type: "nautilo.app.human-edit.update",
      update: {
        state: "dirty",
        draftPatch: {
          kind: "anchored_text",
          oldString: "before",
          newString: "human",
          target: { kind: "workspace_artifact", artifactInternalId: "other" },
        },
      },
    })).toBe(false);
  });

  test("rejects unknown type, empty requestId, missing write/set value, bad state key", () => {
    expect(isAppBridgeRequest({ type: "nautilo.app.other", requestId: "x" })).toBe(false);
    expect(
      isAppBridgeRequest({ type: "nautilo.app.document.req", requestId: "", op: "read" }),
    ).toBe(false);
    expect(
      isAppBridgeRequest({ type: "nautilo.app.document.req", requestId: "w1", op: "write" }),
    ).toBe(false);
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.state.req",
        requestId: "s3",
        op: "set",
        key: "view",
      }),
    ).toBe(false);
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.state.req",
        requestId: "s4",
        op: "get",
        key: "",
      }),
    ).toBe(false);
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.state.req",
        requestId: "s5",
        op: "get",
        key: "a".repeat(129),
      }),
    ).toBe(false);
    expect(
      isAppBridgeRequest({
        type: "nautilo.app.state.req",
        requestId: "s6",
        op: "get",
        key: "bad:key",
      }),
    ).toBe(false);
  });
});

describe("host-owned keys", () => {
  test("rejects top-level host-owned keys", () => {
    for (const key of [
      "appId",
      "artifactId",
      "artifact_id",
      "id",
      "path",
      "rootPath",
      "roomId",
      "namespaceId",
      "sessionToken",
    ]) {
      expect(rejectsHostOwnedKeys({ type: "nautilo.app.state.req", [key]: "x" })).toBe(true);
    }
  });

  test("does not reject nested id inside value", () => {
    expect(
      rejectsHostOwnedKeys({
        type: "nautilo.app.state.req",
        requestId: "r1",
        op: "set",
        key: "cells",
        value: { id: "cell1" },
      }),
    ).toBe(false);
  });
});

describe("appStateKey + normalizeAppContextSummary", () => {
  test("prefixes app state keys", () => {
    expect(appStateKey("sample-app", "view")).toBe("app:sample-app:view");
  });

  test("truncates long context strings", () => {
    const summary = normalizeAppContextSummary({
      title: "t".repeat(300),
      summary: "s".repeat(3_000),
      selection: { range: "A1:C3", cells: [{ id: "cell-1" }] },
      extra: "ignored",
    });
    expect(summary.title?.length).toBe(256);
    expect(summary.summary).toBe("s".repeat(3_000));
    expect(summary.selection).toEqual({ range: "A1:C3", cells: [{ id: "cell-1" }] });
    expect("extra" in summary).toBe(false);
  });

  test("retains the JSON-normalized Writer selection after validation", () => {
    const summary = normalizeAppContextSummary({
      selection: {
        anchor: { row: 3, column: 2 },
        focus: { row: 3, column: 5 },
        tableCellRange: undefined,
      },
    });

    expect(summary.selection).toEqual({
      anchor: { row: 3, column: 2 },
      focus: { row: 3, column: 5 },
    });
    expect((summary.selection as Record<string, unknown>).tableCellRange).toBeUndefined();
    expect("tableCellRange" in (summary.selection as Record<string, unknown>)).toBe(false);
  });
});

describe("readBoundDocument (artifact)", () => {
  test("calls artifact APIs with id+roomId and omits host ids", async () => {
    getArtifactMock.mockClear();
    getBytesMock.mockClear();

    const result = await readBoundDocument(artifactTarget);

    expect(getArtifactMock).toHaveBeenCalledWith("art-internal-1", { roomId: "room-7" });
    expect(getBytesMock).toHaveBeenCalledWith("art-internal-1", { roomId: "room-7" });
    expect(result.path).toBe("budget.document.json");
    expect(result.mimeType).toBe("application/vnd.nautilo.document+json");
    expect(result.baseRevision).toBe(3);
    expect(result.baseSha256).toBe(await sha256FromEditorIo('{"sheets":[]}'));
    expect("id" in result).toBe(false);
    expect("rootPath" in result).toBe(false);
    expect("namespaceId" in result).toBe(false);
  });

  test("unsupported when no target", async () => {
    await expect(readBoundDocument(undefined)).rejects.toThrow(
      "No document is bound to this app.",
    );
  });

  test("coalesces concurrent Writer and host reads into one artifact fetch", async () => {
    getArtifactMock.mockClear();
    getBytesMock.mockClear();
    const session = { envelope: null };

    const [writerEnvelope, hostEnvelope] = await Promise.all([
      readDocumentSession(session, artifactTarget),
      readDocumentSession(session, artifactTarget),
    ]);

    expect(getArtifactMock).toHaveBeenCalledTimes(1);
    expect(getBytesMock).toHaveBeenCalledTimes(1);
    expect(writerEnvelope).toBe(hostEnvelope);
    expect(session.envelope).toBe(writerEnvelope);
  });

  test("clears a rejected shared read so Writer or host can retry", async () => {
    getArtifactMock.mockClear();
    getBytesMock.mockClear();
    const failure = new Error("artifact read failed");
    getArtifactMock.mockImplementationOnce(async () => {
      throw failure;
    });
    const session = { envelope: null };

    const results = await Promise.allSettled([
      readDocumentSession(session, artifactTarget),
      readDocumentSession(session, artifactTarget),
    ]);

    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(getArtifactMock).toHaveBeenCalledTimes(1);
    expect(getBytesMock).toHaveBeenCalledTimes(1);

    getArtifactMock.mockImplementation(async () => ({
      id: "art-internal-1",
      revision: 3,
      path: "budget.document.json",
    }));
    await expect(readDocumentSession(session, artifactTarget)).resolves.toMatchObject({
      path: "budget.document.json",
      baseRevision: 3,
    });
    expect(getArtifactMock).toHaveBeenCalledTimes(2);
    expect(getBytesMock).toHaveBeenCalledTimes(2);
  });

  test("a Genie snapshot-save notification invalidates cached bytes before the open editor reads", async () => {
    const session = { envelope: null };
    const original = await readDocumentSession(session, artifactTarget);
    getBytesMock.mockImplementationOnce(async () => new Blob(['{"sheets":["Genie edit"]}']));
    let reread: ReturnType<typeof readDocumentSession> | undefined;
    const iframe = { contentWindow: { postMessage: () => {
      expect(session.envelope).toBeNull();
      reread = readDocumentSession(session, artifactTarget);
    } } } as unknown as HTMLIFrameElement;
    postAppDocumentChanged(iframe, {
      type: "changed", path: artifactTarget.path, reloadRequired: true,
    }, session);
    const refreshed = await reread;
    expect(refreshed?.content).toBe('{"sheets":["Genie edit"]}');
    expect(refreshed?.baseSha256).not.toBe(original.baseSha256);
    expect(session.envelope).toBe(refreshed);
  });

  test("a delayed pre-save read cannot refill the cache after a change notification", async () => {
    let releaseOld!: (blob: Blob) => void;
    getBytesMock.mockImplementationOnce(() => new Promise<Blob>((resolve) => { releaseOld = resolve; }));
    const session = { envelope: null };
    const oldRead = readDocumentSession(session, artifactTarget);
    const iframe = { contentWindow: { postMessage: () => {} } } as unknown as HTMLIFrameElement;
    postAppDocumentChanged(iframe, { type: "changed", path: artifactTarget.path }, session);
    getBytesMock.mockImplementationOnce(async () => new Blob(['{"sheets":["saved"]}']));
    const latest = await readDocumentSession(session, artifactTarget);
    releaseOld(new Blob(['{"sheets":["old"]}']));
    await oldRead;
    expect(session.envelope).toBe(latest);
    expect((await readDocumentSession(session, artifactTarget)).content).toBe('{"sheets":["saved"]}');
  });
});

describe("writeBoundDocument (artifact)", () => {
  beforeEach(() => {
    applyPatchMock.mockReset();
    applyPatchMock.mockImplementation(async () => ({
      kind: "applied" as const,
      sha256: "patch-sha256",
      revision: 5,
      patchId: "patch-1",
      requestId: "req-1",
      target: {
        kind: "artifact" as const,
        artifactInternalId: "art-internal-1",
        path: "budget.document.json",
      },
      author: { kind: "human" as const, displayName: "user" },
      patch: { kind: "anchored_text" as const, oldString: "x", newString: "y" },
      unifiedDiff: "",
      rebased: false,
    }));
    saveArtifactMock.mockClear();
  });

  test("applies patch from remembered session base via applyWorkspaceArtifactPatch", async () => {
    applyPatchMock.mockClear();
    saveArtifactMock.mockClear();

    const baseContent = '{"sheets":[]}';
    const nextContent = '{"sheets":[1]}';
    const baseSha = await sha256FromEditorIo(baseContent);
    const session = {
      envelope: {
        content: baseContent,
        mimeType: "application/vnd.nautilo.document+json",
        path: "budget.document.json",
        baseSha256: baseSha,
        baseRevision: 3,
      },
    };

    const result = await writeBoundDocument(artifactTarget, nextContent, {
      session,
      baseSha256: baseSha,
      baseRevision: 3,
    });

    expect(result).toEqual({
      kind: "saved",
      sha256: "patch-sha256",
      revision: 5,
      path: "budget.document.json",
    });
    expect(applyPatchMock).toHaveBeenCalledTimes(1);
    expect(saveArtifactMock).not.toHaveBeenCalled();
    const [id, body, roomOpts] = applyPatchMock.mock.calls[0] as [
      string,
      {
        baseRevision: number;
        baseSha256: string;
        patch: { kind: string };
        clientMutationId: string;
        checkpoint: boolean;
        mimeType: string;
        target: { artifactInternalId: string; path: string; roomId: string };
      },
      { roomId: string },
    ];
    expect(id).toBe("art-internal-1");
    expect(roomOpts).toEqual({ roomId: "room-7" });
    expect(body.baseRevision).toBe(3);
    expect(body.baseSha256).toBe(baseSha);
    expect(body.checkpoint).toBe(true);
    expect(body.mimeType).toBe("application/vnd.nautilo.document+json");
    expect(body.target.artifactInternalId).toBe("art-internal-1");
    expect(body.patch).toEqual(deriveAnchoredTextPatch(baseContent, nextContent));
    expect(typeof body.clientMutationId).toBe("string");
    expect(session.envelope?.baseSha256).toBe("patch-sha256");
    expect(session.envelope?.content).toBe(nextContent);
  });

  test("uses canonical content from patch response for session and persistedContent", async () => {
    applyPatchMock.mockClear();

    const baseContent = '{"sheets":[]}';
    const submittedContent = '{"sheets":[1]}';
    const canonicalContent = '{"sheets":[1],"meta":"normalized"}';
    const baseSha = await sha256FromEditorIo(baseContent);
    const session = {
      envelope: {
        content: baseContent,
        mimeType: "application/vnd.nautilo.document+json",
        path: "budget.document.json",
        baseSha256: baseSha,
        baseRevision: 3,
      },
    };

    applyPatchMock.mockImplementationOnce(async () => ({
      kind: "applied" as const,
      sha256: "patch-canonical-sha",
      revision: 6,
      content: canonicalContent,
      patchId: "patch-canonical",
      requestId: "req-canonical",
      target: {
        kind: "artifact" as const,
        artifactInternalId: "art-internal-1",
        path: "budget.document.json",
      },
      author: { kind: "human" as const, displayName: "user" },
      patch: { kind: "anchored_text" as const, oldString: "x", newString: "y" },
      unifiedDiff: "",
      rebased: true,
    }));

    const result = await writeBoundDocument(artifactTarget, submittedContent, { session });

    expect(result).toEqual({
      kind: "saved",
      sha256: "patch-canonical-sha",
      revision: 6,
      persistedContent: canonicalContent,
      path: "budget.document.json",
    });
    expect(session.envelope?.content).toBe(canonicalContent);
    expect(session.envelope?.baseSha256).toBe("patch-canonical-sha");
  });

  test("read-before-write fallback when no remembered session", async () => {
    applyPatchMock.mockClear();
    getArtifactMock.mockClear();
    getBytesMock.mockClear();

    const nextContent = '{"sheets":[1]}';
    await writeBoundDocument(artifactTarget, nextContent);

    expect(getArtifactMock).toHaveBeenCalled();
    expect(getBytesMock).toHaveBeenCalled();
    expect(applyPatchMock).toHaveBeenCalledTimes(1);
    expect(saveArtifactMock).not.toHaveBeenCalled();
  });

  test("read-before-write fallback reports conflict when caller base is stale", async () => {
    applyPatchMock.mockClear();
    getArtifactMock.mockClear();
    getBytesMock.mockClear();

    const result = await writeBoundDocument(artifactTarget, '{"sheets":[1]}', {
      baseSha256: "stale-sha",
      baseRevision: 2,
    });

    expect(result).toEqual({
      kind: "conflict",
      currentSha256: await sha256FromEditorIo('{"sheets":[]}'),
    });
    expect(getArtifactMock).toHaveBeenCalled();
    expect(getBytesMock).toHaveBeenCalled();
    expect(applyPatchMock).not.toHaveBeenCalled();
    expect(saveArtifactMock).not.toHaveBeenCalled();
  });

  test("remembered session base wins over mismatched caller hints", async () => {
    applyPatchMock.mockClear();
    saveArtifactMock.mockClear();

    const baseContent = '{"sheets":[]}';
    const baseSha = await sha256FromEditorIo(baseContent);
    const session = {
      envelope: {
        content: baseContent,
        mimeType: "application/vnd.nautilo.document+json",
        path: "budget.document.json",
        baseSha256: baseSha,
        baseRevision: 3,
      },
    };

    await writeBoundDocument(artifactTarget, '{"sheets":[2]}', {
      session,
      baseSha256: "stale-sha",
      baseRevision: 1,
    });

    const [, body] = applyPatchMock.mock.calls[0] as [
      string,
      { baseSha256: string; baseRevision: number | null },
    ];
    expect(body.baseSha256).toBe(baseSha);
    expect(body.baseRevision).toBe(3);
  });

  test("snapshot fallback only for empty-base materialization", async () => {
    applyPatchMock.mockClear();
    saveArtifactMock.mockClear();

    const result = await writeBoundDocument(artifactTarget, "created-body", {
      allowSnapshotFallback: true,
      session: {
        envelope: {
          content: "",
          mimeType: "application/vnd.nautilo.document+json",
          path: "budget.document.json",
          baseSha256: null,
          baseRevision: null,
        },
      },
    });

    expect(result).toEqual({
      kind: "saved",
      sha256: "saved-sha256",
      revision: 4,
      path: "budget.document.json",
    });
    expect(saveArtifactMock).toHaveBeenCalledTimes(1);
    expect(applyPatchMock).not.toHaveBeenCalled();
  });

  test("broader retry succeeds after stale unrebaseable conflict", async () => {
    applyPatchMock.mockClear();

    const baseContent = '{"sheets":[]}';
    const nextContent = '{"sheets":[1]}';
    const baseSha = await sha256FromEditorIo(baseContent);
    const session = {
      envelope: {
        content: baseContent,
        mimeType: "application/vnd.nautilo.document+json",
        path: "budget.document.json",
        baseSha256: baseSha,
        baseRevision: 3,
      },
    };

    applyPatchMock
      .mockImplementationOnce(async () => {
        throw new DocumentPatchConflictError({
          kind: "stale_base_unrebaseable",
          latestRevision: 4,
          latestSha256: "deadbeef".repeat(8),
        });
      })
      .mockImplementationOnce(async () => ({
        kind: "applied" as const,
        sha256: "retry-sha256",
        revision: 6,
        patchId: "patch-retry",
        requestId: "req-retry",
        target: {
          kind: "artifact" as const,
          artifactInternalId: "art-internal-1",
          path: "budget.document.json",
        },
        author: { kind: "human" as const, displayName: "user" },
        patch: { kind: "anchored_text" as const, oldString: "x", newString: "y" },
        unifiedDiff: "",
        rebased: false,
      }));

    const result = await writeBoundDocument(artifactTarget, nextContent, { session });

    expect(result).toEqual({
      kind: "saved",
      sha256: "retry-sha256",
      revision: 6,
      path: "budget.document.json",
    });
    expect(applyPatchMock).toHaveBeenCalledTimes(2);
    const retryBody = applyPatchMock.mock.calls[1]?.[1] as { patch: { scope?: { from: number; to: number } } };
    expect(retryBody.patch.scope).toEqual({ from: 1, to: 1 });
    expect(session.envelope?.content).toBe(nextContent);
  });

  test("broader retry failure returns conflict after second rejection", async () => {
    applyPatchMock.mockClear();

    const baseContent = '{"sheets":[]}';
    const session = {
      envelope: {
        content: baseContent,
        mimeType: "application/vnd.nautilo.document+json",
        path: "budget.document.json",
        baseSha256: await sha256FromEditorIo(baseContent),
        baseRevision: 3,
      },
    };

    applyPatchMock.mockImplementation(async () => {
      throw new DocumentPatchConflictError({
        kind: "anchor_ambiguous",
        latestRevision: 4,
        latestSha256: "cafebabe".repeat(8),
      });
    });

    const result = await writeBoundDocument(artifactTarget, '{"sheets":[9]}', { session });

    expect(result).toEqual({
      kind: "conflict",
      currentSha256: "cafebabe".repeat(8),
    });
    expect(applyPatchMock).toHaveBeenCalledTimes(2);
  });

  test("maps non-retryable DocumentPatchConflictError to error", async () => {
    applyPatchMock.mockImplementationOnce(async () => {
      throw new DocumentPatchConflictError({
        kind: "unsupported",
        reason: "binary document",
      });
    });

    const baseContent = '{"sheets":[]}';
    const session = {
      envelope: {
        content: baseContent,
        mimeType: "application/vnd.nautilo.document+json",
        path: "budget.document.json",
        baseSha256: await sha256FromEditorIo(baseContent),
        baseRevision: 3,
      },
    };

    const result = await writeBoundDocument(artifactTarget, '{"sheets":[1]}', { session });

    expect(result).toEqual({ kind: "error", message: "binary document" });
    expect(session.envelope?.content).toBe(baseContent);
  });
});

describe("writeBoundDocument (fs)", () => {
  test("still uses desktop fs write path", async () => {
    writeFileMock.mockClear();
    applyPatchMock.mockClear();
    const fsTarget = fsOpenFileTarget("/repo/file.json", "/repo");
    const session = {
      envelope: {
        content: "base-body",
        mimeType: "",
        path: "file.json",
        baseSha256: "base-sha",
        baseRevision: null,
      },
    };

    const result = await writeBoundDocument(fsTarget, "next-body", {
      baseSha256: "base-sha",
      session,
    });

    expect(result).toEqual({ kind: "saved", sha256: "fs-saved-sha", path: "file.json" });
    expect(session.envelope).toEqual({
      content: "next-body",
      mimeType: "",
      path: "file.json",
      baseSha256: "fs-saved-sha",
      baseRevision: null,
    });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(applyPatchMock).not.toHaveBeenCalled();
  });
});

describe("statBoundDocument (artifact)", () => {
  test("returns stat without host ids", async () => {
    const stat = await statBoundDocument(artifactTarget);
    expect(stat.kind).toBe("artifact");
    expect(stat.path).toBe("budget.document.json");
    expect(stat.mimeType).toBe("application/vnd.nautilo.document+json");
    expect(stat.revision).toBe(3);
    expect(stat.size).toBeGreaterThan(0);
    expect(stat.sha256).toBe(await sha256FromEditorIo('{"sheets":[]}'));
    expect("id" in stat).toBe(false);
    expect("rootPath" in stat).toBe(false);
  });
});

describe("app state", () => {
  test("get prefixes app:sample-app:view and 404 returns undefined", async () => {
    getArtifactStateMock.mockClear();
    getArtifactStateMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });

    const missing = await getAppState("sample-app", artifactTarget, "view");
    expect(missing).toBeUndefined();

    getArtifactStateMock.mockClear();
    const value = await getAppState("sample-app", artifactTarget, "view");
    expect(value).toEqual({ zoom: 1 });
    expect(getArtifactStateMock).toHaveBeenCalledWith(
      "art-internal-1",
      "app:sample-app:view",
      { roomId: "room-7" },
    );
  });

  test("set prefixes key", async () => {
    setArtifactStateMock.mockClear();
    await setAppState("sample-app", artifactTarget, "view", { zoom: 2 });
    expect(setArtifactStateMock).toHaveBeenCalledWith(
      "art-internal-1",
      "app:sample-app:view",
      { zoom: 2 },
      { roomId: "room-7" },
    );
  });

  test("fs state is unsupported and does not call API", async () => {
    getArtifactStateMock.mockClear();
    setArtifactStateMock.mockClear();
    const fsTarget = fsOpenFileTarget("/repo/file.json", "/repo");

    await expect(getAppState("sample-app", fsTarget, "view")).rejects.toThrow(
      "App state is only supported for workspace artifact documents.",
    );
    await expect(setAppState("sample-app", fsTarget, "view", {})).rejects.toThrow(
      "App state is only supported for workspace artifact documents.",
    );
    expect(getArtifactStateMock).not.toHaveBeenCalled();
    expect(setArtifactStateMock).not.toHaveBeenCalled();
  });
});

describe("installAppBridge", () => {
  test("delegates valid export results without logging or posting a generic bridge error", async () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof iframeWindow.postMessage;
    const consoleError = console.error;
    const errorMock = mock((..._args: unknown[]) => {});
    console.error = errorMock as typeof console.error;
    const teardown = installAppBridge({ iframe, appId: "presentation" });
    try {
      window.dispatchEvent(new MessageEvent("message", {
        source: iframeWindow as unknown as MessageEventSource,
        data: {
          type: "nautilo.app.export.prepare.result",
          requestId: "export-1",
          ok: true,
          result: {
            content: "AA==", encoding: "base64", mimeType: "application/pdf",
            byteLength: 1, sourceSha256: "a".repeat(64), warnings: [],
          },
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errorMock).not.toHaveBeenCalled();
      expect(posted).toEqual([]);

      window.dispatchEvent(new MessageEvent("message", {
        source: iframeWindow as unknown as MessageEventSource,
        data: { type: "nautilo.app.document.req", requestId: "bad", op: "bogus" },
      }));
      await waitUntil(() => posted.length > 0);
      expect(errorMock).toHaveBeenCalled();
      expect(posted[0]).toMatchObject({
        type: "nautilo.app.res", requestId: "bad", ok: false,
        error: "Malformed app bridge message.",
      });
    } finally {
      teardown();
      console.error = consoleError;
    }
  });

  const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  const priorGlobals: Record<string, unknown> = {};

  beforeAll(() => {
    for (const key of [
      "window",
      "document",
      "HTMLElement",
      "HTMLIFrameElement",
      "MessageEvent",
      "CustomEvent",
    ] as const) {
      priorGlobals[key] = globalThis[key as keyof typeof globalThis];
      Object.defineProperty(globalThis, key, {
        value: happyWindow[key as keyof Window],
        configurable: true,
        writable: true,
      });
    }
  });

  afterAll(() => {
    happyWindow.close();
    for (const [key, value] of Object.entries(priorGlobals)) {
      if (value === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, {
          value,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  test("authored history binds native reads to the host document, not iframe authority", async () => {
    readAuthoredChangeMock.mockClear();
    readFileMock.mockImplementationOnce(async () => "current video");
    const sha = await sha256FromEditorIo("current video");
    const retained = { kind: "ready", operationId: "retained-operation", author: { kind: "agent", displayName: "Moxie" },
      before: { content: "before", sha256: await sha256FromEditorIo("before") },
      after: { content: "after", sha256: await sha256FromEditorIo("after") }, currentSha256: sha };
    readAuthoredChangeMock.mockImplementationOnce(async () => retained);
    const iframe = document.createElement("iframe");
    const contentWindow = {} as Window;
    const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
    contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
    const teardown = installAppBridge({ iframe, appId: "nautilo-video", target: fsOpenFileTarget("/folder/cut.video.html", "/folder") });
    try {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.document.req", requestId: "history", op: "authoredChange" }, source: contentWindow as unknown as MessageEventSource }));
      await waitUntil(() => posted.length === 1);
      expect(readAuthoredChangeMock).toHaveBeenCalledWith({ path: "/folder/cut.video.html", expectedSha256: sha });
      expect(posted[0]).toMatchObject({ ok: true, value: { ...retained, author: { kind: "agent", displayName: "Genie" } } });
      expect(JSON.stringify(posted)).not.toContain("/folder");
    } finally { teardown(); }
  });

  test("Workspace authored history uses the host-bound Room and document version", async () => {
    getWorkspaceArtifactAuthoredChangeMock.mockClear();
    const content = '{"video":"current"}';
    const sha = await sha256FromEditorIo(content);
    const before = '{"video":"before"}';
    const after = '{"video":"after"}';
    const retained = {
      kind: "ready", operationId: "workspace-operation",
      author: { kind: "agent", displayName: "Provider name" },
      before: { content: before, sha256: await sha256FromEditorIo(before) },
      after: { content: after, sha256: await sha256FromEditorIo(after) }, currentSha256: sha,
    };
    getWorkspaceArtifactAuthoredChangeMock.mockImplementationOnce(async () => retained);
    const iframe = document.createElement("iframe");
    const contentWindow = {} as Window;
    const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
    contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
    const documentSession = {
      envelope: { content, mimeType: "text/html", path: artifactTarget.path, baseSha256: sha, baseRevision: 3 },
      documentTargetKey: "artifact:room-7:art-internal-1:budget.document.json:",
    };
    const teardown = installAppBridge({ iframe, appId: "nautilo-video", target: artifactTarget, documentSession });
    try {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.document.req", requestId: "workspace-history", op: "authoredChange" }, source: contentWindow as unknown as MessageEventSource }));
      await waitUntil(() => posted.length === 1);
      expect(getWorkspaceArtifactAuthoredChangeMock).toHaveBeenCalledWith("art-internal-1", {
        roomId: "room-7", expectedSha256: sha, expectedRevision: 3,
      });
      expect(posted[0]).toMatchObject({ ok: true, value: { ...retained, author: { kind: "agent", displayName: "Genie" } } });
    } finally { teardown(); }
  });

  test("Workspace authored history rejects a late result after the document version changes", async () => {
    getWorkspaceArtifactAuthoredChangeMock.mockClear();
    const content = '{"video":"current"}';
    const sha = await sha256FromEditorIo(content);
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    getWorkspaceArtifactAuthoredChangeMock.mockImplementationOnce(async () => pending);
    const iframe = document.createElement("iframe");
    const contentWindow = {} as Window;
    const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
    contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
    const documentSession = {
      envelope: { content, mimeType: "text/html", path: artifactTarget.path, baseSha256: sha, baseRevision: 3 },
      documentTargetKey: "artifact:room-7:art-internal-1:budget.document.json:",
    };
    const teardown = installAppBridge({ iframe, appId: "nautilo-video", target: artifactTarget, documentSession });
    try {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.document.req", requestId: "late-history", op: "authoredChange" }, source: contentWindow as unknown as MessageEventSource }));
      await waitUntil(() => getWorkspaceArtifactAuthoredChangeMock.mock.calls.length === 1);
      documentSession.envelope = { ...documentSession.envelope, baseRevision: 4 };
      release({ kind: "none" });
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toMatchObject({ ok: true, value: { kind: "unavailable", code: "document_changed" } });
    } finally { teardown(); }
  });

  test("other apps cannot read authored history", async () => {
    readAuthoredChangeMock.mockClear();
    getWorkspaceArtifactAuthoredChangeMock.mockClear();
    for (const [appId, target] of [["nautilo-writer", artifactTarget], ["nautilo-writer", fsOpenFileTarget("/folder/cut.html", "/folder")]] as const) {
      const iframe = document.createElement("iframe");
      const contentWindow = {} as Window;
      const posted: unknown[] = [];
      Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
      contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
      const teardown = installAppBridge({ iframe, appId, target });
      try {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.document.req", requestId: "history-denied", op: "authoredChange" }, source: contentWindow as unknown as MessageEventSource }));
        await waitUntil(() => posted.length === 1);
        expect(posted[0]).toMatchObject({ ok: true, value: { kind: "unavailable", code: "unsupported_environment" } });
      } finally { teardown(); }
    }
    expect(readAuthoredChangeMock).not.toHaveBeenCalled();
    expect(getWorkspaceArtifactAuthoredChangeMock).not.toHaveBeenCalled();
  });

  test("postAppDocumentChanged posts patch_applied and reloadRequired changed events", () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", {
      value: iframeWindow,
      configurable: true,
    });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((data: unknown) => {
      posted.push(data);
    }) as typeof iframeWindow.postMessage;

    postAppDocumentChanged(iframe, {
      type: "patch_applied",
      patchId: "patch-1",
      revision: 1,
      sha256: "sha-1",
      previousRevision: 0,
      previousSha256: "sha-0",
      patch: { kind: "anchored_text", oldString: "a", newString: "b" },
      envelope: {
        content: "b",
        mimeType: "text/plain",
        path: "doc.txt",
        baseSha256: "sha-1",
        baseRevision: 1,
      },
    });
    postAppDocumentChanged(iframe, {
      type: "changed",
      path: "doc.txt",
      reloadRequired: true,
    });

    expect(posted).toEqual([
      {
        type: "nautilo.app.document.changed",
        event: {
          type: "patch_applied",
          patchId: "patch-1",
          revision: 1,
          sha256: "sha-1",
          previousRevision: 0,
          previousSha256: "sha-0",
          patch: { kind: "anchored_text", oldString: "a", newString: "b" },
          envelope: {
            content: "b",
            mimeType: "text/plain",
            path: "doc.txt",
            baseSha256: "sha-1",
            baseRevision: 1,
          },
        },
      },
      {
        type: "nautilo.app.document.changed",
        event: { type: "changed", path: "doc.txt", reloadRequired: true },
      },
    ]);
  });

  test("posts only an opaque live session capability to the mounted iframe", () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof iframeWindow.postMessage;

    postAppLiveSession(iframe, { sessionToken: "a".repeat(43), sessionId: "route-a", documentVersion: { kind: "artifact_revision", revision: 7 } });

    expect(posted).toEqual([
      {
        type: "nautilo.app.live-session",
        capability: {
          sessionToken: "a".repeat(43),
          sessionId: "route-a",
          documentVersion: { kind: "artifact_revision", revision: 7 },
        },
      },
    ]);
    expect(JSON.stringify(posted)).not.toContain("art-internal-1");
  });

  test("posts the fixed live proposal envelope without document binding", () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof iframeWindow.postMessage;

    postAppLiveProposal(iframe, {
      proposalId: "tool-386",
      appId: "nautilo-writer",
      sessionId: "writer-routing-session",
      documentVersion: { kind: "artifact_revision", revision: 7 },
      operations: [{ type: "insert_text" }],
    });

    expect(posted).toEqual([
      {
        type: "nautilo.app.live-proposal",
        proposal: {
          proposalId: "tool-386",
          appId: "nautilo-writer",
          sessionId: "writer-routing-session",
          documentVersion: { kind: "artifact_revision", revision: 7 },
          operations: [{ type: "insert_text" }],
        },
      },
    ]);
    expect(JSON.stringify(posted)).not.toContain("art-internal-1");
    expect(saveArtifactMock).not.toHaveBeenCalled();
    expect(applyPatchMock).not.toHaveBeenCalled();
  });

  test("ignores different source, handles bound source, rejects host-owned path", async () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", {
      value: iframeWindow,
      configurable: true,
    });

    const posted: unknown[] = [];
    iframeWindow.postMessage = ((data: unknown) => {
      posted.push(data);
    }) as typeof iframeWindow.postMessage;

    const onContextUpdate = mock((_ctx: unknown) => {});
    const onHumanEditUpdate = mock((_update: unknown) => {});
    const teardown = installAppBridge({
      iframe,
      appId: "sample-app",
      target: artifactTarget,
      onContextUpdate,
      onHumanEditUpdate,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "nautilo.app.document.req",
          requestId: "ignored",
          op: "read",
        },
        source: {} as MessageEventSource,
      }),
    );
    expect(posted).toHaveLength(0);

    getArtifactMock.mockClear();
    getBytesMock.mockClear();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "nautilo.app.document.req",
          requestId: "read-1",
          op: "read",
        },
        source: iframeWindow as unknown as MessageEventSource,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getArtifactMock).toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "nautilo.app.res",
      requestId: "read-1",
      ok: true,
    });

    posted.length = 0;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "nautilo.app.document.req",
          requestId: "bad-1",
          op: "read",
          path: "sneaky.txt",
        },
        source: iframeWindow as unknown as MessageEventSource,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted[0]).toMatchObject({
      type: "nautilo.app.res",
      requestId: "bad-1",
      ok: false,
    });

    posted.length = 0;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "nautilo.app.context.update",
          summary: { title: "Budget", selection: "A1:C3" },
        },
        source: iframeWindow as unknown as MessageEventSource,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onContextUpdate).toHaveBeenCalledTimes(1);
    expect(onContextUpdate.mock.calls[0]?.[0]).toMatchObject({
      appId: "sample-app",
      summary: { title: "Budget", selection: "A1:C3" },
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "nautilo.app.human-edit.update",
          update: {
            state: "dirty",
            draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
          },
        },
        source: iframeWindow as unknown as MessageEventSource,
      }),
    );
    expect(onHumanEditUpdate).toHaveBeenCalledWith({
      state: "dirty",
      draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
    });

    let listenerRemoved = false;
    const originalRemove = window.removeEventListener.bind(window);
    window.removeEventListener = ((type, listener, options) => {
      if (type === "message") listenerRemoved = true;
      originalRemove(type, listener, options);
    }) as typeof window.removeEventListener;
    teardown();
    expect(listenerRemoved).toBe(true);
    window.removeEventListener = originalRemove;

    posted.length = 0;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "nautilo.app.state.req",
          requestId: "after-teardown",
          op: "get",
          key: "view",
        },
        source: iframeWindow as unknown as MessageEventSource,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toHaveLength(0);
  });

  test("recovery uses only the bound target and refuses preview and forged scope before touching storage", async () => {
    const iframe = document.createElement("iframe");
    const frame = { postMessage(data: unknown) { posted.push(data); } } as Window;
    Object.defineProperty(iframe, "contentWindow", { value: frame, configurable: true });
    const posted: unknown[] = [];
    const target = fsOpenFileTarget("/folder/deck.presentation.html", "/folder");
    const read = mock(async () => ({ revision: null, draft: null }));
    const write = mock(async () => ({ revision: "journal-1" }));
    const recovery = { read, write, dispose() {} };
    const send = (data: Record<string, unknown>, source = frame) => window.dispatchEvent(new MessageEvent("message", { data, source }));
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    let teardown = installAppBridge({ iframe, appId: "nautilo-presentation", mode: "edit", target, recovery });
    send({ type: "nautilo.app.recovery.req", requestId: "foreign-frame", op: "read" }, {} as Window);
    await tick();
    expect(read).not.toHaveBeenCalled();
    send({ type: "nautilo.app.recovery.req", requestId: "read", op: "read" });
    await tick();
    expect(read).toHaveBeenCalledWith(target);
    const input = { expectedRevision: null, draft: { version: 1, content: "draft", exact: true, baseSha256: "sha", baseRevision: null } };
    send({ type: "nautilo.app.recovery.req", requestId: "write", op: "write", input });
    await tick();
    expect(write).toHaveBeenCalledWith(target, input);
    send({ type: "nautilo.app.recovery.req", requestId: "forged", op: "write", input, key: "someone-else" });
    await tick();
    expect(write).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ requestId: "forged", ok: false });
    teardown();
    teardown = installAppBridge({ iframe, appId: "nautilo-presentation", mode: "preview", target, recovery });
    send({ type: "nautilo.app.recovery.req", requestId: "preview", op: "read" });
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ requestId: "preview", ok: false, status: 403 });
    teardown();
  });

  test("template access is Slides-only, editable, source-bound and rejects forged scope", async () => {
    const iframe = document.createElement("iframe");
    const posted: unknown[] = [];
    const frame = { postMessage(data: unknown) { posted.push(data); } } as Window;
    Object.defineProperty(iframe, "contentWindow", { value: frame, configurable: true });
    const templates = {
      list: mock(async () => [{ id: "one", name: "Launch" }]),
      read: mock(async () => ({ content: "template-content" })),
      save: mock(async () => ({ id: "two", name: "Launch" })),
      remove: mock(async () => {}),
    };
    const send = (data: Record<string, unknown>, source = frame) => window.dispatchEvent(new MessageEvent("message", { data, source }));
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    let teardown = installAppBridge({ iframe, appId: "nautilo-presentation", mode: "edit", templates });
    const list = { type: "nautilo.app.templates.req", requestId: "list", op: "list" };
    send(list, {} as Window); await tick();
    expect(templates.list).not.toHaveBeenCalled();
    send(list); await tick();
    expect(templates.list).toHaveBeenCalledTimes(1);
    send({ ...list, ownerId: "another-human" }); await tick();
    expect(templates.list).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ ok: false });
    send({ type: "nautilo.app.templates.req", requestId: "save", op: "save", name: "Launch", content: "selected-slide" });
    await tick(); expect(templates.save).toHaveBeenCalledWith({ name: "Launch", content: "selected-slide" });
    send({ type: "nautilo.app.templates.req", requestId: "read", op: "read", templateId: "one" });
    await tick(); expect(templates.read).toHaveBeenCalledWith("one");
    expect(posted.at(-1)).toMatchObject({ ok: true, value: { content: "template-content" } });
    send({ type: "nautilo.app.templates.req", requestId: "remove", op: "remove", templateId: "one" });
    await tick(); expect(templates.remove).toHaveBeenCalledWith("one");
    expect(posted.at(-1)).toMatchObject({ ok: true });
    send({ type: "nautilo.app.templates.req", requestId: "forged", op: "read", templateId: "one", id: "host-target" });
    await tick(); expect(templates.read).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ ok: false });
    teardown();
    for (const [appId, mode] of [["nautilo-presentation", "preview"], ["nautilo-writer", "edit"]] as const) {
      teardown = installAppBridge({ iframe, appId, mode, templates });
      send(list); await tick();
      expect(templates.list).toHaveBeenCalledTimes(1);
      expect(posted.at(-1)).toMatchObject({ ok: false, status: 403 });
      teardown();
    }
  });

  test("admits asset requests only from the bound frame with host-provided assets", async () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof iframeWindow.postMessage;
    const asset = {
      ref: "artifact:123e4567-e89b-12d3-a456-426614174000:" + "a".repeat(64),
      name: "photo.png",
      width: 12,
      height: 8,
      dataUrl: "data:image/png;base64,AA==",
    };
    const pick = mock(async () => asset);
    const read = mock(async (ref: string) => ({ ...asset, ref }));
    const teardown = installAppBridge({ iframe, appId: "nautilo-design", assets: { pick, read } });
    const request = (data: Record<string, unknown>, source: MessageEventSource) => window.dispatchEvent(new MessageEvent("message", {
      data,
      source,
    }));

    request({ type: "nautilo.app.assets.req", requestId: "other-frame", op: "pick" }, {} as MessageEventSource);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pick).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);

    request({ type: "nautilo.app.assets.req", requestId: "pick-1", op: "pick" }, iframeWindow as unknown as MessageEventSource);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ type: "nautilo.app.res", requestId: "pick-1", ok: true, value: asset });

    request({ type: "nautilo.app.assets.req", requestId: "read-1", op: "read", ref: asset.ref }, iframeWindow as unknown as MessageEventSource);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledWith(asset.ref);
    expect(posted.at(-1)).toMatchObject({ type: "nautilo.app.res", requestId: "read-1", ok: true, value: asset });

    request({
      type: "nautilo.app.assets.req", requestId: "forged", op: "read", ref: asset.ref, sessionToken: "forged-authority",
    }, iframeWindow as unknown as MessageEventSource);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({
      type: "nautilo.app.res", requestId: "forged", ok: false, error: "Message must not include host-owned fields.",
    });
    teardown();

    const unavailable = document.createElement("iframe");
    const unavailableWindow = {} as Window;
    Object.defineProperty(unavailable, "contentWindow", { value: unavailableWindow, configurable: true });
    unavailableWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof unavailableWindow.postMessage;
    const removeUnavailable = installAppBridge({ iframe: unavailable, appId: "nautilo-design" });
    request({ type: "nautilo.app.assets.req", requestId: "unavailable", op: "pick" }, unavailableWindow as unknown as MessageEventSource);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted.at(-1)).toMatchObject({
      type: "nautilo.app.res", requestId: "unavailable", ok: false, error: "Image access is unavailable for this app version.",
    });
    removeUnavailable();
  });

  test("lifecycle registration and Save Copy are source-bound host operations", async () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof iframeWindow.postMessage;
    const onLifecycleRegistrationChange = mock((_registered: boolean) => {});
    const saveCopy = mock(async (_content: string) => ({ path: "poster.conflict-copy.design.json" }));
    const teardown = installAppBridge({
      iframe,
      appId: "nautilo-design",
      target: artifactTarget,
      onLifecycleRegistrationChange,
      saveCopy,
    });

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "nautilo.app.lifecycle.register" },
      source: {} as MessageEventSource,
    }));
    expect(onLifecycleRegistrationChange).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "nautilo.app.lifecycle.register" },
      source: iframeWindow as unknown as MessageEventSource,
    }));
    expect(onLifecycleRegistrationChange).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "nautilo.app.document.req",
        requestId: "copy-1",
        op: "saveCopy",
        value: { content: "exact draft" },
      },
      source: iframeWindow as unknown as MessageEventSource,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveCopy).toHaveBeenCalledWith("exact draft");
    expect(posted.at(-1)).toMatchObject({
      type: "nautilo.app.res",
      requestId: "copy-1",
      ok: true,
      value: { path: "poster.conflict-copy.design.json" },
    });
    teardown();
    expect(onLifecycleRegistrationChange).toHaveBeenLastCalledWith(false);
  });

  test("routes Workspace import through the parent only and permits Video rail layout for Workspace and Current Folder", async () => {
    getBytesMock.mockImplementationOnce(async () => new Blob([createEmptyVideoHtml()], { type: "text/html" }));
    const makeHarness = () => {
      const iframe = document.createElement("iframe");
      const iframeWindow = {} as Window;
      const posted: unknown[] = [];
      Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
      iframeWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof iframeWindow.postMessage;
      const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", {
        data,
        source: iframeWindow as unknown as MessageEventSource,
      }));
      return { iframe, posted, send };
    };
    const result = {
      kind: "ready" as const,
      mediaRef: "video-imports/media-1.mp4",
      label: "Opening",
      durationSec: 4.2,
      frameRate: { numerator: 30, denominator: 1 },
      source: {
        kind: "workspace-artifact" as const,
        artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
        path: "video-imports/media-1.mp4",
      },
    };
    const workspace = makeHarness();
    const importWorkspaceVideo = mock(async () => result);
    const workspaceLayout = mock(async (_input: { enabled: boolean }) => undefined);
    const workspaceTeardown = installAppBridge({
      iframe: workspace.iframe,
      appId: "nautilo-video",
      target: artifactOpenFileTarget({
        id: "video-row-1", path: "test_video.html", mimeType: "text/html", roomId: "room-7",
      }),
      videoGeneration: true,
      mediaProxy: true,
      onVideoWorkspaceMediaImport: importWorkspaceVideo,
      onVideoHostLayout: workspaceLayout,
    });
    workspace.send({ type: "nautilo.app.media.req", requestId: "import-1", op: "importVideo" });
    await waitUntil(() => workspace.posted.length === 1);
    expect(importWorkspaceVideo).toHaveBeenCalledTimes(1);
    expect(workspace.posted[0]).toEqual({ type: "nautilo.app.res", requestId: "import-1", ok: true, value: result });
    expect(JSON.stringify(workspace.posted[0])).not.toContain("video-row-1");
    workspace.send({ type: "nautilo.app.video-host-layout.req", requestId: "layout-1", op: "setFullWidth", enabled: true });
    await waitUntil(() => workspace.posted.length === 2);
    expect(workspaceLayout).toHaveBeenCalledWith({ enabled: true });
    workspaceTeardown();

    const currentFolder = makeHarness();
    const currentFolderLayout = mock(async (_input: { enabled: boolean }) => undefined);
    const currentFolderTeardown = installAppBridge({
      iframe: currentFolder.iframe,
      appId: "nautilo-video",
      target: fsOpenFileTarget("/project/rough.video.html", "/project"),
      videoGeneration: true,
      onVideoHostLayout: currentFolderLayout,
    });
    currentFolder.send({ type: "nautilo.app.video-host-layout.req", requestId: "layout-2", op: "setFullWidth", enabled: false });
    await waitUntil(() => currentFolder.posted.length === 1);
    expect(currentFolderLayout).toHaveBeenCalledWith({ enabled: false });
    currentFolderTeardown();
  });

  test("reference import preserves safe failure reasons without exposing arbitrary host data", async () => {
    for (const result of [
      { kind: "unavailable", code: "cancelled" },
      { kind: "unavailable", code: "stale_project" },
      { kind: "unavailable", code: "private-secret" },
      { kind: "unavailable", code: "cancelled", token: "private-secret" },
    ]) {
      const iframe = document.createElement("iframe");
      const contentWindow = {} as Window;
      const posted: unknown[] = [];
      Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
      contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
      const teardown = installAppBridge({
        iframe, appId: "nautilo-video", videoGeneration: true,
        target: artifactOpenFileTarget({ id: "video-row", path: "smoke.video.html", mimeType: "text/html", roomId: "room" }),
        onVideoGenerationImportReference: async () => result as never,
      });
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "nautilo.app.video-generation.req", requestId: "reference", op: "importReference", mediaKind: "video" },
        source: contentWindow as unknown as MessageEventSource,
      }));
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toEqual({ type: "nautilo.app.res", requestId: "reference", ok: true,
        value: JSON.stringify(result).includes("private-secret") ? { kind: "unavailable", code: "unavailable" } : result });
      teardown();
    }
  });

  test("Workspace export forwards only version claims and relays owned progress and cancellation", async () => {
    const iframe = document.createElement("iframe");
    const contentWindow = {} as Window; const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
    contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: contentWindow as unknown as MessageEventSource }));
    let exportInput: import("../../src/apps/app-bridge").VideoWorkspaceMediaExportInput | undefined;
    let finish: ((value: { kind: "cancelled" }) => void) | undefined;
    const exporter = mock((input: import("../../src/apps/app-bridge").VideoWorkspaceMediaExportInput) => {
      exportInput = input;
      return new Promise<{ kind: "cancelled" }>((resolve) => { finish = resolve; });
    });
    const teardown = installAppBridge({ iframe, appId: "nautilo-video", mediaProxy: true,
      target: artifactOpenFileTarget({ id: "private-row", path: "test_video.html", mimeType: "text/html", roomId: "room" }),
      onVideoWorkspaceMediaExport: exporter,
    });
    const exportSettings = { resolution: "720p", quality: "custom", videoBitrateKbps: 4500, audioBitrateKbps: 320 };
    const request = { type: "nautilo.app.media.req", requestId: "export-owned", op: "exportVideo", sha256: "a".repeat(64), revision: 3, publishToWorkspace: true, exportSettings };
    send(request);
    await waitUntil(() => exporter.mock.calls.length === 1);
    expect(Object.keys(exportInput!).sort()).toEqual(["exportSettings", "onProgress", "publishToWorkspace", "requestId", "revision", "sha256", "signal"]);
    expect(exportInput!.exportSettings).toEqual(exportSettings);
    expect(exportInput!.publishToWorkspace).toBe(true);
    exportInput!.onProgress({ stage: "rendering", processedTimeUs: 500_000 });
    expect(posted).toEqual([{ type: "nautilo.app.media.export-progress", requestId: request.requestId, progress: { stage: "rendering", processedTimeUs: 500_000 } }]);
    send(request); // Replays cannot strand an export behind an early response.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exporter).toHaveBeenCalledTimes(1);
    send({ type: "nautilo.app.media.cancel", requestId: request.requestId });
    await waitUntil(() => exportInput!.signal.aborted);
    expect(exportInput!.signal.aborted).toBe(true);
    exportInput!.onProgress({ stage: "saving" });
    expect(posted).toHaveLength(1);
    finish!({ kind: "cancelled" });
    await waitUntil(() => posted.length === 2);
    expect(posted[1]).toEqual({ type: "nautilo.app.res", requestId: request.requestId, ok: true, value: { kind: "cancelled" } });
    expect(JSON.stringify(posted)).not.toContain("private-row");

    send({ ...request, requestId: "export-unmounted" });
    await waitUntil(() => exporter.mock.calls.length === 2);
    teardown();
    expect(exportInput!.signal.aborted).toBe(true);
    finish!({ kind: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toHaveLength(2);
  });

  test("Current Folder refuses Workspace publication before starting native export", async () => {
    const iframe = document.createElement("iframe");
    const contentWindow = {} as Window; const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
    contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
    startMediaExportMock.mockClear();
    const teardown = installAppBridge({ iframe, appId: "nautilo-video", mediaProxy: true,
      target: fsOpenFileTarget("/folder/test.video.html", "/folder"),
    });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.media.req", requestId: "no-workspace-publication", op: "exportVideo", sha256: "a".repeat(64), revision: 3, publishToWorkspace: true }, source: contentWindow as unknown as MessageEventSource }));
    await waitUntil(() => posted.length === 1);
    expect(posted[0]).toEqual({ type: "nautilo.app.res", requestId: "no-workspace-publication", ok: true, value: { kind: "unavailable", code: "workspace_publication_unsupported" } });
    expect(startMediaExportMock).not.toHaveBeenCalled();
    teardown();
  });

  test("export capabilities advertise Workspace only for the authorized bound Workspace Video", async () => {
    for (const workspace of [false, true]) {
      const iframe = document.createElement("iframe"); const posted: unknown[] = [];
      const contentWindow = { postMessage: (data: unknown) => posted.push(data) } as unknown as Window;
      Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
      const teardown = installAppBridge({ iframe, appId: "nautilo-video", mediaProxy: true,
        target: workspace ? artifactOpenFileTarget({ id: "row", path: "test_video.html", mimeType: "text/html", roomId: "room" }) : fsOpenFileTarget("/folder/video.html", "/folder"),
        onVideoWorkspaceMediaExport: async () => ({ kind: "cancelled" }),
      });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.media.req", requestId: "capabilities", op: "exportCapabilities" }, source: contentWindow as unknown as MessageEventSource }));
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toEqual({ type: "nautilo.app.res", requestId: "capabilities", ok: true, value: { workspace } });
      teardown();
    }
  });

  test("Workspace export preserves the actionable document_changed result", async () => {
    const iframe = document.createElement("iframe");
    const contentWindow = {} as Window; const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
    contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
    const teardown = installAppBridge({
      iframe,
      appId: "nautilo-video",
      mediaProxy: true,
      target: artifactOpenFileTarget({ id: "private-row", path: "test_video.html", mimeType: "text/html", roomId: "room" }),
      onVideoWorkspaceMediaExport: async () => ({ kind: "unavailable", code: "document_changed" }),
    });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.media.req", requestId: "changed", op: "exportVideo", sha256: "a".repeat(64), revision: 3 }, source: contentWindow as unknown as MessageEventSource }));
    await waitUntil(() => posted.length === 1);
    expect(posted[0]).toEqual({ type: "nautilo.app.res", requestId: "changed", ok: true, value: { kind: "unavailable", code: "document_changed" } });
    teardown();
  });

  test("Workspace export relays each valid success receipt and refuses malformed publication claims", async () => {
    const saved = { kind: "succeeded" as const, label: "cut.mp4", sizeBytes: 123, warnings: [] };
    const workspace = { status: "published" as const, path: "exports/cut.mp4", artifactId: "10000000-0000-4000-8000-000000000003" };
    const cases = [
      { value: saved, valid: true },
      { value: { ...saved, workspace }, valid: true },
      { value: { ...saved, workspace: { status: "not_published", path: workspace.path } }, valid: true },
      { value: { ...saved, workspace: { status: "unknown", path: workspace.path } }, valid: true },
      { value: { ...saved, workspace: { status: "published", path: workspace.path } }, valid: false },
      { value: { ...saved, workspace: { ...workspace, status: "unknown" } }, valid: false },
      { value: { ...saved, workspace: { ...workspace, path: "../private" } }, valid: false },
      { value: { ...saved, label: "multiline\nfilename.mp4" }, valid: true },
      { value: { ...saved, label: "" }, valid: false },
    ];
    for (const { value, valid } of cases) {
      const iframe = document.createElement("iframe"); const posted: unknown[] = [];
      const contentWindow = { postMessage: (data: unknown) => posted.push(data) } as unknown as Window;
      Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
      const teardown = installAppBridge({ iframe, appId: "nautilo-video", mediaProxy: true,
        target: artifactOpenFileTarget({ id: "private-row", path: "test_video.html", mimeType: "text/html", roomId: "room" }),
        onVideoWorkspaceMediaExport: async () => value as import("../../src/apps/app-bridge").VideoWorkspaceMediaExportResult,
      });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.media.req", requestId: "receipt", op: "exportVideo", sha256: "a".repeat(64), revision: 3 }, source: contentWindow as unknown as MessageEventSource }));
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toEqual({ type: "nautilo.app.res", requestId: "receipt", ok: true, value: valid ? value : { kind: "unavailable", code: "unavailable" } });
      teardown();
    }
  });

  test("Workspace export requires the server media grant and exact Video runtime", async () => {
    for (const options of [{ appId: "nautilo-video" }, { appId: "other-app", mediaProxy: true as const }]) {
      const iframe = document.createElement("iframe");
      const contentWindow = {} as Window; const posted: unknown[] = [];
      Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
      contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
      const exporter = mock(async () => ({ kind: "cancelled" as const }));
      const teardown = installAppBridge({ iframe, ...options, target: artifactTarget, onVideoWorkspaceMediaExport: exporter });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.media.req", requestId: "no-grant", op: "exportVideo", sha256: "a".repeat(64), revision: 3 }, source: contentWindow as unknown as MessageEventSource }));
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toMatchObject({ value: { kind: "unavailable", code: "unsupported_environment" } });
      expect(exporter).not.toHaveBeenCalled();
      teardown();
    }
  });

  test("unified picker admits canonical Video audio references, gates references, and rejects cross-purpose results", async () => {
    for (const scenario of ["valid", "audio-reference", "ungranted", "invalid-document", "cross-purpose", "single-overflow"] as const) {
      getBytesMock.mockImplementationOnce(async () => new Blob([scenario === "invalid-document" ? "<p>Other HTML</p>" : createEmptyVideoHtml()], { type: "text/html" }));
      const iframe = document.createElement("iframe");
      const contentWindow = {} as Window; const posted: unknown[] = [];
      Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
      contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
      const image = { kind: "ready", mediaKind: "image", label: "Image", mediaRef: "media/image.png", source: { kind: "workspace-artifact", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "media/image.png" } };
      const audio = { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc54", path: "references/voice.wav", label: "Voice guide", mediaKind: "audio", mimeType: "audio/wav", sizeBytes: 2048 };
      const result = { kind: "ready", imports: scenario === "single-overflow" ? [image, image] : [], references: scenario === "audio-reference" ? [audio] : [], mediaIds: scenario === "cross-purpose" ? ["media_wrong"] : [], failures: [] };
      const picker = mock(async () => result as never);
      const teardown = installAppBridge({ iframe, appId: "nautilo-video", mediaProxy: true, videoGeneration: scenario === "audio-reference",
        target: artifactOpenFileTarget({ id: "row", path: "project.video.html", mimeType: "text/html", roomId: "room" }), onVideoMediaPick: picker });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.media.req", requestId: scenario, op: "pick", purpose: scenario === "ungranted" || scenario === "audio-reference" ? "references" : "media", multiple: scenario !== "single-overflow" }, source: contentWindow as unknown as MessageEventSource }));
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toMatchObject({ ok: true, value: scenario === "valid" || scenario === "audio-reference" ? result : { kind: "unavailable", code: scenario === "ungranted" ? "unsupported_environment" : scenario === "invalid-document" ? "invalid_document" : "invalid_response" } });
      if (scenario === "invalid-document" || scenario === "ungranted") expect(picker).not.toHaveBeenCalled();
      teardown();
      // The denied grant does not consume the document read stub.
      if (scenario === "ungranted") getBytesMock.mockReset();
    }
  });

  test("ordinary Workspace media import needs neither a generation session nor a filename suffix", async () => {
    for (const [mediaKind, metadata] of [
      ["audio", { durationSec: 3 }],
      ["image", {}],
    ] as const) {
      getBytesMock.mockImplementationOnce(async () => new Blob([createEmptyVideoHtml()], { type: "text/html" }));
      const iframe = document.createElement("iframe");
      const contentWindow = {} as Window; const posted: unknown[] = [];
      Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
      contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
      const mediaRef = "video-imports/source";
      const result = { kind: "ready" as const, mediaKind, ...metadata, label: "Source", mediaRef,
        source: { kind: "workspace-artifact" as const, artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: mediaRef } };
      const teardown = installAppBridge({ iframe, appId: "nautilo-video", mediaProxy: true,
        target: artifactOpenFileTarget({ id: "row", path: "test_video.html", mimeType: "text/html", roomId: "room" }),
        onVideoWorkspaceMediaImport: async () => result as never,
      });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.media.req", requestId: mediaKind, op: "importVideo" }, source: contentWindow as unknown as MessageEventSource }));
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toMatchObject({ ok: true, value: result });
      teardown();
    }
  });

  test("arbitrary HTML cannot gain import authority by opening in Video", async () => {
    getBytesMock.mockImplementationOnce(async () => new Blob(["<p>ordinary HTML</p>"], { type: "text/html" }));
    const iframe = document.createElement("iframe");
    const contentWindow = {} as Window; const posted: unknown[] = [];
    Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
    contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
    const importer = mock(async () => ({ kind: "unavailable" as const, code: "cancelled" }));
    const teardown = installAppBridge({ iframe, appId: "nautilo-video", mediaProxy: true,
      target: artifactOpenFileTarget({ id: "row", path: "fake.video.html", mimeType: "text/html", roomId: "room" }),
      onVideoWorkspaceMediaImport: importer,
    });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.media.req", requestId: "invalid", op: "importVideo" }, source: contentWindow as unknown as MessageEventSource }));
    await waitUntil(() => posted.length === 1);
    expect(posted[0]).toMatchObject({ ok: true, value: { kind: "unavailable", code: "invalid_document" } });
    expect(importer).not.toHaveBeenCalled(); teardown();
  });

  test("preferences are app-key scoped, viewer-scoped, and target-independent", async () => {
    window.localStorage.clear();
    getArtifactStateMock.mockClear();
    setArtifactStateMock.mockClear();
    const makeIframe = () => {
      const iframe = document.createElement("iframe");
      const contentWindow = {} as Window;
      const posted: unknown[] = [];
      Object.defineProperty(iframe, "contentWindow", { value: contentWindow, configurable: true });
      contentWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof contentWindow.postMessage;
      return { iframe, contentWindow, posted };
    };
    const one = makeIframe();
    const teardown = installAppBridge({ iframe: one.iframe, appId: "nautilo-writer", viewerKey: "viewer-a", target: fsOpenFileTarget("/folder/draft.html", "/folder") });
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: one.contentWindow as unknown as MessageEventSource }));
    send({ type: "nautilo.app.preferences.subscribe", key: "writer.spellcheck" });
    send({ type: "nautilo.app.preferences.req", requestId: "set", op: "set", key: "writer.spellcheck", value: { enabled: false, language: "en-US", personalWords: ["Nautilo"] } });
    await waitUntil(() => one.posted.length >= 2);
    expect(one.posted).toContainEqual(expect.objectContaining({ type: "nautilo.app.preferences.changed", key: "writer.spellcheck", value: { enabled: false, language: "en-US", personalWords: ["nautilo"] } }));
    expect(one.posted).toContainEqual(expect.objectContaining({ type: "nautilo.app.res", requestId: "set", ok: true }));
    expect(getArtifactStateMock).not.toHaveBeenCalled();
    expect(setArtifactStateMock).not.toHaveBeenCalled();
    teardown();

    const two = makeIframe();
    const other = installAppBridge({ iframe: two.iframe, appId: "nautilo-writer", viewerKey: "viewer-b" });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.preferences.req", requestId: "get", op: "get", key: "writer.spellcheck" }, source: two.contentWindow as unknown as MessageEventSource }));
    await waitUntil(() => two.posted.length === 1);
    expect(two.posted[0]).toMatchObject({ type: "nautilo.app.res", requestId: "get", value: { enabled: true, language: "en-US", personalWords: [] } });
    other();

    const anonymous = makeIframe();
    const anonTeardown = installAppBridge({ iframe: anonymous.iframe, appId: "nautilo-writer", viewerKey: null });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.preferences.req", requestId: "anon-set", op: "set", key: "writer.spellcheck", value: { enabled: false, language: "en-US", personalWords: [] } }, source: anonymous.contentWindow as unknown as MessageEventSource }));
    await waitUntil(() => anonymous.posted.length === 1);
    expect(anonymous.posted[0]).toMatchObject({ type: "nautilo.app.res", requestId: "anon-set", value: { enabled: true, language: "en-US", personalWords: [] } });
    anonTeardown();

    const blocked = makeIframe();
    const blockedTeardown = installAppBridge({ iframe: blocked.iframe, appId: "sample-app", viewerKey: "viewer-a" });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "nautilo.app.preferences.req", requestId: "blocked", op: "get", key: "writer.spellcheck" }, source: blocked.contentWindow as unknown as MessageEventSource }));
    await waitUntil(() => blocked.posted.length === 1);
    expect(blocked.posted[0]).toMatchObject({ type: "nautilo.app.res", requestId: "blocked", ok: false });
    blockedTeardown();

    const video = makeIframe();
    const videoTeardown = installAppBridge({
      iframe: video.iframe,
      appId: "nautilo-video",
      viewerKey: "viewer-a",
    });
    const sendVideo = (data: unknown) => window.dispatchEvent(new MessageEvent("message", {
      data,
      source: video.contentWindow as unknown as MessageEventSource,
    }));
    sendVideo({ type: "nautilo.app.preferences.subscribe", key: "video.agentReceipts" });
    sendVideo({
      type: "nautilo.app.preferences.req",
      requestId: "video-set",
      op: "set",
      key: "video.agentReceipts",
      value: { enabled: false },
    });
    await waitUntil(() => video.posted.length >= 2);
    expect(video.posted).toContainEqual(expect.objectContaining({
      type: "nautilo.app.preferences.changed",
      key: "video.agentReceipts",
      value: { enabled: false },
    }));
    expect(video.posted).toContainEqual(expect.objectContaining({
      type: "nautilo.app.res",
      requestId: "video-set",
      ok: true,
      value: { enabled: false },
    }));

    sendVideo({
      type: "nautilo.app.preferences.req",
      requestId: "video-read",
      op: "get",
      key: "video.agentReceipts",
    });
    await waitUntil(() => video.posted.length >= 3);
    expect(video.posted).toContainEqual(expect.objectContaining({
      type: "nautilo.app.res",
      requestId: "video-read",
      ok: true,
      value: { enabled: false },
    }));

    sendVideo({
      type: "nautilo.app.preferences.req",
      requestId: "video-cross-app",
      op: "get",
      key: "writer.spellcheck",
    });
    await waitUntil(() => video.posted.length >= 4);
    expect(video.posted).toContainEqual(expect.objectContaining({
      type: "nautilo.app.res",
      requestId: "video-cross-app",
      ok: false,
    }));
    videoTeardown();
  });

  describe("draft / warm-up", () => {
    const draft = {
      appId: "sample-app",
      createActionId: "create-document",
      suggestedName: "Untitled document.html",
      roomId: "room-7",
    };

    afterEach(() => {
      getArtifactMock.mockReset();
      getArtifactMock.mockResolvedValue({ id: "art-internal-1", revision: 3, path: "budget.document.json" });
      getBytesMock.mockReset();
      getBytesMock.mockResolvedValue(new Blob(['{"sheets":[]}'], { type: "application/vnd.nautilo.document+json" }));
      getMiniAppCreateTemplateMock.mockReset();
      getMiniAppCreateTemplateMock.mockResolvedValue({ content: '{"sheets":[]}', mimeType: "application/vnd.nautilo.document+json" });
    });

    function createDraftBridgeHarness() {
      const iframe = document.createElement("iframe");
      const iframeWindow = {} as Window;
      Object.defineProperty(iframe, "contentWindow", {
        value: iframeWindow,
        configurable: true,
      });

      const posted: unknown[] = [];
      iframeWindow.postMessage = ((data: unknown) => {
        posted.push(data);
      }) as typeof iframeWindow.postMessage;

      return { iframe, iframeWindow, posted };
    }

    const sendDraftRequest = (
      iframeWindow: Window,
      data: Record<string, unknown>,
    ): void => {
      window.dispatchEvent(new MessageEvent("message", {
        data,
        source: iframeWindow as unknown as MessageEventSource,
      }));
    };

    test("Slides edit launch materializes and reads canonical bytes before exposing the document or recovery", async () => {
      getMiniAppCreateTemplateMock.mockClear();
      getMiniAppCreateTemplateMock.mockResolvedValue({ content: '{"blank":true}', mimeType: "text/html" });
      getArtifactMock.mockClear();
      getArtifactMock.mockResolvedValue({ id: "slides-new", revision: 1, path: "Untitled.presentation.html", mimeType: "text/html" });
      getBytesMock.mockClear();
      getBytesMock.mockResolvedValue(new Blob(['{"blank":true}'], { type: "text/html" }));
      const target = artifactOpenFileTarget({ id: "slides-new", path: "Untitled.presentation.html", mimeType: "text/html", roomId: "room-7" });
      let created = false;
      const materialize = mock(async () => { created = true; return target; });
      const recoveryRead = mock(async () => ({ revision: null, draft: null }));
      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({ iframe, appId: "nautilo-presentation", mode: "edit", draft: { ...draft, appId: "nautilo-presentation" }, materialize, recovery: { read: recoveryRead, async write() { return { revision: "1" }; }, dispose() {} } });

      sendDraftRequest(iframeWindow, { type: "nautilo.app.document.req", requestId: "slides-read", op: "read" });
      await waitUntil(() => posted.length === 1);
      expect(created).toBe(true);
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(getArtifactMock).toHaveBeenCalledWith("slides-new", { roomId: "room-7" });
      expect(posted[0]).toMatchObject({ requestId: "slides-read", ok: true, value: { content: '{"blank":true}', baseRevision: 1 } });

      sendDraftRequest(iframeWindow, { type: "nautilo.app.recovery.req", requestId: "slides-recovery", op: "read" });
      await waitUntil(() => posted.length === 2);
      expect(recoveryRead).toHaveBeenCalledWith(target);
    });

    test("Board edit launch materializes and reads an exact canonical revision before recovery", async () => {
      getMiniAppCreateTemplateMock.mockResolvedValue({ content: '{"board":[]}', mimeType: "text/html" });
      getArtifactMock.mockClear();
      getArtifactMock.mockResolvedValue({ id: "board-new", revision: 7, path: "Untitled.board.html", mimeType: "text/html" });
      getBytesMock.mockClear();
      getBytesMock.mockResolvedValue(new Blob(['{"board":[]}'], { type: "text/html" }));
      const target = artifactOpenFileTarget({ id: "board-new", path: "Untitled.board.html", mimeType: "text/html", roomId: "room-7" });
      const materialize = mock(async () => target);
      const recoveryRead = mock(async () => ({ revision: null, draft: null }));
      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({ iframe, appId: "nautilo-board", mode: "edit", draft: { ...draft, appId: "nautilo-board" }, materialize, recovery: { read: recoveryRead, async write() { return { revision: "1" }; }, dispose() {} } });

      sendDraftRequest(iframeWindow, { type: "nautilo.app.document.req", requestId: "board-read", op: "read" });
      await waitUntil(() => posted.length === 1);
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(getArtifactMock).toHaveBeenCalledWith("board-new", { roomId: "room-7" });
      expect(posted[0]).toMatchObject({ requestId: "board-read", ok: true, value: { content: '{"board":[]}', baseRevision: 7 } });

      sendDraftRequest(iframeWindow, { type: "nautilo.app.recovery.req", requestId: "board-recovery", op: "read" });
      await waitUntil(() => posted.length === 2);
      expect(recoveryRead).toHaveBeenCalledWith(target);
    });

    test("simultaneous Slides reads share one materialization and canonical read", async () => {
      getMiniAppCreateTemplateMock.mockResolvedValue({ content: "blank", mimeType: "text/html" });
      getArtifactMock.mockClear();
      getArtifactMock.mockResolvedValue({ id: "slides-concurrent", revision: 1, path: "Untitled.presentation.html", mimeType: "text/html" });
      getBytesMock.mockClear();
      getBytesMock.mockResolvedValue(new Blob(["blank"], { type: "text/html" }));
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const target = artifactOpenFileTarget({ id: "slides-concurrent", path: "Untitled.presentation.html", mimeType: "text/html", roomId: "room-7" });
      const materialize = mock(async () => { await blocked; return target; });
      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({ iframe, appId: "nautilo-presentation", mode: "edit", draft: { ...draft, appId: "nautilo-presentation" }, materialize });

      sendDraftRequest(iframeWindow, { type: "nautilo.app.document.req", requestId: "slides-read-a", op: "read" });
      sendDraftRequest(iframeWindow, { type: "nautilo.app.document.req", requestId: "slides-read-b", op: "read" });
      await waitUntil(() => materialize.mock.calls.length === 1);
      release();
      await waitUntil(() => posted.length === 2);
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(getArtifactMock).toHaveBeenCalledTimes(1);
      expect(posted.every((value) => (value as { ok?: boolean }).ok === true)).toBe(true);
    });

    test("failed Slides creation exposes no editable blank and a later read retries", async () => {
      getMiniAppCreateTemplateMock.mockResolvedValue({ content: "blank", mimeType: "text/html" });
      getArtifactMock.mockResolvedValue({ id: "slides-retry", revision: 1, path: "Untitled.presentation.html", mimeType: "text/html" });
      getBytesMock.mockResolvedValue(new Blob(["blank"], { type: "text/html" }));
      const target = artifactOpenFileTarget({ id: "slides-retry", path: "Untitled.presentation.html", mimeType: "text/html", roomId: "room-7" });
      let attempts = 0;
      const materialize = mock(async () => { if (++attempts === 1) throw new Error("create unavailable"); return target; });
      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({ iframe, appId: "nautilo-presentation", mode: "edit", draft: { ...draft, appId: "nautilo-presentation" }, materialize });

      sendDraftRequest(iframeWindow, { type: "nautilo.app.document.req", requestId: "slides-failed", op: "read" });
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toMatchObject({ requestId: "slides-failed", ok: false, error: "create unavailable" });
      sendDraftRequest(iframeWindow, { type: "nautilo.app.document.req", requestId: "slides-retry", op: "read" });
      await waitUntil(() => posted.length === 2);
      expect(materialize).toHaveBeenCalledTimes(2);
      expect(posted[1]).toMatchObject({ requestId: "slides-retry", ok: true, value: { baseRevision: 1 } });
    });

    test("a canonical read failure after successful Slides creation retries the read without creating a duplicate", async () => {
      getMiniAppCreateTemplateMock.mockResolvedValue({ content: "blank", mimeType: "text/html" });
      const target = artifactOpenFileTarget({ id: "slides-created", path: "Untitled.presentation.html", mimeType: "text/html", roomId: "room-7" });
      const materialize = mock(async () => target);
      getArtifactMock.mockReset();
      getArtifactMock.mockRejectedValueOnce(new Error("read unavailable"));
      getArtifactMock.mockResolvedValue({ id: "slides-created", revision: 1, path: "Untitled.presentation.html", mimeType: "text/html" });
      getBytesMock.mockResolvedValue(new Blob(["blank"], { type: "text/html" }));
      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({ iframe, appId: "nautilo-presentation", mode: "edit", draft: { ...draft, appId: "nautilo-presentation" }, materialize });

      sendDraftRequest(iframeWindow, { type: "nautilo.app.document.req", requestId: "read-failed", op: "read" });
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toMatchObject({ requestId: "read-failed", ok: false, error: "read unavailable" });
      sendDraftRequest(iframeWindow, { type: "nautilo.app.document.req", requestId: "read-retry", op: "read", fresh: true });
      await waitUntil(() => posted.length === 2);
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(getArtifactMock).toHaveBeenCalledTimes(2);
      expect(posted[1]).toMatchObject({ requestId: "read-retry", ok: true, value: { baseRevision: 1 } });
    });

    test("Slides preview and other app drafts retain non-materializing reads", async () => {
      getMiniAppCreateTemplateMock.mockResolvedValue({ content: "blank", mimeType: "text/html" });
      const materialize = mock(async () => artifactTarget);
      const preview = createDraftBridgeHarness();
      installAppBridge({ iframe: preview.iframe, appId: "nautilo-presentation", mode: "preview", draft: { ...draft, appId: "nautilo-presentation" }, materialize });
      sendDraftRequest(preview.iframeWindow, { type: "nautilo.app.document.req", requestId: "preview-read", op: "read" });
      await waitUntil(() => preview.posted.length === 1);
      expect(preview.posted[0]).toMatchObject({ ok: true, value: { baseRevision: null } });

      const other = createDraftBridgeHarness();
      installAppBridge({ iframe: other.iframe, appId: "sample-app", mode: "edit", draft, materialize });
      sendDraftRequest(other.iframeWindow, { type: "nautilo.app.document.req", requestId: "other-read", op: "read" });
      await waitUntil(() => other.posted.length === 1);
      expect(other.posted[0]).toMatchObject({ ok: true, value: { baseRevision: null } });
      expect(materialize).not.toHaveBeenCalled();
    });

    test("read on an unbound draft returns template content with null base sha/revision", async () => {
      getMiniAppCreateTemplateMock.mockClear();
      getMiniAppCreateTemplateMock.mockResolvedValueOnce({
        content: '{"blank":true}',
        mimeType: "application/vnd.nautilo.document+json",
      });
      getArtifactMock.mockClear();
      getBytesMock.mockClear();

      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({ iframe, appId: "sample-app", draft });

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nautilo.app.document.req",
            requestId: "draft-read-1",
            op: "read",
          },
          source: iframeWindow as unknown as MessageEventSource,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getMiniAppCreateTemplateMock).toHaveBeenCalledWith("sample-app", "create-document");
      expect(getArtifactMock).not.toHaveBeenCalled();
      expect(getBytesMock).not.toHaveBeenCalled();
      expect(posted[0]).toMatchObject({
        type: "nautilo.app.res",
        requestId: "draft-read-1",
        ok: true,
        value: {
          content: '{"blank":true}',
          mimeType: "application/vnd.nautilo.document+json",
          path: "Untitled document.html",
          baseSha256: null,
          baseRevision: null,
        },
      });
    });

    test("write on an unbound draft materializes once without a second persistence write", async () => {
      getMiniAppCreateTemplateMock.mockClear();
      applyPatchMock.mockClear();
      saveArtifactMock.mockClear();
      getMiniAppCreateTemplateMock.mockResolvedValue({
        content: '{"seed":true}',
        mimeType: "application/vnd.nautilo.document+json",
      });

      const materializedTarget = artifactOpenFileTarget({
        id: "art-new-1",
        path: "Untitled document.html",
        mimeType: "application/vnd.nautilo.document+json",
        roomId: "room-7",
      });

      const materializeMock = mock(async (content: string, mimeType: string) => {
        expect(content).toBe("edited-body");
        expect(mimeType).toBe("application/vnd.nautilo.document+json");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return materializedTarget;
      });

      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({
        iframe,
        appId: "sample-app",
        draft,
        materialize: materializeMock,
      });

      const writePayload = {
        type: "nautilo.app.document.req",
        requestId: "",
        op: "write" as const,
        value: "edited-body",
        baseSha256: null,
        baseRevision: null,
      };

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { ...writePayload, requestId: "draft-write-1" },
          source: iframeWindow as unknown as MessageEventSource,
        }),
      );
      await waitUntil(() => posted.length >= 1 && materializeMock.mock.calls.length >= 1);

      expect(materializeMock).toHaveBeenCalledTimes(1);
      expect(applyPatchMock).not.toHaveBeenCalled();
      expect(saveArtifactMock).not.toHaveBeenCalled();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        type: "nautilo.app.res",
        requestId: "draft-write-1",
        ok: true,
        value: {
          kind: "saved",
          sha256: await sha256FromEditorIo("edited-body"),
          path: "Untitled document.html",
        },
      });
    });

    test("state get on an unbound draft returns undefined without artifact-state API", async () => {
      getArtifactStateMock.mockClear();

      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({ iframe, appId: "sample-app", draft });

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nautilo.app.state.req",
            requestId: "draft-state-1",
            op: "get",
            key: "view",
          },
          source: iframeWindow as unknown as MessageEventSource,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getArtifactStateMock).not.toHaveBeenCalled();
      expect(posted[0]).toMatchObject({
        type: "nautilo.app.res",
        requestId: "draft-state-1",
        ok: true,
        value: undefined,
      });
    });

    test("write with neither target nor materialize rejects with no bound document", async () => {
      const { iframe, iframeWindow, posted } = createDraftBridgeHarness();
      installAppBridge({ iframe, appId: "sample-app" });

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nautilo.app.document.req",
            requestId: "unbound-write-1",
            op: "write",
            value: "orphan",
          },
          source: iframeWindow as unknown as MessageEventSource,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(posted[0]).toMatchObject({
        type: "nautilo.app.res",
        requestId: "unbound-write-1",
        ok: false,
        error: "No document is bound to this app.",
      });
    });
  });

  test("rapid document writes coalesce to latest content while in flight", async () => {
    applyPatchMock.mockReset();
    applyPatchMock.mockImplementation(async () => ({
      kind: "applied" as const,
      sha256: "patch-sha256",
      revision: 5,
      patchId: "patch-1",
      requestId: "req-1",
      target: {
        kind: "artifact" as const,
        artifactInternalId: "art-internal-1",
        path: "budget.document.json",
      },
      author: { kind: "human" as const, displayName: "user" },
      patch: { kind: "anchored_text" as const, oldString: "x", newString: "y" },
      unifiedDiff: "",
      rebased: false,
    }));

    let resolveFirst: ((value: unknown) => void) | undefined;
    applyPatchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    applyPatchMock.mockImplementationOnce(async () => ({
      kind: "applied" as const,
      sha256: "patch-coalesced",
      revision: 7,
      patchId: "patch-coalesced",
      requestId: "req-coalesced",
      target: {
        kind: "artifact" as const,
        artifactInternalId: "art-internal-1",
        path: "budget.document.json",
      },
      author: { kind: "human" as const, displayName: "user" },
      patch: { kind: "anchored_text" as const, oldString: "x", newString: "y" },
      unifiedDiff: "",
      rebased: false,
    }));

    getArtifactMock.mockClear();
    getBytesMock.mockClear();

    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", {
      value: iframeWindow,
      configurable: true,
    });

    const posted: unknown[] = [];
    iframeWindow.postMessage = ((data: unknown) => {
      posted.push(data);
    }) as typeof iframeWindow.postMessage;

    installAppBridge({
      iframe,
      appId: "sample-app",
      target: artifactTarget,
    });

    const baseContent = '{"sheets":[]}';
    const sessionEnvelope = {
      content: baseContent,
      mimeType: "application/vnd.nautilo.document+json",
      path: "budget.document.json",
      baseSha256: await sha256FromEditorIo(baseContent),
      baseRevision: 3,
    };

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "nautilo.app.document.req",
          requestId: "read-coalesce",
          op: "read",
        },
        source: iframeWindow as unknown as MessageEventSource,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sendWrite = (requestId: string, value: string) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nautilo.app.document.req",
            requestId,
            op: "write",
            value,
            baseSha256: sessionEnvelope.baseSha256,
            baseRevision: sessionEnvelope.baseRevision,
          },
          source: iframeWindow as unknown as MessageEventSource,
        }),
      );
    };

    sendWrite("write-1", '{"sheets":[1]}');
    sendWrite("write-2", '{"sheets":[2]}');
    sendWrite("write-3", '{"sheets":[3]}');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applyPatchMock).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      kind: "applied",
      sha256: "patch-first",
      revision: 6,
      patchId: "patch-first",
      requestId: "req-first",
      target: {
        kind: "artifact",
        artifactInternalId: "art-internal-1",
        path: "budget.document.json",
      },
      author: { kind: "human", displayName: "user" },
      patch: deriveAnchoredTextPatch(baseContent, '{"sheets":[1]}'),
      unifiedDiff: "",
      rebased: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(applyPatchMock).toHaveBeenCalledTimes(2);
    const secondBody = applyPatchMock.mock.calls[1]?.[1] as { patch: { newString: string } };
    expect(secondBody.patch.newString).toContain("[3]");

    const responseFor = (requestId: string) =>
      posted.find(
        (msg) =>
          typeof msg === "object" &&
          msg !== null &&
          (msg as { requestId?: string }).requestId === requestId,
      );

    expect(responseFor("write-1")).toMatchObject({
      ok: true,
      value: { kind: "saved", sha256: "patch-first", revision: 6 },
    });
    expect(responseFor("write-2")).toMatchObject({
      ok: true,
      value: { kind: "saved", sha256: "patch-coalesced", revision: 7 },
    });
    expect(responseFor("write-3")).toMatchObject({
      ok: true,
      value: { kind: "saved", sha256: "patch-coalesced", revision: 7 },
    });
  });

  describe("session.acceptProposal", () => {
    const fsTarget = fsOpenFileTarget("/repo/notes.html", "/repo");
    const localSha = { kind: "local_sha" as const, sha256: "a".repeat(64) };
    const secretAcceptedContent = "<html><body>secret accepted bytes</body></html>";

    beforeEach(() => {
      clearPendingAcceptMutationsForTests();
    });

    function createAcceptBridgeHarness() {
      const iframe = document.createElement("iframe");
      const iframeWindow = {} as Window;
      Object.defineProperty(iframe, "contentWindow", {
        value: iframeWindow,
        configurable: true,
      });
      const posted: unknown[] = [];
      iframeWindow.postMessage = ((data: unknown) => {
        posted.push(data);
      }) as typeof iframeWindow.postMessage;
      return { iframe, iframeWindow, posted };
    }

    function dispatchAcceptProposal(
      iframeWindow: Window,
      requestId: string,
      overrides: Record<string, unknown> = {},
    ): void {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nautilo.app.session.req",
            requestId,
            op: "acceptProposal",
            proposalId: "proposal-1",
            documentVersion: localSha,
            acceptedOperationIndexes: [0],
            acceptedContent: secretAcceptedContent,
            ...overrides,
          },
          source: iframeWindow as unknown as MessageEventSource,
        }),
      );
    }

    test("forwards a visible-review acknowledgement only from the bound iframe", () => {
      const { iframe, iframeWindow } = createAcceptBridgeHarness();
      const onLiveProposalAcknowledged = mock((_acknowledgement: unknown) => {});
      installAppBridge({
        iframe,
        appId: "nautilo-writer",
        target: fsTarget,
        onLiveProposalAcknowledged,
      });

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nautilo.app.live-proposal.ack",
            proposalId: "proposal-1",
            documentVersion: localSha,
          },
          source: {} as MessageEventSource,
        }),
      );
      expect(onLiveProposalAcknowledged).not.toHaveBeenCalled();

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "nautilo.app.live-proposal.ack",
            proposalId: "proposal-1",
            documentVersion: localSha,
          },
          source: iframeWindow as unknown as MessageEventSource,
        }),
      );
      expect(onLiveProposalAcknowledged).toHaveBeenCalledWith({
        proposalId: "proposal-1",
        documentVersion: localSha,
      });
    });

    test("maps API acceptance_conflict to structured bridge failure without leaking content", async () => {
      applyAcceptedLiveProposalMock.mockImplementationOnce(async () => {
        const err = Object.assign(new Error("acceptance_conflict"), {
          name: "LiveProposalAcceptanceError",
          status: 409,
          code: "acceptance_conflict",
        });
        throw err;
      });

      const { iframe, iframeWindow, posted } = createAcceptBridgeHarness();
      installAppBridge({
        iframe,
        appId: "nautilo-writer",
        target: fsTarget,
        getLiveSession: () => ({
          sessionToken: "opaque-session-token",
          sessionId: "route-only",
          documentVersion: localSha,
        }),
      });

      dispatchAcceptProposal(iframeWindow, "accept-conflict-1");
      await waitUntil(() => posted.length >= 1);

      expect(posted[0]).toEqual({
        type: "nautilo.app.res",
        requestId: "accept-conflict-1",
        ok: false,
        code: "acceptance_conflict",
        message: "acceptance_conflict",
        status: 409,
      });
      const serialized = JSON.stringify(posted[0]);
      expect(serialized).not.toContain(secretAcceptedContent);
      expect(serialized).not.toContain("opaque-session-token");
      expect(serialized).not.toContain("/repo/");
    });

    test("returns wrapped success result unchanged for valid acceptance", async () => {
      applyAcceptedLiveProposalMock.mockImplementationOnce(async () => ({
        documentVersion: { kind: "local_sha", sha256: "b".repeat(64) },
        contentSha256: "b".repeat(64),
        localRevisionRef: "local:relay:abc",
      }));

      const documentSession = {
        envelope: {
          content: "old canonical bytes",
          mimeType: "",
          path: "notes.html",
          baseSha256: localSha.sha256,
          baseRevision: null,
        },
      };
      const onLiveProposalAccepted = mock((_result: unknown) => {
        expect(documentSession.envelope).toEqual({
          content: secretAcceptedContent,
          mimeType: "",
          path: "notes.html",
          baseSha256: "b".repeat(64),
          baseRevision: null,
        });
      });
      const { iframe, iframeWindow, posted } = createAcceptBridgeHarness();
      installAppBridge({
        iframe,
        appId: "nautilo-writer",
        target: fsTarget,
        documentSession,
        getLiveSession: () => ({
          sessionToken: "opaque-session-token",
          sessionId: "route-only",
          documentVersion: localSha,
        }),
        onLiveProposalAccepted,
      });

      dispatchAcceptProposal(iframeWindow, "accept-success-1");
      await waitUntil(() => posted.length >= 1);

      expect(posted[0]).toEqual({
        type: "nautilo.app.res",
        requestId: "accept-success-1",
        ok: true,
        value: {
          ok: true,
          documentVersion: { kind: "local_sha", sha256: "b".repeat(64) },
          contentSha256: "b".repeat(64),
          localRevisionRef: "local:relay:abc",
        },
      });
      expect(onLiveProposalAccepted).toHaveBeenCalledTimes(1);
      const processAsExternal = mock((_event: unknown) => {});
      expect(
        observePendingAcceptMutationEvent(
          "accept-success-1",
          {
            rootPath: "/repo",
            path: "/repo",
            changedPath: fsTarget.path,
            clientMutationId: "accept-success-1",
          },
          processAsExternal,
        ),
      ).toBe("confirmed_success");
      expect(processAsExternal).not.toHaveBeenCalled();
      expect(JSON.stringify(posted[0])).not.toContain("opaque-session-token");
    });

    test("suppresses an accepted watcher event that arrives before the response", async () => {
      let resolveAcceptance:
        | ((value: {
            documentVersion: { kind: "local_sha"; sha256: string };
            localRevisionRef: string;
          }) => void)
        | undefined;
      applyAcceptedLiveProposalMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAcceptance = resolve;
          }),
      );

      const callsBefore = applyAcceptedLiveProposalMock.mock.calls.length;
      const { iframe, iframeWindow, posted } = createAcceptBridgeHarness();
      installAppBridge({
        iframe,
        appId: "nautilo-writer",
        target: fsTarget,
        getLiveSession: () => ({
          sessionToken: "opaque-session-token",
          sessionId: "route-only",
          documentVersion: localSha,
        }),
      });

      dispatchAcceptProposal(iframeWindow, "accept-event-first");
      await waitUntil(() => applyAcceptedLiveProposalMock.mock.calls.length > callsBefore);
      const processAsExternal = mock((_event: unknown) => {});
      const event = {
        rootPath: "/repo",
        path: "/repo",
        changedPath: fsTarget.path,
        clientMutationId: "accept-event-first",
      };
      expect(
        observePendingAcceptMutationEvent(
          "accept-event-first",
          event,
          processAsExternal,
        ),
      ).toBe("deferred");

      resolveAcceptance?.({
        documentVersion: { kind: "local_sha", sha256: "c".repeat(64) },
        localRevisionRef: "local:relay:event-first",
      });
      await waitUntil(() => posted.length >= 1);

      expect(posted[0]).toMatchObject({ requestId: "accept-event-first", ok: true });
      expect(processAsExternal).not.toHaveBeenCalled();
      expect(
        observePendingAcceptMutationEvent(
          "accept-event-first",
          event,
          processAsExternal,
        ),
      ).toBe("confirmed_success");
    });

    test("replays an event-first watcher change when acceptance fails", async () => {
      let rejectAcceptance: ((reason?: unknown) => void) | undefined;
      applyAcceptedLiveProposalMock.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectAcceptance = reject;
          }),
      );

      const callsBefore = applyAcceptedLiveProposalMock.mock.calls.length;
      const { iframe, iframeWindow, posted } = createAcceptBridgeHarness();
      installAppBridge({
        iframe,
        appId: "nautilo-writer",
        target: fsTarget,
        getLiveSession: () => ({
          sessionToken: "opaque-session-token",
          sessionId: "route-only",
          documentVersion: localSha,
        }),
      });

      dispatchAcceptProposal(iframeWindow, "accept-event-failure");
      await waitUntil(() => applyAcceptedLiveProposalMock.mock.calls.length > callsBefore);
      const processAsExternal = mock((_event: unknown) => {});
      const event = {
        rootPath: "/repo",
        path: "/repo",
        changedPath: fsTarget.path,
        clientMutationId: "accept-event-failure",
        sha256: "d".repeat(64),
      };
      expect(
        observePendingAcceptMutationEvent(
          "accept-event-failure",
          event,
          processAsExternal,
        ),
      ).toBe("deferred");

      rejectAcceptance?.(new Error("relay response unknown"));
      await waitUntil(() => posted.length >= 1);

      expect(posted[0]).toMatchObject({ requestId: "accept-event-failure", ok: false });
      expect(processAsExternal).toHaveBeenCalledWith(event);
    });

    test("summarizes malformed acceptance messages without logging accepted content", async () => {
      const originalConsoleError = console.error;
      const consoleErrorMock = mock((..._args: unknown[]) => {});
      console.error = consoleErrorMock as typeof console.error;
      try {
        const { iframe, iframeWindow, posted } = createAcceptBridgeHarness();
        installAppBridge({
          iframe,
          appId: "nautilo-writer",
          target: fsTarget,
        });

        dispatchAcceptProposal(iframeWindow, "accept-malformed", { proposalId: "" });
        await waitUntil(() => posted.length >= 1);

        expect(JSON.stringify(consoleErrorMock.mock.calls)).not.toContain(secretAcceptedContent);
        expect(JSON.stringify(consoleErrorMock.mock.calls)).toContain("[redacted:");
      } finally {
        console.error = originalConsoleError;
      }
    });

    test("bounds and expires accepted-write suppression entries", () => {
      const originalDateNow = Date.now;
      let now = 1_000;
      Date.now = () => now;
      try {
        const expiredEvent = {
          rootPath: "/repo",
          path: "/repo",
          changedPath: fsTarget.path,
          clientMutationId: "expired-accept",
        };
        const processExpiredAsExternal = mock((_event: unknown) => {});
        registerPendingAcceptMutation("expired-accept");
        expect(
          observePendingAcceptMutationEvent(
            "expired-accept",
            expiredEvent,
            processExpiredAsExternal,
          ),
        ).toBe("deferred");
        now += 60_001;
        registerPendingAcceptMutation("expiry-sweep");
        expect(processExpiredAsExternal).toHaveBeenCalledWith(expiredEvent);

        clearPendingAcceptMutationsForTests();
        const processEvictedAsExternal = mock((_event: unknown) => {});
        registerPendingAcceptMutation("bounded-accept-0");
        observePendingAcceptMutationEvent(
          "bounded-accept-0",
          {
            rootPath: "/repo",
            path: "/repo",
            changedPath: fsTarget.path,
            clientMutationId: "bounded-accept-0",
          },
          processEvictedAsExternal,
        );
        for (let index = 1; index <= 256; index += 1) {
          registerPendingAcceptMutation(`bounded-accept-${index}`);
        }
        expect(processEvictedAsExternal).toHaveBeenCalledTimes(1);
        expect(
          observePendingAcceptMutationEvent(
            "bounded-accept-0",
            { rootPath: "/repo", path: "/repo" },
            processEvictedAsExternal,
          ),
        ).toBe("untracked");
        expect(
          observePendingAcceptMutationEvent(
            "bounded-accept-256",
            { rootPath: "/repo", path: "/repo" },
            processEvictedAsExternal,
          ),
        ).toBe("deferred");
      } finally {
        clearPendingAcceptMutationsForTests();
        Date.now = originalDateNow;
      }
    });

    test("mapAcceptProposalBridgeFailure falls back safely for unknown API codes", () => {
      const mapped = mapAcceptProposalBridgeFailure(
        Object.assign(new Error("unexpected"), {
          name: "LiveProposalAcceptanceError",
          status: 503,
          code: "totally_unknown_code",
        }),
      );
      expect(mapped).toEqual({
        ok: false,
        code: "invalid_request",
        message: "invalid_request",
        status: 503,
      });
    });
  });

  describe("session.resolveProposal", () => {
    function dispatchResolution(
      iframeWindow: Window,
      requestId: string,
      body: Record<string, unknown>,
    ): void {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: "nautilo.app.session.req",
          requestId,
          op: "resolveProposal",
          proposalId: "proposal-1",
          ...body,
        },
        source: iframeWindow as unknown as MessageEventSource,
      }));
    }

    test("reports acceptance only after the artifact revision advanced", async () => {
      const iframe = document.createElement("iframe");
      const iframeWindow = {} as Window;
      Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
      const posted: unknown[] = [];
      iframeWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof iframeWindow.postMessage;
      const documentSession = {
        envelope: {
          content: "persisted",
          mimeType: "text/html",
          path: "notes.html",
          baseSha256: "next-sha",
          baseRevision: 4,
        },
      };
      installAppBridge({
        iframe,
        appId: "nautilo-writer",
        target: artifactOpenFileTarget({ id: "artifact-1", path: "notes.html", mimeType: "text/html" }),
        documentSession,
        getLiveSession: () => ({
          sessionToken: "opaque-session-token",
          sessionId: "route-only",
          documentVersion: { kind: "artifact_revision", revision: 4 },
        }),
      });
      const callsBefore = resolveLiveProposalReviewMock.mock.calls.length;
      dispatchResolution(iframeWindow, "resolve-accepted", {
        documentVersion: { kind: "artifact_revision", revision: 3 },
        outcome: "accepted",
      });
      await waitUntil(() => resolveLiveProposalReviewMock.mock.calls.length > callsBefore);
      expect(resolveLiveProposalReviewMock.mock.calls.at(-1)).toEqual([
        "nautilo-writer",
        {
          sessionToken: "opaque-session-token",
          proposalId: "proposal-1",
          documentVersion: { kind: "artifact_revision", revision: 3 },
          outcome: "accepted",
          resultDocumentVersion: { kind: "artifact_revision", revision: 4 },
        },
      ]);
      await waitUntil(() => posted.length > 0);
      expect(posted.at(-1)).toMatchObject({
        requestId: "resolve-accepted",
        ok: true,
        value: { ok: true, taskStatus: "completed" },
      });
    });

    test("rejects a false acceptance when the document did not advance", async () => {
      const iframe = document.createElement("iframe");
      const iframeWindow = {} as Window;
      Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
      const posted: unknown[] = [];
      iframeWindow.postMessage = ((data: unknown) => posted.push(data)) as typeof iframeWindow.postMessage;
      installAppBridge({
        iframe,
        appId: "nautilo-writer",
        target: artifactOpenFileTarget({ id: "artifact-1", path: "notes.html", mimeType: "text/html" }),
        documentSession: {
          envelope: {
            content: "unchanged",
            mimeType: "text/html",
            path: "notes.html",
            baseSha256: "same-sha",
            baseRevision: 3,
          },
        },
        getLiveSession: () => ({
          sessionToken: "opaque-session-token",
          sessionId: "route-only",
          documentVersion: { kind: "artifact_revision", revision: 3 },
        }),
      });
      dispatchResolution(iframeWindow, "resolve-false-accept", {
        documentVersion: { kind: "artifact_revision", revision: 3 },
        outcome: "accepted",
      });
      await waitUntil(() => posted.length > 0);
      expect(posted.at(-1)).toMatchObject({
        requestId: "resolve-false-accept",
        ok: false,
        status: 409,
      });
    });
  });
});

describe("structured editor bridge recovery", () => {
  const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  const priorGlobals: Record<string, unknown> = {};

  beforeAll(() => {
    for (const key of [
      "window",
      "document",
      "HTMLElement",
      "HTMLIFrameElement",
      "MessageEvent",
      "CustomEvent",
    ] as const) {
      priorGlobals[key] = globalThis[key as keyof typeof globalThis];
      Object.defineProperty(globalThis, key, {
        value: happyWindow[key as keyof Window],
        configurable: true,
        writable: true,
      });
    }
  });

  afterAll(() => {
    happyWindow.close();
    for (const [key, value] of Object.entries(priorGlobals)) {
      if (value === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, {
          value,
          configurable: true,
          writable: true,
        });
      }
    }
  });


  test("strict saves retain the caller revision through storage CAS despite a newer host cache", async () => {
    saveArtifactMock.mockClear();
    applyPatchMock.mockClear();
    await writeBoundDocument(artifactTarget, "local snapshot", {
      baseSha256: "caller-base", baseRevision: 3, conflictPolicy: "strict",
      session: { envelope: { content: "new remote snapshot", mimeType: "text/html", path: artifactTarget.path, baseSha256: "remote-base", baseRevision: 4 } },
    });
    expect(applyPatchMock).not.toHaveBeenCalled();
    expect(saveArtifactMock).toHaveBeenCalledTimes(1);
    expect(saveArtifactMock.mock.calls[0]).toEqual([
      artifactTarget.id, "local snapshot", expect.objectContaining({ baseSha256: "caller-base", baseRevision: 3 }),
    ]);
  });
  test("strict saves without an exact revision fail before writing", async () => {
    saveArtifactMock.mockClear();
    expect(await writeBoundDocument(artifactTarget, "local", { conflictPolicy: "strict" })).toMatchObject({ kind: "error" });
    expect(saveArtifactMock).not.toHaveBeenCalled();
  });
  test("fresh document reads bypass a retained older envelope", async () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((value: unknown) => { posted.push(value); }) as typeof iframeWindow.postMessage;
    const teardown = installAppBridge({ iframe, appId: "nautilo-spreadsheet", target: artifactTarget,
      documentSession: { envelope: { content: "old", mimeType: "text/html", path: artifactTarget.path, baseSha256: "old", baseRevision: 1 } },
    });
    getArtifactMock.mockClear();
    try {
      window.dispatchEvent(new MessageEvent("message", { source: iframeWindow as unknown as MessageEventSource,
        data: { type: "nautilo.app.document.req", requestId: "fresh-sheet-read", op: "read", fresh: true },
      }));
      await waitUntil(() => posted.length > 0);
      expect(getArtifactMock).toHaveBeenCalledTimes(1);
      expect(posted[0]).toMatchObject({ ok: true, value: { baseRevision: 3 } });
    } finally { teardown(); }
  });
  test("preview permits bound reads but refuses every mutation before side effects", async () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((value: unknown) => { posted.push(value); }) as typeof iframeWindow.postMessage;
    const saveCopy = mock(async () => ({ path: "copy.html" }));
    const materialize = mock(async () => artifactTarget);
    const lifecycle = mock(() => {});
    const humanEdit = mock(() => {});
    const ack = mock(() => {});
    const pick = mock(async () => null);
    const context = mock(() => {});
    for (const fn of [saveArtifactMock, applyPatchMock, setArtifactStateMock, writeFileMock,
      applyAcceptedLiveProposalMock, resolveLiveProposalReviewMock, getArtifactMock]) fn.mockClear();
    const teardown = installAppBridge({ iframe, appId: "nautilo-writer", mode: "preview", target: artifactTarget,
      saveCopy, materialize, onLifecycleRegistrationChange: lifecycle, onHumanEditUpdate: humanEdit,
      onLiveProposalAcknowledged: ack, onContextUpdate: context,
      assets: { pick, read: async () => { throw new Error("unused"); } },
    });
    const send = (data: object, source = iframeWindow as unknown as MessageEventSource) => {
      window.dispatchEvent(new MessageEvent("message", { source, data }));
    };
    const version = { kind: "artifact_revision", revision: 3 };
    const mutations = [
      { type: "nautilo.app.document.req", op: "write", value: "changed" },
      { type: "nautilo.app.document.req", op: "saveCopy", value: "changed" },
      { type: "nautilo.app.document.req", op: "downloadCopy", value: "changed" },
      { type: "nautilo.app.state.req", op: "set", key: "view", value: { zoom: 2 } },
      { type: "nautilo.app.preferences.req", op: "set", key: "writer.spellcheck", value: { enabled: false } },
      { type: "nautilo.app.assets.req", op: "pick" },
      { type: "nautilo.app.session.req", op: "acceptProposal", proposalId: "p1", documentVersion: version,
        acceptedOperationIndexes: [0], acceptedContent: "changed" },
      { type: "nautilo.app.session.req", op: "resolveProposal", proposalId: "p1", documentVersion: version, outcome: "rejected" },
      { type: "nautilo.app.session.req", op: "invalidateProposal", proposalSessionToken: "test-token", proposalId: "p1",
        documentVersion: version, reason: "human_changed" },
    ];
    try {
      for (const [index, mutation] of mutations.entries()) {
        expect(isAppBridgeRequest({ ...mutation, requestId: `blocked-${index}` })).toBe(true);
        send({ ...mutation, requestId: `blocked-${index}` });
      }
      send({ type: "nautilo.app.lifecycle.register" });
      send({ type: "nautilo.app.human-edit.update", update: { state: "dirty" } });
      send({ type: "nautilo.app.live-proposal.ack", proposalId: "p1", documentVersion: version });
      await waitUntil(() => posted.length === mutations.length);
      expect(posted).toHaveLength(mutations.length);
      for (const response of posted) expect(response).toMatchObject({ ok: false });
      expect(JSON.stringify(posted)).toContain("Preview is read-only");
      for (const fn of [saveCopy, materialize, lifecycle, humanEdit, ack, pick, saveArtifactMock,
        applyPatchMock, setArtifactStateMock, writeFileMock, applyAcceptedLiveProposalMock, resolveLiveProposalReviewMock]) {
        expect(fn).not.toHaveBeenCalled();
      }
      send({ type: "nautilo.app.document.req", requestId: "foreign-read", op: "read" }, {} as MessageEventSource);
      expect(getArtifactMock).not.toHaveBeenCalled();
      send({ type: "nautilo.app.document.req", requestId: "preview-read", op: "read", fresh: true });
      await waitUntil(() => posted.length > mutations.length);
      expect(posted.at(-1)).toMatchObject({ requestId: "preview-read", ok: true, value: { baseRevision: 3 } });
      expect(getArtifactMock).toHaveBeenCalledTimes(1);
      send({ type: "nautilo.app.context.update", summary: { title: "Preview title" } });
      expect(context).toHaveBeenCalledTimes(1);
    } finally { teardown(); }
  });

  test("Video preview permits media reads and owned cleanup while blocking media mutation", async () => {
    const iframe = document.createElement("iframe");
    const iframeWindow = {} as Window;
    Object.defineProperty(iframe, "contentWindow", { value: iframeWindow, configurable: true });
    const posted: unknown[] = [];
    iframeWindow.postMessage = ((value: unknown) => { posted.push(value); }) as typeof iframeWindow.postMessage;
    const openPreview = mock(async () => ({
      kind: "ready" as const,
      url: "nautilo-media://proxy/preview-token",
      mimeType: "video/mp4",
      sizeBytes: 4,
      revokeToken: "preview-token",
    }));
    const closePreview = mock(async () => {});
    const importMedia = mock(async () => ({ kind: "unavailable" as const, code: "unused" }));
    const teardown = installAppBridge({
      iframe,
      appId: "nautilo-video",
      mode: "preview",
      target: artifactTarget,
      mediaProxy: true,
      onVideoWorkspaceMediaOpenPreview: openPreview,
      onVideoWorkspaceMediaClosePreview: closePreview,
      onVideoWorkspaceMediaImport: importMedia,
    });
    const send = (data: object) => window.dispatchEvent(new MessageEvent("message", {
      source: iframeWindow as unknown as MessageEventSource,
      data,
    }));
    try {
      send({ type: "nautilo.app.media.req", requestId: "preview-open", op: "openPreview", mediaId: "media_take" });
      await waitUntil(() => posted.length === 1);
      expect(posted[0]).toMatchObject({ requestId: "preview-open", ok: true, value: { kind: "ready", revokeToken: "preview-token" } });
      expect(openPreview).toHaveBeenCalledTimes(1);

      send({ type: "nautilo.app.media.req", requestId: "preview-close", op: "closePreview", revokeToken: "preview-token" });
      await waitUntil(() => posted.length === 2);
      expect(closePreview).toHaveBeenCalledWith({ revokeToken: "preview-token" });

      send({ type: "nautilo.app.media.req", requestId: "preview-import", op: "importVideo" });
      await waitUntil(() => posted.length === 3);
      expect(posted[2]).toMatchObject({ requestId: "preview-import", ok: false, status: 403 });
      expect(importMedia).not.toHaveBeenCalled();
    } finally { teardown(); }
  });

});
