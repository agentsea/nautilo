const PROFILE_SLUG = /^[a-z0-9_-]{1,32}$/;

/**
 * Validate a raw profile slug. Shared by the argv path and the
 * `NAUTILO_PROFILE` env path so validation lives in ONE place.
 *
 * Returns the lowercased slug on success; throws on malformed input.
 */
function validateProfileSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (slug !== raw.trim()) {
    throw new Error(
      `Invalid "--profile" value "${raw}": use lowercase letters, digits, underscore, or hyphen only`,
    );
  }
  if (!PROFILE_SLUG.test(slug)) {
    throw new Error(
      `Invalid "--profile" value "${raw}": expected 1–32 characters matching [a-z0-9_-]`,
    );
  }
  return slug;
}

/**
 * Parse `--profile <slug>` from argv, with a `NAUTILO_PROFILE` env fallback
 * (Stack 198 / M161 Phase 5). Returns `undefined` when neither is present.
 *
 * Slug must match `[a-z0-9_-]{1,32}` (already lowercased); otherwise throws.
 *
 * `env` defaults to `process.env` so the production call site in
 * `electron/main.ts` (`parseProfileFromArgv(process.argv)`) picks up
 * `NAUTILO_PROFILE` without a second argument. Unit tests pass an
 * explicit `env` to keep this function pure and deterministic.
 *
 * If both `--profile` and `NAUTILO_PROFILE` are present they MUST agree
 * (same slug after normalization); a disagreement throws — there is one
 * canonical parser/validator, never two sources of truth.
 */
export function parseProfileFromArgv(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const idx = argv.indexOf("--profile");
  const envRaw = env["NAUTILO_PROFILE"];

  if (idx !== -1) {
    const raw = argv[idx + 1];
    if (raw === undefined || raw.startsWith("-")) {
      throw new Error(
        'Missing value for "--profile" — expected a slug of 1–32 characters [a-z0-9_-]',
      );
    }
    const slug = validateProfileSlug(raw);
    if (envRaw !== undefined && envRaw !== "") {
      const envSlug = validateProfileSlug(envRaw);
      if (envSlug !== slug) {
        throw new Error(
          `"--profile" (${slug}) and NAUTILO_PROFILE (${envSlug}) disagree — set only one`,
        );
      }
    }
    return slug;
  }

  if (envRaw !== undefined && envRaw !== "") {
    return validateProfileSlug(envRaw);
  }

  return undefined;
}
