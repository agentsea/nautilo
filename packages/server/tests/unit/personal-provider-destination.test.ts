import { afterEach, describe, expect, test } from "bun:test";
import {
  currentPersonalGatewayDestination,
  validatePersonalGatewayDestination,
} from "../../src/lib/personal-provider-destination";

const originalGatewayBaseUrl = process.env["NAUTILO_GATEWAY_BASE_URL"];

afterEach(() => {
  if (originalGatewayBaseUrl === undefined) {
    delete process.env["NAUTILO_GATEWAY_BASE_URL"];
  } else {
    process.env["NAUTILO_GATEWAY_BASE_URL"] = originalGatewayBaseUrl;
  }
});

describe("personal Gateway destination", () => {
  test("retains the normalized full configured base path", () => {
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "https://gateway.example/tenant-a/v1///";
    expect(currentPersonalGatewayDestination()).toBe(
      "https://gateway.example/tenant-a/v1",
    );
  });

  test("requires Gateway rows to match the current exact destination", () => {
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "https://gateway.example/tenant-a/v1";
    expect(validatePersonalGatewayDestination({
      provider: "gateway",
      destination: "https://gateway.example/tenant-a/v1",
    })).toBe(true);
    expect(validatePersonalGatewayDestination({
      provider: "gateway",
      destination: "https://gateway.example/tenant-b/v1",
    })).toBe(false);
    expect(validatePersonalGatewayDestination({
      provider: "gateway",
      destination: null,
    })).toBe(false);
    expect(validatePersonalGatewayDestination({
      provider: "openai",
      destination: null,
    })).toBe(true);
  });

  test("rejects Gateway rows when the configured destination is unavailable", () => {
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "file:///not-an-http-endpoint";
    expect(currentPersonalGatewayDestination()).toBeNull();
    expect(validatePersonalGatewayDestination({
      provider: "gateway",
      destination: "https://gateway.example/v1",
    })).toBe(false);
  });

  test("does not expose credentials or query data embedded in an admin URL", () => {
    for (const unsafe of [
      "https://user:secret@gateway.example/v1",
      "https://gateway.example/v1?token=secret",
      "https://gateway.example/v1#secret",
    ]) {
      process.env["NAUTILO_GATEWAY_BASE_URL"] = unsafe;
      expect(currentPersonalGatewayDestination()).toBeNull();
    }
  });
});
