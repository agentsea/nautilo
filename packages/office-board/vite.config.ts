// Modified by Nautilo: exercise emitted dependency exports without source aliases or DOM globals.
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
