/**
 * PR-017 MINOR #2 — runtime shape validation regression lock for
 * `createSandboxFromEnvelope` + `validateSandboxEnvelope`.
 *
 * The envelope arrives over the relay WebSocket as parsed JSON.
 * Without runtime shape validation, a protocol-drift bug (new
 * server adds a required field, old relay deployed; or an
 * agent-controlled value sneaks into the envelope path) silently
 * passes a malformed config to `Sandbox.create` which then either
 * crashes later or configures the sandbox with a truncated deny
 * set.
 *
 * These tests pin the validator's contract:
 *   - Throws `SandboxEnvelopeValidationError` (not a plain Error
 *     — both relay handlers can discriminate).
 *   - Throws with a SPECIFIC field-level issue message (so the
 *     operator debugging can identify which relay build to update).
 *   - Accepts all valid shapes the three deployment profiles emit.
 *   - Rejects each missing-required-field case + each wrong-type
 *     case that a drifted protocol could produce.
 */

import { describe, test, expect } from "bun:test";
import {
  validateSandboxEnvelope,
  SandboxEnvelopeValidationError,
  type SandboxEnvelopeLike,
} from "../../src/from-envelope";

const VALID_ENVELOPE: SandboxEnvelopeLike = {
  workspace: "/tmp/test-workspace",
  dataDir: "/tmp/test-data",
  toolsBin: "/tmp/test-tools",
  failIfNoBackend: true,
  config: {
    mode: "enabled",
    writablePaths: ["/tmp/test-writable"],
    projectPaths: [],
    readOnlyPaths: ["/Users/test"],
    passthroughEnv: [],
  },
};

describe("validateSandboxEnvelope — happy paths", () => {
  test("canonical valid envelope passes and returns the same shape", () => {
    const out = validateSandboxEnvelope(VALID_ENVELOPE);
    expect(out).toEqual(VALID_ENVELOPE);
  });

  test("readOnlyPaths omitted is valid (desktop-locked profile shape)", () => {
    const envelope = {
      ...VALID_ENVELOPE,
      config: {
        mode: "enabled" as const,
        writablePaths: [] as const,
        projectPaths: [] as const,
        passthroughEnv: [] as const,
      },
    };
    expect(() => validateSandboxEnvelope(envelope)).not.toThrow();
  });

  test("protectedPaths is valid when supplied as a string array", () => {
    const envelope = {
      ...VALID_ENVELOPE,
      config: {
        ...VALID_ENVELOPE.config,
        protectedPaths: ["/Users/test/.ssh", "/etc/shadow"],
      },
    };
    expect(validateSandboxEnvelope(envelope)).toEqual(envelope);
  });

  test("failIfNoBackend=false is valid (desktop-permissive shape)", () => {
    expect(() =>
      validateSandboxEnvelope({ ...VALID_ENVELOPE, failIfNoBackend: false }),
    ).not.toThrow();
  });

  test("mode=disabled is valid (server posture with sandbox off)", () => {
    const envelope = {
      ...VALID_ENVELOPE,
      config: { ...VALID_ENVELOPE.config, mode: "disabled" as const },
    };
    expect(() => validateSandboxEnvelope(envelope)).not.toThrow();
  });

  test("networkPolicy is valid when present (D103 wire-format plumbing)", () => {
    const envelope: SandboxEnvelopeLike = {
      ...VALID_ENVELOPE,
      config: {
        ...VALID_ENVELOPE.config,
        networkPolicy: {
          mode: "proxy-allowlist",
          allow: [
            { type: "domain", host: "api.openai.com" },
            { type: "wildcard", suffix: "github.com", ports: [443] },
            { type: "cidr", cidr: "192.168.1.0/24" },
          ],
        },
      },
    };
    expect(validateSandboxEnvelope(envelope)).toEqual(envelope);
  });
});

describe("validateSandboxEnvelope — rejection cases", () => {
  test("rejects malformed protectedPaths", () => {
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        config: { ...VALID_ENVELOPE.config, protectedPaths: ["/tmp/ok", 1] },
      }),
    ).toThrow(/protectedPaths/);
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        config: { ...VALID_ENVELOPE.config, protectedPaths: ["relative/path"] },
      }),
    ).toThrow(/protectedPaths/);
  });

  test("rejects null", () => {
    expect(() => validateSandboxEnvelope(null)).toThrow(
      SandboxEnvelopeValidationError,
    );
    expect(() => validateSandboxEnvelope(null)).toThrow(/expected object/);
  });

  test("rejects primitive strings / numbers", () => {
    expect(() => validateSandboxEnvelope("not-an-envelope")).toThrow(
      SandboxEnvelopeValidationError,
    );
    expect(() => validateSandboxEnvelope(42)).toThrow(
      SandboxEnvelopeValidationError,
    );
  });

  test("rejects missing workspace", () => {
    const { workspace: _ignore, ...rest } = VALID_ENVELOPE;
    expect(() => validateSandboxEnvelope(rest)).toThrow(/workspace/);
  });

  test("rejects empty-string workspace (drift symptom — field present but blank)", () => {
    expect(() =>
      validateSandboxEnvelope({ ...VALID_ENVELOPE, workspace: "" }),
    ).toThrow(/workspace/);
  });

  test("rejects missing dataDir", () => {
    const { dataDir: _ignore, ...rest } = VALID_ENVELOPE;
    expect(() => validateSandboxEnvelope(rest)).toThrow(/dataDir/);
  });

  test("rejects missing toolsBin", () => {
    const { toolsBin: _ignore, ...rest } = VALID_ENVELOPE;
    expect(() => validateSandboxEnvelope(rest)).toThrow(/toolsBin/);
  });

  test("rejects missing failIfNoBackend — the paranoid-contract carrier", () => {
    const { failIfNoBackend: _ignore, ...rest } = VALID_ENVELOPE;
    expect(() => validateSandboxEnvelope(rest)).toThrow(/failIfNoBackend/);
  });

  test("rejects non-boolean failIfNoBackend (e.g. stringified 'true' from a broken serializer)", () => {
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        failIfNoBackend: "true" as unknown as boolean,
      }),
    ).toThrow(/failIfNoBackend/);
  });

  test("rejects missing config", () => {
    const { config: _ignore, ...rest } = VALID_ENVELOPE;
    expect(() => validateSandboxEnvelope(rest)).toThrow(/config/);
  });

  test("rejects non-object config", () => {
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        config: "not-a-config" as unknown as SandboxEnvelopeLike["config"],
      }),
    ).toThrow(/config/);
  });

  test("rejects config.mode out of enum", () => {
    const envelope = {
      ...VALID_ENVELOPE,
      config: {
        ...VALID_ENVELOPE.config,
        mode: "paranoid" as unknown as "enabled",
      },
    };
    expect(() => validateSandboxEnvelope(envelope)).toThrow(/config\.mode/);
  });

  test("rejects config.writablePaths as non-array", () => {
    const envelope = {
      ...VALID_ENVELOPE,
      config: {
        ...VALID_ENVELOPE.config,
        writablePaths: "/tmp/writable" as unknown as readonly string[],
      },
    };
    expect(() => validateSandboxEnvelope(envelope)).toThrow(/writablePaths/);
  });

  test("rejects config.writablePaths array with non-string element", () => {
    const envelope = {
      ...VALID_ENVELOPE,
      config: {
        ...VALID_ENVELOPE.config,
        writablePaths: ["/tmp/ok", 42] as unknown as readonly string[],
      },
    };
    expect(() => validateSandboxEnvelope(envelope)).toThrow(/writablePaths/);
  });

  test("rejects config.projectPaths with wrong element type", () => {
    const envelope = {
      ...VALID_ENVELOPE,
      config: {
        ...VALID_ENVELOPE.config,
        projectPaths: [null] as unknown as readonly string[],
      },
    };
    expect(() => validateSandboxEnvelope(envelope)).toThrow(/projectPaths/);
  });

  test("rejects config.readOnlyPaths non-array (but absent is valid)", () => {
    const envelope = {
      ...VALID_ENVELOPE,
      config: {
        ...VALID_ENVELOPE.config,
        readOnlyPaths: "/Users" as unknown as readonly string[],
      },
    };
    expect(() => validateSandboxEnvelope(envelope)).toThrow(/readOnlyPaths/);
  });

  test("rejects malformed networkPolicy", () => {
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        config: {
          ...VALID_ENVELOPE.config,
          networkPolicy: { mode: "proxy-allowlist", allow: "api.openai.com" },
        },
      }),
    ).toThrow(/networkPolicy\.allow/);
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        config: {
          ...VALID_ENVELOPE.config,
          networkPolicy: {
            mode: "proxy-allowlist",
            allow: [{ type: "domain", ports: [443] }],
          },
        },
      }),
    ).toThrow(/host is required/);
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        config: {
          ...VALID_ENVELOPE.config,
          networkPolicy: {
            mode: "proxy-allowlist",
            defaultPort: 80,
            allow: [],
          },
        },
      }),
    ).toThrow(/defaultPort/);
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        config: {
          ...VALID_ENVELOPE.config,
          networkPolicy: {
            mode: "isolated",
            allow: [],
          },
        },
      }),
    ).toThrow(/must not include/);
    expect(() =>
      validateSandboxEnvelope({
        ...VALID_ENVELOPE,
        config: {
          ...VALID_ENVELOPE.config,
          networkPolicy: {
            mode: "proxy-allowlist",
            allow: [{ type: "domain", host: "api.openai.com", ports: [] }],
          },
        },
      }),
    ).toThrow(/ports must not be empty/);
  });
});

describe("SandboxEnvelopeValidationError discriminator", () => {
  test("thrown error instanceof SandboxEnvelopeValidationError (relay handlers discriminate via instanceof)", () => {
    try {
      validateSandboxEnvelope({});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxEnvelopeValidationError);
    }
  });

  test("error message contains 'Sandbox envelope rejected:' prefix (for log greppability)", () => {
    try {
      validateSandboxEnvelope({});
    } catch (e) {
      expect((e as Error).message).toMatch(/^Sandbox envelope rejected:/);
    }
  });

  test("error name is 'SandboxEnvelopeValidationError' (serializable across worker boundaries)", () => {
    try {
      validateSandboxEnvelope({});
    } catch (e) {
      expect((e as Error).name).toBe("SandboxEnvelopeValidationError");
    }
  });
});
