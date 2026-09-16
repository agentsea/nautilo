import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invites } from "@nautilo/db";

import { mintClaimInvite } from "../../src/lib/mint-claim-invite";

function makeThenable<T>(rows: T[]): Promise<T[]> & { then: typeof Promise.prototype.then } {
  const p = Promise.resolve(rows);
  return p as Promise<T[]> & { then: typeof Promise.prototype.then };
}

type MockOpts = {
  tableExists: boolean;
  hasUnredeemedClaim: boolean;
};

function createMockDb(
  opts: MockOpts,
  onInsert?: (vals: Record<string, unknown>) => void,
) {
  return {
    execute: async () => [{ reg: opts.tableExists ? "invites" : null }],
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => {
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
        return Promise.resolve();
      },
    }),
    end: async () => {},
  };
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
});

function trackTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nautilo-server-mint-claim-"));
  tmpDirs.push(d);
  return d;
}

describe("mintClaimInvite (server helper)", () => {
  test("returns token and inserts claim row on happy path", async () => {
    const inserts: Record<string, unknown>[] = [];
    const tokenBytes = Buffer.alloc(24, 0xab);

    const result = await mintClaimInvite({
      db: createMockDb({ tableExists: true, hasUnredeemedClaim: false }, (v) => {
        inserts.push(v);
      }) as never,
      randomBytes: () => tokenBytes,
      hasUnredeemedClaimInviteFn: async () => false,
    });

    expect(result.alreadyExists).toBe(false);
    expect(result.token).toMatch(/^inv_[A-Za-z0-9_-]+$/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!["kind"]).toBe("claim");
    expect(inserts[0]!["maxUses"]).toBe(1);
  });

  test("writes bootstrap files when instanceRootDir is provided", async () => {
    const root = trackTmp();
    const tokenBytes = Buffer.alloc(24, 0xcd);

    const result = await mintClaimInvite({
      db: createMockDb({ tableExists: true, hasUnredeemedClaim: false }) as never,
      randomBytes: () => tokenBytes,
      writeFile: (path, contents, opts) => {
        writeFileSync(path, contents, { encoding: "utf-8", mode: opts.mode });
      },
      chmod: (path, mode) => chmodSync(path, mode),
      mkdir: (path, opts) => mkdirSync(path, opts),
      instanceRootDir: root,
      hasUnredeemedClaimInviteFn: async () => false,
    });

    const bootstrapPath = join(root, ".bootstrap", "claim-invite");
    expect(result.token).not.toBe(null);
    expect(readFileSync(bootstrapPath, "utf8").trim()).toBe(result.token!);
  });

  test("skips file writes when instanceRootDir is omitted", async () => {
    const root = trackTmp();
    let writeCalled = false;

    await mintClaimInvite({
      db: createMockDb({ tableExists: true, hasUnredeemedClaim: false }) as never,
      writeFile: () => {
        writeCalled = true;
      },
      hasUnredeemedClaimInviteFn: async () => false,
    });

    expect(writeCalled).toBe(false);
    expect(() => readFileSync(join(root, ".bootstrap", "claim-invite"))).toThrow();
  });

  test("returns alreadyExists when unredeemed claim invite exists", async () => {
    const inserts: Record<string, unknown>[] = [];

    const result = await mintClaimInvite({
      db: createMockDb({ tableExists: true, hasUnredeemedClaim: true }, (v) => {
        inserts.push(v);
      }) as never,
      hasUnredeemedClaimInviteFn: async () => true,
    });

    expect(result.alreadyExists).toBe(true);
    expect(result.token).toBe(null);
    expect(inserts).toHaveLength(0);
  });
});

// Route-level wire test (403 non-loopback without bearer) is deferred to manual QA —
// see ISSUE-M115 Phase 4 "manual server-probe" step (curl against a running server).
