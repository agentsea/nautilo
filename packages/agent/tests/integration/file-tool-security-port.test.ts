/**
 * D079 PR-011 security port — integration tests for B-1 + B-2 through
 * the real `file` tool dispatch pipeline.
 *
 * WHY THIS TEST EXISTS
 *
 * Unit tests pin the individual layers:
 *   - validateBeforeExecution  (tools-validate-before-execution.test.ts) — B-1a
 *   - checkToolAccess          (personal-policy-resolver.test.ts)        — B-1b
 *   - assertRealpathContained  (file-tool-realpath-containment.test.ts)  — B-2a
 *   - native search authority/projection tests (D446 suites)             — B-2b
 *
 * The integration test pins the LAYERS INTEGRATED — the same failure
 * shape that the unit tests individually exclude can still re-emerge
 * if the wiring between them drifts. Specifically: the file tool's
 * read dispatcher, zone resolver, and realpath-containment must agree
 * on what "inside the workspace" means. Current/absolute mutations now
 * execute on the Desktop relay, whose integration suite owns their
 * symlink-containment coverage.
 *
 * Honeypot sentinels — each test plants a unique `NAUTILO_SENTINEL_*`
 * string in a file OUTSIDE the workspace, then tries to reach it via
 * an attack shape. If the sentinel appears in any returned tool
 * output, the test fails loudly. Mirrors the VM smoke harness's
 * honeypot model, scaled to a host-side tmpdir.
 *
 * Does NOT extend the @nautilo/smoke-runner — that's explicitly
 * scanner-scope-only, and extending it to middleware-invocation mode
 * is deferred to ISSUE-D063 Phase 3. See that phase doc for the
 * motivating cases (B-1, B-2).
 */

// Post-M088B, zone: "workspace" requires a real MemoryAccessEnvelope and
// artifact DB rows — not a tmpdir root. Happy-path / grep cases below use
// zone: "absolute" against the same WORKSPACE tmpdir. B-2 symlink-escape cases
// use zone: "current" with currentFolder bound to that tmpdir because absolute
// bypasses realpath containment (see zones.ts). Workspace-artifact dispatch
// is covered separately by file-tool-workspace-artifact.integration.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchFileCommand, type DispatchContext } from "../../src/tools/file/dispatch";
import { expectDispatchString } from "../helpers/dispatch-string";

// Unique sentinels per run so parallel test invocations don't
// collide and so a leaked sentinel shows up in search output even
// if it was planted in an earlier aborted run.
const RUN_ID = randomBytes(6).toString("hex");
/** Simulated agent turn — required for staged write / str_replace paths (D087). */
const TEST_TURN_ID = randomUUID();
const SENTINEL_SSH = `NAUTILO_SENTINEL_SSH_${RUN_ID}`;
const SENTINEL_CREDS = `NAUTILO_SENTINEL_CREDS_${RUN_ID}`;
const SENTINEL_HOSTS = `NAUTILO_SENTINEL_HOSTS_${RUN_ID}`;

let BASE: string;
let WORKSPACE: string;
let CURRENT: string;
let OUT_OF_TREE: string;

async function makeCtx(): Promise<DispatchContext> {
  return {
    zoneCtx: {
      workspaceRoot: WORKSPACE,
      currentFolder: CURRENT,
    },
    ownerId: "test-owner",
    turnId: TEST_TURN_ID,
  };
}

/** B-2 symlink tests need bounded-zone realpath containment; absolute bypasses it. */
async function makeBoundedWorkspaceCtx(): Promise<DispatchContext> {
  return {
    zoneCtx: {
      workspaceRoot: WORKSPACE,
      currentFolder: WORKSPACE,
    },
    ownerId: "test-owner",
    turnId: TEST_TURN_ID,
  };
}

beforeAll(async () => {
  BASE = await fsp.mkdtemp(join(tmpdir(), "nautilo-pr011-security-port-"));
  WORKSPACE = join(BASE, "workspace");
  CURRENT = join(BASE, "current");
  OUT_OF_TREE = join(BASE, "out-of-tree");

  await fsp.mkdir(WORKSPACE, { recursive: true });
  await fsp.mkdir(CURRENT, { recursive: true });
  await fsp.mkdir(OUT_OF_TREE, { recursive: true });

  // Plant honeypot sentinels in files OUTSIDE both zones. Simulate
  // the classes of files a real attacker would want to exfil:
  // SSH keys, cloud creds, system hostfiles.
  await fsp.writeFile(
    join(OUT_OF_TREE, "fake-id-rsa"),
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${SENTINEL_SSH}\n-----END OPENSSH PRIVATE KEY-----\n`,
  );
  await fsp.writeFile(
    join(OUT_OF_TREE, "fake-credentials"),
    `[default]\naws_secret_access_key = ${SENTINEL_CREDS}\n`,
  );
  await fsp.writeFile(
    join(OUT_OF_TREE, "fake-hosts"),
    `127.0.0.1 localhost\n# ${SENTINEL_HOSTS}\n`,
  );
  // Also a whole directory of secrets (grep honeypot).
  await fsp.mkdir(join(OUT_OF_TREE, "secret-dir"), { recursive: true });
  await fsp.writeFile(
    join(OUT_OF_TREE, "secret-dir", "plant1.txt"),
    `${SENTINEL_SSH}\n`,
  );
  await fsp.writeFile(
    join(OUT_OF_TREE, "secret-dir", "plant2.txt"),
    `${SENTINEL_CREDS}\n`,
  );

  // Populate the zones with real content for legitimate-path tests.
  await fsp.writeFile(join(WORKSPACE, "notes.md"), "# My notes\nlegit content\n");
  await fsp.writeFile(join(CURRENT, "draft.md"), "# Draft\nlegit content\n");

  // Plant symlinks INSIDE the workspace pointing at the honeypots
  // — the B-2 attack shape.
  await fsp.symlink(join(OUT_OF_TREE, "fake-id-rsa"), join(WORKSPACE, "hijack-key"));
  await fsp.symlink(
    join(OUT_OF_TREE, "fake-credentials"),
    join(WORKSPACE, "hijack-creds"),
  );
  await fsp.symlink(
    join(OUT_OF_TREE, "secret-dir"),
    join(WORKSPACE, "hijack-dir"),
  );
  // And one in the current folder so we cover both bounded zones.
  await fsp.symlink(join(OUT_OF_TREE, "fake-hosts"), join(CURRENT, "hijack-hosts"));
});

afterAll(async () => {
  await fsp.rm(BASE, { recursive: true, force: true });
});

function assertNoSentinelLeak(out: string, label: string): void {
  const sentinels = [SENTINEL_SSH, SENTINEL_CREDS, SENTINEL_HOSTS];
  for (const s of sentinels) {
    if (out.includes(s)) {
      throw new Error(`${label}: sentinel ${s} leaked into tool output. B-2 regression.`);
    }
  }
}

describe("B-2 symlink-escape — workspace zone reads (file-tool-security-port)", () => {
  test("read through symlink to out-of-tree file → blocked, no sentinel leak", async () => {
    const ctx = await makeBoundedWorkspaceCtx();
    const out = expectDispatchString(await dispatchFileCommand(
      { command: "read", path: "hijack-key", zone: "current" },
      ctx,
    ));
    expect(out).toMatch(/escapes zone/);
    assertNoSentinelLeak(out, "workspace-zone read of symlink");
  });

  test("read through symlink in current folder → blocked, no sentinel leak", async () => {
    const ctx = await makeCtx();
    const out = expectDispatchString(await dispatchFileCommand(
      { command: "read", path: "hijack-hosts", zone: "current" },
      ctx,
    ));
    expect(out).toMatch(/escapes zone/);
    assertNoSentinelLeak(out, "current-zone read of symlink");
  });

  test("stat on symlinked-outside path → blocked", async () => {
    const ctx = await makeBoundedWorkspaceCtx();
    const out = expectDispatchString(await dispatchFileCommand(
      { command: "stat", path: "hijack-key", zone: "current" },
      ctx,
    ));
    expect(out).toMatch(/escapes zone/);
    assertNoSentinelLeak(out, "stat of symlink");
  });

  test("legitimate read inside workspace still works", async () => {
    const ctx = await makeCtx();
    const out = expectDispatchString(await dispatchFileCommand(
      { command: "read", path: join(WORKSPACE, "notes.md"), zone: "absolute" },
      ctx,
    ));
    expect(out).toContain("legit content");
  });
});

describe("B-1 absolute-zone containment — deny-list and envelope gates live OUTSIDE dispatch", () => {
  // These tests document the division of responsibility. The
  // dispatch layer (what we exercise here via dispatchFileCommand)
  // does NOT apply the path-deny list or the envelope policy — those
  // happen in validateBeforeExecution (toolsNode) and
  // checkToolAccess (trust resolver) respectively. This integration
  // test exists so that future refactors pulling those gates INTO
  // the dispatcher don't silently break.

  test("absolute zone with a legitimate path reads successfully (no dispatch-layer gate)", async () => {
    // Creating a regular readable file at an absolute path. The
    // dispatcher does not gate absolute-zone reads — those are
    // gated by validateBeforeExecution (deny-list) and
    // checkToolAccess (envelope) in the real toolsNode pipeline.
    const tmpFile = join(BASE, "some-abs-file.txt");
    await fsp.writeFile(tmpFile, "absolute-read-works\n");
    const ctx = await makeCtx();
    const out = expectDispatchString(await dispatchFileCommand(
      { command: "read", path: tmpFile, zone: "absolute" },
      ctx,
    ));
    expect(out).toContain("absolute-read-works");
  });

  test("absolute zone requires absolute path (zone resolver gate)", async () => {
    const ctx = await makeCtx();
    const out = expectDispatchString(await dispatchFileCommand(
      { command: "read", path: "relative.md", zone: "absolute" },
      ctx,
    ));
    expect(out).toMatch(/requires an absolute path/);
  });
});
