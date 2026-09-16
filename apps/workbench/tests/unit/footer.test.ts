import { describe, expect, test } from "bun:test";

import { connectionStateMeta } from "../../src/components/footer/connection-segment";
import {
  footerPathLabel,
  formatFooterPath,
} from "../../src/components/footer/current-folder-segment";
import {
  FOOTER_SEGMENT_CLASSES,
  FOOTER_SEGMENT_ICON_CLASSES,
  FOOTER_SEGMENT_LABEL_CLASSES,
} from "../../src/components/footer/footer-segment";

describe("workbench footer helpers (D096)", () => {
  test("connectionStateMeta uses the connection status colors", () => {
    expect(connectionStateMeta("open")).toEqual({
      color: "var(--success)",
      label: "Connected",
      title: "Connected",
    });
    expect(connectionStateMeta("connecting")).toEqual({
      color: "var(--warning)",
      label: "Reconnecting",
      title: "Reconnecting...",
    });
    expect(connectionStateMeta("closed")).toEqual({
      color: "var(--warning)",
      label: "Connection lost",
      title: "Connection lost",
    });
    expect(connectionStateMeta("disconnected-long")).toEqual({
      color: "var(--warning)",
      label: "Connection lost",
      title: "Connection lost",
    });
  });

  test("formatFooterPath abbreviates paths under home when home is known", () => {
    expect(formatFooterPath("/Users/tester", "/Users/tester")).toBe("~");
    expect(formatFooterPath("/Users/tester/Projects/Nautilo", "/Users/tester")).toBe(
      "~/Projects/Nautilo",
    );
    expect(formatFooterPath("/Volumes/work/Nautilo", "/Users/tester")).toBe(
      "/Volumes/work/Nautilo",
    );
  });

  test("formatFooterPath leaves the path unchanged when home is not known", () => {
    expect(formatFooterPath("/Users/tester/Projects/Nautilo")).toBe(
      "/Users/tester/Projects/Nautilo",
    );
  });

  test("footerPathLabel uses the basename for compact status text", () => {
    expect(footerPathLabel("/Users/tester/Projects/product-workspace")).toBe("product-workspace");
    expect(footerPathLabel("/Users/tester/Projects/product-workspace/")).toBe("product-workspace");
  });

  test("segment classes preserve truncation + non-wrapping invariants", () => {
    expect(FOOTER_SEGMENT_CLASSES).toContain("inline-flex");
    expect(FOOTER_SEGMENT_CLASSES).toContain("min-w-0");
    expect(FOOTER_SEGMENT_CLASSES).toContain("whitespace-nowrap");
    expect(FOOTER_SEGMENT_ICON_CLASSES).toContain("shrink-0");
    expect(FOOTER_SEGMENT_LABEL_CLASSES).toContain("truncate");
  });
});
