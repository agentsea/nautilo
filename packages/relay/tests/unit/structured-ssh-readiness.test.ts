import { describe, expect, it } from "bun:test";
import {
  parseRelayStructuredSshReadiness,
  RELAY_STRUCTURED_SSH_READINESS_VERSION,
} from "../../src";

describe("structured SSH readiness", () => {
  it("accepts and rebuilds the exact enabled projection", () => {
    const input = {
      version: 1,
      state: "enabled",
      provider: "openssh",
      ssh: "observed",
      scp: "unavailable",
      auth: true,
      exec: false,
      upload: true,
      download: false,
    };

    const parsed = parseRelayStructuredSshReadiness(input);

    expect(parsed).toEqual({
      ok: true,
      readiness: {
        version: RELAY_STRUCTURED_SSH_READINESS_VERSION,
        state: "enabled",
        provider: "openssh",
        ssh: "observed",
        scp: "unavailable",
        auth: true,
        exec: false,
        upload: true,
        download: false,
      },
    });
    if (parsed.ok) expect(parsed.readiness).not.toBe(input);
  });

  it("accepts unavailable and not-enabled projections without operation booleans", () => {
    expect(
      parseRelayStructuredSshReadiness({
        version: 1,
        state: "unavailable",
        provider: "openssh",
        ssh: "unavailable",
        scp: "observed",
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseRelayStructuredSshReadiness({
        version: 1,
        state: "unavailable",
        provider: "openssh",
        ssh: "observed",
        scp: "observed",
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseRelayStructuredSshReadiness({
        version: 1,
        state: "not-enabled",
        provider: "openssh",
        ssh: "observed",
        scp: "unavailable",
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    { version: 1, state: "enabled", provider: "openssh", ssh: "observed", scp: "observed", auth: true, exec: true, upload: true },
    { version: 1, state: "enabled", provider: "openssh", ssh: "unavailable", scp: "observed", auth: true, exec: true, upload: true, download: true },
    { version: 1, state: "not-enabled", provider: "openssh", ssh: "unavailable", scp: "observed" },
    { version: 1, state: "not-enabled", provider: "openssh", ssh: "observed", scp: "observed", auth: false },
    { version: 1, state: "enabled", provider: "system-agent", ssh: "observed", scp: "observed", auth: true, exec: true, upload: true, download: true },
    { version: 1, state: "enabled", provider: "openssh", ssh: "observed", scp: "observed", auth: true, exec: true, upload: true, download: true, privateKey: "no" },
  ])("rejects malformed or expanded projections", (input) => {
    expect(parseRelayStructuredSshReadiness(input).ok).toBe(false);
  });
});
