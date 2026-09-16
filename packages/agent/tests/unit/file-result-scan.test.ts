import { describe, expect, test } from "bun:test";
import { resolveFileToolResultScanPolicy } from "../../src/tools/file/file-result-scan";

describe("resolveFileToolResultScanPolicy (M206)", () => {
  test("local read/grep override catalog never to on-suspicious", () => {
    expect(
      resolveFileToolResultScanPolicy(
        { command: "read", zone: "current", path: "x.txt" },
        "never",
      ),
    ).toBe("on-suspicious");
    expect(
      resolveFileToolResultScanPolicy(
        { command: "grep", zone: "absolute", path: "/tmp", query: "a" },
        "never",
      ),
    ).toBe("on-suspicious");
  });

  test("local metadata commands keep catalog policy", () => {
    expect(
      resolveFileToolResultScanPolicy(
        { command: "write", zone: "current", path: "x.txt", content: "a" },
        "never",
      ),
    ).toBe("never");
    expect(
      resolveFileToolResultScanPolicy(
        { command: "list", zone: "current", path: "." },
        "never",
      ),
    ).toBe("never");
  });

  test("workspace commands keep catalog policy", () => {
    expect(
      resolveFileToolResultScanPolicy(
        { command: "read", zone: "workspace", path: "notes.md" },
        "never",
      ),
    ).toBe("never");
  });
});
