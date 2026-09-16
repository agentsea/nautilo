import { afterEach, describe, expect, test } from "bun:test";

import {
  getCloudConvertConfig,
  isCloudConvertConfigured,
  resolveConvertConfig,
} from "./config.ts";

const envSnapshot = {
  apiKey: process.env["CLOUDCONVERT_API_KEY"],
  sandbox: process.env["CLOUDCONVERT_SANDBOX"],
  region: process.env["CLOUDCONVERT_REGION"],
};

afterEach(() => {
  for (const [key, value] of Object.entries(envSnapshot)) {
    const envName =
      key === "apiKey"
        ? "CLOUDCONVERT_API_KEY"
        : key === "sandbox"
          ? "CLOUDCONVERT_SANDBOX"
          : "CLOUDCONVERT_REGION";

    if (value === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = value;
    }
  }
});

describe("config", () => {
  test("does not throw at import and reports unconfigured state", () => {
    delete process.env["CLOUDCONVERT_API_KEY"];
    expect(isCloudConvertConfigured()).toBe(false);
    expect(getCloudConvertConfig().apiKey).toBe("");
  });

  test("reads sandbox and region from environment", () => {
    process.env["CLOUDCONVERT_API_KEY"] = "key";
    process.env["CLOUDCONVERT_SANDBOX"] = "true";
    process.env["CLOUDCONVERT_REGION"] = "eu-central";

    expect(getCloudConvertConfig()).toEqual({
      apiKey: "key",
      sandbox: true,
      region: "eu-central",
    });
    expect(isCloudConvertConfigured()).toBe(true);
  });

  test("resolveConvertConfig allows per-call overrides", () => {
    process.env["CLOUDCONVERT_API_KEY"] = "key";
    process.env["CLOUDCONVERT_SANDBOX"] = "false";
    process.env["CLOUDCONVERT_REGION"] = "us-east";

    expect(resolveConvertConfig({ sandbox: true, region: "eu-central" })).toEqual({
      apiKey: "key",
      sandbox: true,
      region: "eu-central",
    });
  });

  // Regression: a hand-edited instance.env can carry an inline comment that the
  // dotenv loader does not strip; it must never reach the region endpoint URL.
  test("strips inline comment + whitespace from region and validates it", () => {
    process.env["CLOUDCONVERT_API_KEY"] = "key";
    process.env["CLOUDCONVERT_REGION"] = "eu-central   # or us-east; omit for auto";
    expect(getCloudConvertConfig().region).toBe("eu-central");
  });

  test("unknown / malformed region falls back to null (SDK auto-select)", () => {
    process.env["CLOUDCONVERT_API_KEY"] = "key";
    process.env["CLOUDCONVERT_REGION"] = "frankfurt";
    expect(getCloudConvertConfig().region).toBeNull();

    process.env["CLOUDCONVERT_REGION"] = "# or us-east; omit for auto";
    expect(getCloudConvertConfig().region).toBeNull();
  });

  test("sandbox tolerates inline comment + casing", () => {
    process.env["CLOUDCONVERT_API_KEY"] = "key";
    process.env["CLOUDCONVERT_SANDBOX"] = "TRUE   # test mode";
    expect(getCloudConvertConfig().sandbox).toBe(true);

    process.env["CLOUDCONVERT_SANDBOX"] = "false # live";
    expect(getCloudConvertConfig().sandbox).toBe(false);
  });

  test("api key is trimmed/unquoted but never comment-stripped (opaque token)", () => {
    process.env["CLOUDCONVERT_API_KEY"] = '"  abc#def  "';
    // surrounding quotes + whitespace removed; the `#` inside the token is kept.
    expect(getCloudConvertConfig().apiKey).toBe("abc#def");
  });
});
