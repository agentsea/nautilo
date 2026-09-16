import { describe, expect, test } from "bun:test";

import { verifyRenderedCoverageReport } from "../../src/report-verification";

describe("rendered coverage report verification", () => {
  test.each([
    "/Users/alice/project/report.md",
    "/home/alice/project/report.md",
    "/private/tmp/project/report.md",
    "/tmp/project/report.md",
    "/Volumes/work/project/report.md",
    "/workspace/project/report.md",
    "/opt/nautilo/project/report.md",
    "/custom-mount/project/report.md",
    "prefix (`/Users/alice/project/report.md`)",
    "C:\\Users\\alice\\project\\report.md",
    "c:\\users\\alice\\project\\report.md",
    "D:\\work\\nautilo\\report.md",
    "E:/work/nautilo/report.md",
    "\\\\fileserver\\share\\nautilo\\report.md",
    "//fileserver/share/nautilo/report.md",
    "header\n/opt/nautilo/report.md",
    "header\nD:\\work\\nautilo\\report.md",
    "header\n\\\\fileserver\\share\\nautilo\\report.md",
    "header\n//fileserver/share/nautilo/report.md",
    "xGET /api/rooms/:id",
    "GET /api/rooms/:id /opt/nautilo/report.md",
    "GET /opt/secret.txt",
    "note: POST /workspace/project/file.ts",
    "GET /api/rooms/:id",
    "GET  /api/rooms/:id",
    "http:request_response:GET route /opt/secret.txt",
    "http:request_response:GET  /opt/secret.txt",
  ])("rejects exact local absolute path form %s", (current) => {
    expect(verifyRenderedCoverageReport(current, current)).toEqual({
      ok: false,
      errors: [
        "generated encryption coverage report contains an absolute local path",
      ],
    });
  });

  test.each([
    "packages/Users/alice/report.md",
    "prefix/Users/alice/report.md",
    "1:\\Users\\alice\\report.md",
    "relative/home/alice/report.md",
    "packages/Volumes/work/report.md",
    "prefix/workspace/project/report.md",
    "packages/C:/work/report.md",
    "https://example.test/opt/report.md",
    "prefix\\\\fileserver\\share\\report.md",
    "prefix//fileserver/share/report.md",
    "http:request_response:DELETE /api/admin/users/:id",
    "wire:http:request_response:POST /api/messages",
    "sse:produced:GET /api/apps/events#changed",
    "sse:accepted:POST /api/profile/generate-soul/stream#soul.delta",
  ])("does not misclassify relative lookalike %s", (current) => {
    expect(verifyRenderedCoverageReport(current, current)).toEqual({ ok: true });
  });

  test("reports only drift when content differs without a path leak", () => {
    expect(verifyRenderedCoverageReport("current", "expected")).toEqual({
      ok: false,
      errors: ["generated encryption coverage report is stale"],
    });
  });

  test("reports path leakage and drift together in stable order", () => {
    expect(verifyRenderedCoverageReport("/Users/alice/current", "expected")).toEqual({
      ok: false,
      errors: [
        "generated encryption coverage report contains an absolute local path",
        "generated encryption coverage report is stale",
      ],
    });
  });
});
