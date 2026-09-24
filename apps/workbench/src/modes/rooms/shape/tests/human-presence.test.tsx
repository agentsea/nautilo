import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HumanPresence } from "../HumanPresence";

describe("HumanPresence", () => {
  test.each([
    ["online", "Online", "bg-[var(--success)]"],
    ["idle", "Idle", "bg-[var(--warning)]"],
    ["offline", "Offline", "bg-foreground-muted"],
  ] as const)("renders %s with a theme dot and label", (status, label, color) => {
    const html = renderToStaticMarkup(<HumanPresence status={status} />);
    expect(html).toContain(`>${label}</span>`);
    expect(html).toContain(color);
    expect(html).toContain(`data-status="${status}"`);
  });

  test("renders unavailable as a neutral dash with an accessible label", () => {
    const html = renderToStaticMarkup(<HumanPresence status={undefined} />);
    expect(html).toContain("—");
    expect(html).toContain('aria-label="Status unavailable"');
    expect(html).toContain('data-status="unavailable"');
  });

  test("compact mode exposes the status label accessibly", () => {
    const html = renderToStaticMarkup(<HumanPresence status="idle" compact name="Alex" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Alex: Idle"');
    expect(html).toContain('data-status="idle"');
  });

  test("compact unavailable status uses a neutral dash and identifies the Human", () => {
    const html = renderToStaticMarkup(<HumanPresence status={undefined} compact name="Alex" />);
    expect(html).toContain("—");
    expect(html).toContain('aria-label="Alex: Status unavailable"');
    expect(html).not.toContain("rounded-full");
  });
});
