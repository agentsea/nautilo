import { isDesktop } from "../../../lib/desktop";
import { CurrentFolderSection } from "./current-folder-section";
import { DesktopPermissionsSection } from "./desktop-permissions-section";
import { StartupSection } from "./startup-section";
import { DesktopFilesystemAccessSection } from "./workstation-access-section";

/** Desktop-local settings grouped by the physical Mac that owns them. */
export function ThisMacSection({
  isDesktopShell = isDesktop,
}: {
  isDesktopShell?: boolean;
} = {}) {
  if (!isDesktopShell) return null;

  return (
    <section
      id="this-mac"
      aria-labelledby="this-mac-title"
      data-testid="this-mac-section"
      className="rounded-lg border border-border bg-background-panel"
    >
      <header className="border-b border-border px-5 py-3">
        <h2 id="this-mac-title" className="text-sm font-semibold text-foreground">
          This Mac
        </h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Startup, folder, macOS permission, and workstation controls owned by this Desktop.
        </p>
      </header>
      <div className="px-5 py-4">
        <div
          data-testid="this-mac-details"
          className="flex flex-col gap-4 rounded-md border border-border/60 bg-background-element/40 p-4"
        >
          <StartupSection isDesktopShell={isDesktopShell} />
          <CurrentFolderSection isDesktopShell={isDesktopShell} />
          <DesktopPermissionsSection isDesktopShell={isDesktopShell} />
          <DesktopFilesystemAccessSection isDesktopShell={isDesktopShell} />
        </div>
      </div>
    </section>
  );
}
