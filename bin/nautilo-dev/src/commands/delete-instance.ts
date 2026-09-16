import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { validateNautiloInstanceIdValue, resolveNautiloStorageRoot } from "@nautilo/config";
import {
  classifyProfileAuthority,
  listLocalInstances,
  readProfileInstanceAuthority,
} from "@nautilo/instance-discovery/node";
import {
  NAUTILO_REPO_ROOT,
  dockerComposeDbDevPrefixRaw,
  dockerComposeNautiloPrefixRaw,
} from "../lib/compose-infra";
import { isProtectedDurableInstance } from "../lib/protected-durable-instance";

export type DeleteInstanceDeps = {
  /** Override for tests — must not invoke real Docker. */
  runDockerCompose?: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  /** Override for tests — skip real `rmSync`. */
  removeInstanceRoot?: (root: string) => void;
  /** Override for tests — list+kill processes listening on a TCP port (no-op when omitted in prod-no-lsof). */
  killPortListeners?: (port: number) => { killed: number[] };
  /** Override profile metadata and local discovery for focused tests. */
  readProfileAuthority?: typeof readProfileInstanceAuthority;
  listLocal?: typeof listLocalInstances;
};

function readInstanceJsonPorts(instanceRoot: string): number[] {
  const path = join(instanceRoot, "instance.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      server?: { port?: number };
      workbench?: { port?: number };
    };
    const ports: number[] = [];
    if (typeof raw.server?.port === "number") ports.push(raw.server.port);
    if (typeof raw.workbench?.port === "number") ports.push(raw.workbench.port);
    return ports;
  } catch {
    return [];
  }
}

function defaultKillPortListeners(port: number): { killed: number[] } {
  // macOS/Linux: lsof to find PIDs LISTENing on the port. Skip silently if
  // lsof is missing (Windows / minimal containers).
  const out = spawnSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  if (out.error || out.status !== 0) return { killed: [] };
  const pids = (out.stdout ?? "")
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  return { killed: pids };
}

function readComposeProjectName(instanceRoot: string, instanceId: string): string {
  const path = join(instanceRoot, "instance.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      compose?: { projectName?: string };
    };
    const pn = raw.compose?.projectName?.trim();
    if (pn) return pn;
  } catch {
    /* fall through */
  }
  return instanceId === "" ? "nautilo" : `nautilo-${instanceId}`;
}

function defaultRunDockerCompose(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((res) => {
    const proc = spawn("docker", args, {
      cwd: NAUTILO_REPO_ROOT,
      stdio: "inherit",
      env,
    });
    proc.on("close", (code) => {
      res(code ?? 1);
    });
  });
}

/**
 * Tear down compose stacks for `projectName` and delete the instance storage root.
 * Refuses default instance, invalid ids, and calls without `--yes`.
 */
export async function deleteInstance(
  options: {
    id: string;
    yes: boolean;
    /** Tests / isolated homes (defaults to `os.homedir()`). */
    userHomeDir?: string;
  },
  deps: DeleteInstanceDeps = {},
): Promise<number> {
  const id = options.id.trim();
  if (id === "") {
    console.error(
      "[delete-instance] refusing to delete the default instance (use a named id).",
    );
    return 1;
  }
  const verr = validateNautiloInstanceIdValue(id);
  if (verr !== null) {
    console.error(`[delete-instance] invalid id: ${verr}`);
    return 1;
  }
  if (!options.yes) {
    console.error(
      "[delete-instance] refusing without --yes (this runs `docker compose … down -v` and deletes ~/.nautilo-<id>).",
    );
    return 1;
  }

  const home = options.userHomeDir?.trim() || homedir();
  const root = resolveNautiloStorageRoot(home, id);
  const expected = normalize(join(home, `.nautilo-${id}`));
  if (normalize(root) !== expected) {
    console.error("[delete-instance] path guard failed — aborting.");
    return 1;
  }
  const authority = (deps.readProfileAuthority ?? readProfileInstanceAuthority)(home);
  const profileDecision = classifyProfileAuthority(id, authority);
  if (isProtectedDurableInstance(root, profileDecision)) {
    console.error(
      `[delete-instance] refusing to delete protected durable fixture '${id}'. Retiring it requires a separate, deliberate protection-policy change.`,
    );
    return 1;
  }
  if (profileDecision?.classification === "remote") {
    console.error(`[delete-instance] refusing remote projection '${id}': ${profileDecision.reason}`);
    return 1;
  }
  if (profileDecision?.classification === "unknown") {
    console.error(`[delete-instance] refusing unknown instance '${id}': ${profileDecision.reason}`);
    return 1;
  }
  const rows = await (deps.listLocal ?? listLocalInstances)(home, {
    probeHealth: () => Promise.resolve(false),
  });
  const row = rows.find((candidate) => candidate.instanceId === id);
  if (row?.state === "invalid-json") {
    console.error(
      `[delete-instance] refusing unknown instance '${id}': invalid or contradictory instance.json (${row.detail ?? "validation failed"})`,
    );
    return 1;
  }
  const provenLocal =
    profileDecision?.classification === "local" || row?.state === "idle" || row?.state === "running";
  if (!provenLocal) {
    console.error(
      `[delete-instance] refusing unknown instance '${id}': no local profile or valid instance.json proves ownership`,
    );
    return 1;
  }
  const dirExists = existsSync(root);
  if (!dirExists) {
    console.warn(
      `[delete-instance] instance directory not found: ${root} — sweeping Docker by compose project anyway`,
    );
  }

  // Kill any zombie host-process bound to this instance's server/workbench
  // ports BEFORE compose teardown. M071 port-bump-on-collision otherwise
  // detects a held port on next `infra:start` and shifts the instance to a
  // new port band, leaving the user with a confusing instance.json mismatch.
  // We only learn ports from instance.json — when the dir is missing we
  // conservatively skip (compose teardown alone is the right behavior; the
  // host server is presumably also gone if its data dir is gone).
  if (dirExists) {
    const killer = deps.killPortListeners ?? defaultKillPortListeners;
    for (const port of readInstanceJsonPorts(root)) {
      const { killed } = killer(port);
      if (killed.length > 0) {
        console.log(
          `[delete-instance] killed zombie host process(es) on :${port} (pid: ${killed.join(", ")})`,
        );
      }
    }
  }

  // Compose project name is deterministic from the instance id
  // (`nautilo-<id>`). The instance dir's `instance.json` is just a
  // hint — fall back to the deterministic name when the dir is
  // missing so we can still tear down orphan stacks.
  const projectName = dirExists
    ? readComposeProjectName(root, id)
    : `nautilo-${id}`;
  const run = deps.runDockerCompose ?? defaultRunDockerCompose;
  const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_PROJECT_NAME: projectName };

  console.log(
    `[delete-instance] docker compose down -v (project=${projectName}) — Logto stack…`,
  );
  const logtoCode = await run(
    [...dockerComposeNautiloPrefixRaw(projectName), "--profile", "auth", "down", "-v"],
    env,
  );
  if (logtoCode !== 0) {
    console.error(
      `[delete-instance] Logto compose down exited ${logtoCode} — continuing to legacy DB compose`,
    );
  }

  console.log(`[delete-instance] docker compose down -v — legacy db stack…`);
  const dbCode = await run(
    [...dockerComposeDbDevPrefixRaw(projectName), "down", "-v"],
    env,
  );
  if (dbCode !== 0) {
    console.error(
      `[delete-instance] legacy db compose down exited ${dbCode} — still removing instance dir`,
    );
  }

  if (dirExists) {
    console.log(`[delete-instance] removing ${root}`);
    if (deps.removeInstanceRoot) {
      deps.removeInstanceRoot(root);
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  } else {
    console.log(`[delete-instance] (no instance dir to remove)`);
  }

  console.log("[delete-instance] done.");
  return logtoCode === 0 && dbCode === 0 ? 0 : 1;
}
