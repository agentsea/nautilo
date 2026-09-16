import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationEncryptionPolicyModeContext } from
  "../adapters/runtime-contexts";
import { FullAuthoredContextNotice } from "./full-authored-context-notice";

function render(mode: "unknown" | "plaintext_only" | "shadow_encryption" | "encrypted_only") {
  return renderToStaticMarkup(
    <ConversationEncryptionPolicyModeContext.Provider value={mode}>
      <FullAuthoredContextNotice />
    </ConversationEncryptionPolicyModeContext.Provider>,
  );
}

describe("FullAuthoredContextNotice", () => {
  test("shows the two narrow ordinary-plaintext exceptions in Full", () => {
    const html = render("encrypted_only");
    expect(html).toContain('role="status"');
    expect(html).toContain("Full encryption is on for supported conversation content");
    expect(html).toContain("Custom Soul and authored Skills remain ordinary plaintext");
    expect(html).toContain("these are the only Full encryption exceptions");
    expect(html).toContain("Unsupported operations are withheld");
    expect(html).not.toContain("temporarily omitted");
    expect(html).not.toContain("all content is encrypted");
    expect(html).not.toContain('role="alert"');
  });

  test.each(["unknown", "plaintext_only", "shadow_encryption"] as const)(
    "renders nothing in %s",
    (mode) => expect(render(mode)).toBe(""),
  );
});
