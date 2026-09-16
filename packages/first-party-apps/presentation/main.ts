import { getSlidesBridge } from "./src/slide-bridge";
import { mountPresentation } from "./src/presentation-app";

const root = document.getElementById("app");
if (root) {
  try { await mountPresentation(root, getSlidesBridge()); }
  catch (error) {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = error instanceof Error ? error.message : String(error);
    root.replaceChildren(message);
  }
}
