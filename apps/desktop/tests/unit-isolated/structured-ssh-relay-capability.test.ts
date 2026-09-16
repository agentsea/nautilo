import { beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRelayStructuredSshReadiness } from "@nautilo/relay";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-d500-capability-userdata" },
}));

let resolveStructuredSshReadiness: typeof import("../../electron/relay-dispatch/structured-ssh").resolveStructuredSshReadiness;

beforeAll(async () => {
  ({
    resolveStructuredSshReadiness,
  } = await import("../../electron/relay-dispatch/structured-ssh"));
});

const enabled = {
  version: 1 as const,
  state: "enabled" as const,
  provider: "openssh" as const,
  ssh: "observed" as const,
  scp: "observed" as const,
  auth: true,
  exec: true,
  upload: true,
  download: true,
};

describe("D500 structured SSH relay readiness capability", () => {
  test("projects strict available and unavailable state without secret-bearing fields", async () => {
    const projected = await resolveStructuredSshReadiness({
      probeReadiness: async () => enabled,
    });
    expect(parseRelayStructuredSshReadiness(projected)).toEqual({
      ok: true,
      readiness: enabled,
    });
    expect(Object.keys(projected).sort()).toEqual([
      "auth", "download", "exec", "provider", "scp", "ssh", "state", "upload", "version",
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/SSH_AUTH_SOCK|privateKey|publicKey|fingerprint|host|user|path|cwd|folder/i);

    expect(await resolveStructuredSshReadiness({
      probeReadiness: async () => { throw new Error("/private/tmp/agent.sock host.example"); },
    })).toEqual({
      version: 1,
      state: "unavailable",
      provider: "openssh",
      ssh: "unavailable",
      scp: "unavailable",
    });
  });

  test("initial registration and reconnect share the live builder and do not involve Current Folder", () => {
    const source = readFileSync(join(import.meta.dir, "../../electron/relay.ts"), "utf8");
    const builderStart = source.indexOf("const capabilitiesBuilder = async (): Promise<RelayCapabilities> =>");
    const builderEnd = source.indexOf("const candidateMcpHost = createRelayMcpHost", builderStart);
    const builder = source.slice(builderStart, builderEnd);
    expect(builder).toContain("await resolveMovedStructuredSshReadiness(structuredSshRuntime)");
    expect(builder).toContain("...(structuredSsh !== undefined ? { structuredSsh } : {})");

    const clientStart = source.indexOf("const candidateClient = createDesktopRelaySidecarClient({", builderEnd);
    const clientEnd = source.indexOf("onDispatch: makeDispatchHandler", clientStart);
    const registration = source.slice(clientStart, clientEnd);
    expect(source).toContain("const initialCapabilities = await capabilitiesBuilder()");
    expect(registration).toContain("capabilities: initialCapabilities");
    expect(registration).toContain("getCapabilities: capabilitiesBuilder");
    expect(source).toContain("getCapabilityRevision: getSessionAcknowledgedCapabilityRevision");
    expect(source).toContain("sessionClient?.getAcknowledgedCapabilityRevision() ?? -1");

    const resolver = readFileSync(join(import.meta.dir, "../../electron/relay-dispatch/structured-ssh.ts"), "utf8");
    expect(resolver).not.toMatch(/currentFolder|cwd/i);
  });
});
