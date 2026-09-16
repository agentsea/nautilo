/**
 * M092 Step 6 — `getArtifactsRoot` instance-suffix awareness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getAppsRoot, getArtifactsRoot, getMediaStorageRoot, getProfileAvatarsRoot, getServerIconRoot } from "../../src/instance-defaults";
import { resolveNautiloRootDir } from "../../src/runtime-paths";

const HOME = "/tmp/nautilo-artifacts-test-home";

function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prior: Record<string, string | undefined> = {};
  for (const key of [
    "NAUTILO_INSTANCE_ID",
    "NAUTILO_ARTIFACTS_ROOT",
    "NAUTILO_MEDIA_ROOT",
    "HOME",
    "USERPROFILE",
  ]) {
    prior[key] = process.env[key];
  }
  process.env["HOME"] = HOME;
  process.env["USERPROFILE"] = HOME;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => {
  delete process.env["NAUTILO_INSTANCE_ID"];
  delete process.env["NAUTILO_ARTIFACTS_ROOT"];
  delete process.env["NAUTILO_MEDIA_ROOT"];
});

describe("getArtifactsRoot — M092 instance suffix", () => {
  test('NAUTILO_INSTANCE_ID="" → ~/.nautilo/artifacts', () => {
    withEnv({ NAUTILO_INSTANCE_ID: "" }, () => {
      const root = resolveNautiloRootDir({ env: process.env, userHomeDir: HOME });
      expect(getArtifactsRoot()).toBe(join(root, "artifacts"));
      expect(getArtifactsRoot()).toBe(join(HOME, ".nautilo", "artifacts"));
    });
  });

  test("NAUTILO_INSTANCE_ID=beta → ~/.nautilo-beta/artifacts", () => {
    withEnv({ NAUTILO_INSTANCE_ID: "beta" }, () => {
      const root = resolveNautiloRootDir({ env: process.env, userHomeDir: HOME });
      expect(getArtifactsRoot()).toBe(join(root, "artifacts"));
      expect(getArtifactsRoot()).toBe(join(HOME, ".nautilo-beta", "artifacts"));
    });
  });

  test("NAUTILO_ARTIFACTS_ROOT=/custom overrides instance suffix", () => {
    withEnv(
      { NAUTILO_INSTANCE_ID: "beta", NAUTILO_ARTIFACTS_ROOT: "/custom" },
      () => {
        expect(getArtifactsRoot()).toBe("/custom");
      },
    );
  });
});

describe("getAppsRoot — M182 sibling of artifacts root", () => {
  test('default → ~/.nautilo/apps', () => {
    withEnv({ NAUTILO_INSTANCE_ID: "" }, () => {
      const root = resolveNautiloRootDir({ env: process.env, userHomeDir: HOME });
      expect(getAppsRoot()).toBe(join(root, "apps"));
      expect(getAppsRoot()).toBe(join(HOME, ".nautilo", "apps"));
    });
  });

  test("NAUTILO_ARTIFACTS_ROOT=/custom/artifacts → /custom/apps", () => {
    withEnv({ NAUTILO_ARTIFACTS_ROOT: "/custom/artifacts" }, () => {
      expect(getAppsRoot()).toBe("/custom/apps");
    });
  });
});

describe("getMediaStorageRoot — durable avatar/icon paths", () => {
  test('NAUTILO_INSTANCE_ID="" → ~/.nautilo', () => {
    withEnv({ NAUTILO_INSTANCE_ID: "" }, () => {
      const root = resolveNautiloRootDir({ env: process.env, userHomeDir: HOME });
      expect(getMediaStorageRoot()).toBe(root);
      expect(getMediaStorageRoot()).toBe(join(HOME, ".nautilo"));
    });
  });

  test("NAUTILO_INSTANCE_ID=beta → ~/.nautilo-beta", () => {
    withEnv({ NAUTILO_INSTANCE_ID: "beta" }, () => {
      const root = resolveNautiloRootDir({ env: process.env, userHomeDir: HOME });
      expect(getMediaStorageRoot()).toBe(root);
      expect(getMediaStorageRoot()).toBe(join(HOME, ".nautilo-beta"));
    });
  });

  test("NAUTILO_MEDIA_ROOT=/custom overrides instance suffix", () => {
    withEnv(
      { NAUTILO_INSTANCE_ID: "beta", NAUTILO_MEDIA_ROOT: "/custom/media" },
      () => {
        expect(getMediaStorageRoot()).toBe("/custom/media");
      },
    );
  });

  test("malformed NAUTILO_MEDIA_ROOT falls back to nautilo root", () => {
    withEnv({ NAUTILO_MEDIA_ROOT: "relative/media" }, () => {
      const root = resolveNautiloRootDir({ env: process.env, userHomeDir: HOME });
      expect(getMediaStorageRoot()).toBe(root);
    });
  });
});

describe("getProfileAvatarsRoot + getServerIconRoot", () => {
  test("default → sibling dirs under nautilo root", () => {
    withEnv({ NAUTILO_INSTANCE_ID: "" }, () => {
      const root = resolveNautiloRootDir({ env: process.env, userHomeDir: HOME });
      expect(getProfileAvatarsRoot()).toBe(join(root, "profile-avatars"));
      expect(getServerIconRoot()).toBe(join(root, "server-icon"));
    });
  });

  test("NAUTILO_MEDIA_ROOT=/custom/media → subdirs under override", () => {
    withEnv({ NAUTILO_MEDIA_ROOT: "/custom/media" }, () => {
      expect(getProfileAvatarsRoot()).toBe("/custom/media/profile-avatars");
      expect(getServerIconRoot()).toBe("/custom/media/server-icon");
    });
  });
});
