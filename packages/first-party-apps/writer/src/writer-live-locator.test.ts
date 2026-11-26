import { describe, expect, test } from "bun:test";
import { createTableBlock } from "@nautilo/office-docs/node";
import {
  findCanonicalTextBlock,
  locateWriterText,
} from "./writer-live-locator";

describe("writer live locator", () => {
  test("disambiguates a short repeated target with exact context", () => {
    expect(locateWriterText("a cat, then a dog, then a cat.", {
      before: "then a", target: "cat", after: ".",
    })).toEqual({ ok: true, range: { start: 26, end: 29 } });
  });

  test("rejects an ambiguous locator", () => {
    expect(locateWriterText("a cat and a cat", { target: "cat" })).toMatchObject({
      ok: false, code: "anchor_ambiguous",
    });
  });

  test("reads and locates nested cell blocks without flattening tables", () => {
    const table = createTableBlock(1, 2);
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.id = "cell-a";
    table.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines = [{ text: "first target", style: {} }];
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.id = "cell-b";
    table.tableData!.rows[0]!.cells[1]!.blocks[0]!.inlines = [{ text: "second target", style: {} }];
    expect(locateWriterText(findCanonicalTextBlock([table], "cell-a")!.inlines.map((inline) => inline.text).join(""), { target: "target" }))
      .toEqual({ ok: true, range: { start: 6, end: 12 } });
    table.tableData!.rows[0]!.cells[1]!.colSpan = 0;
    expect(findCanonicalTextBlock([table], "cell-b")).toBeNull();
  });

});
