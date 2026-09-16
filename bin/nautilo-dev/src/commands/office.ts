/**
 * D362 — bring the nwuno `office` engine up/down for the current instance.
 *
 * Profile-gated compose service (`office`) in infra/compose/nautilo.yml. Host
 * port is the per-instance derived NAUTILO_OFFICE_PORT (set by
 * applyInfraComposeRoutingEnv), so multiple stacks don't collide.
 *
 *   bun run office:up      # build + start nwuno for this instance
 *   bun run office:down    # stop + remove it
 *   bun run office:status  # ps
 */
import { spawn } from "node:child_process";
import { resolveInstance, validateNautiloInstanceIdValue } from "@nautilo/config";
import {
  applyInfraComposeRoutingEnv,
  dockerComposeNautiloPrefixArgs,
  NAUTILO_REPO_ROOT,
} from "../lib/compose-infra";
import { resolveInstanceIdForDevStack } from "./dev-stack";

export async function officeCmd(argv: string[]): Promise<number> {
  const sub = argv[0] ?? "up";
  // Match dev-stack's instance precedence (--instance → env → worktree basename)
  // so `office` lands on the same instance/ports as the running stack. If the
  // derived id is invalid (e.g. an over-long worktree basename), fall back to
  // the default instance rather than crash, and tell the user to pass --instance.
  const derived = resolveInstanceIdForDevStack(process.argv, process.env, process.cwd());
  if (derived !== "" && validateNautiloInstanceIdValue(derived) !== null) {
    console.error(
      `[office] derived instance id "${derived}" is invalid (${validateNautiloInstanceIdValue(derived)}); ` +
        `using the default instance. Pass --instance <id> to isolate.`,
    );
    process.env["NAUTILO_INSTANCE_ID"] = "";
  } else {
    process.env["NAUTILO_INSTANCE_ID"] = derived;
  }
  const inst = resolveInstance();
  applyInfraComposeRoutingEnv(inst);
  const prefix = dockerComposeNautiloPrefixArgs(inst);

  let tail: string[];
  switch (sub) {
    case "up":
      tail = ["--profile", "office", "up", "-d", "--build", "office", "collabora"];
      break;
    case "down":
      tail = ["--profile", "office", "rm", "-sf", "office", "collabora"];
      break;
    case "status":
      tail = ["--profile", "office", "ps", "office", "collabora"];
      break;
    default:
      console.error(`office: unknown subcommand '${sub}' (expected up|down|status)`);
      return 2;
  }

  const port = process.env["NAUTILO_OFFICE_PORT"];
  const collaboraPort = process.env["NAUTILO_COLLABORA_PORT"];
  console.error(
    `[office] instance=${inst.instanceId || "(default)"} project=${inst.compose.projectName} ` +
      `nwuno=http://localhost:${port}/  collabora=http://localhost:${collaboraPort}/office-engine/hosting/discovery`,
  );

  const code = await new Promise<number>((res) => {
    const proc = spawn("docker", [...prefix, ...tail], {
      cwd: NAUTILO_REPO_ROOT,
      stdio: "inherit",
    });
    proc.on("exit", (c) => res(c ?? 0));
  });

  if (sub === "up" && code === 0 && port) {
    process.stderr.write("[office] waiting for nwuno readiness…\n");
    const url = `http://localhost:${port}/`;
    const body =
      '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>';
    let nwunoReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/xml" },
          body,
          signal: AbortSignal.timeout(2000),
        });
        if (r.ok && (await r.text()).includes("find_replace")) {
          process.stderr.write(`[office] nwuno ready at ${url}\n`);
          nwunoReady = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!nwunoReady) {
      process.stderr.write(
        `[office] WARNING: nwuno not ready after 120s at ${url} (check 'office status')\n`,
      );
    }
  }

  if (sub === "up" && code === 0 && collaboraPort) {
    process.stderr.write("[office] waiting for collabora readiness…\n");
    // coolwsd is configured with net.service_root=/office-engine (§3.1b), so
    // discovery lives under that prefix — the bare /hosting/discovery now 400s.
    const url = `http://localhost:${collaboraPort}/office-engine/hosting/discovery`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(2000) });
        if (r.status === 200) {
          process.stderr.write(`[office] collabora ready at ${url}\n`);
          ready = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) {
      process.stderr.write(
        `[office] WARNING: collabora not ready after 120s at ${url} (check 'office status')\n`,
      );
    }
  }
  return code;
}
