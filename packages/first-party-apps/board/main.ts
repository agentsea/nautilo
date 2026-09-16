import { getBoardBridge } from "./src/board-bridge";
import { mountBoard } from "./src/board-app";
const root = document.getElementById("app");
if (!root) throw new Error("Board root is missing.");
void Promise.resolve().then(() => mountBoard(root, getBoardBridge())).catch(error => {
  root.setAttribute("role", "alert");
  root.textContent = error instanceof Error ? error.message : String(error);
});
