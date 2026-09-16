import { describe, expect, test } from "bun:test";
import type { DiscoveredNautiloService, LocalInstanceRow } from "../../src/types";
import { mergePickerCandidates, normalizeServerUrlKey } from "../../src/merge-picker-candidates";

describe("mergePickerCandidates (D112)", () => {
  test("normalizeServerUrlKey strips trailing slash and lowercases", () => {
    expect(normalizeServerUrlKey("HTTP://A.COM/")).toBe("http://a.com");
  });

  test("dedupes layout + mDNS by URL", () => {
    const rows: LocalInstanceRow[] = [
      {
        root: "/x",
        instanceId: "",
        displayId: "default",
        projectName: "nautilo",
        serverPort: 3001,
        workbenchPort: 3000,
        state: "running",
      },
    ];
    const browse: DiscoveredNautiloService[] = [
      {
        name: "md",
        host: "host.local.",
        port: 3001,
        addresses: ["127.0.0.1"],
        serverUrl: "http://127.0.0.1:3001",
        txt: {},
      },
    ];
    const readUrl = () => "http://127.0.0.1:3001";
    const merged = mergePickerCandidates(rows, browse, readUrl);
    expect(merged.length).toBe(1);
    expect(merged[0]!.url).toBe("http://127.0.0.1:3001");
  });

  test("skips non-running layout rows", () => {
    const rows: LocalInstanceRow[] = [
      {
        root: "/x",
        instanceId: "a",
        displayId: "a",
        projectName: "nautilo-a",
        serverPort: 0,
        workbenchPort: 0,
        state: "idle",
      },
    ];
    const merged = mergePickerCandidates(rows, [], () => "http://127.0.0.1:9");
    expect(merged.length).toBe(0);
  });
});
