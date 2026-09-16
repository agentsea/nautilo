import { describe, expect, mock, test } from "bun:test";
import { fsOpenFileTarget } from "../../src/components/browser-column/open-file-target";

mock.module("../../src/lib/api", () => ({
  apiClient: {},
}));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: false,
  desktopAPI: null,
  getShellStateOnBoot: () => null,
  computeInitialLastOpenAtSeed: (input: {
    hasEverBeenOpen: boolean;
    shellStateOnBoot: unknown;
    now: number;
  }) => (input.hasEverBeenOpen ? input.now : null),
}));

const {
  readBoundDocument,
  statBoundDocument,
  writeBoundDocument,
} = await import("../../src/apps/app-bridge");

describe("app bridge FS document operations in browser", () => {
  const fsTarget = fsOpenFileTarget("/repo/budget.document.json", "/repo");

  test("read/stat reject when desktop FS bridge is unavailable", async () => {
    await expect(readBoundDocument(fsTarget)).rejects.toThrow(
      "Desktop file bridge unavailable.",
    );
    await expect(statBoundDocument(fsTarget)).rejects.toThrow(
      "Desktop file bridge unavailable.",
    );
  });

  test("write reports unsupported instead of falling back to server disk", async () => {
    await expect(writeBoundDocument(fsTarget, "{}")).resolves.toEqual({
      kind: "error",
      message: "Desktop file bridge unavailable.",
    });
  });
});
