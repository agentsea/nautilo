import { describe, expect, test } from "bun:test";

import {
  isDeterministicallyLocalServerHost,
  normalizeServerUrl,
  serverUrlCandidates,
} from "./server-url";

describe("mobile server target resolution", () => {
  test("a bare public hostname becomes HTTPS and never silently downgrades", () => {
    expect(serverUrlCandidates("  ALPHA.example.test ")).toEqual([
      "https://alpha.example.test",
    ]);
  });

  test("only deterministic local literals receive a bounded HTTP fallback", () => {
    for (const input of [
      "localhost:3001",
      "127.0.0.1:3001",
      "10.0.0.8:3001",
      "192.168.1.8:3001",
      "[fd00::1]:3001",
    ]) {
      expect(serverUrlCandidates(input).map((url) => new URL(url).protocol)).toEqual([
        "https:",
        "http:",
      ]);
    }
    for (const host of ["alpha.example.test", "my-nas.local", "8.8.8.8", "172.32.0.1"]) {
      expect(isDeterministicallyLocalServerHost(host)).toBe(false);
    }
  });

  test("explicit schemes stay explicit", () => {
    expect(serverUrlCandidates("http://localhost:3001")).toEqual([
      "http://localhost:3001",
    ]);
    expect(serverUrlCandidates("https://alpha.example.test")).toEqual([
      "https://alpha.example.test",
    ]);
  });

  test("normalization rejects credentials and unsupported schemes", () => {
    expect(normalizeServerUrl("ftp://server.test")).toBeNull();
    expect(normalizeServerUrl("https://user:secret@server.test")).toBeNull();
    expect(normalizeServerUrl("https://server.test/not-an-origin")).toBeNull();
  });
});
