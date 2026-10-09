import { validate, type Schema } from "@cfworker/json-schema";
import schemas from "./native-compatibility.json";
import observeV11 from "./native-observe-v11.json";
import observeV12 from "./native-observe-v12.json";
import doV13 from "./native-do-v13.json";

/**
 * Released native.observe v9/v11/v12 and native.do v11/v13 schemas. Keep their exact public
 * bytes while the value/collection contracts roll out independently. These are
 * executable compatibility contracts, not reconstructed version aliases.
 */
export const NATIVE_COMPATIBILITY_SCHEMAS = [...schemas.schemas, observeV11, doV13, observeV12];
/** Frozen pre-advertisement baseline. New families must not silently enter it. */
export const COMPUTER_USE_COMPATIBILITY_BASELINE = schemas.baseline;

export function validateNativeCompatibility(value: unknown, schema: object): boolean {
  return validate(value, structuredClone(schema) as Schema).valid;
}

/** New observation evidence must not leak into a strict older result schema. */
export function projectNativeCompatibilityResult(value: Readonly<Record<string, unknown>>, descriptor?: { contractId: string; contractVersion: number }) {
  const result = { ...value };
  if (descriptor?.contractId === "native.observe") {
    delete result["failureCode"];
    delete result["failureDetail"];
    if (descriptor.contractVersion === 12) return result;
  }
  if (descriptor?.contractId === "native.do") delete result["failureDetail"];
  if (descriptor?.contractId === "native.observe" && descriptor.contractVersion === 11) {
    const collection = result["controlCollection"];
    if (collection && typeof collection === "object" && !Array.isArray(collection)) {
      const projected = { ...collection as Record<string, unknown> };
      if (Array.isArray(projected["controls"])) projected["controls"] = projected["controls"].map((control: Record<string, unknown>) => {
        const retained = { ...control };
        delete retained["actions"];
        delete retained["depth"];
        delete retained["frame"];
        return retained;
      });
      result["controlCollection"] = projected;
    }
    return result;
  }
  delete result["controlCollection"];
  if (result["element"] && typeof result["element"] === "object" && !Array.isArray(result["element"])) {
    const element = { ...result["element"] as Record<string, unknown> };
    delete element["state"];
    result["element"] = element;
  }
  return result;
}
