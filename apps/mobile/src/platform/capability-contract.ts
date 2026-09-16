import type { InitiatingClientSurfaceV1 } from "@nautilo/types";

export const MOBILE_CAPABILITY_KEYS = [
  "authCustody",
  "lifecycle",
  "linksAndIntents",
  "notifications",
  "badges",
  "cameraQr",
  "chatAttachments",
  "photoSelection",
  "voice",
  "nativeShareImport",
  "protectedFilesystem",
  "installationIdentity",
  "controllerAuthority",
  "hostAuthority",
  "externalAppHandoff",
] as const;

export type MobileCapabilityKey = (typeof MOBILE_CAPABILITY_KEYS)[number];

export type CapabilityDecision =
  | Readonly<{
      status: "supported";
      detail: string;
    }>
  | Readonly<{
      status: "progressive";
      reason: string;
      recovery: string;
    }>
  | Readonly<{
      status: "unavailable";
      reason: string;
      recovery: string;
    }>;

export type MobileCapabilityDecisions = Readonly<Record<MobileCapabilityKey, CapabilityDecision>>;

export interface MobilePlatformCapabilities {
  readonly platform: "native" | "web" | "unknown";
  readonly decisions: MobileCapabilityDecisions;
}

/** The Metro-selected capability owner is Mobile's sole surface declaration source. */
export function initiatingClientSurfaceForMobile(
  capabilities: MobilePlatformCapabilities,
): InitiatingClientSurfaceV1 {
  if (capabilities.platform === "native") return "mobile.native";
  if (capabilities.platform === "web") return "mobile.web";
  return "unknown";
}

export function supported(detail: string): CapabilityDecision {
  return Object.freeze({ status: "supported", detail });
}

export function progressive(reason: string, recovery: string): CapabilityDecision {
  return Object.freeze({ status: "progressive", reason, recovery });
}

export function unavailable(reason: string, recovery: string): CapabilityDecision {
  return Object.freeze({ status: "unavailable", reason, recovery });
}

export function definePlatformCapabilities(
  platform: MobilePlatformCapabilities["platform"],
  decisions: Record<MobileCapabilityKey, CapabilityDecision>,
): MobilePlatformCapabilities {
  const frozenDecisions = Object.fromEntries(
    MOBILE_CAPABILITY_KEYS.map((key) => [key, Object.freeze({ ...decisions[key] })]),
  ) as Record<MobileCapabilityKey, CapabilityDecision>;
  return Object.freeze({ platform, decisions: Object.freeze(frozenDecisions) });
}

export const FAIL_CLOSED_CAPABILITY_DECISIONS: MobileCapabilityDecisions = Object.freeze(
  Object.fromEntries(
    MOBILE_CAPABILITY_KEYS.map((key) => [
      key,
      unavailable(
        "This runtime has no reviewed implementation for this capability.",
        "Use a supported Nautilo client or return to a safe product route.",
      ),
    ]),
  ) as Record<MobileCapabilityKey, CapabilityDecision>,
);

const ROUTE_CAPABILITY_REQUIREMENTS = Object.freeze([
  { prefix: "/share", capability: "nativeShareImport" },
  { prefix: "/scan-qr", capability: "cameraQr" },
  { prefix: "/scan-computer-qr", capability: "controllerAuthority" },
  { prefix: "/computers", capability: "controllerAuthority" },
  { prefix: "/files/computer", capability: "controllerAuthority" },
  { prefix: "/settings/notifications", capability: "notifications" },
  { prefix: "/settings/voice", capability: "voice" },
  { prefix: "/settings/agent-photos", capability: "photoSelection" },
] as const satisfies readonly { readonly prefix: string; readonly capability: MobileCapabilityKey }[]);

export type PlatformRouteAdmission =
  | Readonly<{ allowed: true; requiredCapability: MobileCapabilityKey | null }>
  | Readonly<{
      allowed: false;
      requiredCapability: MobileCapabilityKey;
      reason: string;
      recovery: string;
    }>;

function routeMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function capabilityRequiredForRoute(pathname: string): MobileCapabilityKey | null {
  return ROUTE_CAPABILITY_REQUIREMENTS.find(({ prefix }) => routeMatchesPrefix(pathname, prefix))
    ?.capability ?? null;
}

export function admitPlatformRoute(
  capabilities: MobilePlatformCapabilities,
  pathname: string,
): PlatformRouteAdmission {
  const requiredCapability = capabilityRequiredForRoute(pathname);
  if (!requiredCapability) return Object.freeze({ allowed: true, requiredCapability: null });
  const decision = capabilities.decisions[requiredCapability];
  if (decision.status !== "unavailable") {
    return Object.freeze({ allowed: true, requiredCapability });
  }
  return Object.freeze({
    allowed: false,
    requiredCapability,
    reason: decision.reason,
    recovery: decision.recovery,
  });
}
