import { describe, expect, test } from "bun:test";
import {
  HERMES_ACP_REVIEWED_VERSION,
  HERMES_ACP_VERSION_OUTPUT_MAX_BYTES,
  classifyHermesAcpReadiness,
  parseHermesAcpVersionOutput,
  type HermesAcpHostReadinessEvidence,
} from "../../src/hermes-registration.js";

const encoder = new TextEncoder();

function evidence(
  overrides: Partial<HermesAcpHostReadinessEvidence> = {},
): HermesAcpHostReadinessEvidence {
  return {
    executableBasename: "hermes",
    versionOutput: encoder.encode(HERMES_ACP_REVIEWED_VERSION),
    preflight: "passed",
    ...overrides,
  };
}

describe("Hermes ACP registration", () => {
  test("returns only actionable safe missing, incompatible, authentication-required, and unavailable states", () => {
    expect(classifyHermesAcpReadiness(evidence({ preflight: "missing", versionOutput: null }))).toEqual({
      state: "missing",
      action: "Install the reviewed Hermes runtime on this paired desktop, then retry.",
    });
    expect(classifyHermesAcpReadiness(evidence({ versionOutput: encoder.encode("0.20.1") }))).toEqual({
      state: "incompatible",
      action: "Update Hermes to the reviewed compatible release on this paired desktop, then retry.",
    });
    expect(classifyHermesAcpReadiness(evidence({ preflight: "authentication_required" }))).toEqual({
      state: "authentication_required",
      action: "Sign in to Hermes through its native local setup, then retry.",
    });
    expect(classifyHermesAcpReadiness(evidence({ preflight: "unavailable" }))).toEqual({
      state: "unavailable",
      action: "Hermes is unavailable on this paired desktop. Verify its native local setup, then retry.",
    });
  });

  test("accepts one bounded exact reviewed version and rejects malformed or excess native output", () => {
    expect(parseHermesAcpVersionOutput(encoder.encode(`${HERMES_ACP_REVIEWED_VERSION}\n`)))
      .toBe(HERMES_ACP_REVIEWED_VERSION);
    expect(parseHermesAcpVersionOutput(encoder.encode(`\n${HERMES_ACP_REVIEWED_VERSION}\n`))).toBeNull();
    expect(parseHermesAcpVersionOutput(encoder.encode(`Hermes ${HERMES_ACP_REVIEWED_VERSION}`))).toBeNull();
    expect(parseHermesAcpVersionOutput(new Uint8Array(HERMES_ACP_VERSION_OUTPUT_MAX_BYTES + 1))).toBeNull();
    expect(parseHermesAcpVersionOutput(new Uint8Array([0xff]))).toBeNull();
    expect(classifyHermesAcpReadiness(evidence({
      executableBasename: "opencode" as "hermes",
    }))).toMatchObject({ state: "unavailable" });
  });

  test("regression: previously reviewed Hermes 0.20.0 native output is rejected while exact 0.20.4 stays admitted", () => {
    const previouslyReviewed = "0.20.0";
    expect(parseHermesAcpVersionOutput(encoder.encode(previouslyReviewed))).toBeNull();
    expect(classifyHermesAcpReadiness(evidence({ versionOutput: encoder.encode(previouslyReviewed) })))
      .toMatchObject({ state: "incompatible" });
    expect(parseHermesAcpVersionOutput(encoder.encode(HERMES_ACP_REVIEWED_VERSION)))
      .toBe(HERMES_ACP_REVIEWED_VERSION);
    expect(classifyHermesAcpReadiness(evidence())).toMatchObject({ state: "ready" });
  });

});
