import { expect, test } from "bun:test";
import { openVerifiedVideoProjectCopy } from "../../src/apps/open-video-project-copy";

test("opens only the verified copy of the unchanged, clean source", async () => {
  let opened = false;
  expect(await openVerifiedVideoProjectCopy({ expectedSha256: "sha", isCurrent: () => true,
    readCurrentSha256: async () => "sha", verifyCopy: async () => true, open: () => { opened = true; } })).toEqual({ opened: true });
  expect(opened).toBe(true);
});

test("new draft edits, target or authority changes during either read prevent navigation", async () => {
  for (const driftDuring of ["source", "copy"]) {
    let current = true; let opened = false;
    const result = await openVerifiedVideoProjectCopy({ expectedSha256: "sha", isCurrent: () => current,
      readCurrentSha256: async () => { if (driftDuring === "source") current = false; return "sha"; },
      verifyCopy: async () => { if (driftDuring === "copy") current = false; return true; },
      open: () => { opened = true; } });
    expect(result).toEqual({ opened: false, code: "document_changed" });
    expect(opened).toBe(false);
  }
});

test("stale source and missing copy preserve the local project", async () => {
  for (const [sha, exists, code] of [["older", true, "document_changed"], ["sha", false, "unavailable"]] as const) {
    let opened = false;
    expect(await openVerifiedVideoProjectCopy({ expectedSha256: "sha", isCurrent: () => true,
      readCurrentSha256: async () => sha, verifyCopy: async () => exists, open: () => { opened = true; } })).toEqual({ opened: false, code });
    expect(opened).toBe(false);
  }
});
