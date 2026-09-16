import { describe, expect, test } from "bun:test";
import type { BlockOp } from "../../../../src/lib/block-op-types";
import { groupOpsByBlock } from "../../../../src/components/diff-view/block-diff/group-ops-by-block";

describe("groupOpsByBlock", () => {
  test("insert → added section with id from after HTML", () => {
    const ops: BlockOp[] = [
      {
        op: "insert",
        anchor: { rel: "after", id: "s_1" },
        before: null,
        after: `<p id="p_new">hello</p>`,
      },
    ];
    const sections = groupOpsByBlock(ops);
    expect(sections).toHaveLength(1);
    expect(sections[0].op).toBe("added");
    expect(sections[0].blockId).toBe("p_new");
    expect(sections[0].tag).toBe("p");
    expect(sections[0].before).toBeNull();
    expect(sections[0].after).toBe(`<p id="p_new">hello</p>`);
  });

  test("replace delete (empty after) → deleted", () => {
    const ops: BlockOp[] = [
      {
        op: "replace",
        target: { block: "s_3" },
        before: `<nw-slide id="s_3">x</nw-slide>`,
        after: "",
      },
    ];
    const sections = groupOpsByBlock(ops);
    expect(sections[0].op).toBe("deleted");
    expect(sections[0].blockId).toBe("s_3");
    expect(sections[0].tag).toBe("nw-slide");
  });

  test("replace with content → modified", () => {
    const ops: BlockOp[] = [
      {
        op: "replace",
        target: { block: "s_3" },
        before: `<nw-slide id="s_3">old</nw-slide>`,
        after: `<nw-slide id="s_3">new</nw-slide>`,
      },
    ];
    const sections = groupOpsByBlock(ops);
    expect(sections[0].op).toBe("modified");
    expect(sections[0].blockId).toBe("s_3");
  });

  test("move → moved, snapshots preserved", () => {
    const ops: BlockOp[] = [
      {
        op: "move",
        blockId: "s_5",
        anchor: { rel: "before", id: "s_2" },
        before: `<nw-slide id="s_5">body</nw-slide>`,
        after: null,
      },
    ];
    const sections = groupOpsByBlock(ops);
    expect(sections[0].op).toBe("moved");
    expect(sections[0].blockId).toBe("s_5");
    expect(sections[0].after).toBeNull();
    expect(sections[0].blockOp.op).toBe("move");
  });

  test("range replace uses composite blockId", () => {
    const ops: BlockOp[] = [
      {
        op: "replace",
        target: { range: { from: "p_1", to: "p_5" } },
        before: "<p>a</p>",
        after: "<p>b</p>",
      },
    ];
    const sections = groupOpsByBlock(ops);
    expect(sections[0].blockId).toBe("p_1 .. p_5");
  });
});
