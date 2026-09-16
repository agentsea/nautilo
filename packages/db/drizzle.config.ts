import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";
import { resolveMigrationConnectionUrl } from "./src/config/migration-connection";

config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveMigrationConnectionUrl(),
  },
  verbose: true,
  strict: true,
});
