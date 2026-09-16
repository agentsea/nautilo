import { isIP } from "node:net";
import { spawnSync } from "node:child_process";

type DockerPortInventoryResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: unknown;
};

export type DockerPortInventoryRunner = () => DockerPortInventoryResult;

function parsePortRange(raw: string): number[] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw);
  if (!match) throw new Error("Malformed Docker published port range");
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (
    !Number.isInteger(start) || !Number.isInteger(end) ||
    start < 1 || end > 65535 || end < start || end - start > 1024
  ) throw new Error("Invalid Docker published port range");
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function parseDockerPublishedTcpPortsField(field: string): Set<number> {
  const ports = new Set<number>();
  if (field.trim() === "") return ports;
  for (const rawEntry of field.split(",")) {
    const entry = rawEntry.trim();
    if (/^\d+(?:-\d+)?\/(?:tcp|udp)$/.test(entry)) continue;
    const arrow = entry.indexOf("->");
    if (arrow <= 0 || entry.indexOf("->", arrow + 2) !== -1) {
      throw new Error("Malformed Docker published port mapping");
    }
    const hostSide = entry.slice(0, arrow);
    const containerSide = entry.slice(arrow + 2);
    const container = /^(\d+(?:-\d+)?)\/(tcp|udp)$/.exec(containerSide);
    if (!container) throw new Error("Malformed Docker container port mapping");
    const separator = hostSide.lastIndexOf(":");
    if (separator <= 0) throw new Error("Malformed Docker host port mapping");
    const rawHost = hostSide.slice(0, separator);
    const host = rawHost.startsWith("[") && rawHost.endsWith("]")
      ? rawHost.slice(1, -1)
      : rawHost;
    if (isIP(host) === 0) throw new Error("Malformed Docker published host address");
    const hostPorts = parsePortRange(hostSide.slice(separator + 1));
    if (container[2] === "tcp") {
      for (const port of hostPorts) ports.add(port);
    }
  }
  return ports;
}

export function parseDockerPublishedTcpPortsOutput(output: string): Set<number> {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/).filter((value) => value.trim() !== "")) {
    let field: unknown;
    try {
      field = JSON.parse(line);
    } catch {
      throw new Error("Malformed successful Docker port inventory JSON");
    }
    if (typeof field !== "string") {
      throw new Error("Malformed successful Docker port inventory field");
    }
    for (const port of parseDockerPublishedTcpPortsField(field)) ports.add(port);
  }
  return ports;
}

export function collectDockerPublishedTcpPorts(input: {
  readonly run?: DockerPortInventoryRunner;
  readonly warn?: (message: string) => void;
} = {}): Set<number> {
  const result = (input.run ?? (() => {
    const child = spawnSync(
      "docker",
      ["ps", "--format", "{{json .Ports}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return {
      status: child.status,
      stdout: typeof child.stdout === "string" ? child.stdout : "",
      ...(child.error === undefined ? {} : { error: child.error }),
    };
  }))();
  if (result.error !== undefined || result.status !== 0) {
    input.warn?.("[clone] Docker published-port inventory unavailable; falling back to host bind probing");
    return new Set();
  }
  // A successful command is authority. Never turn malformed success into an
  // empty inventory, which could publish a colliding instance reservation.
  return parseDockerPublishedTcpPortsOutput(result.stdout);
}
