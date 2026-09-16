import { describe, expect, test } from "bun:test";
import {
  AUTH_CONTRACT_VERSION,
  buildAuthContract,
  buildManagedAuthDesiredState,
  canonicalJson,
  parseAuthContract,
  serializeAuthContract,
  URI_DERIVATION_RULE_VERSION,
} from "../auth";

describe("server image auth contract", () => {
  test("is deterministic, versioned, and hashes its desired state", () => {
    const first = buildAuthContract();
    const second = buildAuthContract();

    expect(first).toEqual(second);
    expect(first.version).toBe(AUTH_CONTRACT_VERSION);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.managedDesiredStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(serializeAuthContract(first)).toBe(serializeAuthContract(second));
  });

  test("contains canonical bootstrap requirements but no generated credentials", () => {
    const contract = buildAuthContract();
    const json = serializeAuthContract(contract);
    const desiredState = contract.desiredState as {
      applications: Array<{ key: string; name: string }>;
      organizationRoles: string[];
      signInExperience: {
        forgotPassword: { connector: { connectorId: string } };
      };
    };

    expect(contract.logtoEngine.minimumVersion).toBe("1.38.0");
    expect(contract.uriDerivationRuleVersion).toBe(URI_DERIVATION_RULE_VERSION);
    expect(contract.requiredEnvKeyNames).toContain("LOGTO_M2M_APP_SECRET");
    expect(contract.requiredEnvKeyNames).toContain(
      "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET",
    );
    expect(desiredState.applications.map((app) => app.key)).toEqual([
      "workbench",
      "tui",
      "tuiLoopback",
      "desktop",
      "mobile",
      "m2m",
    ]);
    expect(desiredState.organizationRoles).toEqual([
      "owner",
      "household",
      "teammate",
      "guest",
    ]);
    expect(desiredState.signInExperience.forgotPassword.connector.connectorId).toBe(
      "http-email",
    );
    expect(json).not.toContain('"value"');
    expect(json).not.toContain("m2mAppSecret");
    expect(json).not.toContain("webhookSecret");
    expect(json).not.toContain("NAUTILO_REMOTE_PAIRING_PEPPER");
  });

  test("canonical JSON sorts object keys without reordering arrays", () => {
    expect(canonicalJson({ b: [2, 1], a: { z: true, c: null } })).toBe(
      '{"a":{"c":null,"z":true},"b":[2,1]}',
    );
    expect(buildManagedAuthDesiredState()).toEqual(
      buildAuthContract().desiredState,
    );
  });

  test("parses the contract copied from an incoming image and rejects malformed data", () => {
    const serialized = serializeAuthContract();
    expect(parseAuthContract(serialized)).toEqual(buildAuthContract());
    expect(() => parseAuthContract('{"version":1}')).toThrow(/invalid shape/);
  });
});
