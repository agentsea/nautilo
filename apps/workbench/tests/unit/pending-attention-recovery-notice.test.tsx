import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingAttentionRecoveryNotice } from
  "../../src/adapters/pending-attention-recovery-notice";

describe("PendingAttentionRecoveryNotice", () => {
  test("surfaces an explicit retry without claiming the pending set is empty", () => {
    const html = renderToStaticMarkup(
      <PendingAttentionRecoveryNotice onRetry={() => undefined} />,
    );
    expect(html).toContain("Couldn’t restore a pending approval.");
    expect(html).toContain("Try again");
    expect(html).toContain("pending-attention-recovery-status");
  });

  test("tells an older Desktop user to update without offering a futile retry", () => {
    const html = renderToStaticMarkup(<PendingAttentionRecoveryNotice />);
    expect(html).toContain("Update Nautilo Desktop to restore pending approvals.");
    expect(html).not.toContain("Try again");
  });
});
