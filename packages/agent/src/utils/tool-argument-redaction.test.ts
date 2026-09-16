import { describe, expect, test } from "bun:test";
import {
  redactCredentialMaterialForEvent,
  sanitizeToolArgsForEvent,
} from "./tool-argument-redaction";

describe("tool telemetry argument projection", () => {
  test("covers spelling variants shared by foreground and subagent telemetry", () => {
    const source = {
      sessionToken: "session-secret",
      request: {
        refresh_token: "refresh-secret",
        "X-API-Key": "api-secret",
        ownerPIN: "pin-secret",
        operation: "inspect",
      },
    };
    const before = structuredClone(source);
    const safe = sanitizeToolArgsForEvent(source);

    expect(safe).toEqual({
      sessionToken: "[REDACTED TOOL ARG]",
      request: {
        refresh_token: "[REDACTED TOOL ARG]",
        "X-API-Key": "[REDACTED TOOL ARG]",
        ownerPIN: "[REDACTED TOOL ARG]",
        operation: "inspect",
      },
    });
    expect(source).toEqual(before);
  });

  test("bounds the aggregate projection across wide nested trees", () => {
    const wide = (depth: number): Record<string, unknown> => depth === 0
      ? { leaf: "visible" }
      : Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [`branch-${index}`, wide(depth - 1)]),
        );

    const serialized = JSON.stringify(sanitizeToolArgsForEvent(wide(3)));
    expect(serialized.length).toBeLessThan(80_000);
    expect(serialized).toContain("[omitted]");
  });

  test("redacts opaque cursors and embedded bearer/JWT values without damaging normal prose", () => {
    const opaqueCursor = "Qm7_Na2-Xp9_Lc4-Vr8_Kd1-Zs6_Hf3-Wt5_By0-Gj7_Pe2-Ru9_Cx4";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SignatureAbC123456789";
    const projected = sanitizeToolArgsForEvent({
      cursor: opaqueCursor,
      detail: `Bearer Ab3_Cd4-Ef5_Gh6-Ij7_Kl8-Mn9_Op0-Qr1_St2 ${jwt}`,
      prose: "Inspect the next page.",
      documentId: opaqueCursor,
      path: `/workspace/${opaqueCursor}/design.svg`,
      sha256: "a".repeat(64),
    });
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(jwt);
    expect(projected).toMatchObject({
      cursor: "[REDACTED TOOL ARG]",
      prose: "Inspect the next page.",
      documentId: opaqueCursor,
      path: `/workspace/${opaqueCursor}/design.svg`,
      sha256: "a".repeat(64),
    });
    expect(serialized).toContain(opaqueCursor);
    expect(redactCredentialMaterialForEvent("page:2")).toBe("page:2");
  });
});
