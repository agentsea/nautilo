/**
 * M123 Phase 2 / Stack 39 Phase 3C — recent-servers persistence tests.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalizeRecentServerUrl,
  parseRecentServersFile,
} from "../../electron/recent-servers-schema";

let tempRoot = "";

mock.module("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
  },
}));

mock.module("electron-log/main", () => ({
  default: {
    warn: () => {},
    info: () => {},
    error: () => {},
  },
}));

mock.module("../../electron/paths", () => ({
  recentServersFilePath: () => path.join(tempRoot, "recent-servers.json"),
  browserControlStateFilePath: () => path.join(tempRoot, "browser-control-state.json"),
  browserControlAgentBrowserConfigPath: () =>
    path.join(tempRoot, "agent-browser-provider.json"),
  toolRuntimeConfigFilePath: () => path.join(tempRoot, "tool-runtimes.json"),
  localFileHistoryDirPath: () => path.join(tempRoot, "local-file-history"),
}));

let pushRecentServer: typeof import("../../electron/recent-servers").pushRecentServer;
let listRecentServers: typeof import("../../electron/recent-servers").listRecentServers;
let removeRecentServer: typeof import("../../electron/recent-servers").removeRecentServer;
let getRecentServerFingerprint: typeof import("../../electron/recent-servers").getRecentServerFingerprint;
let setRecentServerFingerprint: typeof import("../../electron/recent-servers").setRecentServerFingerprint;
let findRecentServerIdentityGroup: typeof import("../../electron/recent-servers").findRecentServerIdentityGroup;

beforeEach(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-recent-servers-"));
  const mod = await import("../../electron/recent-servers");
  pushRecentServer = mod.pushRecentServer;
  listRecentServers = mod.listRecentServers;
  removeRecentServer = mod.removeRecentServer;
  getRecentServerFingerprint = mod.getRecentServerFingerprint;
  setRecentServerFingerprint = mod.setRecentServerFingerprint;
  findRecentServerIdentityGroup = mod.findRecentServerIdentityGroup;
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("parseRecentServersFile", () => {
  test("schema version mismatch → empty list", () => {
    expect(parseRecentServersFile({ v: 0, servers: [{ url: "https://x", lastUsedAt: "t" }] })).toEqual({
      v: 2,
      servers: [],
    });
  });

  test("malformed servers array → empty list", () => {
    expect(parseRecentServersFile({ v: 1, servers: "nope" })).toEqual({
      v: 2,
      servers: [],
    });
  });

  test("skips entries missing url or lastUsedAt", () => {
    expect(
      parseRecentServersFile({
        v: 1,
        servers: [
          { url: "https://good", lastUsedAt: "2026-01-01T00:00:00.000Z" },
          { url: "", lastUsedAt: "2026-01-01T00:00:00.000Z" },
          { url: "https://bad", lastUsedAt: "" },
        ],
      }),
    ).toEqual({
      v: 2,
      servers: [{ url: "https://good", lastUsedAt: "2026-01-01T00:00:00.000Z" }],
    });
  });

  test("v1 input forward-migrates to v2 output (no fingerprint)", () => {
    expect(
      parseRecentServersFile({
        v: 1,
        servers: [{ url: "https://good", lastUsedAt: "2026-01-01T00:00:00.000Z" }],
      }),
    ).toEqual({
      v: 2,
      servers: [{ url: "https://good", lastUsedAt: "2026-01-01T00:00:00.000Z" }],
    });
  });

  test("v2 input preserves optional fingerprint", () => {
    expect(
      parseRecentServersFile({
        v: 2,
        servers: [
          { url: "https://a.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-a" },
          { url: "https://b.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "" },
        ],
      }),
    ).toEqual({
      v: 2,
      servers: [
        { url: "https://a.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-a" },
        { url: "https://b.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
  });
});

describe("listRecentServers", () => {
  test("missing file → empty list", () => {
    expect(listRecentServers()).toEqual([]);
  });

  test("malformed JSON on disk → empty list", () => {
    const filePath = path.join(tempRoot, "recent-servers.json");
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(filePath, "{ not json");
    expect(listRecentServers()).toEqual([]);
  });

  test("returns sorted by lastUsedAt desc", () => {
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 1,
        servers: [
          { url: "https://older", lastUsedAt: "2026-01-01T00:00:00.000Z" },
          { url: "https://newer", lastUsedAt: "2026-06-01T00:00:00.000Z" },
        ],
      }),
    );
    expect(listRecentServers().map((s) => s.url)).toEqual([
      "https://newer",
      "https://older",
    ]);
  });
});

describe("pushRecentServer", () => {
  test("most recent first after push", () => {
    pushRecentServer({ url: "https://first" });
    pushRecentServer({ url: "https://second" });
    expect(listRecentServers().map((s) => s.url)).toEqual([
      "https://second",
      "https://first",
    ]);
  });

  test("dedupes trailing slash and host case", () => {
    pushRecentServer({ url: "HTTPS://Example.COM/" });
    pushRecentServer({ url: "https://example.com" });
    const list = listRecentServers();
    expect(list).toHaveLength(1);
    expect(list[0]?.url).toBe("https://example.com");
  });

  test("preserves path casing while lowercasing host", () => {
    pushRecentServer({ url: "https://Example.COM/MyPath" });
    expect(listRecentServers()[0]?.url).toBe("https://example.com/MyPath");
    expect(canonicalizeRecentServerUrl("HTTPS://Example.COM/MyPath/")).toBe(
      "https://example.com/MyPath",
    );
  });

  test("retains every connected server until explicit removal", () => {
    for (let i = 0; i < 12; i += 1) {
      pushRecentServer({ url: `https://host-${i}.example` });
    }
    expect(listRecentServers()).toHaveLength(12);
    expect(listRecentServers()[0]?.url).toBe("https://host-11.example");
    expect(listRecentServers().at(-1)?.url).toBe("https://host-0.example");
  });

  test("re-push moves existing entry to front and updates lastUsedAt", () => {
    const before = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 1,
        servers: [
          { url: "https://b.example", lastUsedAt: "2026-02-01T00:00:00.000Z" },
          { url: "https://a.example", lastUsedAt: before },
        ],
      }),
    );

    pushRecentServer({ url: "https://a.example/" });
    const list = listRecentServers();
    expect(list).toHaveLength(2);
    expect(list[0]?.url).toBe("https://a.example");
    expect(list[1]?.url).toBe("https://b.example");
    expect(list[0]?.lastUsedAt).not.toBe(before);
  });

  test("optional displayName is stored", () => {
    pushRecentServer({ url: "https://upgrade.example.test", displayName: "Dev" });
    expect(listRecentServers()[0]?.displayName).toBe("Dev");
  });
});

describe("removeRecentServer (M161 Phase 6.5)", () => {
  test("removes all trusted fingerprint aliases without touching other servers", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
          { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z", fingerprint: "fp-local" },
          { url: "https://other.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-other" },
        ],
      }),
    );
    expect(removeRecentServer("http://localhost:3001", { fingerprint: "fp-local" }).sort()).toEqual([
      "http://127.0.0.1:3001",
      "http://localhost:3001",
    ]);
    expect(listRecentServers().map((entry) => entry.url)).toEqual(["https://other.example"]);
  });

  test("falls back to same-protocol/port loopback aliases and is idempotent", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z" },
          { url: "http://[::1]:3001", lastUsedAt: "2026-02-01T00:00:00.000Z" },
          { url: "https://127.0.0.1:3001", lastUsedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );
    removeRecentServer("http://127.0.0.1:3001");
    expect(listRecentServers().map((entry) => entry.url)).toEqual(["https://127.0.0.1:3001"]);
    expect(removeRecentServer("http://127.0.0.1:3001")).toEqual(["http://127.0.0.1:3001"]);
  });
});

describe("loopback identity group fingerprint lookup/store (M161 Phase 6.6 / Stack 198)", () => {
  test("stored localhost fingerprint is resolved through a 127 alias", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
        ],
      }),
    );
    // No exact 127 recent exists; the localhost alias carries the trust.
    expect(getRecentServerFingerprint("http://127.0.0.1:3001")).toBe("fp-local");
    expect(getRecentServerFingerprint("http://[::1]:3001")).toBe("fp-local");
    // The localhost entry itself still resolves directly.
    expect(getRecentServerFingerprint("http://localhost:3001")).toBe("fp-local");
  });

  test("identity group lists exact match first then loopback aliases", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z", fingerprint: "fp-127" },
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z" },
          { url: "http://[::1]:3001", lastUsedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );
    const group = findRecentServerIdentityGroup("http://127.0.0.1:3001");
    expect(group.map((entry) => entry.url)).toEqual([
      "http://127.0.0.1:3001",
      "http://localhost:3001",
      "http://[::1]:3001",
    ]);
  });

  test("127 store learns fingerprint through the localhost recent entry", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z" },
        ],
      }),
    );
    // No 127 recent exists; the first trust persists on the matching
    // loopback recent (localhost), never creating a new 127 entry.
    expect(setRecentServerFingerprint("http://127.0.0.1:3001", "fp-learned")).toBe(true);
    const list = listRecentServers();
    expect(list).toHaveLength(1);
    expect(list[0]?.url).toBe("http://localhost:3001");
    expect(list[0]?.fingerprint).toBe("fp-learned");
    // The 127 alias now resolves the learned fingerprint through localhost.
    expect(getRecentServerFingerprint("http://127.0.0.1:3001")).toBe("fp-learned");
  });

  test("already-trusted matching fingerprint on localhost alias returns true without overwrite", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
        ],
      }),
    );
    // Switching the 127 alias re-probes the same trusted server: the
    // trust is already established, so the store succeeds without
    // creating a 127 entry or mutating the localhost authority.
    expect(setRecentServerFingerprint("http://127.0.0.1:3001", "fp-local")).toBe(true);
    expect(listRecentServers()).toHaveLength(1);
    expect(listRecentServers()[0]?.url).toBe("http://localhost:3001");
    expect(listRecentServers()[0]?.fingerprint).toBe("fp-local");
  });

  test("port, protocol, and non-loopback aliases never match the identity group", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
        ],
      }),
    );
    // Positive control: the same-protocol+port 127 alias resolves trust.
    expect(getRecentServerFingerprint("http://127.0.0.1:3001")).toBe("fp-local");
    // Different port — no alias match, no fingerprint inherited.
    expect(getRecentServerFingerprint("http://127.0.0.1:3000")).toBeNull();
    // Different protocol — no alias match.
    expect(getRecentServerFingerprint("https://127.0.0.1:3001")).toBeNull();
    // Non-loopback host never merges with a loopback alias.
    expect(getRecentServerFingerprint("http://192.168.1.10:3001")).toBeNull();
    // Storing on a cross-port/protocol/non-loopback URL with no matching
    // recent entry fails closed — there is no identity-group member to
    // persist on, and the localhost:3001 trust is never bridged.
    expect(setRecentServerFingerprint("http://127.0.0.1:3000", "fp-x")).toBe(false);
    expect(setRecentServerFingerprint("https://127.0.0.1:3001", "fp-x")).toBe(false);
    expect(setRecentServerFingerprint("http://192.168.1.10:3001", "fp-x")).toBe(false);
    // Nothing was mutated; the localhost trust is intact.
    expect(listRecentServers()).toEqual([
      { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
    ]);
  });

  test("mismatching existing trusted fingerprint is never overwritten", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-trusted" },
        ],
      }),
    );
    // A probe returning a different fingerprint must not overwrite the
    // existing trusted authority, and the store reports not-trusted.
    expect(setRecentServerFingerprint("http://127.0.0.1:3001", "fp-attacker")).toBe(false);
    expect(setRecentServerFingerprint("http://localhost:3001", "fp-attacker")).toBe(false);
    expect(getRecentServerFingerprint("http://127.0.0.1:3001")).toBe("fp-trusted");
    expect(listRecentServers()[0]?.fingerprint).toBe("fp-trusted");
  });

  test("exact-match trusted fingerprint wins over a disagreeing loopback alias", () => {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 2,
        servers: [
          { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z", fingerprint: "fp-127" },
          { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
        ],
      }),
    );
    // Distinct nonempty fingerprints never merge: the exact match wins.
    expect(getRecentServerFingerprint("http://127.0.0.1:3001")).toBe("fp-127");
    expect(getRecentServerFingerprint("http://localhost:3001")).toBe("fp-local");
  });
});
