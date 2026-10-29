import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pinRecoveryComposeTemplate } from "../../src/recovery-compose-template.ts";

describe("recovery Compose infrastructure selections", () => {
  const image = `ghcr.io/example/auth@sha256:${"a".repeat(64)}`;
  test("freezes old authentication image and migration target without copying secrets", () => {
    const template = 'image: ${LOGTO_IMAGE}\ntarget: ${LOGTO_IMAGE_TAG}\npassword: ${LOGTO_DB_PASSWORD}\n';
    const result = pinRecoveryComposeTemplate(template, `LOGTO_IMAGE=${image}\nLOGTO_IMAGE_TAG=1.38.0\nLOGTO_DB_PASSWORD=fixture-secret\n`);
    expect(result).toBe(`image: ${image}\ntarget: 1.38.0\npassword: \u0024{LOGTO_DB_PASSWORD}\n`);
    expect(result).not.toContain("fixture-secret");
  });
  test("preserves literal old selections and unrelated template substitutions", () => {
    const template = `image: ${image}\nport: \u0024{PORT:-4001}\n`;
    expect(pinRecoveryComposeTemplate(template, "")).toBe(template);
  });
  test("pins both database image selections", () => {
    expect(pinRecoveryComposeTemplate('${POSTGRES_IMAGE}\n${PGVECTOR_IMAGE}', `POSTGRES_IMAGE=${image}\nPGVECTOR_IMAGE=${image}`)).toBe(`${image}\n${image}`);
  });
  test("pins required migration targets and defaulted image substitutions", () => {
    expect(pinRecoveryComposeTemplate('${LOGTO_IMAGE:-auth:latest}\n${LOGTO_IMAGE_TAG:?target required}', `LOGTO_IMAGE=${image}\nLOGTO_IMAGE_TAG=1.38.0`)).toBe(`${image}\n1.38.0`);
  });
  test.each(["", "LOGTO_IMAGE=auth:latest", `LOGTO_IMAGE=${image}\nLOGTO_IMAGE_TAG=bad`])("rejects unavailable or unsafe selections", (env) => {
    expect(() => pinRecoveryComposeTemplate('${LOGTO_IMAGE}\n${LOGTO_IMAGE_TAG}', env)).toThrow("recovery selection");
  });
  test("durable services resume after a host reboot while the migration job stays one-shot", () => {
    const compose = Bun.YAML.parse(readFileSync(new URL("../../templates/docker-compose.yml", import.meta.url), "utf8")) as { services: Record<string, { restart?: unknown }> };
    for (const service of ["app-postgres", "logto-postgres", "logto", "nautilo-server"]) {
      expect(compose.services[service]!.restart).toBe("unless-stopped");
    }
    expect(compose.services["logto-seed"]!.restart).toBe("no");
  });
});
