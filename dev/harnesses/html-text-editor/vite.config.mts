import { defineConfig, mergeConfig } from "vite";
import workbenchConfig from "../../../apps/workbench/vite.config";

export default defineConfig((environment) => mergeConfig(workbenchConfig(environment), {
  root: import.meta.dirname,
  server: { host: "127.0.0.1", port: 5241, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
}));
