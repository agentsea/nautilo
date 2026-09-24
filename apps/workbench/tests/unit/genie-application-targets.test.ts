import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, Fragment, useEffect, type ReactElement } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import {
  GENIE_APPLICATION_BRIDGE_VERSION_V1,
  UI_TARGET_DEFINITIONS_V1,
  UI_TARGET_IDS_V1,
  type UiTargetChannelAdapterV1,
} from "@nautilo/types";
import {
  WORKBENCH_APPLICATION_TARGETS,
  WORKBENCH_TARGET_SPOTLIGHT_DURATION_MS,
  WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_V1,
  focusWorkbenchUiTarget,
  resolveWorkbenchApplicationTarget,
  resolveWorkbenchApplicationPresentation,
  revealWorkbenchCustomization,
  startWorkbenchTargetSpotlight,
  useWorkbenchUiTargetReveal,
  workbenchSpotlightLocationState,
} from "../../src/lib/genie-application-targets";
import { APPLICATION_CATALOGUE_MANIFEST_V1 } from "../../src/lib/application-catalogue-manifest";
import { APPLICATION_ROUTE_TARGETS_V1 } from "../../src/app";
import { SETTINGS_NESTED_SECTIONS, SETTINGS_SECTIONS } from "../../src/pages/settings/settings-page";
import { CONNECTIONS_SECTIONS } from "../../src/pages/connections/connections-sections";
import {
  ADMIN_DESTINATIONS,
  ADMIN_PAGE_CAPS,
  ADMIN_SECTIONS,
} from "../../src/pages/admin/admin-sections";
import { accessControlTabs } from "../../src/pages/admin/access-control/access-control-tabs";
import { DESTINATION_RAIL_ITEMS } from "../../src/components/navigation-rail/rail-items";

let navigateTo: ReturnType<typeof useNavigate> | null = null;

function NavigationCapture() {
  const navigate = useNavigate();
  useEffect(() => { navigateTo = navigate; }, [navigate]);
  return null;
}

function TargetRevealProbe({ target }: { target: (typeof UI_TARGET_IDS_V1)[number] }) {
  useWorkbenchUiTargetReveal(target);
  const anchor = WORKBENCH_APPLICATION_TARGETS[target].presentation.focusAnchorId;
  return anchor ? createElement("div", { id: anchor }) : null;
}

function SpotlightStateCapture() {
  const location = useLocation();
  return createElement("output", { "data-testid": "spotlight-state" }, String(location.state));
}

function renderWithRouter(ui: ReactElement) {
  return render(createElement(MemoryRouter, { initialEntries: ["/connections"] }, ui));
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  navigateTo = null;
});

describe("Workbench Genie application target registry", () => {
  test("mechanically reconciles canonical rendered manifests to generated IDs and local dispositions", () => {
    const expected = new Set(UI_TARGET_IDS_V1);
    const catalogue = APPLICATION_CATALOGUE_MANIFEST_V1.map((entry) => entry.target);
    expect(new Set(catalogue).size).toBe(catalogue.length);
    expect([...catalogue].sort()).toEqual([...expected].sort());
    expect(Object.keys(WORKBENCH_APPLICATION_TARGETS).sort()).toEqual([...expected].sort());
    expect(Object.keys(WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_V1.dispositions).sort()).toEqual([...expected].sort());

    const rendered = [
      ...APPLICATION_ROUTE_TARGETS_V1,
      ...SETTINGS_SECTIONS.map(({ id, catalogueTarget }) => ({ id, catalogueTarget })),
      ...SETTINGS_NESTED_SECTIONS.map(({ id, catalogueTarget }) => ({ id, catalogueTarget })),
      ...CONNECTIONS_SECTIONS.flatMap((section) => section.cards.flatMap((card) => (
        card.catalogueTarget ? [{ id: card.id, catalogueTarget: card.catalogueTarget }] : []
      ))),
      ...ADMIN_SECTIONS.map(({ id, catalogueTarget }) => ({ id, catalogueTarget })),
      ...accessControlTabs(() => true).flatMap((tab) => tab.catalogueTarget ? [{ id: tab.id, catalogueTarget: tab.catalogueTarget }] : []),
    ];
    for (const source of rendered) {
      expect(APPLICATION_CATALOGUE_MANIFEST_V1.some((entry) => (
        entry.target === source.catalogueTarget && entry.sourceId === source.id
      ))).toBe(true);
    }
    const renderedTargets = rendered.map((source) => source.catalogueTarget);
    expect(new Set(renderedTargets).size).toBe(renderedTargets.length);
    expect([...renderedTargets].sort()).toEqual([...catalogue].sort());
    // The unavailable audit tab, parameterized resources, redirects, and rail actions have no catalogue target.
    expect(accessControlTabs(() => true).find((tab) => tab.id === "audit")?.catalogueTarget).toBeUndefined();
    for (const item of DESTINATION_RAIL_ITEMS) {
      if (item.kind === "route") expect(item.catalogueTarget && expected.has(item.catalogueTarget)).toBe(true);
    }
    const adminRail = DESTINATION_RAIL_ITEMS.find((item) => item.id === "admin");
    expect(adminRail?.requiresAnyCap).toEqual(ADMIN_PAGE_CAPS);
    for (const destination of ADMIN_DESTINATIONS) {
      const allowed = resolveWorkbenchApplicationTarget(
        { version: GENIE_APPLICATION_BRIDGE_VERSION_V1, target: destination.catalogueTarget },
        undefined,
        {
          isVerified: true,
          capabilities: destination.requiresAnyCap,
          isDesktopShell: false,
          isSelfManaged: true,
        },
      );
      expect(allowed.kind).toBe("supported");
      expect(resolveWorkbenchApplicationTarget(
        { version: GENIE_APPLICATION_BRIDGE_VERSION_V1, target: destination.catalogueTarget },
        undefined,
        {
          isVerified: true,
          capabilities: [],
          isDesktopShell: false,
          isSelfManaged: true,
        },
      ).kind).toBe("unsupported");
      if ("selfManagedOnly" in destination) {
        expect(resolveWorkbenchApplicationTarget(
          { version: GENIE_APPLICATION_BRIDGE_VERSION_V1, target: destination.catalogueTarget },
          undefined,
          {
            isVerified: true,
            capabilities: destination.requiresAnyCap,
            isDesktopShell: false,
            isSelfManaged: false,
          },
        ).kind).toBe("unsupported");
      }
    }
  });

  test("binds every closed v1 target to shared metadata, adapter disposition, and an explicit local strategy", () => {
    expect(Object.keys(WORKBENCH_APPLICATION_TARGETS).sort()).toEqual([...UI_TARGET_IDS_V1].sort());
    expect(Object.keys(WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_V1.dispositions).sort()).toEqual([...UI_TARGET_IDS_V1].sort());
    for (const target of UI_TARGET_IDS_V1) {
      const resolution = resolveWorkbenchApplicationTarget({ version: GENIE_APPLICATION_BRIDGE_VERSION_V1, target });
      expect(resolution.kind).toBe("supported");
      if (resolution.kind !== "supported") continue;
      expect(resolution.target).toBe(target);
      expect(resolution.value.href).toMatch(/^\//);
      expect(resolution.value.definition).toEqual(
        UI_TARGET_DEFINITIONS_V1.find((definition) => definition.target === target),
      );
      expect(resolution.value.disposition).toEqual({ status: "supported" });
      expect(resolution.value.presentation.supportedPresentations).toEqual(
        resolution.value.presentation.kind === "anchor" ? ["link", "reveal", "spotlight"] : ["link", "reveal"],
      );
    }
    expect(WORKBENCH_APPLICATION_TARGETS["genie.customization"].presentation.kind)
      .toBe("customization-native-or-route");
    expect(WORKBENCH_APPLICATION_TARGETS["connections.google"].presentation.kind).toBe("anchor");
  });

  test("keeps Workbench routes local and returns durable truthful fallback for unknown inputs", () => {
    expect(WORKBENCH_APPLICATION_TARGETS["connections.google"].href).toBe("/connections#google");
    expect(WORKBENCH_APPLICATION_TARGETS["connections.local_mcp"].presentation.focusAnchorId).toBe("local-mcp");
    for (const input of [
      { version: 2, target: "connections.google" },
      { version: GENIE_APPLICATION_BRIDGE_VERSION_V1, target: "connections.unknown" },
    ]) {
      const resolution = resolveWorkbenchApplicationTarget(input);
      expect(resolution.kind).toBe("unsupported");
      if (resolution.kind === "unsupported") {
        expect(resolution.fallbackText).toContain("visible");
        expect(resolution.fallbackText).not.toMatch(/opened|opening|revealed|shown/i);
      }
    }
  });

  test("uses the shared closed adapter disposition and fails truthfully for missing or unsupported channels", () => {
    const unsupportedAdapter: UiTargetChannelAdapterV1 = {
      dispositions: {
        ...WORKBENCH_UI_TARGET_CHANNEL_ADAPTER_V1.dispositions,
        "connections.google": {
          status: "unsupported",
          fallbackText: "Google Workspace is not available in this Nautilo client.",
        },
      },
    };
    const missing = resolveWorkbenchApplicationTarget({
      version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
      target: "connections.google",
    }, null);
    expect(missing).toMatchObject({ kind: "unsupported" });
    if (missing.kind === "unsupported") expect(missing.fallbackText).not.toMatch(/opened|revealed/i);

    expect(resolveWorkbenchApplicationTarget({
      version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
      target: "connections.google",
    }, unsupportedAdapter)).toEqual({
      kind: "unsupported",
      fallbackText: "Google Workspace is not available in this Nautilo client.",
    });
    const spotlight = resolveWorkbenchApplicationTarget({
      version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
      target: "connections.google",
      presentation: "spotlight",
    });
    expect(spotlight).toMatchObject({ kind: "supported", target: "connections.google" });
    expect(resolveWorkbenchApplicationTarget({
      version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
      target: "genie.customization",
      presentation: "spotlight",
    })).toMatchObject({ kind: "unsupported" });
  });

  test("normalizes unsupported spotlight requests through each installed target's local reveal capability", () => {
    const effective = UI_TARGET_IDS_V1.map((target) => {
      const resolution = resolveWorkbenchApplicationPresentation({
        version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
        target,
        presentation: "spotlight",
      });
      expect(resolution.kind).toBe("supported");
      if (resolution.kind !== "supported") throw new Error(`expected ${target} to resolve`);
      return { target, presentation: resolution.presentation };
    });
    expect(effective.filter(({ presentation }) => presentation === "spotlight").map(({ target }) => target).sort())
      .toEqual(["connections.codex", "connections.github_cli", "connections.google", "connections.local_mcp", "connections.ssh"]);
    expect(effective.filter(({ presentation }) => presentation === "reveal")).toHaveLength(50);
    expect(resolveWorkbenchApplicationPresentation({ version: 2, target: "admin.provider_credentials", presentation: "spotlight" }).kind).toBe("unsupported");
    expect(resolveWorkbenchApplicationPresentation({ version: 1, target: "connections.unknown", presentation: "spotlight" }).kind).toBe("unsupported");
    expect(resolveWorkbenchApplicationPresentation({ version: 1, target: "admin.provider_credentials", presentation: "click" }).kind).toBe("unsupported");
  });

  test("filters installed capability and Desktop requirements without consulting metadata", () => {
    const guest = { isVerified: false, capabilities: [], isDesktopShell: false };
    const member = {
      ...guest,
      isVerified: true,
      capabilities: ["use_research_tools", "use_workstation"],
    };
    expect(resolveWorkbenchApplicationTarget({ version: 1, target: "admin" }, undefined, guest).kind)
      .toBe("unsupported");
    expect(resolveWorkbenchApplicationTarget({ version: 1, target: "admin" }, undefined, member).kind)
      .toBe("unsupported");
    expect(resolveWorkbenchApplicationTarget({ version: 1, target: "admin" }, undefined, {
      ...member,
      capabilities: [...member.capabilities, "read_server_settings"],
    }).kind).toBe("supported");
    const billingManager = { ...member, capabilities: ["manage_billing"] };
    expect(resolveWorkbenchApplicationTarget({ version: 1, target: "admin" }, undefined, billingManager).kind)
      .toBe("supported");
    expect(resolveWorkbenchApplicationTarget({ version: 1, target: "admin.costs" }, undefined, billingManager).kind)
      .toBe("supported");
    expect(resolveWorkbenchApplicationTarget({ version: 1, target: "connections.github_cli" }, undefined, { ...guest, isVerified: true }).kind).toBe("unsupported");
    expect(resolveWorkbenchApplicationTarget({ version: 1, target: "connections.github_cli" }, undefined, { ...guest, isVerified: true, isDesktopShell: true }).kind).toBe("supported");
    expect(resolveWorkbenchApplicationTarget({ version: 1, target: "connections.ssh" }, undefined, guest).kind).toBe("unsupported");
    for (const target of [
      "settings.this_mac",
      "settings.startup",
      "settings.current_folder",
      "settings.desktop_permissions",
      "settings.workstation_access",
      "settings.mobile_access",
    ] as const) {
      expect(resolveWorkbenchApplicationTarget({ version: 1, target }, undefined, member).kind)
        .toBe("unsupported");
      expect(resolveWorkbenchApplicationTarget(
        { version: 1, target },
        undefined,
        { ...member, isDesktopShell: true },
      ).kind).toBe("supported");
    }
  });

  test("focuses a real semantic anchor and fails truthfully when the anchor is absent", () => {
    const calls: string[] = [];
    const node = {
      scrollIntoView: () => calls.push("scroll"),
      focus: () => calls.push("focus"),
    };
    expect(focusWorkbenchUiTarget("connections.ssh", {
      getElementById: (id) => id === "ssh" ? node : null,
    })).toEqual({ kind: "focused", target: "connections.ssh" });
    expect(calls).toEqual(["scroll", "focus"]);
    const missing = focusWorkbenchUiTarget("connections.codex", { getElementById: () => null });
    expect(missing.kind).toBe("unsupported");
    if (missing.kind === "unsupported") expect(missing.fallbackText).toContain("cannot focus");
  });

  test("can preserve route focus and spotlight without scrolling a stable surface", () => {
    const calls: string[] = [];
    const node = {
      scrollIntoView: () => calls.push("scroll"),
      focus: () => calls.push("focus"),
    };

    expect(focusWorkbenchUiTarget(
      "connections.google",
      { getElementById: (id) => id === "google" ? node : null },
      { scroll: false },
    )).toEqual({ kind: "focused", target: "connections.google" });
    expect(calls).toEqual(["focus"]);
  });

  test.each([
    "connections.google",
    "connections.ssh",
    "connections.codex",
    "connections.local_mcp",
  ] as const)("uses Router location hash and key to focus repeated %s navigation", async (target) => {
    const view = renderWithRouter(
      createElement(
        Fragment,
        null,
        createElement(NavigationCapture),
        createElement(TargetRevealProbe, { target }),
      ),
    );
    const applicationTarget = WORKBENCH_APPLICATION_TARGETS[target];
    const anchor = view.container.querySelector(
      `#${applicationTarget.presentation.focusAnchorId}`,
    ) as HTMLElement;
    const scrollIntoView = mock(() => undefined);
    const focus = mock(() => undefined);
    Object.assign(anchor, { scrollIntoView, focus });
    await waitFor(() => expect(navigateTo).not.toBeNull());

    await act(async () => { navigateTo?.(applicationTarget.href); });
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    await act(async () => { navigateTo?.(applicationTarget.href); });
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(2));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  test("consumes the strict one-shot spotlight state before focusing and cleans spotlight interaction", async () => {
    const target = "connections.google" as const;
    const intent = workbenchSpotlightLocationState(target);
    const view = render(
      createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: "/connections", hash: "#google", state: intent }] },
        createElement(Fragment, null, createElement(SpotlightStateCapture), createElement(TargetRevealProbe, { target })),
      ),
    );
    const anchor = view.container.querySelector("#google") as HTMLElement;
    await waitFor(() => expect(anchor.classList.contains("genie-ui-target-spotlight")).toBe(true));
    expect(anchor.classList.contains("genie-ui-target-spotlight")).toBe(true);
    expect(view.getByTestId("spotlight-state").textContent).toBe("null");
    fireEvent.pointerDown(document.body);
    expect(anchor.classList.contains("genie-ui-target-spotlight")).toBe(false);

    expect(WORKBENCH_TARGET_SPOTLIGHT_DURATION_MS).toBe(6_000);
    const previousSetTimeout = window.setTimeout;
    const previousClearTimeout = window.clearTimeout;
    const timers: Array<{ callback: TimerHandler; delay?: number }> = [];
    const cleared: number[] = [];
    window.setTimeout = ((callback: TimerHandler, delay?: number) => {
      timers.push({ callback, delay });
      return timers.length;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timer?: number) => { if (timer) cleared.push(timer); }) as typeof window.clearTimeout;
    try {
      const firstCleanup = startWorkbenchTargetSpotlight(anchor);
      const secondCleanup = startWorkbenchTargetSpotlight(anchor);
      expect(timers.map((timer) => timer.delay)).toEqual([6_000, 6_000]);
      expect(cleared).toContain(1);
      fireEvent.keyDown(document.body, { key: "Enter" });
      expect(anchor.classList.contains("genie-ui-target-spotlight")).toBe(false);
      expect(cleared).toContain(2);
      startWorkbenchTargetSpotlight(anchor);
      (timers.at(-1)?.callback as () => void)();
      expect(anchor.classList.contains("genie-ui-target-spotlight")).toBe(false);
      expect(cleared).toContain(3);
      firstCleanup();
      secondCleanup();
      expect(cleared).toContain(2);
    } finally {
      window.setTimeout = previousSetTimeout;
      window.clearTimeout = previousClearTimeout;
    }
  });

  test("cleans an active spotlight when real Router navigation leaves its target", async () => {
    const view = render(
      createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: "/connections", hash: "#google", state: workbenchSpotlightLocationState("connections.google") }] },
        createElement(Fragment, null, createElement(NavigationCapture), createElement(TargetRevealProbe, { target: "connections.google" })),
      ),
    );
    const anchor = view.container.querySelector("#google") as HTMLElement;
    await waitFor(() => expect(anchor.classList.contains("genie-ui-target-spotlight")).toBe(true));
    await waitFor(() => expect(navigateTo).not.toBeNull());
    await act(async () => { navigateTo?.("/connections#ssh"); });
    await waitFor(() => expect(anchor.classList.contains("genie-ui-target-spotlight")).toBe(false));
  });

  test("keeps the spotlight animation motion-gated while reduced motion retains static emphasis", async () => {
    const css = await Bun.file(new URL("../../src/index.css", import.meta.url)).text();
    expect(css).toContain(".genie-ui-target-spotlight {");
    expect(css).toContain("outline: 3px solid var(--accent);");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(css).toContain("animation: genie-ui-target-spotlight");
  });

  test("delegates browser and Desktop customization reveal to the existing soft-prompt helper", async () => {
    const navigations: string[] = [];
    await revealWorkbenchCustomization({
      hasDesktopBridge: false,
      getAccessToken: async () => "unused",
      getTheme: () => null,
      navigateToCustomization: () => navigations.push("/customize-genie"),
    });
    await revealWorkbenchCustomization({
      hasDesktopBridge: true,
      onboardingOpen: async () => navigations.push("desktop-wizard"),
      getAccessToken: async () => "desktop-token",
      getTheme: () => "dark",
      navigateToCustomization: () => navigations.push("unexpected-browser-route"),
    });
    expect(navigations).toEqual(["/customize-genie", "desktop-wizard"]);
  });
});


test("Memory processing uses the shared Admin capability and destination", () => {
  const available = resolveWorkbenchApplicationTarget({ version: 1, target: "admin.memory" }, undefined,
    { isVerified: true, isDesktopShell: false, capabilities: ["read_server_settings"] });
  expect(available.kind).toBe("supported");
  if (available.kind === "supported") expect(available.value.href).toBe("/admin#memory");
  expect(resolveWorkbenchApplicationTarget({ version: 1, target: "admin.memory" }, undefined,
    { isVerified: true, isDesktopShell: true, capabilities: [] }).kind).toBe("unsupported");
});
