import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeployConfigFromPath } from "@nautilo/deploy-config";
import type { D508FreshBrowserAdminEvidence } from "../../src/commands/qualify-owner-claim";
import {
  assertPackagedTargetSetupStatus,
  parsePackagedTargetQualificationArgs,
  runPackagedTargetQualification,
} from "../../src/commands/qualify-packaged-target";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function protectedOwnerConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nautilo-packaged-qualifier-"));
  tmpDirs.push(dir);
  const path = join(dir, "owner.toml");
  writeFileSync(path, body);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

const adminEvidence: D508FreshBrowserAdminEvidence = {
  freshBrowserStartedSignedOut: true,
  exactServerGuideReturn: true,
  authReturnConsumed: true,
  noOwnerClaimIo: true,
  oneOidcAuthorization: true,
  configureServerLinkReachedAdmin: true,
  pinGatedPostureChangedOnce: true,
  refreshedPostureVisible: true,
};

describe("test-only packaged target qualifier", () => {
  test("requires explicit disposable opt-in, a clean loopback origin, protected path, and bounded target identity", () => {
    const accepted = parsePackagedTargetQualificationArgs([
      "--disposable",
      "--server", "http://127.0.0.1:4310/",
      "--owner-config", "/private/tmp/owner.toml",
      "--target-instance", "d508012345abcdef",
    ]);
    expect(accepted).toEqual({
      disposable: true,
      serverUrl: "http://127.0.0.1:4310",
      ownerConfigPath: "/private/tmp/owner.toml",
      targetInstanceId: "d508012345abcdef",
    });
    for (const rejected of [
      ["--server", "http://127.0.0.1:4310", "--owner-config", "/private/tmp/owner.toml", "--target-instance", "d508012345abcdef"],
      ["--disposable", "--server", "https://server.example", "--owner-config", "/private/tmp/owner.toml", "--target-instance", "d508012345abcdef"],
      ["--disposable", "--server", "http://user:pass@127.0.0.1:4310", "--owner-config", "/private/tmp/owner.toml", "--target-instance", "d508012345abcdef"],
      ["--disposable", "--server", "http://127.0.0.1:4310/claim", "--owner-config", "/private/tmp/owner.toml", "--target-instance", "d508012345abcdef"],
      ["--disposable", "--server", "http://127.0.0.1:4310", "--owner-config", "relative.toml", "--target-instance", "d508012345abcdef"],
      ["--disposable", "--server", "http://127.0.0.1:4310", "--owner-config", "/private/tmp/owner.toml", "--target-instance", "default"],
      ["--disposable", "--server", "http://127.0.0.1:4310", "--owner-config", "/private/tmp/owner.toml", "--target-instance", "d508-packaged-012345abcdef"],
      ["--disposable", "--server", "http://127.0.0.1:4310", "--owner-config", "/private/tmp/owner.toml", "--target-instance", "d508012345abcde"],
    ]) {
      expect(() => parsePackagedTargetQualificationArgs(rejected)).toThrow("invalid_arguments");
    }
  });

  test("uses the protected parser and checks authoritative target identity immediately before the only PIN mutation", async () => {
    const ownerConfigPath = protectedOwnerConfig(`schemaVersion = 1
[admin]
handle = "test-owner"
displayName = "Test Owner"
password = { value = "private-test-password" }
pin = { value = "123456" }
`);
    const args = parsePackagedTargetQualificationArgs([
      "--disposable",
      "--server", "http://localhost:4310",
      "--owner-config", ownerConfigPath,
      "--target-instance", "d508012345abcdef",
    ]);
    const order: string[] = [];
    let setupStatusChecks = 0;
    const receipt = await runPackagedTargetQualification(args, {
      loadDeployConfig: (path) => {
        order.push("protected-config");
        return parseDeployConfigFromPath(path);
      },
      fetchSetupStatus: async () => {
        setupStatusChecks += 1;
        order.push(`setup-status-${setupStatusChecks}`);
        return {
          status: 200,
          json: async () => ({ instanceId: "d508012345abcdef", setupState: "claimed-needs-auth", claimRequired: false }),
        };
      },
      runFreshBrowserAdmin: async (input) => {
        order.push("browser-before-pin");
        await input.beforePinMutation?.();
        order.push("pin-mutation");
        return { requests: [], navigations: [], evidence: adminEvidence };
      },
    });
    expect(order).toEqual(["setup-status-1", "protected-config", "browser-before-pin", "setup-status-2", "pin-mutation"]);
    expect(receipt).toEqual({
      outcome: "passed",
      qualifier: "packaged-target-browser",
      evidence: {
        explicitDisposableOptIn: true,
        loopbackCredentialFreeOrigin: true,
        protectedOwnerConfigResolvedWithoutEnvironment: true,
        setupStatusMatchedDisposableInstanceBeforePinMutation: true,
        freshBrowserAdmin: adminEvidence,
      },
      requests: [],
      navigations: [],
    });
    expect(JSON.stringify(receipt)).not.toContain("private-test-password");
    expect(JSON.stringify(receipt)).not.toContain("123456");
    expect(JSON.stringify(receipt)).not.toContain("test-owner");
  });

  test("rejects a setup-status mismatch before the browser can perform the PIN mutation", async () => {
    const args = parsePackagedTargetQualificationArgs([
      "--disposable",
      "--server", "http://127.0.0.1:4310",
      "--owner-config", "/private/tmp/owner.toml",
      "--target-instance", "d508012345abcdef",
    ]);
    let pinMutationReached = false;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(runPackagedTargetQualification(args, {
      loadDeployConfig: () => ({} as never),
      resolveSecrets: () => ({} as never),
      planAdmin: () => ({
        handle: "test-owner", displayName: "Test Owner", password: "private-test-password", pin: "123456",
      }),
      fetchSetupStatus: async () => ({ status: 200, json: async () => ({ instanceId: "d508fedcba987654", setupState: "claimed-needs-auth", claimRequired: false }) }),
      runFreshBrowserAdmin: async (input) => {
        await input.beforePinMutation?.();
        pinMutationReached = true;
        return { requests: [], navigations: [], evidence: adminEvidence };
      },
    })).rejects.toThrow("setup_status");
    expect(pinMutationReached).toBeFalse();
  });

  test("cannot bypass the disposable opt-in or normalized loopback target by calling the harness directly", async () => {
    const bypassed = {
      disposable: false,
      serverUrl: "https://server.example",
      ownerConfigPath: "/private/tmp/owner.toml",
      targetInstanceId: "d508012345abcdef",
    } as unknown as Parameters<typeof runPackagedTargetQualification>[0];
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(runPackagedTargetQualification(bypassed)).rejects.toThrow("invalid_arguments");
  });

  test("setup-status accepts only the exact anonymous owner-bound disposable identity and retains no response body", () => {
    const valid = { instanceId: "d508012345abcdef", setupState: "claimed-needs-auth", claimRequired: false };
    expect(() => assertPackagedTargetSetupStatus(valid, "d508012345abcdef")).not.toThrow();
    expect(() => assertPackagedTargetSetupStatus({ ...valid, instanceId: "d508fedcba987654" }, "d508012345abcdef")).toThrow("setup_status");
    for (const setupState of ["ready", "fresh-unclaimed", "server-needs-keys"]) {
      expect(() => assertPackagedTargetSetupStatus({ ...valid, setupState }, "d508012345abcdef")).toThrow("setup_status");
    }
    expect(() => assertPackagedTargetSetupStatus({ ...valid, claimRequired: true }, "d508012345abcdef")).toThrow("setup_status");
  });
});
