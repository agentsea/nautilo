import { describe, expect, test } from "bun:test";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

/**
 * D120 A5.2 — We do not boot full `nautilo-server` here (DB, certs, seed).
 * Production boot uses the same HTTP→127.0.0.1 forwarder pattern on
 * `~/.nautilo/server.sock` because Node forbids two listen() calls on one
 * `http.Server`. This test proves the forwarder shape works; boot wiring is
 * asserted against `src/index.ts` source.
 */
describe("unix socket forwarder (A5.2)", () => {
  test("boot source references server.sock and unix forwarder", () => {
    const bootPath = join(import.meta.dirname, "..", "..", "src", "index.ts");
    const src = readFileSync(bootPath, "utf8");
    expect(src).toContain("server.sock");
    expect(src).toContain("unix socket");
  });

  test("HTTP forwarder on unix socket reaches upstream", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response("ok-from-upstream"),
    });
    const tport = upstream.port;
    const sock = join(tmpdir(), `nautilo-unix-fwd-${Date.now()}.sock`);

    const forwarder = http.createServer((req, res) => {
      const headers = { ...req.headers, host: `127.0.0.1:${tport}` };
      const upstreamReq = http.request(
        {
          hostname: "127.0.0.1",
          port: tport,
          path: req.url ?? "/",
          method: req.method,
          headers,
        },
        (ur) => {
          res.writeHead(ur.statusCode ?? 500, ur.headers);
          ur.pipe(res);
        },
      );
      upstreamReq.on("error", (e: Error) => {
        res.statusCode = 502;
        res.end(e.message);
      });
      req.pipe(upstreamReq);
    });

    await new Promise<void>((resolve, reject) => {
      forwarder.listen({ path: sock }, () => resolve());
      forwarder.once("error", reject);
    });

    try {
      const res = await fetch("http://localhost/health", { unix: sock } as RequestInit);
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe("ok-from-upstream");
    } finally {
      forwarder.close();
      upstream.stop();
      try {
        unlinkSync(sock);
      } catch {
        /* ENOENT */
      }
    }
  });
});
