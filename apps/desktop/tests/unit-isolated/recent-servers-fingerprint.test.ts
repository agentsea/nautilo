/**
 * M161 Phase 3.2 — per-server fingerprint + recent-servers schema v2
 * migration tests.
 *
 * Covers `setRecentServerFingerprint` (idempotent + non-destructive) and
 * `migratePairedServerIdentityToFingerprint` (legacy
 * `paired-server-identity.json` → matching recent entry, then unlink).
 * The migrator takes injected `readIdentity` / `unlink` deps so the
 * test never touches the Electron `app.getPath("userData")` runtime.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("electron", () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
}));

mock.module("electron-log/main", () => ({
  default: { warn: () => {}, info: () => {}, error: () => {} },
}));

let tempRoot = "";

mock.module("../../electron/paths", () => ({
  recentServersFilePath: () => path.join(tempRoot, "recent-servers.json"),
  browserControlStateFilePath: () => path.join(tempRoot, "browser-control-state.json"),
  browserControlAgentBrowserConfigPath: () =>
    path.join(tempRoot, "agent-browser-provider.json"),
  toolRuntimeConfigFilePath: () => path.join(tempRoot, "tool-runtimes.json"),
  localFileHistoryDirPath: () => path.join(tempRoot, "local-file-history"),
}));

let setRecentServerFingerprint: typeof import("../../electron/recent-servers").setRecentServerFingerprint;
let replaceRecentServerFingerprint: typeof import("../../electron/recent-servers").replaceRecentServerFingerprint;
let setCommittedRecentServerFingerprint: typeof import("../../electron/recent-servers").setCommittedRecentServerFingerprint;
let pushRecentServer: typeof import("../../electron/recent-servers").pushRecentServer;
let migratePairedServerIdentityToFingerprint: typeof import("../../electron/recent-servers").migratePairedServerIdentityToFingerprint;
let listRecentServers: typeof import("../../electron/recent-servers").listRecentServers;

beforeEach(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-recent-servers-fp-"));
  const mod = await import("../../electron/recent-servers");
  setRecentServerFingerprint = mod.setRecentServerFingerprint;
  replaceRecentServerFingerprint = mod.replaceRecentServerFingerprint;
  setCommittedRecentServerFingerprint = mod.setCommittedRecentServerFingerprint;
  pushRecentServer = mod.pushRecentServer;
  migratePairedServerIdentityToFingerprint = mod.migratePairedServerIdentityToFingerprint;
  listRecentServers = mod.listRecentServers;
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function writeRecentServers(servers: unknown[]): void {
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "recent-servers.json"),
    JSON.stringify({ v: 2, servers }),
  );
}

function readRecentServersRaw(): { v: number; servers: unknown[] } {
  return JSON.parse(
    fs.readFileSync(path.join(tempRoot, "recent-servers.json"), "utf-8"),
  ) as { v: number; servers: unknown[] };
}

describe("committed connection fingerprint metadata", () => {
  const authority = {
    scope: "https://b.example", revision: "committed-revision",
    connectionAttemptId: "accepted-attempt", serverFingerprint: "new-b",
  };

  beforeEach(() => {
    writeRecentServers([
      { url: "https://a.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "keep-a" },
      { url: "https://b.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "old-b" },
    ]);
  });

  test("accepted identity finishes metadata without changing another server", () => {
    // Discovery still refuses to replace trust; the guarded durable commit
    // authorizes projecting its accepted identity into the recent entry.
    pushRecentServer({ url: authority.scope });
    expect(setRecentServerFingerprint(authority.scope, "new-b")).toBe(false);
    expect(setCommittedRecentServerFingerprint(authority.scope, "new-b", authority)).toBe(true);
    expect(listRecentServers().find((s) => s.url === authority.scope)?.fingerprint).toBe("new-b");
    expect(listRecentServers().find((s) => s.url === "https://a.example")?.fingerprint).toBe("keep-a");
  });

  test("metadata recovery is idempotent after the write but before checkpoint persistence", () => {
    expect(setCommittedRecentServerFingerprint(authority.scope, "new-b", authority)).toBe(true);
    const written = fs.readFileSync(path.join(tempRoot, "recent-servers.json"), "utf8");
    expect(setCommittedRecentServerFingerprint(authority.scope, "new-b", authority)).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "recent-servers.json"), "utf8")).toBe(written);
  });

  test("a third identity cannot inherit acceptance for the committed identity", () => {
    expect(setCommittedRecentServerFingerprint(authority.scope, "attacker-c", authority)).toBe(false);
    expect(listRecentServers().find((s) => s.url === authority.scope)?.fingerprint).toBe("old-b");
  });

  test("another origin or precommit authority cannot authorize replacement", () => {
    const before = readRecentServersRaw();
    expect(setCommittedRecentServerFingerprint("https://a.example", "new-b", authority)).toBe(false);
    expect(setCommittedRecentServerFingerprint(authority.scope, "new-b", {
      ...authority, serverFingerprint: "old-b",
    })).toBe(false);
    expect(setCommittedRecentServerFingerprint(authority.scope, "new-b", {
      scope: null, revision: null, connectionAttemptId: null, serverFingerprint: null,
    })).toBe(false);
    expect(readRecentServersRaw()).toEqual(before);
  });

  test("missing durable commit identity does not authorize replacement", () => {
    const before = readRecentServersRaw();
    for (const uncommitted of [{ ...authority, revision: "" }, { ...authority, connectionAttemptId: "" }]) {
      expect(setCommittedRecentServerFingerprint(authority.scope, "new-b", uncommitted)).toBe(false);
    }
    expect(readRecentServersRaw()).toEqual(before);
  });

  test("a failed metadata write remains a resumable failure", () => {
    const file = path.join(tempRoot, "recent-servers.json");
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(setCommittedRecentServerFingerprint(authority.scope, "new-b", authority)).toBe(false);
  });
});

describe("setRecentServerFingerprint (M161 Phase 3.2)", () => {
  test("sets fingerprint on the matching entry only", () => {
    writeRecentServers([
      { url: "https://a.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
      { url: "https://b.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(setRecentServerFingerprint("https://a.example", "fp-a")).toBe(true);
    const list = listRecentServers();
    expect(list[0]?.fingerprint).toBe("fp-a");
    expect(list[1]?.fingerprint).toBeUndefined();
  });

  test("canonicalizes the input URL (trailing slash + host case)", () => {
    writeRecentServers([
      { url: "https://example.com", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(setRecentServerFingerprint("HTTPS://Example.COM/", "fp")).toBe(true);
    expect(listRecentServers()[0]?.fingerprint).toBe("fp");
  });

  test("idempotent — re-run does not overwrite an existing fingerprint", () => {
    writeRecentServers([
      { url: "https://a.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "original" },
    ]);
    expect(setRecentServerFingerprint("https://a.example", "new")).toBe(false);
    expect(listRecentServers()[0]?.fingerprint).toBe("original");
  });

  test("non-destructive on non-matching entries", () => {
    writeRecentServers([
      { url: "https://a.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "keep-a" },
      { url: "https://b.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    setRecentServerFingerprint("https://b.example", "fp-b");
    const list = listRecentServers();
    const a = list.find((s) => s.url === "https://a.example");
    const b = list.find((s) => s.url === "https://b.example");
    expect(a?.fingerprint).toBe("keep-a");
    expect(b?.fingerprint).toBe("fp-b");
  });

  test("malformed unrelated URL cannot block or corrupt the matching entry", () => {
    writeRecentServers([
      { url: "not a url", lastUsedAt: "2026-01-01T00:00:00.000Z" },
      { url: "https://b.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(setRecentServerFingerprint("https://b.example", "fp-b")).toBe(true);
    const list = listRecentServers();
    expect(list.find((entry) => entry.url === "not a url")?.fingerprint).toBeUndefined();
    expect(list.find((entry) => entry.url === "https://b.example")?.fingerprint).toBe("fp-b");
  });

  test("no-op when no matching entry exists", () => {
    writeRecentServers([
      { url: "https://a.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(setRecentServerFingerprint("https://nope.example", "fp")).toBe(false);
    expect(listRecentServers()[0]?.fingerprint).toBeUndefined();
  });

  test("rejects empty fingerprint", () => {
    writeRecentServers([
      { url: "https://a.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(setRecentServerFingerprint("https://a.example", "")).toBe(false);
    expect(listRecentServers()[0]?.fingerprint).toBeUndefined();
  });

  test("moving a recent entry to the front preserves its fingerprint", () => {
    writeRecentServers([
      {
        url: "https://a.example",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "fp-a",
      },
    ]);
    pushRecentServer({ url: "https://a.example/" });
    expect(listRecentServers()[0]?.fingerprint).toBe("fp-a");
  });

  test("explicit recovery replacement overwrites only the matching fingerprint", () => {
    writeRecentServers([
      {
        url: "https://a.example",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "old-a",
      },
      {
        url: "https://b.example",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "keep-b",
      },
    ]);
    expect(replaceRecentServerFingerprint("https://a.example", "new-a")).toBe(true);
    const list = listRecentServers();
    expect(list.find((entry) => entry.url === "https://a.example")?.fingerprint).toBe("new-a");
    expect(list.find((entry) => entry.url === "https://b.example")?.fingerprint).toBe("keep-b");
  });
});

describe("migratePairedServerIdentityToFingerprint (M161 Phase 3.2)", () => {
  test("v1 file + legacy identity → matching entry gets fingerprint, non-matching stays fingerprint-less", () => {
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({
        v: 1,
        servers: [
          { url: "https://active.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
          { url: "https://other.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );
    let legacy = "legacy-identity";
    let unlinked = false;
    const migrated = migratePairedServerIdentityToFingerprint("https://active.example", {
      readIdentity: () => legacy,
      unlink: () => {
        legacy = "";
        unlinked = true;
      },
    });
    expect(migrated).toBe(true);
    expect(unlinked).toBe(true);
    // Output is forward-migrated to v2.
    const raw = readRecentServersRaw();
    expect(raw.v).toBe(2);
    const list = listRecentServers();
    const active = list.find((s) => s.url === "https://active.example");
    const other = list.find((s) => s.url === "https://other.example");
    expect(active?.fingerprint).toBe("legacy-identity");
    expect(other?.fingerprint).toBeUndefined();
  });

  test("idempotent + non-destructive on re-run (legacy file already unlinked)", () => {
    writeRecentServers([
      { url: "https://active.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "legacy-identity" },
      { url: "https://other.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const before = readRecentServersRaw();
    const migrated = migratePairedServerIdentityToFingerprint("https://active.example", {
      readIdentity: () => null, // legacy file already gone
      unlink: () => {
        throw new Error("should not unlink");
      },
    });
    expect(migrated).toBe(false);
    // File byte-for-byte unchanged.
    const after = readRecentServersRaw();
    expect(after).toEqual(before);
  });

  test("unlink is best-effort — a missing legacy file does not roll back the fingerprint", () => {
    writeRecentServers([
      { url: "https://active.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    let unlinkCalls = 0;
    const migrated = migratePairedServerIdentityToFingerprint("https://active.example", {
      readIdentity: () => "legacy-identity",
      unlink: () => {
        unlinkCalls += 1;
        throw new Error("ENOENT");
      },
    });
    expect(migrated).toBe(true);
    expect(unlinkCalls).toBe(1);
    expect(listRecentServers()[0]?.fingerprint).toBe("legacy-identity");
  });

  test("does not overwrite an existing fingerprint on the matching entry", () => {
    writeRecentServers([
      { url: "https://active.example", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "already-there" },
    ]);
    let unlinked = false;
    migratePairedServerIdentityToFingerprint("https://active.example", {
      readIdentity: () => "legacy-identity",
      unlink: () => {
        unlinked = true;
      },
    });
    // Fingerprint preserved; legacy file still unlinked (migration ran).
    expect(listRecentServers()[0]?.fingerprint).toBe("already-there");
    expect(unlinked).toBe(true);
  });

  test("retains legacy identity when no matching recent entry exists", () => {
    writeRecentServers([
      { url: "https://other.example", lastUsedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    let unlinked = false;
    const migrated = migratePairedServerIdentityToFingerprint(
      "https://active.example",
      {
        readIdentity: () => "legacy-identity",
        unlink: () => {
          unlinked = true;
        },
      },
    );
    expect(migrated).toBe(false);
    expect(unlinked).toBe(false);
    expect(listRecentServers()[0]?.fingerprint).toBeUndefined();
  });
});
