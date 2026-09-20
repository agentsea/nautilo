import { validate, type Schema } from "@cfworker/json-schema";
import schemas from "./native-compatibility.json";

/**
 * Released native.observe v9 / native.do v11 schemas. Keep their exact public
 * bytes while the value/collection contracts roll out independently. These are
 * executable compatibility contracts, not reconstructed version aliases.
 */
export const NATIVE_COMPATIBILITY_SCHEMAS = schemas.schemas;
/** Frozen pre-advertisement baseline. New families must not silently enter it. */
export const COMPUTER_USE_COMPATIBILITY_BASELINE = schemas.baseline;

export function validateNativeCompatibility(value: unknown, schema: object): boolean {
  return validate(value, structuredClone(schema) as Schema).valid;
}

/** New observation evidence must not leak into a strict older result schema. */
export function projectNativeCompatibilityResult(value: Readonly<Record<string, unknown>>) {
  const result = { ...value };
  delete result["controlCollection"];
  if (result["element"] && typeof result["element"] === "object" && !Array.isArray(result["element"])) {
    const element = { ...result["element"] as Record<string, unknown> };
    delete element["state"];
    result["element"] = element;
  }
  return result;
}
