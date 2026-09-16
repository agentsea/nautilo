import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseModule } from "../../src/commands/release.ts";
import { buildReleaseActiveWorkReadiness } from "../../src/lib/compose-driver-factory.ts";
import type { ComposeDriverProfile } from "@nautilo/compose-driver";

const remoteProfile: ComposeDriverProfile = {
  name: "remote-release",
  transport: "remote",
  lifecycle: "compose",
  from_source: false,
  tag: "main",
  ssh: { host: "203.0.113.10", user: "root" },
};

describe("release CLI", () => {
  test("registers only the read-only plan subcommand (D420 1.2.1 removed apply)", () => {
    const commands: unknown[] = [];
    const chain = {
      command: (command: unknown) => {
        commands.push(command);
        return chain;
      },
      demandCommand: () => chain,
    };

    expect(releaseModule.command).toBe("release");
    if (typeof releaseModule.builder === "function") {
      releaseModule.builder(chain as never);
    }

    expect(
      commands.map((command) =>
        typeof command === "object" && command !== null && "command" in command
          ? (command as { command?: string }).command
          : undefined,
      ),
    ).toEqual(["plan"]);
  });

  test("D427 3.1.1: remote readiness uses SSH-local authority (no bootstrap bearer) and fails closed on active work", async () => {
    let request: RequestInit | undefined;
    const gate = buildReleaseActiveWorkReadiness({
      resolveServerUrl: () => "http://127.0.0.1:4001",
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        request = init;
        return Response.json({ runningJobs: 1, queuedTurns: 0, bufferedLanes: 0 });
      }) as unknown as typeof fetch,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(gate(remoteProfile)).rejects.toThrow(/active work remains/);
    // No authorization header — the remote call is SSH-local against loopback;
    // the server trusts loopback without a bearer and SSH authority gates access.
    expect(request?.headers).toBeUndefined();
  });

  test("uses the selected local instance URL and bootstrap bearer", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-release-readiness-"));
    try {
    const localProfile: ComposeDriverProfile = {
      name: "local-release",
      transport: "local",
      lifecycle: "compose",
      from_source: true,
      instance_id: "local-release",
    };
    const instanceRoot = join(home, ".nautilo-local-release");
    mkdirSync(instanceRoot, { recursive: true });
    writeFileSync(
      join(instanceRoot, "instance.json"),
      JSON.stringify({ server: { url: "http://127.0.0.1:5501" } }),
    );
    let requestedUrl = "";
    let authorization = "";
    const gate = buildReleaseActiveWorkReadiness({
      home,
      readBootstrapTokenFn: () => "local-compose-token",
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        requestedUrl =
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response("unavailable", { status: 503 });
      }) as unknown as typeof fetch,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(gate(localProfile)).rejects.toThrow(/failed closed.*HTTP 503/);
    expect(requestedUrl).toBe("http://127.0.0.1:5501/api/operator/release/readiness");
    expect(authorization).toBe("Bearer local-compose-token");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
