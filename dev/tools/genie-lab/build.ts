import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
const require = createRequire(import.meta.url);
await mkdir(dist, { recursive: true });

// Official AI Elements Opal asset, pinned by bytes. Development-only download;
// no remote requests occur inside the lab, and nothing enters production bundles.
const personaURL = "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/orb-1.2.riv";
const personaSHA256 = "ff2e885d4f065bbfd9b855b1a7aeaecb771c1047d9ef196ba910ba114aac06f8";
const personaPath = join(dist, "persona.riv");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let persona = await readFile(personaPath).catch(() => null);
if (!persona || digest(persona) !== personaSHA256) {
  const response = await fetch(personaURL);
  if (!response.ok) throw new Error(`Persona asset download failed: ${response.status}`);
  persona = Buffer.from(await response.arrayBuffer());
  if (digest(persona) !== personaSHA256) throw new Error("Persona asset integrity mismatch");
  await writeFile(personaPath, persona);
}
await copyFile(join(dirname(require.resolve("@rive-app/webgl2")), "rive.wasm"), join(dist, "rive.wasm"));
await Promise.all([
  build({ entryPoints: [join(root, "main.ts")], outfile: join(dist, "main.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node22" }),
  build({ entryPoints: [join(root, "preload.ts")], outfile: join(dist, "preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node22" }),
  build({ entryPoints: [join(root, "renderer.tsx")], outfile: join(dist, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", target: "chrome134", minify: true, define: { "process.env.NODE_ENV": '"production"' } }),
]);
await writeFile(join(dist, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; worker-src 'self' blob:; font-src 'self'">
<title>Genie Lab — shell preview</title><link rel="stylesheet" href="renderer.css"></head>
<body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
console.log("Built Genie Lab. Microphone and external network access are disabled.");
