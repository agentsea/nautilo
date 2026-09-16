import { defineConfig } from "tsup";

export default defineConfig({
  entry: { runtime: "src/runtime-entry.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  clean: true,
  minify: true,
  treeshake: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  bundle: true,
  noExternal: ["lit", "lit-html", "lit-element", "@lit/reactive-element"],
  outExtension: () => ({ js: ".js" }),
});
