/**
 * D362 §3.4.8/§3.4.9 — hermetic unit tests for the `edit_doc` intent tool.
 *
 * Same mock strategy as `office-inplace.test.ts`: spread-the-real
 * `../file/artifact-store` (stub only the DB-touching resolve fn), inject
 * a fake engine client + fake coolwsd session + fake durability gate via
 * the `createEditDocTool` deps bag, and wire a fake session broker.
 *
 * The contract under test (operator intent): edit_doc hides ALL protocol
 * detail. Results are document-language only — `changed` / `summary` /
 * `updatedDoc` / `reason`, never WOPI/UNO/session/revision — and the
 * schema exposes no `zone` / `inPlace` / transport knob.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { CoolSessionLike, CoolSessionOptions, UnoArgs } from "@nautilo/loffice";
import type { CreateOfficeToolDeps } from "./office";
import {
  resetOfficeSessionBroker,
  setOfficeSessionBroker,
  type OfficeSessionBroker,
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
const sentLines: string[] = [];
let saveShouldFail = false;

function makeFakeSession(_opts: CoolSessionOptions): CoolSessionLike {
  return {
    async connect() {},
    sendUno(command: string, args?: UnoArgs) {
      sentLines.push(args ? `uno ${command} ${JSON.stringify(args)}` : `uno ${command}`);
    },
    async sendUnoAndWait(command: string, args?: UnoArgs) {
      sentLines.push(args ? `uno ${command} ${JSON.stringify(args)}` : `uno ${command}`);
      return { commandName: command, success: true };
    },
    async save() {
      if (saveShouldFail) throw new Error("fake: save failed");
      sentLines.push("save");
    },
    requestSave() {
      sentLines.push("save");
    },
    saveToStorage() {
      sentLines.push("savetostorage");
    },
    setClientPart() {
      /* no-op: not exercised by edit_doc (Writer text) tests */
    },
    sendMouse() {
      /* no-op: not exercised by edit_doc (Writer text) tests */
    },
    sendTextInput() {
      /* no-op: not exercised by edit_doc (Writer text) tests */
    },
    async getChildId() {
      /* no-op: not exercised by edit_doc (Writer text) tests */
      return "fake-child-id";
    },
    async postInsertFile() {
      /* no-op: not exercised by edit_doc (Writer text) tests */
    },
    sendInsertFile() {
      /* no-op: not exercised by edit_doc (Writer text) tests */
    },
    close() {
      sentLines.push("close");
    },
    isAlive() {
      return true;
    },
  };
}

let gateResult = true;
const fakeGate = async (): Promise<boolean> => gateResult;

// ─── Fake broker ─────────────────────────────────────────────────────
const fakeBroker: OfficeSessionBroker = {
  async mintSession() {
    return {
      wsBaseUrl: "ws://fake-engine:9980",
      docUrl: "http://host.docker.internal:9999/wopi/files/abc?access_token=tok",
      wopiSrc: "http://host.docker.internal:9999/wopi/files/abc",
      serviceRoot: "/office-engine",
      origin: "http://127.0.0.1:9999",
    };
  },
};

// ─── artifact-store stub (resolve only) ──────────────────────────────
let inPhysical = "";
const resolveWorkspaceArtifactMock = mock(async (): Promise<unknown> => ({
  ok: true,
  artifact: {
    id: "row-internal-1",
    artifactId: "art-1",
    path: "docs/plan.docx",
    storageUri: "file://" + inPhysical,
    size: 4,
    revision: 1,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  },
  physicalPath: inPhysical,
  artifactId: "art-1",
  storageUri: "file://" + inPhysical,
  logicalPath: "docs/plan.docx",
}));

// ─── Fake engine client — getStructured drives anchor matching ───────
let structuredResult: unknown = { paragraphs: ["hello world"] };
type EngineClient = ReturnType<NonNullable<CreateOfficeToolDeps["makeClient"]>>;
const makeClient: NonNullable<CreateOfficeToolDeps["makeClient"]> = () =>
  ({
    async getStructured() {
      return structuredResult;
    },
  }) as unknown as EngineClient;

let createEditDocTool: typeof import("./office").createEditDocTool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "office-editdoc-test-"));
  inPhysical = join(dir, "plan.docx");
  await writeFile(inPhysical, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  mock.module("../file/artifact-store", () => ({
    ...realArtifactStore,
    resolveWorkspaceArtifact: resolveWorkspaceArtifactMock,
  }));
  setOfficeSessionBroker(fakeBroker);
  ({ createEditDocTool } = await import("./office"));
});

beforeEach(() => {
  resetOfficeSessionManagerForTests();
  sentLines.length = 0;
  saveShouldFail = false;
  gateResult = true;
  structuredResult = { paragraphs: ["hello world"] };
});

afterAll(() => {
  mock.module("../file/artifact-store", () => realArtifactStore);
  resetOfficeSessionBroker();
  resetOfficeSessionManagerForTests();
});

function tool() {
  return createEditDocTool(
    { memoryAccessEnvelope: namespaceEnvelope() },
    { makeClient, makeSession: makeFakeSession, gate: fakeGate },
  );
}

describe("edit_doc — intent-level, protocol-free document edit", () => {
  test("append → GoToEndOfDoc + InsertText; changed:true; document-language result", async () => {
    const res = String(
      await tool().invoke({ operation: "append", path: "docs/plan.docx", text: "New line." }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(true);
    expect(typeof parsed["summary"]).toBe("string");
    expect(parsed["updatedDoc"]).not.toBeNull();
    // No protocol/transport leakage in the result surface.
    expect(res).not.toMatch(/wopi|websocket|session|revision|inPlace|"zone"/i);

    const gotoIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:GoToEndOfDoc"));
    const insertIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:InsertText "));
    expect(gotoIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(gotoIdx);
    expect(sentLines[insertIdx]!).toContain("New line.");
    expect(sentLines).toContain("save");
  });

  test("replace_exact with a unique anchor → ExecuteSearch replace; changed:true", async () => {
    structuredResult = { paragraphs: ["The quick brown fox jumps."] };
    const res = String(
      await tool().invoke({
        operation: "replace_exact",
        path: "docs/plan.docx",
        anchor: "quick brown fox",
        text: "lazy dog",
      }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(true);
    const searchLine = sentLines.find((l) => l.startsWith("uno .uno:ExecuteSearch "));
    expect(searchLine).toBeDefined();
    expect(searchLine!).toContain("quick brown fox");
    expect(searchLine!).toContain("lazy dog");
  });

  test("replace_exact anchor absent → changed:false with a plain reason, no engine op", async () => {
    structuredResult = { paragraphs: ["nothing to see here"] };
    const res = String(
      await tool().invoke({
        operation: "replace_exact",
        path: "docs/plan.docx",
        anchor: "zebra",
        text: "x",
      }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(false);
    expect(String(parsed["reason"])).toMatch(/not found/i);
    // No search was attempted — we short-circuit before opening the session.
    expect(sentLines.find((l) => l.startsWith("uno .uno:ExecuteSearch"))).toBeUndefined();
  });

  test("replace_exact ambiguous anchor (>1) → changed:false asking for a unique phrase", async () => {
    structuredResult = { paragraphs: ["fox here", "fox there"] };
    const res = String(
      await tool().invoke({
        operation: "replace_exact",
        path: "docs/plan.docx",
        anchor: "fox",
        text: "cat",
      }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(false);
    expect(String(parsed["reason"])).toMatch(/appears 2 times/i);
    expect(sentLines.find((l) => l.startsWith("uno .uno:ExecuteSearch"))).toBeUndefined();
  });

  test("replace_exact without anchor → changed:false, asks for the anchor", async () => {
    const res = String(
      await tool().invoke({ operation: "replace_exact", path: "docs/plan.docx", text: "x" }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(false);
    expect(String(parsed["reason"])).toMatch(/anchor/i);
  });

  test("insert_after → find-selects anchor, then GoToEndOfPara + InsertPara + InsertText; changed:true", async () => {
    structuredResult = { paragraphs: ["The anchor paragraph."] };
    const res = String(
      await tool().invoke({
        operation: "insert_after",
        path: "docs/plan.docx",
        anchor: "anchor paragraph",
        text: "New paragraph.",
      }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(true);

    // FIND (Command:0) select of the anchor, then the positional sequence in order.
    const searchIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:ExecuteSearch "));
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(sentLines[searchIdx]!).toMatch(/"value":0\b/); // SvxSearchCmd::FIND
    const endIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:GoToEndOfPara"));
    const paraIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:InsertPara"));
    const insertIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:InsertText "));
    expect(endIdx).toBeGreaterThan(searchIdx);
    expect(paraIdx).toBeGreaterThan(endIdx);
    expect(insertIdx).toBeGreaterThan(paraIdx);
    expect(sentLines[insertIdx]!).toContain("New paragraph.");
  });

  test("insert_before → GoToStartOfPara + InsertText + InsertPara; rewrite_section → GoToStartOfPara + EndOfParaSel + InsertText", async () => {
    structuredResult = { paragraphs: ["The anchor paragraph."] };
    await tool().invoke({
      operation: "insert_before",
      path: "docs/plan.docx",
      anchor: "anchor paragraph",
      text: "Before.",
    });
    const startIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:GoToStartOfPara"));
    const insIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:InsertText "));
    const paraIdx = sentLines.findIndex((l) => l.startsWith("uno .uno:InsertPara"));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(insIdx).toBeGreaterThan(startIdx);
    expect(paraIdx).toBeGreaterThan(insIdx);

    sentLines.length = 0;
    await tool().invoke({
      operation: "rewrite_section",
      path: "docs/plan.docx",
      anchor: "anchor paragraph",
      text: "Rewritten.",
    });
    const rStart = sentLines.findIndex((l) => l.startsWith("uno .uno:GoToStartOfPara"));
    const rSel = sentLines.findIndex((l) => l.startsWith("uno .uno:EndOfParaSel"));
    const rIns = sentLines.findIndex((l) => l.startsWith("uno .uno:InsertText "));
    expect(rStart).toBeGreaterThanOrEqual(0);
    expect(rSel).toBeGreaterThan(rStart);
    expect(rIns).toBeGreaterThan(rSel);
    expect(sentLines[rIns]!).toContain("Rewritten.");
  });

  test("delete → ExecuteSearch replace anchor with empty; changed:true; no 'text' required", async () => {
    structuredResult = { paragraphs: ["keep this. DELETE_ME_PHRASE. keep that."] };
    const res = String(
      await tool().invoke({ operation: "delete", path: "docs/plan.docx", anchor: "DELETE_ME_PHRASE" }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(true);
    const line = sentLines.find((l) => l.startsWith("uno .uno:ExecuteSearch "));
    expect(line).toBeDefined();
    expect(line!).toContain("DELETE_ME_PHRASE");
    expect(line!).toContain('"SearchItem.ReplaceString"');
    expect(line!).toMatch(/ReplaceString":\{"type":"string","value":""\}/);
    expect(line!).toMatch(/"value":3\b/); // REPLACE_ALL
  });

  test("delete without anchor → changed:false, asks for the anchor", async () => {
    const res = String(await tool().invoke({ operation: "delete", path: "docs/plan.docx" }));
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(false);
    expect(String(parsed["reason"])).toMatch(/anchor/i);
  });

  test("positional op with an ambiguous anchor (>1) → changed:false, no session opened", async () => {
    structuredResult = { paragraphs: ["dup here", "dup there"] };
    const res = String(
      await tool().invoke({
        operation: "insert_after",
        path: "docs/plan.docx",
        anchor: "dup",
        text: "x",
      }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(false);
    expect(String(parsed["reason"])).toMatch(/appears 2 times/i);
    expect(sentLines).toHaveLength(0);
  });

  test("edit sent but nothing lands (gate false) → changed:false, not-confirmed, no protocol terms", async () => {
    gateResult = false;
    const res = String(
      await tool().invoke({ operation: "append", path: "docs/plan.docx", text: "y" }),
    );
    const parsed = JSON.parse(res) as Record<string, unknown>;
    expect(parsed["changed"]).toBe(false);
    expect(String(parsed["reason"])).not.toMatch(/wopi|uno|websocket|session|revision/i);
    // Possibly-wedged session invalidated.
    expect(sentLines).toContain("close");
  });
});
