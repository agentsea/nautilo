/**
 * D079 PR-011 security port — tests for `assertRealpathContained`,
 * the realpath-based containment check in zones.ts (B-2a).
 *
 * These tests use REAL symlinks in a scoped temp dir rather than
 * mocking `fs/promises.realpath`. The whole point of the check is
 * that the OS realpath answer matches the file we're about to
 * operate on — mocking would test the mock, not the defense.
 *
 * Cleanup: each describe creates a tmp dir in `beforeAll` and
 * rm-rf's in `afterAll`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { assertRealpathContained } from "../../src/tools/file/zones";

let WORKSPACE_ROOT: string;
let CURRENT_FOLDER: string;
let HONEYPOT_DIR: string;
let HONEYPOT_FILE: string;

const CTX = () => ({
  workspaceRoot: WORKSPACE_ROOT,
  currentFolder: CURRENT_FOLDER,
});

beforeAll(async () => {
  // Set up three sibling directories:
  //   workspace/ — the Workspace zone root (stand-in for ~/Documents/Nautilo/)
  //   current/   — the current folder zone root
  //   honey/     — files OUTSIDE both zones; symlinks inside the zones
  //                may try to point here.
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-realpath-test-"));
  WORKSPACE_ROOT = path.join(base, "workspace");
  CURRENT_FOLDER = path.join(base, "current");
  HONEYPOT_DIR = path.join(base, "honey");
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true });
  await fsp.mkdir(CURRENT_FOLDER, { recursive: true });
  await fsp.mkdir(HONEYPOT_DIR, { recursive: true });

  HONEYPOT_FILE = path.join(HONEYPOT_DIR, "secret.txt");
  await fsp.writeFile(HONEYPOT_FILE, "NAUTILO_SENTINEL_DO_NOT_LEAK");

  // Populate the zones with legitimate content + a symlink each that
  // points OUTSIDE the zone root.
  await fsp.writeFile(path.join(WORKSPACE_ROOT, "notes.md"), "legit");
  await fsp.writeFile(path.join(CURRENT_FOLDER, "draft.md"), "legit");

  // Symlink inside workspace → honeypot file (B-2 attack shape)
  await fsp.symlink(
    HONEYPOT_FILE,
    path.join(WORKSPACE_ROOT, "hijack-file.md"),
  );
  // Symlink inside workspace → honeypot dir
  await fsp.symlink(
    HONEYPOT_DIR,
    path.join(WORKSPACE_ROOT, "hijack-dir"),
  );
  // Symlink inside current folder → honeypot file
  await fsp.symlink(
    HONEYPOT_FILE,
    path.join(CURRENT_FOLDER, "hijack-file.md"),
  );
});

afterAll(async () => {
  // Walk up one level from WORKSPACE_ROOT to find the base tmp dir
  const base = path.dirname(WORKSPACE_ROOT);
  await fsp.rm(base, { recursive: true, force: true });
});

describe("assertRealpathContained — absolute zone bypasses", () => {
  test("absolute zone → always ok (containment is the deny-list's job)", async () => {
    const result = await assertRealpathContained(
      { resolved: "/etc/passwd", resolvedZone: "absolute" },
      CTX(),
    );
    expect(result.ok).toBe(true);
  });
});

describe("assertRealpathContained — workspace zone", () => {
  test("legitimate file inside workspace → ok", async () => {
    const result = await assertRealpathContained(
      {
        resolved: path.join(WORKSPACE_ROOT, "notes.md"),
        resolvedZone: "workspace",
      },
      CTX(),
    );
    expect(result.ok).toBe(true);
  });

  test("symlink inside workspace pointing OUTSIDE → rejected (B-2 attack)", async () => {
    const result = await assertRealpathContained(
      {
        resolved: path.join(WORKSPACE_ROOT, "hijack-file.md"),
        resolvedZone: "workspace",
      },
      CTX(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("escapes zone via symlink");
    }
  });

  test("symlinked directory inside workspace pointing OUTSIDE → rejected when traversed", async () => {
    // Calling with a path THROUGH the symlinked dir simulates a
    // command that tries to descend into hijack-dir/.
    const result = await assertRealpathContained(
      {
        resolved: path.join(WORKSPACE_ROOT, "hijack-dir", "secret.txt"),
        resolvedZone: "workspace",
      },
      CTX(),
    );
    expect(result.ok).toBe(false);
  });

  test("new-file write into legitimate workspace subdir → ok (parent realpath falls under root)", async () => {
    // File doesn't exist yet (ENOENT path). Parent is the workspace
    // root, which realpaths to itself. Write should be allowed.
    const result = await assertRealpathContained(
      {
        resolved: path.join(WORKSPACE_ROOT, "drafts", "new-file.md"),
        resolvedZone: "workspace",
      },
      CTX(),
    );
    expect(result.ok).toBe(true);
  });

  test("new-file write under a symlinked-outside parent → rejected", async () => {
    // File doesn't exist yet, but parent (hijack-dir) is a symlink
    // to the honeypot directory. Parent-realpath fallback catches
    // this.
    const result = await assertRealpathContained(
      {
        resolved: path.join(WORKSPACE_ROOT, "hijack-dir", "planted.md"),
        resolvedZone: "workspace",
      },
      CTX(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/parent directory escapes zone via symlink|escapes zone/);
    }
  });

  test("deep new-file path (parent also doesn't exist) → ok (textual containment holds)", async () => {
    // Neither the file nor its parent exists yet. Falls back to
    // accepting — the caller's textual resolveZone already held,
    // and mkdir -p at write time creates under the root normally.
    const result = await assertRealpathContained(
      {
        resolved: path.join(WORKSPACE_ROOT, "deep", "nested", "new.md"),
        resolvedZone: "workspace",
      },
      CTX(),
    );
    expect(result.ok).toBe(true);
  });
});

describe("assertRealpathContained — current zone", () => {
  test("legitimate file inside current → ok", async () => {
    const result = await assertRealpathContained(
      {
        resolved: path.join(CURRENT_FOLDER, "draft.md"),
        resolvedZone: "current",
      },
      CTX(),
    );
    expect(result.ok).toBe(true);
  });

  test("symlink inside current pointing OUTSIDE → rejected", async () => {
    const result = await assertRealpathContained(
      {
        resolved: path.join(CURRENT_FOLDER, "hijack-file.md"),
        resolvedZone: "current",
      },
      CTX(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("assertRealpathContained — M088B server-owned artifact root", () => {
  let ARTIFACTS_ROOT: string;
  let prevEnv: string | undefined;

  beforeAll(async () => {
    ARTIFACTS_ROOT = await fsp.mkdtemp(
      path.join(os.tmpdir(), "nautilo-artifacts-root-"),
    );
    prevEnv = process.env["NAUTILO_ARTIFACTS_ROOT"];
    process.env["NAUTILO_ARTIFACTS_ROOT"] = ARTIFACTS_ROOT;
  });

  afterAll(async () => {
    if (prevEnv === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
    else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevEnv;
    await fsp.rm(ARTIFACTS_ROOT, { recursive: true, force: true });
  });

  test("workspace zone write into the server-owned artifact root → ok", async () => {
    const target = path.join(ARTIFACTS_ROOT, "11111111-1111-1111-1111-111111111111");
    const result = await assertRealpathContained(
      { resolved: target, resolvedZone: "workspace" },
      CTX(),
    );
    expect(result.ok).toBe(true);
  });

  test("workspace zone write to a sibling of the artifact root (not inside) → rejected", async () => {
    const target = path.join(path.dirname(ARTIFACTS_ROOT), "not-artifacts", "x.bin");
    const result = await assertRealpathContained(
      { resolved: target, resolvedZone: "workspace" },
      CTX(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("assertRealpathContained — D136-P2 dual-root coexistence & cross-root symlinks", () => {
  // These three tests pin the current dual-root containment behavior
  // documented in zones.ts §assertRealpathContained. They exist so that
  // a future tightening (or accidental loosening) of the per-backend
  // semantics surfaces in CI. See D136-P2 audit notes in zones.ts.

  let ARTIFACTS_ROOT: string;
  let LEGACY_ARTIFACT_PATH: string; // M088A-shape: <workspaceRoot>/.artifacts/<uuid>
  let NEW_ARTIFACT_PATH: string;    // M088B-shape: <artifactsRoot>/<uuid>
  let prevEnv: string | undefined;

  beforeAll(async () => {
    ARTIFACTS_ROOT = await fsp.mkdtemp(
      path.join(os.tmpdir(), "nautilo-d136-dualroot-"),
    );
    prevEnv = process.env["NAUTILO_ARTIFACTS_ROOT"];
    process.env["NAUTILO_ARTIFACTS_ROOT"] = ARTIFACTS_ROOT;

    // M088A-shape legacy layout: a `.artifacts/<uuid>` directory inside
    // workspaceRoot. Created during this test to simulate a system that
    // ran M088A first and has not yet been migrated by Pass A of
    // `bun run dev:migrate-artifacts`.
    const legacyDir = path.join(WORKSPACE_ROOT, ".artifacts");
    await fsp.mkdir(legacyDir, { recursive: true });
    LEGACY_ARTIFACT_PATH = path.join(
      legacyDir,
      "22222222-2222-2222-2222-222222222222",
    );
    await fsp.writeFile(LEGACY_ARTIFACT_PATH, "legacy-bytes");

    // M088B-shape new layout: bytes directly under artifactsRoot.
    NEW_ARTIFACT_PATH = path.join(
      ARTIFACTS_ROOT,
      "33333333-3333-3333-3333-333333333333",
    );
    await fsp.writeFile(NEW_ARTIFACT_PATH, "new-bytes");

    // Cross-root symlinks (D136-P2 audit cases). Both directions: a
    // symlink under one root pointing into the other.
    await fsp.symlink(
      NEW_ARTIFACT_PATH,
      path.join(WORKSPACE_ROOT, "cross-symlink-into-artifacts"),
    );
    await fsp.symlink(
      path.join(WORKSPACE_ROOT, "notes.md"),
      path.join(ARTIFACTS_ROOT, "cross-symlink-into-workspace"),
    );
  });

  afterAll(async () => {
    if (prevEnv === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
    else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevEnv;
    await fsp.rm(ARTIFACTS_ROOT, { recursive: true, force: true });
    await fsp.rm(path.join(WORKSPACE_ROOT, ".artifacts"), {
      recursive: true,
      force: true,
    });
    // Clean the symlinks; rm-rf above doesn't catch them because they
    // live at the top of WORKSPACE_ROOT / ARTIFACTS_ROOT.
    await fsp.rm(path.join(WORKSPACE_ROOT, "cross-symlink-into-artifacts"), {
      force: true,
    });
  });

  test("Test C — coexistence: M088A-shape (workspace/.artifacts/<uuid>) AND M088B-shape (artifactsRoot/<uuid>) both contained", async () => {
    const legacy = await assertRealpathContained(
      { resolved: LEGACY_ARTIFACT_PATH, resolvedZone: "workspace" },
      CTX(),
    );
    expect(legacy.ok).toBe(true);

    const fresh = await assertRealpathContained(
      { resolved: NEW_ARTIFACT_PATH, resolvedZone: "workspace" },
      CTX(),
    );
    expect(fresh.ok).toBe(true);
  });

  test("Test A — symlink under workspaceRoot pointing into artifactsRoot: currently ACCEPTED (dual-root permissiveness; D136-P2 follow-up to tighten)", async () => {
    // Path is textually under workspaceRoot, realpath under artifactsRoot.
    // Per the current dual-root contract this passes because realpath is
    // under one of the two valid roots. A per-backend tightening would
    // reject this — tracked as follow-up.
    const result = await assertRealpathContained(
      {
        resolved: path.join(WORKSPACE_ROOT, "cross-symlink-into-artifacts"),
        resolvedZone: "workspace",
      },
      CTX(),
    );
    expect(result.ok).toBe(true);
  });

  test("Test B — symlink under artifactsRoot pointing into workspaceRoot: currently ACCEPTED (same permissiveness, mirror direction)", async () => {
    // Path is textually under artifactsRoot, realpath under workspaceRoot.
    // Symmetric with Test A; pins the dual-root accept-either invariant.
    const result = await assertRealpathContained(
      {
        resolved: path.join(ARTIFACTS_ROOT, "cross-symlink-into-workspace"),
        resolvedZone: "workspace",
      },
      CTX(),
    );
    expect(result.ok).toBe(true);
  });
});

describe("assertRealpathContained — boot-order edge cases", () => {
  test("workspace zone with null workspaceRoot → fail closed", async () => {
    const ctx = { workspaceRoot: "", currentFolder: null };
    const result = await assertRealpathContained(
      {
        resolved: "/some/path",
        resolvedZone: "workspace",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  test("current zone with null currentFolder → fail closed", async () => {
    const ctx = { workspaceRoot: WORKSPACE_ROOT, currentFolder: null };
    const result = await assertRealpathContained(
      {
        resolved: "/some/path",
        resolvedZone: "current",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  test("workspace root that does not exist on disk → fail closed", async () => {
    const ctx = {
      workspaceRoot: "/nonexistent/workspace-that-will-never-exist-12345",
      currentFolder: null,
    };
    const result = await assertRealpathContained(
      {
        resolved: "/nonexistent/workspace-that-will-never-exist-12345/foo.md",
        resolvedZone: "workspace",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});
