import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  GENIE_APPLICATION_BRIDGE_VERSION_V1,
  UI_TARGET_DEFINITIONS_V1,
  uiPresentationSchema,
  uiTargetChannelAdapterV1Schema,
  uiTargetIdSchema,
  type UiPresentation,
  type UiTargetChannelAdapterV1,
  type UiTargetId,
} from "@nautilo/types";
import {
  genieCustomizationPath,
  launchGenieCustomizationFromSoftPrompt,
} from "./genie-soft-prompt";
import {
  ADMIN_DESTINATIONS,
  ADMIN_PAGE_CAPS,
  type AdminCatalogueTarget,
} from "../pages/admin/admin-sections";

export type WorkbenchTargetResolution =
  | { kind: "supported"; target: UiTargetId; value: WorkbenchApplicationTarget }
  | { kind: "unsupported"; fallbackText: string };

export interface WorkbenchApplicationTarget {
  /** Shared, route-free product metadata. */
  readonly definition: (typeof UI_TARGET_DEFINITIONS_V1)[number];
  /** Workbench's explicit implementation of the shared channel contract. */
  readonly disposition: UiTargetChannelAdapterV1["dispositions"][UiTargetId];
  readonly href: string;
  readonly presentation: WorkbenchPresentationStrategy;
}
export type WorkbenchTargetAvailability = { isVerified: boolean; capabilities: readonly string[]; isDesktopShell: boolean; isSelfManaged?: boolean };

/** Dependencies the Workbench alone supplies when presenting a semantic target. */
export interface WorkbenchTargetPresentationDependencies {
  readonly availability: WorkbenchTargetAvailability;
  readonly navigate: (to: string, options?: { state?: unknown }) => unknown;
  readonly customization: Omit<
    Parameters<typeof launchGenieCustomizationFromSoftPrompt>[0],
    "navigateToCustomization"
  >;
}

export type WorkbenchTargetPresentationResult =
  | { kind: "presented"; target: UiTargetId }
  | { kind: "unsupported"; fallbackText: string };

export type WorkbenchTargetPresentationResolution =
  | { kind: "supported"; target: UiTargetId; value: WorkbenchApplicationTarget; presentation: UiPresentation }
  | { kind: "unsupported"; fallbackText: string };

/**
 * Workbench-only presentation mechanics. These never cross the shared target
 * contract: customization opens its existing native-or-route journey, while
 * Connections targets navigate and focus one semantic anchor.
 */
export type WorkbenchPresentationStrategy =
  | {
    readonly kind: "customization-native-or-route";
    readonly focusAnchorId: null;
    readonly supportedPresentations: readonly ["link", "reveal"];
  }
  | {
    readonly kind: "anchor";
    readonly focusAnchorId: string;
    readonly supportedPresentations: readonly ["link", "reveal", "spotlight"];
  }
  | {
    readonly kind: "route";
    readonly focusAnchorId: null;
    readonly supportedPresentations: readonly ["link", "reveal"];
  };

const UNSUPPORTED_CHANNEL_FALLBACK =
  "This guidance destination is not available in this Nautilo client. Use the visible Genie or Connections menus to continue.";
const UNSUPPORTED_PRESENTATION_FALLBACK =
  "This guidance presentation is not available in this Nautilo client. Use the visible Genie or Connections menus to continue.";
const SPOTLIGHT_CLASS = "genie-ui-target-spotlight";
const activeSpotlightCleanups = new WeakMap<HTMLElement, () => void>();
export const WORKBENCH_TARGET_SPOTLIGHT_DURATION_MS = 6_000;

function supportsWorkbenchPresentation(
  target: WorkbenchApplicationTarget,
  presentation: UiPresentation,
): boolean {
  return target.presentation.supportedPresentations.some((supported) => supported === presentation);
}

export interface WorkbenchFocusDocument {
  getElementById(id: string): {
    scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
    focus?: (options?: FocusOptions) => void;
  } | null;
}

export type WorkbenchFocusResult =
  | { kind: "focused"; target: UiTargetId }
  | { kind: "unsupported"; fallbackText: string };

function spotlightIntentFromLocationState(value: unknown): {
  target: UiTargetId;
  presentation: "spotlight";
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (Object.keys(state).length !== 1 || !("d513GuidePresentation" in state)) return null;
  const intent = state["d513GuidePresentation"];
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return null;
  const record = intent as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || !("version" in record)
    || !("target" in record)
    || !("presentation" in record)
  ) return null;
  const target = uiTargetIdSchema.safeParse(record["target"]);
  return target.success && record["version"] === GENIE_APPLICATION_BRIDGE_VERSION_V1 && record["presentation"] === "spotlight"
    ? { target: target.data, presentation: "spotlight" }
    : null;
}

/** Bounded, client-local Router state for a one-view connection spotlight. */
export function workbenchSpotlightLocationState(target: UiTargetId): {
  d513GuidePresentation: { version: 1; target: UiTargetId; presentation: "spotlight" };
} {
  return { d513GuidePresentation: { version: 1, target, presentation: "spotlight" } };
}

export function startWorkbenchTargetSpotlight(node: HTMLElement): () => void {
  activeSpotlightCleanups.get(node)?.();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    document.removeEventListener("pointerdown", finish, true);
    document.removeEventListener("keydown", finish, true);
    node.classList.remove(SPOTLIGHT_CLASS);
    if (activeSpotlightCleanups.get(node) === cleanup) activeSpotlightCleanups.delete(node);
  };
  const cleanup = finish;
  node.classList.add(SPOTLIGHT_CLASS);
  const timer = window.setTimeout(finish, WORKBENCH_TARGET_SPOTLIGHT_DURATION_MS);
  // Capture is deliberately ephemeral: a person can dismiss the emphasis
  // anywhere without introducing an application-level event channel.
  document.addEventListener("pointerdown", finish, true);
  document.addEventListener("keydown", finish, true);
  activeSpotlightCleanups.set(node, cleanup);
  return cleanup;
}

const UNKNOWN_VERSION_FALLBACK =
  "This guidance action is not supported by this version of Nautilo. Use the visible Genie or Connections menus to continue.";
const UNKNOWN_TARGET_FALLBACK =
  "This guidance destination is not available in Nautilo. Use the visible Genie or Connections menus to continue.";
type LocalTargetAvailability = { readonly verified?: true; readonly desktop?: true; readonly selfManaged?: true; readonly anyCapabilities?: readonly string[] };
type LocalTargetDetail = Omit<WorkbenchApplicationTarget, "definition" | "disposition"> & { readonly availability?: LocalTargetAvailability };
const route = (href: string): LocalTargetDetail => ({ href, presentation: { kind: "route", focusAnchorId: null, supportedPresentations: ["link", "reveal"] } });
const anchor = (href: string, focusAnchorId: string): LocalTargetDetail => ({ href, presentation: { kind: "anchor", focusAnchorId, supportedPresentations: ["link", "reveal", "spotlight"] } });
const ADMIN_LOCAL_TARGET_DETAILS = Object.fromEntries(
  ADMIN_DESTINATIONS.map((destination) => [
    destination.catalogueTarget,
    {
      ...route(destination.kind === "route" ? destination.href : `/admin${destination.href}`),
      availability: {
        anyCapabilities: destination.requiresAnyCap,
        ...("selfManagedOnly" in destination ? { selfManaged: true as const } : {}),
      },
    },
  ]),
) as unknown as Record<AdminCatalogueTarget, LocalTargetDetail>;

/** Installed Workbench navigation/focus mechanics. This is intentionally not generated metadata. */
const WORKBENCH_LOCAL_TARGET_DETAILS: Record<UiTargetId, LocalTargetDetail> = {
  "genie.customization": { href: genieCustomizationPath(), presentation: { kind: "customization-native-or-route", focusAnchorId: null, supportedPresentations: ["link", "reveal"] } },
  "workbench.context": route("/info"), "help.server": route("/help/server"), "settings": route("/settings"), "admin": { ...route("/admin"), availability: { anyCapabilities: ADMIN_PAGE_CAPS } }, "costs": { ...route("/costs"), availability: { verified: true } }, "skills": { ...route("/skills"), availability: { verified: true } }, "connections": { ...route("/connections"), availability: { verified: true } }, "commands": { ...route("/commands"), availability: { verified: true } }, "approvals": { ...route("/approvals"), availability: { verified: true } }, "memory": { ...route("/memory"), availability: { verified: true } }, "scheduled_tasks": { ...route("/scheduled-tasks"), availability: { verified: true } },
  "settings.profile": route("/settings#profile"), "settings.startup": { ...route("/settings#startup"), availability: { desktop: true } }, "settings.my_agents": route("/settings#my-agents"), "settings.this_mac": { ...route("/settings#this-mac"), availability: { desktop: true } }, "settings.notifications": route("/settings#notifications"), "settings.model": route("/settings#model"), "settings.fallback": route("/settings#fallback"), "settings.current_folder": { ...route("/settings#current-folder"), availability: { desktop: true } }, "settings.your_access": route("/settings#your-access"), "settings.desktop_permissions": { ...route("/settings#desktop-permissions"), availability: { desktop: true } }, "settings.workstation_access": { ...route("/settings#workstation-access"), availability: { desktop: true } }, "settings.devices": route("/settings#devices"), "settings.encrypted_recovery": route("/settings#encrypted-recovery"), "settings.mobile_access": { ...route("/settings#mobile-access"), availability: { desktop: true } }, "settings.invite_people": { ...route("/settings#invite-people"), availability: { anyCapabilities: ["create_invites"] } }, "settings.security": route("/settings#security"), "settings.about": route("/settings#about"),
  "connections.codex": { ...anchor("/connections#codex", "codex"), availability: { verified: true } }, "connections.github_cli": { ...anchor("/connections#github-cli", "github-cli"), availability: { verified: true, desktop: true } }, "connections.ssh": { ...anchor("/connections#ssh", "ssh"), availability: { verified: true } }, "connections.local_mcp": { ...anchor("/connections#local-mcp", "local-mcp"), availability: { verified: true } }, "connections.google": { ...anchor("/connections#google", "google"), availability: { verified: true } },
  ...ADMIN_LOCAL_TARGET_DETAILS,
  "admin.access_control.users": { ...route("/admin/access-control"), availability: { anyCapabilities: ["manage_members"] } }, "admin.access_control.groups": { ...route("/admin/access-control/groups"), availability: { anyCapabilities: ["manage_groups"] } }, "admin.access_control.roles": { ...route("/admin/access-control/roles"), availability: { anyCapabilities: ["manage_roles"] } }, "admin.access_control.capabilities": { ...route("/admin/access-control/capabilities"), availability: { anyCapabilities: ["manage_members", "manage_groups", "manage_roles"] } },
};

/** Explicit installed support: adding metadata alone cannot activate a Workbench target. */
const WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_RAW_V1 = {
  dispositions: Object.fromEntries(Object.keys(WORKBENCH_LOCAL_TARGET_DETAILS).map((target) => [target, { status: "supported" }])),
};
export const WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_V1: UiTargetChannelAdapterV1 = uiTargetChannelAdapterV1Schema.parse(WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_RAW_V1);

/** Workbench-only navigation details; Genie sees only the semantic target ID. */
export const WORKBENCH_APPLICATION_TARGETS: Record<UiTargetId, WorkbenchApplicationTarget> = Object.fromEntries(
  UI_TARGET_DEFINITIONS_V1.map((definition) => [definition.target, {
    definition,
    disposition: WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_V1.dispositions[definition.target],
    ...WORKBENCH_LOCAL_TARGET_DETAILS[definition.target],
  }]),
) as Record<UiTargetId, WorkbenchApplicationTarget>;

export function resolveWorkbenchApplicationTarget(args: {
  version: unknown;
  target: unknown;
  presentation?: unknown;
}, adapter: UiTargetChannelAdapterV1 | null = WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_V1, availability?: WorkbenchTargetAvailability): WorkbenchTargetResolution {
  if (args.version !== GENIE_APPLICATION_BRIDGE_VERSION_V1) {
    return { kind: "unsupported", fallbackText: UNKNOWN_VERSION_FALLBACK };
  }
  const parsedTarget = uiTargetIdSchema.safeParse(args.target);
  if (!parsedTarget.success) {
    return { kind: "unsupported", fallbackText: UNKNOWN_TARGET_FALLBACK };
  }
  if (!adapter) return { kind: "unsupported", fallbackText: UNSUPPORTED_CHANNEL_FALLBACK };
  const disposition = adapter.dispositions[parsedTarget.data];
  if (disposition.status !== "supported") {
    return { kind: "unsupported", fallbackText: disposition.fallbackText };
  }
  const value = WORKBENCH_APPLICATION_TARGETS[parsedTarget.data];
  const required = WORKBENCH_LOCAL_TARGET_DETAILS[parsedTarget.data].availability;
  if (availability && required && ((required.desktop && !availability.isDesktopShell) || (required.verified && !availability.isVerified) || (required.selfManaged && availability.isSelfManaged !== true) || (required.anyCapabilities && !required.anyCapabilities.some((capability) => availability.capabilities.includes(capability))))) {
    return { kind: "unsupported", fallbackText: "This guidance destination is not available for your current Nautilo access or client." };
  }
  if (args.presentation !== undefined) {
    const parsedPresentation = uiPresentationSchema.safeParse(args.presentation);
    if (!parsedPresentation.success || !supportsWorkbenchPresentation(value, parsedPresentation.data)) {
      return { kind: "unsupported", fallbackText: UNSUPPORTED_PRESENTATION_FALLBACK };
    }
  }
  return {
    kind: "supported",
    target: parsedTarget.data,
    value,
  };
}

/**
 * Resolve a requested presentation against the installed client adapter.
 * A route-only target cannot spotlight a control, but it can still reveal its
 * own route. Keep that downgrade local and truthful rather than discarding a
 * valid durable or exact-client guidance target.
 */
export function resolveWorkbenchApplicationPresentation(
  args: { version: unknown; target: unknown; presentation: unknown },
  adapter: UiTargetChannelAdapterV1 | null = WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_V1,
  availability?: WorkbenchTargetAvailability,
): WorkbenchTargetPresentationResolution {
  const target = resolveWorkbenchApplicationTarget(
    { version: args.version, target: args.target },
    adapter,
    availability,
  );
  if (target.kind !== "supported") return target;
  const requested = uiPresentationSchema.safeParse(args.presentation);
  if (!requested.success) return { kind: "unsupported", fallbackText: UNSUPPORTED_PRESENTATION_FALLBACK };
  const presentation = supportsWorkbenchPresentation(target.value, requested.data)
    ? requested.data
    : requested.data === "spotlight" && supportsWorkbenchPresentation(target.value, "reveal")
      ? "reveal"
      : null;
  if (!presentation) return { kind: "unsupported", fallbackText: UNSUPPORTED_PRESENTATION_FALLBACK };
  return { ...target, presentation };
}

/**
 * Present a semantic target through Workbench-owned navigation only. The
 * caller supplies viewer/runtime facts; shared metadata never decides
 * availability, routes, native handlers, or spotlight state.
 */
export async function presentWorkbenchApplicationTarget(
  args: { version: unknown; target: unknown; presentation: unknown },
  dependencies: WorkbenchTargetPresentationDependencies,
): Promise<WorkbenchTargetPresentationResult> {
  const resolution = resolveWorkbenchApplicationPresentation(
    args,
    undefined,
    dependencies.availability,
  );
  if (resolution.kind !== "supported") return resolution;

  if (resolution.value.presentation.kind === "customization-native-or-route") {
    try {
      await revealWorkbenchCustomization({
        ...dependencies.customization,
        navigateToCustomization: () => {
          void dependencies.navigate(genieCustomizationPath());
        },
      });
      return { kind: "presented", target: resolution.target };
    } catch {
      return {
        kind: "unsupported",
        fallbackText: "Customization could not be opened right now. Use the visible Genie menu to continue.",
      };
    }
  }

  void dependencies.navigate(resolution.value.href, {
    ...(resolution.presentation === "spotlight"
      ? { state: workbenchSpotlightLocationState(resolution.target) }
      : {}),
  });
  return { kind: "presented", target: resolution.target };
}

/** Focus only a real semantic anchor; missing nodes never claim a reveal succeeded. */
export function focusWorkbenchUiTarget(
  target: UiTargetId,
  document: WorkbenchFocusDocument,
  options: Readonly<{ scroll?: boolean }> = {},
): WorkbenchFocusResult {
  const resolution = resolveWorkbenchApplicationTarget({
    version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
    target,
  });
  if (resolution.kind === "unsupported" || !resolution.value.presentation.focusAnchorId) {
    return {
      kind: "unsupported",
      fallbackText: resolution.kind === "unsupported"
        ? resolution.fallbackText
        : "This destination can be opened from the visible Genie menu.",
    };
  }
  const node = document.getElementById(resolution.value.presentation.focusAnchorId);
  if (!node) {
    return {
      kind: "unsupported",
      fallbackText: "This destination is available from the Connections page, but this client cannot focus it right now.",
    };
  }
  if (options.scroll !== false) node.scrollIntoView?.({ block: "start" });
  node.focus?.({ preventScroll: true });
  return { kind: "focused", target };
}

/**
 * Route-owned reveal for mounted Workbench targets. React Router's location
 * key deliberately participates so a second navigation to the same hash
 * refocuses the control without relying on browser hashchange events.
 */
export function useWorkbenchUiTargetReveal(
  target: UiTargetId,
  enabled = true,
  onRevealed?: () => void,
  options: Readonly<{ scroll?: boolean }> = {},
): void {
  const location = useLocation();
  const navigate = useNavigate();
  const scrollTargetIntoView = options.scroll !== false;
  const pendingSpotlightTarget = useRef<UiTargetId | null>(null);
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const intent = spotlightIntentFromLocationState(location.state);
    if (intent?.target === target) {
      pendingSpotlightTarget.current = target;
      void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
      return;
    }
    const resolution = resolveWorkbenchApplicationTarget({
      version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
      target,
    });
    if (resolution.kind !== "supported" || !resolution.value.presentation.focusAnchorId) {
      pendingSpotlightTarget.current = null;
      return;
    }
    if (location.hash !== `#${resolution.value.presentation.focusAnchorId}`) {
      pendingSpotlightTarget.current = null;
      return;
    }
    if (focusWorkbenchUiTarget(target, document, {
      scroll: scrollTargetIntoView,
    }).kind !== "focused") {
      pendingSpotlightTarget.current = null;
      return;
    }
    onRevealed?.();

    if (pendingSpotlightTarget.current !== target) return;
    pendingSpotlightTarget.current = null;
    const node = document.getElementById(resolution.value.presentation.focusAnchorId);
    if (!(node instanceof HTMLElement)) return;
    return startWorkbenchTargetSpotlight(node);
  }, [enabled, location.hash, location.key, location.state, location.pathname, location.search, navigate, onRevealed, scrollTargetIntoView, target]);
}

/** Reuse the existing Desktop wizard/browser-route presentation seam. */
export async function revealWorkbenchCustomization(args: Parameters<
  typeof launchGenieCustomizationFromSoftPrompt
>[0]): Promise<void> {
  await launchGenieCustomizationFromSoftPrompt(args);
}
