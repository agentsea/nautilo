import { describe, test, expect } from "bun:test";
import { resolveSecurityLayers, type SecurityLevel } from "../../src/security-config";

describe("resolveSecurityLayers", () => {
  test("yolo disables everything", () => {
    const layers = resolveSecurityLayers("yolo");
    expect(layers.commandScanning).toBe(false);
    expect(layers.pathDeny).toBe(false);
    expect(layers.contentScanning).toBe(false);
  });

  test("permissive enables only path deny", () => {
    const layers = resolveSecurityLayers("permissive");
    expect(layers.commandScanning).toBe(false);
    expect(layers.pathDeny).toBe(true);
    expect(layers.contentScanning).toBe(false);
  });

  test("standard enables command scanning + path deny + content scanning", () => {
    const layers = resolveSecurityLayers("standard");
    expect(layers.commandScanning).toBe(true);
    expect(layers.pathDeny).toBe(true);
    expect(layers.contentScanning).toBe(true);
  });

  test("cautious has same layers as standard (stubs not yet implemented)", () => {
    const standard = resolveSecurityLayers("standard");
    const cautious = resolveSecurityLayers("cautious");
    expect(cautious).toEqual(standard);
  });

  test("paranoid has same layers as standard (stubs not yet implemented)", () => {
    const standard = resolveSecurityLayers("standard");
    const paranoid = resolveSecurityLayers("paranoid");
    expect(paranoid).toEqual(standard);
  });

  test("all levels have ast/subagent/sandbox disabled (future)", () => {
    const levels: SecurityLevel[] = ["yolo", "permissive", "standard", "cautious", "paranoid"];
    for (const level of levels) {
      const layers = resolveSecurityLayers(level);
      expect(layers.ast).toBe(false);
      expect(layers.subagent).toBe(false);
      expect(layers.sandbox).toBe(false);
    }
  });
});
