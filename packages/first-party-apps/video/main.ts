import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { VideoApp } from "./src/app";
import "./styles.css";

const rootEl = document.getElementById("app");
if (rootEl) {
  createRoot(rootEl).render(createElement(VideoApp));
}
