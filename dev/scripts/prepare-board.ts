import { join } from "node:path";
import { buildBoardArtifacts } from "../../packaging/wafflebase/board-artifacts";

const root = join(import.meta.dirname, "../..");
await buildBoardArtifacts(root, join(root, "packages/first-party-apps/board/engine"));
console.log("Board bundled artifacts are ready.");
