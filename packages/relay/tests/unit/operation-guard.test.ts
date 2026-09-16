import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  guardDesktopFilesystemOperation,
  type DesktopFilesystemOperationGuardInput,
} from "../../src/operation-guard";
import type {
  DesktopFilesystemAccessOperation,
  DesktopFilesystemGrant,
  DesktopFilesystemGrantSubject,
} from "@nautilo/desktop-filesystem-grants";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const ROOT = path.join(path.sep, "Users", "alice", "approved");
const SUBJECT: DesktopFilesystemGrantSubject = {
  userId: "user-1",
  instanceId: "instance-1",
  relayId: "relay-1",
  agentScope: "agent-1",
};

function grant(overrides: Partial<DesktopFilesystemGrant> = {}): DesktopFilesystemGrant {
  return {
    schemaVersion: 1,
    id: "grant-1",
    canonicalRoot: ROOT,
    access: ["read"],
    origin: "user_picker",
    lifetime: "durable",
    subject: SUBJECT,
    createdBy: "alice",
    createdAt: "2029-01-01T00:00:00.000Z",
    policyVersion: 1,
    ...overrides,
  };
}

function check(
  overrides: Partial<DesktopFilesystemOperationGuardInput> = {},
  operation: DesktopFilesystemAccessOperation = "read",
) {
  return guardDesktopFilesystemOperation({
    candidatePath: path.join(ROOT, "project", "notes.md"),
    operation,
    grants: [],
    subject: SUBJECT,
    now: NOW,
    ...overrides,
  });
}

function expectFailure(
  result: ReturnType<typeof guardDesktopFilesystemOperation>,
  code: Exclude<ReturnType<typeof guardDesktopFilesystemOperation>, { ok: true }>["code"],
) {
  expect(result).toEqual({ ok: false, code });
}

describe("guardDesktopFilesystemOperation", () => {
  test("selects a matching grant and reports its root and opaque id", () => {
    expect(check({ grants: [grant()] })).toEqual({
      ok: true,
      authority: "grant",
      authorityId: "grant-1",
      root: ROOT,
      grantId: "grant-1",
    });
  });

  test("selects the narrowest authority that permits the requested operation", () => {
    const narrowRoot = path.join(ROOT, "project");
    expect(
      check({
        grants: [
          grant({ id: "broad-read", access: ["read"] }),
          grant({ id: "narrow-write", canonicalRoot: narrowRoot, access: ["create_modify"] }),
        ],
      }),
    ).toMatchObject({ ok: true, authority: "grant", grantId: "broad-read" });
    expect(
      check(
        {
          grants: [
            grant({ id: "broad-read", access: ["read"] }),
            grant({ id: "narrow-write", canonicalRoot: narrowRoot, access: ["create_modify"] }),
          ],
        },
        "create_modify",
      ),
    ).toMatchObject({ ok: true, authority: "grant", root: narrowRoot, grantId: "narrow-write" });
  });

  test("permits an explicit baseline only for its declared operation subset", () => {
    const baselineRoot = path.join(ROOT, "current-folder");
    const candidatePath = path.join(baselineRoot, "draft.md");
    expect(
      check({
        candidatePath,
        baselineAuthorities: [{ id: "current-folder", root: baselineRoot, access: ["read"] }],
      }),
    ).toEqual({ ok: true, authority: "baseline", authorityId: "current-folder", root: baselineRoot });
    expectFailure(
      check(
        { candidatePath, baselineAuthorities: [{ id: "current-folder", root: baselineRoot, access: ["read"] }] },
        "delete",
      ),
      "OPERATION_UPGRADE",
    );
  });

  test("does not turn a baseline root into implicit authority beyond its boundary", () => {
    const baselineRoot = path.join(ROOT, "current-folder");
    expectFailure(
      check({
        candidatePath: path.join(ROOT, "other-folder", "draft.md"),
        baselineAuthorities: [{ id: "current-folder", root: baselineRoot, access: ["read"] }],
      }),
      "ROOT_EXPANSION",
    );
  });

  test("rejects non-absolute and null-byte candidate paths", () => {
    expectFailure(check({ candidatePath: "relative/file.txt" }), "INVALID_PATH");
    expectFailure(check({ candidatePath: `${ROOT}\0evil` }), "INVALID_PATH");
  });

  test("requires an explicit supported requested operation", () => {
    expectFailure(
      guardDesktopFilesystemOperation({
        candidatePath: path.join(ROOT, "project", "notes.md"),
        operation: undefined as unknown as DesktopFilesystemAccessOperation,
        grants: [grant()],
        subject: SUBJECT,
        now: NOW,
      }),
      "INVALID_OPERATION",
    );
  });

  test("rejects grants bound to another user, instance, relay, or agent scope", () => {
    for (const subject of [
      { ...SUBJECT, userId: "other-user" },
      { ...SUBJECT, instanceId: "other-instance" },
      { ...SUBJECT, relayId: "other-relay" },
      { ...SUBJECT, agentScope: "other-agent" },
    ]) {
      expectFailure(check({ grants: [grant({ subject })] }), "SUBJECT_MISMATCH");
    }
  });

  test("rejects revoked and expired matching grants", () => {
    expectFailure(check({ grants: [grant({ revokedAt: "2029-02-01T00:00:00.000Z" })] }), "REVOKED");
    expectFailure(
      check({ grants: [grant({ expiresAt: "2029-12-31T23:59:59.999Z" })] }),
      "EXPIRED",
    );
  });

  test("treats a requested operation missing from a matching grant as an operation upgrade", () => {
    expectFailure(check({ grants: [grant({ access: ["read"] })] }, "delete"), "OPERATION_UPGRADE");
  });

  test("treats a candidate outside every local authority as root expansion", () => {
    expectFailure(
      check({
        candidatePath: path.join(ROOT, "not-approved", "notes.md"),
        grants: [grant({ canonicalRoot: path.join(ROOT, "approved-subtree") })],
      }),
      "ROOT_EXPANSION",
    );
  });

  test("reports grant not found when no local authority exists", () => {
    expectFailure(check(), "GRANT_NOT_FOUND");
  });

  test("uses separator-aware matching for sibling prefixes and filesystem root", () => {
    expectFailure(
      check({
        candidatePath: path.join(path.sep, "approved-sibling", "notes.md"),
        grants: [grant({ canonicalRoot: path.join(path.sep, "approved") })],
      }),
      "ROOT_EXPANSION",
    );
    expect(
      check({
        candidatePath: path.join(path.sep, "anywhere", "notes.md"),
        grants: [grant({ canonicalRoot: path.parse(ROOT).root })],
      }),
    ).toMatchObject({ ok: true, authority: "grant", grantId: "grant-1" });
  });
});
