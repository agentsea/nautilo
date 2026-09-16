import { describe, expect, test } from "bun:test";

import type { ComposeDriver, ComposeDriverProfile } from "@nautilo/compose-driver";

import { createProductionComposeLifecycle } from "../../src/index.ts";

const profile = {
  name: "m269-factory",
  lifecycle: "compose",
  transport: "local",
  instance_id: "m269-factory",
} as ComposeDriverProfile;

describe("production lifecycle factory", () => {
  test("threads explicit target, paths, readiness, and maintenance into one driver", () => {
    const wired: string[] = [];
    const driver = {
      setReleaseActiveWorkReadiness: () => { wired.push("readiness"); },
      setMaintenanceDrain: () => { wired.push("maintenance"); },
    } as unknown as ComposeDriver;
    let receivedProfile: ComposeDriverProfile | undefined;
    let receivedOptions: Record<string, unknown> | undefined;
    const lifecycle = createProductionComposeLifecycle({
      profile,
      templateDir: "/explicit/template",
      operatorHome: "/explicit/home",
      releaseActiveWorkReadiness: async () => undefined,
      maintenanceDrain: async () => { throw new Error("not invoked"); },
      driverFactory: (targetProfile, options) => {
        receivedProfile = targetProfile;
        receivedOptions = options as unknown as Record<string, unknown>;
        return driver;
      },
    });

    expect(receivedProfile).toBe(profile);
    expect(receivedOptions).toMatchObject({
      templateDir: "/explicit/template",
      operatorHome: "/explicit/home",
    });
    expect(wired).toEqual(["readiness", "maintenance"]);
    expect(lifecycle.target.profileName).toBe(profile.name);
  });

  test("passes an absolute managed provider file to a local driver", () => {
    let receivedOptions: Record<string, unknown> | undefined;
    createProductionComposeLifecycle({
      profile,
      templateDir: "/explicit/template",
      operatorHome: "/explicit/home",
      managedServerEnvPath: "/custody/provider-g1.env",
      driverFactory: (_targetProfile, options) => {
        receivedOptions = options as unknown as Record<string, unknown>;
        return {} as ComposeDriver;
      },
    });
    expect(receivedOptions?.["managedServerEnvPath"]).toBe("/custody/provider-g1.env");
  });

  test("rejects relative managed files and remote targets before driver construction", () => {
    expect(() =>
      createProductionComposeLifecycle({
        profile,
        templateDir: "/explicit/template",
        managedServerEnvPath: "relative.env",
      }),
    ).toThrow("must be absolute");
    expect(() =>
      createProductionComposeLifecycle({
        profile: { ...profile, transport: "remote" },
        templateDir: "/explicit/template",
        managedServerEnvPath: "/custody/provider-g1.env",
      }),
    ).toThrow("only for local Compose");
  });
});
