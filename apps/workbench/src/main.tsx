import "./index.css";

if (window.nautiloCompanion) {
  void import("./companion/companion-window").then(({ startCompanionWindow }) => startCompanionWindow());
} else {
  void import("./bootstrap").then(({ applyInitialThemeClass, startWorkbenchBootstrap }) => {
    applyInitialThemeClass();
    void startWorkbenchBootstrap();
  });
}
