import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface CloneTargetState {
  root: boolean;
  containers: string[];
  networks: string[];
  volumes: string[];
}

function dockerNames(args: string[]): string[] {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Docker preflight failed").trim());
  }
  return result.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
}

export function inspectCloneTargetState(input: {
  root: string;
  projectName: string;
  volumeNames: string[];
}): CloneTargetState {
  return {
    root: existsSync(input.root),
    containers: dockerNames([
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${input.projectName}`,
      "--format",
      "{{.Names}}",
    ]),
    networks: dockerNames([
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${input.projectName}`,
      "--format",
      "{{.Name}}",
    ]),
    volumes: input.volumeNames.filter((name) => {
      const result = spawnSync("docker", ["volume", "inspect", name], {
        encoding: "utf8",
      });
      if (result.status === 0) return true;
      if (/\bno such volume\b/i.test(result.stderr)) return false;
      if (result.error) throw result.error;
      throw new Error("Docker volume preflight failed");
    }),
  };
}

export function assertCloneTargetAbsent(state: CloneTargetState): void {
  const present = [
    state.root ? "instance root" : null,
    state.containers.length > 0 ? `containers (${state.containers.join(", ")})` : null,
    state.networks.length > 0 ? `networks (${state.networks.join(", ")})` : null,
    state.volumes.length > 0 ? `volumes (${state.volumes.join(", ")})` : null,
  ].filter((value): value is string => value !== null);
  if (present.length > 0) {
    throw new Error(`Clone target is not wholly absent: ${present.join("; ")}`);
  }
}
