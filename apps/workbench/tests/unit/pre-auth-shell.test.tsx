import * as React from "react";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PreAuthShell } from "../../src/components/pre-auth-shell";

describe("PreAuthShell", () => {
  test("renders title, subtitle, and children with dialog labelling", () => {
    const html = renderToStaticMarkup(
      <PreAuthShell
        title="Welcome back"
        subtitle="Sign in to continue"
        scrim="page"
        testId="pre-auth-test"
      >
        <button type="button">Continue</button>
      </PreAuthShell>,
    );

    expect(html).toContain('data-testid="pre-auth-test"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="pre-auth-test-title"');
    expect(html).toContain('id="pre-auth-test-title"');
    expect(html).toContain("Welcome back");
    expect(html).toContain("Sign in to continue");
    expect(html).toContain("Continue");
  });

  test("omits subtitle when none is provided", () => {
    const html = renderToStaticMarkup(
      <PreAuthShell title="No subtitle" scrim="page">
        <span>Body</span>
      </PreAuthShell>,
    );

    expect(html).toContain("No subtitle");
    expect(html).toContain("Body");
    expect(html).not.toContain("undefined");
  });

  test("uses different wrappers for page and modal modes", () => {
    const page = renderToStaticMarkup(
      <PreAuthShell title="Page" scrim="page">
        <span>Body</span>
      </PreAuthShell>,
    );
    const modal = renderToStaticMarkup(
      <PreAuthShell title="Modal" scrim="modal" onClose={() => {}}>
        <span>Body</span>
      </PreAuthShell>,
    );

    expect(page).toContain("bg-background-panel");
    expect(page).not.toContain("bg-background p-4");
    expect(page).not.toContain("backdrop-blur-sm");
    expect(modal).toContain("bg-black/50");
    expect(modal).toContain("bg-background-panel");
    expect(modal).toContain("border-border-strong");
    expect(modal).toContain("backdrop-blur-sm");
    expect(modal).toContain('aria-label="Close"');
    expect(modal).toContain("absolute right-4 top-4");
  });
});
