import { createHash } from "node:crypto";

import { z } from "zod";

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("computer use schema digest rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) throw new Error("computer use schema digest rejects undefined values");
      target[key] = canonicalize(child);
    }
    return target;
  }
  throw new Error("computer use schema digest rejects non-JSON values");
}

export function stringifyCanonicalComputerUseSchemaJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Keep the public nullable spelling stable across schema-library upgrades. */
export function toComputerUseContractJsonSchema(schema: z.ZodType) {
  const document = z.toJSONSchema(schema);
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const json = node as Record<string, unknown>;
    const types = json["type"];
    if (Array.isArray(types) && types.length === 2 && types.includes("null")
      && types.every((type) => typeof type === "string")
      && json["anyOf"] === undefined && json["enum"] === undefined && json["const"] === undefined) {
      delete json["type"];
      json["anyOf"] = types.map((type: string) => ({ type }));
    }
    // Visit schema positions only: defaults, examples and enum/const values are data.
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
      const children = json[key];
      if (children !== null && typeof children === "object" && !Array.isArray(children)) {
        for (const child of Object.values(children)) visit(child);
      }
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      const children = json[key];
      if (Array.isArray(children)) for (const child of children) visit(child);
    }
    for (const key of ["items", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
      "contains", "propertyNames", "not", "if", "then", "else"]) visit(json[key]);
  };
  visit(document);
  return document;
}

/** Recompute a descriptor digest from schemas carried by a signed catalogue. */
export function computeComputerUseJsonSchemaDigest(
  inputJsonSchema: Readonly<Record<string, unknown>>,
  resultJsonSchema: Readonly<Record<string, unknown>>,
): `sha256:${string}` {
  const canonical = stringifyCanonicalComputerUseSchemaJson({
    input: inputJsonSchema,
    result: resultJsonSchema,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Binds one public contract descriptor to the exact input and result JSON
 * schemas consumed by both the signed Host and server catalogue.
 */
export function computeComputerUseSchemaDigest(
  inputSchema: z.ZodType,
  resultSchema: z.ZodType,
): `sha256:${string}` {
  return computeComputerUseJsonSchemaDigest(
    toComputerUseContractJsonSchema(inputSchema),
    toComputerUseContractJsonSchema(resultSchema),
  );
}
