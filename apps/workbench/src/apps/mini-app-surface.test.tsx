import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { ApiError } from "@nautilo/api-client/browser";
import { VideoHostAttestationRegistry, VIDEO_HOST_ATTESTATION_TTL_MS } from "../../../../packages/server/src/apps/video-host-attestation-registry";
import {
  publishLiveAppProposal,
  requestLiveAppProposalReconciliation,
  resetLiveAppProposalBusForTest,
} from "./live-app-proposal-bus";
import {
  publishLiveAppMutationCommitted,
  resetLiveAppMutationBusForTest,
} from "./live-app-mutation-bus";
import type { FsDirectoryChangedEvent } from "../lib/fs-directory-changed";
import { createEmptyProject, type MediaAsset } from "../../../../packages/first-party-apps/video/src/edl";
import { createDefaultManifest, serializeVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import { createEmptyGenerationBrief } from "../../../../packages/first-party-apps/video/src/generation-brief";
import { setSimpleGenerationPrompt } from "../../../../packages/first-party-apps/video/src/generator-composer";
import { buildVideoGenerationPlanDraft, VIDEO_GENERATION_CATALOG_MODELS } from "../../../../packages/first-party-apps/video/src/generation-plan";
import type { AppDraftRecoveryPort } from "./app-draft-recovery";
import type { AppSlideTemplateLibrary } from "./app-slide-templates";
import { dispatchAuthTransition } from "../lib/auth-transition";

const loadMiniAppRuntime = mock(async (appId: string) => ({
  appId,
  sourceHash: "d".repeat(64),
  srcDoc: "<!DOCTYPE html><html><body>Sample App placeholder</body></html>",
  manifest: {
    id: appId,
    name: "Sample App",
    version: "0.1.0",
    fileAssociations: { extensions: [".document.json"] },
    capabilities: {},
    ...(appId === "nautilo-writer" ? { liveReview: { enabled: true as const } } : {}),
  },
}));
const teardownBridge = mock(() => {});
const installAppBridge = mock(() => teardownBridge);
const postAppDocumentChanged = mock(() => {});
const postAppLiveSession = mock(() => {});
const postAppLiveProposal = mock(() => {});
const postAppTheme = mock(() => {});
const applyDocumentPatchToWriteSession = mock(() => null);
const readDocumentSession = mock(async (session: { envelope: unknown }) => {
  const envelope = {
    content: "base\n",
    mimeType: "text/html",
    path: "budget.html",
    baseSha256: "base-sha",
    baseRevision: 1,
  };
  session.envelope = envelope;
  return envelope;
});
const resetDocumentReadSession = mock((session: { envelope: unknown }) => {
  session.envelope = null;
});
const buildNautiloAppBridgeClientScript = mock(() => "window.__nautiloAppBridgeClientInstalled=true;");
const requestMiniAppLifecycle = mock(async () => ({
  status: "ready" as const,
  result: { documentSaved: true, recoveryPersisted: false, recoverableDraftExact: false },
}));
const listWorkspaceArtifacts = mock(async () => ({
  artifacts: [] as Array<{ id: string; path: string; mimeType: string }>,
}));
const createWorkspaceArtifact = mock(async (_file: Blob, opts: { path: string; mimeType: string }) => ({
  id: "artifact-created-1",
  artifactId: "external-artifact-created-1",
  path: opts.path,
  mimeType: opts.mimeType,
  size: 12,
  revision: 1,
  createdAt: "2026-06-26T00:00:00.000Z",
  updatedAt: "2026-06-26T00:00:00.000Z",
  namespaceIds: [],
}));
const renameWorkspaceArtifact = mock(async (_id: string, name: string) => ({ path: `docs/${name}` }));
const runMiniAppConversion = mock(
  async (_appId: string, body: { target?: { path?: string } }) => ({
    ok: true,
    result: {
      ok: true,
      status: "exported",
      displayPath: body.target?.path ?? "exported.docx",
    },
  }),
);
const issueLiveMiniAppSession = mock(async () => ({
  sessionToken: "a".repeat(43),
  sessionId: "route-a",
  documentVersion: { kind: "artifact_revision" as const, revision: 1 },
  expiresAt: Date.now() + 60_000,
}));
const refreshLiveMiniAppSession = mock(async () => ({
  sessionToken: "a".repeat(43),
  sessionId: "route-a",
  documentVersion: { kind: "artifact_revision" as const, revision: 2 },
  expiresAt: Date.now() + 60_000,
}));
const revokeLiveMiniAppSession = mock(async () => undefined);
const listPendingLiveProposalReviews = mock(async () => ({ proposals: [] }));
const listAllWorkspaceArtifacts = mock(async () => ({ artifacts: [] }));
const getWorkspaceArtifact = mock(async () => ({
  id: "artifact-row-1",
  artifactId: "external-video-project-1",
  path: "project.video.html",
  mimeType: "text/html",
  revision: 3,
}));
const issueVideoHostAttestation = mock(async () => ({ attestationToken: "a".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" }));
const revokeVideoHostAttestation = mock(async () => undefined);
const videoReviewFixture = () => ({
  takeId: "take_1234567890abcdef",
  reviewHandle: "review-private-handle",
  approval: {
    version: "media-generation-approval-v1",
    digest: "a".repeat(64), quoteDigest: "b".repeat(64), revision: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    preview: {
      mediaKind: "video", model: "seedance-2-5-text-to-video-basic",
      settings: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" },
      prompt: { characterCount: 20, summary: "Safe prompt summary", truncated: false },
      quote: { currency: "USD", amountMicros: 100_000, display: "USD 0.100000" },
      spendNotice: "Approving starts a paid generation using this exact quote.",
    },
  },
});
const prepareVideoGeneration = mock(async () => videoReviewFixture());
const submitVideoGenerationTake = mock(async () => ({ state: "queued" }));
const listVideoGenerationTakes = mock(async () => ({ takes: [] as Array<{ takeId: string; shotId: string; shotLabel: string; documentRevision: number }> }));
const getVideoGenerationTakeStatus = mock(async () => ({
  takeId: "take_abcdefghijklmnop", dtoVersion: 1 as const, revision: 4, mediaKind: "video" as const, state: "ready" as const,
  modelId: "seedance-2-5-text-to-video-basic", settings: { durationSeconds: 5 },
  artifact: { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/take.mp4", zone: "workspace" as const, mime: "video/mp4", bytes: 4 },
  recoveryActions: [],
}));
const getWorkspaceArtifactBytesArrayBuffer = mock(async () => new Uint8Array([1, 2, 3, 4]).buffer);
const deleteWorkspaceArtifact = mock(async () => undefined);

const exportDocxAction = {
  id: "export-docx",
  label: "Microsoft Word",
  to: {
    extension: ".docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  tool: "office-export",
  targetSurfaces: ["workspace", "currentFolder"],
};

const exportPdfAction = {
  id: "export-pdf",
  label: "PDF",
  to: {
    extension: ".pdf",
    mimeType: "application/pdf",
  },
  tool: "office-export",
  targetSurfaces: ["workspace", "currentFolder"],
};

const exportSvgAction = {
  id: "export-svg",
  label: "SVG",
  to: { extension: ".svg", mimeType: "image/svg+xml" },
  tool: "export-svg",
  targetSurfaces: ["workspace"],
};

const exportPngAction = {
  id: "export-png",
  label: "PNG",
  to: { extension: ".png", mimeType: "image/png" },
  tool: "export-png",
  targetSurfaces: ["workspace"],
};

function runtimeWithExportActions(appId: string, exportActions = [exportDocxAction]) {
  return {
    appId,
    sourceHash: "d".repeat(64),
    srcDoc: "<!DOCTYPE html><html><body>Sample App placeholder</body></html>",
    manifest: {
      id: appId,
      name: "Sample App",
      version: "0.1.0",
      fileAssociations: { extensions: [".document.json"] },
      capabilities: {},
      conversions: {
        export: exportActions,
      },
    },
  };
}

let artifactEventHandler: ((event: unknown) => void | Promise<void>) | null = null;
const subscribeWorkspaceArtifactEventsMock = mock(
  (handler: (event: unknown) => void | Promise<void>) => {
  artifactEventHandler = handler;
  return () => {
    artifactEventHandler = null;
  };
});
const isLocalArtifactSaveMutationMock = mock(() => false);
const usePublishedHumanEditLeaseMock = mock(() => ({ record: null }));

mock.module("../artifacts/workspace-artifacts-provider", () => ({
  useWorkspaceArtifactEventHub: () => subscribeWorkspaceArtifactEventsMock,
}));

const watchRootMock = mock(async () => undefined);
const fsStatMock = mock(async () => ({
  exists: true,
  isFile: true,
  size: 5,
  documentIdentity: {
    kind: "local_file" as const,
    relayId: "relay-desktop-1",
    canonicalPath: "/workspace/document.txt",
  },
}));
const fsReadFileMock = mock(async () => "hello");
const importedRowId = "00000000-0000-4000-8000-000000000001";
function nativeReceipt(mediaKind: "video" | "audio" | "image" = "video", label = "Opening take") {
  const extension = mediaKind === "video" ? "mp4" : mediaKind === "audio" ? "wav" : "png";
  return { ok: true as const, data: { label, mediaKind,
    artifact: { id: importedRowId, artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
      path: `video-imports/${importedRowId}.${extension}`, mimeType: `${mediaKind}/${extension}`, size: 12 },
    ...(mediaKind === "image" ? {} : { durationSec: 4.2 }),
    ...(mediaKind === "video" ? { frameRate: { numerator: 30, denominator: 1 } } : {}),
  } };
}
const importWorkspaceMock = mock(async (_input: unknown): Promise<any> => ({ ok: false, error: { code: "cancelled" } }));
const importWorkspaceBatchMock = mock(async (_input: unknown): Promise<any> => ({ ok: false, error: { code: "cancelled" } }));
const nativePreviewToken = "00000000-0000-4000-8000-000000000004";
const nativePreviewUrl = `nautilo-media://proxy/${nativePreviewToken}`;
const openWorkspaceMock = mock(async ({ artifact }: { artifact: { mimeType: string; size: number } }): Promise<any> => ({
  ok: true, data: { url: nativePreviewUrl, revokeToken: nativePreviewToken, mimeType: artifact.mimeType,
    sizeBytes: artifact.size, mediaKind: artifact.mimeType.split("/")[0],
    ...(artifact.mimeType.startsWith("image/") ? {} : { durationSec: 4.25 }),
    ...(artifact.mimeType.startsWith("video/") ? { frameRate: { numerator: 24, denominator: 1 } } : {}) },
}));
const closeWorkspaceMock = mock(async (_token: string) => ({ ok: true, data: null }));
const cancelWorkspaceMock = mock(async (_request: string) => ({ ok: true, data: null }));
const startWorkspaceExportMock = mock(async (_input: unknown) => ({ ok: true as const, data: { status: "succeeded" as const, label: "cut.mp4", sizeBytes: 2048, warnings: [] } }));
const cancelExportMock = mock(async (_requestId: string) => ({ ok: true as const, data: null }));
let exportProgressHandler: ((event: { requestId: string; progress: unknown }) => void) | undefined;
const unsubscribeExportMock = mock(() => { exportProgressHandler = undefined; });
const fsWriteFileMock = mock(async () => ({ ok: true as const, sha256: "copy-sha" }));
const recoveryOpenMock = mock(async () => ({ handle: "slides-recovery-handle" }));
const recoveryReadMock = mock(async () => ({ revision: null, draft: null }));
const recoveryCloseMock = mock(async () => {});
const nativeRecoveryMock = {
  open: recoveryOpenMock,
  read: recoveryReadMock,
  write: mock(async () => ({ revision: "checkpoint-revision" })),
  close: recoveryCloseMock,
};
let directoryChangedHandler: ((event: FsDirectoryChangedEvent) => void) | null = null;
const onDirectoryChangedMock = mock((handler: (event: FsDirectoryChangedEvent) => void) => {
  directoryChangedHandler = handler;
  return () => {
    if (directoryChangedHandler === handler) directoryChangedHandler = null;
  };
});
const desktopApiMock: {
  miniAppRecovery?: typeof nativeRecoveryMock;
  fs: {
    watchRoot: typeof watchRootMock;
    onDirectoryChanged: typeof onDirectoryChangedMock;
    stat: typeof fsStatMock;
    readFile: typeof fsReadFileMock;
    writeFile: typeof fsWriteFileMock;
  };
  mediaProxy: {
    importWorkspace: typeof importWorkspaceMock;
    importWorkspaceBatch: typeof importWorkspaceBatchMock;
    openWorkspace: typeof openWorkspaceMock;
    close: typeof closeWorkspaceMock;
    cancel: typeof cancelWorkspaceMock;
  };
  mediaExport: {
    supportsExportSettings: boolean;
    startWorkspace: typeof startWorkspaceExportMock;
    cancel: typeof cancelExportMock;
    onProgress: (handler: typeof exportProgressHandler) => typeof unsubscribeExportMock;
  };
} = {
  miniAppRecovery: nativeRecoveryMock,
  fs: {
    watchRoot: watchRootMock,
    onDirectoryChanged: onDirectoryChangedMock,
    stat: fsStatMock,
    readFile: fsReadFileMock,
    writeFile: fsWriteFileMock,
  },
  mediaProxy: {
    importWorkspace: importWorkspaceMock,
    importWorkspaceBatch: importWorkspaceBatchMock,
    openWorkspace: openWorkspaceMock,
    close: closeWorkspaceMock,
    cancel: cancelWorkspaceMock,
  },
  mediaExport: {
    supportsExportSettings: true,
    startWorkspace: startWorkspaceExportMock,
    cancel: cancelExportMock,
    onProgress: (handler: typeof exportProgressHandler) => { exportProgressHandler = handler; return unsubscribeExportMock; },
  },
};

mock.module("../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: desktopApiMock,
  getDesktopRelayId: mock(async () => "relay-desktop-1" as string | null),
}));

mock.module("../lib/api", () => ({
  apiClient: {
    subscribeWorkspaceArtifactEvents: subscribeWorkspaceArtifactEventsMock,
    listWorkspaceArtifacts,
    createWorkspaceArtifact,
    deleteWorkspaceArtifact,
    renameWorkspaceArtifact,
    runMiniAppConversion,
    issueLiveMiniAppSession,
    refreshLiveMiniAppSession,
    revokeLiveMiniAppSession,
    listPendingLiveProposalReviews,
    listAllWorkspaceArtifacts,
    getWorkspaceArtifact,
    issueVideoHostAttestation,
    revokeVideoHostAttestation,
    prepareVideoGeneration,
    submitVideoGenerationTake,
    listVideoGenerationTakes,
    getVideoGenerationTakeStatus,
    getWorkspaceArtifactBytesArrayBuffer,
  },
}));

mock.module("../editors/local-artifact-save-mutations", () => ({
  isLocalArtifactSaveMutation: isLocalArtifactSaveMutationMock,
}));

mock.module("../editors/use-human-edit-lease", () => ({
  usePublishedHumanEditLease: usePublishedHumanEditLeaseMock,
}));
let testViewer = { isVerified: true, sessionUserId: "viewer-test" };
mock.module("../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: testViewer }),
}));

let appEventHandler: ((event: {
  type: "changed" | "status";
  appId: string;
  sourceHash?: string;
  status?: string;
}) => void) | null = null;

mock.module("./use-app-events", () => ({
  useAppEvents: (handler: typeof appEventHandler extends infer H ? NonNullable<H> : never) => {
    appEventHandler = handler;
  },
}));

mock.module("./app-runtime", () => ({
  loadMiniAppRuntime,
}));

mock.module("./app-bridge", () => ({
  installAppBridge,
  postAppDocumentChanged,
  postAppLiveSession,
  postAppLiveProposal,
  postAppLiveSessionClosed: mock(() => {}),
  postAppTheme,
  applyDocumentPatchToWriteSession,
  applyVerifiedDocumentPatchToWriteSession: applyDocumentPatchToWriteSession,
  readDocumentSession,
  resetDocumentReadSession,
}));

mock.module("./live-app-session-close-bus", () => ({
  subscribeLiveAppSessionClosed: mock(() => () => {}),
}));

mock.module("./app-bridge-client", () => ({
  buildNautiloAppBridgeClientScript,
}));

const {
  MiniAppSurface,
  buildUniqueDraftPath,
  designExportScopeChoices,
  durableWorkspaceVideoMediaFromDocument,
  liveSessionRefreshDelay,
  srcDocWithAppBridgeClient,
} = await import("./mini-app-surface");
const { setOpenFileDispatcher } = await import("../adapters/open-file-ref");
const {
  clearPendingAcceptMutationsForTests,
  failPendingAcceptMutation,
  markPendingAcceptMutationSucceeded,
  registerPendingAcceptMutation,
} = await import("./local-fs-accept-mutations");

function validVideoDocument(media: MediaAsset[] = []): string {
  const project = createEmptyProject();
  project.media = media;
  return serializeVideoHtml(createDefaultManifest(), project, { touchMetadata: false });
}

beforeEach(() => {
  testViewer = { isVerified: true, sessionUserId: "viewer-test" };
  reapplyHappyDomGlobals();
  resetLiveAppProposalBusForTest();
  resetLiveAppMutationBusForTest();
  loadMiniAppRuntime.mockClear();
  installAppBridge.mockClear();
  installAppBridge.mockImplementation(() => teardownBridge);
  usePublishedHumanEditLeaseMock.mockClear();
  postAppDocumentChanged.mockClear();
  postAppLiveSession.mockClear();
  postAppLiveProposal.mockClear();
  postAppTheme.mockClear();
  applyDocumentPatchToWriteSession.mockClear();
  readDocumentSession.mockClear();
  readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
    const envelope = {
      content: "base\n",
      mimeType: "text/html",
      path: "budget.html",
      baseSha256: "base-sha",
      baseRevision: 1,
    };
    session.envelope = envelope;
    return envelope;
  });
  resetDocumentReadSession.mockClear();
  clearPendingAcceptMutationsForTests();
  directoryChangedHandler = null;
  watchRootMock.mockClear();
  onDirectoryChangedMock.mockClear();
  fsStatMock.mockClear();
  fsReadFileMock.mockClear();
  importWorkspaceMock.mockReset();
  importWorkspaceBatchMock.mockReset();
  openWorkspaceMock.mockClear();
  closeWorkspaceMock.mockClear();
  cancelWorkspaceMock.mockClear();
  startWorkspaceExportMock.mockClear();
  startWorkspaceExportMock.mockImplementation(async () => ({ ok: true as const, data: { status: "succeeded" as const, label: "cut.mp4", sizeBytes: 2048, warnings: [] } }));
  cancelExportMock.mockClear();
  unsubscribeExportMock.mockClear();
  exportProgressHandler = undefined;
  fsWriteFileMock.mockClear();
  recoveryOpenMock.mockClear();
  recoveryReadMock.mockClear();
  recoveryCloseMock.mockClear();
  desktopApiMock.miniAppRecovery = nativeRecoveryMock;
  fsWriteFileMock.mockImplementation(async () => ({ ok: true as const, sha256: "copy-sha" }));
  fsStatMock.mockImplementation(async () => ({ exists: true, isFile: true, size: 5 }));
  fsReadFileMock.mockImplementation(async () => "hello");
  importWorkspaceMock.mockImplementation(async () => ({ ok: false, error: { code: "cancelled" } }));
  importWorkspaceBatchMock.mockImplementation(async () => ({ ok: false, error: { code: "cancelled" } }));
  teardownBridge.mockClear();
  buildNautiloAppBridgeClientScript.mockClear();
  requestMiniAppLifecycle.mockClear();
  requestMiniAppLifecycle.mockImplementation(async () => ({
    status: "ready" as const,
    result: { documentSaved: true, recoveryPersisted: false, recoverableDraftExact: false },
  }));
  subscribeWorkspaceArtifactEventsMock.mockClear();
  isLocalArtifactSaveMutationMock.mockClear();
  artifactEventHandler = null;
  listWorkspaceArtifacts.mockClear();
  createWorkspaceArtifact.mockClear();
  deleteWorkspaceArtifact.mockClear();
  renameWorkspaceArtifact.mockClear();
  renameWorkspaceArtifact.mockImplementation(async (_id: string, name: string) => ({ path: `docs/${name}` }));
  runMiniAppConversion.mockClear();
  issueLiveMiniAppSession.mockClear();
  refreshLiveMiniAppSession.mockClear();
  revokeLiveMiniAppSession.mockClear();
  listPendingLiveProposalReviews.mockClear();
  listPendingLiveProposalReviews.mockImplementation(async () => ({ proposals: [] }));
  listAllWorkspaceArtifacts.mockClear();
  listAllWorkspaceArtifacts.mockImplementation(async () => ({ artifacts: [] }));
  getWorkspaceArtifact.mockClear();
  issueVideoHostAttestation.mockClear();
  revokeVideoHostAttestation.mockClear();
  prepareVideoGeneration.mockClear();
  submitVideoGenerationTake.mockClear();
  listVideoGenerationTakes.mockClear();
  getVideoGenerationTakeStatus.mockClear();
  getWorkspaceArtifactBytesArrayBuffer.mockClear();
  listWorkspaceArtifacts.mockImplementation(async () => ({ artifacts: [] }));
  listVideoGenerationTakes.mockImplementation(async () => ({ takes: [] }));
  getVideoGenerationTakeStatus.mockImplementation(async () => ({
    takeId: "take_abcdefghijklmnop", dtoVersion: 1, revision: 4, mediaKind: "video", state: "ready", modelId: "seedance-2-5-text-to-video-basic", settings: { durationSeconds: 5 },
    artifact: { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/take.mp4", zone: "workspace", mime: "video/mp4", bytes: 4 }, recoveryActions: [],
  }));
  getWorkspaceArtifactBytesArrayBuffer.mockImplementation(async () => new Uint8Array([1, 2, 3, 4]).buffer);
  createWorkspaceArtifact.mockImplementation(async (_file: Blob, opts: { path: string; mimeType: string }) => ({
    id: "artifact-created-1",
    artifactId: "external-artifact-created-1",
    path: opts.path,
    mimeType: opts.mimeType,
    size: 12,
    revision: 1,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    namespaceIds: [],
  }));
  runMiniAppConversion.mockImplementation(async (_appId: string, body: { target?: { path?: string } }) => ({
    ok: true,
    result: {
      ok: true,
      status: "exported",
      displayPath: body.target?.path ?? "exported.docx",
    },
  }));
  issueLiveMiniAppSession.mockImplementation(async () => ({
    sessionToken: "a".repeat(43),
    sessionId: "route-a",
    documentVersion: { kind: "artifact_revision" as const, revision: 1 },
    expiresAt: Date.now() + 60_000,
  }));
  refreshLiveMiniAppSession.mockImplementation(async () => ({
    sessionToken: "a".repeat(43),
    sessionId: "route-a",
    documentVersion: { kind: "artifact_revision" as const, revision: 2 },
    expiresAt: Date.now() + 60_000,
  }));
  revokeLiveMiniAppSession.mockImplementation(async () => undefined);
  getWorkspaceArtifact.mockImplementation(async () => ({
    id: "artifact-row-1", artifactId: "external-video-project-1", path: "project.video.html", mimeType: "text/html", revision: 3,
  }));
  issueVideoHostAttestation.mockImplementation(async () => ({ attestationToken: "a".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" }));
  revokeVideoHostAttestation.mockImplementation(async () => undefined);
  prepareVideoGeneration.mockImplementation(async () => ({
    takeId: "take_1234567890abcdef", reviewHandle: "review-private-handle",
    approval: {
      version: "media-generation-approval-v1", digest: "a".repeat(64), quoteDigest: "b".repeat(64), revision: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      preview: { mediaKind: "video", model: "seedance-2-5-text-to-video-basic", settings: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" }, prompt: { characterCount: 20, summary: "Safe prompt summary", truncated: false }, quote: { currency: "USD", amountMicros: 100_000, display: "USD 0.100000" }, spendNotice: "Approving starts a paid generation using this exact quote." },
    },
  }));
  submitVideoGenerationTake.mockImplementation(async () => ({ state: "queued" }));
  appEventHandler = null;
  setOpenFileDispatcher(null);
  loadMiniAppRuntime.mockImplementation(async (appId: string) => ({
    appId,
    sourceHash: "d".repeat(64),
    srcDoc: "<!DOCTYPE html><html><body>Sample App placeholder</body></html>",
    manifest: {
      id: appId,
      name: "Sample App",
      version: "0.1.0",
      fileAssociations: { extensions: [".document.json"] },
      capabilities: {},
      ...(appId === "nautilo-writer" ? { liveReview: { enabled: true as const } } : {}),
    },
  }));
});

describe("MiniAppSurface", () => {
  test("resolves one durable Workspace video source only from the bound project document", () => {
    const content = validVideoDocument([{ id: "media_take", kind: "video", ref: "generated/take.mp4", lifecycle: "durable", durationSec: 4, frameRate: { numerator: 30, denominator: 1 }, source: { kind: "workspace-artifact", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated/take.mp4" } }]);
    expect(durableWorkspaceVideoMediaFromDocument(content, "media_take")).toEqual({
      artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
      path: "generated/take.mp4",
      mediaKind: "video",
    });
    // A valid host document above Video's former quota must retain its media.
    const largeContent = content.replace("</body>", `<p>${"Caption ".repeat(30_000)}</p></body>`);
    expect(new TextEncoder().encode(largeContent).byteLength).toBeGreaterThan(200 * 1024);
    expect(durableWorkspaceVideoMediaFromDocument(largeContent, "media_take")).toEqual(durableWorkspaceVideoMediaFromDocument(content, "media_take"));
    expect(durableWorkspaceVideoMediaFromDocument(content, "missing")).toBeNull();
    expect(durableWorkspaceVideoMediaFromDocument(content.replace('"media": [', '"media": [{"id":"media_take","kind":"video","ref":"generated/other.mp4","lifecycle":"durable","durationSec":4,"frameRate":{"numerator":30,"denominator":1},"source":{"kind":"workspace-artifact","artifactId":"48a0266d-b1c2-4ffd-9c10-2865bea8fc53","path":"generated/other.mp4"}},'), "media_take")).toBeNull();
    expect(durableWorkspaceVideoMediaFromDocument(content.replace('"source": {', '"source": {"internalId":"nope",'), "media_take")).toBeNull();
  });

  test("preview keeps the canonical read bridge while withholding edit authority", async () => {
    const onEdit = mock(() => {});
    loadMiniAppRuntime.mockImplementation(async (appId: string) => {
      const runtime = runtimeWithExportActions(appId, [exportDocxAction]);
      return {
        ...runtime,
        manifest: { ...runtime.manifest, liveReview: { enabled: true as const } },
      };
    });
    const target = {
      kind: "artifact" as const,
      id: "artifact-preview-1",
      path: "Preview.document.html",
      mimeType: "text/html",
    };

    const view = render(
      <MiniAppSurface
        appId="nautilo-writer"
        mode="preview"
        target={target}
        onEdit={onEdit}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridgeOptions = installAppBridge.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(bridgeOptions.mode).toBe("preview");
    expect(bridgeOptions.target).toEqual(target);
    expect(typeof bridgeOptions.onContextUpdate).toBe("function");
    expect(bridgeOptions.onHumanEditUpdate).toBeUndefined();
    expect(bridgeOptions.onLifecycleRegistrationChange).toBeUndefined();
    expect(bridgeOptions.onDocumentVersion).toBeUndefined();
    expect(bridgeOptions.getLiveSession).toBeUndefined();
    expect(bridgeOptions.onLiveProposalAccepted).toBeUndefined();
    expect(bridgeOptions.onLiveProposalAcknowledged).toBeUndefined();
    expect(issueLiveMiniAppSession).not.toHaveBeenCalled();
    expect(usePublishedHumanEditLeaseMock.mock.calls.at(-1)?.[0]).toEqual({
      file: undefined,
      update: { state: "clean" },
    });
    expect(await view.findByText("Sample App · v0.1.0 · Preview")).toBeTruthy();
    expect(view.queryByTestId("mini-app-export-button")).toBeNull();
    expect(view.queryByTestId("mini-app-doc-name")).toBeNull();

    fireEvent.click(view.getByTestId("mini-app-edit-button"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(buildNautiloAppBridgeClientScript).toHaveBeenCalledWith(undefined, "preview", { recovery: false, templates: false });
    expect(readDocumentSession).toHaveBeenCalled();
  });

  test("changing between edit and preview replaces the iframe authority identity", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-mode-switch",
      path: "Mode.document.html",
      mimeType: "text/html",
    };
    const view = render(
      <MiniAppSurface appId="sample-app" mode="edit" target={target} onClose={() => {}} />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const editIframe = view.container.querySelector("iframe");
    expect(installAppBridge.mock.calls.at(-1)?.[0].mode).toBe("edit");

    view.rerender(
      <MiniAppSurface appId="sample-app" mode="preview" target={target} onClose={() => {}} />,
    );
    await waitFor(() => expect(installAppBridge.mock.calls.at(-1)?.[0].mode).toBe("preview"));
    expect(view.container.querySelector("iframe")).not.toBe(editIframe);
    expect(teardownBridge).toHaveBeenCalled();
    expect(resetDocumentReadSession).toHaveBeenCalled();
  });

  test("Slides recovery survives first materialization and closes with its frame", async () => {
    const view = render(<MiniAppSurface
      appId="nautilo-presentation"
      draft={{ createActionId: "create-presentation", suggestedName: "Draft.presentation.html" }}
      onClose={() => {}}
    />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    expect(buildNautiloAppBridgeClientScript).toHaveBeenCalledWith(undefined, "edit", { recovery: true, templates: true });
    const options = installAppBridge.mock.calls.at(-1)?.[0];
    const recovery = options.recovery as AppDraftRecoveryPort;
    const installs = installAppBridge.mock.calls.length;
    await act(async () => { await options.materialize!("edited-content", "text/html"); });
    await waitFor(() => expect(installAppBridge.mock.calls.length).toBeGreaterThan(installs));
    const boundOptions = installAppBridge.mock.calls.at(-1)?.[0];
    expect(boundOptions.recovery).toBe(recovery);
    await recovery.read(boundOptions.target!);
    expect(recoveryOpenMock).toHaveBeenCalledTimes(1);
    expect(recoveryCloseMock).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(recoveryCloseMock).toHaveBeenCalledWith("slides-recovery-handle"));
  });

  test("Board recovery survives first materialization without enabling Slides templates", async () => {
    const view = render(<MiniAppSurface
      appId="nautilo-board"
      draft={{ createActionId: "create-board", suggestedName: "Draft.board.html" }}
      onClose={() => {}}
    />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    expect(buildNautiloAppBridgeClientScript).toHaveBeenCalledWith(undefined, "edit", { recovery: true, templates: false });
    const options = installAppBridge.mock.calls.at(-1)?.[0];
    const recovery = options.recovery as AppDraftRecoveryPort;
    await act(async () => { await options.materialize!("edited-board", "text/html"); });
    const boundOptions = installAppBridge.mock.calls.at(-1)?.[0];
    await recovery.read(boundOptions.target!);
    expect(recoveryOpenMock).toHaveBeenCalledWith(expect.objectContaining({ appId: "nautilo-board" }));
    view.unmount();
    await waitFor(() => expect(recoveryCloseMock).toHaveBeenCalledWith("slides-recovery-handle"));
  });

  test("Slides template authority is retired on account transition and unmount", async () => {
    const view = render(<MiniAppSurface appId="nautilo-presentation"
      draft={{ createActionId: "create-presentation", suggestedName: "Templates.presentation.html" }}
      onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const library = installAppBridge.mock.calls.at(-1)?.[0].templates as AppSlideTemplateLibrary;
    expect(library).toBeDefined();
    dispatchAuthTransition({ credentialGeneration: 1, viewerGeneration: 1, reason: "user-switched" });
    await expect(library.list()).rejects.toThrow("authority");
    view.unmount();
    await expect(library.save({ name: "Old frame", content: "old draft" })).rejects.toThrow("authority");
  });

  test("browser Slides omits recovery from both iframe bootstrap and host bridge", async () => {
    delete desktopApiMock.miniAppRecovery;
    render(<MiniAppSurface
      appId="nautilo-presentation"
      draft={{ createActionId: "create-presentation", suggestedName: "Browser.presentation.html" }}
      onClose={() => {}}
    />);

    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    expect(buildNautiloAppBridgeClientScript).toHaveBeenCalledWith(undefined, "edit", { recovery: false, templates: true });
    expect(installAppBridge.mock.calls.at(-1)?.[0].recovery).toBeUndefined();
    expect(recoveryOpenMock).not.toHaveBeenCalled();
  });

  test("preview does not expose draft materialization or rename controls", async () => {
    const view = render(
      <MiniAppSurface
        appId="sample-app"
        mode="preview"
        draft={{ suggestedName: "Preview draft.html", mimeType: "text/html", createActionId: "new" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridgeOptions = installAppBridge.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(bridgeOptions.draft).toBeUndefined();
    expect(bridgeOptions.materialize).toBeUndefined();
    expect(view.queryByTestId("mini-app-doc-name")).toBeNull();
    expect(view.queryByTestId("mini-app-doc-name-input")).toBeNull();
    expect(view.getByText("Preview draft.html")).toBeTruthy();
  });

  test("Video preview keeps media reads but withholds media mutation and generation authority", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video",
      sourceHash: "d".repeat(64),
      srcDoc: "<html><head></head><body></body></html>",
      hostCapabilities: {
        assets: true as const,
        assetReadRaster: true as const,
        mediaProxy: true as const,
        videoGeneration: true as const,
      },
      manifest: {
        id: "nautilo-video",
        name: "Video",
        version: "0.2.2",
        fileAssociations: { extensions: [".video.html"] },
        capabilities: {},
      },
    }));
    render(
      <MiniAppSurface
        appId="nautilo-video"
        mode="preview"
        target={{ kind: "artifact", id: "video-preview", path: "Preview.video.html", mimeType: "text/html" }}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(bridge.assets).toBeDefined();
    expect(bridge.assetReadRaster).toBe(true);
    expect(bridge.mediaProxy).toBe(true);
    expect(bridge.onVideoWorkspaceMediaOpenPreview).toBeDefined();
    expect(bridge.onVideoWorkspaceMediaClosePreview).toBeDefined();
    expect(bridge.onVideoWorkspaceMediaImport).toBeUndefined();
    expect(bridge.onVideoWorkspaceMediaExport).toBeUndefined();
    expect(bridge.onVideoProjectPromotion).toBeUndefined();
    expect(bridge.videoGeneration).toBeUndefined();
    expect(bridge.onVideoGenerationRequest).toBeUndefined();
    expect(buildNautiloAppBridgeClientScript).toHaveBeenLastCalledWith(
      { assetReadRaster: true, mediaProxy: true },
      "preview",
      { recovery: false, templates: false },
    );
  });

  test("computes a bounded pre-expiry live-session refresh delay", () => {
    expect(liveSessionRefreshDelay(901_000, 1_000)).toBe(840_000);
    expect(liveSessionRefreshDelay(6_000, 1_000)).toBe(4_000);
    expect(liveSessionRefreshDelay(1_000, 1_000)).toBeNull();
    expect(liveSessionRefreshDelay(Number.NaN, 1_000)).toBeNull();
  });

  test("buildUniqueDraftPath preserves extensions and picks the next free default", () => {
    expect(
      buildUniqueDraftPath({
        desiredName: "Untitled document.html",
        existingNames: ["untitled document.html", "Untitled document 2.html"],
      }),
    ).toBe("Untitled document 3.html");
    expect(
      buildUniqueDraftPath({
        desiredName: "Notes",
        existingNames: ["notes"],
      }),
    ).toBe("Notes 2");
  });

  test("derives complete Design export scopes only from host-bound active context", () => {
    expect(designExportScopeChoices({
      appId: "nautilo-design",
      summary: {
        selection: {
          pageHandle: "page:page-1",
          nodeHandles: ["node:frame-1", "node:shape-2"],
        },
        summary: {
          design: {
            pageHandle: "page:page-1",
            topLevelFrames: [{ handle: "node:frame-1", name: "Poster" }],
          },
        },
      },
      updatedAt: 1,
    })).toEqual([
      { label: "Current page", scope: { pageHandle: "page:page-1" } },
      {
        label: "Selection",
        scope: { pageHandle: "page:page-1", nodeHandles: ["node:frame-1", "node:shape-2"] },
      },
      {
        label: "Selected frame",
        scope: { pageHandle: "page:page-1", nodeHandles: ["node:frame-1"] },
      },
    ]);
  });

  test("injects bridge before module script, not a </head> string inside bundled code", () => {
    const srcDoc = `<!doctype html><html><head><script type="module">const html = \`<html><head></head><body>\${preview}</body></html>\`; window.ok = true;</script></head><body><div id="app"></div></body></html>`;
    const finalDoc = srcDocWithAppBridgeClient(srcDoc);
    const bridgeIndex = finalDoc.indexOf("__nautiloAppBridgeClientInstalled");
    const moduleIndex = finalDoc.indexOf('<script type="module">');
    const templateHeadIndex = finalDoc.indexOf("<head></head><body>");

    expect(bridgeIndex).toBeGreaterThanOrEqual(0);
    expect(moduleIndex).toBeGreaterThanOrEqual(0);
    expect(bridgeIndex).toBeLessThan(moduleIndex);
    expect(templateHeadIndex).toBeGreaterThan(moduleIndex);
  });

  test("passes the attested Video generation grant into bootstrap only", () => {
    const srcDoc = srcDocWithAppBridgeClient("<html><head></head><body></body></html>", "dark", {
      videoGeneration: true,
    });
    expect(buildNautiloAppBridgeClientScript).toHaveBeenLastCalledWith(
      { initialTheme: "dark", videoGeneration: true, videoHostLayout: true },
      "edit",
      undefined,
    );
    expect(srcDoc).toContain("__nautiloAppBridgeClientInstalled");
  });

  async function mountRecoveryVideo() {
    const brief = setSimpleGenerationPrompt(createEmptyGenerationBrief(), "A slow coastal flight.");
    const document = { sha256: "a".repeat(64), revision: 3 };
    const source = { kind: "quick-brief" as const };
    const settings = { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" };
    const draft = await buildVideoGenerationPlanDraft(brief, { version: 1, document, scope: source,
      jobs: [{ source, modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance, settings }] });
    if (draft.status !== "ready-for-quote") throw new Error("Expected direction");
    const content = serializeVideoHtml(createDefaultManifest(), { ...createEmptyProject(), generationBrief: brief });
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({ appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html></html>",
      hostCapabilities: { videoGeneration: true as const }, manifest: { id: "nautilo-video", name: "Video", version: "0.2.2", fileAssociations: { extensions: [".video.html"] }, capabilities: {} } }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content, mimeType: "text/html", path: target.path, baseSha256: document.sha256, baseRevision: document.revision };
      session.envelope = envelope; return envelope;
    });
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    const request = { requestId: "request-video-recovery", document, sourceFingerprint: draft.sourceFingerprint,
      job: { source, prompt: draft.jobs[0].prompt, modelId: draft.jobs[0].catalogModelId, requestedSettings: settings } };
    return { rendered, bridge, request, target, content };
  }

  test("an autosaved Video revision renews the host token before prepare and rejects the stale request", async () => {
    const h = await mountRecoveryVideo();
    const renewedToken = "b".repeat(43);
    const renewedDocument = { sha256: "b".repeat(64), revision: 4 };
    getWorkspaceArtifact.mockImplementation(async () => ({
      id: "artifact-row-1", artifactId: "external-video-project-1", path: h.target.path,
      mimeType: "text/html", revision: renewedDocument.revision,
    }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content: h.content, mimeType: "text/html", path: h.target.path,
        baseSha256: renewedDocument.sha256, baseRevision: renewedDocument.revision };
      session.envelope = envelope;
      return envelope;
    });
    issueVideoHostAttestation.mockImplementationOnce(async () => ({
      attestationToken: renewedToken, expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    try {
      const renewed = h.bridge.onVideoGenerationRequest({
        ...h.request, requestId: "request-video-revision-4", document: renewedDocument,
      });
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      expect(issueVideoHostAttestation).toHaveBeenCalledTimes(2);
      expect(prepareVideoGeneration.mock.calls.at(-1)?.[1]).toBe(renewedToken);
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Cancel" })));
      await expect(renewed).resolves.toEqual({ kind: "cancelled" });

      let staleResult: unknown;
      await act(async () => { staleResult = await h.bridge.onVideoGenerationRequest(h.request); });
      expect(staleResult).toEqual({ kind: "expired" });
      expect(prepareVideoGeneration).toHaveBeenCalledTimes(1);
      expect(submitVideoGenerationTake).not.toHaveBeenCalled();
    } finally { h.rendered.unmount(); }
  });

  test("a host without Workspace media support stops Video before quote preparation", async () => {
    const mediaProxy = desktopApiMock.mediaProxy as typeof desktopApiMock.mediaProxy & { openWorkspace?: typeof openWorkspaceMock };
    const priorOpenWorkspace = mediaProxy.openWorkspace;
    mediaProxy.openWorkspace = undefined;
    const h = await mountRecoveryVideo();
    try {
      const result = await h.bridge.onVideoGenerationRequest(h.request);
      expect(result).toEqual({
        kind: "unavailable",
        code: "desktop_required",
      });
      expect(prepareVideoGeneration).not.toHaveBeenCalled();
      expect(submitVideoGenerationTake).not.toHaveBeenCalled();
      expect(h.rendered.getByTestId("video-host-support-notice")).toBeTruthy();
    } finally {
      mediaProxy.openWorkspace = priorOpenWorkspace;
      h.rendered.unmount();
    }
  });

  test("revision refresh expires an open Video review without submitting it", async () => {
    const h = await mountRecoveryVideo();
    const pending = h.bridge.onVideoGenerationRequest(h.request);
    try {
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      getWorkspaceArtifact.mockImplementation(async () => ({
        id: "artifact-row-1", artifactId: "external-video-project-1", path: h.target.path,
        mimeType: "text/html", revision: 4,
      }));
      issueVideoHostAttestation.mockImplementationOnce(async () => ({
        attestationToken: "b".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z",
      }));

      await act(async () => {
        expect(await h.bridge.onVideoGenerationListTakes()).toMatchObject({ kind: "ready" });
      });
      await expect(pending).resolves.toEqual({ kind: "expired" });
      expect(listVideoGenerationTakes.mock.calls.at(-1)?.[0]?.attestationToken).toBe("b".repeat(43));
      expect(h.rendered.queryByTestId("video-generation-review-overlay")).toBeNull();
      expect(submitVideoGenerationTake).not.toHaveBeenCalled();
    } finally { h.rendered.unmount(); }
  });

  test("an open review expires safely with the real host lease and can be reviewed again without new creative input", async () => {
    let now = Date.now();
    const registry = new VideoHostAttestationRegistry(() => now);
    const binding = { userId: "viewer-test", roomId: "room-1", namespaceId: "namespace-1", projectArtifactInternalId: "artifact-row-1",
      projectArtifactId: "external-video-project-1", projectRevision: 3, sourceHash: "d".repeat(64) };
    const first = registry.issue(binding);
    issueVideoHostAttestation.mockImplementationOnce(async () => ({ attestationToken: first.token, expiresAt: first.expiresAt }));
    const h = await mountRecoveryVideo();
    try {
      const pending = h.bridge.onVideoGenerationRequest(h.request);
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      // The quote is still valid until 2099; only the five-minute host authority expired.
      now += VIDEO_HOST_ATTESTATION_TTL_MS + 1;
      expect(registry.validate(first.token, binding)).toBe(false);
      const second = registry.issue(binding);
      issueVideoHostAttestation.mockImplementationOnce(async () => ({ attestationToken: second.token, expiresAt: second.expiresAt }));
      listVideoGenerationTakes.mockImplementationOnce(async () => { throw new ApiError(410, "host_expired"); });
      await act(async () => { expect(await h.bridge.onVideoGenerationListTakes()).toMatchObject({ kind: "unavailable" }); });
      await expect(pending).resolves.toEqual({ kind: "expired" });
      await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalledTimes(2));
      expect(h.rendered.queryByTestId("video-generation-review-overlay")).toBeNull();
      expect(submitVideoGenerationTake).not.toHaveBeenCalled();
      const freshReview = h.bridge.onVideoGenerationRequest(h.request);
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      expect(prepareVideoGeneration.mock.calls.at(-1)?.[1]).toBe(second.token);
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Cancel" })));
      await expect(freshReview).resolves.toEqual({ kind: "cancelled" });
      expect(submitVideoGenerationTake).not.toHaveBeenCalled();
    } finally { h.rendered.unmount(); registry.clear(); }
  });

  test.each(["success", "expired"])("late %s from an old Video observation cannot cross renewal", async (outcome) => {
    const h = await mountRecoveryVideo();
    let finish!: (value: { takes: [] }) => void;
    let fail!: (reason: unknown) => void;
    listVideoGenerationTakes.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const stale = h.bridge.onVideoGenerationListTakes();
    try {
      issueVideoHostAttestation.mockImplementationOnce(async () => ({ attestationToken: "b".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" }));
      getVideoGenerationTakeStatus.mockImplementationOnce(async () => { throw new ApiError(410, "host_expired"); });
      await act(async () => { await h.bridge.onVideoGenerationGetTakeStatus({ takeId: "take_abcdefghijklmnop" }); });
      await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalledTimes(2));
      await act(async () => { if (outcome === "success") finish({ takes: [] }); else fail(new ApiError(410, "old_host_expired")); });
      expect(await stale).toMatchObject({ kind: "unavailable" });
      expect(issueVideoHostAttestation).toHaveBeenCalledTimes(2);
      expect(submitVideoGenerationTake).not.toHaveBeenCalled();
    } finally { h.rendered.unmount(); }
  });

  test.each(["renewal", "document", "identity", "sign-out", "unmount"])("late Video quote cannot reopen review after %s", async (change) => {
    const h = await mountRecoveryVideo();
    let finish!: (value: ReturnType<typeof videoReviewFixture>) => void;
    prepareVideoGeneration.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.bridge.onVideoGenerationRequest(h.request);
    try {
      await waitFor(() => expect(prepareVideoGeneration).toHaveBeenCalledTimes(1));
      if (change === "renewal") {
        getVideoGenerationTakeStatus.mockImplementationOnce(async () => { throw new ApiError(410, "host_expired"); });
        await act(async () => { await h.bridge.onVideoGenerationGetTakeStatus({ takeId: "take_abcdefghijklmnop" }); });
        await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalledTimes(2));
      } else if (change === "document") {
        h.rendered.rerender(<MiniAppSurface appId="nautilo-video" target={{ ...h.target, id: "other-document", path: "other.video.html" }} onClose={() => {}} />);
      } else if (change === "identity" || change === "sign-out") {
        testViewer = { isVerified: change === "identity", sessionUserId: "other-viewer" };
        h.rendered.rerender(<MiniAppSurface appId="nautilo-video" target={h.target} onClose={() => {}} />);
      } else h.rendered.unmount();
      await act(async () => { finish(videoReviewFixture()); });
      await expect(pending).resolves.toEqual({ kind: "expired" });
      expect(h.rendered.queryByTestId("video-generation-review-overlay")).toBeNull();
      expect(submitVideoGenerationTake).not.toHaveBeenCalled();
    } finally { h.rendered.unmount(); }
  });

  test.each([403, 410])("server rejection %i on an explicitly approved review never resubmits automatically", async (status) => {
    const h = await mountRecoveryVideo();
    try {
      const pending = h.bridge.onVideoGenerationRequest(h.request);
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      submitVideoGenerationTake.mockImplementationOnce(async () => { throw new ApiError(status, status === 403 ? "permission_revoked" : "quote_expired"); });
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Generate · $0.10" })));
      await expect(pending).resolves.toEqual({ kind: "expired" });
      await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalledTimes(2));
      expect(h.rendered.queryByTestId("video-generation-review-overlay")).toBeNull();
      expect(submitVideoGenerationTake).toHaveBeenCalledTimes(1);
      expect(prepareVideoGeneration).toHaveBeenCalledTimes(1);
    } finally { h.rendered.unmount(); }
  });

  test.each(["close", "session change"])("classifies %s after an unconfirmed submit as submission-unknown", async (change) => {
    const h = await mountRecoveryVideo();
    try {
      const pending = h.bridge.onVideoGenerationRequest(h.request);
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      submitVideoGenerationTake.mockImplementationOnce(async () => { throw new Error("response lost"); });
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Generate · $0.10" })));
      await waitFor(() => expect(h.rendered.getAllByRole("alert").at(-1)?.textContent).toContain("check this scene’s takes"));
      if (change === "close") {
        await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Cancel" })));
      } else {
        getVideoGenerationTakeStatus.mockImplementationOnce(async () => { throw new ApiError(410, "host_expired"); });
        await act(async () => { await h.bridge.onVideoGenerationGetTakeStatus({ takeId: "take_abcdefghijklmnop" }); });
      }
      await expect(pending).resolves.toEqual({ kind: "submission-unknown", takeId: "take_1234567890abcdef" });
      expect(submitVideoGenerationTake).toHaveBeenCalledTimes(1);
      expect(prepareVideoGeneration).toHaveBeenCalledTimes(1);
    } finally { h.rendered.unmount(); }
  });

  test("keeps clean preapproval cancellation distinct from submission uncertainty", async () => {
    const h = await mountRecoveryVideo();
    try {
      const pending = h.bridge.onVideoGenerationRequest(h.request);
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Cancel" })));
      await expect(pending).resolves.toEqual({ kind: "cancelled" });
      expect(submitVideoGenerationTake).not.toHaveBeenCalled();
    } finally { h.rendered.unmount(); }
  });

  test("retains submission uncertainty when a same-handle retry later reports expiry", async () => {
    const h = await mountRecoveryVideo();
    try {
      const pending = h.bridge.onVideoGenerationRequest(h.request);
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      submitVideoGenerationTake
        .mockImplementationOnce(async () => { throw new Error("response lost"); })
        .mockImplementationOnce(async () => { throw new ApiError(410, "quote_expired"); });
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Generate · $0.10" })));
      await waitFor(() => expect(h.rendered.getAllByRole("alert").at(-1)?.textContent).toContain("Retry this same approval"));
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Generate · $0.10" })));
      await expect(pending).resolves.toEqual({ kind: "submission-unknown", takeId: "take_1234567890abcdef" });
      expect(submitVideoGenerationTake).toHaveBeenCalledTimes(2);
      expect(prepareVideoGeneration).toHaveBeenCalledTimes(1);
      expect(h.rendered.queryByText(/fresh generation/i)).toBeNull();
    } finally { h.rendered.unmount(); }
  });

  test("late paid response cannot close a new review after host renewal", async () => {
    const h = await mountRecoveryVideo();
    let finish!: (value: { state: string }) => void;
    try {
      const pending = h.bridge.onVideoGenerationRequest(h.request);
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      submitVideoGenerationTake.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Generate · $0.10" })));
      getVideoGenerationTakeStatus.mockImplementationOnce(async () => { throw new ApiError(410, "host_expired"); });
      await act(async () => { await h.bridge.onVideoGenerationGetTakeStatus({ takeId: "take_abcdefghijklmnop" }); });
      await expect(pending).resolves.toEqual({ kind: "submission-unknown", takeId: "take_1234567890abcdef" });
      await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalledTimes(2));
      const next = h.bridge.onVideoGenerationRequest({ ...h.request, requestId: "request-video-next" });
      await waitFor(() => expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull());
      await act(async () => { finish({ state: "queued" }); });
      expect(h.rendered.queryByTestId("video-generation-review-overlay")).not.toBeNull();
      expect(submitVideoGenerationTake).toHaveBeenCalledTimes(1);
      await act(async () => fireEvent.click(h.rendered.getByRole("button", { name: "Cancel" })));
      await expect(next).resolves.toEqual({ kind: "cancelled" });
    } finally { h.rendered.unmount(); }
  });

  test("issues parent-only Video host attestation and opens a once/cancel review", async () => {
    const brief = setSimpleGenerationPrompt(createEmptyGenerationBrief(), "A slow coastal flight.");
    const document = { sha256: "a".repeat(64), revision: 3 };
    const source = { kind: "quick-brief" as const };
    const settings = { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" };
    const draft = await buildVideoGenerationPlanDraft(brief, { version: 1, document, scope: source,
      jobs: [{ source, modelId: VIDEO_GENERATION_CATALOG_MODELS.seedance, settings }] });
    if (draft.status !== "ready-for-quote") throw new Error("Expected saved direction to compile");
    const job = draft.jobs[0];
    const content = serializeVideoHtml(createDefaultManifest(), { ...createEmptyProject(), generationBrief: brief });
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "project.video.html",
      mimeType: "text/html",
      roomId: "room-1",
    };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>",
      hostCapabilities: { videoGeneration: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.1.0", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content, mimeType: "text/html", path: target.path, baseSha256: document.sha256, baseRevision: document.revision };
      session.envelope = envelope;
      return envelope;
    });
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalledWith({
      roomId: "room-1", projectArtifactId: "external-video-project-1", sourceHash: "d".repeat(64),
    }));
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    expect(bridge).toMatchObject({ videoGeneration: true });
    const pendingResult = bridge.onVideoGenerationRequest({
      requestId: "request-video-1", document, sourceFingerprint: draft.sourceFingerprint,
      job: { source, prompt: job.prompt, modelId: job.catalogModelId, requestedSettings: settings },
    });
    await waitFor(() => expect(prepareVideoGeneration).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-1", projectArtifactId: "external-video-project-1", briefDigest: draft.sourceFingerprint,
      job: { modelId: job.catalogModelId, prompt: job.prompt, ...settings },
    }), "a".repeat(43)));
    expect(rendered.getByTestId("video-generation-review-overlay").textContent).toContain("One paid generation. No automatic retry.");
    expect(rendered.container.innerHTML).not.toContain("review-private-handle");
    expect(submitVideoGenerationTake).not.toHaveBeenCalled();
    let submitAttempt = 0;
    submitVideoGenerationTake.mockImplementation(async () => {
      submitAttempt += 1;
      if (submitAttempt === 1) throw new Error("temporary outage");
      return { state: "queued" };
    });
    let settled = false;
    void pendingResult.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    await act(async () => {
      fireEvent.click(rendered.getByRole("button", { name: "Generate · $0.10" }));
    });
    await waitFor(() => expect(rendered.getAllByRole("alert").at(-1)?.textContent).toContain("Retry this same approval"));
    expect(settled).toBe(false);
    await act(async () => {
      fireEvent.click(rendered.getByRole("button", { name: "Generate · $0.10" }));
    });
    await expect(pendingResult).resolves.toEqual({ kind: "queued", takeId: "take_1234567890abcdef" });
    expect(submitVideoGenerationTake).toHaveBeenCalledWith("take_1234567890abcdef", expect.objectContaining({
      reviewHandle: "review-private-handle", attestationToken: "a".repeat(43),
    }));
    expect(submitVideoGenerationTake).toHaveBeenCalledTimes(2);
    rendered.unmount();
    await waitFor(() => expect(revokeVideoHostAttestation).toHaveBeenCalledWith("a".repeat(43)));
  });

  test("admits mixed Workspace media through native streaming receipts without renderer upload", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 };
      session.envelope = envelope; return envelope;
    });
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    expect(issueVideoHostAttestation).not.toHaveBeenCalled();
    const importFromComputer = async () => {
      const pending = bridge.onVideoWorkspaceMediaImport();
      await waitFor(() => expect(rendered.getByRole("button", { name: "Upload from computer" })).toBeTruthy());
      fireEvent.click(rendered.getByRole("button", { name: "Upload from computer" }));
      return pending;
    };
    for (const kind of ["video", "image", "audio"] as const) {
      importWorkspaceMock.mockImplementationOnce(async () => nativeReceipt(kind));
      const imported = await importFromComputer();
      expect(imported).toMatchObject({ kind: "ready", label: "Opening take", source: { kind: "workspace-artifact", artifactId: nativeReceipt(kind).data.artifact.artifactId } });
      expect(importWorkspaceMock).toHaveBeenLastCalledWith({ requestId: expect.any(String), roomId: "room-1" });
    }
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    expect(getWorkspaceArtifactBytesArrayBuffer).not.toHaveBeenCalled();
    for (const invalid of [
      { ...nativeReceipt().data, label: "bad\nlabel" },
      { ...nativeReceipt("image").data, durationSec: 1 },
      { ...nativeReceipt("audio").data, artifact: { ...nativeReceipt("audio").data.artifact, mimeType: "image/png" } },
    ]) {
      importWorkspaceMock.mockImplementationOnce(async () => ({ ok: true, data: invalid }));
      await expect(importFromComputer()).resolves.toEqual({ kind: "unavailable", code: "invalid_response" });
      expect(deleteWorkspaceArtifact).toHaveBeenCalledWith(importedRowId, { roomId: "room-1" });
    }
    importWorkspaceMock.mockImplementationOnce(async () => ({ ok: false, error: { code: "upload_unknown" } }));
    const calls = importWorkspaceMock.mock.calls.length;
    await expect(importFromComputer()).resolves.toEqual({ kind: "unavailable", code: "upload_unknown" });
    expect(importWorkspaceMock).toHaveBeenCalledTimes(calls + 1);
    rendered.unmount();
  });

  test("imports existing scoped Workspace media without uploading or duplicating it", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    const media = { id: "00000000-0000-4000-8000-000000000099", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc99", path: "Media/My opening take.mp4", mimeType: "video/mp4", size: 4096, revision: 2, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", namespaceIds: [], canWrite: true };
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => { const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 }; session.envelope = envelope; return envelope; });
    loadMiniAppRuntime.mockImplementationOnce(async () => ({ appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { mediaProxy: true as const }, manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} } }));
    listAllWorkspaceArtifacts.mockResolvedValueOnce({ artifacts: [media, { ...media, id: "other", mimeType: "text/plain", path: "notes.txt" }] });
    getWorkspaceArtifact.mockResolvedValueOnce(media);
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    const pending = bridge.onVideoWorkspaceMediaImport();
    await waitFor(() => expect(rendered.getByText("My opening take.mp4")).toBeTruthy());
    expect(rendered.queryByText("notes.txt")).toBeNull();
    fireEvent.click(rendered.getByText("My opening take.mp4").closest("button")!);
    await expect(pending).resolves.toEqual({ kind: "ready", mediaRef: media.path, label: "My opening take.mp4", durationSec: 4.25, frameRate: { numerator: 24, denominator: 1 }, source: { kind: "workspace-artifact", artifactId: media.artifactId, path: media.path } });
    expect(listAllWorkspaceArtifacts).toHaveBeenCalledWith({ roomId: "room-1", signal: expect.any(AbortSignal) });
    expect(getWorkspaceArtifact).toHaveBeenCalledWith(media.id, { roomId: "room-1" });
    expect(importWorkspaceMock).not.toHaveBeenCalled();
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    expect(closeWorkspaceMock).toHaveBeenCalledWith(nativePreviewToken);
    rendered.unmount();
  });

  test("picker thumbnails use exact scoped native previews and revoke a late response after close", async () => {
    const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
      unobserve() {} disconnect() {}
    } });
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    const media = { id: "00000000-0000-4000-8000-000000000099", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc99", path: "Media/Character.png", mimeType: "image/png", size: 4096, revision: 2, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", namespaceIds: [], canWrite: true };
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => { const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 }; session.envelope = envelope; return envelope; });
    loadMiniAppRuntime.mockImplementationOnce(async () => ({ appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { mediaProxy: true as const }, manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} } }));
    listAllWorkspaceArtifacts.mockResolvedValueOnce({ artifacts: [media] });
    let finish!: (value: unknown) => void;
    openWorkspaceMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    try {
      await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
      const pending = installAppBridge.mock.calls.at(-1)?.[0].onVideoWorkspaceMediaImport();
      await waitFor(() => expect(openWorkspaceMock).toHaveBeenCalledWith({ requestId: expect.any(String), roomId: "room-1", artifact: media }));
      fireEvent.click(rendered.getByRole("button", { name: "Close media picker" }));
      await expect(pending).resolves.toEqual({ kind: "unavailable", code: "cancelled" });
      expect(cancelWorkspaceMock).toHaveBeenCalledWith(openWorkspaceMock.mock.calls[0]?.[0].requestId);
      finish({ ok: true, data: { url: nativePreviewUrl, revokeToken: nativePreviewToken, mimeType: media.mimeType, sizeBytes: media.size, mediaKind: "image" } });
      await waitFor(() => expect(closeWorkspaceMock).toHaveBeenCalledWith(nativePreviewToken));
      expect(rendered.queryByRole("dialog", { name: "Import media" })).toBeNull();
      closeWorkspaceMock.mockClear();
      listAllWorkspaceArtifacts.mockResolvedValueOnce({ artifacts: [media] });
      openWorkspaceMock.mockImplementationOnce(async () => ({ ok: true, data: { url: nativePreviewUrl, revokeToken: nativePreviewToken, mimeType: media.mimeType, sizeBytes: media.size, mediaKind: "video", durationSec: 1 } }));
      const second = installAppBridge.mock.calls.at(-1)?.[0].onVideoWorkspaceMediaImport();
      await waitFor(() => expect(closeWorkspaceMock).toHaveBeenCalledWith(nativePreviewToken));
      expect(rendered.getByRole("dialog", { name: "Import media" }).querySelector("img,video")).toBeNull();
      fireEvent.click(rendered.getByRole("button", { name: "Close media picker" }));
      await expect(second).resolves.toEqual({ kind: "unavailable", code: "cancelled" });
      expect(importWorkspaceMock).not.toHaveBeenCalled();
      expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
      if (observerDescriptor) Object.defineProperty(globalThis, "IntersectionObserver", observerDescriptor);
      else Reflect.deleteProperty(globalThis, "IntersectionObserver");
    }
  });

  test("rejects a deferred selected-row read after the authenticated viewer changes", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    const media = { id: "00000000-0000-4000-8000-000000000099", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc99", path: "Media/take.mp4", mimeType: "video/mp4", size: 4096, revision: 2, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", namespaceIds: [], canWrite: true };
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => { const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 }; session.envelope = envelope; return envelope; });
    loadMiniAppRuntime.mockImplementationOnce(async () => ({ appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { mediaProxy: true as const }, manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} } }));
    listAllWorkspaceArtifacts.mockResolvedValueOnce({ artifacts: [media] });
    let resolveRead!: (value: typeof media) => void;
    getWorkspaceArtifact.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const pending = installAppBridge.mock.calls.at(-1)?.[0].onVideoWorkspaceMediaImport();
    await waitFor(() => expect(rendered.getByText("take.mp4")).toBeTruthy());
    fireEvent.click(rendered.getByText("take.mp4").closest("button")!);
    await waitFor(() => expect(getWorkspaceArtifact).toHaveBeenCalledWith(media.id, { roomId: "room-1" }));
    const previewCalls = openWorkspaceMock.mock.calls.length;
    testViewer = { isVerified: true, sessionUserId: "another-viewer" };
    rendered.rerender(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await expect(pending).resolves.toEqual({ kind: "unavailable", code: "stale_project" });
    await act(async () => { resolveRead(media); await Promise.resolve(); });
    expect(openWorkspaceMock).toHaveBeenCalledTimes(previewCalls);
    rendered.unmount();
  });

  test("admits a picked image reference only through the bound Workspace Video project", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { videoGeneration: true as const, mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 };
      session.envelope = envelope; return envelope;
    });
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalled());
    importWorkspaceMock.mockImplementationOnce(async () => nativeReceipt("image", "Character reference"));
    expect(await bridge.onVideoGenerationImportReference({ mediaKind: "image" })).toMatchObject({
      kind: "ready", asset: { label: "Character reference", mediaKind: "image", mimeType: "image/png", sizeBytes: 12 },
    });
    expect(importWorkspaceMock).toHaveBeenLastCalledWith({ requestId: expect.any(String), roomId: "room-1", mediaKind: "image" });
    await expect(bridge.onVideoGenerationImportReference({ mediaKind: "audio" })).resolves.toEqual({ kind: "unavailable", code: "cancelled" });
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    rendered.unmount();
  });

  test("opens a saved Workspace reference without a project.media mirror and rejects absent or ambiguous ids", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    const artifactId = "48a0266d-b1c2-4ffd-9c10-2865bea8fc53";
    const referencePath = "video imports/Character reference.png";
    const reference = { id: "reference-image", name: "Character", mediaKind: "image" as const,
      source: { kind: "workspace-artifact" as const, artifactId, path: referencePath, mimeType: "image/png", sizeBytes: 12 } };
    const project = createEmptyProject();
    const brief = createEmptyGenerationBrief();
    brief.references = [reference];
    expect(brief.blocks).toEqual([]);
    project.generationBrief = brief;
    expect(project.media).toEqual([]);
    let content = serializeVideoHtml(createDefaultManifest(), project, { touchMetadata: false });
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content, mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 };
      session.envelope = envelope; return envelope;
    });
    listWorkspaceArtifacts.mockImplementation(async () => ({ artifacts: [{ id: "row-reference", artifactId, path: referencePath, mimeType: "image/png", size: 12 }] }));
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    await expect(bridge.onVideoWorkspaceMediaOpenPreview({ referenceId: reference.id, signal: new AbortController().signal })).resolves.toMatchObject({
      kind: "ready", mimeType: "image/png", sizeBytes: 12,
    });
    expect(listWorkspaceArtifacts).toHaveBeenLastCalledWith({ roomId: "room-1", pathPrefix: referencePath });
    expect(openWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({ artifact: expect.objectContaining({ artifactId }) }));
    const onDocumentVersion = installAppBridge.mock.calls.at(-1)?.[0]?.onDocumentVersion;
    await act(async () => onDocumentVersion?.({ kind: "artifact_revision", revision: 2 }));
    expect(closeWorkspaceMock).not.toHaveBeenCalled();

    await expect(bridge.onVideoWorkspaceMediaOpenPreview({ referenceId: "absent-reference", signal: new AbortController().signal })).resolves.toEqual({ kind: "unavailable", code: "unavailable" });
    brief.blocks = [
      { id: "reference-board", kind: "references", references: [reference] },
      { id: "second-reference-board", kind: "references", references: [{ ...reference }] },
    ];
    project.generationBrief = brief;
    content = serializeVideoHtml(createDefaultManifest(), project, { touchMetadata: false });
    await expect(bridge.onVideoWorkspaceMediaOpenPreview({ referenceId: reference.id, signal: new AbortController().signal })).resolves.toEqual({ kind: "unavailable", code: "unavailable" });
    expect(openWorkspaceMock).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  test("imports ordered image references with explicit mixed failures and cancellation", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { videoGeneration: true as const, mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 };
      session.envelope = envelope; return envelope;
    });
    const imageResult = (id: string, artifactId: string, label: string) => ({ ok: true as const, data: { label, mediaKind: "image" as const,
      artifact: { id, artifactId, path: `video-imports/${id}.png`, mimeType: "image/png", size: 12 } } });
    let finishBatch!: (value: { ok: true; data: { results: unknown[] } }) => void;
    importWorkspaceBatchMock.mockImplementationOnce(() => new Promise((resolve) => { finishBatch = resolve; }));
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    const importing = bridge.onVideoGenerationImportReferences({ mediaKind: "image" });
    await waitFor(() => expect(importWorkspaceBatchMock).toHaveBeenCalledTimes(1));
    const onDocumentVersion = installAppBridge.mock.calls.at(-1)?.[0]?.onDocumentVersion;
    await act(async () => onDocumentVersion?.({ kind: "artifact_revision", revision: 2 }));
    expect(cancelWorkspaceMock).not.toHaveBeenCalled();
    finishBatch({ ok: true, data: { results: [
      imageResult("row-first", "48a0266d-b1c2-4ffd-9c10-2865bea8fc51", "First"),
      { ok: false as const, label: "Broken image", error: { code: "decode_failed" } },
      imageResult("row-second", "48a0266d-b1c2-4ffd-9c10-2865bea8fc52", "Second"),
    ] } });
    await expect(importing).resolves.toMatchObject({
      kind: "ready",
      assets: [{ label: "First", path: "video-imports/row-first.png" }, { label: "Second", path: "video-imports/row-second.png" }],
      failures: [{ label: "Broken image", code: "decode_failed" }],
    });
    expect(importWorkspaceBatchMock).toHaveBeenLastCalledWith({ requestId: expect.any(String), roomId: "room-1", mediaKind: "image" });
    expect(deleteWorkspaceArtifact).not.toHaveBeenCalled();
    await expect(bridge.onVideoGenerationImportReferences({ mediaKind: "image" })).resolves.toEqual({ kind: "unavailable", code: "cancelled" });
    rendered.unmount();
  });

  test.each(["target", "auth"])("deletes every successful batch artifact when the bound %s changes during import", async (change) => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { videoGeneration: true as const, mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 };
      session.envelope = envelope; return envelope;
    });
    let finish!: (value: any) => void;
    importWorkspaceBatchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    const importing = bridge.onVideoGenerationImportReferences({ mediaKind: "image" });
    await waitFor(() => expect(importWorkspaceBatchMock).toHaveBeenCalledTimes(1));
    const requestId = (importWorkspaceBatchMock.mock.calls[0]![0] as { requestId: string }).requestId;
    if (change === "target") {
      rendered.rerender(<MiniAppSurface appId="nautilo-video" target={{ ...target, id: "artifact-row-2", path: "next.video.html" }} onClose={() => {}} />);
    } else {
      testViewer = { isVerified: true, sessionUserId: "another-viewer" };
      rendered.rerender(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    }
    finish({ ok: true, data: { results: [
      { ok: true, data: { label: "First", mediaKind: "image", artifact: { id: "row-first", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc51", path: "video-imports/first.png", mimeType: "image/png", size: 12 } } },
      { ok: true, data: { label: "Second", mediaKind: "image", artifact: { id: "row-second", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc52", path: "video-imports/second.png", mimeType: "image/png", size: 12 } } },
    ] } });
    await expect(importing).resolves.toEqual({ kind: "unavailable", code: "stale_project" });
    await waitFor(() => {
      expect(deleteWorkspaceArtifact).toHaveBeenCalledWith("row-first", { roomId: "room-1" });
      expect(deleteWorkspaceArtifact).toHaveBeenCalledWith("row-second", { roomId: "room-1" });
    });
    expect(cancelWorkspaceMock).toHaveBeenCalledWith(requestId);
    rendered.unmount();
  });

  test("exports the canonical Workspace timeline with exact source bindings and no renderer byte download", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "test_video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.1.0", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    const artifactId = "48a0266d-b1c2-4ffd-9c10-2865bea8fc53";
    const project = createEmptyProject();
    project.media = [
      { id: "media_used", kind: "video", ref: "media/take.mp4", lifecycle: "durable", durationSec: 4, source: { kind: "workspace-artifact", artifactId, path: "media/take.mp4" } },
      { id: "media_unused", kind: "video", ref: "unavailable.mp4" },
    ];
    const track = project.sequences[0]!.tracks[0]!;
    track.clips.push({ id: "clip_take", trackId: track.id, kind: "video", mediaId: "media_used", timelineStartSec: 0, sourceInSec: 1, durationSec: 2 });
    project.sequences[0]!.durationSec = 2;
    const content = serializeVideoHtml(createDefaultManifest(), project, { touchMetadata: false });
    const envelope = { content, mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 4 };
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => { session.envelope = envelope; return envelope; });
    const artifact = { id: "row-source", artifactId, path: "media/take.mp4", mimeType: "video/mp4", size: 3 * 1024 ** 3 };
    listWorkspaceArtifacts.mockImplementation(async () => ({ artifacts: [artifact] }));
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    const onProgress = mock((_progress: unknown) => {});
    const exportSettings = { resolution: "720p", quality: "custom", videoBitrateKbps: 4500, audioBitrateKbps: 320 } as const;
    const input = { requestId: "export-test", sha256: envelope.baseSha256, revision: 4, publishToWorkspace: true, exportSettings, signal: new AbortController().signal, onProgress };
    const nativeExporter = (await import("../lib/desktop")).desktopAPI!.mediaExport!;
    delete nativeExporter.supportsExportSettings;
    try {
      await expect(bridge.onVideoWorkspaceMediaExport(input)).resolves.toEqual({ kind: "unavailable", code: "export_settings_unsupported" });
      expect(startWorkspaceExportMock).not.toHaveBeenCalled();
    } finally { nativeExporter.supportsExportSettings = true; }
    const publication = { status: "published" as const, path: "exports/cut.mp4", artifactId };
    startWorkspaceExportMock.mockImplementationOnce(async () => {
      exportProgressHandler?.({ requestId: "not-ours", progress: { stage: "saving" } });
      exportProgressHandler?.({ requestId: input.requestId, progress: { stage: "rendering", processedTimeUs: 200_000 } });
      exportProgressHandler?.({ requestId: input.requestId, progress: { stage: "publishing" } });
      return { ok: true as const, data: { status: "succeeded" as const, label: "cut.mp4", sizeBytes: 2048, warnings: [], workspace: publication } };
    });
    await expect(bridge.onVideoWorkspaceMediaExport(input)).resolves.toEqual({ kind: "succeeded", label: "cut.mp4", sizeBytes: 2048, warnings: [], workspace: publication });
    expect(startWorkspaceExportMock).toHaveBeenCalledWith({ requestId: input.requestId, documentContent: content, expectedSha256: input.sha256, roomId: "room-1", publishToWorkspace: true, exportSettings, sources: [
      { mediaId: "media_used", artifactRowId: "row-source", artifactId, path: artifact.path, mimeType: artifact.mimeType, sizeBytes: artifact.size },
    ] });
    expect(listWorkspaceArtifacts).toHaveBeenLastCalledWith({ roomId: "room-1", pathPrefix: artifact.path });
    expect(getWorkspaceArtifactBytesArrayBuffer).not.toHaveBeenCalled();
    expect(issueVideoHostAttestation).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([{ stage: "preparing" }, { stage: "rendering", processedTimeUs: 200_000 }, { stage: "publishing" }]);
    expect(unsubscribeExportMock).toHaveBeenCalledTimes(1);

    startWorkspaceExportMock.mockClear();
    await expect(bridge.onVideoWorkspaceMediaExport({ ...input, revision: 3 })).resolves.toEqual({ kind: "unavailable", code: "document_changed" });
    listWorkspaceArtifacts.mockImplementationOnce(async () => ({ artifacts: [{ ...artifact, artifactId: "another-id" }] }));
    await expect(bridge.onVideoWorkspaceMediaExport(input)).resolves.toEqual({ kind: "unavailable", code: "source_unavailable" });
    listWorkspaceArtifacts.mockImplementationOnce(async () => ({ artifacts: [artifact, artifact] }));
    await expect(bridge.onVideoWorkspaceMediaExport(input)).resolves.toEqual({ kind: "unavailable", code: "source_unavailable" });
    expect(startWorkspaceExportMock).not.toHaveBeenCalled();

    const controller = new AbortController();
    listWorkspaceArtifacts.mockImplementationOnce(async () => { controller.abort(); return { artifacts: [artifact] }; });
    await expect(bridge.onVideoWorkspaceMediaExport({ ...input, signal: controller.signal })).resolves.toEqual({ kind: "cancelled" });
    expect(startWorkspaceExportMock).not.toHaveBeenCalled();

    const nativeController = new AbortController();
    startWorkspaceExportMock.mockImplementationOnce(async () => {
      nativeController.abort();
      // Publication won the race with a late cancel. Preserve that truth.
      return { ok: true as const, data: { status: "succeeded" as const, label: "cut.mp4", sizeBytes: 2048, warnings: [] } };
    });
    await expect(bridge.onVideoWorkspaceMediaExport({ ...input, signal: nativeController.signal })).resolves.toMatchObject({ kind: "succeeded" });
    expect(cancelExportMock).toHaveBeenCalledWith(input.requestId);
    expect(exportProgressHandler).toBeUndefined();

    startWorkspaceExportMock.mockClear();
    listWorkspaceArtifacts.mockImplementationOnce(async () => {
      rendered.rerender(<MiniAppSurface appId="nautilo-video" target={{ ...target, id: "another-project" }} onClose={() => {}} />);
      return { artifacts: [artifact] };
    });
    await expect(bridge.onVideoWorkspaceMediaExport(input)).resolves.toEqual({ kind: "cancelled" });
    expect(startWorkspaceExportMock).not.toHaveBeenCalled();
    rendered.unmount();
  });

  test("opens durable Workspace audio and images without a generation session", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "test_video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.1.0", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    const artifactId = "48a0266d-b1c2-4ffd-9c10-2865bea8fc53";
    const content = validVideoDocument([
      { id: "media_audio", kind: "audio", ref: "media/voice.wav", lifecycle: "durable", durationSec: 2, source: { kind: "workspace-artifact", artifactId, path: "media/voice.wav" } },
      { id: "media_image", kind: "image", ref: "media/still.png", lifecycle: "durable", source: { kind: "workspace-artifact", artifactId, path: "media/still.png" } },
    ]);
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content, mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 };
      session.envelope = envelope; return envelope;
    });
    listWorkspaceArtifacts.mockImplementation(async ({ pathPrefix }: { pathPrefix: string }) => ({ artifacts: [{
      id: pathPrefix.endsWith("wav") ? "row-audio" : "row-image", artifactId, path: pathPrefix,
      mimeType: pathPrefix.endsWith("wav") ? "audio/wav" : "image/png", size: 12,
    }] }));
    getWorkspaceArtifactBytesArrayBuffer.mockImplementation(async (rowId: string) => rowId === "row-audio"
      ? new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WAVE")]).buffer
      : new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer);
    const originalCreateElement = document.createElement.bind(document);
    const originalCreateUrl = URL.createObjectURL;
    URL.createObjectURL = mock(() => "blob:workspace-media") as never;
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (tagName === "audio") {
        Object.defineProperty(element, "duration", { configurable: true, get: () => 2 });
        (element as HTMLMediaElement).load = () => queueMicrotask(() => element.dispatchEvent(new Event("loadedmetadata")));
      }
      return element;
    }) as typeof document.createElement;
    try {
      const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
      await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
      expect(issueVideoHostAttestation).not.toHaveBeenCalled();
      const bridge = installAppBridge.mock.calls.at(-1)?.[0];
      await expect(bridge.onVideoWorkspaceMediaOpenPreview({ mediaId: "media_audio", signal: new AbortController().signal })).resolves.toMatchObject({ kind: "ready", mimeType: "audio/wav" });
      await expect(bridge.onVideoWorkspaceMediaOpenPreview({ mediaId: "media_image", signal: new AbortController().signal })).resolves.toMatchObject({ kind: "ready", mimeType: "image/png" });
      rendered.unmount();
    } finally {
      document.createElement = originalCreateElement;
      URL.createObjectURL = originalCreateUrl;
    }
  });

  test("deletes an unattached reference when the bound project changes during upload", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { videoGeneration: true as const, mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 };
      session.envelope = envelope; return envelope;
    });
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    let resolveUpload!: (value: ReturnType<typeof nativeReceipt>) => void;
    importWorkspaceMock.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const importing = bridge.onVideoGenerationImportReference({ mediaKind: "image" });
    await waitFor(() => expect(importWorkspaceMock).toHaveBeenCalledTimes(1));
    const requestId = (importWorkspaceMock.mock.calls[0]![0] as { requestId: string }).requestId;
    rendered.rerender(<MiniAppSurface appId="nautilo-video" target={{ ...target, id: "artifact-row-2", path: "next.video.html" }} onClose={() => {}} />);
    resolveUpload(nativeReceipt("image"));
    await expect(importing).resolves.toEqual({ kind: "unavailable", code: "stale_project" });
    await waitFor(() => expect(deleteWorkspaceArtifact).toHaveBeenCalledWith(importedRowId, { roomId: "room-1" }));
    expect(cancelWorkspaceMock).toHaveBeenCalledWith(requestId);
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    rendered.unmount();
  });

  test("deletes an unattached ordinary media import when navigation wins the upload race", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.2.1", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = { content: validVideoDocument(), mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 1 };
      session.envelope = envelope; return envelope;
    });
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridge = installAppBridge.mock.calls.at(-1)?.[0];
    let resolveUpload!: (value: ReturnType<typeof nativeReceipt>) => void;
    importWorkspaceMock.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const importing = bridge.onVideoWorkspaceMediaImport();
    await waitFor(() => fireEvent.click(rendered.getByRole("button", { name: "Upload from computer" })));
    await waitFor(() => expect(importWorkspaceMock).toHaveBeenCalledTimes(1));
    const requestId = (importWorkspaceMock.mock.calls[0]![0] as { requestId: string }).requestId;
    rendered.rerender(<MiniAppSurface appId="nautilo-video" target={{ ...target, id: "artifact-row-2", path: "next.video.html" }} onClose={() => {}} />);
    resolveUpload(nativeReceipt("video"));
    await expect(importing).resolves.toEqual({ kind: "unavailable", code: "stale_project" });
    await waitFor(() => expect(deleteWorkspaceArtifact).toHaveBeenCalledWith(importedRowId, { roomId: "room-1" }));
    expect(cancelWorkspaceMock).toHaveBeenCalledWith(requestId);
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    rendered.unmount();
  });

  test("keeps generated-take discovery, preview, and measured promotion revalidation in the attested parent", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { videoGeneration: true as const, mediaProxy: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.1.0", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    listVideoGenerationTakes.mockImplementation(async () => ({ takes: [{ takeId: "take_abcdefghijklmnop", shotId: "quick-brief", shotLabel: "Quick brief", documentRevision: 4 }] }));
    listWorkspaceArtifacts.mockImplementation(async () => ({ artifacts: [{ id: "internal-artifact-row", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/take.mp4", mimeType: "video/mp4", size: 4 }] }));
    const originalCreateElement = document.createElement.bind(document);
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = mock(() => "blob:parent-preview") as never;
    URL.revokeObjectURL = mock(() => {}) as never;
    try {
      const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
      await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalled());
      document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
        const element = originalCreateElement(tagName, options);
        if (tagName === "video" || tagName === "audio") {
          Object.defineProperty(element, "duration", { configurable: true, get: () => 4.25 });
          (element as HTMLMediaElement).load = () => queueMicrotask(() => element.dispatchEvent(new Event("loadedmetadata")));
        }
        return element;
      }) as typeof document.createElement;
      const bridge = installAppBridge.mock.calls.at(-1)?.[0];
      await expect(bridge.onVideoGenerationListTakes()).resolves.toEqual({ kind: "ready", takes: [{ takeId: "take_abcdefghijklmnop", shotId: "quick-brief", shotLabel: "Quick brief", documentRevision: 4 }] });
      const status = await bridge.onVideoGenerationGetTakeStatus({ takeId: "take_abcdefghijklmnop" });
      expect(status.status.recoveryActions).toEqual([]);
      expect(JSON.stringify(status)).not.toContain("review-private-handle");
      let preview: unknown;
      await act(async () => { preview = await bridge.onVideoGenerationPreviewTake({ takeId: "take_abcdefghijklmnop" }); });
      expect(preview).toEqual({ kind: "opened" });
      expect(getWorkspaceArtifactBytesArrayBuffer).not.toHaveBeenCalled();
      expect(openWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1", artifact: expect.objectContaining({ artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53" }) }));
      expect(listWorkspaceArtifacts).toHaveBeenCalledWith({ roomId: "room-1", pathPrefix: "generated-media/take.mp4" });
      const dialog = rendered.getByRole("dialog", { name: "Generated take preview" });
      expect(dialog.textContent).toContain("Quick brief");
      const closePreview = rendered.getByRole("button", { name: "Close preview" });
      expect(document.activeElement).toBe(closePreview);
      await act(async () => { fireEvent.keyDown(dialog, { key: "Escape" }); });
      expect(rendered.queryByRole("dialog", { name: "Generated take preview" })).toBeNull();
      expect(closeWorkspaceMock).toHaveBeenCalledWith(nativePreviewToken);
      expect(document.activeElement).toBe(rendered.container.querySelector("iframe"));
      await act(async () => { preview = await bridge.onVideoGenerationPreviewTake({ takeId: "take_abcdefghijklmnop" }); });
      const revalidated = await bridge.onVideoGenerationRevalidateTake({ takeId: "take_abcdefghijklmnop" });
      expect(revalidated).toMatchObject({ status: "ready", durationSec: 4.25, take: { id: "take_abcdefghijklmnop", briefRevision: 4, shotId: "quick-brief", artifact: { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53" } } });
      expect(JSON.stringify(revalidated)).not.toContain("internal-artifact-row");
      expect(JSON.stringify(revalidated)).not.toContain("blob:parent-preview");
      readDocumentSession.mockImplementationOnce(async () => ({
        content: validVideoDocument([{ id: "media_take", kind: "video", ref: "generated-media/take.mp4", lifecycle: "durable", durationSec: 4, frameRate: { numerator: 30, denominator: 1 }, source: { kind: "workspace-artifact", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/take.mp4" } }]),
        mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 4,
      }));
      const controller = new AbortController();
      const workspacePreview = await bridge.onVideoWorkspaceMediaOpenPreview({ mediaId: "media_take", signal: controller.signal });
      expect(workspacePreview).toMatchObject({ kind: "ready", url: nativePreviewUrl, mimeType: "video/mp4", sizeBytes: 4 });
      expect(JSON.stringify(workspacePreview)).not.toContain("internal-artifact-row");
      expect(listWorkspaceArtifacts).toHaveBeenLastCalledWith({ roomId: "room-1", pathPrefix: "generated-media/take.mp4" });
      expect(getWorkspaceArtifactBytesArrayBuffer).not.toHaveBeenCalled();
      expect(openWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1", artifact: expect.objectContaining({ artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53" }) }));
      await bridge.onVideoWorkspaceMediaClosePreview({ revokeToken: workspacePreview.revokeToken });
      expect(closeWorkspaceMock).toHaveBeenCalledWith(nativePreviewToken);
      readDocumentSession.mockImplementationOnce(async () => ({
        content: validVideoDocument([{ id: "media_take", kind: "video", ref: "generated-media/take.mp4", lifecycle: "durable", durationSec: 4, frameRate: { numerator: 30, denominator: 1 }, source: { kind: "workspace-artifact", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/take.mp4" } }]),
        mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 4,
      }));
      listWorkspaceArtifacts.mockImplementationOnce(async () => ({ artifacts: [{ id: "internal-wrong-row", artifactId: "00000000-0000-4000-8000-000000000002", path: "generated-media/take.mp4", mimeType: "video/mp4", size: 4 }] }));
      await expect(bridge.onVideoWorkspaceMediaOpenPreview({ mediaId: "media_take", signal: new AbortController().signal })).resolves.toEqual({ kind: "unavailable", code: "unavailable" });
      const aborted = new AbortController();
      aborted.abort();
      await expect(bridge.onVideoWorkspaceMediaOpenPreview({ mediaId: "media_take", signal: aborted.signal })).resolves.toEqual({ kind: "unavailable", code: "unavailable" });
      readDocumentSession.mockImplementationOnce(async () => ({ content: "<script type=\"module\">boom()</script>", mimeType: "text/html", path: target.path, baseSha256: "a".repeat(64), baseRevision: 4 }));
      await expect(bridge.onVideoWorkspaceMediaOpenPreview({ mediaId: "media_take", signal: new AbortController().signal })).resolves.toEqual({ kind: "unavailable", code: "unavailable" });
      await act(async () => {
        rendered.rerender(<MiniAppSurface appId="nautilo-video" target={{ ...target, id: "artifact-row-2", path: "next.video.html" }} onClose={() => {}} />);
      });
      expect(rendered.queryByRole("dialog", { name: "Generated take preview" })).toBeNull();
      expect(closeWorkspaceMock).toHaveBeenCalledWith(nativePreviewToken);
      await act(async () => { rendered.unmount(); });
      expect(closeWorkspaceMock).toHaveBeenCalledWith(nativePreviewToken);
    } finally {
      document.createElement = originalCreateElement;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test("does not steal focus when a target change passively invalidates a closed generated-take preview", async () => {
    const target = { kind: "artifact" as const, id: "artifact-row-1", path: "project.video.html", mimeType: "text/html", roomId: "room-1" };
    loadMiniAppRuntime.mockImplementationOnce(async () => ({
      appId: "nautilo-video", sourceHash: "d".repeat(64), srcDoc: "<html><body></body></html>", hostCapabilities: { videoGeneration: true as const },
      manifest: { id: "nautilo-video", name: "Video", version: "0.1.0", fileAssociations: { extensions: [".video.html"] }, capabilities: {} },
    }));
    const rendered = render(<MiniAppSurface appId="nautilo-video" target={target} onClose={() => {}} />);
    await waitFor(() => expect(issueVideoHostAttestation).toHaveBeenCalled());
    const invoker = document.createElement("button");
    document.body.append(invoker);
    invoker.focus();
    try {
      await act(async () => {
        rendered.rerender(<MiniAppSurface appId="nautilo-video" target={{ ...target, id: "artifact-row-2", path: "next.video.html" }} onClose={() => {}} />);
      });
      await waitFor(() => expect(revokeVideoHostAttestation).toHaveBeenCalled());
      expect(document.activeElement).toBe(invoker);
    } finally {
      invoker.remove();
      rendered.unmount();
    }
  });

  test("bootstraps the initial host mode and sends later rail changes without reloading", async () => {
    const rendered = render(<MiniAppSurface appId="sample-app" theme="light" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    await waitFor(() => expect(buildNautiloAppBridgeClientScript).toHaveBeenCalledWith("light", "edit", { recovery: false, templates: false }));
    const initialSrcDoc = iframe.getAttribute("srcDoc");

    fireEvent.load(iframe);
    expect(postAppTheme).toHaveBeenLastCalledWith(iframe, "light");

    rendered.rerender(<MiniAppSurface appId="sample-app" theme="dark" onClose={() => {}} />);
    await waitFor(() => expect(postAppTheme).toHaveBeenLastCalledWith(iframe, "dark"));
    expect(iframe.getAttribute("srcDoc")).toBe(initialSrcDoc);
  });

  test("shows loading state before runtime resolves", () => {
    loadMiniAppRuntime.mockImplementationOnce(
      () => new Promise(() => {
        /* pending */
      }),
    );
    const { getByText, container } = render(<MiniAppSurface appId="sample-app" onClose={() => {}} />);
    expect(getByText("Loading app…")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("installs the bridge before assigning app srcDoc", async () => {
    const srcDocsWhenBridgeInstalled: Array<string | null> = [];
    installAppBridge.mockImplementation(({ iframe }) => {
      srcDocsWhenBridgeInstalled.push(iframe.getAttribute("srcDoc"));
      return teardownBridge;
    });

    render(<MiniAppSurface appId="sample-app" onClose={() => {}} />);

    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    expect(srcDocsWhenBridgeInstalled).toEqual([null]);
    await waitFor(() => {
      expect(document.querySelector("iframe")?.getAttribute("srcDoc")).toContain("Sample App placeholder");
    });
  });

  test("binds targetless human-edit truth to the current host target and clears it on switch", async () => {
    const artifactTarget = {
      kind: "artifact" as const,
      id: "writer-artifact-lease",
      path: "draft.html",
      mimeType: "text/html",
      roomId: "room-7",
    };
    const fsTarget = {
      kind: "fs" as const,
      rootPath: "/workspace",
      path: "/workspace/draft.html",
    };
    const { rerender } = render(
      <MiniAppSurface appId="nautilo-writer" target={artifactTarget} onClose={() => {}} />,
    );

    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    expect(usePublishedHumanEditLeaseMock.mock.calls.at(-1)?.[0]).toEqual({
      file: undefined,
      update: { state: "clean" },
    });
    const onHumanEditUpdate = installAppBridge.mock.calls[0]?.[0]?.onHumanEditUpdate;
    expect(typeof onHumanEditUpdate).toBe("function");
    act(() => {
      onHumanEditUpdate?.({
        state: "dirty",
        draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
      });
    });
    expect(usePublishedHumanEditLeaseMock.mock.calls.at(-1)?.[0]).toEqual({
      file: artifactTarget,
      update: {
        state: "dirty",
        draftPatch: { kind: "anchored_text", oldString: "before", newString: "human" },
      },
    });
    act(() => onHumanEditUpdate?.({ state: "clean" }));
    expect(usePublishedHumanEditLeaseMock.mock.calls.at(-1)?.[0]).toEqual({
      file: artifactTarget,
      update: { state: "clean" },
    });

    rerender(<MiniAppSurface appId="nautilo-writer" target={fsTarget} onClose={() => {}} />);
    await waitFor(() => {
      expect(usePublishedHumanEditLeaseMock.mock.calls.at(-1)?.[0]).toEqual({
        file: undefined,
        update: { state: "clean" },
      });
    });
    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(2));
    const onNextHumanEditUpdate = installAppBridge.mock.calls[1]?.[0]?.onHumanEditUpdate;
    act(() => onNextHumanEditUpdate?.({ state: "clean" }));
    expect(usePublishedHumanEditLeaseMock.mock.calls.at(-1)?.[0]).toEqual({
      file: fsTarget,
      update: { state: "clean" },
    });
  });

  test("protects browser unload for dirty targetless drafts", async () => {
    const rendered = render(<MiniAppSurface appId="nautilo-design" onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    const onHumanEditUpdate = installAppBridge.mock.calls[0]?.[0]?.onHumanEditUpdate;
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(cleanUnload)).toBe(true);
    act(() => onHumanEditUpdate?.({ state: "dirty" }));
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(dirtyUnload)).toBe(false);
    rendered.unmount();
  });

  test("fetches runtime on mount and renders sandboxed iframe with srcDoc", async () => {
    render(<MiniAppSurface appId="sample-app" onClose={() => {}} />);
    expect(loadMiniAppRuntime).toHaveBeenCalledWith("sample-app");

    await waitFor(() => {
      expect(document.querySelector('iframe[title="Sample App"]')?.getAttribute("srcdoc"))
        .toContain("Sample App placeholder");
    });

    const iframe = document.querySelector('iframe[title="Sample App"]');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts");
    await waitFor(() => expect(iframe!.getAttribute("srcDoc")).toContain("Sample App placeholder"));
    expect(iframe!.getAttribute("srcDoc")).toContain("__nautiloAppBridgeClientInstalled");
    expect(document.body.textContent).toContain("v0.1.0");
  });

  test("refetches when appId changes", async () => {
    const { rerender } = render(<MiniAppSurface appId="sample-app" onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    act(() => installAppBridge.mock.calls[0]?.[0]?.onHumanEditUpdate?.({ state: "dirty" }));
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);

    rerender(<MiniAppSurface appId="other" onClose={() => {}} />);
    await waitFor(() => expect(loadMiniAppRuntime).toHaveBeenCalledTimes(2));
    expect(loadMiniAppRuntime).toHaveBeenLastCalledWith("other");
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
  });

  test("shows sanitized error panel when runtime fetch fails", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async () => {
      throw new ApiError(409, "App dependencies are not installed.");
    });
    const { getByText } = render(<MiniAppSurface appId="sample-app" onClose={() => {}} />);

    await waitFor(() => {
      expect(getByText("App dependencies are not installed.")).toBeTruthy();
    });
    expect(document.querySelector("iframe")).toBeNull();
  });

  test("close button invokes onClose", async () => {
    const onClose = mock(() => {});
    const { getByRole } = render(<MiniAppSurface appId="sample-app" onClose={onClose} />);
    await waitFor(() => expect(document.querySelector('iframe[title="Sample App"]')).not.toBeNull());

    fireEvent.click(getByRole("button", { name: "Close app" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("registered apps use one awaited transition request and remain mounted on failure", async () => {
    let guard: ((reason: "close" | "replace" | "navigate" | "suspend") => Promise<boolean>) | null = null;
    requestMiniAppLifecycle.mockImplementation(async () => ({
      status: "blocked" as const,
      message: "Recovery could not be persisted.",
    }));
    const rendered = render(
      <MiniAppSurface
        appId="nautilo-design"
        target={{ kind: "artifact", id: "design-1", path: "poster.design.json", mimeType: "application/json" }}
        lifecycleRequester={requestMiniAppLifecycle}
        onRegisterTransitionGuard={(next) => { guard = next; }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const bridgeOptions = installAppBridge.mock.calls.at(-1)?.[0] as {
      onLifecycleRegistrationChange?: (registered: boolean) => void;
    };
    bridgeOptions.onLifecycleRegistrationChange?.(true);
    expect(guard).not.toBeNull();
    let results: boolean[] = [];
    await act(async () => {
      const first = guard!("replace");
      const second = guard!("replace");
      results = await Promise.all([first, second]);
    });
    expect(results).toEqual([false, false]);
    expect(requestMiniAppLifecycle).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(rendered.getByText("Recovery could not be persisted.")).toBeTruthy());
    expect(document.querySelector('iframe[title="Sample App"]')).not.toBeNull();
  });

  test("a successful route retry cannot authorize a later unrelated transition", async () => {
    let guard: ((reason: "close" | "replace" | "navigate" | "suspend") => Promise<boolean>) | null = null;
    let shouldBlock = true;
    requestMiniAppLifecycle.mockImplementation(async () => shouldBlock
      ? { status: "blocked" as const, message: "Save failed." }
      : {
          status: "ready" as const,
          result: { documentSaved: true, recoveryPersisted: false, recoverableDraftExact: false },
        });
    const onLifecycleRetryReady = mock(() => {});
    const rendered = render(
      <MiniAppSurface
        appId="nautilo-design"
        target={{ kind: "artifact", id: "design-1", path: "poster.design.json", mimeType: "application/json" }}
        lifecycleRequester={requestMiniAppLifecycle}
        onRegisterTransitionGuard={(next) => { guard = next; }}
        onLifecycleRetryReady={onLifecycleRetryReady}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    installAppBridge.mock.calls.at(-1)?.[0]?.onLifecycleRegistrationChange?.(true);

    let ready = true;
    await act(async () => {
      ready = await guard!("navigate");
    });
    expect(ready).toBe(false);
    shouldBlock = false;
    fireEvent.click(rendered.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onLifecycleRetryReady).toHaveBeenCalledTimes(1));
    expect(requestMiniAppLifecycle).toHaveBeenCalledTimes(2);

    await act(async () => {
      ready = await guard!("replace");
    });
    expect(ready).toBe(true);
    expect(requestMiniAppLifecycle).toHaveBeenCalledTimes(3);
    rendered.unmount();
  });

  for (const reason of ["suspend", "quit"] as const) {
    test(`retrying ${reason} persistence keeps the editor mounted`, async () => {
      let guard: ((reason: "suspend" | "quit") => Promise<boolean>) | null = null;
      let shouldBlock = true;
      requestMiniAppLifecycle.mockImplementation(async () => shouldBlock
        ? { status: "blocked" as const, message: "Save failed." }
        : { status: "ready" as const, result: { documentSaved: true, recoveryPersisted: false, recoverableDraftExact: false } });
      const onClose = mock(() => {});
      const onLifecycleRetryReady = mock(() => {});
      const rendered = render(<MiniAppSurface
        appId="nautilo-design"
        target={{ kind: "artifact", id: "design-1", path: "poster.design.html", mimeType: "text/html" }}
        lifecycleRequester={requestMiniAppLifecycle}
        onRegisterTransitionGuard={(next) => { guard = next; }}
        onLifecycleRetryReady={onLifecycleRetryReady}
        onClose={onClose}
      />);
      await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
      installAppBridge.mock.calls.at(-1)?.[0]?.onLifecycleRegistrationChange?.(true);
      await act(async () => { await guard!(reason); });
      shouldBlock = false;
      fireEvent.click(rendered.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(rendered.queryByText("Save failed.")).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
      expect(onLifecycleRetryReady).not.toHaveBeenCalled();
      expect(document.querySelector("iframe")).not.toBeNull();
      await act(async () => { await guard!(reason); });
      expect(requestMiniAppLifecycle).toHaveBeenCalledTimes(3);
      rendered.unmount();
    });
  }

  test("Design Save Copy persists a collision-safe sibling without overwriting the original", async () => {
    const rendered = render(
      <MiniAppSurface
        appId="nautilo-design"
        target={{ kind: "artifact", id: "design-1", path: "poster.design.json", mimeType: "application/json" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const saveCopy = installAppBridge.mock.calls.at(-1)?.[0]?.saveCopy as
      | ((content: string) => Promise<{ path: string }>)
      | undefined;
    expect(saveCopy).toBeDefined();
    await expect(saveCopy!("draft")).resolves.toEqual({ path: "poster.design.conflict-copy.json" });
    expect(createWorkspaceArtifact).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  test("Slides Save Copy persists a collision-safe Workspace sibling", async () => {
    const rendered = render(
      <MiniAppSurface
        appId="nautilo-presentation"
        target={{
          kind: "artifact",
          id: "slides-1",
          path: "decks/demo.presentation.html",
          mimeType: "text/html",
          roomId: "room-slides",
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const saveCopy = installAppBridge.mock.calls.at(-1)?.[0]?.saveCopy as
      | ((content: string) => Promise<{ path: string }>)
      | undefined;

    expect(saveCopy).toBeDefined();
    await expect(saveCopy!("exact slides draft")).resolves.toEqual({
      path: "decks/demo.presentation.conflict-copy.html",
    });
    expect(createWorkspaceArtifact).toHaveBeenCalledWith(
      expect.any(Blob),
      {
        path: "decks/demo.presentation.conflict-copy.html",
        mimeType: "text/html",
        roomId: "room-slides",
      },
    );
    const workspaceCopy = createWorkspaceArtifact.mock.calls[0]?.[0];
    expect(await workspaceCopy?.text()).toBe("exact slides draft");
    rendered.unmount();
  });

  test("Board Save Copy persists a collision-safe Workspace sibling", async () => {
    const rendered = render(
      <MiniAppSurface
        appId="nautilo-board"
        target={{ kind: "artifact", id: "board-1", path: "boards/demo.board.html", mimeType: "text/html", roomId: "room-board" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const saveCopy = installAppBridge.mock.calls.at(-1)?.[0]?.saveCopy as
      | ((content: string) => Promise<{ path: string }>)
      | undefined;
    expect(saveCopy).toBeDefined();
    await expect(saveCopy!("exact board draft")).resolves.toEqual({ path: "boards/demo.board.conflict-copy.html" });
    expect(createWorkspaceArtifact).toHaveBeenCalledWith(expect.any(Blob), {
      path: "boards/demo.board.conflict-copy.html", mimeType: "text/html", roomId: "room-board",
    });
    rendered.unmount();
  });

  test("Slides Save Copy persists a create-only Current Folder sibling", async () => {
    fsStatMock.mockResolvedValueOnce({ exists: false, isFile: false, size: 0 });
    const rendered = render(
      <MiniAppSurface
        appId="nautilo-presentation"
        target={{
          kind: "fs",
          rootPath: "/repo",
          path: "/repo/demo.presentation.html",
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const saveCopy = installAppBridge.mock.calls.at(-1)?.[0]?.saveCopy as
      | ((content: string) => Promise<{ path: string }>)
      | undefined;

    expect(saveCopy).toBeDefined();
    await expect(saveCopy!("exact local slides draft")).resolves.toEqual({
      path: "/repo/demo.presentation.conflict-copy.html",
    });
    expect(fsWriteFileMock).toHaveBeenCalledWith(
      "/repo/demo.presentation.conflict-copy.html",
      "exact local slides draft",
      { baseSha256: null },
    );
    rendered.unmount();
  });

  test("keeps an unclean mini-app mounted until the user explicitly discards", async () => {
    const onClose = mock(() => {});
    const target = {
      kind: "artifact" as const,
      id: "artifact-dirty-close",
      path: "budget.document.html",
      mimeType: "text/html",
    };
    const rendered = render(<MiniAppSurface appId="sample-app" target={target} onClose={onClose} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    const iframe = document.querySelector("iframe");
    const onHumanEditUpdate = installAppBridge.mock.calls[0]?.[0]?.onHumanEditUpdate;
    act(() => onHumanEditUpdate?.({ state: "dirty" }));

    fireEvent.click(rendered.getByRole("button", { name: "Close app" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBe(iframe);
    expect(rendered.getByRole("alertdialog", { name: "Unsaved app changes" }).textContent)
      .toContain("Save your changes before leaving.");
    fireEvent.click(rendered.getByRole("button", { name: "Keep editing" }));
    expect(rendered.queryByRole("alertdialog", { name: "Unsaved app changes" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(rendered.getByRole("button", { name: "Close app" }));
    fireEvent.click(rendered.getByRole("button", { name: "Discard and continue" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("keeps dirty edits and a pending navigation guarded across artifact rename", async () => {
    const onClose = mock(() => {});
    const target = { kind: "artifact" as const, id: "rename-dirty", path: "old.document.html", mimeType: "text/html" };
    const rendered = render(<MiniAppSurface appId="sample-app" target={target} onClose={onClose} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    act(() => installAppBridge.mock.calls[0]?.[0]?.onHumanEditUpdate?.({ state: "dirty" }));
    fireEvent.click(rendered.getByRole("button", { name: "Close app" }));
    rendered.rerender(<MiniAppSurface appId="sample-app" target={{ ...target, path: "renamed.document.html", reloadToken: 1 }} onClose={onClose} />);
    expect(installAppBridge).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(rendered.getByRole("alertdialog", { name: "Unsaved app changes" })).toBeTruthy();
    fireEvent.click(rendered.getByRole("button", { name: "Discard and continue" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("protects edits in a fresh draft before a document is materialized", async () => {
    const onClose = mock(() => {});
    const draft = {
      appId: "sample-app",
      createActionId: "create-document",
      suggestedName: "Untitled document.html",
    };
    const rendered = render(<MiniAppSurface appId="sample-app" draft={draft} onClose={onClose} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    const bridge = installAppBridge.mock.calls[0]?.[0];
    expect(bridge?.target).toBeUndefined();
    act(() => bridge?.onHumanEditUpdate?.({ state: "dirty" }));
    fireEvent.click(rendered.getByRole("button", { name: "Close app" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(rendered.getByRole("alertdialog", { name: "Unsaved app changes" })).toBeTruthy();
    act(() => bridge?.onHumanEditUpdate?.({ state: "clean" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("defers shell file and app navigation until save or one explicit discard", async () => {
    let beforeLeave: ((leave: () => void) => void) | null = null;
    const registerBeforeLeave = mock((guard: ((leave: () => void) => void) | null) => {
      beforeLeave = guard;
    });
    const openDifferentFile = mock(() => {});
    const openDifferentApp = mock(() => {});
    const target = {
      kind: "artifact" as const,
      id: "artifact-navigation-guard",
      path: "budget.document.html",
      mimeType: "text/html",
    };
    const rendered = render(
      <MiniAppSurface
        appId="sample-app"
        target={target}
        registerBeforeLeave={registerBeforeLeave}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    const iframe = document.querySelector("iframe");
    const onHumanEditUpdate = installAppBridge.mock.calls[0]?.[0]?.onHumanEditUpdate;
    act(() => onHumanEditUpdate?.({ state: "dirty" }));

    act(() => beforeLeave?.(openDifferentFile));
    expect(openDifferentFile).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBe(iframe);

    act(() => onHumanEditUpdate?.({ state: "clean" }));
    expect(openDifferentFile).toHaveBeenCalledTimes(1);

    act(() => onHumanEditUpdate?.({ state: "dirty" }));
    act(() => beforeLeave?.(openDifferentApp));
    fireEvent.click(rendered.getByRole("button", { name: "Discard and continue" }));
    expect(openDifferentApp).toHaveBeenCalledTimes(1);

    act(() => beforeLeave?.(openDifferentFile));
    expect(openDifferentFile).toHaveBeenCalledTimes(1);
  });

  test("guards window unload only while the published human edit is unclean", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-unload-guard",
      path: "budget.document.html",
      mimeType: "text/html",
    };
    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);
    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    const onHumanEditUpdate = installAppBridge.mock.calls[0]?.[0]?.onHumanEditUpdate;

    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    act(() => onHumanEditUpdate?.({ state: "saving" }));
    const savingEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savingEvent);
    expect(savingEvent.defaultPrevented).toBe(true);

    act(() => onHumanEditUpdate?.({ state: "clean" }));
    const savedEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedEvent);
    expect(savedEvent.defaultPrevented).toBe(false);
  });

  test("offers a reversible full-width control that restores Workspace and Genie exactly", async () => {
    const onToggleChat = mock(() => {});
    const onToggleBrowser = mock(() => {});
    const rendered = render(
      <MiniAppSurface
        appId="sample-app"
        onClose={() => {}}
        onToggleChat={onToggleChat}
        chatVisible
        onToggleBrowser={onToggleBrowser}
        browserVisible
      />,
    );
    await act(async () => {});
    fireEvent.click(rendered.getByRole("button", { name: "Work full width" }));
    expect(onToggleChat).toHaveBeenCalledTimes(1);
    expect(onToggleBrowser).toHaveBeenCalledTimes(1);
    rendered.rerender(
      <MiniAppSurface
        appId="sample-app"
        onClose={() => {}}
        onToggleChat={onToggleChat}
        chatVisible={false}
        onToggleBrowser={onToggleBrowser}
        browserVisible={false}
      />,
    );
    const restore = rendered.getByRole("button", { name: "Restore layout" });
    expect(restore.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(restore);
    expect(onToggleChat).toHaveBeenCalledTimes(2);
    expect(onToggleBrowser).toHaveBeenCalledTimes(2);
  });

  test("full width preserves an already-collapsed Workspace browser", async () => {
    const onToggleChat = mock(() => {});
    const onToggleBrowser = mock(() => {});
    const rendered = render(
      <MiniAppSurface
        appId="sample-app"
        onClose={() => {}}
        onToggleChat={onToggleChat}
        chatVisible
        onToggleBrowser={onToggleBrowser}
        browserVisible={false}
      />,
    );
    await act(async () => {});
    fireEvent.click(rendered.getByRole("button", { name: "Work full width" }));
    expect(onToggleChat).toHaveBeenCalledTimes(1);
    expect(onToggleBrowser).not.toHaveBeenCalled();
    rendered.rerender(
      <MiniAppSurface
        appId="sample-app"
        onClose={() => {}}
        onToggleChat={onToggleChat}
        chatVisible={false}
        onToggleBrowser={onToggleBrowser}
        browserVisible={false}
      />,
    );
    fireEvent.click(rendered.getByRole("button", { name: "Restore layout" }));
    expect(onToggleChat).toHaveBeenCalledTimes(2);
    expect(onToggleBrowser).not.toHaveBeenCalled();
  });

  test("renders export actions from the runtime manifest", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) =>
      runtimeWithExportActions(appId, [exportDocxAction, exportPdfAction]),
    );
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    const { getByRole } = render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Export ▾" }));

    expect(getByRole("menuitem", { name: "Microsoft Word" })).toBeTruthy();
    expect(getByRole("menuitem", { name: "PDF" })).toBeTruthy();
  });

  test("filters export actions to the actual bound document surface", async () => {
    const workspaceOnly = { ...exportDocxAction, id: "workspace-only", label: "Workspace only", targetSurfaces: ["workspace"] };
    const folderOnly = { ...exportPdfAction, id: "folder-only", label: "Folder only", targetSurfaces: ["currentFolder"] };
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) =>
      runtimeWithExportActions(appId, [workspaceOnly, folderOnly]),
    );
    const target = {
      kind: "fs" as const,
      path: "/workspace/budget.document.json",
      rootPath: "/workspace",
    };
    const { getByRole, queryByRole, rerender } = render(
      <MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />,
    );

    await waitFor(() => expect(getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Export ▾" }));
    expect(getByRole("menuitem", { name: "Folder only" })).toBeTruthy();
    expect(queryByRole("menuitem", { name: "Workspace only" })).toBeNull();

    rerender(
      <MiniAppSurface
        appId="sample-app"
        target={{
          kind: "artifact",
          id: "artifact-row-1",
          path: "budget.document.json",
          mimeType: "application/vnd.nautilo.document+json",
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(queryByRole("menu", { name: "Export document" })).toBeNull());
    fireEvent.click(getByRole("button", { name: "Export ▾" }));
    expect(getByRole("menuitem", { name: "Workspace only" })).toBeTruthy();
    expect(queryByRole("menuitem", { name: "Folder only" })).toBeNull();
  });

  test("disables export when no document is bound", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    const { getByRole } = render(<MiniAppSurface appId="sample-app" onClose={() => {}} />);

    await waitFor(() => expect(getByRole("button", { name: "Export ▾" })).toBeTruthy());
    const exportButton = getByRole("button", { name: "Export ▾" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.title).toBe("Open a document to export");
  });

  test("runs export conversion with the silent same-directory target", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
      roomId: "33333333-3333-4333-8333-333333333333",
    };
    const { getByRole } = render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Export ▾" }));
    await act(async () => {
      fireEvent.click(getByRole("menuitem", { name: "Microsoft Word" }));
    });

    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));
    expect(runMiniAppConversion.mock.calls[0]?.[0]).toBe("sample-app");
    expect(runMiniAppConversion.mock.calls[0]?.[1]).toEqual({
      actionId: "export-docx",
      direction: "export",
      source: { surface: "workspace", path: "docs/budget.document.json" },
      target: { surface: "workspace", path: "docs/budget.document.docx" },
      roomId: "33333333-3333-4333-8333-333333333333",
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Exported to docs/budget.document.docx");
    });
  });

  test("prepares PDF bytes in the bound frame before the canonical conversion call", async () => {
    const action = { ...exportPdfAction, prepareInApp: true, selectWorkspaceDestination: true };
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId, [action]));
    const prepared = { content: "JVBERi0=", encoding: "base64" as const, mimeType: "application/pdf",
      byteLength: 5, sourceSha256: "a".repeat(64), warnings: ["Raster PDF"] };
    let release!: (value: typeof prepared) => void;
    const exportRequester = mock(() => new Promise<typeof prepared>(resolve => { release = resolve; }));
    const target = { kind: "artifact" as const, id: "pdf-source", path: "Deck.presentation.html", mimeType: "text/html" };
    const view = render(<MiniAppSurface appId="nautilo-presentation" target={target} onClose={() => {}} exportRequester={exportRequester} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Export ▾" }));
    fireEvent.click(view.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(exportRequester).toHaveBeenCalledTimes(1));
    expect(runMiniAppConversion).not.toHaveBeenCalled();
    expect(view.getByRole("button", { name: "Cancel export" })).toBeTruthy();
    await act(async () => { release(prepared); });
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));
    expect(runMiniAppConversion.mock.calls[0]?.[1]).toMatchObject({ preparedExport: prepared,
      source: { surface: "workspace", path: target.path }, target: { surface: "workspace", path: "Deck.presentation.pdf" },
      workspaceDestination: "current" });
  });

  test("cancel preparation leaves no canonical conversion running", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId, [{ ...exportPdfAction, prepareInApp: true }]));
    const exportRequester = mock(({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("Export request was aborted.")), { once: true });
    }));
    const view = render(<MiniAppSurface appId="nautilo-presentation" target={{ kind: "artifact", id: "pdf-cancel", path: "Deck.presentation.html", mimeType: "text/html" }} onClose={() => {}} exportRequester={exportRequester} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Export ▾" }));
    fireEvent.click(view.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Cancel export" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Cancel export" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Cancel export" })).toBeNull());
    expect(view.queryByText("Export request was aborted.")).toBeNull();
    expect(runMiniAppConversion).not.toHaveBeenCalled();
  });

  test("uses the host-bound Design page, selection, and selected-frame scopes for PNG export", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) =>
      runtimeWithExportActions(appId, [exportSvgAction, exportPngAction]),
    );
    const target = {
      kind: "artifact" as const,
      id: "design-artifact-1",
      path: "designs/D575 Design acceptance.design.html",
      mimeType: "text/html",
    };
    const rendered = render(<MiniAppSurface appId="nautilo-design" target={target} onClose={() => {}} />);

    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    const onContextUpdate = installAppBridge.mock.calls.at(-1)?.[0]?.onContextUpdate as
      | ((context: { appId: string; target: typeof target; summary: unknown; updatedAt: number }) => void)
      | undefined;
    expect(onContextUpdate).toBeDefined();
    onContextUpdate!({
      appId: "nautilo-design",
      target,
      summary: {
        selection: { nodeHandles: ["node:frame-1", "node:shape-2"] },
        summary: {
          design: {
            pageHandle: "page:page-1",
            topLevelFrames: [{ handle: "node:frame-1", name: "Poster" }],
          },
        },
      },
      updatedAt: 1,
    });
    rendered.rerender(<MiniAppSurface appId="nautilo-design" target={target} onClose={() => {}} />);

    await waitFor(() => expect(rendered.getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Export ▾" }));
    for (const label of ["Current page", "Selection", "Selected frame"]) {
      expect(rendered.getByRole("menuitem", { name: `SVG · ${label}` })).toBeTruthy();
      expect(rendered.getByRole("menuitem", { name: `PNG · ${label}` })).toBeTruthy();
    }

    await act(async () => {
      fireEvent.click(rendered.getByRole("menuitem", { name: "PNG · Selection" }));
    });
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));
    expect(runMiniAppConversion.mock.calls[0]?.[0]).toBe("nautilo-design");
    expect(runMiniAppConversion.mock.calls[0]?.[1]).toMatchObject({
      actionId: "export-png",
      direction: "export",
      source: { surface: "workspace", path: "designs/D575 Design acceptance.design.html" },
      target: { surface: "workspace", path: "designs/D575 Design acceptance.design.png" },
      scope: { pageHandle: "page:page-1", nodeHandles: ["node:frame-1", "node:shape-2"] },
    });
  });

  test("awaits the registered app save boundary before starting export", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    let releaseLifecycle!: (value: {
      status: "ready";
      result: { documentSaved: boolean; recoveryPersisted: boolean; recoverableDraftExact: boolean };
    }) => void;
    requestMiniAppLifecycle.mockImplementation(() => new Promise((resolve) => {
      releaseLifecycle = resolve;
    }));
    const target = {
      kind: "artifact" as const,
      id: "design-1",
      path: "poster.design.json",
      mimeType: "application/vnd.nautilo.design+json",
    };
    const rendered = render(
      <MiniAppSurface
        appId="nautilo-design"
        target={target}
        lifecycleRequester={requestMiniAppLifecycle}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    installAppBridge.mock.calls.at(-1)?.[0]?.onLifecycleRegistrationChange?.(true);
    await waitFor(() => expect(rendered.getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Export ▾" }));
    fireEvent.click(rendered.getByRole("menuitem", { name: "Microsoft Word" }));
    await Promise.resolve();
    expect(requestMiniAppLifecycle).toHaveBeenCalledWith(expect.objectContaining({ reason: "suspend" }));
    expect(runMiniAppConversion).not.toHaveBeenCalled();
    await act(async () => releaseLifecycle({
      status: "ready",
      result: { documentSaved: true, recoveryPersisted: false, recoverableDraftExact: false },
    }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));
    rendered.unmount();
  });

  test("does not export server source when close readiness came only from recovery", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    requestMiniAppLifecycle.mockImplementation(async () => ({
      status: "ready" as const,
      result: { documentSaved: false, recoveryPersisted: true, recoverableDraftExact: true },
    }));
    const rendered = render(
      <MiniAppSurface
        appId="nautilo-design"
        target={{ kind: "artifact", id: "design-1", path: "poster.design.json", mimeType: "application/json" }}
        lifecycleRequester={requestMiniAppLifecycle}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(installAppBridge).toHaveBeenCalled());
    installAppBridge.mock.calls.at(-1)?.[0]?.onLifecycleRegistrationChange?.(true);
    fireEvent.click(await rendered.findByRole("button", { name: "Export ▾" }));
    await act(async () => fireEvent.click(rendered.getByRole("menuitem", { name: "Microsoft Word" })));
    expect(runMiniAppConversion).not.toHaveBeenCalled();
    expect(rendered.getByText("Export requires the current document to be saved to its original location.")).toBeTruthy();
    rendered.unmount();
  });

  test("opens an exported workspace artifact and reports when the reader is unavailable", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    listWorkspaceArtifacts.mockImplementation(async () => ({
      artifacts: [{ id: "export-row", path: "docs/budget.document.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
    }));
    const open = mock(() => {});
    setOpenFileDispatcher(open);
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
      roomId: "room-bound",
    };
    const { getByRole } = render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Export ▾" }));
    await act(async () => {
      fireEvent.click(getByRole("menuitem", { name: "Microsoft Word" }));
    });

    await waitFor(() => expect(open).toHaveBeenCalledWith({
      kind: "artifact",
      id: "export-row",
      path: "docs/budget.document.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      roomId: "room-bound",
    }));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Exported to docs/budget.document.docx and opened it.");
    });

    setOpenFileDispatcher(null);
  });

  test("reports a completed export without claiming it opened when the artifact row is unavailable", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    const { getByRole } = render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Export ▾" }));
    await act(async () => {
      fireEvent.click(getByRole("menuitem", { name: "Microsoft Word" }));
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Exported to docs/budget.document.docx.");
      expect(document.body.textContent).not.toContain("Exported to docs/budget.document.docx and opened it.");
    });
  });

  test("does not open a completed export after its surface unmounts", async () => {
    let resolveConversion: ((value: { ok: true; result: { ok: true; status: "exported"; displayPath: string } }) => void) | null = null;
    runMiniAppConversion.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveConversion = resolve;
      }),
    );
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    listWorkspaceArtifacts.mockImplementation(async () => ({
      artifacts: [{ id: "export-row", path: "docs/budget.document.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
    }));
    const open = mock(() => {});
    setOpenFileDispatcher(open);
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    const rendered = render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(rendered.getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Export ▾" }));
    fireEvent.click(rendered.getByRole("menuitem", { name: "Microsoft Word" }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));
    rendered.unmount();
    resolveConversion?.({
      ok: true,
      result: { ok: true, status: "exported", displayPath: "docs/budget.document.docx" },
    });
    await act(async () => {});

    expect(open).not.toHaveBeenCalled();
    expect(listWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  test("does not show a stale export error after the bound document changes", async () => {
    let rejectConversion: ((reason?: unknown) => void) | null = null;
    runMiniAppConversion.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectConversion = reject;
      }),
    );
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    const originalTarget = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    const rendered = render(
      <MiniAppSurface appId="sample-app" target={originalTarget} onClose={() => {}} />,
    );

    await waitFor(() => expect(rendered.getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Export ▾" }));
    fireEvent.click(rendered.getByRole("menuitem", { name: "Microsoft Word" }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));
    rendered.rerender(
      <MiniAppSurface
        appId="sample-app"
        target={{ ...originalTarget, id: "artifact-row-2", path: "docs/other.document.json" }}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      rejectConversion?.(new Error("late export failure"));
    });

    expect(document.body.textContent).not.toContain("late export failure");
  });

  test("treats the same artifact id in another room as a changed export target", async () => {
    let rejectConversion: ((reason?: unknown) => void) | null = null;
    runMiniAppConversion.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectConversion = reject;
      }),
    );
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    const originalTarget = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
      roomId: "33333333-3333-4333-8333-333333333333",
    };
    const rendered = render(
      <MiniAppSurface appId="sample-app" target={originalTarget} onClose={() => {}} />,
    );

    await waitFor(() => expect(rendered.getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Export ▾" }));
    fireEvent.click(rendered.getByRole("menuitem", { name: "Microsoft Word" }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));
    rendered.rerender(
      <MiniAppSurface
        appId="sample-app"
        target={{ ...originalTarget, roomId: "44444444-4444-4444-8444-444444444444" }}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      rejectConversion?.(new Error("late cross-room export failure"));
    });

    expect(document.body.textContent).not.toContain("late cross-room export failure");
  });

  test("keeps a pending export current when the same artifact target object is replaced", async () => {
    let resolveConversion: ((value: { ok: true; result: { ok: true; status: "exported"; displayPath: string } }) => void) | null = null;
    runMiniAppConversion.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveConversion = resolve;
      }),
    );
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
      roomId: "33333333-3333-4333-8333-333333333333",
    };
    const rendered = render(
      <MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />,
    );

    await waitFor(() => expect(rendered.getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Export ▾" }));
    fireEvent.click(rendered.getByRole("menuitem", { name: "Microsoft Word" }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <MiniAppSurface
        appId="sample-app"
        target={{ ...target, path: "docs/renamed.document.json" }}
        onClose={() => {}}
      />,
    );

    await act(async () => {
      resolveConversion?.({
        ok: true,
        result: {
          ok: true,
          status: "exported",
          displayPath: "docs/budget.document.docx",
        },
      });
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Exported to docs/budget.document.docx.");
      expect(rendered.getByRole("button", { name: "Export ▾" })).toBeTruthy();
    });
  });

  test("export conflict shows the dialog and retries with overwrite", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    runMiniAppConversion.mockImplementationOnce(async () => ({
      ok: true,
      result: {
        ok: true,
        status: "conflict",
        target: { surface: "workspace", path: "docs/budget.document.docx" },
        message: 'A file already exists at "docs/budget.document.docx".',
      },
    }));
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    const { getByRole, getByTestId } = render(
      <MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />,
    );

    await waitFor(() => expect(getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Export ▾" }));
    await act(async () => {
      fireEvent.click(getByRole("menuitem", { name: "Microsoft Word" }));
    });

    await waitFor(() => expect(getByTestId("conversion-conflict-overwrite")).toBeTruthy());
    await act(async () => {
      fireEvent.click(getByTestId("conversion-conflict-overwrite"));
    });

    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(2));
    expect(runMiniAppConversion.mock.calls[1]?.[1]).toMatchObject({
      actionId: "export-docx",
      direction: "export",
      overwrite: true,
      target: { surface: "workspace", path: "docs/budget.document.docx" },
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Exported to docs/budget.document.docx");
    });
  });

  test("export conflict cancel makes no second call and shows no success notice", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => runtimeWithExportActions(appId));
    runMiniAppConversion.mockImplementationOnce(async () => ({
      ok: true,
      result: {
        ok: true,
        status: "conflict",
        target: { surface: "workspace", path: "docs/budget.document.docx" },
        message: "exists",
      },
    }));
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "docs/budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    const { getByRole, queryByTestId } = render(
      <MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />,
    );

    await waitFor(() => expect(getByRole("button", { name: "Export ▾" })).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Export ▾" }));
    await act(async () => {
      fireEvent.click(getByRole("menuitem", { name: "Microsoft Word" }));
    });

    await waitFor(() => expect(queryByTestId("conversion-conflict-overwrite")).toBeTruthy());
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Cancel" }));
    });

    await waitFor(() => expect(queryByTestId("conversion-conflict-overwrite")).toBeNull());
    expect(runMiniAppConversion).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Exported to");
  });

  test("renders runtime iframe when target is provided without leaking it into srcDoc", async () => {
    const runtimeSrcDoc = "<!DOCTYPE html><html><body>Sample App placeholder</body></html>";
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => ({
      appId,
      sourceHash: "d".repeat(64),
      srcDoc: runtimeSrcDoc,
      manifest: {
        id: appId,
        name: "Sample App",
        version: "0.1.0",
        fileAssociations: { extensions: [".document.json"] },
        capabilities: {},
      },
    }));

    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };

    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('iframe[title="Sample App"]')).not.toBeNull();
    });

    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts");
    await waitFor(() => {
      expect(iframe!.getAttribute("srcDoc")).toContain(runtimeSrcDoc.replace("</head>", ""));
    });
    expect(iframe!.getAttribute("srcDoc")).not.toContain("artifact-row-1");
    expect(iframe!.getAttribute("srcDoc")).not.toContain("budget.document.json");
  });

  test("issues and revokes Writer capability only for a hydrated artifact", async () => {
    const rotatedToken = "rotated-token".padEnd(43, "r");
    refreshLiveMiniAppSession.mockImplementationOnce(async () => ({
      sessionToken: rotatedToken,
      sessionId: "route-a",
      documentVersion: { kind: "artifact_revision" as const, revision: 2 },
      expiresAt: Date.now() + 60_000,
    }));
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-1",
      path: "draft.html",
      mimeType: "text/html",
    };
    const { unmount } = render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => {
      expect(issueLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
        targetKind: "artifact",
        artifactId: "writer-artifact-1",
        documentVersion: { kind: "artifact_revision", revision: 1 },
      });
    });
    expect(issueLiveMiniAppSession.mock.calls[0]?.[1]).not.toHaveProperty("path");
    await waitFor(() =>
      expect(postAppLiveSession).toHaveBeenCalledWith(expect.anything(), {
        sessionToken: "a".repeat(43),
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision", revision: 1 },
      }),
    );

    const onDocumentVersion = installAppBridge.mock.calls[0]?.[0]?.onDocumentVersion;
    await act(async () => onDocumentVersion?.({ kind: "artifact_revision", revision: 2 }));
    await waitFor(() =>
      expect(refreshLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
        sessionToken: "a".repeat(43),
        targetKind: "artifact",
        artifactId: "writer-artifact-1",
        documentVersion: { kind: "artifact_revision", revision: 2 },
      }),
    );
    await waitFor(() =>
      expect(postAppLiveSession).toHaveBeenLastCalledWith(expect.anything(), {
        sessionToken: rotatedToken,
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision", revision: 2 },
      }),
    );

    unmount();
    await waitFor(() =>
      expect(revokeLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
        sessionToken: rotatedToken,
      }),
    );
  });

  test("reissues and reposts a Writer capability after session_closed refresh failure", async () => {
    const initialToken = "initial-token".padEnd(43, "a");
    const recoveredToken = "recovered-token".padEnd(43, "b");
    issueLiveMiniAppSession
      .mockImplementationOnce(async () => ({
        sessionToken: initialToken,
        sessionId: "initial-route",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        expiresAt: Date.now() + 60_000,
      }))
      .mockImplementationOnce(async () => ({
        sessionToken: recoveredToken,
        sessionId: "recovered-route",
        documentVersion: { kind: "artifact_revision", revision: 3 },
        expiresAt: Date.now() + 60_000,
      }));
    refreshLiveMiniAppSession.mockImplementationOnce(async () => {
      throw new ApiError(409, "session_closed");
    });
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-recovery",
      path: "recovery.html",
      mimeType: "text/html",
    };

    render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = {
        content: "updated\n",
        mimeType: "text/html",
        path: "recovery.html",
        baseSha256: "updated-sha",
        baseRevision: 3,
      };
      session.envelope = envelope;
      return envelope;
    });
    const onDocumentVersion = installAppBridge.mock.calls[0]?.[0]?.onDocumentVersion;
    await act(async () => onDocumentVersion?.({ kind: "artifact_revision", revision: 2 }));

    await waitFor(() =>
      expect(refreshLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
        sessionToken: initialToken,
        targetKind: "artifact",
        artifactId: target.id,
        documentVersion: { kind: "artifact_revision", revision: 2 },
      }),
    );
    await waitFor(() =>
      expect(issueLiveMiniAppSession).toHaveBeenLastCalledWith("nautilo-writer", {
        targetKind: "artifact",
        artifactId: target.id,
        documentVersion: { kind: "artifact_revision", revision: 3 },
      }),
    );
    await waitFor(() =>
      expect(postAppLiveSession).toHaveBeenLastCalledWith(expect.anything(), {
        sessionToken: recoveredToken,
        sessionId: "recovered-route",
        documentVersion: { kind: "artifact_revision", revision: 3 },
      }),
    );
  });

  test("does not recover a stale Writer refresh after its target changes", async () => {
    let rejectRefresh: ((reason?: unknown) => void) | null = null;
    refreshLiveMiniAppSession.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRefresh = reject;
        }),
    );
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-stale",
      path: "stale.html",
      mimeType: "text/html",
    };
    const nextTarget = { ...target, id: "writer-artifact-current", path: "current.html" };
    const { rerender } = render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    const onDocumentVersion = installAppBridge.mock.calls[0]?.[0]?.onDocumentVersion;
    const staleRefresh = onDocumentVersion?.({ kind: "artifact_revision", revision: 2 });
    await waitFor(() => expect(refreshLiveMiniAppSession).toHaveBeenCalledTimes(1));

    rerender(<MiniAppSurface appId="nautilo-writer" target={nextTarget} onClose={() => {}} />);
    await waitFor(() =>
      expect(issueLiveMiniAppSession).toHaveBeenLastCalledWith("nautilo-writer", {
        targetKind: "artifact",
        artifactId: nextTarget.id,
        documentVersion: { kind: "artifact_revision", revision: 1 },
      }),
    );
    await act(async () => rejectRefresh?.(new ApiError(409, "session_closed")));
    await staleRefresh;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(2);
  });

  test("does not post a recovered Writer capability after unmount", async () => {
    let resolveRecoveryIssue:
      | ((capability: {
          sessionToken: string;
          sessionId: string;
          documentVersion: { kind: "artifact_revision"; revision: number };
          expiresAt: number;
        }) => void)
      | null = null;
    const initialToken = "unmount-initial".padEnd(43, "a");
    const recoveredToken = "unmount-recovered".padEnd(43, "b");
    issueLiveMiniAppSession
      .mockImplementationOnce(async () => ({
        sessionToken: initialToken,
        sessionId: "unmount-initial-route",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        expiresAt: Date.now() + 60_000,
      }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRecoveryIssue = resolve;
          }),
      );
    refreshLiveMiniAppSession.mockImplementationOnce(async () => {
      throw new ApiError(409, "session_closed");
    });
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-unmount",
      path: "unmount.html",
      mimeType: "text/html",
    };
    const { unmount } = render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    const onDocumentVersion = installAppBridge.mock.calls[0]?.[0]?.onDocumentVersion;
    const recoveryRefresh = onDocumentVersion?.({ kind: "artifact_revision", revision: 2 });
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(2));

    unmount();
    await act(async () =>
      resolveRecoveryIssue?.({
        sessionToken: recoveredToken,
        sessionId: "unmount-recovered-route",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        expiresAt: Date.now() + 60_000,
      }),
    );
    await recoveryRefresh;

    expect(postAppLiveSession).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(revokeLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
        sessionToken: recoveredToken,
      }),
    );
  });

  test("does not issue a Writer capability without a bound artifact", async () => {
    render(<MiniAppSurface appId="nautilo-writer" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(issueLiveMiniAppSession).not.toHaveBeenCalled();
  });

  test("forwards only a proposal matching this Writer live session and unsubscribes", async () => {
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-proposal",
      path: "proposal.html",
      mimeType: "text/html",
    };
    const { unmount } = render(
      <MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />,
    );

    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(postAppLiveSession).toHaveBeenCalledTimes(1));
    const iframe = document.querySelector("iframe")!;

    await act(async () => {
      publishLiveAppProposal({
        proposalId: "wrong-session",
        appId: "nautilo-writer",
        sessionId: "different-session",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        operations: [],
      });
      publishLiveAppProposal({
        proposalId: "wrong-revision",
        appId: "nautilo-writer",
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision", revision: 2 },
        operations: [],
      });
      publishLiveAppProposal({
        proposalId: "matching",
        appId: "nautilo-writer",
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        operations: [{ type: "insert_text" }],
      });
    });

    expect(postAppLiveProposal).toHaveBeenCalledTimes(1);
    expect(postAppLiveProposal).toHaveBeenCalledWith(iframe, {
      proposalId: "matching",
      appId: "nautilo-writer",
      sessionId: "route-a",
        documentVersion: { kind: "artifact_revision", revision: 1 },
      operations: [{ type: "insert_text" }],
    });
    await waitFor(() => expect(subscribeWorkspaceArtifactEventsMock).toHaveBeenCalledTimes(1));
    const readsBeforeReconnect = readDocumentSession.mock.calls.length;
    refreshLiveMiniAppSession.mockClear();
    await act(async () => {
      const onReconnect = subscribeWorkspaceArtifactEventsMock.mock.calls[0]?.[1]?.onReconnect;
      await Promise.all([onReconnect?.(), onReconnect?.()]);
    });
    expect(readDocumentSession).toHaveBeenCalledTimes(readsBeforeReconnect + 1);
    expect(postAppDocumentChanged).toHaveBeenCalledTimes(1);
    expect(postAppDocumentChanged).toHaveBeenCalledWith(iframe, { type: "reconnected" });
    expect(refreshLiveMiniAppSession).not.toHaveBeenCalled();
    expect(postAppLiveProposal).toHaveBeenCalledTimes(1);
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    unmount();
    publishLiveAppProposal({
      proposalId: "after-unmount",
      appId: "nautilo-writer",
      sessionId: "route-a",
        documentVersion: { kind: "artifact_revision", revision: 1 },
      operations: [],
    });
    expect(postAppLiveProposal).toHaveBeenCalledTimes(1);
  });

  test("replays a matching proposal that arrived before the Writer live session was ready", async () => {
    publishLiveAppProposal({
      proposalId: "early-matching",
      appId: "nautilo-writer",
      sessionId: "route-a",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      operations: [{ type: "replace" }],
    });
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-early-proposal",
      path: "early-proposal.html",
      mimeType: "text/html",
    };

    render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => expect(postAppLiveSession).toHaveBeenCalledTimes(1));
    const iframe = document.querySelector("iframe")!;
    await waitFor(() => expect(postAppLiveProposal).toHaveBeenCalledTimes(1));
    expect(postAppLiveProposal).toHaveBeenCalledWith(iframe, {
      proposalId: "early-matching",
      appId: "nautilo-writer",
      sessionId: "route-a",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      operations: [{ type: "replace" }],
    });
  });

  test("reconciles a background Task proposal from the authenticated live session", async () => {
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-server-reconcile",
      path: "server-reconcile.html",
      mimeType: "text/html",
    };
    render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);
    await waitFor(() => expect(postAppLiveSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listPendingLiveProposalReviews).toHaveBeenCalledTimes(1));
    listPendingLiveProposalReviews.mockImplementation(async () => ({
      proposals: [{
        proposalId: "server-pending",
        appId: "nautilo-writer",
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision" as const, revision: 1 },
        operations: [{ type: "replace" }],
      }],
    }));

    await act(async () => requestLiveAppProposalReconciliation());

    const iframe = document.querySelector("iframe")!;
    await waitFor(() => expect(postAppLiveProposal).toHaveBeenCalledTimes(1));
    expect(postAppLiveProposal).toHaveBeenCalledWith(iframe, {
      proposalId: "server-pending",
      appId: "nautilo-writer",
      sessionId: "route-a",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      operations: [{ type: "replace" }],
    });
  });

  test("replays an old unresolved review after capability refresh and iframe reload", async () => {
    const writerRuntime = (sourceHash: string) => ({
      appId: "nautilo-writer",
      sourceHash,
      srcDoc: "<!DOCTYPE html><html><body>Writer</body></html>",
      manifest: {
        id: "nautilo-writer",
        name: "Writer",
        version: "0.1.0",
        fileAssociations: { extensions: [".html"] },
        capabilities: {},
        liveReview: { enabled: true as const },
      },
    });
    loadMiniAppRuntime
      .mockImplementationOnce(async () => writerRuntime("d".repeat(64)))
      .mockImplementationOnce(async () => writerRuntime("e".repeat(64)));
    issueLiveMiniAppSession
      .mockImplementationOnce(async () => ({
        sessionToken: "a".repeat(43),
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision" as const, revision: 1 },
        expiresAt: Date.now() + 60_000,
      }))
      .mockImplementationOnce(async () => ({
        sessionToken: "a".repeat(43),
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision" as const, revision: 2 },
        expiresAt: Date.now() + 60_000,
      }));
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-old-replay",
      path: "old-replay.html",
      mimeType: "text/html",
    };
    render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    const refreshCapability = installAppBridge.mock.calls[0]?.[0]?.onDocumentVersion;
    await act(async () => {
      await refreshCapability?.({ kind: "artifact_revision", revision: 2 });
    });
    await waitFor(() => expect(refreshLiveMiniAppSession).toHaveBeenCalledTimes(1));

    listPendingLiveProposalReviews.mockImplementation(async () => ({
      proposals: [{
        proposalId: "old-unresolved",
        appId: "nautilo-writer",
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision" as const, revision: 1 },
        operations: [{ type: "replace" }],
      }],
    }));
    await act(async () => {
      appEventHandler?.({
        type: "changed",
        appId: "nautilo-writer",
        sourceHash: "e".repeat(64),
      });
    });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="mini-app-update-available"] button')).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="mini-app-update-available"] button')!);
    });

    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(2));
    const iframe = document.querySelector("iframe")!;
    await waitFor(() => expect(postAppLiveProposal).toHaveBeenCalledTimes(1));
    expect(postAppLiveProposal).toHaveBeenLastCalledWith(iframe, {
      proposalId: "old-unresolved",
      appId: "nautilo-writer",
      sessionId: "route-a",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      operations: [{ type: "replace" }],
    });

    // The stale replay is deliberately sent only from the authenticated
    // reconciliation response. New live-bus delivery still requires the
    // current version and may proceed while Writer closes the old review.
    await act(async () => {
      publishLiveAppProposal({
        proposalId: "fresh-current",
        appId: "nautilo-writer",
        sessionId: "route-a",
        documentVersion: { kind: "artifact_revision", revision: 2 },
        operations: [{ type: "replace" }],
      });
    });
    await waitFor(() => expect(postAppLiveProposal).toHaveBeenCalledTimes(2));
    expect(postAppLiveProposal).toHaveBeenLastCalledWith(iframe, {
      proposalId: "fresh-current",
      appId: "nautilo-writer",
      sessionId: "route-a",
      documentVersion: { kind: "artifact_revision", revision: 2 },
      operations: [{ type: "replace" }],
    });
  });

  test("refreshes an idle Writer capability before its retained expiry", async () => {
    issueLiveMiniAppSession.mockImplementationOnce(async () => ({
      sessionToken: "idle-token".padEnd(43, "a"),
      sessionId: "idle-route",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
      expiresAt: Date.now() + 1_100,
    }));
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-idle",
      path: "idle.html",
      mimeType: "text/html",
    };
    const { unmount } = render(
      <MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />,
    );

    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    await waitFor(
      () =>
        expect(refreshLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
          sessionToken: "idle-token".padEnd(43, "a"),
          targetKind: "artifact",
        artifactId: "writer-artifact-idle",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        }),
      { timeout: 1_000 },
    );
    unmount();
  });

  test("cancels the scheduled idle refresh on unmount", async () => {
    issueLiveMiniAppSession.mockImplementationOnce(async () => ({
      sessionToken: "closing-token".padEnd(43, "b"),
      sessionId: "closing-route",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
      expiresAt: Date.now() + 1_200,
    }));
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-closing",
      path: "closing.html",
      mimeType: "text/html",
    };
    const { unmount } = render(
      <MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />,
    );
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(refreshLiveMiniAppSession).not.toHaveBeenCalled();
    expect(revokeLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
      sessionToken: "closing-token".padEnd(43, "b"),
    });
  });

  test("installs bridge for iframe and tears down on target change", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    const nextTarget = {
      ...target,
      id: "artifact-row-2",
      path: "next.document.json",
    };
    const onContextUpdate = mock(() => {});

    const { rerender } = render(
      <MiniAppSurface
        appId="sample-app"
        target={target}
        onContextUpdate={onContextUpdate}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    expect(installAppBridge.mock.calls[0]?.[0]).toMatchObject({
      appId: "sample-app",
      target,
      onContextUpdate: expect.any(Function),
    });

    rerender(
      <MiniAppSurface
        appId="sample-app"
        target={nextTarget}
        onContextUpdate={onContextUpdate}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(2));
    expect(teardownBridge).toHaveBeenCalledTimes(1);
    expect(installAppBridge.mock.calls[1]?.[0]).toMatchObject({
      appId: "sample-app",
      target: nextTarget,
      onContextUpdate: expect.any(Function),
    });
  });

  test("matching changed event shows update banner and reloads only on user action", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };

    loadMiniAppRuntime
      .mockImplementationOnce(async (appId: string) => ({
        appId,
        sourceHash: "d".repeat(64),
        srcDoc: "<!DOCTYPE html><html><body>v1</body></html>",
        manifest: {
          id: appId,
          name: "Sample App",
          version: "0.1.0",
          fileAssociations: { extensions: [".document.json"] },
          capabilities: {},
        },
      }))
      .mockImplementationOnce(async (appId: string) => ({
        appId,
        sourceHash: "e".repeat(64),
        srcDoc: "<!DOCTYPE html><html><body>v2</body></html>",
        manifest: {
          id: appId,
          name: "Sample App",
          version: "0.1.0",
          fileAssociations: { extensions: [".document.json"] },
          capabilities: {},
        },
      }));

    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(appEventHandler).not.toBeNull());
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());

    await act(async () => {
      appEventHandler!({
        type: "changed",
        appId: "sample-app",
        sourceHash: "e".repeat(64),
      });
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="mini-app-update-available"]')?.textContent).toContain(
        "App source changed",
      );
    });
    expect(loadMiniAppRuntime).toHaveBeenCalledTimes(1);
    expect(document.querySelector("iframe")!.getAttribute("srcDoc")).toContain("v1");

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="mini-app-update-available"] button')!);
    });

    await waitFor(() => {
      expect(loadMiniAppRuntime).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="mini-app-reload-notice"]')?.textContent).toContain(
        "App reloaded after source change.",
      );
    });

    expect(installAppBridge.mock.calls.at(-1)?.[0]).toMatchObject({
      appId: "sample-app",
      target,
    });
    expect(document.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(document.querySelector("iframe")!.getAttribute("srcDoc")).toContain("v2");
  });

  for (const state of ["dirty", "saving"] as const) {
    test(`guards source reload while an unmaterialized draft is ${state}`, async () => {
      const draft = { appId: "sample-app", createActionId: "create-document", suggestedName: "New.html" };
      const rendered = render(<MiniAppSurface appId="sample-app" draft={draft} onClose={() => {}} />);
      await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
      const iframe = document.querySelector("iframe");
      act(() => installAppBridge.mock.calls[0]?.[0]?.onHumanEditUpdate?.({ state }));
      act(() => appEventHandler?.({ type: "changed", appId: "sample-app", sourceHash: "e".repeat(64) }));
      fireEvent.click(rendered.getByRole("button", { name: "Reload app" }));
      expect(loadMiniAppRuntime).toHaveBeenCalledTimes(1);
      expect(document.querySelector("iframe")).toBe(iframe);
      fireEvent.click(rendered.getByRole("button", { name: "Discard and continue" }));
      await waitFor(() => expect(loadMiniAppRuntime).toHaveBeenCalledTimes(2));
    });
  }

  test("bound artifact reloadToken changes are forwarded to the running iframe", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.html",
      mimeType: "text/html",
      roomId: "room-1",
    };

    const { rerender } = render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = document.querySelector("iframe")!;
    expect(postAppDocumentChanged).not.toHaveBeenCalled();

    rerender(
      <MiniAppSurface
        appId="sample-app"
        target={{ ...target, path: "budget-updated.html", reloadToken: 1 }}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(postAppDocumentChanged).toHaveBeenCalledWith(iframe, {
        type: "changed",
        path: "budget-updated.html",
      });
    });
  });

  test("re-reads external Current Folder bytes before notifying the iframe", async () => {
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/notes.html",
    };
    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    const documentSession = installAppBridge.mock.calls.at(-1)?.[0]?.documentSession as {
      envelope: unknown;
    };

    let resolveFreshRead:
      | ((envelope: {
          content: string;
          mimeType: string;
          path: string;
          baseSha256: string;
          baseRevision: null;
        }) => void)
      | undefined;
    readDocumentSession.mockImplementationOnce(
      (session: { envelope: unknown }) =>
        new Promise((resolve) => {
          expect(session.envelope).toBeNull();
          resolveFreshRead = (envelope) => {
            session.envelope = envelope;
            resolve(envelope);
          };
        }),
    );
    resetDocumentReadSession.mockClear();
    postAppDocumentChanged.mockClear();

    await act(async () => {
      directoryChangedHandler?.({
        rootPath: "/repo",
        path: "/repo",
        changedPath: target.path,
        sha256: "e".repeat(64),
        reloadRequired: true,
      });
      await Promise.resolve();
    });

    expect(resetDocumentReadSession).toHaveBeenCalledWith(documentSession);
    expect(postAppDocumentChanged).not.toHaveBeenCalled();

    const freshEnvelope = {
      content: "fresh external bytes",
      mimeType: "",
      path: "notes.html",
      baseSha256: "e".repeat(64),
      baseRevision: null,
    } as const;
    await act(async () => {
      resolveFreshRead?.(freshEnvelope);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(postAppDocumentChanged).toHaveBeenCalledWith(document.querySelector("iframe"), {
        type: "changed",
        path: "notes.html",
        reloadRequired: true,
      }),
    );
    expect(documentSession.envelope).toEqual(freshEnvelope);
  });

  test("reissues a Current Folder live session after initial issue failure and canonical change", async () => {
    const recoveredToken = "current-file-recovered".padEnd(43, "r");
    const recoveredSha = "e".repeat(64);
    issueLiveMiniAppSession
      .mockImplementationOnce(async () => {
        throw new ApiError(503, "relay_unavailable");
      })
      .mockImplementationOnce(async () => ({
        sessionToken: recoveredToken,
        sessionId: "current-file-recovered-route",
        documentVersion: { kind: "local_sha" as const, sha256: recoveredSha },
        expiresAt: Date.now() + 60_000,
      }));
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/recovery.html",
    };

    render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    expect(issueLiveMiniAppSession).toHaveBeenLastCalledWith("nautilo-writer", {
      targetKind: "currentFile",
      relayIdHint: "relay-desktop-1",
      currentFolder: "/repo",
      relativePath: "recovery.html",
      documentVersion: { kind: "local_sha", sha256: "base-sha" },
    });
    expect(postAppLiveSession).not.toHaveBeenCalled();

    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = {
        content: "restored canonical bytes",
        mimeType: "text/html",
        path: "recovery.html",
        baseSha256: recoveredSha,
        baseRevision: null,
      };
      session.envelope = envelope;
      return envelope;
    });
    await act(async () => {
      directoryChangedHandler?.({
        rootPath: "/repo",
        path: "/repo",
        changedPath: target.path,
        sha256: recoveredSha,
        reloadRequired: true,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(2));
    expect(issueLiveMiniAppSession).toHaveBeenLastCalledWith("nautilo-writer", {
      targetKind: "currentFile",
      relayIdHint: "relay-desktop-1",
      currentFolder: "/repo",
      relativePath: "recovery.html",
      documentVersion: { kind: "local_sha", sha256: recoveredSha },
    });
    await waitFor(() => expect(postAppLiveSession).toHaveBeenCalledWith(expect.anything(), {
      sessionToken: recoveredToken,
      sessionId: "current-file-recovered-route",
      documentVersion: { kind: "local_sha", sha256: recoveredSha },
    }));
  });

  test("revokes a late Current Folder reissue after unmount", async () => {
    const recoveredToken = "current-file-late".padEnd(43, "r");
    const recoveredSha = "f".repeat(64);
    let resolveReissue:
      | ((capability: {
          sessionToken: string;
          sessionId: string;
          documentVersion: { kind: "local_sha"; sha256: string };
          expiresAt: number;
        }) => void)
      | null = null;
    issueLiveMiniAppSession
      .mockImplementationOnce(async () => {
        throw new ApiError(503, "relay_unavailable");
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveReissue = resolve;
      }));
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/late-recovery.html",
    };
    const { unmount } = render(
      <MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />,
    );

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = {
        content: "late restored canonical bytes",
        mimeType: "text/html",
        path: "late-recovery.html",
        baseSha256: recoveredSha,
        baseRevision: null,
      };
      session.envelope = envelope;
      return envelope;
    });
    await act(async () => {
      directoryChangedHandler?.({
        rootPath: "/repo",
        path: "/repo",
        changedPath: target.path,
        sha256: recoveredSha,
        reloadRequired: true,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(2));

    unmount();
    await act(async () => {
      resolveReissue?.({
        sessionToken: recoveredToken,
        sessionId: "current-file-late-route",
        documentVersion: { kind: "local_sha", sha256: recoveredSha },
        expiresAt: Date.now() + 60_000,
      });
      await Promise.resolve();
    });

    expect(postAppLiveSession).not.toHaveBeenCalled();
    await waitFor(() => expect(revokeLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
      sessionToken: recoveredToken,
    }));
  });

  test("revokes a late Current Folder reissue after the bound target changes", async () => {
    const staleToken = "current-file-stale".padEnd(43, "s");
    const currentToken = "current-file-current".padEnd(43, "c");
    const restoredSha = "7".repeat(64);
    let resolveStaleReissue:
      | ((capability: {
          sessionToken: string;
          sessionId: string;
          documentVersion: { kind: "local_sha"; sha256: string };
          expiresAt: number;
        }) => void)
      | null = null;
    issueLiveMiniAppSession
      .mockImplementationOnce(async () => {
        throw new ApiError(503, "relay_unavailable");
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveStaleReissue = resolve;
      }))
      .mockImplementationOnce(async () => ({
        sessionToken: currentToken,
        sessionId: "current-file-current-route",
        documentVersion: { kind: "local_sha" as const, sha256: restoredSha },
        expiresAt: Date.now() + 60_000,
      }));
    const staleTarget = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/stale-recovery.html",
    };
    const currentTarget = { ...staleTarget, path: "/repo/current.html" };
    const { rerender } = render(
      <MiniAppSurface appId="nautilo-writer" target={staleTarget} onClose={() => {}} />,
    );

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    readDocumentSession.mockImplementation(async (session: { envelope: unknown }) => {
      const envelope = {
        content: "restored canonical bytes",
        mimeType: "text/html",
        path: "current.html",
        baseSha256: restoredSha,
        baseRevision: null,
      };
      session.envelope = envelope;
      return envelope;
    });
    await act(async () => {
      directoryChangedHandler?.({
        rootPath: "/repo",
        path: "/repo",
        changedPath: staleTarget.path,
        sha256: restoredSha,
        reloadRequired: true,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(2));

    rerender(<MiniAppSurface appId="nautilo-writer" target={currentTarget} onClose={() => {}} />);
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(postAppLiveSession).toHaveBeenCalledWith(expect.anything(), {
      sessionToken: currentToken,
      sessionId: "current-file-current-route",
      documentVersion: { kind: "local_sha", sha256: restoredSha },
    }));

    await act(async () => {
      resolveStaleReissue?.({
        sessionToken: staleToken,
        sessionId: "current-file-stale-route",
        documentVersion: { kind: "local_sha", sha256: restoredSha },
        expiresAt: Date.now() + 60_000,
      });
      await Promise.resolve();
    });

    expect(postAppLiveSession).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionToken: staleToken,
    }));
    await waitFor(() => expect(revokeLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
      sessionToken: staleToken,
    }));
  });

  test("re-reads a Current Folder document after a committed Desktop mutation", async () => {
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/budget.html",
    };
    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(artifactEventHandler).not.toBeNull());
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    readDocumentSession.mockImplementationOnce(async (session: { envelope: unknown }) => {
      const envelope = {
        content: "fresh document bytes",
        mimeType: "text/html",
        path: "budget.html",
        baseSha256: "b".repeat(64),
        baseRevision: null,
        localIdentity: {
          relayId: "relay-desktop-1",
          canonicalPath: target.path,
        },
      };
      session.envelope = envelope;
      return envelope;
    });
    resetDocumentReadSession.mockClear();
    postAppDocumentChanged.mockClear();

    await act(async () => {
      await artifactEventHandler?.({
        type: "document.mutation.committed",
        operationId: "desktop-apply-patch:test",
        revisionGroupId: "group-test",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "agent", agentId: "agent-1" },
        mutation: "update",
        before: {
          identity: { kind: "local_file", relayId: "relay-desktop-1", canonicalPath: target.path },
          backendVersion: { kind: "local_sha", sha256: "a".repeat(64) },
          sha256: "a".repeat(64),
        },
        after: {
          identity: { kind: "local_file", relayId: "relay-desktop-1", canonicalPath: target.path },
          backendVersion: { kind: "local_sha", sha256: "b".repeat(64) },
          sha256: "b".repeat(64),
        },
      });
    });

    expect(resetDocumentReadSession).toHaveBeenCalled();
    expect(postAppDocumentChanged).toHaveBeenCalledWith(document.querySelector("iframe"), {
      type: "changed",
      path: "budget.html",
      reloadRequired: true,
    }, expect.any(Object));
  });

  test("preserves Current Folder patch events with the re-read canonical envelope", async () => {
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/patched.html",
    };
    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    const canonicalSha = "9".repeat(64);
    readDocumentSession.mockImplementationOnce(async (session: { envelope: unknown }) => {
      expect(session.envelope).toBeNull();
      const envelope = {
        content: "canonical patched bytes",
        mimeType: "",
        path: "patched.html",
        baseSha256: canonicalSha,
        baseRevision: null,
      };
      session.envelope = envelope;
      return envelope;
    });
    resetDocumentReadSession.mockClear();
    postAppDocumentChanged.mockClear();

    await act(async () => {
      directoryChangedHandler?.({
        rootPath: "/repo",
        path: "/repo",
        changedPath: target.path,
        patchEvent: {
          type: "document.patch.applied",
          target: {
            kind: "currentFile",
            currentFolderRef: target.rootPath,
            relativePath: "patched.html",
          },
          patchId: "patch-current-folder",
          revision: null,
          sha256: canonicalSha,
          previousRevision: null,
          previousSha256: "8".repeat(64),
          patch: { kind: "anchored_text", oldString: "old", newString: "canonical patched bytes" },
        },
      });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(postAppDocumentChanged).toHaveBeenCalledWith(
        document.querySelector("iframe"),
        expect.objectContaining({
          type: "patch_applied",
          patchId: "patch-current-folder",
          envelope: expect.objectContaining({
            content: "canonical patched bytes",
            baseSha256: canonicalSha,
          }),
        }),
      ),
    );
    expect(resetDocumentReadSession).toHaveBeenCalled();
  });

  test("suppresses repeated response-first accepted write events", async () => {
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/accepted.html",
    };
    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    resetDocumentReadSession.mockClear();
    postAppDocumentChanged.mockClear();
    registerPendingAcceptMutation("accept-response-first");
    markPendingAcceptMutationSucceeded("accept-response-first");

    await act(async () => {
      const event = {
        rootPath: "/repo",
        path: "/repo",
        changedPath: target.path,
        clientMutationId: "accept-response-first",
        sha256: "f".repeat(64),
        reloadRequired: true,
      };
      directoryChangedHandler?.(event);
      directoryChangedHandler?.(event);
      await Promise.resolve();
    });

    expect(resetDocumentReadSession).not.toHaveBeenCalled();
    expect(postAppDocumentChanged).not.toHaveBeenCalled();
  });

  test("discards repeated event-first changes after confirmed acceptance", async () => {
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/event-first-success.html",
    };
    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    resetDocumentReadSession.mockClear();
    postAppDocumentChanged.mockClear();
    registerPendingAcceptMutation("accept-event-first-success");
    const event = {
      rootPath: "/repo",
      path: "/repo",
      changedPath: target.path,
      clientMutationId: "accept-event-first-success",
      sha256: "1".repeat(64),
      reloadRequired: true,
    };

    await act(async () => {
      directoryChangedHandler?.(event);
      directoryChangedHandler?.(event);
      await Promise.resolve();
    });
    expect(resetDocumentReadSession).not.toHaveBeenCalled();

    markPendingAcceptMutationSucceeded("accept-event-first-success");
    await act(async () => {
      directoryChangedHandler?.(event);
      await Promise.resolve();
    });

    expect(resetDocumentReadSession).not.toHaveBeenCalled();
    expect(postAppDocumentChanged).not.toHaveBeenCalled();
  });

  test("replays an event-first acceptance change as external after failure", async () => {
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/event-first-failure.html",
    };
    issueLiveMiniAppSession.mockImplementationOnce(async () => ({
      sessionToken: "failure-token".padEnd(43, "f"),
      sessionId: "failure-route",
      documentVersion: { kind: "local_sha" as const, sha256: "base-sha" },
      expiresAt: Date.now() + 60_000,
    }));
    render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    readDocumentSession.mockImplementationOnce(async (session: { envelope: unknown }) => {
      expect(session.envelope).toBeNull();
      const envelope = {
        content: "canonical after failed acceptance",
        mimeType: "",
        path: "event-first-failure.html",
        baseSha256: "2".repeat(64),
        baseRevision: null,
      };
      session.envelope = envelope;
      return envelope;
    });
    resetDocumentReadSession.mockClear();
    postAppDocumentChanged.mockClear();
    registerPendingAcceptMutation("accept-event-first-failure");

    await act(async () => {
      directoryChangedHandler?.({
        rootPath: "/repo",
        path: "/repo",
        changedPath: target.path,
        clientMutationId: "accept-event-first-failure",
        sha256: "2".repeat(64),
        reloadRequired: true,
      });
      await Promise.resolve();
    });
    expect(resetDocumentReadSession).not.toHaveBeenCalled();

    await act(async () => {
      failPendingAcceptMutation("accept-event-first-failure");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(postAppDocumentChanged).toHaveBeenCalledWith(document.querySelector("iframe"), {
        type: "changed",
        path: "event-first-failure.html",
        reloadRequired: true,
      }),
    );
    expect(resetDocumentReadSession).toHaveBeenCalled();
    await waitFor(() =>
      expect(refreshLiveMiniAppSession).toHaveBeenCalledWith(
        "nautilo-writer",
        expect.objectContaining({
          documentVersion: { kind: "local_sha", sha256: "2".repeat(64) },
        }),
      ),
    );
  });

  test("replays a deferred acceptance event when its response expires", async () => {
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/expired-acceptance.html",
    };
    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    readDocumentSession.mockImplementationOnce(async (session: { envelope: unknown }) => {
      const envelope = {
        content: "canonical after timeout",
        mimeType: "",
        path: "expired-acceptance.html",
        baseSha256: "3".repeat(64),
        baseRevision: null,
      };
      session.envelope = envelope;
      return envelope;
    });
    resetDocumentReadSession.mockClear();
    postAppDocumentChanged.mockClear();

    const originalDateNow = Date.now;
    let now = 5_000;
    Date.now = () => now;
    try {
      registerPendingAcceptMutation("accept-no-response");
      await act(async () => {
        directoryChangedHandler?.({
          rootPath: "/repo",
          path: "/repo",
          changedPath: target.path,
          clientMutationId: "accept-no-response",
          sha256: "3".repeat(64),
          reloadRequired: true,
        });
        await Promise.resolve();
      });
      expect(resetDocumentReadSession).not.toHaveBeenCalled();

      now += 60_001;
      await act(async () => {
        registerPendingAcceptMutation("trigger-expiry-sweep");
        await Promise.resolve();
      });
    } finally {
      Date.now = originalDateNow;
    }

    await waitFor(() =>
      expect(postAppDocumentChanged).toHaveBeenCalledWith(document.querySelector("iframe"), {
        type: "changed",
        path: "expired-acceptance.html",
        reloadRequired: true,
      }),
    );
  });

  test("drops deferred acceptance callbacks when the surface unmounts", async () => {
    const target = {
      kind: "fs" as const,
      rootPath: "/repo",
      path: "/repo/unmounted-acceptance.html",
    };
    const { unmount } = render(
      <MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />,
    );

    await waitFor(() => expect(directoryChangedHandler).not.toBeNull());
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    registerPendingAcceptMutation("accept-before-unmount");
    await act(async () => {
      directoryChangedHandler?.({
        rootPath: "/repo",
        path: "/repo",
        changedPath: target.path,
        clientMutationId: "accept-before-unmount",
        sha256: "4".repeat(64),
        reloadRequired: true,
      });
      await Promise.resolve();
    });

    unmount();
    resetDocumentReadSession.mockClear();
    postAppDocumentChanged.mockClear();
    failPendingAcceptMutation("accept-before-unmount");
    await Promise.resolve();

    expect(resetDocumentReadSession).not.toHaveBeenCalled();
    expect(postAppDocumentChanged).not.toHaveBeenCalled();
  });

  test("ignores changed events for other apps and identical source hashes", async () => {
    render(<MiniAppSurface appId="sample-app" onClose={() => {}} />);

    await waitFor(() => expect(appEventHandler).not.toBeNull());
    await waitFor(() => expect(loadMiniAppRuntime).toHaveBeenCalledTimes(1));

    await act(async () => {
      appEventHandler!({ type: "changed", appId: "other", sourceHash: "z".repeat(64) });
      appEventHandler!({ type: "changed", appId: "sample-app", sourceHash: "d".repeat(64) });
    });

    await waitFor(() => {
      expect(loadMiniAppRuntime).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector('[data-testid="mini-app-reload-notice"]')).toBeNull();
  });

  test("draft launch shows editable doc name seeded from suggestedName", async () => {
    const draft = {
      appId: "sample-app",
      createActionId: "create-document",
      suggestedName: "Untitled document.html",
    };

    render(<MiniAppSurface appId="sample-app" draft={draft} onClose={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="mini-app-doc-name"]')).not.toBeNull();
    });

    const nameButton = document.querySelector('[data-testid="mini-app-doc-name"]');
    expect(nameButton?.textContent).toContain("Untitled document.html");
  });

  test("draft launch installs bridge without a bound target", async () => {
    const draft = {
      appId: "sample-app",
      createActionId: "create-document",
      suggestedName: "Untitled document.html",
    };

    render(<MiniAppSurface appId="sample-app" draft={draft} onClose={() => {}} />);

    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));

    const bridgeOpts = installAppBridge.mock.calls[0]?.[0];
    expect(bridgeOpts).toMatchObject({
      appId: "sample-app",
      draft,
    });
    expect(bridgeOpts?.target).toBeUndefined();
    expect(typeof bridgeOpts?.materialize).toBe("function");
    expect(bridgeOpts?.documentSession).toBeDefined();
  });

  test("forwards external patch events to iframe and ignores own clientMutationId", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
      roomId: "room-1",
    };

    applyDocumentPatchToWriteSession.mockReturnValueOnce({
      type: "patch_applied",
      path: "budget.document.json",
      patchId: "patch-remote",
      revision: 5,
      sha256: "sha-next",
      previousRevision: 4,
      previousSha256: "sha-prev",
      patch: { kind: "anchored_text", oldString: "a", newString: "b" },
      envelope: {
        content: "b",
        mimeType: target.mimeType,
        path: target.path,
        baseSha256: "sha-next",
        documentVersion: { kind: "artifact_revision" as const, revision: 5 },
      },
    });

    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(subscribeWorkspaceArtifactEventsMock).toHaveBeenCalledTimes(1));
    expect(subscribeWorkspaceArtifactEventsMock.mock.calls[0]?.[1]).toEqual({
      artifactId: "artifact-row-1",
      roomId: "room-1",
      onReconnect: expect.any(Function),
    });
    await waitFor(() => expect(artifactEventHandler).not.toBeNull());

    const iframe = document.querySelector("iframe")!;
    const patchEvent = {
      type: "document.patch.applied" as const,
      target: {
        kind: "artifact" as const,
        artifactInternalId: target.id,
        path: target.path,
      },
      patchId: "patch-remote",
      revision: 5,
      sha256: "sha-next",
      previousRevision: 4,
      previousSha256: "sha-prev",
      patch: { kind: "anchored_text" as const, oldString: "a", newString: "b" },
      author: { kind: "human" as const, displayName: "User" },
      clientMutationId: "own-mutation",
    };

    isLocalArtifactSaveMutationMock.mockReturnValueOnce(true);
    await act(async () => {
      await artifactEventHandler!(patchEvent);
    });
    expect(applyDocumentPatchToWriteSession).not.toHaveBeenCalled();
    expect(postAppDocumentChanged).not.toHaveBeenCalled();

    isLocalArtifactSaveMutationMock.mockReturnValueOnce(false);
    await act(async () => {
      await artifactEventHandler!(patchEvent);
    });

    expect(applyDocumentPatchToWriteSession).toHaveBeenCalledTimes(1);
    expect(postAppDocumentChanged).toHaveBeenCalledWith(iframe, {
      type: "patch_applied",
      path: "budget.document.json",
      patchId: "patch-remote",
      revision: 5,
      sha256: "sha-next",
      previousRevision: 4,
      previousSha256: "sha-prev",
      patch: { kind: "anchored_text", oldString: "a", newString: "b" },
      envelope: {
        content: "b",
        mimeType: target.mimeType,
        path: target.path,
        baseSha256: "sha-next",
        documentVersion: { kind: "artifact_revision" as const, revision: 5 },
      },
    });

    const originalConsoleInfo = console.info;
    const reconnectDiagnostics = mock(() => {});
    console.info = reconnectDiagnostics;
    window.history.replaceState({}, "", "/?miniAppDiagnostics=1");
    try {
      postAppDocumentChanged.mockClear();
      await act(async () => {
        await Promise.all([
          subscribeWorkspaceArtifactEventsMock.mock.calls[0]?.[1]?.onReconnect?.(),
          subscribeWorkspaceArtifactEventsMock.mock.calls[0]?.[1]?.onReconnect?.(),
        ]);
      });
      expect(postAppDocumentChanged).toHaveBeenCalledTimes(1);
      expect(postAppDocumentChanged).toHaveBeenCalledWith(iframe, { type: "reconnected" });
      expect(reconnectDiagnostics).toHaveBeenCalledTimes(1);
      expect(reconnectDiagnostics).toHaveBeenCalledWith(
        "[mini-app][artifact-reconnect]",
        JSON.stringify({ event: "stream_reconnected", outcome: "canonical_unchanged" }),
      );
    } finally {
      console.info = originalConsoleInfo;
      window.history.replaceState({}, "", "/");
    }
  });

  test("forwards an agent-triggered Design tool patch with its exact revision chain to the iframe", async () => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => ({
      appId,
      sourceHash: "d".repeat(64),
      srcDoc: "<!DOCTYPE html><html><body>Design placeholder</body></html>",
      manifest: {
        id: appId,
        name: "Design",
        version: "0.1.0",
        fileAssociations: { extensions: [".html"] },
        capabilities: {},
        liveReview: { enabled: true as const },
      },
    }));
    const target = {
      kind: "artifact" as const,
      id: "design-artifact-1",
      path: "Hero.design.html",
      mimeType: "text/html",
      roomId: "room-1",
    };
    const applied = {
      type: "patch_applied" as const,
      path: target.path,
      patchId: "design-agent-patch-2",
      revision: 2,
      sha256: "design-sha-2",
      previousRevision: 1,
      previousSha256: "design-sha-1",
      patch: { kind: "anchored_text" as const, oldString: "old scene", newString: "agent scene" },
      author: { kind: "app_tool" as const, displayName: "nautilo-design" },
      rebased: false,
      envelope: {
        content: "agent scene",
        mimeType: target.mimeType,
        path: target.path,
        baseSha256: "design-sha-2",
        baseRevision: 2,
      },
    };
    applyDocumentPatchToWriteSession.mockReturnValueOnce(applied);

    render(<MiniAppSurface appId="nautilo-design" target={target} onClose={() => {}} />);

    await waitFor(() => expect(artifactEventHandler).not.toBeNull());
    await waitFor(() => expect(issueLiveMiniAppSession).toHaveBeenCalledTimes(1));
    const iframe = document.querySelector("iframe")!;
    await act(async () => {
      await artifactEventHandler!({
        type: "document.patch.applied",
        target: { kind: "artifact", artifactInternalId: target.id, path: target.path },
        patchId: applied.patchId,
        revision: applied.revision,
        sha256: applied.sha256,
        previousRevision: applied.previousRevision,
        previousSha256: applied.previousSha256,
        patch: applied.patch,
        author: applied.author,
        rebased: applied.rebased,
      });
    });

    expect(postAppDocumentChanged).toHaveBeenCalledWith(iframe, applied);
    await waitFor(() =>
      expect(refreshLiveMiniAppSession).toHaveBeenCalledWith("nautilo-design", {
        sessionToken: "a".repeat(43),
        targetKind: "artifact",
        artifactId: target.id,
        documentVersion: { kind: "artifact_revision", revision: 2 },
      }),
    );
    expect(postAppDocumentChanged).toHaveBeenCalledTimes(1);
    expect(postAppDocumentChanged).not.toHaveBeenCalledWith(
      iframe,
      expect.objectContaining({ type: "changed" }),
    );
  });

  test.each(["nautilo-design", "nautilo-board"] as const)("rereads open %s after its direct agent edit reports success", async (appId) => {
    loadMiniAppRuntime.mockImplementationOnce(async (appId: string) => ({
      appId,
      sourceHash: "d".repeat(64),
      srcDoc: "<!DOCTYPE html><html><body>Design placeholder</body></html>",
      manifest: {
        id: appId,
        name: "Design",
        version: "0.1.0",
        fileAssociations: { extensions: [".html"] },
        capabilities: {},
        liveReview: { enabled: true as const },
      },
    }));
    const target = {
      kind: "artifact" as const,
      id: "design-artifact-direct-edit",
      path: "pelican.html",
      mimeType: "text/html",
      roomId: "room-1",
    };

    render(<MiniAppSurface appId={appId} target={target} onClose={() => {}} />);

    await waitFor(() => expect(subscribeWorkspaceArtifactEventsMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    const readsBeforeMutation = readDocumentSession.mock.calls.length;
    postAppDocumentChanged.mockClear();
    readDocumentSession.mockImplementationOnce(async (session: { envelope: unknown }) => {
      const envelope = {
        content: "pelican scene",
        mimeType: "text/html",
        path: "pelican.html",
        baseSha256: "pelican-sha",
        baseRevision: 2,
      };
      session.envelope = envelope;
      return envelope;
    });

    await act(async () => {
      publishLiveAppMutationCommitted({
        appId,
        toolCallId: "design-edit-success",
      });
    });

    await waitFor(() => expect(readDocumentSession).toHaveBeenCalledTimes(readsBeforeMutation + 1));
    const iframe = document.querySelector("iframe")!;
    expect(postAppDocumentChanged).toHaveBeenCalledWith(iframe, {
      type: "changed",
      path: "pelican.html",
      reloadRequired: true,
    }, expect.any(Object));
    expect(refreshLiveMiniAppSession).toHaveBeenCalledWith(appId, {
      sessionToken: "a".repeat(43),
      targetKind: "artifact",
      artifactId: target.id,
      documentVersion: { kind: "artifact_revision", revision: 2 },
    });
  });

  test("reloads and refreshes Writer version when reconnect discovers a newer artifact", async () => {
    const target = {
      kind: "artifact" as const,
      id: "writer-artifact-reconnect-change",
      path: "proposal.html",
      mimeType: "text/html",
      roomId: "room-1",
    };

    render(<MiniAppSurface appId="nautilo-writer" target={target} onClose={() => {}} />);

    await waitFor(() => expect(subscribeWorkspaceArtifactEventsMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(postAppLiveSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    readDocumentSession.mockImplementationOnce(async (session: { envelope: unknown }) => {
      const envelope = {
        content: "new canonical content\n",
        mimeType: "text/html",
        path: "budget.html",
        baseSha256: "new-sha",
        baseRevision: 2,
      };
      session.envelope = envelope;
      return envelope;
    });
    postAppDocumentChanged.mockClear();
    refreshLiveMiniAppSession.mockClear();

    const originalConsoleInfo = console.info;
    const reconnectDiagnostics = mock(() => {});
    console.info = reconnectDiagnostics;
    window.history.replaceState({}, "", "/?miniAppDiagnostics=1");
    try {
      await act(async () => {
        await subscribeWorkspaceArtifactEventsMock.mock.calls[0]?.[1]?.onReconnect?.();
      });

      expect(postAppDocumentChanged).toHaveBeenCalledWith(document.querySelector("iframe"), {
        type: "changed",
        path: target.path,
        reloadRequired: true,
      }, expect.any(Object));
      await waitFor(() =>
        expect(refreshLiveMiniAppSession).toHaveBeenCalledWith("nautilo-writer", {
          sessionToken: "a".repeat(43),
          targetKind: "artifact",
          artifactId: target.id,
          documentVersion: { kind: "artifact_revision", revision: 2 },
        }),
      );
      expect(reconnectDiagnostics).toHaveBeenCalledTimes(1);
      expect(reconnectDiagnostics).toHaveBeenCalledWith(
        "[mini-app][artifact-reconnect]",
        JSON.stringify({ event: "stream_reconnected", outcome: "canonical_changed" }),
      );
    } finally {
      console.info = originalConsoleInfo;
      window.history.replaceState({}, "", "/");
    }
  });

  test("seeds document session before applying an early external patch", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    applyDocumentPatchToWriteSession.mockImplementationOnce((session: { envelope?: unknown }) => {
      expect(session.envelope).toMatchObject({ content: "base\n", baseSha256: "base-sha" });
      return {
        type: "patch_applied",
        path: target.path,
        patchId: "patch-remote",
        revision: 2,
        sha256: "sha-next",
        previousRevision: 1,
        previousSha256: "base-sha",
        patch: { kind: "anchored_text", oldString: "base\n", newString: "next\n" },
        envelope: {
          content: "next\n",
          mimeType: target.mimeType,
          path: target.path,
          baseSha256: "sha-next",
          baseRevision: 2,
        },
      };
    });

    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(artifactEventHandler).not.toBeNull());
    await act(async () => {
      await artifactEventHandler!({
        type: "document.patch.applied",
        target: { kind: "artifact", artifactInternalId: target.id, path: target.path },
        patchId: "patch-remote",
        revision: 2,
        sha256: "sha-next",
        previousRevision: 1,
        previousSha256: "base-sha",
        patch: { kind: "anchored_text", oldString: "base\n", newString: "next\n" },
      });
    });

    await waitFor(() => expect(readDocumentSession).toHaveBeenCalled());
    await waitFor(() => expect(applyDocumentPatchToWriteSession).toHaveBeenCalledTimes(1));
  });

  test("patch event cancels pending generic changed notification", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };
    applyDocumentPatchToWriteSession.mockReturnValueOnce({
      type: "patch_applied",
      path: target.path,
      patchId: "patch-remote",
      revision: 5,
      sha256: "sha-next",
      previousRevision: 4,
      previousSha256: "sha-prev",
      patch: { kind: "anchored_text", oldString: "a", newString: "b" },
      envelope: {
        content: "b",
        mimeType: target.mimeType,
        path: target.path,
        baseSha256: "sha-next",
        documentVersion: { kind: "artifact_revision" as const, revision: 5 },
      },
    });

    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(artifactEventHandler).not.toBeNull());
    await act(async () => {
      artifactEventHandler!({
        type: "changed",
        id: target.id,
        artifactId: "artifact-public",
        path: target.path,
      });
      artifactEventHandler!({
        type: "document.patch.applied",
        target: { kind: "artifact", artifactInternalId: target.id, path: target.path },
        patchId: "patch-remote",
        revision: 5,
        sha256: "sha-next",
        previousRevision: 4,
        previousSha256: "sha-prev",
        patch: { kind: "anchored_text", oldString: "a", newString: "b" },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(postAppDocumentChanged).toHaveBeenCalledTimes(1);
    expect(postAppDocumentChanged.mock.calls[0]?.[1]).toMatchObject({
      type: "patch_applied",
      patchId: "patch-remote",
    });
  });

  test("posts reloadRequired changed when patch apply fails", async () => {
    const target = {
      kind: "artifact" as const,
      id: "artifact-row-1",
      path: "budget.document.json",
      mimeType: "application/vnd.nautilo.document+json",
    };

    applyDocumentPatchToWriteSession.mockReturnValueOnce(null);

    render(<MiniAppSurface appId="sample-app" target={target} onClose={() => {}} />);

    await waitFor(() => expect(artifactEventHandler).not.toBeNull());
    const iframe = document.querySelector("iframe")!;

    await act(async () => {
      artifactEventHandler!({
        type: "document.patch.applied",
        target: {
          kind: "artifact",
          artifactInternalId: target.id,
          path: target.path,
        },
        patchId: "patch-fail",
        revision: 2,
        sha256: "sha-next",
        previousRevision: 1,
        previousSha256: "sha-prev",
        patch: { kind: "anchored_text", oldString: "missing", newString: "found" },
        author: { kind: "agent", displayName: "Genie" },
      });
    });

    expect(postAppDocumentChanged).toHaveBeenCalledWith(iframe, {
      type: "changed",
      path: target.path,
      reloadRequired: true,
    }, expect.any(Object));
  });

  test("draft materialization uses a collision-free fallback name", async () => {
    const draft = {
      appId: "sample-app",
      createActionId: "create-document",
      suggestedName: "Untitled document.html",
      roomId: "room-7",
    };
    const onMaterialized = mock(() => {});
    listWorkspaceArtifacts.mockImplementationOnce(async () => ({
      artifacts: [
        {
          id: "existing-1",
          path: "Untitled document.html",
          mimeType: "text/html",
        },
      ],
    }));

    render(<MiniAppSurface appId="sample-app" draft={draft} onMaterialized={onMaterialized} onClose={() => {}} />);

    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    const materialize = installAppBridge.mock.calls[0]?.[0]?.materialize;
    expect(typeof materialize).toBe("function");
    let target: Awaited<ReturnType<NonNullable<typeof materialize>>> | null = null;
    await act(async () => {
      target = await materialize!("edited-content", "text/html");
    });

    expect(listWorkspaceArtifacts).toHaveBeenCalledWith({ roomId: "room-7" });
    expect(createWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(createWorkspaceArtifact.mock.calls[0]?.[1]).toMatchObject({
      path: "Untitled document 2.html",
      mimeType: "text/html",
      roomId: "room-7",
    });
    expect(target).toMatchObject({
      kind: "artifact",
      id: "artifact-created-1",
      path: "Untitled document 2.html",
      mimeType: "text/html",
      roomId: "room-7",
    });
    expect(onMaterialized).toHaveBeenCalledWith(target);
  });

  test("draft materialization retries with a fallback name when create races a 409", async () => {
    const draft = {
      appId: "sample-app",
      createActionId: "create-document",
      suggestedName: "Untitled document.html",
    };
    listWorkspaceArtifacts.mockImplementation(async () => ({ artifacts: [] }));
    createWorkspaceArtifact
      .mockImplementationOnce(async () => {
        throw new ApiError(409, "An artifact already exists at this path");
      })
      .mockImplementationOnce(async (_file: Blob, opts: { path: string; mimeType: string }) => ({
        id: "artifact-created-2",
        artifactId: "external-artifact-created-2",
        path: opts.path,
        mimeType: opts.mimeType,
        size: 12,
        revision: 1,
        createdAt: "2026-06-26T00:00:00.000Z",
        updatedAt: "2026-06-26T00:00:00.000Z",
        namespaceIds: [],
      }));

    render(<MiniAppSurface appId="sample-app" draft={draft} onClose={() => {}} />);

    await waitFor(() => expect(installAppBridge).toHaveBeenCalledTimes(1));
    const materialize = installAppBridge.mock.calls[0]?.[0]?.materialize;
    expect(typeof materialize).toBe("function");
    let target: Awaited<ReturnType<NonNullable<typeof materialize>>> | null = null;
    await act(async () => {
      target = await materialize!("edited-content", "text/html");
    });

    expect(listWorkspaceArtifacts).toHaveBeenCalledTimes(2);
    expect(createWorkspaceArtifact).toHaveBeenCalledTimes(2);
    expect(createWorkspaceArtifact.mock.calls[0]?.[1]).toMatchObject({
      path: "Untitled document.html",
    });
    expect(createWorkspaceArtifact.mock.calls[1]?.[1]).toMatchObject({
      path: "Untitled document 2.html",
    });
    expect(target.path).toBe("Untitled document 2.html");
  });
});
