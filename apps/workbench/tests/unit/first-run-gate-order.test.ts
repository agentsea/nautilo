/**
 * D112 — M071 ordering: `FirstRunGate` wraps `AuthGate` so setup cards can
 * render before Logto session resolution.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("FirstRunGate ordering (D112 / M071)", () => {
  test("AppShell nests FirstRunGate outside AuthGate", () => {
    const path = join(import.meta.dir, "../../src/app.tsx");
    const src = readFileSync(path, "utf8");
    const iFirst = src.indexOf("<FirstRunGate>");
    const iAuth = src.indexOf("<AuthGate>");
    expect(iFirst).toBeGreaterThan(-1);
    expect(iAuth).toBeGreaterThan(-1);
    expect(iFirst).toBeLessThan(iAuth);
    const iFirstClose = src.indexOf("</FirstRunGate>");
    const iAuthClose = src.indexOf("</AuthGate>");
    expect(iAuthClose).toBeGreaterThan(-1);
    expect(iFirstClose).toBeGreaterThan(-1);
    expect(iAuthClose).toBeLessThan(iFirstClose);
  });

  test("M303 admission wraps every protected Workbench provider", () => {
    const path = join(import.meta.dir, "../../src/app.tsx");
    const src = readFileSync(path, "utf8");
    const admissionOpen = src.indexOf("<CryptoDeviceAdmissionGate>");
    const firstProtectedProvider = src.indexOf("<InstalledAppsProvider>");
    const runtimeProvider = src.indexOf("<NautiloRuntimeProvider>");
    const admissionClose = src.indexOf("</CryptoDeviceAdmissionGate>");
    expect(admissionOpen).toBeGreaterThan(-1);
    expect(firstProtectedProvider).toBeGreaterThan(admissionOpen);
    expect(runtimeProvider).toBeGreaterThan(admissionOpen);
    expect(admissionClose).toBeGreaterThan(runtimeProvider);
  });
});
