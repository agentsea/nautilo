import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const WORKBENCH_ROOT = join(import.meta.dirname, "../..");
const SRC_ROOT = join(WORKBENCH_ROOT, "src");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkSourceFiles(full));
      continue;
    }
    if ([...SOURCE_EXTENSIONS].some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function rel(path: string): string {
  return relative(WORKBENCH_ROOT, path);
}

function filesMatching(pattern: RegExp): string[] {
  return walkSourceFiles(SRC_ROOT)
    .filter((file) => pattern.test(readFileSync(file, "utf-8")))
    .map(rel)
    .sort();
}

describe("canonical Workbench auth/profile paths", () => {
  test("useAuthState is deleted; useAuth is the only Workbench auth hook", () => {
    expect(filesMatching(/useAuthState|use-auth-state/)).toEqual([]);
  });

  test("auth consumers use nested session/viewer paths, not ambiguous top-level fields", () => {
    expect(
      filesMatching(
        /\bauth\.(role|label|isVerified|userIdentity|state|identity|signIn|signOut|getAccessToken)\b/,
      ),
    ).toEqual([]);
  });

  test("only ProfileProvider fetches the agent profile", () => {
    expect(filesMatching(/apiClient\.getProfile/)).toEqual([
      "src/contexts/profile-context.tsx",
    ]);
  });

  test("no workbench source accesses legacy session-token localStorage key", () => {
    expect(
      filesMatching(
        /localStorage\.(getItem|setItem|removeItem)\("nautilo:session-token"\)|SESSION_TOKEN_KEY\s*=\s*"nautilo:session-token"/,
      ),
    ).toEqual([]);
  });

  test("identity UI never renders the role-projected avatar route directly", () => {
    expect(filesMatching(/src=["']\/api\/profile\/avatar["']/)).toEqual([]);
  });

  test("profile avatar route symbol is centralized in ProfileProvider", () => {
    // D243 — `profile-section.tsx` is an audited exception: the
    // Settings "Download avatar" button intentionally fetches the
    // original via `${PROFILE_AVATAR_URL}?size=full` (a different
    // cache key than ProfileProvider's default thumbnail fetch), so
    // it constructs the URL inline rather than going through context.
    // Any other consumer of this symbol IS the sprawl this guard
    // exists to catch — keep the allow-list to these two files.
    expect(filesMatching(/PROFILE_AVATAR_URL/)).toEqual([
      "src/contexts/profile-context.tsx",
      "src/pages/settings/sections/profile-section.tsx",
    ]);
  });
});
