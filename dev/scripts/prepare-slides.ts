import { join } from "node:path";
import { buildSlidesArtifacts } from "../../packaging/wafflebase/slides-artifacts.mjs";

const root = join(import.meta.dirname, "../..");
await buildSlidesArtifacts(root, join(root, "packages/first-party-apps/presentation/engine"));
console.log("Slides compiled artifacts are ready. Restart the development server to discover the app in Apps; an existing disabled preference is preserved.");
