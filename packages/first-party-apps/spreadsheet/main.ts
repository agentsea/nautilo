import { getSheetsBridge } from "./src/sheet-bridge";
import { mountSpreadsheet } from "./src/spreadsheet-app";
const root = document.getElementById("app");
if (root) {
  try {
    await mountSpreadsheet(root, getSheetsBridge());
  } catch (error) {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = error instanceof Error ? error.message : String(error);
    root.append(message);
  }
}
