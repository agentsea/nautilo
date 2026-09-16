import { SystemPermissionsSection } from "../../../components/system-permissions-section";
import { isDesktop } from "../../../lib/desktop";

/** Local macOS capability truth and recovery, separate from developer delegation. */
export function DesktopPermissionsSection({
  isDesktopShell = isDesktop,
}: {
  isDesktopShell?: boolean;
} = {}) {
  if (!isDesktopShell) return null;

  return <SystemPermissionsSection
    sectionId="desktop-permissions"
    eyebrow=""
    title="macOS permissions"
    description="Manage the macOS access used by Nautilo Desktop. Nautilo updates this list when macOS reports a change."
    collapseWhenReady
    showComputerUseProgress={false}
    showOnboardingControls
  />;
}
