import { join } from "node:path";
import { buildArtifacts } from "../../packaging/wafflebase/artifacts.mjs";

const root = join(import.meta.dirname, "../..");
await buildArtifacts(root, join(root, "packages/first-party-apps/spreadsheet/engine"));
console.log("Sheets compiled artifacts are ready. Restart the development server to seed Sheets in Apps.");
