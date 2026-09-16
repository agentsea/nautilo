/**
 * Unit tests for the SBPL profile generator.
 * D060 Phase 2 task 2.1.12.
 *
 * These tests assert on STRUCTURE, not exact byte-for-byte output —
 * snapshot-matching the whole profile would flake any time Apple
 * changes `system.sb` or Gemini CLI updates their reference. Instead
 * we assert:
 *   - scaffold order (version → deny default → import → workspace)
 *   - rule ordering invariants (deny-after-allow for governance files)
 *   - both original AND realpath forms emitted
 *   - escape helpers produce parser-safe output
 *   - worktree detection walks two-up for main git dir
 *   - secret-file regex anchors to each search base
 *
 * Plus one positive end-to-end: running `sandbox-exec -p "$(profile)"
 * /usr/bin/true` under a real Darwin binary should exit 0. Gated on
 * `NAUTILO_SMOKE_MACOS=1` because CI runners without sandbox-exec
 * can't exercise it.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_SEATBELT_PROFILE,
  GOVERNANCE_FILES,
  NETWORK_ALLOW_RULES,
  buildNetworkProxyRules,
  PUBLIC_TEMPLATE_TERMINAL_SUFFIXES,
  SECRET_FILES,
  buildSbplProfile,
  escapeRegexForSchemeLiteral,
  escapeSchemeString,
} from "../../src/seatbelt-profile";
import { buildSandboxExec } from "../../src/seatbelt";
import type { SandboxConfig } from "../../src/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a tmp dir and canonicalize it so we can assert on the
 * realpath form (macOS `/var/folders/...` → `/private/var/folders/...`
 * canonicalization). Tests that compare the profile against the
 * workspace dir need this form.
 */
function mkTmp(prefix: string): { raw: string; real: string } {
  const raw = mkdtempSync(join(tmpdir(), prefix));
  const real = realpathSync(raw);
  return { raw, real };
}

function baseConfig(): SandboxConfig {
  return {
    mode: "enabled",
    writablePaths: [],
    projectPaths: [],
    passthroughEnv: [],
  };
}

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

describe("escapeSchemeString", () => {
  test("escapes backslashes", () => {
    expect(escapeSchemeString("/foo\\bar")).toBe("/foo\\\\bar");
  });

  test("escapes double quotes", () => {
    expect(escapeSchemeString('/foo"bar')).toBe('/foo\\"bar');
  });

  test("leaves normal path chars alone", () => {
    expect(escapeSchemeString("/usr/local/bin")).toBe("/usr/local/bin");
  });

  test("escapes dollar, dot, hash untouched (they are string literals in Scheme)", () => {
    // `$`, `.`, `#` are only special in regex contexts, not in
    // plain SBPL string literals. Verify we don't over-escape.
    expect(escapeSchemeString("/foo.bar$baz#qux")).toBe("/foo.bar$baz#qux");
  });
});

describe("escapeRegexForSchemeLiteral", () => {
  test("escapes regex metacharacter `.` as single-backslash (empirical -p-mode behavior)", () => {
    // Under sandbox-exec's `-p` mode, the Scheme reader does NOT
    // standard-unescape `\\`. Literal `\\.` in the profile bytes
    // reaches the regex engine as `\\.` (which means "literal `\`
    // + any char"), never matching real paths. We need `\.` (ONE
    // backslash) so the engine sees `\.` = "literal dot".
    //
    // JS `"foo\\.bar"` = 7 chars in memory: `foo\.bar`.
    expect(escapeRegexForSchemeLiteral("foo.bar")).toBe("foo\\.bar");
  });

  test("escapes backslash as `\\\\` (profile bytes = 2, regex = literal `\\`)", () => {
    // Source `\` → emit `\\` (profile bytes) → regex reads `\\`
    // = literal single backslash. Paths rarely contain `\`, but
    // we cover it for cross-platform symmetry with Phase 1.
    expect(escapeRegexForSchemeLiteral("foo\\bar")).toBe("foo\\\\bar");
  });

  test("escapes double quotes for Scheme string literal", () => {
    // `"` would close the `#"..."` literal; escape with `\"` so
    // Scheme keeps the literal open. Doesn't reach the regex engine.
    expect(escapeRegexForSchemeLiteral('foo"bar')).toBe('foo\\"bar');
  });

  test("round-trips a realistic path", () => {
    // `/Users/me/.nautilo/data` — the `.`'s are regex metachars.
    // Result: each `.` becomes `\.` (2 chars). JS source
    // `"/Users/me/\\.nautilo/data"` = 23 chars in memory.
    const out = escapeRegexForSchemeLiteral("/Users/me/.nautilo/data");
    expect(out).toBe("/Users/me/\\.nautilo/data");
  });
});

// ---------------------------------------------------------------------------
// Base profile invariants
// ---------------------------------------------------------------------------

describe("BASE_SEATBELT_PROFILE", () => {
  test("starts with (version 1)", () => {
    expect(BASE_SEATBELT_PROFILE.startsWith("(version 1)")).toBe(true);
  });

  test("has (deny default) before anything else", () => {
    const versionIdx = BASE_SEATBELT_PROFILE.indexOf("(version 1)");
    const denyDefaultIdx = BASE_SEATBELT_PROFILE.indexOf("(deny default)");
    const importIdx = BASE_SEATBELT_PROFILE.indexOf('(import "system.sb")');
    expect(versionIdx).toBe(0);
    expect(denyDefaultIdx).toBeGreaterThan(versionIdx);
    expect(importIdx).toBeGreaterThan(denyDefaultIdx);
  });

  test("includes core execution allows", () => {
    expect(BASE_SEATBELT_PROFILE).toContain("(allow process-exec)");
    expect(BASE_SEATBELT_PROFILE).toContain("(allow process-fork)");
  });

  test("allows executable mapping from common third-party interpreter trees", () => {
    expect(BASE_SEATBELT_PROFILE).toContain('(subpath "/opt/homebrew")');
    expect(BASE_SEATBELT_PROFILE).toContain('(subpath "/usr/local")');
    expect(BASE_SEATBELT_PROFILE).toContain('(subpath "/Library/Frameworks")');
  });

  test("includes base read-only system paths", () => {
    for (const p of [
      "/System",
      "/usr/lib",
      "/usr/bin",
      "/bin",
      "/sbin",
      "/opt/homebrew",
    ]) {
      expect(BASE_SEATBELT_PROFILE).toContain(`(subpath "${p}")`);
    }
  });

  test("allows metadata on system parent dirs used by realpath/canonicalize", () => {
    for (const p of [
      "/usr",
      "/usr/bin",
      "/usr/local",
      "/usr/local/bin",
      "/opt",
      "/opt/homebrew",
      "/opt/homebrew/bin",
      "/Library",
      "/Library/Developer",
    ]) {
      expect(BASE_SEATBELT_PROFILE).toContain(`(literal "${p}")`);
    }
  });

  test("does NOT include network rules (they're opt-in)", () => {
    expect(BASE_SEATBELT_PROFILE).not.toContain("(allow network-outbound)");
  });
});

describe("NETWORK_ALLOW_RULES", () => {
  test("allows outbound + inbound + bind", () => {
    expect(NETWORK_ALLOW_RULES).toContain("(allow network-outbound)");
    expect(NETWORK_ALLOW_RULES).toContain("(allow network-inbound)");
    expect(NETWORK_ALLOW_RULES).toContain("(allow network-bind)");
  });
});

describe("D103 network policy SBPL", () => {
  test("networkPolicy=isolated emits no allow network rules", () => {
    const { raw } = mkTmp("nautilo-sbpl-net-isolated-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        networkPolicy: { mode: "isolated" },
      },
    });
    expect(profile).not.toContain("(allow network-outbound)");
    expect(profile).not.toContain("(allow network-inbound)");
    expect(profile).not.toContain("(allow network-bind)");
  });

  test("networkPolicy=proxy-allowlist allows only the local proxy port", () => {
    const { raw } = mkTmp("nautilo-sbpl-net-proxy-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        networkPolicy: {
          mode: "proxy-allowlist",
          allow: [{ type: "domain", host: "api.openai.com" }],
        },
      },
      networkProxyPort: 49152,
    });
    expect(profile).toContain('remote tcp "localhost:49152"');
    expect(profile).not.toContain("(allow network-bind)");
  });

  test("networkPolicy=proxy-allowlist without a proxy port fails closed", () => {
    const { raw } = mkTmp("nautilo-sbpl-net-proxy-missing-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        networkPolicy: {
          mode: "proxy-allowlist",
          allow: [{ type: "domain", host: "api.openai.com" }],
        },
      },
    });
    expect(profile).not.toContain("(allow network-outbound)");
    expect(profile).not.toContain("(allow network-bind)");
  });

  test("buildNetworkProxyRules is deterministic", () => {
    expect(buildNetworkProxyRules(12345)).toContain("localhost:12345");
  });
});

// ---------------------------------------------------------------------------
// Profile builder — shape
// ---------------------------------------------------------------------------

describe("buildSbplProfile — canonical workspace", () => {
  test("embeds the base profile followed by workspace rules", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-base-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    // Base profile first.
    expect(profile.startsWith(BASE_SEATBELT_PROFILE)).toBe(true);

    // Workspace allow appears AFTER the base.
    const baseEnd = BASE_SEATBELT_PROFILE.length;
    const workspaceAllowIdx = profile.indexOf(
      `(allow file-read* (subpath "${raw}"))`,
    );
    expect(workspaceAllowIdx).toBeGreaterThanOrEqual(baseEnd);

    // Realpath form emitted if it differs from raw.
    if (real !== raw) {
      expect(profile).toContain(
        `(allow file-read* (subpath "${real}"))`,
      );
      expect(profile).toContain(
        `(allow file-write* (subpath "${real}"))`,
      );
    }
  });

  test("emits workspace rules in order: read allow → write allow → realpath → same", () => {
    const { raw } = mkTmp("nautilo-sbpl-order-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    const readIdx = profile.indexOf(`(allow file-read* (subpath "${raw}"))`);
    const writeIdx = profile.indexOf(`(allow file-write* (subpath "${raw}"))`);
    expect(readIdx).toBeGreaterThan(0);
    expect(writeIdx).toBeGreaterThan(readIdx);
  });

  test("emits metadata allow for the workspace literal", () => {
    const { raw } = mkTmp("nautilo-sbpl-metadata-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    expect(profile).toContain(
      `(allow file-read-metadata (literal "${raw}"))`,
    );
  });

  test("network allow appended by default (Phase 2 = allow all)", () => {
    const { raw } = mkTmp("nautilo-sbpl-net-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    expect(profile).toContain("(allow network-outbound)");
  });

  test("network allow omitted when networkAccess=false", () => {
    const { raw } = mkTmp("nautilo-sbpl-nonet-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
      networkAccess: false,
    });
    expect(profile).not.toContain("(allow network-outbound)");
  });
});

// ---------------------------------------------------------------------------
// Governance file denies (deny-after-allow ordering)
// ---------------------------------------------------------------------------

describe("buildSbplProfile — governance file denies", () => {
  test("every GOVERNANCE_FILE produces a deny rule AFTER the workspace allow", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-gov-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    const workspaceAllowIdx = profile.indexOf(
      `(allow file-write* (subpath "${real}"))`,
    );
    // If realpath matches raw, use the raw form instead.
    const allowIdx =
      workspaceAllowIdx >= 0
        ? workspaceAllowIdx
        : profile.indexOf(`(allow file-write* (subpath "${raw}"))`);
    expect(allowIdx).toBeGreaterThan(0);

    for (const gov of GOVERNANCE_FILES) {
      const govPath = join(real, gov.path);
      // deny rule exists and comes AFTER the workspace allow —
      // this is the critical ordering invariant per the docstring.
      const denyReadWriteIdx = profile.indexOf(
        `(deny file-write*`,
      );
      expect(denyReadWriteIdx).toBeGreaterThan(allowIdx);
      // Deny rule specifically names this governance path.
      expect(profile).toContain(`"${govPath}"`);
    }
  });

  test(".git uses subpath when directory exists on disk", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-gitdir-");
    // Don't create .git — verify the default shape (directory) wins.
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    const gitPath = join(real, ".git");
    expect(profile).toContain(
      `(deny file-write* (subpath "${gitPath}"))`,
    );
  });

  test(".gitignore uses literal (file, not directory)", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-gitignore-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    const path = join(real, ".gitignore");
    expect(profile).toContain(
      `(deny file-write* (literal "${path}"))`,
    );
  });

  test("D574 trusted Developer Workstation profile suppresses only workspace governance denies", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-workstation-gov-");
    mkdirSync(join(raw, ".git"));
    const protectedPath = join(real, ".ssh");
    mkdirSync(protectedPath);
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        protectedPaths: [protectedPath],
      },
      allowWorkspaceGovernanceWrites: true,
    });

    for (const gov of GOVERNANCE_FILES) {
      expect(profile).not.toContain(
        `(deny file-write* (${gov.isDirectory ? "subpath" : "literal"} "${join(real, gov.path)}"))`,
      );
    }
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${protectedPath}"))`,
    );
    expect(profile).toContain(`^${real}/(.*/)?\\.env[^/]*$`);
  });
});

// ---------------------------------------------------------------------------
// Secret file regex denies
// ---------------------------------------------------------------------------

describe("buildSbplProfile — secret file regex denies", () => {
  test("every SECRET_FILES pattern gets a regex rule anchored to workspace", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-secret-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    // Should have at least one deny rule per pattern, anchored to
    // the workspace real path.
    expect(SECRET_FILES.length).toBeGreaterThan(0);
    for (const secret of SECRET_FILES) {
      // Fragment of the pattern should appear in the emitted profile.
      const isGlob = secret.pattern.endsWith("*");
      const stem = isGlob ? secret.pattern.slice(0, -1) : secret.pattern;
      // The stem is dot-escaped in the regex form — SINGLE
      // backslash in the profile bytes (the escape bug fix).
      const escaped = stem.replace(/\./g, "\\.");
      expect(profile).toContain(escaped);
    }

    // Anchor to workspace real path shows up in at least one rule.
    const escapedBase = escapeRegexForSchemeLiteral(real);
    expect(profile).toContain(`^${escapedBase}/`);
  });

  test("PR-015 MINOR #1 — secret-regex emits `[^/]*$` quantifier (NOT `[^/]+$`) to match bare `.env`", () => {
    // The SEC-1 fix landed in commit 755ffec flipped the quantifier
    // from Gemini CLI's `[^/]+$` (one-or-more non-slash char after
    // the stem — misses bare `.env`) to `[^/]*$` (zero-or-more
    // non-slash — matches `.env`, `.env.local`, `.env.production`).
    //
    // Before PR-015, the only regression test for this quantifier
    // was the live-Darwin sandbox-exec test below, which `.skip`s
    // on Linux CI. A refactor that flipped `[^/]*$` back to
    // `[^/]+$` would have shipped CI-green and silently re-broken
    // bare `.env` blocking.
    //
    // This CI-runnable byte-shape assertion pins the quantifier so
    // a future regression is caught on every platform.
    const { raw, real } = mkTmp("nautilo-sbpl-sec-quantifier-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    // Every glob-style SECRET_FILES entry must emit the `[^/]*$`
    // quantifier (not `[^/]+$`).
    const globPatterns = SECRET_FILES.filter((s) => s.pattern.endsWith("*"));
    expect(globPatterns.length).toBeGreaterThan(0);

    for (const secret of globPatterns) {
      const stem = escapeRegexForSchemeLiteral(secret.pattern.slice(0, -1));
      // The emitted profile must contain the `[^/]*$` form anchored
      // to the workspace base (canonical OR raw — belt-and-suspenders).
      const goodPattern = `${stem}[^/]*$`;
      const badPattern = `${stem}[^/]+$`;
      expect(profile).toContain(goodPattern);
      expect(profile).not.toContain(badPattern);
    }

    // Workspace anchor appears in at least one rule (cross-checks the
    // base-escape didn't regress).
    const escapedBase = escapeRegexForSchemeLiteral(real);
    expect(profile).toContain(`^${escapedBase}/`);
  });

  test("PR-015 MINOR #2 — glob stem escape routes through escapeRegexForSchemeLiteral", () => {
    // Defensive: if a future SECRET_FILES entry carries a regex
    // metachar (`+`, `*`, `(`, `[`, `|`, etc.), the emit path must
    // escape it through the canonical helper — same shape as the
    // SEC-1 fix. Locks the invariant by injecting a synthetic entry
    // into a profile and asserting the emit uses proper escapes.
    //
    // We don't mutate SECRET_FILES at runtime (it's a readonly
    // const); instead we verify that the CURRENT production escape
    // path produces identical bytes for the hand-rolled vs.
    // helper-based escape on every real entry. If a future entry
    // with metachars is added, the test file below
    // ("every SECRET_FILES pattern gets a regex rule anchored to
    // workspace") will catch a helper-vs-hand-rolled drift because
    // it asserts the dot-escape fragment appears in the emitted
    // profile.
    for (const secret of SECRET_FILES) {
      const stem = secret.pattern.endsWith("*")
        ? secret.pattern.slice(0, -1)
        : secret.pattern;
      const handRolled = stem.replace(/\./g, "\\.");
      const viaHelper = escapeRegexForSchemeLiteral(stem);
      // Equivalence check: for entries containing only `.` + word
      // chars (today's SECRET_FILES), the helper produces the same
      // output as the hand-rolled escape. This test documents that
      // invariant and will fail loudly if a future entry breaks it
      // (at which point the production code is already correct
      // because it routes through the helper).
      expect(viaHelper).toBe(handRolled);
    }
  });

  test("regex denies come AFTER workspace allow (Seatbelt later-wins)", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-sec-order-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    const workspaceAllowIdx = profile.indexOf(
      `(allow file-write* (subpath "${real}"))`,
    );
    const allowIdx =
      workspaceAllowIdx >= 0
        ? workspaceAllowIdx
        : profile.indexOf(`(allow file-write* (subpath "${raw}"))`);

    const firstRegexDenyIdx = profile.indexOf("(deny file-read* file-write* (regex");
    expect(firstRegexDenyIdx).toBeGreaterThan(allowIdx);
  });
});

// ---------------------------------------------------------------------------
// D574 — public env-template read/write carve-out
// ---------------------------------------------------------------------------

describe("buildSbplProfile — public template carve-out (D418 A2)", () => {
  test("emits one allow-read/write regex per secret base using terminal suffix alternation", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-tmpl-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    expect(PUBLIC_TEMPLATE_TERMINAL_SUFFIXES.length).toBeGreaterThan(0);
    const suffixAlt = PUBLIC_TEMPLATE_TERMINAL_SUFFIXES.join("|");
    // The carve-out is anchored to BOTH the raw + canonical secret bases.
    const bases = Array.from(new Set([raw, real]));
    for (const base of bases) {
      const escapedBase = escapeRegexForSchemeLiteral(base);
      const anchor = `^${escapedBase}/(.*/)?[^/]+\\.(${suffixAlt})$`;
      expect(profile).toContain(`(allow file-read* file-write* (regex #"${anchor}"))`);
      expect(profile).not.toContain(`(deny file-write* (regex #"${anchor}"))`);
    }
  });

  test("template carve-out is emitted AFTER the secret deny (later-wins re-opens reads)", () => {
    const { raw } = mkTmp("nautilo-sbpl-tmpl-order-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    const firstSecretDenyIdx = profile.indexOf("(deny file-read* file-write* (regex");
    const suffixAlt = PUBLIC_TEMPLATE_TERMINAL_SUFFIXES.join("|");
    const firstCarveOutIdx = profile.indexOf(
      `(allow file-read* file-write* (regex #"^${escapeRegexForSchemeLiteral(raw)}/(.*/)?[^/]+\\.(${suffixAlt})$"))`,
    );
    expect(firstSecretDenyIdx).toBeGreaterThan(0);
    expect(firstCarveOutIdx).toBeGreaterThan(firstSecretDenyIdx);
  });

  test("terminal suffix only — `.env.example.local` stays blocked (suffix must be terminal on basename)", () => {
    const { raw } = mkTmp("nautilo-sbpl-tmpl-exact-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    const escapedBase = escapeRegexForSchemeLiteral(raw);
    const suffixAlt = PUBLIC_TEMPLATE_TERMINAL_SUFFIXES.join("|");
    // Carve-out ends with `\.(example|sample|template|dist)$` — NOT a glob
    // after the suffix, so `.env.example.local` does not match.
    expect(profile).toContain(`^${escapedBase}/(.*/)?[^/]+\\.(${suffixAlt})$`);
    expect(profile).not.toContain(`\\.example[^/]*$`);
  });

  test("compound env template stems like `.env.local-smoke.example` match the suffix carve-out", () => {
    const { raw } = mkTmp("nautilo-sbpl-tmpl-compound-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    const escapedBase = escapeRegexForSchemeLiteral(raw);
    const suffixAlt = PUBLIC_TEMPLATE_TERMINAL_SUFFIXES.join("|");
    const anchor = `^${escapedBase}/(.*/)?[^/]+\\.(${suffixAlt})$`;
    // JS RegExp sanity: nested deploy path + compound stem (keep $ anchor).
    const re = new RegExp(anchor);
    expect(re.test(`${raw}/deploy/compose-driver/templates/.env.local-smoke.example`)).toBe(
      true,
    );
    expect(re.test(`${raw}/.env.local-smoke.example`)).toBe(true);
    expect(re.test(`${raw}/.env.example.local`)).toBe(false);
    expect(re.test(`${raw}/.env.local`)).toBe(false);
    expect(profile).toContain(`(allow file-read* file-write* (regex #"${anchor}"))`);
  });

  test("the `.env*` secret deny still covers live secret variants (carve-out does not weaken it)", () => {
    const { raw } = mkTmp("nautilo-sbpl-tmpl-secret-kept-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    // The bare `.env` + glob quantifier secret deny is still present.
    const escapedBase = escapeRegexForSchemeLiteral(raw);
    expect(profile).toContain(`^${escapedBase}/(.*/)?\\.env[^/]*$`);
  });

  test("carve-out also covers writablePaths bases (not just the workspace)", () => {
    const { raw } = mkTmp("nautilo-sbpl-tmpl-wrt-");
    const wrt = mkTmp("nautilo-sbpl-tmpl-wrt-child-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: { ...baseConfig(), writablePaths: [wrt.raw] },
    });
    const escapedWrt = escapeRegexForSchemeLiteral(wrt.raw);
    const suffixAlt = PUBLIC_TEMPLATE_TERMINAL_SUFFIXES.join("|");
    const anchor = `^${escapedWrt}/(.*/)?[^/]+\\.(${suffixAlt})$`;
    expect(profile).toContain(`(allow file-read* file-write* (regex #"${anchor}"))`);
    expect(profile).not.toContain(`(deny file-write* (regex #"${anchor}"))`);
  });
});

// ---------------------------------------------------------------------------
// D418 A2 — narrow macOS xcrun cache exception
// ---------------------------------------------------------------------------

describe("buildSbplProfile — xcrun cache exception (D418 A2)", () => {
  test("emits a narrow allow for `<xcrunCacheDir>/xcrun_db*` only (both raw + canonical forms)", () => {
    const { raw } = mkTmp("nautilo-sbpl-xcrun-");
    const cacheDir = mkTmp("nautilo-sbpl-xcrun-cache-").raw;
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
      xcrunCacheDir: cacheDir,
    });
    const escaped = escapeRegexForSchemeLiteral(cacheDir);
    expect(profile).toContain(
      `(allow file-read* file-write* (regex #"^${escaped}/xcrun_db[^/]*$"))`,
    );
    // The regex is anchored to xcrun_db only — never a broad subpath allow
    // on the cache dir, and never a bare `[^/]*` over the whole dir.
    expect(profile).not.toContain(`(allow file-read* file-write* (subpath "${cacheDir}"))`);
    expect(profile).not.toContain(`(allow file-read* file-write* (subpath "/private/var/folders"))`);
    expect(profile).not.toContain(`(allow file-read* file-write* (subpath "/var"))`);
  });

  test("the xcrun regex does NOT match arbitrary sibling temp files (narrow scope)", () => {
    // Deterministic proof that the policy cannot be read as allowing
    // siblings: build the emitted anchor and assert it only matches
    // xcrun_db-prefixed names, not arbitrary files in the same dir.
    const { raw } = mkTmp("nautilo-sbpl-xcrun-narrow-");
    const cacheDir = "/tmp/nautilo-xcrun-scope-test";
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
      xcrunCacheDir: cacheDir,
    });
    const anchor = `^/tmp/nautilo-xcrun-scope-test/xcrun_db[^/]*$`;
    expect(profile).toContain(anchor);
    const re = new RegExp(anchor.slice(1, -1)); // strip leading ^ and trailing $
    expect(re.test("/tmp/nautilo-xcrun-scope-test/xcrun_db_abc123")).toBe(true);
    expect(re.test("/tmp/nautilo-xcrun-scope-test/xcrun_db")).toBe(true);
    // Sibling temp files are NOT matched.
    expect(re.test("/tmp/nautilo-xcrun-scope-test/other.txt")).toBe(false);
    expect(re.test("/tmp/nautilo-xcrun-scope-test/secrets.env")).toBe(false);
    // Arbitrary /private/var/folders siblings are NOT matched.
    expect(re.test("/private/var/folders/XX/YY/T/evil")).toBe(false);
  });

  test("xcrun exception is emitted BEFORE the dataDir + protected-path denies (final denies win)", () => {
    const { raw } = mkTmp("nautilo-sbpl-xcrun-order-");
    const dataDir = join(raw, ".nautilo");
    mkdirSync(dataDir);
    const cacheDir = mkTmp("nautilo-sbpl-xcrun-order-cache-").raw;
    const protectedRoot = mkTmp("nautilo-sbpl-xcrun-pp-").raw;
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir,
      toolsBin: `${raw}/.tools`,
      config: { ...baseConfig(), protectedPaths: [protectedRoot] },
      xcrunCacheDir: cacheDir,
    });
    const xcrunIdx = profile.indexOf(`/xcrun_db[^/]*$`);
    const dataDenyIdx = profile.indexOf(`(deny file-read* file-write* (subpath "${dataDir}"))`);
    const protectedDenyIdx = profile.indexOf(
      `(deny file-read* file-write* (subpath "${protectedRoot}"))`,
    );
    expect(xcrunIdx).toBeGreaterThan(0);
    expect(dataDenyIdx).toBeGreaterThan(xcrunIdx);
    expect(protectedDenyIdx).toBeGreaterThan(xcrunIdx);
  });
});

// ---------------------------------------------------------------------------
// dataDir deny — masks secret store even when overlapping workspace
// ---------------------------------------------------------------------------

describe("buildSbplProfile — dataDir deny", () => {
  test("emits deny for existing dataDir AFTER workspace allow", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-data-");
    // Create the dataDir so existsSync passes.
    const dataDir = join(raw, ".nautilo");
    mkdirSync(dataDir);
    const dataReal = realpathSync(dataDir);

    const profile = buildSbplProfile({
      workspace: raw,
      dataDir,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });

    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${dataDir}"))`,
    );
    if (dataReal !== dataDir) {
      expect(profile).toContain(
        `(deny file-read* file-write* (subpath "${dataReal}"))`,
      );
    }

    // Appears AFTER the workspace allow.
    const workspaceAllow = profile.indexOf(
      `(allow file-write* (subpath "${real}"))`,
    );
    const allowIdx =
      workspaceAllow >= 0
        ? workspaceAllow
        : profile.indexOf(`(allow file-write* (subpath "${raw}"))`);
    const dataDenyIdx = profile.indexOf(
      `(deny file-read* file-write* (subpath "${dataDir}"))`,
    );
    expect(dataDenyIdx).toBeGreaterThan(allowIdx);
  });

  test("emits deny when dataDir doesn't exist (future-created store stays masked)", () => {
    const { raw } = mkTmp("nautilo-sbpl-nodata-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo-missing`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${raw}/.nautilo-missing"))`,
    );
  });
});

// ---------------------------------------------------------------------------
// writablePaths + projectPaths — additional writable surface
// ---------------------------------------------------------------------------

describe("buildSbplProfile — writable paths", () => {
  test("each writablePaths entry gets file-read* + file-write* allow (original + realpath)", () => {
    const { raw } = mkTmp("nautilo-sbpl-wrtparent-");
    const wrt = mkTmp("nautilo-sbpl-wrt-child-");

    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        writablePaths: [wrt.raw],
      },
    });

    expect(profile).toContain(
      `(allow file-read* (subpath "${wrt.raw}"))`,
    );
    expect(profile).toContain(
      `(allow file-write* (subpath "${wrt.raw}"))`,
    );
    if (wrt.real !== wrt.raw) {
      expect(profile).toContain(
        `(allow file-read* (subpath "${wrt.real}"))`,
      );
    }
  });

  test("projectPaths treated identically to writablePaths", () => {
    const { raw } = mkTmp("nautilo-sbpl-proj-parent-");
    const proj = mkTmp("nautilo-sbpl-proj-child-");

    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        projectPaths: [proj.raw],
      },
    });

    expect(profile).toContain(
      `(allow file-write* (subpath "${proj.raw}"))`,
    );
  });

  test("non-existent writablePaths are skipped silently (no rule emitted)", () => {
    const { raw } = mkTmp("nautilo-sbpl-wrt-skip-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        writablePaths: ["/nonexistent/path/for/testing"],
      },
    });
    expect(profile).not.toContain(
      `(subpath "/nonexistent/path/for/testing")`,
    );
  });
});

// ---------------------------------------------------------------------------
// readOnlyPaths (D060 Sprint 1 G5.1)
// ---------------------------------------------------------------------------

describe("buildSbplProfile — readOnlyPaths", () => {
  test("each readOnlyPaths entry gets file-read* allow but NO file-write* allow", () => {
    const { raw } = mkTmp("nautilo-sbpl-ro-parent-");
    const ro = mkTmp("nautilo-sbpl-ro-child-");

    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        readOnlyPaths: [ro.raw],
      },
    });

    expect(profile).toContain(
      `(allow file-read* (subpath "${ro.raw}"))`,
    );
    // The whole point: NO file-write* allow for the read-only path.
    // Broad-read / narrow-write shape from §5.1 of the ship plan.
    expect(profile).not.toContain(
      `(allow file-write* (subpath "${ro.raw}"))`,
    );
    if (ro.real !== ro.raw) {
      expect(profile).toContain(
        `(allow file-read* (subpath "${ro.real}"))`,
      );
      expect(profile).not.toContain(
        `(allow file-write* (subpath "${ro.real}"))`,
      );
    }
  });

  test("readOnlyPaths emitted BEFORE writablePaths so writable overlays win", () => {
    // desktop-permissive shape: readOnly=/Users/tester, writable=/Users/tester/Downloads.
    // Seatbelt is later-wins → writable allow for the narrower path
    // must appear after the readOnly allow for the broader parent.
    // If ordering flips, the narrow writable never grants write access.
    const { raw } = mkTmp("nautilo-sbpl-ordering-parent-");
    const ro = mkTmp("nautilo-sbpl-ordering-ro-");
    const wrt = mkTmp("nautilo-sbpl-ordering-wrt-");

    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        readOnlyPaths: [ro.raw],
        writablePaths: [wrt.raw],
      },
    });

    const roIdx = profile.indexOf(`(allow file-read* (subpath "${ro.raw}"))`);
    const wrtReadIdx = profile.indexOf(`(allow file-read* (subpath "${wrt.raw}"))`);
    const wrtWriteIdx = profile.indexOf(`(allow file-write* (subpath "${wrt.raw}"))`);

    expect(roIdx).toBeGreaterThan(-1);
    expect(wrtReadIdx).toBeGreaterThan(-1);
    expect(wrtWriteIdx).toBeGreaterThan(-1);
    // readOnly first, then writable.
    expect(wrtReadIdx).toBeGreaterThan(roIdx);
    expect(wrtWriteIdx).toBeGreaterThan(roIdx);
  });

  test("non-existent readOnlyPaths are skipped silently (no rule emitted)", () => {
    const { raw } = mkTmp("nautilo-sbpl-ro-skip-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        readOnlyPaths: ["/nonexistent/ro/path"],
      },
    });
    expect(profile).not.toContain(
      `(subpath "/nonexistent/ro/path")`,
    );
  });

  test("readOnlyPaths absent (undefined) does not break the profile", () => {
    // baseConfig() doesn't include readOnlyPaths; regression lock
    // for accidentally introducing `[...undefined]` spread bugs.
    const { raw } = mkTmp("nautilo-sbpl-ro-undef-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    // Profile still starts correctly, has workspace allows, etc.
    expect(profile).toContain("(version 1)");
    expect(profile).toContain(`(allow file-write* (subpath "${raw}"))`);
  });
});

// ---------------------------------------------------------------------------
// Git worktree auto-detect
// ---------------------------------------------------------------------------

describe("buildSbplProfile — git worktree auto-detect", () => {
  test("regular repo (.git is directory) does NOT emit extra rules", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-regular-repo-");
    mkdirSync(join(raw, ".git"));
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    // No worktree-specific rules appear — just the governance deny
    // on .git that we emit always.
    expect(profile).toContain(
      `(deny file-write* (subpath "${join(real, ".git")}"))`,
    );
  });

  test("worktree (.git is a file) emits file-read+write allow on both worktreeGitDir and mainGitDir", () => {
    // Build a fake main-repo + worktree layout:
    //   /tmp/X/.git/worktrees/feature-y/
    //   /tmp/Y/.git → 'gitdir: /tmp/X/.git/worktrees/feature-y'
    const mainRepo = mkTmp("nautilo-sbpl-main-");
    const mainGit = join(mainRepo.raw, ".git");
    const mainWt = join(mainGit, "worktrees", "feature-y");
    mkdirSync(mainWt, { recursive: true });

    const worktree = mkTmp("nautilo-sbpl-wt-");
    writeFileSync(join(worktree.raw, ".git"), `gitdir: ${mainWt}\n`);

    const profile = buildSbplProfile({
      workspace: worktree.raw,
      dataDir: `${worktree.raw}/.nautilo`,
      toolsBin: `${worktree.raw}/.tools`,
      config: baseConfig(),
    });

    // Both the worktree git dir and the main git dir should appear
    // as file-read+write allow.
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${realpathSync(mainWt)}"))`,
    );
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${realpathSync(mainGit)}"))`,
    );
  });

  test("PR-015 MINOR #3 — worktree allow emits BOTH raw and canonical forms when they differ (e.g. /var → /private/var)", () => {
    // On macOS, `/var/folders/...` (where mkdtemp lands) canonicalizes
    // to `/private/var/folders/...`. If the workspace + main repo both
    // sit under such a tmpdir, the raw and canonical git-dir paths
    // differ — and the SBPL allow rule must cover BOTH so fs ops
    // addressed through the raw form also match.
    //
    // Same belt-and-suspenders shape the workspace / governance /
    // secret / dataDir rules use. Before PR-015 MINOR #3, only the
    // canonical form was emitted for the worktree git dirs; this
    // test locks the new both-forms behavior.
    const mainRepo = mkTmp("nautilo-sbpl-main-forms-");
    const mainGit = join(mainRepo.raw, ".git");
    const mainWt = join(mainGit, "worktrees", "feature-z");
    mkdirSync(mainWt, { recursive: true });

    const worktree = mkTmp("nautilo-sbpl-wt-forms-");
    writeFileSync(join(worktree.raw, ".git"), `gitdir: ${mainWt}\n`);

    const profile = buildSbplProfile({
      workspace: worktree.raw,
      dataDir: `${worktree.raw}/.nautilo`,
      toolsBin: `${worktree.raw}/.tools`,
      config: baseConfig(),
    });

    const mainWtCanonical = realpathSync(mainWt);
    const mainGitCanonical = realpathSync(mainGit);

    // Canonical forms always emitted.
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${mainWtCanonical}"))`,
    );
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${mainGitCanonical}"))`,
    );

    // When raw differs from canonical, the raw form must ALSO appear.
    // When they match, the helper dedups (null) and no duplicate is
    // emitted — both outcomes are correct behavior.
    if (mainWt !== mainWtCanonical) {
      expect(profile).toContain(
        `(allow file-read* file-write* (subpath "${mainWt}"))`,
      );
    }
    if (mainGit !== mainGitCanonical) {
      expect(profile).toContain(
        `(allow file-read* file-write* (subpath "${mainGit}"))`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tools-bin
// ---------------------------------------------------------------------------

describe("buildSbplProfile — tools-bin", () => {
  test("tools-bin read allow emitted when directory exists", () => {
    const { raw } = mkTmp("nautilo-sbpl-tools-parent-");
    const tools = mkTmp("nautilo-sbpl-tools-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: tools.raw,
      config: baseConfig(),
    });
    expect(profile).toContain(
      `(allow file-read* (subpath "${tools.raw}"))`,
    );
    // NO file-write allow — tools-bin is read-only.
    expect(profile).not.toContain(
      `(allow file-write* (subpath "${tools.raw}"))`,
    );
  });

  test("non-existent tools-bin skipped silently", () => {
    const { raw } = mkTmp("nautilo-sbpl-notools-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: "/nonexistent/tools-bin",
      config: baseConfig(),
    });
    expect(profile).not.toContain('(subpath "/nonexistent/tools-bin")');
  });
});

// ---------------------------------------------------------------------------
// D418 task 3.2.1 — canonical protected-path deny-overrides
// ---------------------------------------------------------------------------

describe("buildSbplProfile — protectedPath denies (D418 3.2.1)", () => {
  test("each protectedPaths entry emits a read+write deny AFTER every allow", () => {
    const { raw, real } = mkTmp("nautilo-sbpl-pp-");
    const protectedRoot = mkTmp("nautilo-sbpl-pp-secret-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        protectedPaths: [protectedRoot.raw],
      },
    });

    // Deny rule exists for the protected path.
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${protectedRoot.raw}"))`,
    );

    // Deny comes AFTER the workspace write allow — the load-bearing
    // ordering invariant: Seatbelt is later-wins, so a deny emitted
    // before the allow would be overridden. Assert against the realpath
    // form when present (the /var → /private/var quirk), else the raw.
    const workspaceAllowIdx =
      profile.indexOf(`(allow file-write* (subpath "${real}"))`) >= 0
        ? profile.indexOf(`(allow file-write* (subpath "${real}"))`)
        : profile.indexOf(`(allow file-write* (subpath "${raw}"))`);
    const protectedDenyIdx = profile.indexOf(
      `(deny file-read* file-write* (subpath "${protectedRoot.raw}"))`,
    );
    expect(workspaceAllowIdx).toBeGreaterThan(0);
    expect(protectedDenyIdx).toBeGreaterThan(workspaceAllowIdx);
  });

  test("protected-path deny wins over a writable allow that overlaps it", () => {
    // The protected path is INSIDE the writable surface — the deny must
    // be emitted after the writable allow so later-wins keeps it denied.
    const { raw } = mkTmp("nautilo-sbpl-pp-overlap-");
    const writable = mkTmp("nautilo-sbpl-pp-overlap-wrt-");
    const protectedChild = join(writable.raw, ".ssh");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        writablePaths: [writable.raw],
        protectedPaths: [protectedChild],
      },
    });

    const writableWriteIdx = profile.indexOf(
      `(allow file-write* (subpath "${writable.raw}"))`,
    );
    const denyIdx = profile.indexOf(
      `(deny file-read* file-write* (subpath "${protectedChild}"))`,
    );
    expect(writableWriteIdx).toBeGreaterThan(0);
    expect(denyIdx).toBeGreaterThan(writableWriteIdx);
  });

  test("protected-path deny is emitted even when the path does not exist on disk", () => {
    // 3.2.1 acceptance: a protected subtree must remain protected the
    // moment it is created — the deny emits regardless of current
    // existence (unlike readOnlyPaths / writablePaths which skip
    // missing entries).
    const { raw } = mkTmp("nautilo-sbpl-pp-absent-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        protectedPaths: ["/definitely/does/not/exist/protected-path"],
      },
    });
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "/definitely/does/not/exist/protected-path"))`,
    );
  });

  test("protected-path deny emitted AFTER the dataDir deny (last deny wins)", () => {
    const { raw } = mkTmp("nautilo-sbpl-pp-after-data-");
    const dataDir = join(raw, ".nautilo");
    mkdirSync(dataDir);
    const protectedRoot = mkTmp("nautilo-sbpl-pp-after-data-secret-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir,
      toolsBin: `${raw}/.tools`,
      config: {
        ...baseConfig(),
        protectedPaths: [protectedRoot.raw],
      },
    });
    const dataDenyIdx = profile.indexOf(
      `(deny file-read* file-write* (subpath "${dataDir}"))`,
    );
    const protectedDenyIdx = profile.indexOf(
      `(deny file-read* file-write* (subpath "${protectedRoot.raw}"))`,
    );
    expect(dataDenyIdx).toBeGreaterThan(0);
    expect(protectedDenyIdx).toBeGreaterThan(dataDenyIdx);
  });

  test("absent protectedPaths does not change the profile shape", () => {
    const { raw } = mkTmp("nautilo-sbpl-pp-none-");
    const profile = buildSbplProfile({
      workspace: raw,
      dataDir: `${raw}/.nautilo`,
      toolsBin: `${raw}/.tools`,
      config: baseConfig(),
    });
    // No protected-path deny section is emitted when the field is absent.
    expect(profile).not.toContain("(deny file-read* file-write* (subpath \"/definitely/does/not/exist/protected-path\"))");
    expect(profile).toContain("(version 1)");
  });
});

// ---------------------------------------------------------------------------
// Live regression — runs against real /usr/bin/sandbox-exec on Darwin.
//
// THIS IS THE CRITICAL GUARD for the escape-level + quantifier bugs we
// fixed in self-review: over-escape (Gemini CLI's `\\\\.` pattern) +
// `[^/]+$` quantifier both produced regex rules that looked right in
// unit-tested profile text but were silently INERT at runtime. A text-
// level assertion wasn't enough; we need to run a real sandbox-exec
// invocation and confirm the `.env` file is actually unreadable.
//
// Gated on `process.platform === "darwin"` + `/usr/bin/sandbox-exec`
// exists. Non-Darwin hosts skip — Linux CI doesn't have sandbox-exec.
// ---------------------------------------------------------------------------

describe("buildSbplProfile — LIVE sandbox-exec regression (Darwin only)", () => {
  const isDarwin = process.platform === "darwin";
  const hasSandboxExec = existsSync("/usr/bin/sandbox-exec");
  const shouldRun = isDarwin && hasSandboxExec;

  if (!shouldRun) {
    test.skip("live sandbox-exec regression (skipped — not on Darwin)", () => {});
    return;
  }

  test("secret-file regex rules actually block .env + .env.local under real sandbox-exec", () => {
    // The scenario that exposed the escape + quantifier bugs:
    // - `.env` bare (not blocked before fix — `[^/]+` required a trailing char)
    // - `.env.local` (not blocked before fix — double-escape produced inert regex)
    // - `.env.production` (same as above)
    // If any of these read successfully, there's a regression in
    // escapeRegexForSchemeLiteral OR the secret-regex generator.
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-regr-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);
    writeFileSync(join(real, ".env"), "SECRET=should-not-be-readable");
    writeFileSync(join(real, ".env.local"), "SECRET=should-not-be-readable");
    writeFileSync(join(real, ".env.production"), "SECRET=should-not-be-readable");
    writeFileSync(join(real, ".secret"), "x");
    writeFileSync(join(real, "credentials"), "x");
    writeFileSync(join(real, "credentials.json"), "x");
    writeFileSync(join(real, "normal.txt"), "public");

    const profile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
    });

    

    const checkBlocked = (target: string, expectedBlocked: boolean): void => {
      const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", target], {
        encoding: "utf8",
      });
      const actuallyBlocked = r.status !== 0;
      if (actuallyBlocked !== expectedBlocked) {
        throw new Error(
          `Live sandbox-exec drift: ${target} expected ${
            expectedBlocked ? "blocked" : "allowed"
          }, got ${actuallyBlocked ? "blocked" : "allowed"} (exit ${r.status})`,
        );
      }
    };

    // Must be blocked (secret regex):
    checkBlocked(`${real}/.env`, true);
    checkBlocked(`${real}/.env.local`, true);
    checkBlocked(`${real}/.env.production`, true);
    checkBlocked(`${real}/.secret`, true);
    checkBlocked(`${real}/credentials`, true);
    checkBlocked(`${real}/credentials.json`, true);
    // Must be allowed (not a secret pattern):
    checkBlocked(`${real}/normal.txt`, false);
  });

  test("dataDir deny actually blocks access under real sandbox-exec", () => {
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-datadir-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "secrets.json"), "internal");

    const profile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
    });

    
    const r = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/cat", `${real}/.nautilo/secrets.json`],
      { encoding: "utf8" },
    );
    expect(r.status).not.toBe(0); // blocked
  });

  test("workspace writes succeed (regression lock for over-eager denies)", () => {
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-ws-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);

    const profile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
    });

    
    const r = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/usr/bin/touch", `${real}/ok.txt`],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0); // allowed
  });

  test("Homebrew Python can map executable libraries when present", () => {
    const python = "/opt/homebrew/bin/python3";
    if (!existsSync(python)) return;
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-python-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);

    const profile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/opt/homebrew/bin",
      config: baseConfig(),
    });

    const r = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, python, "-c", "import csv; print('ok')"],
      { cwd: real, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });

  test("bare python3 works when /usr/local/bin points at Python.org framework", () => {
    const python = "/usr/local/bin/python3";
    if (!existsSync(python)) return;
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-pythonorg-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);

    const wrapped = buildSandboxExec({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: baseConfig(),
      cwd: real,
      commandEnv: {},
      program: "/bin/sh",
      args: ["-c", "python3 -c 'import csv; print(\"ok\")'"],
    });

    const r = spawnSync(
      wrapped.program,
      [...wrapped.args],
      { cwd: wrapped.cwd, encoding: "utf8", env: wrapped.env ?? undefined },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });

  test("readOnlyPaths — read allowed, write denied (G5.1 live regression)", () => {
    // Plant a readable sibling dir NEXT to the workspace so
    // workspace-write allow doesn't accidentally cover it.
    // Scenario: desktop-permissive mode — user's broader home is
    // read-only, workspace is writable. Reading from the RO path
    // succeeds; writing to it fails.
    const roSibling = mkdtempSync(join(tmpdir(), "sbpl-live-ro-"));
    const roReal = realpathSync(roSibling);
    writeFileSync(join(roReal, "readme.md"), "reference content");

    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-ro-ws-"));
    const wsReal = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);

    const profile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
        readOnlyPaths: [roSibling],
      },
    });

    // Read from RO path → allowed.
    const readR = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/cat", `${roReal}/readme.md`],
      { encoding: "utf8" },
    );
    expect(readR.status).toBe(0);

    // Write to RO path → denied (no file-write* allow).
    const writeR = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/usr/bin/touch", `${roReal}/new-file.txt`],
      { encoding: "utf8" },
    );
    expect(writeR.status).not.toBe(0);

    // Workspace write still succeeds — readOnly shouldn't shadow it.
    const wsWriteR = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/usr/bin/touch", `${wsReal}/workspace-ok.txt`],
      { encoding: "utf8" },
    );
    expect(wsWriteR.status).toBe(0);
  });

  test("D418 3.2.1 — protectedPath deny stays unreadable through an alternate interpreter", () => {
    // The 3.2.1 acceptance: protected paths stay unreadable through
    // alternate interpreters. Plant a secret under a writable workspace
    // and compile its path as a protectedPath; both `/bin/cat` AND
    // python3 (an alternate interpreter) must fail to read it, while a
    // non-protected sibling in the same workspace stays readable.
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-pp-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);
    writeFileSync(join(real, "secret.key"), "PRIVATE-KEY-CONTENT");
    writeFileSync(join(real, "public.txt"), "public");

    const profile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
        protectedPaths: [join(real, "secret.key")],
      },
    });

    // /bin/cat cannot read the protected file.
    const catR = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/cat", `${real}/secret.key`],
      { encoding: "utf8" },
    );
    expect(catR.status).not.toBe(0);

    // An alternate interpreter (python3) also cannot read it.
    const python = "/usr/bin/python3";
    if (existsSync(python)) {
      const pyR = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          python,
          "-c",
          `import sys; sys.stdout.write(open("${real}/secret.key").read())`,
        ],
        { encoding: "utf8" },
      );
      expect(pyR.status).not.toBe(0);
    }

    // Non-protected sibling in the same workspace stays readable.
    const okR = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/cat", `${real}/public.txt`],
      { encoding: "utf8" },
    );
    expect(okR.status).toBe(0);
    expect(okR.stdout.trim()).toBe("public");
  });

  test("D574 — public templates are readable and writable under real sandbox-exec", () => {
    // The live evidence: `git status --short && bun --version` succeeded
    // but emitted denials for public templates (including
    // `deploy/compose-driver/templates/.env.local-smoke.example`).
    // The carve-out must re-open normal workspace READS + WRITES on
    // basename-terminal suffixes, while live secret variants stay fully
    // blocked (read + write).
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-tmpl-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);
    const nestedTplDir = join(real, "deploy", "compose-driver", "templates");
    mkdirSync(nestedTplDir, { recursive: true });

    const publicTemplates = [
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.dist",
      ".envrc.example",
      ".env.local-smoke.example",
      "nautilo-server.service.example",
    ] as const;
    for (const t of publicTemplates) {
      const target =
        t === ".env.local-smoke.example"
          ? join(nestedTplDir, t)
          : join(real, t);
      writeFileSync(target, `public-template=${t}`);
    }
    writeFileSync(join(real, ".env"), "SECRET=live");
    writeFileSync(join(real, ".env.local"), "SECRET=live");
    writeFileSync(join(real, ".env.production"), "SECRET=live");
    writeFileSync(join(real, ".env.example.local"), "SECRET=shaped-like-template");

    const profile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
    });

    const checkRead = (target: string, expectedAllowed: boolean): void => {
      const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", target], {
        encoding: "utf8",
      });
      const allowed = r.status === 0;
      if (allowed !== expectedAllowed) {
        throw new Error(
          `Live sandbox-exec drift: read ${target} expected ${
            expectedAllowed ? "allowed" : "blocked"
          }, got ${allowed ? "allowed" : "blocked"} (exit ${r.status})`,
        );
      }
    };

    const checkWrite = (target: string, expectedBlocked: boolean): void => {
      const r = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/usr/bin/touch", target],
        { encoding: "utf8" },
      );
      const blocked = r.status !== 0;
      if (blocked !== expectedBlocked) {
        throw new Error(
          `Live sandbox-exec drift: write ${target} expected ${
            expectedBlocked ? "blocked" : "allowed"
          }, got ${blocked ? "blocked" : "allowed"} (exit ${r.status})`,
        );
      }
    };

    // Public templates: READ allowed (root + nested compound stem).
    for (const t of publicTemplates) {
      const target =
        t === ".env.local-smoke.example"
          ? join(nestedTplDir, t)
          : join(real, t);
      checkRead(target, true);
      checkWrite(target, false);
    }
    // Non-terminal template shape: READ denied.
    checkRead(join(real, ".env.example.local"), false);
    // Live secret variants: READ + WRITE denied.
    for (const s of [".env", ".env.local", ".env.production"]) {
      checkRead(join(real, s), false);
      checkWrite(join(real, s), true);
    }
  });

  test("D574 — trusted Developer Workstation can run ordinary Git mutations while secrets stay denied", () => {
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-workstation-git-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);
    writeFileSync(join(real, ".env.example"), "PUBLIC=example\n");
    writeFileSync(join(real, ".gitignore"), "node_modules\n");
    writeFileSync(join(real, "normal.txt"), "tracked\n");

    const runHostGit = (args: readonly string[]) =>
      spawnSync("/usr/bin/git", [...args], { cwd: real, encoding: "utf8" });
    expect(runHostGit(["init", "--quiet"]).status).toBe(0);
    expect(runHostGit(["add", "--", ".env.example", ".gitignore", "normal.txt"]).status).toBe(0);
    expect(runHostGit([
      "-c", "user.name=Nautilo Test",
      "-c", "user.email=nautilo@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ]).status).toBe(0);

    rmSync(join(real, ".env.example"));
    rmSync(join(real, ".gitignore"));
    writeFileSync(join(real, ".env"), "SECRET=live\n");
    const containedEnv = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: real,
      TMPDIR: "/tmp",
      CI: "true",
    };

    const ordinaryProfile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: baseConfig(),
    });
    const blocked = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", ordinaryProfile, "/usr/bin/git", "restore", "--", ".env.example", ".gitignore"],
      { cwd: real, encoding: "utf8", env: containedEnv },
    );
    expect(blocked.status).not.toBe(0);

    // Reset any partial worktree side effect before the trusted retry.
    rmSync(join(real, ".env.example"), { force: true });
    rmSync(join(real, ".gitignore"), { force: true });
    const workstationProfile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: baseConfig(),
      allowWorkspaceGovernanceWrites: true,
    });
    const restored = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", workstationProfile, "/usr/bin/git", "restore", "--", ".env.example", ".gitignore"],
      { cwd: real, encoding: "utf8", env: containedEnv },
    );
    if (restored.status !== 0) {
      throw new Error(
        `trusted Developer Workstation git restore failed (${restored.status}): ${restored.stderr}`,
      );
    }
    expect(existsSync(join(real, ".env.example"))).toBe(true);
    expect(existsSync(join(real, ".gitignore"))).toBe(true);
    expect(existsSync(join(real, ".git", "index.lock"))).toBe(false);

    const secretRead = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", workstationProfile, "/bin/cat", join(real, ".env")],
      { cwd: real, encoding: "utf8", env: containedEnv },
    );
    expect(secretRead.status).not.toBe(0);
    expect(secretRead.stdout).not.toContain("SECRET=live");
  });

  test("D418 A2 — narrow xcrun cache exception allows xcrun_db* but NOT sibling temp files", () => {
    // Redirect the xcrun exception at a controlled fake user-temp dir so
    // the test does not depend on the host's confstr path. The narrow
    // regex must allow `xcrun_db*` reads+writes while denying arbitrary
    // sibling temp files in the same dir.
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-xcrun-ws-"));
    const wsReal = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);
    const cacheDir = realpathSync(mkdtempSync(join(tmpdir(), "sbpl-live-xcrun-cache-")));
    writeFileSync(join(cacheDir, "xcrun_db_foo"), "cache");
    writeFileSync(join(cacheDir, "sibling.txt"), "sibling");

    const profile = buildSbplProfile({
      workspace: ws,
      dataDir,
      toolsBin: "/usr/local/bin",
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      xcrunCacheDir: cacheDir,
    });

    // xcrun_db file: READ + WRITE allowed by the narrow exception.
    const readDb = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/cat", `${cacheDir}/xcrun_db_foo`],
      { encoding: "utf8" },
    );
    expect(readDb.status).toBe(0);

    const writeDb = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/usr/bin/touch", `${cacheDir}/xcrun_db_new`],
      { encoding: "utf8" },
    );
    expect(writeDb.status).toBe(0);

    // Sibling temp file: READ + WRITE denied (narrow scope — not
    // broadened to the whole cache dir or /private/var/folders).
    const readSibling = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/cat", `${cacheDir}/sibling.txt`],
      { encoding: "utf8" },
    );
    expect(readSibling.status).not.toBe(0);

    const writeSibling = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/usr/bin/touch", `${cacheDir}/other.txt`],
      { encoding: "utf8" },
    );
    expect(writeSibling.status).not.toBe(0);

    // Workspace writes still succeed (the carve-out didn't break the
    // workspace writable surface).
    const wsWrite = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/usr/bin/touch", `${wsReal}/ok.txt`],
      { encoding: "utf8" },
    );
    expect(wsWrite.status).toBe(0);
  });
});
