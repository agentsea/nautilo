import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { WriterApp } from "./src/writer-app";

const rootEl = document.getElementById("app");
if (rootEl) {
  createRoot(rootEl).render(createElement(WriterApp));
}
