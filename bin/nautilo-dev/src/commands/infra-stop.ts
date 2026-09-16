/**
 * M051: tear down every infrastructure container brought up by
 * `infra:start`. Volumes are PRESERVED by default (Logto admin user,
 * default-tenant apps, and Nautilo schema all live in volumes; wiping
 * them invalidates the bootstrap-logto idempotency probe and forces
 * a fresh first-run bootstrap).
 *
 * If you want a torch-it-all wipe, pass `--with-volumes`:
 *   bun run infra:stop -- --with-volumes
 */
import { spawn } from "node:child_process";
import { resolveInstance } from "@nautilo/config";
import {
  applyInfraComposeRoutingEnv,
  dockerComposeDbDevPrefixRaw,
  dockerComposeNautiloPrefixArgs,
  NAUTILO_REPO_ROOT,
} from "../lib/compose-infra";

function run(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; code: number }> {
  return new Promise((res) => {
    const proc = spawn(cmd, args, { cwd: NAUTILO_REPO_ROOT, stdio: "inherit" });
    proc.on("close", (code) => {
      res({ ok: code === 0, code: code ?? 1 });
    });
  });
}

export async function infraStop(opts: { withVolumes?: boolean } = {}): Promise<number> {
  const inst = resolveInstance();
  applyInfraComposeRoutingEnv(inst);

  console.log("[infra:stop] tearing down Logto compose stack...");
  const composeArgs = [
    ...dockerComposeNautiloPrefixArgs(inst),
    "--profile",
    "auth",
    "--profile",
    "connections",
    "down",
  ];
  if (opts.withVolumes) composeArgs.push("-v");
  const composeDown = await run("docker", composeArgs);
  if (!composeDown.ok) {
     
    console.error(
      `[infra:stop] docker compose down failed (exit ${composeDown.code})`,
    );
    // Continue to legacy db:dev:down regardless — partial cleanup is
    // better than none.
  }

   
  console.log("[infra:stop] tearing down legacy postgres...");
  const dbArgs = [...dockerComposeDbDevPrefixRaw(inst.compose.projectName), "down"];
  if (opts.withVolumes) dbArgs.push("-v");
  const dbDown = await run("docker", dbArgs);
  if (!dbDown.ok) {
     
    console.error(`[infra:stop] docker compose db down failed (exit ${dbDown.code})`);
    return dbDown.code;
  }

   
  console.log(
    opts.withVolumes
      ? "[infra:stop] done. Volumes wiped — next infra:start will re-bootstrap."
      : "[infra:stop] done. Volumes preserved (use --with-volumes to wipe).",
  );
  return composeDown.ok ? 0 : composeDown.code;
}
