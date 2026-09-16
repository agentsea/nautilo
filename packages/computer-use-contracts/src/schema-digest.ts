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
    z.toJSONSchema(inputSchema),
    z.toJSONSchema(resultSchema),
  );
}
