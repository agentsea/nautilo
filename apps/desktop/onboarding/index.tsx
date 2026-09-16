/**
 * D091 Phase 1 — onboarding renderer mount.
 *
 * Matches the shape of `first-run/index.tsx`: vanilla React 19,
 * `createRoot`, IIFE bundle loaded from `onboarding/index.html`
 * via `file://`. No router, no state library, no animation
 * dependencies beyond Three.js (which the OrbCanvas component
 * imports internally).
 *
 * Runs inside a dedicated BrowserWindow with the `nautiloOnboarding`
 * contextBridge API exposed via `preload-onboarding.js`.
 */

// React must be in scope for esbuild's classic JSX transform
// (`<App />` compiles to `React.createElement(App, null)`). Without
// this import the bundle hits `ReferenceError: React is not defined`
// at mount time and the window paints empty. esbuild defaults to
// classic for `.tsx` files unless `jsx: "automatic"` is configured
// in the build script — we use classic to match `first-run/`'s
// existing pattern (every renderer .tsx imports React explicitly).
import React from "react";
import { createRoot } from "react-dom/client";
import {
  GenieCustomizationApp,
  type OnboardingAPI,
} from "@nautilo/genie-customization-ui";

declare global {
  interface Window {
    /** Desktop-only bridge supplied by preload-onboarding.ts. */
    nautiloOnboarding?: OnboardingAPI;
  }
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <GenieCustomizationApp api={window.nautiloOnboarding} />,
  );
}
