import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleInsertBlock,
  handleListBlocks,
  handleMoveBlock,
  handleReadBlock,
  handleReplaceBlock,
  handleRewriteBlock,
} from "../../../src/tools/file/blocks/commands";

let TMP_ROOT: string;

const CTX = {
  zoneCtx: { workspaceRoot: "", currentFolder: null },
  ownerId: "test-owner",
  turnId: "block-turn",
};

function absResolution(filePath: string) {
  return { resolved: filePath, resolvedZone: "absolute" as const };
}

function baseHtml() {
  return [
    "<!doctype html><html><body>",
    '<section id="deck">',
    '<p id="p_1">One</p>',
    '<p id="p_2" data-x="keep">Two</p>',
    '<p id="p_3">Three</p>',
    "</section>",
    "</body></html>",
  ].join("");
}

async function writeFixture(name: string): Promise<string> {
  const filePath = path.join(TMP_ROOT, `${name}-${Date.now()}-${Math.random()}.html`);
  await fsp.writeFile(filePath, baseHtml());
  return filePath;
}

function parseApplied(raw: string) {
  const parsed = JSON.parse(raw) as {
    applied?: boolean;
    blockOps?: Array<{ op: string; before?: string | null; after?: string | null }>;
    unifiedDiff: string;
  };
  if (parsed.applied !== true) throw new Error(`expected applied envelope, got: ${raw}`);
  return parsed;
}

function parseListBlocks(raw: string): { blocks: Array<{ id: string }> } {
  return JSON.parse(raw) as { blocks: Array<{ id: string }> };
}

function parseReadBlock(raw: string): { content: string } {
  return JSON.parse(raw) as { content: string };
}

beforeAll(async () => {
  TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-block-commands-test-"));
});

afterAll(async () => {
  if (TMP_ROOT) await fsp.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("block read commands", () => {
  test("list_blocks and read_block expose block content", async () => {
    const filePath = await writeFixture("read");
    const listed = parseListBlocks(await handleListBlocks({ command: "list_blocks", path: "x", zone: "workspace" }, absResolution(filePath), CTX));
    expect(listed.blocks.map((b: { id: string }) => b.id)).toContain("deck");
    const read = parseReadBlock(await handleReadBlock({ command: "read_block", path: "x", zone: "workspace", blockId: "p_2" }, absResolution(filePath), CTX));
    expect(read.content).toContain('data-x="keep"');
  });
});

describe("block mutators apply immediately", () => {
  test("replace_block applies and preserves blockOps", async () => {
    const filePath = await writeFixture("replace");
    const out = await handleReplaceBlock(
      { command: "replace_block", path: "x", zone: "workspace", target: { block: "p_2" }, newContent: '<p id="p_2">Two updated</p>' },
      absResolution(filePath),
      CTX,
    );
    const env = parseApplied(out);
    expect(env.blockOps?.[0]?.op).toBe("replace");
    expect(env.blockOps?.[0]?.before).toContain("Two");
    expect(env.blockOps?.[0]?.after).toContain("Two updated");
    expect(await fsp.readFile(filePath, "utf-8")).toContain("Two updated");
  });

  test("insert_block applies before an anchor", async () => {
    const filePath = await writeFixture("insert");
    const out = await handleInsertBlock(
      { command: "insert_block", path: "x", zone: "workspace", anchor: { rel: "before", id: "p_2" }, newContent: '<p id="p_new">New</p>' },
      absResolution(filePath),
      CTX,
    );
    const env = parseApplied(out);
    expect(env.blockOps?.[0]?.op).toBe("insert");
    const disk = await fsp.readFile(filePath, "utf-8");
    expect(disk.indexOf('id="p_new"')).toBeLessThan(disk.indexOf('id="p_2"'));
  });

  test("move_block applies without re-emitting content", async () => {
    const filePath = await writeFixture("move");
    const out = await handleMoveBlock(
      { command: "move_block", path: "x", zone: "workspace", blockId: "p_3", anchor: { rel: "before", id: "p_1" } },
      absResolution(filePath),
      CTX,
    );
    const env = parseApplied(out);
    expect(env.blockOps?.[0]?.op).toBe("move");
    expect(env.blockOps?.[0]?.after).toBeNull();
    const disk = await fsp.readFile(filePath, "utf-8");
    expect(disk.indexOf('id="p_3"')).toBeLessThan(disk.indexOf('id="p_1"'));
  });

  test("rewrite_block applies text-scope edits", async () => {
    const filePath = await writeFixture("rewrite");
    const out = await handleRewriteBlock(
      { command: "rewrite_block", path: "x", zone: "workspace", blockId: "p_1", scope: "text", oldString: "One", newString: "One!" },
      absResolution(filePath),
      CTX,
    );
    const env = parseApplied(out);
    expect(env.blockOps?.[0]?.op).toBe("rewrite");
    expect(await fsp.readFile(filePath, "utf-8")).toContain("One!");
  });

  test("duplicate ids are rejected before apply", async () => {
    const filePath = await writeFixture("dupe");
    const out = await handleInsertBlock(
      { command: "insert_block", path: "x", zone: "workspace", anchor: { rel: "after", id: "p_1" }, newContent: '<p id="p_2">Duplicate</p>' },
      absResolution(filePath),
      CTX,
    );
    expect(out).toMatch(/duplicate id/);
    expect(await fsp.readFile(filePath, "utf-8")).not.toContain("Duplicate");
  });
});
