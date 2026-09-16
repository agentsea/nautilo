/**
 * M088C item 3 step 2 — FS-branch regression guard.
 *
 * The Files tab (Surface B) is intentionally untouched per M088 success
 * criterion 5; binary viewers must use the sender-owned `binaryRead` bridge
 * (text viewers retain `desktopAPI.fs.readFile`) and must NOT route
 * through `apiClient.getWorkspaceArtifactBytes`. A future PR that
 * "simplifies" all viewers to go through the API would otherwise pass
 * the suite and 404 on every Files-tab click.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

const apiBytesMock = mock(async () => new Blob());

mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytes: apiBytesMock,
  },
}));

let stat: { exists: boolean; size: number } = { exists: true, size: 16 };
let readFileResult = "alpha";
const statMock = mock(async () => stat);
const binaryOpenMock = mock(async () => ({ ok: true as const, data: { id: "session", size: stat.size, chunkSize: 3 } }));
const binaryReadMock = mock(async (_id: string, position: number) => ({ ok: true as const, data: { bytes: position === 0 ? new Uint8Array([0, 0, 0]) : new Uint8Array(), position, done: true } }));
const binaryCloseMock = mock(async () => ({ ok: true as const, data: null }));
const readFileMock = mock(async () => readFileResult);

mock.module("../../../src/lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    fs: {
      stat: statMock,
      readFile: readFileMock,
    },
    binaryRead: { open: binaryOpenMock, read: binaryReadMock, close: binaryCloseMock },
  },
  // Stack 19 Phase 6.9.6 fix: partial mocks of lib/desktop omit Stack
  // 19's new runtime exports under Bun's mock-hoisting → other tests
  // importing them get `Export named 'X' not found`. Stubs MUST
  // call-through to `window.nautiloDesktop` (see forgot-password
  // sibling for full rationale).
  getShellStateOnBoot: () => {
    if (typeof window === "undefined") return null;
    const api = (window as unknown as { nautiloDesktop?: { shellStateOnBoot?: () => unknown } }).nautiloDesktop;
    if (!api?.shellStateOnBoot) return null;
    try { return api.shellStateOnBoot() ?? null; } catch { return null; }
  },
  computeInitialLastOpenAtSeed: (input: { hasEverBeenOpen: boolean; shellStateOnBoot: unknown; now: number }) => {
    const base = input.hasEverBeenOpen ? input.now : null;
    if (input.shellStateOnBoot != null && input.shellStateOnBoot !== "live" && base === null) return input.now;
    return base;
  },
}));

const { imageViewerAdapter } = await import("../../../src/viewers/image/adapter");
const { pdfViewerAdapter } = await import("../../../src/viewers/pdf/adapter");
const { markdownViewerAdapter } = await import("../../../src/viewers/markdown/adapter");
const { textViewerAdapter } = await import("../../../src/viewers/text/adapter");
const { docxViewerAdapter } = await import("../../../src/viewers/ooxml/docx");
const { xlsxViewerAdapter } = await import("../../../src/viewers/ooxml/xlsx");
const { pptxViewerAdapter } = await import("../../../src/viewers/ooxml/pptx");

afterEach(() => {
  apiBytesMock.mockClear();
  statMock.mockClear();
  binaryOpenMock.mockClear();
  binaryReadMock.mockClear();
  binaryCloseMock.mockClear();
  readFileMock.mockClear();
  stat = { exists: true, size: 16 };
});

function fsTarget(path: string) {
  return { kind: "fs" as const, path, rootPath: "/work" };
}

describe("viewer FS branches keep using desktopAPI (M088C item 3 step 2)", () => {
  test("image FS branch calls binaryRead, not Artifact bytes", async () => {
    await imageViewerAdapter.load(fsTarget("/work/photo.png"), { maxTextBytes: 1_000_000 });
    expect(binaryOpenMock).toHaveBeenCalled();
    expect(apiBytesMock).not.toHaveBeenCalled();
  });

  test("pdf FS branch calls binaryRead, not Artifact bytes", async () => {
    await pdfViewerAdapter.load(fsTarget("/work/doc.pdf"), { maxTextBytes: 1_000_000 });
    expect(binaryOpenMock).toHaveBeenCalled();
    expect(apiBytesMock).not.toHaveBeenCalled();
  });

  test("docx FS branch never routes through getWorkspaceArtifactBytes", async () => {
    // The test's only purpose is the regression guard "FS does not hit the
    // API". The over-cap return short-circuits before the parser runs.
    stat = { exists: true, size: 101 * 1024 * 1024 };
    const r = await docxViewerAdapter.load(fsTarget("/work/doc.docx"), {
      maxTextBytes: 1_000_000,
    });
    expect(r.kind).toBe("too_large");
    expect(statMock).toHaveBeenCalled();
    expect(apiBytesMock).not.toHaveBeenCalled();
  });

  test("xlsx FS branch never routes through getWorkspaceArtifactBytes", async () => {
    stat = { exists: true, size: 101 * 1024 * 1024 };
    const r = await xlsxViewerAdapter.load(fsTarget("/work/sheet.xlsx"), {
      maxTextBytes: 1_000_000,
    });
    expect(r.kind).toBe("too_large");
    expect(statMock).toHaveBeenCalled();
    expect(apiBytesMock).not.toHaveBeenCalled();
  });

  test("pptx FS branch never routes through getWorkspaceArtifactBytes", async () => {
    stat = { exists: true, size: 101 * 1024 * 1024 };
    const r = await pptxViewerAdapter.load(fsTarget("/work/deck.pptx"), {
      maxTextBytes: 1_000_000,
    });
    expect(r.kind).toBe("too_large");
    expect(statMock).toHaveBeenCalled();
    expect(apiBytesMock).not.toHaveBeenCalled();
  });

  test("markdown FS branch calls readFile, not getWorkspaceArtifactBytes", async () => {
    await markdownViewerAdapter.load(fsTarget("/work/notes.md"), { maxTextBytes: 1_000_000 });
    expect(readFileMock).toHaveBeenCalled();
    expect(apiBytesMock).not.toHaveBeenCalled();
  });

  test("text FS branch calls readFile, not getWorkspaceArtifactBytes", async () => {
    await textViewerAdapter.load(fsTarget("/work/log.txt"), { maxTextBytes: 1_000_000 });
    expect(readFileMock).toHaveBeenCalled();
    expect(apiBytesMock).not.toHaveBeenCalled();
  });

  test("FS over-cap returns kind: too_large (image)", async () => {
    stat = { exists: true, size: 26 * 1024 * 1024 };
    const r = await imageViewerAdapter.load(fsTarget("/work/big.png"), {
      maxTextBytes: 1_000_000,
    });
    expect(r.kind).toBe("too_large");
  });

  test("FS over-cap returns kind: too_large (pdf)", async () => {
    stat = { exists: true, size: 60 * 1024 * 1024 };
    const r = await pdfViewerAdapter.load(fsTarget("/work/big.pdf"), {
      maxTextBytes: 1_000_000,
    });
    expect(r.kind).toBe("too_large");
  });

  test("FS over-cap returns kind: too_large (markdown)", async () => {
    stat = { exists: true, size: 5_000 };
    const r = await markdownViewerAdapter.load(fsTarget("/work/big.md"), {
      maxTextBytes: 1_000,
    });
    expect(r.kind).toBe("too_large");
  });

  test("FS over-cap returns kind: too_large (text)", async () => {
    stat = { exists: true, size: 5_000 };
    const r = await textViewerAdapter.load(fsTarget("/work/big.txt"), {
      maxTextBytes: 1_000,
    });
    expect(r.kind).toBe("too_large");
  });
});

afterAll(() => {
  mock.restore();
});
