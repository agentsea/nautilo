import type { MobilePlatformCapabilities } from "@/platform/capability-contract";

export function canBrowseComputerFiles(platform: MobilePlatformCapabilities): boolean {
  return platform.decisions.controllerAuthority.status === "supported";
}
