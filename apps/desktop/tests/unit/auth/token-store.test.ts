/**
 * M055 — token-store unit tests using an in-memory FsLike + a
 * scriptable SafeStorageLike. No Electron, no real disk.
 */
import { describe, expect, test } from "bun:test";
import {
  appendAuthBundleClearedAudit,
  defaultLocalAuthAuditLogPath,
} from "../../../electron/auth/local-auth-audit";
import {
  authFilePath,
  clearTokens,
  HEADER_ENC_V1,
  HEADER_ENC_V2,
  HEADER_PT_V1,
  HEADER_PT_V2,
  legacyAuthFilePath,
  loadTokens,
  loadTokensResult,
  migrateLegacyAuthV1IfDefaultInstance,
  migrateLegacySingleServerAuth,
  saveTokens,
  serverUrlScope,
  type AuthIdentity,
  type FsLike,
  type SafeStorageLike,
  type TokenBundle,
  type TokenStoreDeps,
} from "../../../electron/auth/token-store";
import { parseProfileFromArgv } from "../../../electron/auth/profile-from-argv";

const ID_A: AuthIdentity = {
  instanceId: "",
  serverUrl: "http://localhost:3000",
  logtoEndpoint: "http://localhost:3301",
  workbenchAppId: "wb-a",
};

const ID_B: AuthIdentity = {
  ...ID_A,
  workbenchAppId: "wb-b",
};

const ID_OTHER_SERVER: AuthIdentity = {
  ...ID_A,
  serverUrl: "https://other.example.com",
};

const SCOPE_A = serverUrlScope(ID_A.serverUrl);
const SCOPE_OTHER = serverUrlScope(ID_OTHER_SERVER.serverUrl);

function makeFs(): FsLike & {
  files: Map<string, Buffer>;
  modes: Map<string, number>;
} {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    writeFileSync: (p, data, options) => {
      const buf =
        typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
      files.set(p, buf);
      if (options?.mode !== undefined) modes.set(p, options.mode);
    },
    readFileSync: (p) => {
      const f = files.get(p);
      if (!f) {
        const err = new Error(`ENOENT: ${p}`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      return f;
    },
    unlinkSync: (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      files.delete(p);
      modes.delete(p);
    },
    chmodSync: (p, mode) => {
      modes.set(p, mode);
    },
    existsSync: (p) => files.has(p),
    renameSync: (from, to) => {
      const f = files.get(from);
      if (!f) {
        const err = new Error(`ENOENT: ${from}`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      files.set(to, f);
      files.delete(from);
      if (modes.has(from)) {
        modes.set(to, modes.get(from)!);
        modes.delete(from);
      }
    },
  };
}

function makeSafeStorage(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.concat([Buffer.from("ENC:"), Buffer.from(s, "utf-8")]),
    decryptString: (b) => {
      const tag = b.subarray(0, 4).toString("utf-8");
      if (tag !== "ENC:") throw new Error("decrypt failed");
      return b.subarray(4).toString("utf-8");
    },
  };
}

function makeDeps(
  opts: { encryptionAvailable: boolean; authDir?: string; profile?: string },
): TokenStoreDeps & {
  warns: Array<{ obj: Record<string, unknown> | undefined; msg: string }>;
} {
  const fs = makeFs();
  const warns: Array<{ obj: Record<string, unknown> | undefined; msg: string }> = [];
  return {
    safeStorage: makeSafeStorage(opts.encryptionAvailable),
    fs,
    authDir: opts.authDir ?? "/nautilo-root",
    profile: opts.profile,
    logger: {
      warn: (obj, msg) => warns.push({ obj, msg }),
    },
    warns,
  };
}

const SAMPLE_BUNDLE: TokenBundle = {
  access_token: "at",
  refresh_token: "rt",
  id_token: "it",
  expires_in: 3600,
  refreshed_at: 1_700_000_000_000,
};

describe("authFilePath — per-server keyed filename", () => {
  test("uses desktop-auth-<scope>.json for default profile", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(authFilePath(deps, ID_A)).toBe(
      `/nautilo-root/desktop-auth-${SCOPE_A}.json`,
    );
    expect(SCOPE_A).toBe("f1de9e489ba88cb1");
  });

  test("uses desktop-auth-<profile>-<scope>.json when profile is bob", () => {
    const deps = makeDeps({ encryptionAvailable: true, profile: "bob" });
    expect(authFilePath(deps, ID_A)).toBe(
      `/nautilo-root/desktop-auth-bob-${SCOPE_A}.json`,
    );
  });

  test("two server URLs produce independent keyed paths", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(authFilePath(deps, ID_A)).not.toBe(authFilePath(deps, ID_OTHER_SERVER));
    expect(SCOPE_OTHER).toBe("c18eed13d5510f64");
  });
});

describe("saveTokens + loadTokens — encrypted path", () => {
  test("round-trips with encryption header", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const p = authFilePath(deps, ID_A);
    const stored = (deps.fs as ReturnType<typeof makeFs>).files.get(p)!;
    expect(stored.subarray(0, HEADER_ENC_V2.length).equals(HEADER_ENC_V2)).toBe(true);
    const loaded = loadTokens(deps, { expectedIdentity: ID_A });
    expect(loaded).toEqual(SAMPLE_BUNDLE);
    expect(deps.warns.length).toBe(0);
  });

  test("chmod 600 enforced even on overwrite of pre-existing file", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    const p = authFilePath(deps, ID_A);
    (deps.fs as ReturnType<typeof makeFs>).files.set(p, Buffer.from("stale"));
    (deps.fs as ReturnType<typeof makeFs>).modes.set(p, 0o644);
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    expect((deps.fs as ReturnType<typeof makeFs>).modes.get(p)).toBe(0o600);
  });
});

describe("saveTokens + loadTokens — plaintext fallback", () => {
  test("uses HEADER_PT_V2 when encryption unavailable, logs warning", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const p = authFilePath(deps, ID_A);
    const stored = (deps.fs as ReturnType<typeof makeFs>).files.get(p)!;
    expect(stored.subarray(0, HEADER_PT_V2.length).equals(HEADER_PT_V2)).toBe(true);
    expect(deps.warns[0]?.msg).toBe("auth.token_store.unencrypted_fallback");
    const loaded = loadTokens(deps, { expectedIdentity: ID_A });
    expect(loaded).toEqual(SAMPLE_BUNDLE);
  });
});

describe("saveTokens + loadTokens — per-server isolation", () => {
  test("two server URLs round-trip independently", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    const bundleOther = { ...SAMPLE_BUNDLE, access_token: "at-other" };
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    saveTokens(deps, { bundle: bundleOther, identity: ID_OTHER_SERVER });

    expect(loadTokens(deps, { expectedIdentity: ID_A })).toEqual(SAMPLE_BUNDLE);
    expect(loadTokens(deps, { expectedIdentity: ID_OTHER_SERVER })).toEqual(bundleOther);
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(authFilePath(deps, ID_A))).toBe(
      true,
    );
    expect(
      (deps.fs as ReturnType<typeof makeFs>).files.has(authFilePath(deps, ID_OTHER_SERVER)),
    ).toBe(true);
  });
});

describe("loadTokens — failure modes (fail closed)", () => {
  test("returns null when file is missing", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(loadTokens(deps, { expectedIdentity: ID_A })).toBeNull();
  });

  test("returns null when header is unrecognised (corrupt / pre-M055)", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    const p = authFilePath(deps, ID_A);
    (deps.fs as ReturnType<typeof makeFs>).files.set(
      p,
      Buffer.from(JSON.stringify(SAMPLE_BUNDLE), "utf-8"),
    );
    expect(loadTokens(deps, { expectedIdentity: ID_A })).toBeNull();
  });

  test("returns null when disk says encrypted but platform can't decrypt", () => {
    const writeDeps = makeDeps({ encryptionAvailable: true });
    saveTokens(writeDeps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const p = authFilePath(writeDeps, ID_A);
    const buf = (writeDeps.fs as ReturnType<typeof makeFs>).files.get(p)!;

    const readDeps = makeDeps({ encryptionAvailable: false });
    (readDeps.fs as ReturnType<typeof makeFs>).files.set(authFilePath(readDeps, ID_A), buf);
    expect(loadTokens(readDeps, { expectedIdentity: ID_A })).toBeNull();
  });

  test("returns null when JSON is malformed", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    const p = authFilePath(deps, ID_A);
    (deps.fs as ReturnType<typeof makeFs>).files.set(
      p,
      Buffer.concat([HEADER_PT_V2, Buffer.from("{not valid", "utf-8")]),
    );
    expect(loadTokens(deps, { expectedIdentity: ID_A })).toBeNull();
  });

  test("returns null when required bundle fields are missing", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    const p = authFilePath(deps, ID_A);
    const bad = { v: 2, identity: ID_A, bundle: { access_token: "x" } };
    (deps.fs as ReturnType<typeof makeFs>).files.set(
      p,
      Buffer.concat([HEADER_PT_V2, Buffer.from(JSON.stringify(bad), "utf-8")]),
    );
    expect(loadTokens(deps, { expectedIdentity: ID_A })).toBeNull();
  });

  test("fail-closed on identity mismatch + structured warn", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const loaded = loadTokens(deps, { expectedIdentity: ID_B });
    expect(loaded).toBeNull();
    expect(deps.warns.some((w) => w.msg === "auth.token_store.scope_mismatch")).toBe(true);
  });

  test("loadTokensResult classifies identity mismatch for guided recovery", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const result = loadTokensResult(deps, { expectedIdentity: ID_B });
    expect(result).toEqual({
      kind: "scope-mismatch",
      expected: ID_B,
      disk: ID_A,
    });
  });
});

describe("loadTokens — env-pinned silent clear", () => {
  test("clears mismatched bundle, returns none, and appends audit row", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });

    const auditRows: Array<ReturnType<typeof appendAuthBundleClearedAudit>> = [];
    deps.appendAuthBundleClearedAudit = (args) => {
      const row = appendAuthBundleClearedAudit({
        ...args,
        auditLogPath: "/unit-test/audit.log",
        fs: {
          mkdirSync: () => {},
          appendFileSync: () => {},
          chmodSync: () => {},
        },
        now: () => new Date("2026-05-28T12:00:00.000Z"),
      });
      auditRows.push(row);
      return row;
    };

    const result = loadTokensResult(deps, {
      expectedIdentity: ID_B,
      envPinnedServerUrl: ID_B.serverUrl,
    });

    expect(result).toEqual({
      kind: "env-pinned-cleared",
      expected: ID_B,
      disk: ID_A,
    });
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(authFilePath(deps, ID_A))).toBe(false);
    expect(deps.warns.some((w) => w.msg === "auth.token_store.env_pinned_mismatch_clear")).toBe(
      true,
    );
    expect(deps.warns.some((w) => w.msg === "auth.token_store.scope_mismatch")).toBe(false);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      kind: "auth.bundle_cleared",
      reason: "env_pinned_mismatch",
      expected: ID_B,
      disk: ID_A,
      ts: "2026-05-28T12:00:00.000Z",
    });
    expect(JSON.stringify(auditRows[0])).not.toContain("access_token");
    expect(JSON.stringify(auditRows[0])).not.toContain("refresh_token");
  });

  test("env-pinned clear deletes bundle at keyed path after legacy migration mismatch", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    const auditRows: Array<ReturnType<typeof appendAuthBundleClearedAudit>> = [];
    deps.appendAuthBundleClearedAudit = (args) => {
      const row = appendAuthBundleClearedAudit({
        ...args,
        auditLogPath: "/unit-test/audit.log",
        fs: {
          mkdirSync: () => {},
          appendFileSync: () => {},
          chmodSync: () => {},
        },
        now: () => new Date("2026-05-28T12:00:00.000Z"),
      });
      auditRows.push(row);
      return row;
    };
    const legacy = legacyAuthFilePath(deps);
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const keyedForA = authFilePath(deps, ID_A);
    const buf = (deps.fs as ReturnType<typeof makeFs>).files.get(keyedForA)!;
    (deps.fs as ReturnType<typeof makeFs>).files.set(legacy, buf);
    (deps.fs as ReturnType<typeof makeFs>).files.delete(keyedForA);

    migrateLegacySingleServerAuth(deps, ID_B);
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(legacy)).toBe(false);
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(authFilePath(deps, ID_B))).toBe(true);

    const loaded = loadTokens(deps, {
      expectedIdentity: ID_B,
      envPinnedServerUrl: ID_B.serverUrl,
    });
    expect(loaded).toBeNull();
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(authFilePath(deps, ID_B))).toBe(
      false,
    );
    expect(auditRows).toHaveLength(1);
  });

  test("without env pin, mismatch still fails closed", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });

    const result = loadTokensResult(deps, { expectedIdentity: ID_B });
    expect(result.kind).toBe("scope-mismatch");
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(authFilePath(deps, ID_A))).toBe(true);
  });
});

describe("clearTokens", () => {
  test("removes the keyed file when present", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    clearTokens(deps, ID_A);
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(authFilePath(deps, ID_A))).toBe(false);
  });

  test("no-op when file is already gone", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(() => clearTokens(deps, ID_A)).not.toThrow();
  });
});

describe("migrateLegacySingleServerAuth", () => {
  test("renames legacy desktop-auth.json to keyed name once", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const keyed = authFilePath(deps, ID_A);
    const legacy = legacyAuthFilePath(deps);
    const buf = (deps.fs as ReturnType<typeof makeFs>).files.get(keyed)!;
    (deps.fs as ReturnType<typeof makeFs>).files.set(legacy, buf);
    (deps.fs as ReturnType<typeof makeFs>).files.delete(keyed);

    expect(migrateLegacySingleServerAuth(deps, ID_A)).toBe("migrated");
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(legacy)).toBe(false);
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(keyed)).toBe(true);
    expect(loadTokens(deps, { expectedIdentity: ID_A })).toEqual(SAMPLE_BUNDLE);

    expect(migrateLegacySingleServerAuth(deps, ID_A)).toBe("no-legacy");
  });

  test("skips when keyed file already exists", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const legacy = legacyAuthFilePath(deps);
    (deps.fs as ReturnType<typeof makeFs>).files.set(legacy, Buffer.from("stale"));

    expect(migrateLegacySingleServerAuth(deps, ID_A)).toBe("skipped");
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(legacy)).toBe(true);
  });

  test("returns no-legacy when legacy file absent", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(migrateLegacySingleServerAuth(deps, ID_A)).toBe("no-legacy");
  });
});

describe("parseProfileFromArgv", () => {
  test("accepts valid slugs", () => {
    expect(parseProfileFromArgv(["node", "x", "--profile", "bob"])).toBe("bob");
    expect(parseProfileFromArgv(["--profile", "bob-1"])).toBe("bob-1");
    expect(parseProfileFromArgv(["--profile", "alpha_2"])).toBe("alpha_2");
  });

  test("rejects uppercase and invalid patterns", () => {
    expect(() => parseProfileFromArgv(["--profile", "BOB"])).toThrow(/lowercase/);
    expect(() => parseProfileFromArgv(["--profile", ""])).toThrow();
    expect(() => parseProfileFromArgv(["--profile", "a".repeat(33)])).toThrow();
    expect(() => parseProfileFromArgv(["--profile", "hi space"])).toThrow();
    expect(() => parseProfileFromArgv(["--profile", "oops/"])).toThrow();
  });
});

describe("migrateLegacyAuthV1IfDefaultInstance", () => {
  test("migrates v1 bundle when default instance, no profile, primary absent", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    const legacyPath = "/legacy/auth.json";
    const raw = JSON.stringify(SAMPLE_BUNDLE);
    const enc = deps.safeStorage.encryptString(raw);
    (deps.fs as ReturnType<typeof makeFs>).files.set(
      legacyPath,
      Buffer.concat([HEADER_ENC_V1, enc]),
    );

    const r = migrateLegacyAuthV1IfDefaultInstance(deps, {
      legacyPath,
      identity: ID_A,
      isDefaultInstance: true,
    });
    expect(r).toBe("migrated");
    expect((deps.fs as ReturnType<typeof makeFs>).files.has(legacyPath)).toBe(false);
    const loaded = loadTokens(deps, { expectedIdentity: ID_A });
    expect(loaded).toEqual(SAMPLE_BUNDLE);
  });

  test("returns no-legacy when legacy file absent", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    const r = migrateLegacyAuthV1IfDefaultInstance(deps, {
      legacyPath: "/nope/auth.json",
      identity: ID_A,
      isDefaultInstance: true,
    });
    expect(r).toBe("no-legacy");
  });

  test("skips when profile is set", () => {
    const deps = makeDeps({ encryptionAvailable: true, profile: "bob" });
    const legacyPath = "/legacy/auth.json";
    const raw = JSON.stringify(SAMPLE_BUNDLE);
    (deps.fs as ReturnType<typeof makeFs>).files.set(
      legacyPath,
      Buffer.concat([HEADER_PT_V1, Buffer.from(raw, "utf-8")]),
    );
    const r = migrateLegacyAuthV1IfDefaultInstance(deps, {
      legacyPath,
      identity: ID_A,
      isDefaultInstance: true,
    });
    expect(r).toBe("skipped");
  });

  test("skips when not default instance", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    const legacyPath = "/legacy/auth.json";
    const raw = JSON.stringify(SAMPLE_BUNDLE);
    (deps.fs as ReturnType<typeof makeFs>).files.set(
      legacyPath,
      Buffer.concat([HEADER_PT_V1, Buffer.from(raw, "utf-8")]),
    );
    const r = migrateLegacyAuthV1IfDefaultInstance(deps, {
      legacyPath,
      identity: ID_A,
      isDefaultInstance: false,
    });
    expect(r).toBe("skipped");
  });

  test("skips when primary auth file already exists", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    saveTokens(deps, { bundle: SAMPLE_BUNDLE, identity: ID_A });
    const legacyPath = "/legacy/auth.json";
    const raw = JSON.stringify(SAMPLE_BUNDLE);
    (deps.fs as ReturnType<typeof makeFs>).files.set(
      legacyPath,
      Buffer.concat([HEADER_PT_V1, Buffer.from(raw, "utf-8")]),
    );
    const r = migrateLegacyAuthV1IfDefaultInstance(deps, {
      legacyPath,
      identity: ID_A,
      isDefaultInstance: true,
    });
    expect(r).toBe("skipped");
  });
});

describe("local-auth-audit", () => {
  test("appendAuthBundleClearedAudit writes JSONL without token fields", () => {
    const lines: string[] = [];
    const auditPath = "/tmp-test/audit.log";
    appendAuthBundleClearedAudit({
      expected: ID_A,
      disk: ID_OTHER_SERVER,
      auditLogPath: auditPath,
      fs: {
        mkdirSync: () => {},
        appendFileSync: (_p, data) => lines.push(data),
        chmodSync: () => {},
      },
      now: () => new Date("2026-05-28T12:00:00.000Z"),
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      kind: "auth.bundle_cleared",
      reason: "env_pinned_mismatch",
      ts: "2026-05-28T12:00:00.000Z",
    });
    expect(JSON.stringify(parsed)).not.toContain("access_token");
    expect(defaultLocalAuthAuditLogPath()).toContain("audit.log");
  });
});
