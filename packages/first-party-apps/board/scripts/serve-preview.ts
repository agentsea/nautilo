import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const built = await Bun.build({
  entrypoints: [resolve(root, "preview.ts")],
  target: "browser",
  format: "esm",
});
if (!built.success)
  throw new Error(built.logs.map((l) => l.message).join("\n"));
const code = await built.outputs[0].text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/preview.js")
      return new Response(code, {
        headers: { "content-type": "text/javascript" },
      });
    if (path === "/" || path === "/styles.css")
      return new Response(
        Bun.file(resolve(root, path === "/" ? "preview.html" : "styles.css")),
      );
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Board interface preview: ${server.url}?example=1`);
