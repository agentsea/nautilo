/**
 * D362 Milestone B — hermetic unit tests for `office` `inPlace: true`
 * (live coolwsd session edit of a workspace doc).
 *
 * Mock strategy mirrors `office-workspace.test.ts`:
 *   - Spread-the-real-module for `../file/artifact-store` (keep types,
 *     stub only the DB-touching fns `resolveWorkspaceArtifact` +
 *     `applyWorkspaceArtifactRowChange`).
 *   - Inject a fake `makeClient` via `createOfficeTool(ctx, { makeClient })`
 *     so we don't mock `@nautilo/loffice` process-wide.
 *   - Inject a fake `makeSession` via the same deps bag — the fake
 *     records the UNO lines it would have sent and resolves
 *     `sendUnoAndWait`/`save` immediately.
 *   - Wire a fake broker via `setOfficeSessionBroker` from
 *     `./session-broker` (process-global, restored in afterAll).
 *
 * No global `mock.module("@nautilo/loffice")` — that would clobber the
 * real `LofficeClient` for co-running files (office.live.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp, JimpMime } from "jimp";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { readImagePixelSize, LO_INSERT_DPI, type CoolSessionLike, type CoolSessionOptions, type UnoArgs } from "@nautilo/loffice";
import type { CreateOfficeToolDeps } from "./office";
import { computeImagePlacementRect } from "./office";
import {
  resetOfficeSessionBroker,
  setOfficeSessionBroker,
  type OfficeSessionBroker,
  type OfficeSessionMintOptions,
} from "./session-broker";
import { resetOfficeSessionManagerForTests } from "./session-manager";

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

// ─── Fake session ────────────────────────────────────────────────────
// Records every UNO line it would have sent and resolves wait/save
// immediately. The test inspects `sentLines` to assert the protocol.

const sentLines: string[] = [];
let connectShouldFail = false;
let saveShouldFail = false;
let connectCalls = 0;
// Configurable getCommandState reply for idempotent-toggle tests
// (track_changes / freeze_panes). null = "unreadable" → blind-toggle fallback.
let commandStateReturn: string | boolean | null = null;
// Configurable `getGraphicSelection` reply for insert_image fit-to-slide
// tests. null = "no graphicselection echo" → conservative fallback path.
// A rect {x1,y1,x2,y2} in twips simulates the coolwsd echo for the
// just-inserted image's native size.
let graphicSelectionReturn: { x1: number; y1: number; x2: number; y2: number } | null = null;
// Captures the last `postInsertFile` file bytes so the insert_image
// sizing-via-bytes tests can decode them with jimp and assert the
// intrinsic pixel dims equal the target cm rect at `LO_INSERT_DPI`
// (the resample is the D362-second-wave fix for coolwsd's broken
// TransformDialog Width/Height).
let lastPostInsertFileBytes: Uint8Array | null = null;

// Fake durability gate: the fake session never touches the real file, so
// the production file-poll gate would time out. `gateResult` lets a test
// choose "bytes changed" (true → changed) vs "nothing landed" (false →
// not_confirmed).
let gateResult = true;
const fakeGate = async (): Promise<boolean> => gateResult;

function makeFakeSession(_opts: CoolSessionOptions): CoolSessionLike {
  return {
    async connect() {
      connectCalls++;
      if (connectShouldFail) throw new Error("fake: connect failed");
    },
    sendUno(command: string, args?: UnoArgs) {
      sentLines.push(args ? `uno ${command} ${JSON.stringify(args)}` : `uno ${command}`);
    },
    async sendUnoAndWait(command: string, args?: UnoArgs) {
      const line = args ? `uno ${command} ${JSON.stringify(args)}` : `uno ${command}`;
      sentLines.push(line);
      return { commandName: command, success: true };
    },
    async save() {
      if (saveShouldFail) throw new Error("fake: save failed");
      sentLines.push("save dontTerminateEdit=1 dontSaveIfUnmodified=0");
    },
    requestSave() {
      sentLines.push("save dontTerminateEdit=1 dontSaveIfUnmodified=0");
    },
    saveToStorage() {
      sentLines.push("savetostorage force=1");
    },
    setClientPart(n: number) {
      sentLines.push(`setclientpart part=${n}`);
    },
    sendMouse(type: "buttondown" | "buttonup" | "move", x: number, y: number, buttons: number, modifier: number) {
      sentLines.push(`mouse type=${type} x=${x} y=${y} count=1 buttons=${buttons} modifier=${modifier}`);
    },
    sendTextInput(text: string) {
      sentLines.push(`textinput id=0 text=${encodeURIComponent(text)}`);
    },
    async getChildId() {
      sentLines.push("getchildid");
      return "fake-child-id";
    },
    async postInsertFile(name: string, childId: string, file: { bytes: Uint8Array; filename: string; contentType: string }) {
      sentLines.push(`postinsertfile name=${name} childid=${childId} filename=${file.filename} type=${file.contentType} bytes=${file.bytes.byteLength}`);
      lastPostInsertFileBytes = file.bytes;
    },
    sendInsertFile(name: string, type: string) {
      sentLines.push(`insertfile name=${name} type=${type}`);
    },
    close() {
      sentLines.push("close");
    },
    isAlive() {
      return true;
    },
    async getCommandState(command: string) {
      sentLines.push(`getstate ${command}`);
      return commandStateReturn;
    },
    clearGraphicSelectionCache() {
      sentLines.push("clear-graphic-selection-cache");
    },
    async getGraphicSelection() {
      sentLines.push("get-graphic-selection");
      return graphicSelectionReturn;
    },
  };
}

// ─── Fake broker ─────────────────────────────────────────────────────

const mintCalls: Array<{ artifactInternalId: string; opts: OfficeSessionMintOptions }> = [];
const fakeBroker: OfficeSessionBroker = {
    async mintSession(artifactInternalId, opts) {
      mintCalls.push({ artifactInternalId, opts });
      return {
      wsBaseUrl: "ws://fake-engine:9980",
      docUrl: "http://host.docker.internal:9999/wopi/files/abc?access_token=tok&access_token_ttl=0&permission=edit",
      wopiSrc: "http://host.docker.internal:9999/wopi/files/abc",
      serviceRoot: "/office-engine",
      origin: "http://127.0.0.1:9999",
    };
  },
};

// ─── artifact-store stubs (DB-touching fns only) ─────────────────────

const resolveWorkspaceArtifactMock = mock(async (params: {
  logicalPath: string;
  facts: unknown;
  intent: "read" | "mutate" | "create" | "create_or_update";
}): Promise<unknown> => {
  return nextResolution(params);
});

const applyWorkspaceArtifactRowChangeMock = mock(
  async (_meta: unknown, _size: number, _userId: string, _agentId: string): Promise<unknown> => {
    return { internalId: "row-internal-id", artifactId: "row-artifact-id", path: "row-path", revision: 1, previousRevision: null };
  },
);

let nextResolution: (params: {
  logicalPath: string;
  facts: unknown;
  intent: "read" | "mutate" | "create" | "create_or_update";
}) => Promise<unknown> = async () => ({
  ok: false,
  reason: "no resolution configured",
});

const { createOfficeTool } = await import("./office");

// Fake engine client — only the read methods the workspace branch uses.
type EngineClient = ReturnType<NonNullable<CreateOfficeToolDeps["makeClient"]>>;
// Configurable slide size the fake `getStructured` reports for Impress
// decks (.pptx/.ppt). The dispatch's insert_image path reads this to
// compute the deterministic placement. Default = 28×15.75 cm (the
// live-verified 16:9-ish deck from the Bug 2 report). Tests that need
// a different slide size override this.
let fakeSlideSizeCm: { widthCm: number; heightCm: number } = { widthCm: 28, heightCm: 15.75 };
// Configurable slide COUNT the fake `getStructured` reports for Impress
// decks. The dispatch's insert_image Bug 2 bounds-check reads
// `slides.length` to reject out-of-range targetSlide. Default = 5
// slides (indices 0..4) — matches the live deck from the Bug 2 report
// (targetSlide=5/6 on a 5-slide deck silently landed on slide 4).
// Tests that need a different count override this; `null` simulates
// the engine omitting `slides` (the bounds-check is skipped).
let fakeSlideCount: number | null = 5;
const makeClient: NonNullable<CreateOfficeToolDeps["makeClient"]> = () =>
  ({
    async info() {
      return { unoserver: "mock", api: "mock", export_filters: { a: 1 }, import_filters: { b: 1 } };
    },
    async getStructured(_bytes: Uint8Array, inExt: string) {
      // For Impress decks, return a slides doctype with the configured
      // slideSize so the insert_image dispatch picks up the REAL slide
      // size (not the hardcoded fallback). Other doctypes get the
      // legacy shape.
      if (inExt === "pptx" || inExt === "ppt" || inExt === "odp") {
        const obj: Record<string, unknown> = {
          doctype: "slides",
          slideSize: { ...fakeSlideSizeCm },
        };
        // `fakeSlideCount === null` simulates the engine OMITTING the
        // `slides` field (malformed readback) — the dispatch's Bug 2
        // bounds-check is skipped in that case (non-array `slides`).
        if (fakeSlideCount !== null) obj["slides"] = new Array(fakeSlideCount);
        return obj;
      }
      return { paragraphs: ["hello"], sheets: [] };
    },
    async getMeta() {
      return { title: "mock-doc" };
    },
  }) as unknown as EngineClient;

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "office-inplace-test-"));
  mock.module("../file/artifact-store", () => ({
    ...realArtifactStore,
    resolveWorkspaceArtifact: resolveWorkspaceArtifactMock,
    applyWorkspaceArtifactRowChange: applyWorkspaceArtifactRowChangeMock,
  }));
  setOfficeSessionBroker(fakeBroker);
});

beforeEach(() => {
  // Reset the manager FIRST — `reset…ForTests` closes any cached
  // sessions from the prior test (which pushes "close" into the shared
  // `sentLines`), so we must clear `sentLines` AFTER, not before.
  resetOfficeSessionManagerForTests();
  resolveWorkspaceArtifactMock.mockClear();
  applyWorkspaceArtifactRowChangeMock.mockClear();
  mintCalls.length = 0;
  sentLines.length = 0;
  connectShouldFail = false;
  saveShouldFail = false;
  connectCalls = 0;
  commandStateReturn = null;
  graphicSelectionReturn = null;
  gateResult = true;
  fakeSlideSizeCm = { widthCm: 28, heightCm: 15.75 };
  fakeSlideCount = 5;
  lastPostInsertFileBytes = null;
  nextResolution = async () => ({ ok: false, reason: "no resolution configured" });
});

afterAll(() => {
  resolveWorkspaceArtifactMock.mockReset();
  applyWorkspaceArtifactRowChangeMock.mockReset();
  mock.module("../file/artifact-store", () => realArtifactStore);
  resetOfficeSessionBroker();
  resetOfficeSessionManagerForTests();
});

describe("office tool — inPlace workspace edit", () => {
  test("find_replace with inPlace:true connects → ExecuteSearch → save; session reused (no close); updatedDoc returned", async () => {
    const inPhysical = join(tmpRoot, "in-findreplace.docx");
    const inputBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22]);
    await writeFile(inPhysical, inputBytes);

    nextResolution = async (params) => {
      expect(params.intent).toBe("read");
      expect(params.logicalPath).toBe("docs/in.docx");
      return {
        ok: true,
        artifact: {
          id: "row-internal-1",
          artifactId: "art-1",
          path: "docs/in.docx",
          storageUri: "file://" + inPhysical,
          size: inputBytes.byteLength,
          revision: 1,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
        physicalPath: inPhysical,
        artifactId: "art-1",
        storageUri: "file://" + inPhysical,
        logicalPath: "docs/in.docx",
      };
    };

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "find_replace",
      zone: "workspace",
      path: "docs/in.docx",
      find: "FOO",
      replace: "BAR",
      inPlace: true,
    }));

    const parsed = JSON.parse(res) as {
      ok: boolean;
      command: string;
      zone: string;
      inPlace: boolean;
      path: string;
      artifactId: string;
      updatedDoc: string | null;
      updatedDocTruncated: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("find_replace");
    expect(parsed.zone).toBe("workspace");
    expect(parsed.inPlace).toBe(true);
    expect(parsed.path).toBe("docs/in.docx");
    expect(parsed.artifactId).toBe("art-1");
    // Post-edit re-extract is included.
    expect(parsed.updatedDoc).not.toBeNull();
    expect(parsed.updatedDocTruncated).toBe(false);

    // The broker was minted for the artifact's INTERNAL id.
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0]!.artifactInternalId).toBe("row-internal-1");
    expect(mintCalls[0]!.opts.readableNamespaces).toEqual([NS_A1, NS_A2]);
    expect(mintCalls[0]!.opts.writableNamespaces).toEqual([NS_A1]);
    expect(mintCalls[0]!.opts.ownerId).toBe(USER_A);

    // The UNO line for ExecuteSearch carries SearchItem.Command = 3
    // (REPLACE_ALL) + the find/replace strings.
    const searchLine = sentLines.find((l) => l.startsWith("uno .uno:ExecuteSearch "));
    expect(searchLine).toBeDefined();
    expect(searchLine!).toContain('"SearchItem.SearchString"');
    expect(searchLine!).toContain('"FOO"');
    expect(searchLine!).toContain('"SearchItem.ReplaceString"');
    expect(searchLine!).toContain('"BAR"');
    expect(searchLine!).toContain('"SearchItem.Command"');
    expect(searchLine!).toMatch(/"value":3\b/);

    // A save was issued.
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);

    // The session is REUSED across tool calls — the manager owns its
    // lifecycle, so a successful op does NOT close the session.
    expect(sentLines).not.toContain("close");

    // No new artifact was minted — applyWorkspaceArtifactRowChange is
    // the row-mint path for the non-inPlace write flow.
    expect(applyWorkspaceArtifactRowChangeMock).not.toHaveBeenCalled();
  });

  test("two consecutive inPlace calls on the same artifact REUSE the session (1 connect, 2 saves)", async () => {
    const inPhysical = join(tmpRoot, "in-reuse.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    nextResolution = async () => ({
      ok: true,
      artifact: {
        id: "row-internal-reuse",
        artifactId: "art-reuse",
        path: "docs/in.docx",
        storageUri: "file://" + inPhysical,
        size: 4,
        revision: 1,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      physicalPath: inPhysical,
      artifactId: "art-reuse",
      storageUri: "file://" + inPhysical,
      logicalPath: "docs/in.docx",
    });

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );

    await tool.invoke({
      command: "find_replace",
      zone: "workspace",
      path: "docs/in.docx",
      find: "A",
      replace: "B",
      inPlace: true,
    });
    const savesAfterFirst = sentLines.filter((l) => l.startsWith("save ")).length;
    const connectsAfterFirst = connectCalls;
    // Mint once for the first call.
    expect(mintCalls).toHaveLength(1);

    await tool.invoke({
      command: "find_replace",
      zone: "workspace",
      path: "docs/in.docx",
      find: "C",
      replace: "D",
      inPlace: true,
    });

    // Second call REUSES the cached live session: NO new connect, NO new
    // mint — just a second save.
    expect(connectCalls).toBe(connectsAfterFirst); // 1 connect total
    expect(mintCalls).toHaveLength(1); // mint not called again
    const savesAfterSecond = sentLines.filter((l) => l.startsWith("save ")).length;
    expect(savesAfterSecond).toBe(savesAfterFirst + 1); // 2 saves total
    // No close on either successful op.
    expect(sentLines).not.toContain("close");
  });

  test("bytes never land (gate stays false) → not_confirmed + session invalidated (no false success)", async () => {
    const inPhysical = join(tmpRoot, "in-savefail.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    nextResolution = async () => ({
      ok: true,
      artifact: {
        id: "row-internal-savefail",
        artifactId: "art-savefail",
        path: "docs/in.docx",
        storageUri: "file://" + inPhysical,
        size: 4,
        revision: 1,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      physicalPath: inPhysical,
      artifactId: "art-savefail",
      storageUri: "file://" + inPhysical,
      logicalPath: "docs/in.docx",
    });

    // The edit is sent + save fired, but no durable byte change is
    // observed within the window.
    gateResult = false;

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "find_replace",
      zone: "workspace",
      path: "docs/in.docx",
      find: "A",
      replace: "B",
      inPlace: true,
    }));

    // Nothing landed → document-language NOT-confirmed (no protocol/UNO/
    // session terms), never a false success.
    const parsed = JSON.parse(res) as { ok: boolean; changed: boolean; reason?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.changed).toBe(false);
    expect(parsed.reason).toBeDefined();
    expect(parsed.reason!).not.toMatch(/wopi|uno|websocket|session|revision/i);
    // The possibly-wedged session was invalidated (close+evict).
    expect(sentLines).toContain("close");
  });

  test("insert_text with inPlace:true (atEnd default) sends GoToEndOfDoc then InsertText", async () => {
    const inPhysical = join(tmpRoot, "in-insert.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    nextResolution = async () => ({
      ok: true,
      artifact: {
        id: "row-internal-2",
        artifactId: "art-2",
        path: "docs/in.docx",
        storageUri: "file://" + inPhysical,
        size: 4,
        revision: 1,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      physicalPath: inPhysical,
      artifactId: "art-2",
      storageUri: "file://" + inPhysical,
      logicalPath: "docs/in.docx",
    });

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_text",
      zone: "workspace",
      path: "docs/in.docx",
      text: "hello world",
      inPlace: true,
    }));

    const parsed = JSON.parse(res) as { ok: boolean; inPlace: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.inPlace).toBe(true);
    expect(parsed.command).toBe("insert_text");

    // atEnd defaults to true → GoToEndOfDoc is sent BEFORE InsertText.
    const gotoIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:GoToEndOfDoc"));
    const insertIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:InsertText "));
    expect(gotoIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(gotoIdx);
    const insertLine = sentLines[insertIdx]!;
    expect(insertLine).toContain('"Text"');
    expect(insertLine).toContain('"hello world"');
  });

  test("set_cell with inPlace:true sends GoToCell then EnterString with String(value)", async () => {
    const inPhysical = join(tmpRoot, "in-cell.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    nextResolution = async () => ({
      ok: true,
      artifact: {
        id: "row-internal-3",
        artifactId: "art-3",
        path: "sheets/in.xlsx",
        storageUri: "file://" + inPhysical,
        size: 4,
        revision: 1,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      physicalPath: inPhysical,
      artifactId: "art-3",
      storageUri: "file://" + inPhysical,
      logicalPath: "sheets/in.xlsx",
    });

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "set_cell",
      zone: "workspace",
      path: "sheets/in.xlsx",
      cell: "A1",
      value: 42,
      inPlace: true,
    }));

    const parsed = JSON.parse(res) as { ok: boolean; inPlace: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.inPlace).toBe(true);
    expect(parsed.command).toBe("set_cell");

    const gotoIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:GoToCell "));
    const enterIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:EnterString "));
    expect(gotoIdx).toBeGreaterThanOrEqual(0);
    expect(enterIdx).toBeGreaterThan(gotoIdx);

    const gotoLine = sentLines[gotoIdx]!;
    expect(gotoLine).toContain('"ToPoint"');
    expect(gotoLine).toContain('"A1"');

    const enterLine = sentLines[enterIdx]!;
    expect(enterLine).toContain('"StringName"');
    expect(enterLine).toContain('"42"'); // String(value) — number → string
  });

  // ─── Wave C — format_range (Calc cell formatting, inPlace-only) ────────

  function xlsxResolution(physicalPath: string, artifactId = "art-fmt") {
    return async () => ({
      ok: true,
      artifact: {
        id: "row-internal-" + artifactId,
        artifactId,
        path: "sheets/in.xlsx",
        storageUri: "file://" + physicalPath,
        size: 4,
        revision: 1,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      physicalPath,
      artifactId,
      storageUri: "file://" + physicalPath,
      logicalPath: "sheets/in.xlsx",
    });
  }

  test("format_range with inPlace:true sends GoToCell then each field's grounded UNO verb", async () => {
    const inPhysical = join(tmpRoot, "in-formatrange.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-formatrange");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_range",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "A1:C3",
      bold: true,
      numberFormat: "currency",
      merge: true,
      wrap: true,
      fontColor: "#ff0011",
      bgColor: "#1133ff",
      align: "center",
      inPlace: true,
    }));

    const parsed = JSON.parse(res) as { ok: boolean; command: string; inPlace: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("format_range");
    expect(parsed.inPlace).toBe(true);

    // 1. Range selected first via .uno:GoToCell {ToPoint} (grounded §3.1).
    const gotoIdx = sentLines.findIndex(
      (l) => l.startsWith("uno .uno:GoToCell ") && l.includes('"ToPoint"') && l.includes('"A1:C3"'),
    );
    expect(gotoIdx).toBeGreaterThanOrEqual(0);

    // 2. Bold FF toggle (only fired because bold:true).
    const boldLine = sentLines.find((l) => l === "uno .uno:Bold");
    expect(boldLine).toBeDefined();
    const boldIdx = sentLines.indexOf(boldLine!);
    expect(boldIdx).toBeGreaterThan(gotoIdx);

    // 3. numberFormat "currency" → .uno:NumberFormatCurrency (FF, grounded §1).
    const nfLine = sentLines.find((l) => l === "uno .uno:NumberFormatCurrency");
    expect(nfLine).toBeDefined();

    // 4. merge → .uno:ToggleMergeCells (FF, grounded §1).
    expect(sentLines).toContain("uno .uno:ToggleMergeCells");

    // 5. wrap → .uno:WrapText (FF, grounded §1).
    expect(sentLines).toContain("uno .uno:WrapText");

    // 6. fontColor "#ff0011" → .uno:Color { "Color.Color": long, value 0xff0011 }.
    //    Grounded: svx/sdi/svx.sdi:1554 (SID_ATTR_CHAR_COLOR);
    //    Control.NotebookbarCalc.js:612; Widget.ColorPickerButton.js:113-122.
    const fontColorLine = sentLines.find((l) => l.startsWith("uno .uno:Color {"));
    expect(fontColorLine).toBeDefined();
    expect(fontColorLine!).toContain('"Color.Color"');
    expect(fontColorLine!).toContain('"type":"long"');
    expect(fontColorLine!).toContain('"value":16711697'); // 0xff0011

    // 7. bgColor "#1133ff" → .uno:BackgroundColor { "BackgroundColor.Color": long, value 0x1133ff }.
    //    Grounded: svx/sdi/svx.sdi:456 (SID_BACKGROUND_COLOR);
    //    Control.NotebookbarCalc.js:603; Widget.ColorPickerButton.js:113-122.
    const bgLine = sentLines.find((l) => l.startsWith("uno .uno:BackgroundColor {"));
    expect(bgLine).toBeDefined();
    expect(bgLine!).toContain('"BackgroundColor.Color"');
    expect(bgLine!).toContain('"type":"long"');
    expect(bgLine!).toContain('"value":1127423'); // 0x1133ff

    // 8. align "center" → .uno:AlignHorizontalCenter (FF, grounded scalc.sdi:195).
    expect(sentLines).toContain("uno .uno:AlignHorizontalCenter");

    // A save was issued.
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("format_range with bad hex fontColor errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-formatrange-badhex.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-formatrange-badhex");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_range",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "A1",
      fontColor: "not-a-color",
      inPlace: true,
    }));
    expect(res).toContain("Error: format_range 'fontColor' must be \"#rrggbb\"");
    // No UNO line should have been sent — validation runs before the session.
    expect(sentLines.some((l) => l.startsWith("uno .uno:GoToCell"))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:Color"))).toBe(false);
  });

  test("format_range missing 'range' errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-formatrange-norange.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-formatrange-norange");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_range",
      zone: "workspace",
      path: "sheets/in.xlsx",
      bold: true,
      inPlace: true,
    }));
    expect(res).toContain("Error: format_range requires 'range'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:GoToCell"))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:Bold"))).toBe(false);
  });

  test("format_range with no format fields errors clearly (no-op is a caller bug)", async () => {
    const inPhysical = join(tmpRoot, "in-formatrange-noop.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-formatrange-noop");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_range",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "A1",
      inPlace: true,
    }));
    expect(res).toContain("Error: format_range requires at least one format field");
    expect(sentLines.some((l) => l.startsWith("uno .uno:GoToCell"))).toBe(false);
  });

  test("inPlace without a wired broker returns a clear error", async () => {
    // Temporarily remove the broker.
    setOfficeSessionBroker(null);
    try {
      const inPhysical = join(tmpRoot, "in-nobroker.docx");
      await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

      nextResolution = async () => ({
        ok: true,
        artifact: {
          id: "row-internal-4",
          artifactId: "art-4",
          path: "docs/in.docx",
          storageUri: "file://" + inPhysical,
          size: 4,
          revision: 1,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
        physicalPath: inPhysical,
        artifactId: "art-4",
        storageUri: "file://" + inPhysical,
        logicalPath: "docs/in.docx",
      });

      const tool = createOfficeTool(
        { memoryAccessEnvelope: namespaceEnvelope() },
        { makeClient, makeSession: makeFakeSession, gate: fakeGate },
      );
      const res = String(await tool.invoke({
        command: "find_replace",
        zone: "workspace",
        path: "docs/in.docx",
        find: "FOO",
        replace: "BAR",
        inPlace: true,
      }));
      expect(res).toContain("Error: inPlace office editing is not wired");
    } finally {
      setOfficeSessionBroker(fakeBroker);
    }
  });

  test("inPlace on zone:home returns a clear error (workspace-only)", async () => {
    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "find_replace",
      zone: "home",
      path: "in.docx",
      out: "out.docx",
      find: "FOO",
      replace: "BAR",
      inPlace: true,
    }));
    expect(res).toContain('Error: inPlace is only supported on zone="workspace"');
  });

  test("inPlace with an unsupported command returns a clear error", async () => {
    const inPhysical = join(tmpRoot, "in-badcmd.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    nextResolution = async () => ({
      ok: true,
      artifact: {
        id: "row-internal-5",
        artifactId: "art-5",
        path: "docs/in.docx",
        storageUri: "file://" + inPhysical,
        size: 4,
        revision: 1,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      physicalPath: inPhysical,
      artifactId: "art-5",
      storageUri: "file://" + inPhysical,
      logicalPath: "docs/in.docx",
    });

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "convert",
      zone: "workspace",
      path: "docs/in.docx",
      out: "docs/out.pdf",
      inPlace: true,
    }));
    expect(res).toContain("Error: inPlace is only supported for find_replace | insert_text | set_cell");
  });

  // ─── Wave C — agent-side Impress ops ──────────────────────────────────

  function pptxResolution(physicalPath: string, artifactId = "art-impress") {
    return async () => ({
      ok: true,
      artifact: {
        id: "row-internal-" + artifactId,
        artifactId,
        path: "deck/in.pptx",
        storageUri: "file://" + physicalPath,
        size: 4,
        revision: 1,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      physicalPath,
      artifactId,
      storageUri: "file://" + physicalPath,
      logicalPath: "deck/in.pptx",
    });
  }

  test("slide_insert without 'at' sends FF .uno:InsertPage", async () => {
    const inPhysical = join(tmpRoot, "in-slideinsert-ff.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slideinsert-ff");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_insert",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string; inPlace: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("slide_insert");
    expect(parsed.inPlace).toBe(true);
    // FF insert: bare `uno .uno:InsertPage` with NO args (no JSON payload).
    const ffLine = sentLines.find((l) => l === "uno .uno:InsertPage");
    expect(ffLine).toBeDefined();
    // No arg-bearing variant was sent.
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertPage {"))).toBe(false);
    // A save was issued.
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("slide_insert with 'at' sends .uno:InsertPage with InsertPos int16", async () => {
    const inPhysical = join(tmpRoot, "in-slideinsert-pos.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slideinsert-pos");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_insert",
      zone: "workspace",
      path: "deck/in.pptx",
      at: 2,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    const insertLine = sentLines.find((l) => l.startsWith("uno .uno:InsertPage {"));
    expect(insertLine).toBeDefined();
    expect(insertLine!).toContain('"InsertPos"');
    expect(insertLine!).toContain('"type":"int16"');
    expect(insertLine!).toContain('"value":2');
  });

  test("slide_insert with negative 'at' errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-slideinsert-bad.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slideinsert-bad");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_insert",
      zone: "workspace",
      path: "deck/in.pptx",
      at: -1,
      inPlace: true,
    }));
    expect(res).toContain("Error: slide_insert 'at' must be a non-negative integer");
    // No UNO line should have been sent — validation runs before the session.
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertPage"))).toBe(false);
  });

  test("slide_goto sends setclientpart part=<n> (0-based)", async () => {
    const inPhysical = join(tmpRoot, "in-slidegoto.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidegoto");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_goto",
      zone: "workspace",
      path: "deck/in.pptx",
      index: 3,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("slide_goto");
    // Grounded socket message (NOT a UNO command).
    expect(sentLines).toContain("setclientpart part=3");
  });

  test("slide_goto missing 'index' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-slidegoto-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidegoto-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_goto",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: slide_goto requires 'index'");
    expect(sentLines.some((l) => l.startsWith("setclientpart"))).toBe(false);
  });

  test("set_layout sends setclientpart then .uno:AssignLayout with WhatPage + WhatLayout unsigned short", async () => {
    const inPhysical = join(tmpRoot, "in-setlayout.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-setlayout");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "set_layout",
      zone: "workspace",
      path: "deck/in.pptx",
      slide: 1,
      layoutId: 20,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("set_layout");

    // First the slide is selected via setclientpart (grounded Parts.js:88).
    const partIdx = sentLines.indexOf("setclientpart part=1");
    expect(partIdx).toBeGreaterThanOrEqual(0);
    // Then AssignLayout with the grounded arg shape.
    const layoutLine = sentLines.find((l) => l.startsWith("uno .uno:AssignLayout {"));
    expect(layoutLine).toBeDefined();
    expect(layoutLine!).toContain('"WhatPage"');
    expect(layoutLine!).toContain('"type":"unsigned short"');
    expect(layoutLine!).toContain('"value":1');
    expect(layoutLine!).toContain('"WhatLayout"');
    expect(layoutLine!).toContain('"value":20');
    // setclientpart fires BEFORE AssignLayout.
    const layoutIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:AssignLayout {"));
    expect(layoutIdx).toBeGreaterThan(partIdx);
  });

  test("set_layout missing 'layoutId' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-setlayout-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-setlayout-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "set_layout",
      zone: "workspace",
      path: "deck/in.pptx",
      slide: 0,
      inPlace: true,
    }));
    expect(res).toContain("Error: set_layout requires 'layoutId'");
  });

  test("set_notes enters notes edit, types via textinput, then escapes", async () => {
    const inPhysical = join(tmpRoot, "in-setnotes.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-setnotes");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "set_notes",
      zone: "workspace",
      path: "deck/in.pptx",
      slide: 2,
      text: "speaker cues",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("set_notes");

    const partIdx = sentLines.indexOf("setclientpart part=2");
    const notesIdx = sentLines.indexOf("uno .uno:NotesMode");
    const textIdx = sentLines.findIndex((l) => l.startsWith("textinput id=0 text="));
    const escIdx = sentLines.indexOf("uno .uno:Escape");
    expect(partIdx).toBeGreaterThanOrEqual(0);
    expect(notesIdx).toBeGreaterThan(partIdx);
    expect(textIdx).toBeGreaterThan(notesIdx);
    expect(escIdx).toBeGreaterThan(textIdx);
    expect(sentLines[textIdx]!).toContain("speaker%20cues");
    expect(sentLines.filter((l) => l === "uno .uno:NotesMode")).toHaveLength(1);
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertText "))).toBe(false);
  });

  test("place_textbox: Text?CreateDirectly → textinput → Escape → TransformDialog (no mouse)", async () => {
    const inPhysical = join(tmpRoot, "in-placetextbox.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-placetextbox");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "place_textbox",
      zone: "workspace",
      path: "deck/in.pptx",
      // 1 cm ≈ 566.93 twips → x=2cm ≈ 1134, y=1cm ≈ 567, w=10cm ≈ 5669, h=2cm ≈ 1134.
      x: 2,
      y: 1,
      w: 10,
      h: 2,
      text: "hello slide",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("place_textbox");

    // DETERMINISTIC path — NO synthesized mouse events at all.
    expect(sentLines.some((l) => l.startsWith("mouse "))).toBe(false);

    // 1. Construct directly via .uno:Text (SID_ATTR_CHAR) — grounded:
    //    docdispatcher inserttextbox + drviewse.cxx:243-266 CreateDirectly-for-LOK.
    const drawIdx = sentLines.findIndex((l) => l === "uno .uno:Text?CreateDirectly:bool=true");
    // 2. Type via the active-edit textinput path (NOT .uno:InsertText — that
    //    does not commit into a draw text box, leaving it empty → culled).
    const textIdx = sentLines.findIndex((l) => l.startsWith("textinput id=0 text="));
    // 3. Leave text-edit (shape stays selected).
    const escIdx = sentLines.findIndex((l) => l === "uno .uno:Escape");
    // 4. Move/size to the requested cm via the format_shape transform path.
    const xformIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:TransformDialog "));
    expect(drawIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(drawIdx);
    expect(escIdx).toBeGreaterThan(textIdx);
    expect(xformIdx).toBeGreaterThan(escIdx);

    // textinput carries the URL-encoded text payload.
    expect(sentLines[textIdx]!).toContain("hello%20slide");
    // .uno:InsertText must NOT be used for the box text (the old broken path).
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertText "))).toBe(false);

    // TransformDialog carries pos+size in twips (x=2cm≈1134, y=1cm≈567,
    // w=10cm≈5669, h=2cm≈1134).
    const xformLine = sentLines[xformIdx]!;
    expect(xformLine).toContain('"TransformPosX"');
    expect(xformLine).toContain('"TransformPosY"');
    expect(xformLine).toContain('"TransformWidth"');
    expect(xformLine).toContain('"TransformHeight"');
    expect(xformLine).toMatch(/"value":113[0-9]/); // ~1134 (x and h both round here)
    expect(xformLine).toMatch(/"value":566[0-9]|"value":567/); // ~567 y
    expect(xformLine).toMatch(/"value":566[0-9]/); // ~5669 w
    // Bug 3 fix: TransformWidth/Height are SfxUInt32Item (svx.sdi:12204,
    // 12223) → wire type "unsigned long" (matches browser LineWidth at
    // Definitions.Menu.ts:161). TransformPosX/Y are SfxInt32Item → "long".
    // The previous "long" for width/height was silently dropped by coolwsd
    // (height no-op'd live).
    expect(xformLine).toMatch(/"TransformPosX":\s*\{[^}]*"type":\s*"long"/);
    expect(xformLine).toMatch(/"TransformPosY":\s*\{[^}]*"type":\s*"long"/);
    expect(xformLine).toMatch(/"TransformWidth":\s*\{[^}]*"type":\s*"unsigned long"/);
    expect(xformLine).toMatch(/"TransformHeight":\s*\{[^}]*"type":\s*"unsigned long"/);
  });

  test("place_textbox slide alias selects the target slide before creating the box", async () => {
    const inPhysical = join(tmpRoot, "in-placetextbox-slidealias.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-placetextbox-slidealias");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "place_textbox",
      zone: "workspace",
      path: "deck/in.pptx",
      slide: 3,
      x: 1,
      y: 1,
      w: 4,
      h: 2,
      text: "targeted",
      inPlace: true,
    }));
    expect((JSON.parse(res) as { ok: boolean }).ok).toBe(true);
    const partIdx = sentLines.indexOf("setclientpart part=3");
    const createIdx = sentLines.indexOf("uno .uno:Text?CreateDirectly:bool=true");
    expect(partIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(partIdx);
  });

  test("place_textbox conflicting target aliases error clearly", async () => {
    const inPhysical = join(tmpRoot, "in-placetextbox-conflict.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-placetextbox-conflict");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "place_textbox",
      zone: "workspace",
      path: "deck/in.pptx",
      targetSlide: 2,
      slide: 1,
      x: 1,
      y: 1,
      w: 1,
      h: 1,
      text: "x",
      inPlace: true,
    }));
    expect(res).toContain("Error: place_textbox got conflicting slide targets");
    expect(sentLines.some((l) => l.startsWith("setclientpart part="))).toBe(false);
    expect(sentLines.includes("uno .uno:Text?CreateDirectly:bool=true")).toBe(false);
  });

  test("place_textbox missing 'w' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-placetextbox-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-placetextbox-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "place_textbox",
      zone: "workspace",
      path: "deck/in.pptx",
      x: 1,
      y: 1,
      h: 1,
      text: "x",
      inPlace: true,
    }));
    expect(res).toContain("Error: place_textbox requires 'w'");
    expect(sentLines.some((l) => l.startsWith("mouse "))).toBe(false);
  });

  // ─── Wave I — Impress shape + slide ops (inPlace-only) ────────────────

  test("select_shape_at sends mouse buttondown then buttonup at the twips coord (no drag)", async () => {
    const inPhysical = join(tmpRoot, "in-selectshape.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-selectshape");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "select_shape_at",
      zone: "workspace",
      path: "deck/in.pptx",
      at: { x: 5, y: 4 },
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("select_shape_at");

    // Click = buttondown then buttonup at the SAME coord (no move/drag).
    // 5 cm ≈ 2835 twips, 4 cm ≈ 2268 twips. Buttons=1 (left), modifier=0.
    const downIdx = sentLines.findIndex((l) => l.startsWith("mouse type=buttondown "));
    const upIdx = sentLines.findIndex((l) => l.startsWith("mouse type=buttonup "));
    expect(downIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(downIdx);
    // No move between down and up (a click, not a drag).
    const moveBetween = sentLines.slice(downIdx, upIdx).find((l) => l.startsWith("mouse type=move "));
    expect(moveBetween).toBeUndefined();

    const downLine = sentLines[downIdx]!;
    expect(downLine).toMatch(/ x=283[0-9] /); // ~2835
    expect(downLine).toMatch(/ y=226[0-9] /); // ~2268
    expect(downLine).toContain("buttons=1");
    expect(downLine).toContain("modifier=0");

    const upLine = sentLines[upIdx]!;
    expect(upLine).toMatch(/ x=283[0-9] /);
    expect(upLine).toMatch(/ y=226[0-9] /);

    // A save was issued.
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("select_shape_at missing 'at' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-selectshape-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-selectshape-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "select_shape_at",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: select_shape_at requires 'at' as {x, y}");
    expect(sentLines.some((l) => l.startsWith("mouse "))).toBe(false);
  });

  test("select_shape_at with number 'at' (slide_insert shape) errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-selectshape-bad.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-selectshape-bad");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "select_shape_at",
      zone: "workspace",
      path: "deck/in.pptx",
      at: 3,
      inPlace: true,
    }));
    expect(res).toContain("Error: select_shape_at requires 'at' as {x, y}");
    expect(sentLines.some((l) => l.startsWith("mouse "))).toBe(false);
  });

  test("format_shape with at + fillColor + transform sends click → FillColor → TransformDialog (single call)", async () => {
    const inPhysical = join(tmpRoot, "in-formatshape-fillxform.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-formatshape-fillxform");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      at: { x: 3, y: 3 },
      fillColor: "#ff00aa",
      x: 4,
      y: 5,
      w: 6,
      h: 2,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("format_shape");

    // 1. Shape selected first via LOK click (buttondown + buttonup at
    //    3cm ≈ 1701 twips, 3cm ≈ 1701 twips).
    const downIdx = sentLines.findIndex((l) => l.startsWith("mouse type=buttondown "));
    const upIdx = sentLines.findIndex((l) => l.startsWith("mouse type=buttonup "));
    expect(downIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(downIdx);
    const downLine = sentLines[downIdx]!;
    expect(downLine).toMatch(/ x=170[0-9] /);
    expect(downLine).toMatch(/ y=170[0-9] /);

    // 2. FillColor "#ff00aa" → .uno:FillColor { "FillColor.Color": long, value 0xff00aa }.
    //    Grounded: svx/sdi/svx.sdi:2845 (SID_ATTR_FILL_COLOR);
    //    Widget.ColorPickerButton.js:113-135.
    const fillLine = sentLines.find((l) => l.startsWith("uno .uno:FillColor {"));
    expect(fillLine).toBeDefined();
    expect(fillLine!).toContain('"FillColor.Color"');
    expect(fillLine!).toContain('"type":"long"');
    expect(fillLine!).toContain('"value":16711850'); // 0xff00aa

    // 3. TransformDialog carries pos + size args (twips) in ONE call.
    //    Grounded: svx/sdi/svx.sdi:8976-8977 (SID_ATTR_TRANSFORM);
    //    ShapeHandlesSection.ts:789-800 (pos); ⚠️ U2 size ungrounded-live.
    //    4cm ≈ 2268, 5cm ≈ 2835, 6cm ≈ 3402, 2cm ≈ 1134.
    const transformLine = sentLines.find((l) => l.startsWith("uno .uno:TransformDialog {"));
    expect(transformLine).toBeDefined();
    expect(transformLine!).toContain('"TransformPosX"');
    expect(transformLine!).toContain('"TransformPosY"');
    expect(transformLine!).toContain('"TransformWidth"');
    expect(transformLine!).toContain('"TransformHeight"');
    expect(transformLine!).toContain('"type":"long"');
    // Only ONE TransformDialog call (combined args, not split).
    expect(sentLines.filter((l) => l.startsWith("uno .uno:TransformDialog {")).length).toBe(1);

    // The fill + transform fired AFTER the selection click.
    const fillIdx = sentLines.indexOf(fillLine!);
    expect(fillIdx).toBeGreaterThan(upIdx);
    const transformIdx = sentLines.indexOf(transformLine!);
    expect(transformIdx).toBeGreaterThan(upIdx);

    // A save was issued.
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("format_shape with rotation + flipH sends TransformDialog (rotation args, 1/100°) then FlipHorizontal", async () => {
    const inPhysical = join(tmpRoot, "in-formatshape-rot.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-formatshape-rot");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      at: { x: 2, y: 2 },
      rotation: 45,
      flipH: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // TransformDialog with rotation: DeltaAngle in 1/100° (45° → 4500),
    // center = at coord in twips (2cm ≈ 1134).
    // Grounded: svx/sdi/svx.sdi:8977; ShapeHandleRotationSubSection.ts:100-115.
    const transformLine = sentLines.find((l) => l.startsWith("uno .uno:TransformDialog {"));
    expect(transformLine).toBeDefined();
    expect(transformLine!).toContain('"TransformRotationDeltaAngle"');
    expect(transformLine!).toContain('"value":4500'); // 45 * 100
    expect(transformLine!).toContain('"TransformRotationX"');
    expect(transformLine!).toContain('"TransformRotationY"');
    expect(transformLine).not.toContain('"TransformPosX"');
    expect(transformLine).not.toContain('"TransformWidth"');

    // FlipHorizontal FF after TransformDialog.
    // Grounded: svx/sdi/svx.sdi:12840; Control.NotebookbarImpress.js:2483.
    const flipLine = sentLines.find((l) => l === "uno .uno:FlipHorizontal");
    expect(flipLine).toBeDefined();
    const flipIdx = sentLines.indexOf(flipLine!);
    const transformIdx = sentLines.indexOf(transformLine!);
    expect(flipIdx).toBeGreaterThan(transformIdx);
  });

  test("format_shape with no format fields errors clearly (no-op is a caller bug)", async () => {
    const inPhysical = join(tmpRoot, "in-formatshape-noop.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-formatshape-noop");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      at: { x: 2, y: 2 },
      inPlace: true,
    }));
    expect(res).toContain("Error: format_shape requires at least one format field");
    expect(sentLines.some((l) => l.startsWith("mouse "))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:FillColor"))).toBe(false);
  });

  test("format_shape with bad hex fillColor errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-formatshape-badhex.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-formatshape-badhex");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      fillColor: "not-a-color",
      inPlace: true,
    }));
    expect(res).toContain("Error: format_shape 'fillColor' must be \"#rrggbb\"");
    expect(sentLines.some((l) => l.startsWith("uno .uno:FillColor"))).toBe(false);
  });

  test("arrange_shape with at + zorder + align sends click → BringToFront → ObjectAlignLeft", async () => {
    const inPhysical = join(tmpRoot, "in-arrange-zalign.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-arrange-zalign");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "arrange_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      at: { x: 1, y: 1 },
      zorder: "front",
      align: "left",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("arrange_shape");

    // 1. Shape selected first via LOK click.
    const upIdx = sentLines.findIndex((l) => l.startsWith("mouse type=buttonup "));
    expect(upIdx).toBeGreaterThanOrEqual(0);

    // 2. zorder "front" → .uno:BringToFront (FF).
    //    Grounded: svx/sdi/svx.sdi:964; Control.NotebookbarImpress.js:2421.
    const frontLine = sentLines.find((l) => l === "uno .uno:BringToFront");
    expect(frontLine).toBeDefined();
    const frontIdx = sentLines.indexOf(frontLine!);
    expect(frontIdx).toBeGreaterThan(upIdx);

    // 3. align "left" → .uno:ObjectAlignLeft (FF).
    //    Grounded: svx/sdi/svx.sdi:176; Control.NotebookbarImpress.js:2354.
    const alignLine = sentLines.find((l) => l === "uno .uno:ObjectAlignLeft");
    expect(alignLine).toBeDefined();
    expect(sentLines.indexOf(alignLine!)).toBeGreaterThan(frontIdx);
  });

  test("arrange_shape with group sends .uno:FormatGroup (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-arrange-group.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-arrange-group");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "arrange_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      group: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: svx/sdi/svx.sdi:3449; Control.NotebookbarImpress.js:2675.
    expect(sentLines).toContain("uno .uno:FormatGroup");
    // No selection click was sent (no `at`).
    expect(sentLines.some((l) => l.startsWith("mouse "))).toBe(false);
  });

  test("arrange_shape with align 'middle' sends .uno:AlignMiddle (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-arrange-middle.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-arrange-middle");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "arrange_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      align: "middle",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: svx/sdi/svx.sdi:213; Control.NotebookbarImpress.js:2387.
    expect(sentLines).toContain("uno .uno:AlignMiddle");
  });

  test("arrange_shape with no fields errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-arrange-noop.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-arrange-noop");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "arrange_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: arrange_shape requires at least one of zorder / align / group / ungroup");
  });

  test("slide_visibility hidden=true with slide N sends setclientpart then .uno:HideSlide", async () => {
    const inPhysical = join(tmpRoot, "in-slidevis-hide.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidevis-hide");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_visibility",
      zone: "workspace",
      path: "deck/in.pptx",
      slide: 2,
      hidden: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("slide_visibility");

    // First switch to slide N (grounded Parts.js:88).
    const partIdx = sentLines.indexOf("setclientpart part=2");
    expect(partIdx).toBeGreaterThanOrEqual(0);
    // Then HideSlide FF (grounded sd/sdi/sdraw.sdi:1488; Parts.js:567).
    const hideIdx = sentLines.indexOf("uno .uno:HideSlide");
    expect(hideIdx).toBeGreaterThan(partIdx);
    expect(sentLines).not.toContain("uno .uno:ShowSlide");
  });

  test("slide_visibility hidden=false without slide sends .uno:ShowSlide on current slide", async () => {
    const inPhysical = join(tmpRoot, "in-slidevis-show.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidevis-show");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_visibility",
      zone: "workspace",
      path: "deck/in.pptx",
      hidden: false,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // No slide switch (current slide).
    expect(sentLines.some((l) => l.startsWith("setclientpart"))).toBe(false);
    // ShowSlide FF (grounded sd/sdi/sdraw.sdi:1505; Parts.js:579).
    expect(sentLines).toContain("uno .uno:ShowSlide");
    expect(sentLines).not.toContain("uno .uno:HideSlide");
  });

  test("slide_visibility missing 'hidden' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-slidevis-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidevis-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_visibility",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: slide_visibility requires 'hidden'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:HideSlide"))).toBe(false);
  });

  test("insert_table sends .uno:InsertTable with Columns + Rows (long)", async () => {
    const inPhysical = join(tmpRoot, "in-inserttable.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-inserttable");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_table",
      zone: "workspace",
      path: "deck/in.pptx",
      rows: 3,
      cols: 4,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("insert_table");

    // Grounded: svx/sdi/svx.sdi:5124-5125; Control.Toolbar.js:292-298.
    const tableLine = sentLines.find((l) => l.startsWith("uno .uno:InsertTable {"));
    expect(tableLine).toBeDefined();
    expect(tableLine!).toContain('"Columns"');
    expect(tableLine!).toContain('"type":"long"');
    expect(tableLine!).toContain('"value":4');
    expect(tableLine!).toContain('"Rows"');
    expect(tableLine!).toContain('"value":3');
  });

  test("insert_table missing 'cols' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-inserttable-nocols.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-inserttable-nocols");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_table",
      zone: "workspace",
      path: "deck/in.pptx",
      rows: 3,
      inPlace: true,
    }));
    expect(res).toContain("Error: insert_table requires 'cols'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertTable"))).toBe(false);
  });

  test("insert_table with array 'rows' (set_range shape) errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-inserttable-badrows.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-inserttable-badrows");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_table",
      zone: "workspace",
      path: "deck/in.pptx",
      rows: [["a", "b"]],
      cols: 2,
      inPlace: true,
    }));
    expect(res).toContain("Error: insert_table requires 'rows' (positive integer");
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertTable"))).toBe(false);
  });

  test("insert_chart sends FF .uno:InsertObjectChart", async () => {
    const inPhysical = join(tmpRoot, "in-insertchart.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-insertchart");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_chart",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("insert_chart");
    // Grounded: svx/sdi/svx.sdi:5068-5069; Control.NotebookbarImpress.js:1260, 1525.
    expect(sentLines).toContain("uno .uno:InsertObjectChart");
  });

  test("master_view enter=true sends .uno:SlideMasterPage (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-masterview-enter.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-masterview-enter");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "master_view",
      zone: "workspace",
      path: "deck/in.pptx",
      enter: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: sd/sdi/sdraw.sdi:3142; Control.NotebookbarImpress.js:657.
    expect(sentLines).toContain("uno .uno:SlideMasterPage");
    expect(sentLines).not.toContain("uno .uno:CloseMasterView");
  });

  test("master_view enter=false sends .uno:CloseMasterView (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-masterview-exit.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-masterview-exit");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "master_view",
      zone: "workspace",
      path: "deck/in.pptx",
      enter: false,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: sd/sdi/sdraw.sdi:3625; Control.NotebookbarImpress.js:1947.
    expect(sentLines).toContain("uno .uno:CloseMasterView");
    expect(sentLines).not.toContain("uno .uno:SlideMasterPage");
  });

  test("master_view missing 'enter' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-masterview-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-masterview-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "master_view",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: master_view requires 'enter'");
  });

  // ─── Wave J — agent-side Writer ops (inPlace-only) ─────────────────────
  // Closes the agent-parity gap vs. the human Writer ribbon. Every verb
  // grounded in our own shipped Writer ribbon (office-doc-surface.tsx) +
  // the Writer Review group (office-writer-review-group.tsx).

  function docxResolution(physicalPath: string, artifactId = "art-writer") {
    return async () => ({
      ok: true,
      artifact: {
        id: "row-internal-" + artifactId,
        artifactId,
        path: "docs/in.docx",
        storageUri: "file://" + physicalPath,
        size: 4,
        revision: 1,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      physicalPath,
      artifactId,
      storageUri: "file://" + physicalPath,
      logicalPath: "docs/in.docx",
    });
  }

  test("format_text with anchor + bold + fontColor + style sends ExecuteSearch(FIND) then the grounded Writer verbs", async () => {
    const inPhysical = join(tmpRoot, "in-formattext.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-formattext");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_text",
      zone: "workspace",
      path: "docs/in.docx",
      anchor: "introduction",
      bold: true,
      fontColor: "#ff0011",
      style: "Heading 1",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string; inPlace: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("format_text");
    expect(parsed.inPlace).toBe(true);

    // 1. .uno:ExecuteSearch with SearchItem.Command = 0 (FIND) + the anchor
    //    as SearchString. Grounded: same FIND+SELECT call shape edit_doc's
    //    positional ops use (see findSelectArgs in dispatchEditDoc).
    const searchLine = sentLines.find((l) => l.startsWith("uno .uno:ExecuteSearch "));
    expect(searchLine).toBeDefined();
    expect(searchLine!).toContain('"SearchItem.SearchString"');
    expect(searchLine!).toContain('"introduction"');
    expect(searchLine!).toContain('"SearchItem.Command"');
    expect(searchLine!).toMatch(/"value":0\b/); // SVX_SEARCH_CMD_FIND
    // FIND (not REPLACE_ALL): no ReplaceString.
    expect(searchLine!).not.toContain('"SearchItem.ReplaceString"');

    const searchIdx = sentLines.indexOf(searchLine!);

    // 2. Bold FF toggle fired AFTER the search (only because bold:true).
    //    Grounded in our Writer ribbon (office-doc-surface.tsx:669).
    const boldLine = sentLines.find((l) => l === "uno .uno:Bold");
    expect(boldLine).toBeDefined();
    expect(sentLines.indexOf(boldLine!)).toBeGreaterThan(searchIdx);

    // 3. fontColor "#ff0011" → .uno:FontColor { "FontColor.Color": long,
    //    value 0xff0011 }. Grounded: Writer USES FontColor (SID_ATTR_CHAR_COLOR2,
    //    sw/sdi/swriter.sdi:1323); office-doc-surface.tsx:696. NOT Calc's
    //    .uno:Color (which format_range sends).
    const fontColorLine = sentLines.find((l) => l.startsWith("uno .uno:FontColor {"));
    expect(fontColorLine).toBeDefined();
    expect(fontColorLine!).toContain('"FontColor.Color"');
    expect(fontColorLine!).toContain('"type":"long"');
    expect(fontColorLine!).toContain('"value":16711697'); // 0xff0011
    // Crucially, .uno:Color (Calc) was NOT sent.
    expect(sentLines.some((l) => l.startsWith("uno .uno:Color {"))).toBe(false);

    // 4. style "Heading 1" → .uno:StyleApply { Style, FamilyName: "ParagraphStyles" }.
    //    Grounded in our Writer ribbon (office-doc-surface.tsx:620-623).
    const styleLine = sentLines.find((l) => l.startsWith("uno .uno:StyleApply {"));
    expect(styleLine).toBeDefined();
    expect(styleLine!).toContain('"Style"');
    expect(styleLine!).toContain('"Heading 1"');
    expect(styleLine!).toContain('"FamilyName"');
    expect(styleLine!).toContain('"ParagraphStyles"');

    // A save was issued.
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("format_text with italic + underline + strike + highlightColor + fontFamily + fontSize fires each Writer verb", async () => {
    const inPhysical = join(tmpRoot, "in-formattext-full.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-formattext-full");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_text",
      zone: "workspace",
      path: "docs/in.docx",
      anchor: "some text",
      italic: true,
      underline: true,
      strike: true,
      highlightColor: "#1133ff",
      fontFamily: "Liberation Sans",
      fontSize: 14,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // Italic / Underline / Strikeout FF toggles (grounded Writer ribbon).
    expect(sentLines).toContain("uno .uno:Italic");
    expect(sentLines).toContain("uno .uno:Underline");
    expect(sentLines).toContain("uno .uno:Strikeout");

    // highlightColor "#1133ff" → .uno:CharBackColor { "CharBackColor.Color": long }.
    // Grounded: office-doc-surface.tsx:704. NOT .uno:BackgroundColor (Calc cell FILL).
    const hlLine = sentLines.find((l) => l.startsWith("uno .uno:CharBackColor {"));
    expect(hlLine).toBeDefined();
    expect(hlLine!).toContain('"CharBackColor.Color"');
    expect(hlLine!).toContain('"type":"long"');
    expect(hlLine!).toContain('"value":1127423'); // 0x1133ff
    expect(sentLines.some((l) => l.startsWith("uno .uno:BackgroundColor {"))).toBe(false);

    // fontFamily → .uno:CharFontName { "CharFontName.FamilyName": string }.
    // Grounded: office-doc-surface.tsx:642-644.
    const fontLine = sentLines.find((l) => l.startsWith("uno .uno:CharFontName {"));
    expect(fontLine).toBeDefined();
    expect(fontLine!).toContain('"CharFontName.FamilyName"');
    expect(fontLine!).toContain('"Liberation Sans"');

    // fontSize 14 → .uno:FontHeight { "FontHeight.Height": float }.
    // Grounded: office-doc-surface.tsx:659-661.
    const sizeLine = sentLines.find((l) => l.startsWith("uno .uno:FontHeight {"));
    expect(sizeLine).toBeDefined();
    expect(sizeLine!).toContain('"FontHeight.Height"');
    expect(sizeLine!).toContain('"type":"float"');
    expect(sizeLine!).toContain('"value":14');
  });

  test("format_text missing 'anchor' errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-formattext-noanchor.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-formattext-noanchor");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_text",
      zone: "workspace",
      path: "docs/in.docx",
      bold: true,
      inPlace: true,
    }));
    expect(res).toContain("Error: format_text requires 'anchor'");
    // No UNO line should have been sent — validation runs before the session.
    expect(sentLines.some((l) => l.startsWith("uno .uno:ExecuteSearch"))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:Bold"))).toBe(false);
  });

  test("format_text with no format fields errors clearly (no-op is a caller bug)", async () => {
    const inPhysical = join(tmpRoot, "in-formattext-noop.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-formattext-noop");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_text",
      zone: "workspace",
      path: "docs/in.docx",
      anchor: "x",
      inPlace: true,
    }));
    expect(res).toContain("Error: format_text requires at least one format field");
    expect(sentLines.some((l) => l.startsWith("uno .uno:ExecuteSearch"))).toBe(false);
  });

  test("format_text with bad hex fontColor errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-formattext-badhex.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-formattext-badhex");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_text",
      zone: "workspace",
      path: "docs/in.docx",
      anchor: "x",
      fontColor: "not-a-color",
      inPlace: true,
    }));
    expect(res).toContain("Error: format_text 'fontColor' must be \"#rrggbb\"");
    expect(sentLines.some((l) => l.startsWith("uno .uno:ExecuteSearch"))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:FontColor"))).toBe(false);
  });

  test("format_text with bad hex highlightColor errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-formattext-badhl.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-formattext-badhl");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_text",
      zone: "workspace",
      path: "docs/in.docx",
      anchor: "x",
      highlightColor: "#xyz",
      inPlace: true,
    }));
    expect(res).toContain("Error: format_text 'highlightColor' must be \"#rrggbb\"");
    expect(sentLines.some((l) => l.startsWith("uno .uno:CharBackColor"))).toBe(false);
  });

  test("insert_link with text + url sends .uno:SetHyperlink with grounded args (no anchor → at cursor)", async () => {
    const inPhysical = join(tmpRoot, "in-insertlink.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-insertlink");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_link",
      zone: "workspace",
      path: "docs/in.docx",
      text: "Nautilo",
      url: "https://nautilo.dev",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("insert_link");

    // No anchor → no ExecuteSearch (link inserted at cursor).
    expect(sentLines.some((l) => l.startsWith("uno .uno:ExecuteSearch"))).toBe(false);

    // .uno:SetHyperlink { "Hyperlink.Text": string, "Hyperlink.URL": string }.
    // Grounded in our Writer ribbon (office-doc-surface.tsx:771-774).
    const linkLine = sentLines.find((l) => l.startsWith("uno .uno:SetHyperlink {"));
    expect(linkLine).toBeDefined();
    expect(linkLine!).toContain('"Hyperlink.Text"');
    expect(linkLine!).toContain('"Nautilo"');
    expect(linkLine!).toContain('"Hyperlink.URL"');
    expect(linkLine!).toContain('"https://nautilo.dev"');

    // A save was issued.
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("insert_link with anchor sends ExecuteSearch(FIND) then SetHyperlink", async () => {
    const inPhysical = join(tmpRoot, "in-insertlink-anchor.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-insertlink-anchor");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_link",
      zone: "workspace",
      path: "docs/in.docx",
      text: "Nautilo",
      url: "https://nautilo.dev",
      anchor: "the platform",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // Anchor → ExecuteSearch FIND with the anchor as SearchString.
    const searchLine = sentLines.find((l) => l.startsWith("uno .uno:ExecuteSearch "));
    expect(searchLine).toBeDefined();
    expect(searchLine!).toContain('"the platform"');
    expect(searchLine!).toMatch(/"value":0\b/); // FIND

    // SetHyperlink fires AFTER the search.
    const linkIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:SetHyperlink {"));
    const searchIdx = sentLines.indexOf(searchLine!);
    expect(linkIdx).toBeGreaterThan(searchIdx);
  });

  test("insert_link missing 'url' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-insertlink-nourl.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-insertlink-nourl");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_link",
      zone: "workspace",
      path: "docs/in.docx",
      text: "Nautilo",
      inPlace: true,
    }));
    expect(res).toContain("Error: insert_link requires 'url'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:SetHyperlink"))).toBe(false);
  });

  test("insert_link missing 'text' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-insertlink-notext.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-insertlink-notext");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_link",
      zone: "workspace",
      path: "docs/in.docx",
      url: "https://nautilo.dev",
      inPlace: true,
    }));
    expect(res).toContain("Error: insert_link requires 'text'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:SetHyperlink"))).toBe(false);
  });

  test("track_changes enabled=true fires .uno:TrackChanges (STATE TOGGLE)", async () => {
    const inPhysical = join(tmpRoot, "in-trackchanges-on.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-trackchanges-on");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "track_changes",
      zone: "workspace",
      path: "docs/in.docx",
      enabled: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("track_changes");

    // .uno:TrackChanges FF (STATE TOGGLE). Grounded in our Writer Review
    // group (office-writer-review-group.tsx:71). The op fires the toggle
    // regardless of `enabled` — idempotent set-to-enabled needs a state-read
    // (commandstatechanged) which is out of scope; see sendLowLevelOps caveat.
    expect(sentLines).toContain("uno .uno:TrackChanges");

    // A save was issued.
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("track_changes with unreadable state (getCommandState→null) falls back to a single .uno:TrackChanges toggle", async () => {
    commandStateReturn = null; // engine hasn't pushed the state → best-effort toggle
    const inPhysical = join(tmpRoot, "in-trackchanges-off.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-trackchanges-off");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "track_changes",
      zone: "workspace",
      path: "docs/in.docx",
      enabled: false,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Same FF toggle fires for enabled=false — the verb is a TOGGLE, not a
    // set, so the same command is sent regardless of the desired direction.
    // The `enabled` flag is the agent's INTENT; without a state-read the
    // resulting state cannot be guaranteed (documented caveat).
    expect(sentLines).toContain("uno .uno:TrackChanges");
  });

  test("track_changes missing 'enabled' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-trackchanges-noarg.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-trackchanges-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "track_changes",
      zone: "workspace",
      path: "docs/in.docx",
      inPlace: true,
    }));
    expect(res).toContain("Error: track_changes requires 'enabled'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:TrackChanges"))).toBe(false);
  });

  test("track_changes enabled=true is IDEMPOTENT: already-on state → NO toggle fired", async () => {
    commandStateReturn = "enabled"; // record-changes already ON
    const inPhysical = join(tmpRoot, "in-tc-idem-noop.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-tc-idem-noop");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "track_changes",
      zone: "workspace",
      path: "docs/in.docx",
      enabled: true,
      inPlace: true,
    }));
    expect((JSON.parse(res) as { ok: boolean }).ok).toBe(true);
    // State already matches intent → the toggle must NOT fire (no flip-off).
    expect(sentLines).toContain("getstate .uno:TrackChanges");
    expect(sentLines).not.toContain("uno .uno:TrackChanges");
  });

  test("track_changes enabled=true when OFF → toggle fires (state disagrees with intent)", async () => {
    commandStateReturn = "disabled"; // record-changes currently OFF
    const inPhysical = join(tmpRoot, "in-tc-idem-on.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-tc-idem-on");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "track_changes",
      zone: "workspace",
      path: "docs/in.docx",
      enabled: true,
      inPlace: true,
    }));
    expect((JSON.parse(res) as { ok: boolean }).ok).toBe(true);
    expect(sentLines).toContain("getstate .uno:TrackChanges");
    expect(sentLines).toContain("uno .uno:TrackChanges");
  });

  // ─── D362 — Writer co-creative review loop (inPlace-only) ──────────────
  // Closes the agent-parity gap vs. the human Writer Review group
  // (office-writer-review-group.tsx): the 8 FF verbs that let a Genie
  // ACCEPT/REJECT tracked changes — making "suggest mode" real (agent
  // proposes tracked edits → either party accepts/rejects). All FF, no args;
  // grounded in phase-3-writer-editor.md §3.3.8.

  test("review_changes missing 'action' errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-review-noaction.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-review-noaction");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "review_changes",
      zone: "workspace",
      path: "docs/in.docx",
      inPlace: true,
    }));
    expect(res).toContain("Error: review_changes requires 'action'");
    // No review verb should have been sent.
    expect(sentLines.some((l) =>
      l.startsWith("uno .uno:AcceptTrackedChange") ||
      l.startsWith("uno .uno:RejectTrackedChange") ||
      l.startsWith("uno .uno:NextTrackedChange") ||
      l.startsWith("uno .uno:PreviousTrackedChange")
    )).toBe(false);
  });

  test("review_changes with bad 'action' (valid enum, wrong subset) errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-review-badaction.docx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = docxResolution(inPhysical, "art-review-badaction");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    // "add" is a valid `action` enum value (for `sheet`) but NOT a valid
    // review_changes action — the per-command validation must reject it.
    const res = String(await tool.invoke({
      command: "review_changes",
      zone: "workspace",
      path: "docs/in.docx",
      action: "add",
      inPlace: true,
    }));
    expect(res).toContain("Error: review_changes requires 'action'");
    expect(sentLines.some((l) =>
      l.startsWith("uno .uno:AcceptTrackedChange") ||
      l.startsWith("uno .uno:RejectTrackedChange") ||
      l.startsWith("uno .uno:NextTrackedChange") ||
      l.startsWith("uno .uno:PreviousTrackedChange")
    )).toBe(false);
  });

  // Each action → its grounded verb (FF, no args). Grounded in
  // office-writer-review-group.tsx + phase-3-writer-editor.md §3.3.8.
  const REVIEW_ACTION_TO_VERB = [
    ["accept", ".uno:AcceptTrackedChange"],
    ["reject", ".uno:RejectTrackedChange"],
    ["accept_next", ".uno:AcceptTrackedChangeToNext"],
    ["reject_next", ".uno:RejectTrackedChangeToNext"],
    ["accept_all", ".uno:AcceptAllTrackedChanges"],
    ["reject_all", ".uno:RejectAllTrackedChanges"],
    ["next", ".uno:NextTrackedChange"],
    ["prev", ".uno:PreviousTrackedChange"],
  ] as const;

  for (const [action, verb] of REVIEW_ACTION_TO_VERB) {
    test(`review_changes action=${action} sends ${verb} (FF, no args)`, async () => {
      const inPhysical = join(tmpRoot, `in-review-${action}.docx`);
      await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      nextResolution = docxResolution(inPhysical, `art-review-${action}`);

      const tool = createOfficeTool(
        { memoryAccessEnvelope: namespaceEnvelope() },
        { makeClient, makeSession: makeFakeSession, gate: fakeGate },
      );
      const res = String(await tool.invoke({
        command: "review_changes",
        zone: "workspace",
        path: "docs/in.docx",
        action,
        inPlace: true,
      }));
      const parsed = JSON.parse(res) as { ok: boolean; command: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("review_changes");
      // The grounded FF verb fires with NO args (no JSON tail).
      expect(sentLines).toContain(`uno ${verb}`);
      // A save was issued (the durability gate is the sync point).
      expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
    });
  }

  // ─── Wave G — Calc sheet management + freeze panes (inPlace-only) ───────
  // Closes the standout Calc agent-parity gap vs. the human tab bar. Sheet
  // verbs grounded in wave-c-build-sheet §1 (LIVE-VERIFIED: the human
  // sheet-tab bar fires these exact verbs). `index` is 0-based from the
  // agent; UNO `Index` is 1-based (nPos+1).

  test("sheet add with index + name sends .uno:Insert { Name, Index: index+1 }", async () => {
    const inPhysical = join(tmpRoot, "in-sheet-add.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-sheet-add");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "sheet",
      zone: "workspace",
      path: "sheets/in.xlsx",
      action: "add",
      index: 2,
      name: "Q3",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("sheet");
    // Grounded: browser/src/control/Parts.js:357-368; build-sheet §1.
    // Index is 1-based: agent 0-based 2 → UNO Index=3.
    const insertLine = sentLines.find((l) => l.startsWith("uno .uno:Insert {"));
    expect(insertLine).toBeDefined();
    expect(insertLine!).toContain('"Name"');
    expect(insertLine!).toContain('"Q3"');
    expect(insertLine!).toContain('"Index"');
    expect(insertLine!).toContain('"type":"long"');
    expect(insertLine!).toContain('"value":3');
  });

  test("sheet add without name sends empty Name (Core assigns SheetN)", async () => {
    const inPhysical = join(tmpRoot, "in-sheet-add-noname.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-sheet-add-noname");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "sheet",
      zone: "workspace",
      path: "sheets/in.xlsx",
      action: "add",
      index: 0,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    const insertLine = sentLines.find((l) => l.startsWith("uno .uno:Insert {"));
    expect(insertLine).toBeDefined();
    expect(insertLine!).toContain('"value":""'); // empty Name
    expect(insertLine!).toContain('"value":1'); // index 0 → 1-based 1
  });

  test("sheet rename sends .uno:Name { Name, Index: index+1 }", async () => {
    const inPhysical = join(tmpRoot, "in-sheet-rename.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-sheet-rename");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "sheet",
      zone: "workspace",
      path: "sheets/in.xlsx",
      action: "rename",
      index: 1,
      name: "Revenue",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: Parts.js:470-481; build-sheet §1.
    const nameLine = sentLines.find((l) => l.startsWith("uno .uno:Name {"));
    expect(nameLine).toBeDefined();
    expect(nameLine!).toContain('"Revenue"');
    expect(nameLine!).toContain('"Index"');
    expect(nameLine!).toContain('"value":2'); // 0-based 1 → 1-based 2
  });

  test("sheet delete sends .uno:Remove { Index: index+1 }", async () => {
    const inPhysical = join(tmpRoot, "in-sheet-delete.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-sheet-delete");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "sheet",
      zone: "workspace",
      path: "sheets/in.xlsx",
      action: "delete",
      index: 0,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: Parts.js:423-430; build-sheet §1.
    const removeLine = sentLines.find((l) => l.startsWith("uno .uno:Remove {"));
    expect(removeLine).toBeDefined();
    expect(removeLine!).toContain('"Index"');
    expect(removeLine!).toContain('"value":1'); // 0-based 0 → 1-based 1
    // No Name arg for delete.
    expect(removeLine!).not.toContain('"Name"');
  });

  test("sheet switch sends setclientpart part=<index> (0-based)", async () => {
    const inPhysical = join(tmpRoot, "in-sheet-switch.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-sheet-switch");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "sheet",
      zone: "workspace",
      path: "sheets/in.xlsx",
      action: "switch",
      index: 3,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: same setclientpart socket message slide_goto uses
    // (Parts.js:88). 0-based, no +1 conversion.
    expect(sentLines).toContain("setclientpart part=3");
    // No UNO command for switch.
    expect(sentLines.some((l) => l.startsWith("uno .uno:Insert"))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:Remove"))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:Name"))).toBe(false);
  });

  test("sheet missing 'action' errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-sheet-noaction.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-sheet-noaction");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "sheet",
      zone: "workspace",
      path: "sheets/in.xlsx",
      index: 0,
      inPlace: true,
    }));
    expect(res).toContain("Error: sheet requires 'action'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:Insert"))).toBe(false);
  });

  test("sheet missing 'index' errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-sheet-noindex.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-sheet-noindex");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "sheet",
      zone: "workspace",
      path: "sheets/in.xlsx",
      action: "add",
      inPlace: true,
    }));
    expect(res).toContain("Error: sheet requires 'index'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:Insert"))).toBe(false);
  });

  test("sheet rename missing 'name' errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-sheet-renamenoname.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-sheet-renamenoname");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "sheet",
      zone: "workspace",
      path: "sheets/in.xlsx",
      action: "rename",
      index: 0,
      inPlace: true,
    }));
    expect(res).toContain("Error: sheet rename requires 'name'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:Name"))).toBe(false);
  });

  test("freeze_panes enabled=true fires .uno:FreezePanes (STATE TOGGLE)", async () => {
    const inPhysical = join(tmpRoot, "in-freeze.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-freeze");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "freeze_panes",
      zone: "workspace",
      path: "sheets/in.xlsx",
      enabled: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("freeze_panes");
    // Grounded: sc/sdi/scalc.sdi:1978; Control.NotebookbarCalc.js:1477-1478.
    expect(sentLines).toContain("uno .uno:FreezePanes");
  });

  test("freeze_panes with unreadable state (getCommandState→null) falls back to a single .uno:FreezePanes toggle", async () => {
    commandStateReturn = null;
    const inPhysical = join(tmpRoot, "in-freeze-off.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-freeze-off");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "freeze_panes",
      zone: "workspace",
      path: "sheets/in.xlsx",
      enabled: false,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Same FF toggle fires for enabled=false — the verb is a TOGGLE, not a
    // set, so the same command is sent regardless of the desired direction.
    expect(sentLines).toContain("uno .uno:FreezePanes");
  });

  test("freeze_panes missing 'enabled' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-freeze-noarg.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-freeze-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "freeze_panes",
      zone: "workspace",
      path: "sheets/in.xlsx",
      inPlace: true,
    }));
    expect(res).toContain("Error: freeze_panes requires 'enabled'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:FreezePanes"))).toBe(false);
  });

  test("freeze_panes enabled=true is IDEMPOTENT: already-frozen (state true) → NO toggle fired", async () => {
    commandStateReturn = true; // panes already frozen
    const inPhysical = join(tmpRoot, "in-freeze-idem.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-freeze-idem");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "freeze_panes",
      zone: "workspace",
      path: "sheets/in.xlsx",
      enabled: true,
      inPlace: true,
    }));
    expect((JSON.parse(res) as { ok: boolean }).ok).toBe(true);
    expect(sentLines).toContain("getstate .uno:FreezePanes");
    expect(sentLines).not.toContain("uno .uno:FreezePanes");
  });

  test("calc_data sort_asc selects the range then fires .uno:SortAscending (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-calcdata-sortasc.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-calcdata-sortasc");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "calc_data",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "A1:C20",
      action: "sort_asc",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("calc_data");
    const gotoIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:GoToCell ") && l.includes('"A1:C20"'));
    expect(gotoIdx).toBeGreaterThanOrEqual(0);
    const sortIdx = sentLines.indexOf("uno .uno:SortAscending");
    expect(sortIdx).toBeGreaterThan(gotoIdx);
    expect(sentLines).not.toContain("uno .uno:SortDescending");
  });

  test("calc_data sort_desc fires .uno:SortDescending", async () => {
    const inPhysical = join(tmpRoot, "in-calcdata-sortdesc.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-calcdata-sortdesc");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "calc_data",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "A1:C20",
      action: "sort_desc",
      inPlace: true,
    }));
    expect((JSON.parse(res) as { ok: boolean }).ok).toBe(true);
    expect(sentLines).toContain("uno .uno:SortDescending");
  });

  test("calc_data autofilter fires .uno:DataFilterAutoFilter after selecting the range", async () => {
    const inPhysical = join(tmpRoot, "in-calcdata-filter.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-calcdata-filter");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "calc_data",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "A1:C1",
      action: "autofilter",
      inPlace: true,
    }));
    expect((JSON.parse(res) as { ok: boolean }).ok).toBe(true);
    const gotoIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:GoToCell "));
    const filterIdx = sentLines.indexOf("uno .uno:DataFilterAutoFilter");
    expect(filterIdx).toBeGreaterThan(gotoIdx);
  });

  test("calc_data missing 'action' errors clearly (no engine touch)", async () => {
    const inPhysical = join(tmpRoot, "in-calcdata-noaction.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-calcdata-noaction");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "calc_data",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "A1:C20",
      inPlace: true,
    }));
    expect(res).toContain("Error: calc_data requires 'action'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:Sort"))).toBe(false);
  });

  test("calc_data missing 'range' errors clearly (no engine touch)", async () => {
    const inPhysical = join(tmpRoot, "in-calcdata-norange.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-calcdata-norange");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "calc_data",
      zone: "workspace",
      path: "sheets/in.xlsx",
      action: "sort_asc",
      inPlace: true,
    }));
    expect(res).toContain("Error: calc_data requires 'range'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:GoToCell"))).toBe(false);
  });

  // ─── Wave G — Impress cheap-tail (inPlace-only; audit §2.1 G12-G20) ─────

  test("slide_field kind=pagenumber sends FF .uno:InsertPageField", async () => {
    const inPhysical = join(tmpRoot, "in-slidefield-pagenum.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidefield-pagenum");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_field",
      zone: "workspace",
      path: "deck/in.pptx",
      kind: "pagenumber",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("slide_field");
    // Bug 2 fix: establish a text-edit context BEFORE the field UNO.
    // Sequence: Text?CreateDirectly → InsertPageField → Escape (mirrors
    // place_textbox's context-establishing discipline).
    const createIdx = sentLines.indexOf("uno .uno:Text?CreateDirectly:bool=true");
    const fieldIdx = sentLines.indexOf("uno .uno:InsertPageField");
    const escIdx = sentLines.indexOf("uno .uno:Escape");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(fieldIdx).toBeGreaterThan(createIdx);
    expect(escIdx).toBeGreaterThan(fieldIdx);
    // No targetSlide → setClientPart must NOT be sent.
    expect(sentLines.some((l) => l.startsWith("setclientpart part="))).toBe(false);
  });

  test("slide_field kind=author sends FF .uno:InsertAuthorField", async () => {
    const inPhysical = join(tmpRoot, "in-slidefield-author.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidefield-author");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_field",
      zone: "workspace",
      path: "deck/in.pptx",
      kind: "author",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Bug 2 fix: same Text?CreateDirectly → field → Escape sequence.
    const createIdx = sentLines.indexOf("uno .uno:Text?CreateDirectly:bool=true");
    const fieldIdx = sentLines.indexOf("uno .uno:InsertAuthorField");
    const escIdx = sentLines.indexOf("uno .uno:Escape");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(fieldIdx).toBeGreaterThan(createIdx);
    expect(escIdx).toBeGreaterThan(fieldIdx);
  });

  test("slide_field kind=text sends textinput and avoids InsertText", async () => {
    const inPhysical = join(tmpRoot, "in-slidefield-text.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidefield-text");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_field",
      zone: "workspace",
      path: "deck/in.pptx",
      kind: "text",
      text: "custom label",
      inPlace: true,
    }));
    expect((JSON.parse(res) as { ok: boolean }).ok).toBe(true);
    const textLine = sentLines.find((l) => l.startsWith("textinput id=0 text="));
    expect(textLine).toBeDefined();
    expect(textLine!).toContain("custom%20label");
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertText "))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertPageField"))).toBe(false);
    // Bug 2 fix: kind=text ALSO establishes a text-edit context first
    // (Text?CreateDirectly → textinput → Escape), so the free text lands
    // in a fresh text box instead of dropping into the void.
    const createIdx = sentLines.indexOf("uno .uno:Text?CreateDirectly:bool=true");
    const textIdx = sentLines.findIndex((l) => l.startsWith("textinput id=0 text="));
    const escIdx = sentLines.indexOf("uno .uno:Escape");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(createIdx);
    expect(escIdx).toBeGreaterThan(textIdx);
  });

  test("slide_field with targetSlide sets the active part BEFORE creating the text box (Bug 2: field lands on the intended slide)", async () => {
    const inPhysical = join(tmpRoot, "in-slidefield-targetslide.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidefield-targetslide");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_field",
      zone: "workspace",
      path: "deck/in.pptx",
      kind: "pagenumber",
      targetSlide: 1,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("slide_field");
    // Bug 2 fix: setClientPart fires BEFORE Text?CreateDirectly so the new
    // text box (and its field) lands on slide 1.
    const partIdx = sentLines.indexOf("setclientpart part=1");
    const createIdx = sentLines.indexOf("uno .uno:Text?CreateDirectly:bool=true");
    const fieldIdx = sentLines.indexOf("uno .uno:InsertPageField");
    const escIdx = sentLines.indexOf("uno .uno:Escape");
    expect(partIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(partIdx);
    expect(fieldIdx).toBeGreaterThan(createIdx);
    expect(escIdx).toBeGreaterThan(fieldIdx);
  });

  test("slide_field with conflicting targetSlide aliases errors clearly (Bug 2: same alias discipline as place_textbox)", async () => {
    const inPhysical = join(tmpRoot, "in-slidefield-conflict.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidefield-conflict");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_field",
      zone: "workspace",
      path: "deck/in.pptx",
      kind: "pagenumber",
      targetSlide: 2,
      slide: 1,
      inPlace: true,
    }));
    expect(res).toContain("Error: place_textbox got conflicting slide targets");
    expect(sentLines.some((l) => l.startsWith("setclientpart part="))).toBe(false);
    expect(sentLines.includes("uno .uno:Text?CreateDirectly:bool=true")).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertPageField"))).toBe(false);
  });

  test("slide_field kind=text missing text errors clearly before touching engine", async () => {
    const inPhysical = join(tmpRoot, "in-slidefield-text-notext.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidefield-text-notext");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_field",
      zone: "workspace",
      path: "deck/in.pptx",
      kind: "text",
      inPlace: true,
    }));
    expect(res).toContain("Error: slide_field kind='text' requires 'text'");
    expect(sentLines.some((l) => l.startsWith("textinput id=0 text="))).toBe(false);
  });

  test("slide_field missing 'kind' errors clearly before touching the engine", async () => {
    const inPhysical = join(tmpRoot, "in-slidefield-nokind.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slidefield-nokind");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_field",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: slide_field requires 'kind'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:InsertPageField"))).toBe(false);
  });

  test("slide_outline action=expand sends FF .uno:ExpandPage", async () => {
    const inPhysical = join(tmpRoot, "in-slideoutline-expand.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slideoutline-expand");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_outline",
      zone: "workspace",
      path: "deck/in.pptx",
      action: "expand",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: sd/sdi/sdraw.sdi:871; audit §1.1 G13.
    expect(sentLines).toContain("uno .uno:ExpandPage");
    expect(sentLines).not.toContain("uno .uno:SummaryPage");
  });

  test("slide_outline action=summary sends FF .uno:SummaryPage", async () => {
    const inPhysical = join(tmpRoot, "in-slideoutline-summary.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slideoutline-summary");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_outline",
      zone: "workspace",
      path: "deck/in.pptx",
      action: "summary",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Grounded: sd/sdi/sdraw.sdi:3248; audit §1.1 G13.
    expect(sentLines).toContain("uno .uno:SummaryPage");
    expect(sentLines).not.toContain("uno .uno:ExpandPage");
  });

  test("slide_outline missing 'action' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-slideoutline-noaction.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-slideoutline-noaction");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "slide_outline",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: slide_outline requires 'action'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:ExpandPage"))).toBe(false);
  });

  test("master_display displayBackground=true fires .uno:DisplayMasterBackground (FF toggle)", async () => {
    const inPhysical = join(tmpRoot, "in-masterdisp-bg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-masterdisp-bg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "master_display",
      zone: "workspace",
      path: "deck/in.pptx",
      displayBackground: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("master_display");
    // Grounded: sd/sdi/sdraw.sdi:3675; audit §1.3 G15.
    expect(sentLines).toContain("uno .uno:DisplayMasterBackground");
    // displayObjects omitted → its verb NOT fired.
    expect(sentLines).not.toContain("uno .uno:DisplayMasterObjects");
  });

  test("master_display with both fields fires both verbs", async () => {
    const inPhysical = join(tmpRoot, "in-masterdisp-both.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-masterdisp-both");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "master_display",
      zone: "workspace",
      path: "deck/in.pptx",
      displayBackground: true,
      displayObjects: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(sentLines).toContain("uno .uno:DisplayMasterBackground");
    expect(sentLines).toContain("uno .uno:DisplayMasterObjects");
  });

  test("master_display with no fields errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-masterdisp-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-masterdisp-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "master_display",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: master_display requires at least one of 'displayBackground' or 'displayObjects'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:DisplayMasterBackground"))).toBe(false);
  });

  test("shape_autofit with at + autofit=true sends click → .uno:TextAutoFitToSize", async () => {
    const inPhysical = join(tmpRoot, "in-shapeautofit.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-shapeautofit");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "shape_autofit",
      zone: "workspace",
      path: "deck/in.pptx",
      at: { x: 5, y: 4 },
      autofit: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("shape_autofit");
    // Selection click fires first.
    const downIdx = sentLines.findIndex((l) => l.startsWith("mouse type=buttondown "));
    const upIdx = sentLines.findIndex((l) => l.startsWith("mouse type=buttonup "));
    expect(downIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(downIdx);
    // Grounded: sd/sdi/sdraw.sdi:3350; audit §1.13 G17.
    const autofitIdx = sentLines.indexOf("uno .uno:TextAutoFitToSize");
    expect(autofitIdx).toBeGreaterThan(upIdx);
  });

  test("shape_autofit missing 'autofit' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-shapeautofit-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-shapeautofit-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "shape_autofit",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: shape_autofit requires 'autofit'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:TextAutoFitToSize"))).toBe(false);
  });

  test("convert_shape with at + kind=bitmap sends click → .uno:ConvertIntoBitmap", async () => {
    const inPhysical = join(tmpRoot, "in-convertshape-bitmap.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-convertshape-bitmap");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "convert_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      at: { x: 2, y: 2 },
      kind: "bitmap",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("convert_shape");
    // Grounded: audit §1.4 G18 (FF on selected shape).
    expect(sentLines).toContain("uno .uno:ConvertIntoBitmap");
    expect(sentLines).not.toContain("uno .uno:ConvertIntoMetaFile");
  });

  test("convert_shape kind=metafile sends .uno:ConvertIntoMetaFile (no at → on current selection)", async () => {
    const inPhysical = join(tmpRoot, "in-convertshape-meta.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-convertshape-meta");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "convert_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      kind: "metafile",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // No `at` → no selection click, verb fires on the current selection.
    expect(sentLines.some((l) => l.startsWith("mouse type=buttondown"))).toBe(false);
    expect(sentLines).toContain("uno .uno:ConvertIntoMetaFile");
  });

  test("convert_shape missing 'kind' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-convertshape-nokind.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-convertshape-nokind");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "convert_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: convert_shape requires 'kind'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:ConvertIntoBitmap"))).toBe(false);
  });

  test("group_nav action=enter sends .uno:EnterGroup (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-groupnav-enter.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-groupnav-enter");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "group_nav",
      zone: "workspace",
      path: "deck/in.pptx",
      action: "enter",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("group_nav");
    // Grounded: audit §1.6 G20 (FF on current selection).
    expect(sentLines).toContain("uno .uno:EnterGroup");
    expect(sentLines).not.toContain("uno .uno:LeaveGroup");
  });

  test("group_nav action=leave sends .uno:LeaveGroup (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-groupnav-leave.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-groupnav-leave");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "group_nav",
      zone: "workspace",
      path: "deck/in.pptx",
      action: "leave",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(sentLines).toContain("uno .uno:LeaveGroup");
    expect(sentLines).not.toContain("uno .uno:EnterGroup");
  });

  test("group_nav missing 'action' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-groupnav-noaction.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-groupnav-noaction");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "group_nav",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: group_nav requires 'action'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:EnterGroup"))).toBe(false);
  });

  // ─── Office cheap tail — borders / presenter / original-size ────────

  test("format_range with borders=outline sends GoToCell → .uno:SetBorderStyle (OuterBorder)", async () => {
    const inPhysical = join(tmpRoot, "in-borders-outline.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-borders-outline");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_range",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "A1:C3",
      borders: "outline",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("format_range");

    // Range selected first via GoToCell, then the border preset.
    const gotoIdx = sentLines.findIndex(
      (l) => l.startsWith("uno .uno:GoToCell ") && l.includes('"A1:C3"'),
    );
    expect(gotoIdx).toBeGreaterThanOrEqual(0);
    // Grounded: Control.Toolbar.js getBorderStyleUNOCommand → OuterBorder/InnerBorder shape.
    const borderLine = sentLines.find((l) => l.startsWith("uno .uno:SetBorderStyle {"));
    expect(borderLine).toBeDefined();
    expect(borderLine!).toContain('"OuterBorder"');
    expect(borderLine!).toContain('"InnerBorder"');
    expect(sentLines.indexOf(borderLine!)).toBeGreaterThan(gotoIdx);
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("format_range with borders=none sends .uno:SetBorderStyle (clear-all)", async () => {
    const inPhysical = join(tmpRoot, "in-borders-none.xlsx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = xlsxResolution(inPhysical, "art-borders-none");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_range",
      zone: "workspace",
      path: "sheets/in.xlsx",
      range: "B2",
      borders: "none",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(sentLines.some((l) => l.startsWith("uno .uno:SetBorderStyle {"))).toBe(true);
  });

  test("format_shape with originalSize=true selects the shape then sends .uno:OriginalSize (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-origsize.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-origsize");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "format_shape",
      zone: "workspace",
      path: "deck/in.pptx",
      at: { x: 3, y: 3 },
      originalSize: true,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("format_shape");

    // Shape selected via LOK click first.
    const upIdx = sentLines.findIndex((l) => l.startsWith("mouse type=buttonup "));
    expect(upIdx).toBeGreaterThanOrEqual(0);
    // Grounded: audit §1.4 G19 — .uno:OriginalSize (SID_ORIGINAL_SIZE) FF, no args.
    const origLine = sentLines.find((l) => l === "uno .uno:OriginalSize");
    expect(origLine).toBeDefined();
    expect(sentLines.indexOf(origLine!)).toBeGreaterThan(upIdx);
  });

  test("presentation mode=current sends .uno:PresentationCurrentSlide (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-present-current.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-present-current");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "presentation",
      zone: "workspace",
      path: "deck/in.pptx",
      mode: "current",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("presentation");
    expect(sentLines).toContain("uno .uno:PresentationCurrentSlide");
    expect(sentLines).not.toContain("uno .uno:RehearseTimings");
  });

  test("presentation mode=rehearse sends .uno:RehearseTimings (FF)", async () => {
    const inPhysical = join(tmpRoot, "in-present-rehearse.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-present-rehearse");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "presentation",
      zone: "workspace",
      path: "deck/in.pptx",
      mode: "rehearse",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(sentLines).toContain("uno .uno:RehearseTimings");
    expect(sentLines).not.toContain("uno .uno:PresentationCurrentSlide");
  });

  test("presentation missing 'mode' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-present-nomode.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-present-nomode");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "presentation",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: presentation requires 'mode'");
    expect(sentLines.some((l) => l.startsWith("uno .uno:PresentationCurrentSlide"))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("uno .uno:RehearseTimings"))).toBe(false);
  });

  // ─── Wave K — agent image insert (inPlace-only) ──────────────────────
  // GROUNDED in Map.FileInserter.js (the human Insert > Image button's
  // wire). Sequence: getchildid → multipart POST {name, childid, file} to
  // /cool/<WOPISrc>/insertfile → socket `insertfile name=… type=graphic`.
  // These tests assert the WIRE SEQUENCE only — K.1 (childid/multipart-
  // through-proxy) + K.4 (image visibly lands) are LIVE-VERIFY PENDING.

  /**
   * Two-artifact resolution helper for insert_image: returns the deck for
   * `deck/in.pptx` and the image artifact for `assets/logo.png`. The image
   * bytes are written to a real temp file so `readFile` in
   * `dispatchInPlaceOffice` returns them.
   */
  function insertImageResolution(deckPhysical: string, imagePhysical: string, imageBytes: Uint8Array) {
    return async (params: { logicalPath: string; intent: string }) => {
      if (params.logicalPath === "deck/in.pptx") {
        return {
          ok: true,
          artifact: {
            id: "row-internal-img",
            artifactId: "art-img-deck",
            path: "deck/in.pptx",
            storageUri: "file://" + deckPhysical,
            size: 4,
            revision: 1,
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
          physicalPath: deckPhysical,
          artifactId: "art-img-deck",
          storageUri: "file://" + deckPhysical,
          logicalPath: "deck/in.pptx",
        };
      }
      // The image artifact.
      return {
        ok: true,
        artifact: {
          id: "row-internal-imgfile",
          artifactId: "art-img-file",
          path: "assets/logo.png",
          storageUri: "file://" + imagePhysical,
          size: imageBytes.byteLength,
          revision: 1,
          mimeType: "image/png",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
        physicalPath: imagePhysical,
        artifactId: "art-img-file",
        storageUri: "file://" + imagePhysical,
        logicalPath: "assets/logo.png",
      };
    };
  }

  // ─── Image header fixtures for the deterministic placement tests ─────
  // `readImagePixelSize` parses PNG IHDR (offset 16/20) and JPEG SOF
  // markers. These helpers build minimal valid headers carrying known
  // pixel dims, so the dispatch's `readImagePixelSize(imageBytes)` returns
  // a known native size and the placement compute is fully deterministic.

  /** Minimal PNG header (24 bytes) carrying width/height as BE uint32. */
  function pngHeader(w: number, h: number): Uint8Array {
    const b = new Uint8Array(24);
    // Signature: 89 50 4E 47 0D 0A 1A 0A
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    // IHDR chunk length (13) — bytes 8..11.
    b.set([0x00, 0x00, 0x00, 0x0d], 8);
    // "IHDR" — bytes 12..15.
    b.set([0x49, 0x48, 0x44, 0x52], 12);
    // Width BE uint32 — bytes 16..19.
    b[16] = (w >>> 24) & 0xff;
    b[17] = (w >>> 16) & 0xff;
    b[18] = (w >>> 8) & 0xff;
    b[19] = w & 0xff;
    // Height BE uint32 — bytes 20..23.
    b[20] = (h >>> 24) & 0xff;
    b[21] = (h >>> 16) & 0xff;
    b[22] = (h >>> 8) & 0xff;
    b[23] = h & 0xff;
    return b;
  }

  /** Minimal JPEG header carrying an SOF0 marker with width/height. */
  function jpegHeader(w: number, h: number): Uint8Array {
    // FF D8 (SOI) + FF C0 (SOF0) + 00 11 (segLen=17) + 08 (precision)
    //   + HH HL (height) + WH WL (width) + 01 01 11 00 (1 component filler)
    //   + FF D9 (EOI).
    const b = new Uint8Array(16);
    b[0] = 0xff; b[1] = 0xd8;
    b[2] = 0xff; b[3] = 0xc0;
    b[4] = 0x00; b[5] = 0x11;
    b[6] = 0x08;
    b[7] = (h >> 8) & 0xff; b[8] = h & 0xff;
    b[9] = (w >> 8) & 0xff; b[10] = w & 0xff;
    b[11] = 0x01; b[12] = 0x01; b[13] = 0x11; b[14] = 0x00;
    b[15] = 0xd9;
    return b;
  }

  /**
   * Build a REAL decodable PNG of the given pixel dims with jimp —
   * used by the sizing-via-bytes tests that need the dispatch's
   * `resizeImageToCm` to actually resample (the `pngHeader` fixture is
   * only the 24-byte IHDR with no IDAT, so jimp can't decode it and the
   * defensive path returns the original bytes). Returns the PNG bytes.
   */
  async function realPng(pxW: number, pxH: number): Promise<Uint8Array> {
    const img = new Jimp({ width: pxW, height: pxH, color: 0xff0000ff });
    return new Uint8Array(await img.getBuffer(JimpMime.png));
  }

  test("insert_image: getchildid → postinsertfile(name, childid, file) → socket `insertfile name=… type=graphic` → save", async () => {
    const deckPhysical = join(tmpRoot, "in-insertimg-deck.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg.png");
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("insert_image");

    // No targetSlide → setClientPart must NOT be sent (Bug 1: only set the
    // active part when the agent explicitly targets a slide).
    expect(sentLines.some((l) => l.startsWith("setclientpart part="))).toBe(false);

    // 1. getchildid sent (no args, no `uno ` prefix).
    const getChildIdIdx = sentLines.indexOf("getchildid");
    expect(getChildIdIdx).toBeGreaterThanOrEqual(0);

    // 2. multipart POST issued with the childid returned by the fake
    //    session + the image bytes + filename. The fake session stub
    //    records `postinsertfile name=<n> childid=<c> filename=<f> type=<ct> bytes=<len>`.
    const postIdx = sentLines.findIndex((l) => l.startsWith("postinsertfile "));
    expect(postIdx).toBeGreaterThan(getChildIdIdx);
    const postLine = sentLines[postIdx]!;
    expect(postLine).toContain("childid=fake-child-id");
    expect(postLine).toContain("filename=logo.png");
    expect(postLine).toContain("type=image/png");
    expect(postLine).toContain(`bytes=${imageBytes.byteLength}`);

    // 3. socket `insertfile name=<name> type=graphic` sent AFTER the POST.
    //    The name is a Date.now() string — match by pattern, not exact value.
    const insertIdx = sentLines.findIndex(
      (l) => /^insertfile name=\d+ type=graphic$/.test(l),
    );
    expect(insertIdx).toBeGreaterThan(postIdx);

    // 4. Bug 1 settle: .uno:Escape fired AFTER the insertfile so the kit
    //    has processed the insert before the save/durability gate fires.
    //    The fake session's sendUnoAndWait records `uno .uno:Escape` and
    //    resolves immediately. Grounded in ClientSession.cpp:1386-1478
    //    (insertfile + uno share the same kit queue).
    const escapeIdx = sentLines.indexOf("uno .uno:Escape");
    expect(escapeIdx).toBeGreaterThan(insertIdx);

    // 5. save issued (the durability gate is the sync point).
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);

    // NOT a UNO command — must NOT carry an `uno ` prefix.
    expect(sentLines.some((l) => l.startsWith("uno insertfile"))).toBe(false);
  });

  test("insert_image with targetSlide sets the active part BEFORE getchildid (Bug 1: image lands on the intended slide)", async () => {
    const deckPhysical = join(tmpRoot, "in-insertimg-targetslide.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-targetslide.png");
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      targetSlide: 2,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; command: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("insert_image");

    // Bug 1 fix: setClientPart fires BEFORE getchildid so the insertfile
    // lands on slide 2 (not the kit's default slide 0).
    const partIdx = sentLines.indexOf("setclientpart part=2");
    const getChildIdIdx = sentLines.indexOf("getchildid");
    expect(partIdx).toBeGreaterThanOrEqual(0);
    expect(getChildIdIdx).toBeGreaterThan(partIdx);

    // The insertfile still fires after the POST, and the Escape settle
    // still fires after the insertfile.
    const insertIdx = sentLines.findIndex(
      (l) => /^insertfile name=\d+ type=graphic$/.test(l),
    );
    expect(insertIdx).toBeGreaterThan(getChildIdIdx);
    const escapeIdx = sentLines.indexOf("uno .uno:Escape");
    expect(escapeIdx).toBeGreaterThan(insertIdx);
  });

  test("insert_image with conflicting targetSlide aliases errors clearly (Bug 1: same alias discipline as place_textbox)", async () => {
    const deckPhysical = join(tmpRoot, "in-insertimg-conflict.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-conflict.png");
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      targetSlide: 2,
      slide: 1,
      inPlace: true,
    }));
    expect(res).toContain("Error: place_textbox got conflicting slide targets");
    // No session interaction — alias validation fails up-front.
    expect(sentLines).not.toContain("getchildid");
    expect(sentLines.some((l) => l.startsWith("setclientpart part="))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("insertfile name="))).toBe(false);
  });

  test("insert_image missing 'imagePath' errors clearly", async () => {
    const inPhysical = join(tmpRoot, "in-insertimg-noarg.pptx");
    await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = pptxResolution(inPhysical, "art-insertimg-noarg");

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      inPlace: true,
    }));
    expect(res).toContain("Error: insert_image requires 'imagePath'");
    // No session interaction — imagePath validation fails up-front.
    expect(sentLines).not.toContain("getchildid");
    expect(sentLines.some((l) => l.startsWith("insertfile name="))).toBe(false);
  });

  test("insert_image with a missing image artifact errors clearly (no session interaction)", async () => {
    const deckPhysical = join(tmpRoot, "in-insertimg-nofile.pptx");
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    nextResolution = async (params) => {
      if (params.logicalPath === "deck/in.pptx") {
        return {
          ok: true,
          artifact: {
            id: "row-internal-imgnofile",
            artifactId: "art-imgnofile",
            path: "deck/in.pptx",
            storageUri: "file://" + deckPhysical,
            size: 4,
            revision: 1,
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
          physicalPath: deckPhysical,
          artifactId: "art-imgnofile",
          storageUri: "file://" + deckPhysical,
          logicalPath: "deck/in.pptx",
        };
      }
      // Image artifact missing.
      return { ok: false, reason: `there is no image at "assets/missing.png"` };
    };

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/missing.png",
      inPlace: true,
    }));
    expect(res).toContain("no image at");
    // Image resolution fails BEFORE the transaction — no session minted.
    expect(sentLines).not.toContain("getchildid");
    expect(sentLines.some((l) => l.startsWith("insertfile name="))).toBe(false);
  });

  // ─── Intent-level placement (deterministic, no live echo) ───────────
  // The redesign kept deterministic size compute (image header bytes +
  // real slide size → `computeImagePlacementRect`) BUT the
  // `graphicselection:` echo await was removed entirely — which broke
  // the SELECTION/TIMING gate. `TransformDialog` operates on the
  // current selection; without the gate it fired before the freshly-
  // inserted image was selected/ready → applied to nothing → the image
  // kept native size (Bug 1, diagnosed from a clean single-op live
  // test: tool computed the correct rect but `extract` showed the image
  // at native size, off-slide). The fix RESTORES the
  // `getGraphicSelection` await as the selection/readiness gate (NOT to
  // read size — the byte-based compute is authoritative). These tests
  // assert the gate sequence: clear-cache → insertfile →
  // get-graphic-selection (gate) → TransformDialog(computed dims) →
  // Escape.

  test("insert_image: clear-cache → insertfile → await graphicselection (gate) → TransformDialog(computed dims) → Escape (Bug 1 gate-restore)", async () => {
    // The keystone Bug 1 assertion: the dispatch computes the rect
    // deterministically (image header + slide size) AND the apply path
    // awaits the `graphicselection:` echo as the selection gate before
    // firing `TransformDialog` (which targets the current selection).
    // Without the gate, `TransformDialog` no-ops and the image keeps
    // native size. The `clearGraphicSelectionCache` call BEFORE the
    // insertfile ensures the post-insert echo is FRESH (not a stale
    // rect from a prior selection).
    const deckPhysical = join(tmpRoot, "in-insertimg-gate.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-gate.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // The graphicselection primitives ARE invoked — the gate is restored.
    // `clearGraphicSelectionCache` fires BEFORE the insertfile trigger
    // (so the post-insert echo is fresh, not stale).
    const clearIdx = sentLines.indexOf("clear-graphic-selection-cache");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    const insertIdx = sentLines.findIndex(
      (l) => /^insertfile name=\d+ type=graphic$/.test(l),
    );
    expect(insertIdx).toBeGreaterThan(clearIdx);
    // `getGraphicSelection` (the gate) fires AFTER the insertfile. The
    // fake returns `null` (no echo configured) → the gate times out →
    // the path proceeds best-effort (the deterministic dims are still
    // correct, the save gate is the final sync).
    const gateIdx = sentLines.indexOf("get-graphic-selection");
    expect(gateIdx).toBeGreaterThan(insertIdx);
    // `TransformDialog` fires AFTER the gate (it targets the current
    // selection, which the gate proved is the just-inserted image).
    const xformIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:TransformDialog "));
    expect(xformIdx).toBeGreaterThan(gateIdx);
    // `Escape` settle fires AFTER the TransformDialog.
    const escapeIdx = sentLines.indexOf("uno .uno:Escape");
    expect(escapeIdx).toBeGreaterThan(xformIdx);
  });

  test("insert_image graphicselection gate proceeds best-effort on timeout (null echo) and still fires TransformDialog + Escape", async () => {
    // The gate is best-effort: if the echo times out (coolwsd didn't
    // push within the bounded window), the path still fires the
    // TransformDialog with the pre-computed dims and the Escape settle.
    // The deterministic dims are correct regardless; the save gate is
    // the final sync. This test configures `graphicSelectionReturn =
    // null` explicitly (default) and asserts the full apply sequence
    // still fires.
    const deckPhysical = join(tmpRoot, "in-insertimg-gate-timeout.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-gate-timeout.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);
    graphicSelectionReturn = null;

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean; placedRect: { wCm: number; hCm: number } };
    expect(parsed.ok).toBe(true);
    // The full apply sequence still fires on timeout.
    expect(sentLines).toContain("clear-graphic-selection-cache");
    expect(sentLines.some((l) => /^insertfile name=\d+ type=graphic$/.test(l))).toBe(true);
    expect(sentLines).toContain("get-graphic-selection");
    expect(sentLines.some((l) => l.startsWith("uno .uno:TransformDialog "))).toBe(true);
    expect(sentLines).toContain("uno .uno:Escape");
    // The deterministic dims are still applied — the placed rect is
    // returned in the result regardless of the gate outcome.
    expect(parsed.placedRect.wCm).toBeCloseTo(parsed.placedRect.hCm, 5);
  });

  test("insert_image graphicselection gate resolves when the echo arrives (fresh post-insert rect)", async () => {
    // When coolwsd DOES push a `graphicselection:` echo (the happy
    // path), the gate resolves with the rect and the path proceeds.
    // The echo's rect is NOT used for sizing (the byte-based compute is
    // authoritative) — it's only the timing/selection signal. This
    // test configures a non-null echo and asserts the full sequence
    // fires in the same order.
    const deckPhysical = join(tmpRoot, "in-insertimg-gate-echo.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-gate-echo.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);
    // A non-null echo — twips rect (values irrelevant; the gate only
    // checks "the image is selected").
    graphicSelectionReturn = { x1: 0, y1: 0, x2: 8000, y2: 8000 };

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // The gate fires between insertfile and TransformDialog in order.
    const clearIdx = sentLines.indexOf("clear-graphic-selection-cache");
    const insertIdx = sentLines.findIndex(
      (l) => /^insertfile name=\d+ type=graphic$/.test(l),
    );
    const gateIdx = sentLines.indexOf("get-graphic-selection");
    const xformIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:TransformDialog "));
    const escapeIdx = sentLines.indexOf("uno .uno:Escape");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(clearIdx);
    expect(gateIdx).toBeGreaterThan(insertIdx);
    expect(xformIdx).toBeGreaterThan(gateIdx);
    expect(escapeIdx).toBeGreaterThan(xformIdx);
  });

  // ─── Bug 2: out-of-range targetSlide errors cleanly ───────────────

  test("insert_image with out-of-range targetSlide errors cleanly (Bug 2: no silent clamp-and-continue)", async () => {
    // 5-slide deck (indices 0..4). targetSlide=5 is out of range → the
    // dispatch returns an error BEFORE minting a session. Without the
    // fix, `setClientPart` would clamp to the last slide and the insert
    // would silently land on slide 4.
    const deckPhysical = join(tmpRoot, "in-insertimg-oor5.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-oor5.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);
    fakeSlideCount = 5;

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      targetSlide: 5,
      inPlace: true,
    }));
    expect(res).toContain("Error: insert_image 'targetSlide' 5 is out of range");
    expect(res).toContain("deck has 5 slides");
    // No session interaction — the bounds check fires up-front, before
    // the session is minted.
    expect(sentLines).not.toContain("getchildid");
    expect(sentLines.some((l) => l.startsWith("setclientpart part="))).toBe(false);
    expect(sentLines.some((l) => l.startsWith("insertfile name="))).toBe(false);
    expect(sentLines).not.toContain("clear-graphic-selection-cache");
    expect(sentLines).not.toContain("get-graphic-selection");
  });

  test("insert_image with out-of-range targetSlide=6 on a 5-slide deck errors (Bug 2: 6 > 4)", async () => {
    const deckPhysical = join(tmpRoot, "in-insertimg-oor6.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-oor6.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);
    fakeSlideCount = 5;

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      targetSlide: 6,
      inPlace: true,
    }));
    expect(res).toContain("Error: insert_image 'targetSlide' 6 is out of range");
    expect(res).toContain("deck has 5 slides");
    expect(sentLines).not.toContain("getchildid");
    expect(sentLines.some((l) => l.startsWith("insertfile name="))).toBe(false);
  });

  test("insert_image with targetSlide=4 on a 5-slide deck is the LAST valid index (Bug 2: boundary not off-by-one)", async () => {
    // targetSlide=4 on a 5-slide deck (indices 0..4) is the LAST valid
    // index — the bounds check must NOT reject it (off-by-one guard).
    const deckPhysical = join(tmpRoot, "in-insertimg-lastidx.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-lastidx.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);
    fakeSlideCount = 5;

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      targetSlide: 4,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // The setClientPart fires for the valid last index.
    expect(sentLines).toContain("setclientpart part=4");
  });

  test("insert_image bounds-check is skipped when the engine omits `slides` (no spurious block on malformed readback)", async () => {
    // If `getStructured` returns no `slides` array (e.g. the engine
    // emits a partial readback), the bounds check is SKIPPED — don't
    // block a legitimate insert on a malformed readback. The path
    // proceeds (no error). `fakeSlideCount = null` makes the fake
    // OMIT the `slides` field entirely (vs. `[]` which is an array of
    // length 0 and would enforce).
    const deckPhysical = join(tmpRoot, "in-insertimg-no-slides-field.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-no-slides-field.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);
    fakeSlideCount = null;

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      targetSlide: 99,
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // The bounds check was skipped (no `slides` field) → the path
    // proceeded and setClientPart fired for the (unchecked) target.
    expect(sentLines).toContain("setclientpart part=99");
  });

  test("insert_image with explicit w/h + at={x,y} uploads RESIZED bytes (sizing-via-bytes) and emits TransformDialog with ONLY PosX/PosY (NO TransformWidth/Height)", async () => {
    // D362 second wave: sizing is done by RESAMPLING THE BYTES before
    // insert (coolwsd's TransformDialog Width/Height is broken — see
    // the `office.ts:3107` U2 caveat + live readback). The dispatch
    // calls `resizeImageToCm(imageBytes, wCm, hCm, LO_INSERT_DPI)` and
    // the multipart POST carries the RESIZED bytes; the TransformDialog
    // build for insert_image sends ONLY TransformPosX/PosY (position
    // still works; size does not). `placedRect` in the result is
    // HONEST — the bytes are that size, so an `extract` after save
    // shows the image at exactly `{xCm, yCm, wCm, hCm}` (modulo the
    // `LO_INSERT_DPI` live-calibration factor — see `image-resize.ts`).
    const deckPhysical = join(tmpRoot, "in-insertimg-explicit-wh.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-explicit-wh.png");
    // Real decodable PNG (jimp-produced) — the dispatch's
    // `resizeImageToCm` will actually resample this; the
    // `pngHeader` fixture is IHDR-only (no IDAT) so jimp can't decode
    // it and the defensive path returns the original bytes.
    const imageBytes = await realPng(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      at: { x: 3, y: 2 },
      size: { w: 10, h: 6 },
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean;
      placedRect: { xCm: number; yCm: number; wCm: number; hCm: number };
      sizeMode: string;
      anchor: string;
      slideSizeSource: string;
    };
    expect(parsed.ok).toBe(true);
    // The result INCLUDES the placed rect — immediate spatial feedback
    // without a separate `extract`. The rect is HONEST: the bytes are
    // that size (sizing-via-bytes), so an `extract` after save shows
    // the image at exactly these cm (modulo LO_INSERT_DPI calibration).
    expect(parsed.placedRect).toEqual({ xCm: 3, yCm: 2, wCm: 10, hCm: 6 });
    expect(parsed.sizeMode).toBe("explicit:both");
    expect(parsed.anchor).toBe("explicit");
    expect(parsed.slideSizeSource).toBe("engine");

    // (a) The multipart POST carries the RESIZED bytes — decode them
    //     with jimp and assert the intrinsic pixel dims equal
    //     round(cm/2.54 * LO_INSERT_DPI):
    //       w = round(10/2.54 * 96) = round(378.0) = 378
    //       h = round(6/2.54  * 96) = round(226.77) = 227
    expect(lastPostInsertFileBytes).not.toBeNull();
    const decoded = await Jimp.read(Buffer.from(lastPostInsertFileBytes!));
    expect(decoded.width).toBe(Math.round((10 / 2.54) * LO_INSERT_DPI));
    expect(decoded.height).toBe(Math.round((6 / 2.54) * LO_INSERT_DPI));
    // The uploaded bytes are a PNG (resizeImageToCm re-encodes as PNG).
    expect(lastPostInsertFileBytes![0]).toBe(0x89);
    expect(lastPostInsertFileBytes![1]).toBe(0x50);
    expect(lastPostInsertFileBytes![2]).toBe(0x4e);
    expect(lastPostInsertFileBytes![3]).toBe(0x47);

    // (b) The TransformDialog args contain ONLY TransformPosX/PosY —
    //     NO TransformWidth/Height (sizing-via-bytes removed the
    //     post-insert size apply; coolwsd drops/corrupts those args
    //     anyway, see the U2 caveat at `office.ts:3107`).
    //   x=3cm≈1701, y=2cm≈1134 (twips, sent as "long").
    const xformIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:TransformDialog "));
    expect(xformIdx).toBeGreaterThanOrEqual(0);
    const xformLine = sentLines[xformIdx]!;
    expect(xformLine).toContain('"TransformPosX"');
    expect(xformLine).toContain('"TransformPosY"');
    expect(xformLine).not.toContain('"TransformWidth"');
    expect(xformLine).not.toContain('"TransformHeight"');
    expect(xformLine).toMatch(/"TransformPosX":\s*\{[^}]*"type":\s*"long"/);
    expect(xformLine).toMatch(/"TransformPosY":\s*\{[^}]*"type":\s*"long"/);
    // Sanity: x=3cm * 566.93 ≈ 1701 twips; y=2cm * 566.93 ≈ 1134 twips.
    expect(xformLine).toMatch(/"TransformPosX":\s*\{[^}]*"value":\s*170[0-9]/);
    expect(xformLine).toMatch(/"TransformPosY":\s*\{[^}]*"value":\s*113[0-9]/);

    // Escape settle fires AFTER the TransformDialog; save issued.
    const escapeIdx = sentLines.indexOf("uno .uno:Escape");
    expect(escapeIdx).toBeGreaterThan(xformIdx);
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("insert_image fit-to-slide (default) centers + scales a square image on a 28×15.75 slide, returns placedRect", async () => {
    // Default `size` = "fit" → contain within ≤ 0.9 of the slide
    // preserving aspect. Square 1000×1000 native on a 28×15.75 cm slide:
    //   wCm = 0.9*28 = 25.2; hCm = 25.2 (aspect 1); but 25.2 > 0.9*15.75=14.175
    //   → hCm = 14.175; wCm = 14.175 (aspect preserved).
    //   Centered: x = (28-14.175)/2 = 6.9125; y = (15.75-14.175)/2 = 0.7875.
    // Uses a REAL decodable PNG (jimp-produced) so the dispatch's
    // `resizeImageToCm` actually resamples the bytes — the
    // `pngHeader` fixture is IHDR-only (no IDAT) so jimp can't decode
    // it and the defensive path returns the original bytes (which
    // would break the byte-dim assertions below).
    const deckPhysical = join(tmpRoot, "in-insertimg-fit-square.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-fit-square.png");
    const imageBytes = await realPng(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      inPlace: true,
      // No at/size → default fit + center.
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean;
      placedRect: { xCm: number; yCm: number; wCm: number; hCm: number };
      sizeMode: string;
      anchor: string;
      nativePixels: { w: number; h: number } | null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.sizeMode).toBe("fit");
    expect(parsed.anchor).toBe("center");
    expect(parsed.nativePixels).toEqual({ w: 1000, h: 1000 });
    // Aspect preserved: w == h.
    expect(parsed.placedRect.wCm).toBeCloseTo(parsed.placedRect.hCm, 5);
    // The image fits within the slide (the clamp guarantee).
    expect(parsed.placedRect.xCm).toBeGreaterThanOrEqual(0);
    expect(parsed.placedRect.yCm).toBeGreaterThanOrEqual(0);
    expect(parsed.placedRect.xCm + parsed.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(parsed.placedRect.yCm + parsed.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    // Sanity: scaled to ~14.175 cm (the slide height is the binding axis).
    expect(parsed.placedRect.wCm).toBeGreaterThan(13);
    expect(parsed.placedRect.wCm).toBeLessThan(15);
    // Centered on the wider slide: x > 0 (the slide is wider than the image).
    expect(parsed.placedRect.xCm).toBeGreaterThan(5);
    expect(parsed.placedRect.yCm).toBeLessThan(2);

    // TransformDialog carries ONLY TransformPosX/PosY — NO
    // TransformWidth/Height (D362 second wave: sizing-via-bytes removed
    // the post-insert size apply; coolwsd drops/corrupts those args
    // anyway, see the U2 caveat at `office.ts:3107`). The image is
    // sized by RESAMPLING THE BYTES before insert (`resizeImageToCm`
    // in `@nautilo/loffice`), so the inserted raster's intrinsic pixel
    // size IS the target cm rect — no post-insert size apply needed.
    const xformIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:TransformDialog "));
    expect(xformIdx).toBeGreaterThanOrEqual(0);
    const xformLine = sentLines[xformIdx]!;
    expect(xformLine).toContain('"TransformPosX"');
    expect(xformLine).toContain('"TransformPosY"');
    expect(xformLine).not.toContain('"TransformWidth"');
    expect(xformLine).not.toContain('"TransformHeight"');
    // Position is still sent as "long" (the working type for
    // SfxInt32Item, same as place_textbox).
    expect(xformLine).toMatch(/"TransformPosX":\s*\{[^}]*"type":\s*"long"/);
    expect(xformLine).toMatch(/"TransformPosY":\s*\{[^}]*"type":\s*"long"/);
    // The size is NOT in the TransformDialog — it's in the BYTES. The
    // uploaded bytes decode to round(14.175/2.54 * 96) ≈ 535 px square
    // (the fit-to-slide scaled cm). The placed rect's wCm/hCm is the
    // authoritative size; the bytes match it (modulo LO_INSERT_DPI
    // calibration — see `image-resize.ts`).
    expect(lastPostInsertFileBytes).not.toBeNull();
    const decoded = await Jimp.read(Buffer.from(lastPostInsertFileBytes!));
    // 14.175cm @ 96dpi = round(14.175/2.54 * 96) = round(535.43) = 535.
    expect(decoded.width).toBe(Math.round((parsed.placedRect.wCm / 2.54) * LO_INSERT_DPI));
    expect(decoded.height).toBe(Math.round((parsed.placedRect.hCm / 2.54) * LO_INSERT_DPI));
    // Aspect preserved in the bytes: w == h (square fit).
    expect(decoded.width).toBe(decoded.height);

    const escapeIdx = sentLines.indexOf("uno .uno:Escape");
    expect(escapeIdx).toBeGreaterThan(xformIdx);
    expect(sentLines.some((l) => l.startsWith("save "))).toBe(true);
  });

  test("insert_image with a portrait JPEG fits on the 28×15.75 slide (height-binding, aspect preserved, on-slide)", async () => {
    // Portrait 800×1200 native → aspect = 0.667. Fit on 28×15.75:
    //   wCm = 0.9*28 = 25.2; hCm = 25.2/0.667 = 37.78 > 14.175
    //   → hCm = 14.175; wCm = 14.175 * 0.667 = 9.45.
    //   Centered: x = (28-9.45)/2 = 9.275; y = (15.75-14.175)/2 = 0.7875.
    const deckPhysical = join(tmpRoot, "in-insertimg-fit-portrait.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-fit-portrait.jpg");
    const imageBytes = jpegHeader(800, 1200);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean;
      placedRect: { xCm: number; yCm: number; wCm: number; hCm: number };
      nativePixels: { w: number; h: number } | null;
    };
    expect(parsed.ok).toBe(true);
    // JPEG header parsed → native pixels available.
    expect(parsed.nativePixels).toEqual({ w: 800, h: 1200 });
    // On-slide clamp guarantee.
    expect(parsed.placedRect.xCm).toBeGreaterThanOrEqual(0);
    expect(parsed.placedRect.yCm).toBeGreaterThanOrEqual(0);
    expect(parsed.placedRect.xCm + parsed.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(parsed.placedRect.yCm + parsed.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    // Aspect preserved: w/h ≈ 800/1200 = 0.667.
    expect(parsed.placedRect.wCm / parsed.placedRect.hCm).toBeCloseTo(800 / 1200, 3);
    // Height-binding: h ≈ 14.175.
    expect(parsed.placedRect.hCm).toBeGreaterThan(13);
    expect(parsed.placedRect.hCm).toBeLessThan(15);
  });

  test("insert_image with a landscape PNG fits on the 28×15.75 slide (width-binding, aspect preserved)", async () => {
    // Landscape 1920×1080 native → aspect = 1.778. Fit on 28×15.75:
    //   wCm = 0.9*28 = 25.2; hCm = 25.2/1.778 = 14.175 ≈ 0.9*15.75.
    //   Both axes near the safe-area limit; width-binding (w = 25.2).
    const deckPhysical = join(tmpRoot, "in-insertimg-fit-landscape.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-fit-landscape.png");
    const imageBytes = pngHeader(1920, 1080);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean;
      placedRect: { xCm: number; yCm: number; wCm: number; hCm: number };
      nativePixels: { w: number; h: number } | null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.nativePixels).toEqual({ w: 1920, h: 1080 });
    expect(parsed.placedRect.xCm).toBeGreaterThanOrEqual(0);
    expect(parsed.placedRect.yCm).toBeGreaterThanOrEqual(0);
    expect(parsed.placedRect.xCm + parsed.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(parsed.placedRect.yCm + parsed.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    // Aspect preserved: w/h ≈ 1920/1080 = 1.778.
    expect(parsed.placedRect.wCm / parsed.placedRect.hCm).toBeCloseTo(1920 / 1080, 3);
    // Width-binding: w ≈ 25.2.
    expect(parsed.placedRect.wCm).toBeGreaterThan(24);
    expect(parsed.placedRect.wCm).toBeLessThan(26);
  });

  test("insert_image with a named anchor 'top-left' places at (0,0); 'bottom-right' clamps to slide corner", async () => {
    const deckPhysical = join(tmpRoot, "in-insertimg-anchors.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-anchors.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );

    // top-left: rect at (0, 0).
    const resTopLeft = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      at: "top-left",
      inPlace: true,
    }));
    const parsedTopLeft = JSON.parse(resTopLeft) as {
      ok: boolean; placedRect: { xCm: number; yCm: number; wCm: number; hCm: number }; anchor: string;
    };
    expect(parsedTopLeft.ok).toBe(true);
    expect(parsedTopLeft.anchor).toBe("top-left");
    expect(parsedTopLeft.placedRect.xCm).toBeCloseTo(0, 5);
    expect(parsedTopLeft.placedRect.yCm).toBeCloseTo(0, 5);

    // bottom-right: x = slideW - w, y = slideH - h (clamped to the corner).
    const resBottomRight = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      at: "bottom-right",
      inPlace: true,
    }));
    const parsedBR = JSON.parse(resBottomRight) as {
      ok: boolean; placedRect: { xCm: number; yCm: number; wCm: number; hCm: number }; anchor: string;
    };
    expect(parsedBR.ok).toBe(true);
    expect(parsedBR.anchor).toBe("bottom-right");
    // The rect's bottom-right corner coincides with the slide's
    // bottom-right corner (within rounding).
    expect(parsedBR.placedRect.xCm + parsedBR.placedRect.wCm).toBeCloseTo(28, 5);
    expect(parsedBR.placedRect.yCm + parsedBR.placedRect.hCm).toBeCloseTo(15.75, 5);
  });

  test("insert_image with size = 0.33 (fraction of slide width) derives height from native aspect", async () => {
    // 28×15.75 slide, fraction 0.33 → wCm = 0.33*28 = 9.24.
    // Square 1000×1000 native → hCm = 9.24 (aspect 1).
    const deckPhysical = join(tmpRoot, "in-insertimg-fraction.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-fraction.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      size: 0.33,
      at: "top-left",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean; placedRect: { xCm: number; yCm: number; wCm: number; hCm: number }; sizeMode: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.sizeMode).toBe("fraction:0.33");
    expect(parsed.placedRect.xCm).toBeCloseTo(0, 5);
    expect(parsed.placedRect.yCm).toBeCloseTo(0, 5);
    expect(parsed.placedRect.wCm).toBeCloseTo(0.33 * 28, 5);
    expect(parsed.placedRect.hCm).toBeCloseTo(0.33 * 28, 5); // aspect 1
  });

  test("insert_image with size = {w} only derives h from native aspect", async () => {
    // 28×15.75 slide, size {w: 14} on a 1920×1080 native (aspect 1.778).
    //   hCm = 14 / 1.778 = 7.875.
    const deckPhysical = join(tmpRoot, "in-insertimg-w-only.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-w-only.png");
    const imageBytes = pngHeader(1920, 1080);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      size: { w: 14 },
      at: "center",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean; placedRect: { xCm: number; yCm: number; wCm: number; hCm: number }; sizeMode: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.sizeMode).toBe("explicit:w-derived");
    expect(parsed.placedRect.wCm).toBeCloseTo(14, 5);
    expect(parsed.placedRect.hCm).toBeCloseTo(14 / (1920 / 1080), 4);
  });

  test("insert_image with size = {h} only derives w from native aspect", async () => {
    // 28×15.75 slide, size {h: 10} on a 800×1200 native (aspect 0.667).
    //   wCm = 10 * 0.667 = 6.667.
    const deckPhysical = join(tmpRoot, "in-insertimg-h-only.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-h-only.jpg");
    const imageBytes = jpegHeader(800, 1200);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      size: { h: 10 },
      at: "center",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean; placedRect: { xCm: number; yCm: number; wCm: number; hCm: number }; sizeMode: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.sizeMode).toBe("explicit:h-derived");
    expect(parsed.placedRect.hCm).toBeCloseTo(10, 5);
    expect(parsed.placedRect.wCm).toBeCloseTo(10 * (800 / 1200), 4);
  });

  test("insert_image clamps an explicit {w,h} that exceeds the slide (never off-slide)", async () => {
    // Explicit 30×20 on a 28×15.75 slide — both dims overflow. The
    // clamp scales BOTH dims by slideW/w = 28/30 = 0.933 first (w→28,
    // h→18.67), then by slideH/h = 15.75/18.67 = 0.844 (w→23.6,
    // h→15.75). Aspect of the EXPLICIT dims (30/20 = 1.5) is preserved
    // (23.6/15.75 ≈ 1.5) because both dims scale by the same factor.
    const deckPhysical = join(tmpRoot, "in-insertimg-clamp.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-clamp.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      size: { w: 30, h: 20 },
      at: "center",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean; placedRect: { xCm: number; yCm: number; wCm: number; hCm: number };
    };
    expect(parsed.ok).toBe(true);
    // GUARANTEED on-slide — the clamp is the whole point of the redesign.
    expect(parsed.placedRect.xCm).toBeGreaterThanOrEqual(0);
    expect(parsed.placedRect.yCm).toBeGreaterThanOrEqual(0);
    expect(parsed.placedRect.xCm + parsed.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(parsed.placedRect.yCm + parsed.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    // The explicit-dims aspect (1.5) is preserved through the clamp.
    expect(parsed.placedRect.wCm / parsed.placedRect.hCm).toBeCloseTo(30 / 20, 3);
  });

  test("insert_image falls back to the hardcoded slide size + flags 'fallback' when getStructured omits slideSize", async () => {
    // Force the fake `getStructured` to report a non-slides doctype so
    // the dispatch can't read a real slide size. It MUST fall back to
    // the hardcoded 25.4×19.05 default AND flag `slideSizeSource:
    // "fallback"` so the agent knows the slide dims may be wrong.
    fakeSlideSizeCm = { widthCm: 0, heightCm: 0 }; // triggers the fallback
    const deckPhysical = join(tmpRoot, "in-insertimg-fallback-slide.pptx");
    const imagePhysical = join(tmpRoot, "logo-insertimg-fallback-slide.png");
    const imageBytes = pngHeader(1000, 1000);
    await writeFile(deckPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(imagePhysical, imageBytes);
    nextResolution = insertImageResolution(deckPhysical, imagePhysical, imageBytes);

    const tool = createOfficeTool(
      { memoryAccessEnvelope: namespaceEnvelope() },
      { makeClient, makeSession: makeFakeSession, gate: fakeGate },
    );
    const res = String(await tool.invoke({
      command: "insert_image",
      zone: "workspace",
      path: "deck/in.pptx",
      imagePath: "assets/logo.png",
      inPlace: true,
    }));
    const parsed = JSON.parse(res) as {
      ok: boolean;
      slideSize: { widthCm: number; heightCm: number };
      slideSizeSource: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.slideSizeSource).toBe("fallback");
    expect(parsed.slideSize).toEqual({ widthCm: 25.4, heightCm: 19.05 });
  });

  // ─── Pure compute-rect unit tests (the deterministic geometry proof) ──
  // `computeImagePlacementRect` is PURE — no session, no engine. These
  // tests are the MEANINGFUL proof of the geometry (the whole point of
  // the redesign): portrait/landscape/square natives on a 28×15.75 slide,
  // every named anchor, every size mode, and the never-off-slide clamp.

  test("computeImagePlacementRect: default fit+center, square native on 28×15.75", () => {
    const r = computeImagePlacementRect(
      { w: 1000, h: 1000 },
      { w: 28, h: 15.75 },
      {},
    );
    expect(r.anchor).toBe("center");
    expect(r.sizeMode).toBe("fit");
    expect(r.nativePixels).toEqual({ w: 1000, h: 1000 });
    // Square fits to the binding axis (height): h = 0.9*15.75 = 14.175; w = 14.175.
    expect(r.placedRect.hCm).toBeCloseTo(14.175, 3);
    expect(r.placedRect.wCm).toBeCloseTo(14.175, 3);
    expect(r.placedRect.xCm).toBeCloseTo((28 - 14.175) / 2, 3);
    expect(r.placedRect.yCm).toBeCloseTo((15.75 - 14.175) / 2, 3);
    // On-slide.
    expect(r.placedRect.xCm + r.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(r.placedRect.yCm + r.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
  });

  test("computeImagePlacementRect: each named anchor positions correctly", () => {
    const slide = { w: 28, h: 15.75 };
    const native = { w: 1000, h: 1000 };
    // Fit a square → w = h = 14.175.
    const w = 14.175;
    const h = 14.175;
    const cases: Array<{ anchor: "center" | "top-left" | "top" | "top-right" | "left" | "right" | "bottom-left" | "bottom" | "bottom-right"; x: number; y: number }> = [
      { anchor: "top-left", x: 0, y: 0 },
      { anchor: "top", x: (28 - w) / 2, y: 0 },
      { anchor: "top-right", x: 28 - w, y: 0 },
      { anchor: "left", x: 0, y: (15.75 - h) / 2 },
      { anchor: "center", x: (28 - w) / 2, y: (15.75 - h) / 2 },
      { anchor: "right", x: 28 - w, y: (15.75 - h) / 2 },
      { anchor: "bottom-left", x: 0, y: 15.75 - h },
      { anchor: "bottom", x: (28 - w) / 2, y: 15.75 - h },
      { anchor: "bottom-right", x: 28 - w, y: 15.75 - h },
    ];
    for (const c of cases) {
      const r = computeImagePlacementRect(native, slide, { at: c.anchor });
      expect(r.anchor).toBe(c.anchor);
      expect(r.placedRect.xCm).toBeCloseTo(c.x, 3);
      expect(r.placedRect.yCm).toBeCloseTo(c.y, 3);
      expect(r.placedRect.wCm).toBeCloseTo(w, 3);
      expect(r.placedRect.hCm).toBeCloseTo(h, 3);
    }
  });

  test("computeImagePlacementRect: fraction size derives height from native aspect", () => {
    const r = computeImagePlacementRect(
      { w: 1920, h: 1080 },
      { w: 28, h: 15.75 },
      { size: 0.5, at: "top-left" },
    );
    // wCm = 0.5*28 = 14; aspect = 1920/1080 = 1.778; hCm = 14/1.778 = 7.875.
    expect(r.sizeMode).toBe("fraction:0.5");
    expect(r.placedRect.wCm).toBeCloseTo(14, 5);
    expect(r.placedRect.hCm).toBeCloseTo(14 / (1920 / 1080), 4);
    expect(r.placedRect.xCm).toBeCloseTo(0, 5);
    expect(r.placedRect.yCm).toBeCloseTo(0, 5);
  });

  test("computeImagePlacementRect: explicit {w,h} both → used as-is (may distort)", () => {
    const r = computeImagePlacementRect(
      { w: 1000, h: 1000 },
      { w: 28, h: 15.75 },
      { size: { w: 20, h: 10 }, at: "top-left" },
    );
    expect(r.sizeMode).toBe("explicit:both");
    expect(r.placedRect.wCm).toBe(20);
    expect(r.placedRect.hCm).toBe(10);
  });

  test("computeImagePlacementRect: explicit {w} only → derive h from native aspect", () => {
    const r = computeImagePlacementRect(
      { w: 1920, h: 1080 },
      { w: 28, h: 15.75 },
      { size: { w: 14 } },
    );
    expect(r.sizeMode).toBe("explicit:w-derived");
    expect(r.placedRect.wCm).toBe(14);
    expect(r.placedRect.hCm).toBeCloseTo(14 / (1920 / 1080), 4);
  });

  test("computeImagePlacementRect: explicit {h} only → derive w from native aspect", () => {
    const r = computeImagePlacementRect(
      { w: 800, h: 1200 },
      { w: 28, h: 15.75 },
      { size: { h: 10 } },
    );
    expect(r.sizeMode).toBe("explicit:h-derived");
    expect(r.placedRect.hCm).toBe(10);
    expect(r.placedRect.wCm).toBeCloseTo(10 * (800 / 1200), 4);
  });

  test("computeImagePlacementRect: portrait native on 28×15.75 fits to height (aspect preserved, on-slide)", () => {
    const r = computeImagePlacementRect(
      { w: 800, h: 1200 },
      { w: 28, h: 15.75 },
      {},
    );
    expect(r.placedRect.hCm).toBeLessThanOrEqual(0.9 * 15.75 + 1e-6);
    expect(r.placedRect.wCm + r.placedRect.xCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(r.placedRect.yCm + r.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    // Aspect preserved.
    expect(r.placedRect.wCm / r.placedRect.hCm).toBeCloseTo(800 / 1200, 3);
  });

  test("computeImagePlacementRect: landscape native on 28×15.75 fits to width (aspect preserved, on-slide)", () => {
    const r = computeImagePlacementRect(
      { w: 1920, h: 1080 },
      { w: 28, h: 15.75 },
      {},
    );
    expect(r.placedRect.wCm).toBeLessThanOrEqual(0.9 * 28 + 1e-6);
    expect(r.placedRect.xCm + r.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(r.placedRect.yCm + r.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    expect(r.placedRect.wCm / r.placedRect.hCm).toBeCloseTo(1920 / 1080, 3);
  });

  test("computeImagePlacementRect: square native on 28×15.75 fits to height (binding axis)", () => {
    const r = computeImagePlacementRect(
      { w: 1000, h: 1000 },
      { w: 28, h: 15.75 },
      {},
    );
    // Square: both dims equal; height is the binding axis (0.9*15.75 < 0.9*28).
    expect(r.placedRect.wCm).toBe(r.placedRect.hCm);
    expect(r.placedRect.hCm).toBeCloseTo(0.9 * 15.75, 3);
  });

  test("computeImagePlacementRect: never off-slide clamp — explicit {w,h} that exceeds slide is shrunk preserving the explicit aspect", () => {
    // 30×20 on 28×15.75 — both overflow. The clamp scales both dims
    // equally (preserves the 30:20 = 1.5 aspect) until the rect fits.
    const r = computeImagePlacementRect(
      { w: 1000, h: 1000 },
      { w: 28, h: 15.75 },
      { size: { w: 30, h: 20 }, at: "center" },
    );
    expect(r.placedRect.xCm).toBeGreaterThanOrEqual(0);
    expect(r.placedRect.yCm).toBeGreaterThanOrEqual(0);
    expect(r.placedRect.xCm + r.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(r.placedRect.yCm + r.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    // Explicit-dims aspect preserved through the clamp.
    expect(r.placedRect.wCm / r.placedRect.hCm).toBeCloseTo(30 / 20, 3);
  });

  test("computeImagePlacementRect: nativePixels null → falls back to slide aspect (deterministic)", () => {
    // Unknown format → nativePixels null. Fit falls back to filling the
    // safe area on both axes (no aspect to preserve); the rect is still
    // on-slide and deterministic.
    const r = computeImagePlacementRect(
      null,
      { w: 28, h: 15.75 },
      {},
    );
    expect(r.nativePixels).toBeNull();
    expect(r.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(r.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    expect(r.placedRect.xCm + r.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(r.placedRect.yCm + r.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
  });

  test("computeImagePlacementRect: explicit {x,y} at respected + clamped to slide", () => {
    // Place a fit-sized square at {x: 20, y: 10} on 28×15.75. The rect
    // is 14.175×14.175; x=20 would push x+w = 34.175 > 28, so the clamp
    // pulls x back to 28-14.175 = 13.825.
    const r = computeImagePlacementRect(
      { w: 1000, h: 1000 },
      { w: 28, h: 15.75 },
      { at: { x: 20, y: 10 } },
    );
    expect(r.anchor).toBe("explicit");
    expect(r.placedRect.xCm + r.placedRect.wCm).toBeLessThanOrEqual(28 + 1e-6);
    expect(r.placedRect.yCm + r.placedRect.hCm).toBeLessThanOrEqual(15.75 + 1e-6);
    // The clamp pulled x back so the rect stays on-slide.
    expect(r.placedRect.xCm).toBeLessThanOrEqual(20);
  });
});

// ─── readImagePixelSize pure unit tests (deterministic native-aspect) ──
// `readImagePixelSize` parses PNG IHDR + JPEG SOF headers. These tests
// verify the parser with real header byte fixtures (and an unknown
// format → null) — the deterministic native-aspect source for the
// insert_image placement compute.
describe("readImagePixelSize", () => {
  test("PNG: parses IHDR width/height (big-endian uint32 at offset 16/20)", () => {
    // Build a 24-byte PNG header with width=1920, height=1080.
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    const w = 1920;
    const h = 1080;
    bytes[16] = (w >>> 24) & 0xff;
    bytes[17] = (w >>> 16) & 0xff;
    bytes[18] = (w >>> 8) & 0xff;
    bytes[19] = w & 0xff;
    bytes[20] = (h >>> 24) & 0xff;
    bytes[21] = (h >>> 16) & 0xff;
    bytes[22] = (h >>> 8) & 0xff;
    bytes[23] = h & 0xff;
    expect(readImagePixelSize(bytes)).toEqual({ w: 1920, h: 1080 });
  });

  test("PNG: large dims (4000×3000) parse correctly across all 4 bytes", () => {
    // 4000 = 0x0FA0, 3000 = 0x0BB8.
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    bytes[16] = 0x00; bytes[17] = 0x00; bytes[18] = 0x0f; bytes[19] = 0xa0;
    bytes[20] = 0x00; bytes[21] = 0x00; bytes[22] = 0x0b; bytes[23] = 0xb8;
    expect(readImagePixelSize(bytes)).toEqual({ w: 4000, h: 3000 });
  });

  test("PNG: truncated header (< 24 bytes) → null", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(readImagePixelSize(bytes)).toBeNull();
  });

  test("PNG: valid signature but missing IHDR chunk marker → null", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    // Leave bytes 12..15 as zeros (NOT "IHDR").
    expect(readImagePixelSize(bytes)).toBeNull();
  });

  test("JPEG: parses SOF0 marker (height/width big-endian after segLen+precision)", () => {
    // FF D8 FF C0 00 11 08 02 58 03 20 ... → height=0x0258=600, width=0x0320=800.
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0,
      0x00, 0x11,
      0x08,
      0x02, 0x58, // height = 600
      0x03, 0x20, // width = 800
      0x01, 0x01, 0x11, 0x00,
    ]);
    expect(readImagePixelSize(bytes)).toEqual({ w: 800, h: 600 });
  });

  test("JPEG: parses SOF2 (progressive) marker the same as SOF0", () => {
    // FF D8 FF C2 00 11 08 04 38 07 80 ... → height=0x0438=1080, width=0x0780=1920.
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc2,
      0x00, 0x11,
      0x08,
      0x04, 0x38, // height = 1080
      0x07, 0x80, // width = 1920
      0x01, 0x01, 0x11, 0x00,
    ]);
    expect(readImagePixelSize(bytes)).toEqual({ w: 1920, h: 1080 });
  });

  test("JPEG: skips APP0 (FFE0) before SOF0 — the common JFIF layout", () => {
    // FF D8 FF E0 00 10 4A 46 49 46 ... (16-byte APP0) then FF C0 SOF0.
    // APP0: FF E0 00 10 + 14 bytes payload (bytes 2..19).
    // SOF0: FF C0 00 11 08 02 58 03 20 ... (bytes 20..).
    const bytes = new Uint8Array(31);
    bytes[0] = 0xff; bytes[1] = 0xd8;        // SOI
    bytes[2] = 0xff; bytes[3] = 0xe0;        // APP0 marker
    bytes[4] = 0x00; bytes[5] = 0x10;        // segLen = 16
    for (let i = 6; i <= 19; i++) bytes[i] = 0x00; // 14 bytes payload
    bytes[20] = 0xff; bytes[21] = 0xc0;      // SOF0 marker
    bytes[22] = 0x00; bytes[23] = 0x11;      // segLen = 17
    bytes[24] = 0x08;                         // precision
    bytes[25] = 0x02; bytes[26] = 0x58;      // height = 600
    bytes[27] = 0x03; bytes[28] = 0x20;      // width = 800
    bytes[29] = 0x01; bytes[30] = 0x01;      // filler
    expect(readImagePixelSize(bytes)).toEqual({ w: 800, h: 600 });
  });

  test("JPEG: no SOF before SOS → null", () => {
    // FF D8 FF DA ... (SOS with no preceding SOF — malformed for our purpose).
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x05, 0x01, 0x01, 0x00]);
    expect(readImagePixelSize(bytes)).toBeNull();
  });

  test("unknown format (e.g. GIF magic) → null", () => {
    // GIF8 magic.
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x0a, 0x00]);
    expect(readImagePixelSize(bytes)).toBeNull();
  });

  test("empty / too-short buffer → null", () => {
    expect(readImagePixelSize(new Uint8Array(0))).toBeNull();
    expect(readImagePixelSize(new Uint8Array(4))).toBeNull();
  });
});
