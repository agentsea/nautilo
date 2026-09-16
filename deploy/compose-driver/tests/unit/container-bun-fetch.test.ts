import { afterAll, describe, expect, test } from "bun:test";
import {
  buildContainerBunFetchArgs,
  CONTAINER_BUN_FETCH_SCRIPT,
} from "../../src/container-bun-fetch.ts";

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/redirect") {
      return Response.redirect(new URL("/unexpected-target", request.url).href, 307);
    }
    return Response.json({
      method: request.method,
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    }, { status: request.method === "POST" ? 201 : 200 });
  },
});

afterAll(() => server.stop(true));

async function runProbe(args: string[], body?: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn(args, {
    stdin: body === undefined ? "ignore" : new Blob([body]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("container Bun fetch probe", () => {
  test("fails closed when an operator endpoint redirects", async () => {
    const result = await runProbe(buildContainerBunFetchArgs({
      url: new URL("redirect", server.url).href,
    }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });
  test("uses only the guaranteed Bun runtime and emits body plus status trailer", async () => {
    const args = buildContainerBunFetchArgs({
      url: new URL("health", server.url).href,
    });
    expect(args[0]).toBe("bun");
    expect(args).not.toContain("curl");
    expect(CONTAINER_BUN_FETCH_SCRIPT).not.toContain("curl");

    const result = await runProbe(args);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const separator = result.stdout.lastIndexOf("\n");
    expect(result.stdout.slice(separator + 1)).toBe("200");
    expect(JSON.parse(result.stdout.slice(0, separator))).toEqual({
      method: "GET",
      contentType: null,
      body: "",
    });
  });

  test("forwards method, headers, and stdin body", async () => {
    const args = buildContainerBunFetchArgs({
      url: new URL("maintenance", server.url).href,
      method: "POST",
      headers: { "content-type": "application/json" },
      hasBody: true,
    });
    const result = await runProbe(args, '{"hardMs":1800000}');
    expect(result.exitCode).toBe(0);
    const separator = result.stdout.lastIndexOf("\n");
    expect(result.stdout.slice(separator + 1)).toBe("201");
    expect(JSON.parse(result.stdout.slice(0, separator))).toEqual({
      method: "POST",
      contentType: "application/json",
      body: '{"hardMs":1800000}',
    });
  });
});
