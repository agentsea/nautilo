import { spawnSync } from "node:child_process";
import {
  composeProjectName,
  buildSshArgs,
  type ComposeDriverProfile,
} from "@nautilo/compose-driver";
import {
  assessUbuntuHostKernel,
  type UbuntuHostKernelAssessment,
} from "@nautilo/hosting";

interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

type DockerRunner = (args: string[], env: NodeJS.ProcessEnv, command: "docker" | "ssh") => DockerResult;

// Execute only a filesystem read in the selected Docker daemon's kernel.
// The operator's kernel and the container's /etc/os-release are not evidence
// about that daemon, especially with Docker Desktop or a remote context.
const READ_KERNEL_SIGNATURE = `
const fs = require("node:fs");
let signature = null;
try { signature = fs.readFileSync("/proc/version_signature", "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
process.stdout.write(JSON.stringify({ signature }));
`;

function defaultRunDocker(args: string[], env: NodeJS.ProcessEnv, command: "docker" | "ssh"): DockerResult {
  const result = spawnSync(command, args, { env, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

let runDocker: DockerRunner = defaultRunDocker;

/** Test seam for the process boundary; production always uses Docker. */
export function setComposeHostKernelRunnerForTests(runner: DockerRunner | undefined): void {
  runDocker = runner ?? defaultRunDocker;
}

export function inspectComposeHostKernel(
  profile: ComposeDriverProfile,
  imageRef?: string,
): UbuntuHostKernelAssessment {
  if (profile.transport === "remote" && process.env["DOCKER_CONTEXT"]?.trim()) {
    throw new Error(
      "Host kernel check refused: DOCKER_CONTEXT overrides the remote Docker host. " +
      "Unset DOCKER_CONTEXT and retry the explicitly selected profile.",
    );
  }
  const run = (args: string[]): DockerResult => {
    if (profile.transport !== "remote") return runDocker(args, process.env, "docker");
    if (profile.ssh === undefined) throw new Error("Host kernel check requires the selected remote profile's SSH settings.");
    // Use the registry lifecycle's native SSH route, retaining its dedicated
    // identity, port and pinned known_hosts before any container is executed.
    return runDocker(buildSshArgs(profile.ssh, "docker", args), process.env, "ssh");
  };
  let image = imageRef;
  if (image === undefined) {
    const discovery = run([
      "ps", "-aq", "--no-trunc", "--filter", `label=com.docker.compose.project=${composeProjectName(profile)}`,
      "--filter", "label=com.docker.compose.service=nautilo-server",
    ]);
    const ids = discovery.stdout.trim().split(/\s+/);
    if (discovery.code !== 0 || ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0] ?? "")) {
      throw new Error("Cannot check the deployment host kernel: expected exactly one existing Nautilo server container. No deployment was started.");
    }
    const result = run(
      ["inspect", "--format", "{{.Image}}", ids[0]!],
    );
    if (result.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim())) {
      throw new Error(
        "Cannot check the deployment host kernel: the existing Nautilo image is unavailable. " +
        "Check Docker access and the selected profile before retrying. No deployment was started.",
      );
    }
    image = result.stdout.trim();
  }
  const result = run([
    "run", "--rm", "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--label", "io.nautilo.purpose=host-kernel-check",
    "--entrypoint", "/usr/local/bin/bun", image, "-e", READ_KERNEL_SIGNATURE,
  ]);
  if (result.code !== 0) {
    throw new Error(
      "Cannot check the deployment host kernel: the isolated Docker probe failed. " +
      "Check daemon access and image availability; no deployment or maintenance drain was started.",
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error("Host kernel probe returned invalid evidence; deployment refused."); }
  if (typeof parsed !== "object" || parsed === null || !("signature" in parsed)
    || (parsed.signature !== null && typeof parsed.signature !== "string")) {
    throw new Error("Host kernel probe returned invalid evidence; deployment refused.");
  }
  return assessUbuntuHostKernel(parsed.signature);
}

/** Must run before owner custody, maintenance, backup, or service mutation. */
export function assertComposeHostKernelReady(profile: ComposeDriverProfile, imageRef?: string): void {
  const assessment = inspectComposeHostKernel(profile, imageRef);
  if (assessment.status === "affected") {
    throw new Error(`${assessment.message} No deployment or maintenance drain was started.`);
  }
  if (assessment.status === "unknown") {
    process.stderr.write(`[deploy] host kernel protection unverified: ${assessment.message}\n`);
  }
}
