/**
 * Dev-only reset for the shared `test-cruft` scratch instance.
 *
 * This intentionally composes the existing instance-level primitives instead
 * of deleting fixture rows by hand:
 *   1. delete-instance test-cruft --yes
 *   2. infra-start with NAUTILO_INSTANCE_ID=test-cruft
 *
 * Medium/long-term fixture hardening belongs in D266; this is the safe
 * operator escape hatch when the shared scratch DB gets haunted.
 */
import { deleteInstance } from "./delete-instance";
import { infraStart } from "./infra-start";
import { persistLocalProfileRetention } from "./protect-instance";

export const TEST_CRUFT_INSTANCE_ID = "test-cruft";

export interface ResetTestCruftDeps {
  deleteInstanceImpl?: typeof deleteInstance;
  infraStartImpl?: typeof infraStart;
  log?: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
  persistDisposableRetention?: (home: string, id: string, retention: "disposable") => void;
}

export async function resetTestCruft(
  opts: { yes?: boolean },
  deps: ResetTestCruftDeps = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  const env = deps.env ?? process.env;
  const deleteImpl = deps.deleteInstanceImpl ?? deleteInstance;
  const infraImpl = deps.infraStartImpl ?? infraStart;

  if (opts.yes !== true) {
    console.error(
      "[reset-test-cruft] refusing without --yes (this deletes and recreates the test-cruft instance).",
    );
    return 1;
  }

  log(`[reset-test-cruft] deleting ${TEST_CRUFT_INSTANCE_ID}...`);
  const deleteCode = await deleteImpl({ id: TEST_CRUFT_INSTANCE_ID, yes: true });
  if (deleteCode !== 0) {
    console.error(`[reset-test-cruft] delete-instance exited ${deleteCode}; aborting recreate.`);
    return deleteCode;
  }

  const prev = env["NAUTILO_INSTANCE_ID"];
  env["NAUTILO_INSTANCE_ID"] = TEST_CRUFT_INSTANCE_ID;
  try {
    log(`[reset-test-cruft] recreating ${TEST_CRUFT_INSTANCE_ID} via infra-start...`);
    const infraCode = await infraImpl({});
    if (infraCode !== 0) {
      console.error(`[reset-test-cruft] infra-start exited ${infraCode}.`);
      return infraCode;
    }
    const home = env["HOME"];
    if (!home || home.trim() === "") {
      console.error("[reset-test-cruft] HOME is required to persist disposable retention.");
      return 1;
    }
    try {
      (deps.persistDisposableRetention ?? persistLocalProfileRetention)(home, TEST_CRUFT_INSTANCE_ID, "disposable");
    } catch (error) {
      console.error(`[reset-test-cruft] recreated the instance but could not persist disposable retention: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  } finally {
    if (prev === undefined) delete env["NAUTILO_INSTANCE_ID"];
    else env["NAUTILO_INSTANCE_ID"] = prev;
  }

  log("[reset-test-cruft] done.");
  return 0;
}
