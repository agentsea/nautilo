import { useBrowserColumn } from "../browser-column/browser-column.context";
import { FooterSegment } from "./footer-segment";

export function formatFooterPath(path: string, home?: string): string {
  if (home === undefined || home.length === 0) return path;
  const normalizedHome = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === normalizedHome) return "~";
  if (path.startsWith(`${normalizedHome}/`)) {
    return `~/${path.slice(normalizedHome.length + 1)}`;
  }
  return path;
}

export function footerPathLabel(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const last = clean.split("/").filter(Boolean).at(-1);
  return last ?? clean;
}

export function CurrentFolderSegment() {
  const browser = useBrowserColumn();
  const currentFolder = browser.currentFolderPath;
  if (!currentFolder) return null;

  const label = footerPathLabel(currentFolder);
  return (
    <FooterSegment
      title={currentFolder}
      label={label}
      className="max-w-[28vw]"
    />
  );
}
