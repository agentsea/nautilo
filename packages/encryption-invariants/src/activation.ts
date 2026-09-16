export type Wave0Activation = {
  readonly stage: "disabled";
};

export const DEFAULT_ENCRYPTION_ACTIVATION: Wave0Activation = Object.freeze({
  stage: "disabled",
});

export type Wave0ActivationParseResult =
  | { readonly ok: true; readonly value: Wave0Activation }
  | { readonly ok: false; readonly error: string };

export function parseWave0Activation(input: unknown): Wave0ActivationParseResult {
  if (input === undefined) {
    return { ok: true, value: DEFAULT_ENCRYPTION_ACTIVATION };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      error: "Wave 0 activation input must be an object when provided",
    };
  }

  const record = input as Record<string, unknown>;
  const unsupported = Object.keys(record)
    .filter((key) => key !== "stage")
    .sort();
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: `Wave 0 activation input contains unsupported fields: ${unsupported.join(", ")}`,
    };
  }
  if (record["stage"] !== "disabled") {
    return {
      ok: false,
      error: `Wave 0 cannot activate encryption stage: ${String(record["stage"])}`,
    };
  }
  return { ok: true, value: DEFAULT_ENCRYPTION_ACTIVATION };
}
