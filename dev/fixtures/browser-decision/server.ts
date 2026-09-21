const usage = "Usage: bun dev/fixtures/browser-decision/server.ts --port <1-65535>";

function parsePort(argv: string[]): number {
  if (argv.length !== 2 || argv[0] !== "--port") {
    throw new Error(usage);
  }

  const port = Number(argv[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(usage);
  }

  return port;
}

let port: number;
try {
  port = parsePort(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : usage);
  process.exit(1);
}

const catalogue = Bun.file(new URL("./catalogue.html", import.meta.url));

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/" || url.pathname === "/catalogue.html") {
      return new Response(catalogue, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Browser decision fixture listening on http://127.0.0.1:${port}`);
