import { expect, test } from "bun:test";
import {
  ConnectedWebAccountTargetError,
  isPublicInternetAddress,
  validateConnectedWebTarget,
} from "../../src/connected-web-accounts/target-validator";

test("D568 target validator preserves a public landing URL while storing the normalized origin", async () => {
  const target = await validateConnectedWebTarget("https://Example.com:443/sign-in?next=home", async () => [{ address: "93.184.216.34", family: 4 }]);
  expect(target).toEqual({ origin: "https://example.com", targetUrl: "https://example.com/sign-in?next=home" });
});

test("D568 target validator rejects credential URLs, local/control names, and any private DNS answer", async () => {
  for (const url of ["https://user:pass@example.com", "http://localhost", "https://metadata.google.internal", "ftp://example.com"]) {
    await expectInvalid(validateConnectedWebTarget(url, async () => [{ address: "93.184.216.34", family: 4 }]));
  }
  await expectInvalid(validateConnectedWebTarget("https://example.com", async () => [
    { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
  ]));
});

async function expectInvalid(result: Promise<unknown>): Promise<void> {
  try {
    await result;
    throw new Error("expected invalid target");
  } catch (error) { expect(error).toBeInstanceOf(ConnectedWebAccountTargetError); }
}

test("D568 address guard denies IPv4-mapped IPv6 and local IPv6 literals", () => {
  expect(isPublicInternetAddress("::ffff:7f00:1")).toBe(false);
  expect(isPublicInternetAddress("::1")).toBe(false);
  expect(isPublicInternetAddress("2606:4700:4700::1111")).toBe(true);
});
