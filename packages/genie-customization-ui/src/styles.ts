import { useEffect } from "react";

const STYLE_ID = "nautilo-genie-customization-ui";

/** Shared structural styling; hosts retain document shell, CSP, and palette. */
const WIZARD_CSS = `
  .genie-customization-host {
    box-sizing: border-box;
    width: 100%; height: 100%; display: flex; flex-direction: column;
    align-items: center; overflow-y: auto;
  }
  .genie-customization-host *, .genie-customization-host *::before, .genie-customization-host *::after {
    box-sizing: border-box;
  }
  .genie-customization-orb-wrap {
    width: 220px; height: 220px; display: flex; align-items: center; justify-content: center;
  }
  .genie-customization-orb-wrap.hidden { display: none; }
  @keyframes genie-customization-spin { to { transform: rotate(360deg); } }
`;

function ensureWizardStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = WIZARD_CSS;
  document.head.appendChild(style);
}

export function useGenieCustomizationStyles(): void {
  useEffect(() => { ensureWizardStyles(); }, []);
}
