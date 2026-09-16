import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockDiffSection } from "../../../../src/components/diff-view/block-diff/BlockDiffSection";
import { groupOpsByBlock } from "../../../../src/components/diff-view/block-diff/group-ops-by-block";
import type { BlockOp } from "../../../../src/lib/block-op-types";

describe("BlockDiffSection", () => {
  test("modified op: header + delete strike + insert highlight markers", () => {
    const ops: BlockOp[] = [
      {
        op: "rewrite",
        blockId: "p_7",
        scope: "text",
        old: "recieve",
        new: "receive",
        before: `<p id="p_7">recieve</p>`,
        after: `<p id="p_7">receive</p>`,
      },
    ];
    const [section] = groupOpsByBlock(ops);
    const html = renderToStaticMarkup(
      <BlockDiffSection section={section} />,
    );
    expect(html).toContain("p_7");
    expect(html).toContain("modified");
    expect(html).toContain("block-diff-del");
    expect(html).toContain("line-through");
    expect(html).toContain("block-diff-add");
    expect(html).not.toContain("block-diff-section-accept");
  });
});
