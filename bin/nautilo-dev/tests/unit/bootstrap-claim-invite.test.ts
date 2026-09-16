/**
 * M073 — bootstrap claim invite helper (mocked DB; no Postgres).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import { credentials, invites, users } from "@nautilo/db";
import {
  bootstrapClaimInvite,
  CLAIM_INVITE_FILENAME,
  formatClaimInviteBanner,
  formatClaimInviteFile,
  parseClaimInviteFileContent,
  resolveDefaultPublicInviteBaseUrl,
} from "../../src/lib/bootstrap-claim-invite";

function makeThenable<T>(rows: T[]): Promise<T[]> & { then: typeof Promise.prototype.then } {
  const p = Promise.resolve(rows);
  return p as Promise<T[]> & { then: typeof Promise.prototype.then };
}

type MockOpts = {
  tableExists: boolean;
  userCount: number;
  firstHandle?: string | null;
  hasUnredeemedClaim: boolean;
  /**
   * Result of `findClaimedOwnerIdWithDb` — the user id of a user with
   * an associated `credentials` row, or `null` if no real claim has
   * happened. Defaults to `null` so the placeholder/seed-user shape is
   * the default mock behavior; tests that simulate "already claimed"
   * set this to a non-null uuid.
   */
  claimedOwnerId?: string | null;
};

function createMockDb(
  opts: MockOpts,
  onInsert?: (vals: Record<string, unknown>) => void,
  insertBehavior?: "ok" | "reject",
) {
  const claimedOwnerId = opts.claimedOwnerId ?? null;
  return {
    execute: async () => [{ reg: opts.tableExists ? "invites" : null }],
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === users && "n" in fields) {
          return makeThenable([{ n: opts.userCount }]);
        }
        if (table === users && "id" in fields) {
          // findClaimedOwnerIdWithDb requires the complete durable-owner
          // projection: PIN credential + profile + owners-group membership.
          // Preserve that exact four-join query shape in this mocked-DB unit.
          const joinedOwnerQuery = {
            innerJoin: () => joinedOwnerQuery,
            where: () => ({
              orderBy: () => ({
                limit: () =>
                  makeThenable(
                    claimedOwnerId !== null ? [{ id: claimedOwnerId }] : [],
                  ),
              }),
            }),
          };
          return joinedOwnerQuery;
        }
        if (table === users && "handle" in fields) {
          const handle =
            opts.firstHandle !== undefined && opts.firstHandle !== null
              ? opts.firstHandle
              : "alice";
          return {
            // Post-fix shape: select handle where(id = <claimedOwnerId>) limit 1
            where: () => ({
              limit: () => makeThenable([{ handle }]),
            }),
            // Legacy shape (no longer hit, kept for safety): order by created_at desc
            orderBy: () => ({
              limit: () => makeThenable([{ handle }]),
            }),
          };
        }
        if (table === credentials) {
          // findClaimedOwnerIdWithDb builds an `exists(...)` subquery
          // over credentials. The mock never executes the subquery
          // standalone — it only needs to accept the chained where()
          // call so the outer query builder constructs successfully.
          return {
            where: () => ({
              limit: () => makeThenable([]),
            }),
          };
        }
        if (table === invites && "id" in fields) {
          return {
            where: () => ({
              limit: () =>
                makeThenable(
                  opts.hasUnredeemedClaim
                    ? [{ id: "00000000-0000-0000-0000-000000000001" }]
                    : [],
                ),
            }),
          };
        }
        throw new Error("unexpected select shape in mock");
      },
    }),
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        onInsert?.(vals);
        if (insertBehavior === "reject") {
          return Promise.reject(new Error("insert failed"));
        }
        return Promise.resolve();
      },
    }),
    end: async () => {},
  };
}

describe("resolveDefaultPublicInviteBaseUrl", () => {
  const orig = process.env["NAUTILO_PUBLIC_BASE_URL"];
  const origHome = process.env["HOME"];
  const origInstanceId = process.env["NAUTILO_INSTANCE_ID"];
  const origPort = process.env["NAUTILO_PORT"];
  const origServerUrl = process.env["NAUTILO_SERVER_URL"];
  let tmpHome: string | null = null;

  afterEach(() => {
    __resetResolvedInstanceForTests();
    if (orig === undefined) delete process.env["NAUTILO_PUBLIC_BASE_URL"];
    else process.env["NAUTILO_PUBLIC_BASE_URL"] = orig;
    if (origHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHome;
    if (origInstanceId === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = origInstanceId;
    if (origPort === undefined) delete process.env["NAUTILO_PORT"];
    else process.env["NAUTILO_PORT"] = origPort;
    if (origServerUrl === undefined) delete process.env["NAUTILO_SERVER_URL"];
    else process.env["NAUTILO_SERVER_URL"] = origServerUrl;
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  });

  test("uses NAUTILO_PUBLIC_BASE_URL when set (trailing slash stripped)", () => {
    process.env["NAUTILO_PUBLIC_BASE_URL"] = "https://example.com/";
    expect(resolveDefaultPublicInviteBaseUrl()).toBe("https://example.com");
  });

  test("defaults to http://localhost:3001", () => {
    tmpHome = mkdtempSync(join(tmpdir(), "nautilo-claim-url-"));
    delete process.env["NAUTILO_PUBLIC_BASE_URL"];
    delete process.env["NAUTILO_INSTANCE_ID"];
    delete process.env["NAUTILO_PORT"];
    delete process.env["NAUTILO_SERVER_URL"];
    process.env["HOME"] = tmpHome;
    __resetResolvedInstanceForTests();
    expect(resolveDefaultPublicInviteBaseUrl()).toBe("http://localhost:3001");
  });
});

describe("formatClaimInviteFile", () => {
  test("includes redeem input, token, and header lines", () => {
    const out = formatClaimInviteFile(
      {
        redeemInput: "inv_abc",
        token: "inv_abc",
      },
      "2026-05-04T12:00:00.000Z",
    );
    expect(out).toContain("# Nautilo bootstrap claim invite");
    expect(out).toContain("# Created: 2026-05-04T12:00:00.000Z");
    expect(out).toContain("redeem_input: inv_abc");
    expect(out).toContain("token: inv_abc");
    expect(out).toContain("open the redeem_input URL");
    expect(out).toContain("Workbench or the Desktop app");
  });
});

describe("formatClaimInviteBanner", () => {
  test("boxed minted banner shape", () => {
    const b = formatClaimInviteBanner({
      redeemInput: "inv_x",
      filePath: `/Users/me/.nautilo/${CLAIM_INVITE_FILENAME}`,
      bootstrapClaimInvitePath: "/Users/me/.nautilo/.bootstrap/claim-invite",
    });
    expect(b).toContain("Nautilo bootstrap claim invite");
    expect(b).toContain("Redeem input : inv_x");
    expect(b).toContain(`Written to   : /Users/me/.nautilo/${CLAIM_INVITE_FILENAME}`);
    expect(b).toContain("Bootstrap dir : /Users/me/.nautilo/.bootstrap/claim-invite");
  });

  test("reprint headline when unredeemed invite already exists", () => {
    const b = formatClaimInviteBanner({
      redeemInput: "inv_x",
      filePath: `/Users/me/.nautilo/${CLAIM_INVITE_FILENAME}`,
      reprint: true,
    });
    expect(b).toContain("STILL UNREDEEMED");
  });
});

describe("parseClaimInviteFileContent", () => {
  test("extracts redeem input and token lines", () => {
    const raw = [
      "# header",
      "redeem_input: inv_abc",
      "token: inv_abc",
    ].join("\n");
    expect(parseClaimInviteFileContent(raw)).toEqual({
      redeemInput: "inv_abc",
      token: "inv_abc",
    });
  });

  test("accepts legacy url lines", () => {
    const raw = [
      "# header",
      "url: http://localhost:3001/redeem/inv_abc",
      "token: inv_abc",
    ].join("\n");
    expect(parseClaimInviteFileContent(raw)).toEqual({
      redeemInput: "http://localhost:3001/redeem/inv_abc",
      token: "inv_abc",
    });
  });

  test("returns null when redeem input line missing", () => {
    expect(parseClaimInviteFileContent("token: inv_only")).toBeNull();
  });
});

describe("bootstrapClaimInvite", () => {
  test("skipped-no-table when invites relation missing", async () => {
    const logs: string[] = [];
    const db = createMockDb({
      tableExists: false,
      userCount: 0,
      hasUnredeemedClaim: false,
    });
    const r = await bootstrapClaimInvite({
      db: db as never,
      log: (m) => logs.push(m),
    });
    expect(r.outcome.kind).toBe("skipped-no-table");
    expect(logs.some((l) => l.includes("invites table missing"))).toBe(true);
  });

  test("already-claimed when a claimer with credentials exists and no unredeemed claim invite", async () => {
    const logs: string[] = [];
    const db = createMockDb({
      tableExists: true,
      userCount: 2,
      firstHandle: "owner",
      hasUnredeemedClaim: false,
      // Real claim happened — at least one user has a `credentials` row.
      claimedOwnerId: "11111111-1111-1111-1111-111111111111",
    });
    const r = await bootstrapClaimInvite({
      db: db as never,
      log: (m) => logs.push(m),
    });
    expect(r.outcome.kind).toBe("already-claimed");
    if (r.outcome.kind === "already-claimed") {
      expect(r.outcome.firstUserHandle).toBe("owner");
    }
    expect(
      logs.some((l) =>
        l.includes("first user @owner already claimed (credentials present)"),
      ),
    ).toBe(true);
  });

  test("seed-user-only DB (server:start ran but no claim ever happened) MINTS a fresh claim invite", async () => {
    // Regression guard for the M118-followup bug where `server:start →
    // infra:start` left the operator stuck: the bootstrap dummy
    // `users` row (no credentials) was masquerading as "claimed",
    // skipping the mint and leaving no recovery path.
    const logs: string[] = [];
    const tmpDir = mkdtempSync(join(tmpdir(), "nautilo-claim-seed-user-"));
    const target = join(tmpDir, "claim-invite.txt");
    try {
      const db = createMockDb({
        tableExists: true,
        userCount: 1,
        firstHandle: "user",
        hasUnredeemedClaim: false,
        claimedOwnerId: null, // seed placeholder — no credentials row.
      });
      const r = await bootstrapClaimInvite({
        db: db as never,
        log: (m) => logs.push(m),
        resolveClaimInvitePath: () => target,
      });
      expect(r.outcome.kind).toBe("minted");
      expect(logs.some((l) => l.includes("already claimed"))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("seeded owner row does not block — unredeemed claim + users still reprints from file", async () => {
    const logs: string[] = [];
    const db = createMockDb({
      tableExists: true,
      userCount: 1,
      firstHandle: "user",
      hasUnredeemedClaim: true,
    });
    const target = "/tmp/claim-invite-seeded-owner.txt";
    const fileBody = formatClaimInviteFile(
      { redeemInput: "inv_seed", token: "inv_seed" },
      "2026-05-05T12:00:00.000Z",
    );
    const r = await bootstrapClaimInvite({
      db: db as never,
      log: (m) => logs.push(m),
      resolveClaimInvitePath: () => target,
      existsSync: () => true,
      readFile: () => fileBody,
    });
    expect(r.outcome.kind).toBe("preserved-existing");
    if (r.outcome.kind === "preserved-existing") {
      expect(r.outcome.reprintRedeemInput).toBe("inv_seed");
    }
    expect(logs.some((l) => l.includes("users already exist"))).toBe(false);
  });

  test("preserved-existing when an unredeemed claim row exists — reprints redeem input from file", async () => {
    const logs: string[] = [];
    const db = createMockDb({
      tableExists: true,
      userCount: 0,
      hasUnredeemedClaim: true,
    });
    const target = "/tmp/claim-invite-test-path.txt";
    const fileBody = formatClaimInviteFile(
      { redeemInput: "inv_fromfile", token: "inv_fromfile" },
      "2026-05-04T12:00:00.000Z",
    );
    const r = await bootstrapClaimInvite({
      db: db as never,
      log: (m) => logs.push(m),
      resolveClaimInvitePath: () => target,
      existsSync: () => true,
      readFile: () => fileBody,
    });
    expect(r.outcome.kind).toBe("preserved-existing");
    if (r.outcome.kind === "preserved-existing") {
      expect(r.outcome.filePath).toBe(target);
      expect(r.outcome.reprintRedeemInput).toBe("inv_fromfile");
    }
    expect(logs.some((l) => l.includes("repeating redeem input from"))).toBe(true);
  });

  test("preserved-existing without readable redeem input — no reprintRedeemInput", async () => {
    const logs: string[] = [];
    const db = createMockDb({
      tableExists: true,
      userCount: 0,
      hasUnredeemedClaim: true,
    });
    const target = "/missing/claim-invite.txt";
    const r = await bootstrapClaimInvite({
      db: db as never,
      log: (m) => logs.push(m),
      resolveClaimInvitePath: () => target,
      existsSync: () => false,
    });
    expect(r.outcome.kind).toBe("preserved-existing");
    if (r.outcome.kind === "preserved-existing") {
      expect(r.outcome.reprintRedeemInput).toBeUndefined();
    }
    expect(logs.some((l) => l.includes("missing or has no redeem_input/url"))).toBe(true);
  });

  test("minted writes legacy + `.bootstrap/claim-invite` before inserting claim row", async () => {
    const logs: string[] = [];
    const writes: { path: string; body: string }[] = [];
    const order: string[] = [];
    let inserted: Record<string, unknown> | undefined;
    const db = createMockDb(
      {
        tableExists: true,
        userCount: 0,
        hasUnredeemedClaim: false,
      },
      (vals) => {
        order.push("insert");
        inserted = vals;
      },
    );
    const fixed = Buffer.alloc(24, 0xab);
    const tmpHome = mkdtempSync(join(tmpdir(), "nautilo-claim-home-"));
    const inst = "mintdual";
    const instanceRoot = join(tmpHome, `.nautilo-${inst}`);
    const target = join(instanceRoot, CLAIM_INVITE_FILENAME);
    mkdirSync(instanceRoot, { recursive: true });
    const prevHome = process.env["HOME"];
    process.env["HOME"] = tmpHome;
    __resetResolvedInstanceForTests();
    try {
      const r = await bootstrapClaimInvite({
        db: db as never,
        log: (m) => logs.push(m),
        writeFile: (path, contents) => {
          order.push("write");
          writes.push({ path, body: contents });
        },
        resolveClaimInvitePath: () => target,
        resolvePublicInviteBaseUrl: () => "http://localhost:3001",
        currentInstanceId: () => inst,
        operatorHomeDir: tmpHome,
        isoStamp: () => "2026-05-04T08:01:23.456Z",
        randomBytes: () => fixed,
      });
      expect(r.outcome.kind).toBe("minted");
      if (r.outcome.kind !== "minted") throw new Error("expected minted");
      const expectedToken =
        "inv_" + fixed.toString("base64url");
      expect(r.outcome.token).toBe(expectedToken);
      expect(r.outcome.redeemInput).toBe(expectedToken);
      expect(r.outcome.bootstrapClaimInvitePath).toBe(
        join(instanceRoot, ".bootstrap", "claim-invite"),
      );
      expect(inserted?.["kind"]).toBe("claim");
      expect(inserted?.["maxUses"]).toBe(1);
      expect(inserted?.["createdBy"]).toBeNull();
      expect(inserted?.["displayName"]).toBe("Bootstrap claim invite");
      expect(writes.length).toBe(1);
      expect(writes[0]?.path).toBe(target);
      expect(writes[0]?.body).toContain(`token: ${expectedToken}`);
      expect(writes[0]?.body).toContain(`redeem_input: ${r.outcome.redeemInput}`);
      expect(order).toEqual(["write", "insert"]);
      expect(existsSync(r.outcome.bootstrapClaimInvitePath)).toBe(true);
      expect(readFileSync(r.outcome.bootstrapClaimInvitePath, "utf8").trim()).toBe(expectedToken);
      expect(logs.some((l) => l.includes("claim invite written to"))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      __resetResolvedInstanceForTests();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("minted removes claim file when DB insert fails (no stranded invite)", async () => {
    const logs: string[] = [];
    const writes: { path: string; body: string }[] = [];
    const unlinked: string[] = [];
    const db = createMockDb(
      {
        tableExists: true,
        userCount: 0,
        hasUnredeemedClaim: false,
      },
      undefined,
      "reject",
    );
    const fixed = Buffer.alloc(24, 3);
    const tmpHome = mkdtempSync(join(tmpdir(), "nautilo-claim-fail-"));
    const inst = "faildual";
    const instanceRoot = join(tmpHome, `.nautilo-${inst}`);
    const target = join(instanceRoot, CLAIM_INVITE_FILENAME);
    const bootstrapClaim = join(instanceRoot, ".bootstrap", "claim-invite");
    mkdirSync(instanceRoot, { recursive: true });
    const prevHome = process.env["HOME"];
    process.env["HOME"] = tmpHome;
    __resetResolvedInstanceForTests();
    let threw = false;
    try {
      try {
        await bootstrapClaimInvite({
          db: db as never,
          log: (m) => logs.push(m),
          writeFile: (path, contents) => writes.push({ path, body: contents }),
          unlinkFile: (p) => unlinked.push(p),
          resolveClaimInvitePath: () => target,
          resolvePublicInviteBaseUrl: () => "http://localhost:3001",
          currentInstanceId: () => inst,
          operatorHomeDir: tmpHome,
          isoStamp: () => "2026-05-04T08:01:23.456Z",
          randomBytes: () => fixed,
        });
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toContain("insert failed");
      }
      expect(threw).toBe(true);
      expect(writes.length).toBe(1);
      expect(unlinked).toContain(target);
      expect(unlinked).toContain(bootstrapClaim);
    } finally {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      __resetResolvedInstanceForTests();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
