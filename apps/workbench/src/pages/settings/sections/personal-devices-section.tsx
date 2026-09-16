import { isDesktop } from "../../../lib/desktop";
import { SectionCard } from "../ui";
import { WorkComputersSection } from "./devices-section";
import { MobileAccessSection } from "./mobile-access-section";

/** Purpose-specific device identities grouped by their owning Human. */
export function PersonalDevicesSection({
  isDesktopShell = isDesktop,
}: {
  isDesktopShell?: boolean;
} = {}) {
  return (
    <SectionCard
      id="devices"
      title="Devices"
      description="Manage the work computers and mobile controllers paired with your account."
    >
      <div className="flex flex-col gap-4" data-testid="personal-devices-details">
        <WorkComputersSection />
        {isDesktopShell ? <MobileAccessSection /> : null}
      </div>
    </SectionCard>
  );
}
