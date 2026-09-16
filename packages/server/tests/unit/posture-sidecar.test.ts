/**
 * Tests for posture-sidecar read + write — D060 ship-plan G4.
 *
 * Covers:
 *   - round-trip: write then read returns the same posture
 *   - absent file → null (first boot)
 *   - malformed JSON → null + warn (doesn\u0027t crash boot)
 *   - invalid fields (bad deployment_mode / level) → null + warn
 *   - unknown version number → null (future-proofing)
 *   - atomic write: no partial file visible mid-write
 *   - 0600 file mode on the final file
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  ensurePostureSidecar,
  readPostureSidecar,
  writePostureSidecar,
} from "../../src/lib/posture-sidecar";

const SERVER_POSTURE = {
  deploymentMode: "server",
  securityLevel: "paranoid",
  networkPolicy: { mode: "isolated" },
  allowUncontainedHostCommands: false,
} as const;

const DESKTOP_POSTURE = {
  deploymentMode: "desktop-permissive",
  securityLevel: "cautious",
  networkPolicy: { mode: "host" },
  allowUncontainedHostCommands: false,
} as const;

const LOCKED_POSTURE = {
  deploymentMode: "desktop-locked",
  securityLevel: "paranoid",
  networkPolicy: { mode: "isolated" },
  allowUncontainedHostCommands: false,
} as const;

let tmp: string;
let sidecarPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nautilo-sidecar-"));
  sidecarPath = join(tmp, "posture.json");
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("posture sidecar", () => {
  test("absent file → null (first-boot case)", () => {
    expect(readPostureSidecar(sidecarPath)).toBeNull();
  });

  test("round-trip: write then read returns the same posture", () => {
    writePostureSidecar(sidecarPath, SERVER_POSTURE);
    const read = readPostureSidecar(sidecarPath);
    expect(read).toEqual(SERVER_POSTURE);
  });

  test("round-trip desktop-permissive", () => {
    writePostureSidecar(sidecarPath, DESKTOP_POSTURE);
    expect(readPostureSidecar(sidecarPath)).toEqual(DESKTOP_POSTURE);
  });

  test("round-trip preserves an explicit uncontained-host-commands policy", () => {
    const enabled = {
      ...DESKTOP_POSTURE,
      allowUncontainedHostCommands: true,
    } as const;
    writePostureSidecar(sidecarPath, enabled);
    expect(readPostureSidecar(sidecarPath)).toEqual(enabled);
  });

  test("v1/v2 sidecars upgrade fail-closed with the policy disabled", () => {
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 2,
        deploymentMode: "desktop-permissive",
        securityLevel: "cautious",
        networkPolicy: { mode: "host" },
      }),
      "utf-8",
    );
    expect(readPostureSidecar(sidecarPath)).toEqual(DESKTOP_POSTURE);
  });

  test("writing overwrites prior value", () => {
    writePostureSidecar(sidecarPath, DESKTOP_POSTURE);
    writePostureSidecar(sidecarPath, LOCKED_POSTURE);
    expect(readPostureSidecar(sidecarPath)).toEqual(LOCKED_POSTURE);
  });

  test("malformed JSON → null (+ warn logged)", () => {
    writeFileSync(sidecarPath, "not json {{{", "utf-8");
    expect(readPostureSidecar(sidecarPath)).toBeNull();
  });

  test("invalid deployment_mode → null (Zod reject, doesn\u0027t crash)", () => {
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        deploymentMode: "yolo-mode",
        securityLevel: "cautious",
      }),
      "utf-8",
    );
    expect(readPostureSidecar(sidecarPath)).toBeNull();
  });

  test("invalid security_level → null", () => {
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        deploymentMode: "server",
        securityLevel: "chaos",
      }),
      "utf-8",
    );
    expect(readPostureSidecar(sidecarPath)).toBeNull();
  });

  test("unknown version number → null (future-proofing)", () => {
    // A future version-2 sidecar reaching a current-version reader
    // falls back to config defaults rather than guessing the shape.
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 99,
        deploymentMode: "server",
        securityLevel: "paranoid",
        newField: "whatever",
      }),
      "utf-8",
    );
    expect(readPostureSidecar(sidecarPath)).toBeNull();
  });

  test("0600 file mode (owner-only read/write)", () => {
    writePostureSidecar(sidecarPath, SERVER_POSTURE);
    // On Windows file-mode check is meaningless; skip when not POSIX.
    if (sep !== "/") return;
    const stat = statSync(sidecarPath);
    const mode = stat.mode & 0o777;
    // Posture file carries security-sensitive values; don\u0027t let
    // siblings read. 0600 target; umask may tighten it (e.g. 0400).
    expect(mode & 0o077).toBe(0);
  });

  test("atomic write: no *.tmp-* files left behind after success", () => {
    writePostureSidecar(sidecarPath, SERVER_POSTURE);
    const files = readdirSync(tmp);
    const tmpFiles = files.filter((f) => f.includes(".tmp-"));
    expect(tmpFiles).toEqual([]);
    expect(files).toContain("posture.json");
  });

  test("creates parent directory if missing (first-run case)", () => {
    const nestedPath = join(tmp, "nested", "deeper", ".nautilo", "posture.json");
    writePostureSidecar(nestedPath, SERVER_POSTURE);
    expect(readPostureSidecar(nestedPath)).toEqual(SERVER_POSTURE);
  });
});

// ---------------------------------------------------------------------------
// G4 (D060 Sprint 2 Friday) — first-boot provisioner
// ---------------------------------------------------------------------------

describe("ensurePostureSidecar (G4 first-boot provisioner)", () => {
  test("absent file → writes defaults + returns them", () => {
    const defaults = SERVER_POSTURE;
    const got = ensurePostureSidecar(sidecarPath, defaults);
    expect(got).toEqual(defaults);
    // File now exists on disk with the same shape
    expect(readPostureSidecar(sidecarPath)).toEqual(defaults);
  });

  test("existing file → reads it + does NOT overwrite (idempotent)", () => {
    // Simulate operator state: sidecar already at desktop defaults
    writePostureSidecar(sidecarPath, DESKTOP_POSTURE);
    // ensurePostureSidecar called with DIFFERENT defaults must
    // respect the existing file, not overwrite.
    const got = ensurePostureSidecar(sidecarPath, SERVER_POSTURE);
    expect(got).toEqual(DESKTOP_POSTURE);
    expect(readPostureSidecar(sidecarPath)).toEqual(DESKTOP_POSTURE);
  });

  test("malformed file → returns defaults but does NOT overwrite (operator triage)", () => {
    // Operator hand-edited the sidecar and broke it. We must NOT
    // overwrite — that masks the misconfiguration. Use defaults
    // for the current process; preserve the file for triage.
    writeFileSync(sidecarPath, "{ this is not valid json", "utf-8");
    const defaults = SERVER_POSTURE;
    const got = ensurePostureSidecar(sidecarPath, defaults);
    expect(got).toEqual(defaults);
    // File on disk is STILL the malformed content — readPostureSidecar
    // returns null for it (operator-visible warn line surfaces the issue).
    expect(readPostureSidecar(sidecarPath)).toBeNull();
  });

  test("Electron-then-server ordering: desktop defaults win on a desktop install", () => {
    // Simulates: apps/desktop boot() runs ensurePostureSidecar(...,
    // desktop-permissive/cautious), THEN bin/nautilo-server boots
    // and calls ensurePostureSidecar(..., server/paranoid). The
    // desktop install must end up with desktop defaults.
    const desktop = ensurePostureSidecar(sidecarPath, DESKTOP_POSTURE);
    const server = ensurePostureSidecar(sidecarPath, SERVER_POSTURE);
    expect(desktop).toEqual(DESKTOP_POSTURE);
    expect(server).toEqual(DESKTOP_POSTURE);
  });
});
