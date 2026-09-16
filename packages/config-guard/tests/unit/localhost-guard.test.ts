import { describe, expect, test } from "bun:test";
import { isLocalhostIp } from "../../src/localhost-guard";

describe("isLocalhostIp", () => {
  test("accepts IPv4 and IPv6 loopback", () => {
    expect(isLocalhostIp("127.0.0.1")).toBe(true);
    expect(isLocalhostIp("::1")).toBe(true);
    expect(isLocalhostIp("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects non-loopback", () => {
    expect(isLocalhostIp("8.8.8.8")).toBe(false);
    expect(isLocalhostIp("192.168.1.1")).toBe(false);
    expect(isLocalhostIp("::2")).toBe(false);
    expect(isLocalhostIp("10.0.0.1")).toBe(false);
  });
});
