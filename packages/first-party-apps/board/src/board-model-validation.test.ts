import { describe, expect, test } from "bun:test";
import { createBoardDocument } from "./board-document";
import {
  NativeBoardModelValidationFailure,
  assertNativeBoardModel,
  nativeBoardModelSchemaDescriptor,
  validateNativeBoardModel,
} from "./board-model-validation";

describe("source-derived native Board model validation", () => {
  test("publishes a discoverable full-model schema descriptor", () => {
    const descriptor = nativeBoardModelSchemaDescriptor();
    expect(descriptor.version).toBe(1);
    expect(descriptor.schema).toMatchObject({ $ref: "#/definitions/BoardModel" });
    expect(JSON.stringify(descriptor.schema)).toContain('"ConnectorElement"');
    expect(JSON.stringify(descriptor.schema)).toContain('"FreeformPath"');
  });

  test("reports schema errors without mutating input", () => {
    const invalid = { meta: { title: 42 }, elements: [{ type: "teleporter" }] };
    const before = JSON.stringify(invalid);
    const errors = validateNativeBoardModel(invalid);
    expect(errors.length).toBeGreaterThan(1);
    expect(errors.some((error) => error.instancePath === "/meta/title")).toBe(true);
    expect(JSON.stringify(invalid)).toBe(before);
    expect(() => assertNativeBoardModel(invalid)).toThrow(NativeBoardModelValidationFailure);
  });

  test("returns structured paths for unsafe numbers and forbidden nested keys", () => {
    const model = createBoardDocument() as unknown as Record<string, unknown>;
    model["extension"] = JSON.parse('{"nested":{"constructor":"blocked"},"number":1e400}');
    const errors = validateNativeBoardModel(model);
    expect(errors.some((error) => error.keyword === "safe-json")).toBe(true);
    expect(errors.some((error) => error.keyword === "finite-number")).toBe(true);
    expect(errors.some((error) => error.instancePath === "/extension/nested/constructor")).toBe(true);
    expect(errors.some((error) => error.instancePath === "/extension/number")).toBe(true);
  });

  test("rejects empty identities and negative frame dimensions", () => {
    const invalid = {
      meta: { title: "" },
      elements: [{ id: "", type: "shape", frame: { x: 0, y: 0, w: -1, h: 2, rotation: 0 }, data: { kind: "rect" } }],
    };
    const errors = validateNativeBoardModel(invalid);
    expect(errors.some((error) => error.keyword === "board-title")).toBe(true);
    expect(errors.some((error) => error.keyword === "element-id")).toBe(true);
    expect(errors.some((error) => error.keyword === "frame-dimensions")).toBe(true);
  });
});
