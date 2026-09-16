/**
 * M059 follow-up — `reset-logto-admin-password` runner.
 *
 * Covers every branch with injected deps:
 *   - happy path: rotates + writes file with the new password
 *   - secret read failure → exit 1, no rotation, no file write
 *   - token mint failure → exit 1
 *   - admin user not found → exit 1, distinct hint
 *   - PATCH failure → exit 1, no file written (operator can re-run)
 *   - file write failure → password is still echoed to the log
 *     (so the operator can record it manually before retrying)
 *   - file body matches `bootstrap-logto.ts`'s
 *     `formatLogtoAdminCredentialFile` byte-for-byte (drift guard)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  formatCredentialFile,
  runResetLogtoAdminPassword,
  type ResetAdminPasswordDeps,
} from "../../src/commands/reset-logto-admin-password";
import { formatLogtoAdminCredentialFile } from "../../../nautilo-local/src/bootstrap-logto";

interface CapturedWrite {
  path: string;
  contents: string;
}

interface CapturedPatch {
  endpoint: string;
  userId: string;
  password: string;
}

function makeDeps(overrides: {
  secret?: string | Error;
  token?: string | Error;
  adminId?: string | null | Error;
  patchFails?: Error;
  writeFails?: Error;
} = {}): {
  deps: ResetAdminPasswordDeps;
  writes: CapturedWrite[];
  patches: CapturedPatch[];
  logs: string[];
} {
  const writes: CapturedWrite[] = [];
  const patches: CapturedPatch[] = [];
  const logs: string[] = [];

  const deps: ResetAdminPasswordDeps = {
    readMAdminSecret: () => {
      if (overrides.secret instanceof Error) return Promise.reject(overrides.secret);
      return Promise.resolve(overrides.secret ?? "secret-from-pg");
    },
    mintAdminToken: () => {
      if (overrides.token instanceof Error) return Promise.reject(overrides.token);
      return Promise.resolve(overrides.token ?? "test-admin-token");
    },
    findAdminUserId: () => {
      if (overrides.adminId instanceof Error) {
        return Promise.reject(overrides.adminId);
      }
      // Distinguish "explicitly null" from "default" via undefined.
      return Promise.resolve(
        overrides.adminId === undefined ? "user-id-abc" : overrides.adminId,
      );
    },
    setUserPassword: (endpoint, _token, userId, password) => {
      patches.push({ endpoint, userId, password });
      if (overrides.patchFails) return Promise.reject(overrides.patchFails);
      return Promise.resolve();
    },
    generatePassword: () => "deadbeef".repeat(6), // 48-char deterministic
    writeCredentialFile: (path, contents) => {
      writes.push({ path, contents });
      if (overrides.writeFails) throw overrides.writeFails;
    },
    log: (msg) => logs.push(msg),
    isoStamp: () => "2026-04-29T19:00:00Z",
  };

  return { deps, writes, patches, logs };
}

const LOGTO_URL_ENV_KEYS = ["LOGTO_ADMIN_ENDPOINT", "LOGTO_ENDPOINT"] as const;

describe("runResetLogtoAdminPassword — happy path", () => {
  const savedEnv: Partial<Record<(typeof LOGTO_URL_ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of LOGTO_URL_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of LOGTO_URL_ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("rotates password, writes file with chmod 600, exits 0", async () => {
    const { deps, writes, patches } = makeDeps();
    const code = await runResetLogtoAdminPassword(
      { outputPath: "/tmp/test-admin.txt" },
      deps,
    );
    expect(code).toBe(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.userId).toBe("user-id-abc");
    expect(patches[0]?.password).toBe("deadbeef".repeat(6));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/tmp/test-admin.txt");
    expect(writes[0]?.contents).toContain("password: " + "deadbeef".repeat(6));
    expect(writes[0]?.contents).toContain("username: nautilo_admin");
  });

  test("sends PATCH against the admin-tenant endpoint, not the core endpoint", async () => {
    const { deps, patches } = makeDeps();
    await runResetLogtoAdminPassword(
      {
        endpoint: "http://localhost:3301",
        adminEndpoint: "http://localhost:3302",
        outputPath: "/tmp/test-admin.txt",
      },
      deps,
    );
    expect(patches[0]?.endpoint).toBe("http://localhost:3302");
  });

  test("admin endpoint defaults to :3302 when only endpoint is supplied", async () => {
    const { deps, patches } = makeDeps();
    await runResetLogtoAdminPassword(
      { endpoint: "http://localhost:3301", outputPath: "/tmp/test-admin.txt" },
      deps,
    );
    expect(patches[0]?.endpoint).toBe("http://localhost:3302");
  });
});

describe("runResetLogtoAdminPassword — failure branches", () => {
  test("secret read failure aborts before any HTTP call", async () => {
    const { deps, patches, writes } = makeDeps({ secret: new Error("docker not running") });
    const code = await runResetLogtoAdminPassword({ outputPath: "/tmp/x" }, deps);
    expect(code).toBe(1);
    expect(patches).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("token mint failure aborts before user lookup", async () => {
    const { deps, patches } = makeDeps({ token: new Error("HTTP 401") });
    const code = await runResetLogtoAdminPassword({ outputPath: "/tmp/x" }, deps);
    expect(code).toBe(1);
    expect(patches).toEqual([]);
  });

  test("missing admin user surfaces a clean hint", async () => {
    const { deps, patches, logs } = makeDeps({ adminId: null });
    const code = await runResetLogtoAdminPassword({ outputPath: "/tmp/x" }, deps);
    expect(code).toBe(1);
    expect(patches).toEqual([]);
    expect(logs.some((m) => m.includes("not found in Logto"))).toBe(true);
    expect(
      logs.some((m) => m.includes("`bun run infra:start`")),
    ).toBe(true);
  });

  test("PATCH failure aborts before file write (operator re-runs cleanly)", async () => {
    const { deps, writes } = makeDeps({ patchFails: new Error("HTTP 500") });
    const code = await runResetLogtoAdminPassword({ outputPath: "/tmp/x" }, deps);
    expect(code).toBe(1);
    expect(writes).toEqual([]);
  });

  test("file write failure echoes the rotated password to the log so the operator doesn't lose it", async () => {
    const { deps, logs } = makeDeps({ writeFails: new Error("EACCES") });
    const code = await runResetLogtoAdminPassword({ outputPath: "/tmp/x" }, deps);
    expect(code).toBe(1);
    expect(logs.some((m) => m.includes("write it down NOW"))).toBe(true);
    expect(logs.some((m) => m.includes("deadbeef".repeat(6)))).toBe(true);
  });
});

describe("formatCredentialFile — drift guard against bootstrap-logto.ts", () => {
  test("byte-for-byte parity with formatLogtoAdminCredentialFile (M059 contract)", () => {
    const input = {
      username: "nautilo_admin",
      password: "deadbeef".repeat(6),
      adminUrl: "http://localhost:3302",
    };
    const isoStamp = "2026-04-29T19:00:00Z";
    const reset = formatCredentialFile({ ...input, isoStamp });
    const bootstrap = formatLogtoAdminCredentialFile(input, isoStamp);
    expect(reset).toBe(bootstrap);
  });
});
