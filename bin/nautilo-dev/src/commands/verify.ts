import { verify, type VerifyReport } from "../lib/verify";

export const VERIFY_FAILURE_IDS_JSON_FLAG = "--failure-ids-json";
export const AUTHORITATIVE_VERIFY_FAILURE_IDS = [
  "health",
  "identity",
  "spa",
  "runtime-role",
  "direct-postgres",
  "oidc",
  "gate",
  "unknown",
] as const;
export type AuthoritativeVerifyFailureId = typeof AUTHORITATIVE_VERIFY_FAILURE_IDS[number];
const AUTHORITATIVE_VERIFY_FAILURE_ID_SET = new Set<string>(AUTHORITATIVE_VERIFY_FAILURE_IDS);

export function authoritativeVerifyFailureIds(report: VerifyReport): AuthoritativeVerifyFailureId[] {
  if (report.allPassed) return [];
  const ids: AuthoritativeVerifyFailureId[] = [];
  for (const check of report.checks) {
    if (check.passed || check.nonFatal === true) continue;
    const id = AUTHORITATIVE_VERIFY_FAILURE_ID_SET.has(check.id) ? check.id as AuthoritativeVerifyFailureId : "unknown";
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return ["unknown"];
  return ids.sort((a, b) =>
    AUTHORITATIVE_VERIFY_FAILURE_IDS.indexOf(a) - AUTHORITATIVE_VERIFY_FAILURE_IDS.indexOf(b));
}

export function serializeAuthoritativeVerifyFailureIds(report: VerifyReport): string {
  return JSON.stringify(authoritativeVerifyFailureIds(report));
}

export function parseAuthoritativeVerifyFailureId(output: string): AuthoritativeVerifyFailureId {
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("[")) continue;
    try {
      const ids = JSON.parse(line) as unknown;
      if (
        Array.isArray(ids) && ids.length > 0 &&
        ids.every((id) => typeof id === "string" && AUTHORITATIVE_VERIFY_FAILURE_ID_SET.has(id)) &&
        new Set(ids).size === ids.length &&
        ids.every((id, index) => index === 0 ||
          AUTHORITATIVE_VERIFY_FAILURE_IDS.indexOf(ids[index - 1] as AuthoritativeVerifyFailureId) <
            AUTHORITATIVE_VERIFY_FAILURE_IDS.indexOf(id as AuthoritativeVerifyFailureId))
      ) return ids[0] as AuthoritativeVerifyFailureId;
    } catch {
      // Ignore arbitrary stderr and fail closed to the fixed unknown code.
    }
  }
  return "unknown";
}

/**
 * `nautilo-dev verify` command.
 *
 * Default mode is the D427 Wave 4 authoritative runtime-acceptance gate
 * (fail-closed on runtime-role, parameterized Neon HTTP, OIDC, identity, and
 * SPA failures). `--smoke` selects the pre-Wave-4 nonfatal diagnostic and
 * explicitly does NOT claim acceptance.
 *
 * `--smoke` is sourced from `process.argv` here because the dispatcher in
 * `src/index.ts` calls `verifyCmd()` with no arguments; the flag wiring stays
 * within this command file.
 */
export async function verifyCmd(): Promise<void> {
  const smoke = process.argv.slice(2).includes("--smoke");
  const emitFailureIds = process.argv.slice(2).includes(VERIFY_FAILURE_IDS_JSON_FLAG);
  const report = await verify({ smoke });

  if (emitFailureIds) {
    console.log(serializeAuthoritativeVerifyFailureIds(report));
    if (!report.allPassed) process.exit(1);
    return;
  }

  const modeLabel =
    report.mode === "smoke"
      ? "smoke (nonfatal diagnostic — NOT acceptance)"
      : "authoritative runtime acceptance";
  console.log(
    `Verify [${modeLabel}]: ${report.allPassed ? "all checks passed" : "FAILURES"}`,
  );
  console.log("");

  for (const c of report.checks) {
    const mark = c.passed ? "✓" : c.nonFatal ? "⚠" : "✗";
    console.log(`  ${mark} [${c.id}] ${c.title}`);
    console.log(`      ${c.detail}`);
  }

  if (!report.allPassed) {
    process.exit(1);
  }
}

// Exported for unit tests that want to construct/inspect a report shape.
export type { VerifyReport };
