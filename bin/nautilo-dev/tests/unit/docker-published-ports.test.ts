import { describe, expect, test } from "bun:test";
import {
  collectDockerPublishedTcpPorts,
  parseDockerPublishedTcpPortsField,
  parseDockerPublishedTcpPortsOutput,
} from "../../src/lib/docker-published-ports";

describe("Docker published host-port inventory", () => {
  test("parses wildcard, IPv4, IPv6, ranges, and duplicates as TCP authority", () => {
    const output = [
      JSON.stringify("0.0.0.0:5434->5432/tcp, [::]:5434->5432/tcp, 127.0.0.1:3301->3301/tcp"),
      JSON.stringify("192.168.1.8:4400-4401->4400-4401/tcp, [::1]:9980->9980/udp, 7777/tcp"),
      JSON.stringify("127.0.0.1:3301->3301/tcp"),
      "",
    ].join("\n");
    expect([...parseDockerPublishedTcpPortsOutput(output)].sort((a, b) => a - b)).toEqual([
      3301, 4400, 4401, 5434,
    ]);
    expect([...parseDockerPublishedTcpPortsField(":::3302->3302/tcp")]).toEqual([3302]);
  });

  test("fails closed on malformed successful output", () => {
    for (const output of [
      "not-json\n",
      "42\n",
      `${JSON.stringify("0.0.0.0:not-a-port->5432/tcp")}\n`,
      `${JSON.stringify("hostname:5432->5432/tcp")}\n`,
      `${JSON.stringify("0.0.0.0:5432->broken")}\n`,
    ]) {
      expect(() => parseDockerPublishedTcpPortsOutput(output)).toThrow();
    }
  });

  test("falls back only when Docker is unavailable and never logs command output", () => {
    const warnings: string[] = [];
    expect([...collectDockerPublishedTcpPorts({
      run: () => ({ status: 1, stdout: "password=secret" }),
      warn: (message) => warnings.push(message),
    })]).toEqual([]);
    expect(warnings).toEqual([
      "[clone] Docker published-port inventory unavailable; falling back to host bind probing",
    ]);
    expect(warnings.join(" ")).not.toContain("secret");

    expect(() => collectDockerPublishedTcpPorts({
      run: () => ({ status: 0, stdout: "password=secret" }),
    })).toThrow("Malformed successful Docker port inventory JSON");
  });
});
