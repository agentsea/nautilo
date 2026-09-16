import { expect, test } from "bun:test";

test("AttentionBar keeps readable content below the system inset without duplicating it", async () => {
  const source = await Bun.file(new URL("./attention-bar.tsx", import.meta.url)).text();

  expect(source).toContain("useSafeAreaInsets()");
  expect(source).toContain("paddingTop: topInset + contentPaddingTop");
  expect(source).toContain("marginBottom: -topInset");
  expect(source).toContain("zIndex: 30");
  expect(source).toContain("elevation: 30");
  expect(source).toContain("paddingBottom: t.spacing.md");
  expect(source).toContain("compact ? styles.compactBar : null");
  expect(source).toContain("numberOfLines={compact ? 1 : 2}");
  expect(source).toContain("minHeight: 44");
  expect(source).not.toContain("paddingVertical: t.spacing.md");
});
