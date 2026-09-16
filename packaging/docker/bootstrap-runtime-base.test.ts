import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface BaseImage {
  readonly role: string;
  readonly identity: string;
}

describe("hosted bootstrap runtime base", () => {
  test("pins the declared runtime evidence to the supported no-SSL base", () => {
    const dockerfile = readFileSync(join(import.meta.dir, "Dockerfile.bootstrap"), "utf8");
    const baseImages = JSON.parse(
      readFileSync(join(import.meta.dir, "bootstrap-base-images.json"), "utf8"),
    ) as BaseImage[];
    const runtime = baseImages.find((entry) => entry.role === "runtime");

    expect(runtime).toBeDefined();
    expect(runtime?.identity).toMatch(
      /^gcr\.io\/distroless\/base-nossl-debian13@sha256:[a-f0-9]{64}$/,
    );
    const digest = runtime?.identity.slice(runtime.identity.indexOf("@"));
    expect(dockerfile).toContain(
      `FROM gcr.io/distroless/base-nossl-debian13:nonroot${digest}`,
    );
    expect(dockerfile).not.toContain("gcr.io/distroless/base-debian13");
  });
});
