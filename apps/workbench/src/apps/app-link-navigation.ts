import { desktopAPI } from "../lib/desktop";

/** Called only after the app bridge has validated the exact sending frame. */
export async function openAppLink(appId: string, value: string): Promise<void> {
  if (appId !== "nautilo-writer" || !window.navigator.userActivation?.isActive) {
    throw new Error("Click the link to open it.");
  }
  const url = new URL(value);
  if (!["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) {
    throw new Error("This link type cannot be opened.");
  }
  // Keep all navigation in the host; Writer retains its scripts-only sandbox.
  if (desktopAPI?.browserControl?.openExternal && (url.protocol === "http:" || url.protocol === "https:")) {
    await desktopAPI.browserControl.openExternal({ url: url.href });
  } else {
    window.open(url.href, "_blank", "noopener,noreferrer");
  }
}
