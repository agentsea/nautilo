import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ComposeDriverProfile } from "@nautilo/compose-driver";
import { localInstanceRootDir } from "@nautilo/compose-driver";

import {
  bootstrapTokenPath,
  readBootstrapToken,
} from "../../src/lib/bootstrap-tokens.ts";
import { ensureBootstrapToken } from "../../src/lib/compose-driver-factory.ts";

let fakeHome: string;

const remoteProfile: ComposeDriverProfile = {
  name: "do-droplet-1",
  transport: "remote",
  lifecycle: "compose",
  instance_id: "prod",
  from_source: true,
  ssh: { host: "1.2.3.4", user: "root" },
};

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "nautilo-ebt-"));
});

afterEach(() => {
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe("ensureBootstrapToken", () => {
  test("first call writes bootstrap-tokens file and instance.env; second call is idempotent", () => {
    const tokenPath = bootstrapTokenPath(remoteProfile.name, fakeHome);
    const envPath = join(
      localInstanceRootDir(fakeHome, remoteProfile.instance_id),
      "instance.env",
    );

    const first = ensureBootstrapToken(remoteProfile, fakeHome);
    expect(first.length).toBeGreaterThan(0);
    expect(readBootstrapToken(remoteProfile.name, { home: fakeHome })).toBe(first);
    expect(readFileSync(envPath, "utf8")).toContain(`NAUTILO_BOOTSTRAP_TOKEN=${first}`);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    const envAfterFirst = readFileSync(envPath, "utf8");
    const second = ensureBootstrapToken(remoteProfile, fakeHome);
    expect(second).toBe(first);
    expect(readFileSync(envPath, "utf8")).toBe(envAfterFirst);
    expect(
      readFileSync(envPath, "utf8").match(/NAUTILO_BOOTSTRAP_TOKEN=/g)?.length,
    ).toBe(1);
  });

  test("replaces existing NAUTILO_BOOTSTRAP_TOKEN line when bootstrap-tokens file is missing", () => {
    const instanceRoot = localInstanceRootDir(fakeHome, remoteProfile.instance_id);
    mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
    const envPath = join(instanceRoot, "instance.env");
    writeFileSync(
      envPath,
      "FOO=bar\nNAUTILO_BOOTSTRAP_TOKEN=oldvalue\nBAR=baz\n",
      { mode: 0o600 },
    );

    const token = ensureBootstrapToken(remoteProfile, fakeHome);
    expect(token).not.toBe("oldvalue");
    const body = readFileSync(envPath, "utf8");
    expect(body).toContain(`NAUTILO_BOOTSTRAP_TOKEN=${token}`);
    expect(body).not.toContain("NAUTILO_BOOTSTRAP_TOKEN=oldvalue");
    expect(body.match(/NAUTILO_BOOTSTRAP_TOKEN=/g)?.length).toBe(1);
    expect(readBootstrapToken(remoteProfile.name, { home: fakeHome })).toBe(token);
    expect(existsSync(bootstrapTokenPath(remoteProfile.name, fakeHome))).toBe(true);
  });

  test("restores instance.env after the instance root is recreated", () => {
    const first = ensureBootstrapToken(remoteProfile, fakeHome);
    const instanceRoot = localInstanceRootDir(fakeHome, remoteProfile.instance_id);
    rmSync(instanceRoot, { recursive: true, force: true });

    const second = ensureBootstrapToken(remoteProfile, fakeHome);
    const envPath = join(instanceRoot, "instance.env");

    expect(second).toBe(first);
    expect(readFileSync(envPath, "utf8")).toContain(
      `NAUTILO_BOOTSTRAP_TOKEN=${first}`,
    );
    expect(readFileSync(envPath, "utf8").match(/NAUTILO_BOOTSTRAP_TOKEN=/g)?.length).toBe(1);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });
});
