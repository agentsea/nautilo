/**
 * D069 — multimodal `file:read` returns ToolMessage for image/PDF paths when
 * the active model supports the modality (`DispatchContext.activeModelId`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ToolMessage } from "@langchain/core/messages";
import { handleRead } from "../../src/tools/file/commands/read";
import type { DispatchContext } from "../../src/tools/file/dispatch";

const BASE_CTX: DispatchContext = {
  zoneCtx: { workspaceRoot: "", currentFolder: null },
  ownerId: "test-owner",
};

/** Smallest valid-ish PNG (1×1 transparent pixel). */
const MIN_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000100000108060000001f15c4890000000a49444154789c63000100000500001d0a2db40000000049454e44ae426082",
  "hex",
);

let TMP = "";

beforeEach(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-mm-read-"));
});

afterEach(async () => {
  if (TMP) await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  TMP = "";
});

describe("handleRead multimodal (D069)", () => {
  test("PNG returns ToolMessage when model supports vision", async () => {
    const p = path.join(TMP, "one.png");
    await fsp.writeFile(p, MIN_PNG);

    const out = await handleRead(
      { command: "read", path: p, zone: "absolute" },
      { resolved: p, resolvedZone: "absolute" },
      { ...BASE_CTX, activeModelId: "anthropic:claude-sonnet-4-6" },
    );

    expect(out).toBeInstanceOf(ToolMessage);
    const tm = out as ToolMessage;
    expect(Array.isArray(tm.content)).toBe(true);
    const blocks = tm.content as Array<{ type?: string }>;
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[1]?.type).toBe("image_url");

    // D113A — workbench-side renderer envelope on additional_kwargs.
    const summaryRaw = tm.additional_kwargs["nautilo_event_summary"];
    expect(typeof summaryRaw).toBe("string");
    const summary = JSON.parse(summaryRaw as string) as Record<string, unknown>;
    expect(summary["multimodal"]).toBe(true);
    expect(summary["kind"]).toBe("image");
    expect(summary["absolutePath"]).toBe(p);
    expect(summary["mime"]).toBe("image/png");
    expect(summary["bytes"]).toBe(MIN_PNG.byteLength);
    expect(typeof summary["header"]).toBe("string");
  });

  test("PDF returns ToolMessage with base64 file block (NOT a data URL)", async () => {
    // Anthropic rejects data: URLs on document content blocks ("Only HTTPS
    // URLs are supported."). Documents must use source_type:"base64" with
    // mime_type (snake_case) + raw base64 in `data`. This test locks in
    // the corrected shape after the PDF-block regression on PR #149.
    const p = path.join(TMP, "doc.pdf");
    // Minimal-ish %PDF-1.4 magic bytes; sniff only checks the first 4 bytes.
    await fsp.writeFile(p, Buffer.from("%PDF-1.4\n%EOF\n"));

    const out = await handleRead(
      { command: "read", path: p, zone: "absolute" },
      { resolved: p, resolvedZone: "absolute" },
      { ...BASE_CTX, activeModelId: "anthropic:claude-sonnet-4-6" },
    );

    expect(out).toBeInstanceOf(ToolMessage);
    const tm = out as ToolMessage;
    const blocks = tm.content as Array<Record<string, unknown>>;
    expect(blocks[0]?.["type"]).toBe("text");
    const fileBlock = blocks[1] as Record<string, unknown>;
    expect(fileBlock["type"]).toBe("file");
    expect(fileBlock["source_type"]).toBe("base64");
    expect(fileBlock["mime_type"]).toBe("application/pdf");
    expect(typeof fileBlock["data"]).toBe("string");
    // The raw base64 must NOT carry a data: prefix.
    expect(fileBlock["data"]).not.toMatch(/^data:/);
    // No legacy fields that the broken implementation used.
    expect(fileBlock["url"]).toBeUndefined();
    expect(fileBlock["mimeType"]).toBeUndefined();

    // Envelope on additional_kwargs flips kind to "pdf".
    const summary = JSON.parse(
      tm.additional_kwargs["nautilo_event_summary"] as string,
    ) as Record<string, unknown>;
    expect(summary["kind"]).toBe("pdf");
  });

  test("PNG returns rejection string for text-only model", async () => {
    const p = path.join(TMP, "two.png");
    await fsp.writeFile(p, MIN_PNG);

    const out = await handleRead(
      { command: "read", path: p, zone: "absolute" },
      { resolved: p, resolvedZone: "absolute" },
      { ...BASE_CTX, activeModelId: "fireworks:accounts/fireworks/models/kimi-k2p5" },
    );

    expect(typeof out).toBe("string");
    expect(out).toContain("does not support vision");
    expect(out).toContain("kimi-k2p5");
  });
});
