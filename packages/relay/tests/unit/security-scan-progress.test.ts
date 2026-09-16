import { expect, test } from "bun:test";
import { isSecurityScanProgress } from "../../src/security-scan-progress";

test("scanner progress admits fixed strings, never coercible values or source payloads", () => {
  expect(isSecurityScanProgress({ stage: "scanner_started", probe: "gitleaks" })).toBeTrue();
  expect(isSecurityScanProgress({ stage: "preparing_scanners" })).toBeTrue();
  expect(isSecurityScanProgress({ stage: ["preparing_scanners"] })).toBeFalse();
  expect(isSecurityScanProgress({ stage: "scanner_started", probe: ["gitleaks"] })).toBeFalse();
  expect(isSecurityScanProgress({ stage: "scanner_started" })).toBeFalse();
  expect(isSecurityScanProgress({ stage: "research_ready", probe: "gitleaks" })).toBeFalse();
  expect(isSecurityScanProgress({ stage: "scanner_started", probe: "gitleaks", source: "private text" })).toBeFalse();
});


test("inventory progress reports observed counts without claiming a total or accepting source text", () => {
  expect(isSecurityScanProgress({ stage: "inventory_progress", filesObserved: 400, directoriesObserved: 30 })).toBeTrue();
  expect(isSecurityScanProgress({ stage: "inventory_progress", filesObserved: -1, directoriesObserved: 30 })).toBeFalse();
  expect(isSecurityScanProgress({ stage: "inventory_progress", filesObserved: 400 })).toBeFalse();
  expect(isSecurityScanProgress({ stage: "inventory_progress", filesObserved: 400, directoriesObserved: 30, path: "private" })).toBeFalse();
  expect(isSecurityScanProgress({ stage: "research_ready", filesObserved: 400, directoriesObserved: 30 })).toBeFalse();
});
