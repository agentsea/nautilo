import { describe, expect, test } from "bun:test";
import {
  OPENCODE_ACP_REVIEWED_VERSION,
  OPENCODE_ACP_VERSION_OUTPUT_MAX_BYTES,
  classifyOpenCodeAcpReadiness,
  parseOpenCodeAcpVersionOutput,
  type OpenCodeAcpHostReadinessEvidence,
} from "../../src/opencode-registration.js";

const encoder = new TextEncoder();

function evidence(
  overrides: Partial<OpenCodeAcpHostReadinessEvidence> = {},
): OpenCodeAcpHostReadinessEvidence {
  return {
    executableBasename: "opencode",
    versionOutput: encoder.encode(OPENCODE_ACP_REVIEWED_VERSION),
    preflight: "passed",
    ...overrides,
  };
}

describe("OpenCode ACP registration", () => {
  test("returns only fixed safe readiness states", () => {
    expect(classifyOpenCodeAcpReadiness(evidence({ preflight: "missing", versionOutput: null }))).toEqual({
      state: "missing",
      action: "Install the reviewed OpenCode runtime on this paired desktop, then retry.",
    });
    expect(classifyOpenCodeAcpReadiness(evidence({ versionOutput: encoder.encode("1.18.17") }))).toEqual({
      state: "incompatible",
      action: "Update OpenCode to the reviewed compatible release on this paired desktop, then retry.",
    });
    expect(classifyOpenCodeAcpReadiness(evidence({ preflight: "authentication_required" }))).toEqual({
      state: "authentication_required",
      action: "Configure OpenCode through its native local setup, then retry.",
    });
    expect(classifyOpenCodeAcpReadiness(evidence({ preflight: "unavailable" }))).toEqual({
      state: "unavailable",
      action: "OpenCode is unavailable on this paired desktop. Verify its native local setup, then retry.",
    });
  });

  test("accepts only one exact bounded reviewed version", () => {
    expect(parseOpenCodeAcpVersionOutput(encoder.encode(`${OPENCODE_ACP_REVIEWED_VERSION}\n`)))
      .toBe(OPENCODE_ACP_REVIEWED_VERSION);
    expect(parseOpenCodeAcpVersionOutput(encoder.encode(`opencode ${OPENCODE_ACP_REVIEWED_VERSION}`))).toBeNull();
    expect(parseOpenCodeAcpVersionOutput(new Uint8Array(OPENCODE_ACP_VERSION_OUTPUT_MAX_BYTES + 1))).toBeNull();
    expect(parseOpenCodeAcpVersionOutput(new Uint8Array([0xff]))).toBeNull();
    expect(classifyOpenCodeAcpReadiness(evidence({
      executableBasename: "hermes" as "opencode",
    }))).toMatchObject({ state: "unavailable" });
  });
});
