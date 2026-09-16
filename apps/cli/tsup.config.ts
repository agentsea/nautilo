import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  minify: false,
  platform: "node",
  target: "node20",
  // Bundle workspace packages (they ship TypeScript + extensionless imports).
  external: ["dotenv"],
  noExternal: [/^@nautilo\//],
  define: {
    // Prevent bundled workspace CLI entrypoints from treating the nautilo
    // bundle as their own main module.
    "import.meta.main": "false",
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
