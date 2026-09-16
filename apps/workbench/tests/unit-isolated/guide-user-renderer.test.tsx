import { beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import {
  GENIE_APPLICATION_BRIDGE_VERSION_V1,
  UI_TARGET_IDS_V1,
} from "@nautilo/types";
import { resolveWorkbenchApplicationPresentation } from "../../src/lib/genie-application-targets";

const getAccessToken = mock(async () => "token");
mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    session: { getAccessToken },
    viewer: {
      isVerified: true,
      capabilities: ["manage_server_settings"],
    },
  }),
}));
mock.module("../../src/lib/desktop", () => ({ isDesktop: false, desktopAPI: null }));
mock.module("../../src/contexts/setup-status-context", () => ({
  useSetupStatus: () => ({ providers: { managedByCloud: false } }),
}));

const { guideUserRenderer } = await import("../../src/components/tool-card/renderers/guide-user");
const { ToolCard } = await import("../../src/components/tool-card/tool-card");

function LocationProbe() {
  const location = useLocation();
  return <>
    <output data-testid="location">{`${location.pathname}${location.hash}`}</output>
    <output data-testid="location-state">{JSON.stringify(location.state)}</output>
  </>;
}

function renderGuide(
  args: Record<string, unknown>,
  resultText: string,
  parentClick = mock(() => undefined),
  state: "running" | "success" | "error" = "success",
  resultTruncated = false,
) {
  const ExpandedBody = guideUserRenderer.ExpandedBody;
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <LocationProbe />
      <div onClick={parentClick} onKeyDown={parentClick}>
        <ExpandedBody
          args={args}
          result={resultText}
          resultText={resultText}
          resultTruncated={resultTruncated}
          state={state}
          event={undefined}
        />
      </div>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  getAccessToken.mockClear();
});

describe("guide_user renderer", () => {
  test("auto-expands a persisted successful guidance card so its action is immediately visible", async () => {
    const result = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-visible", target: "connections.google", presentation: "reveal", fallbackText: "Use Connections then Google Workspace to continue." });
    const view = render(
      <MemoryRouter initialEntries={["/"]}>
        <ToolCard
          toolName="guide_user"
          toolCallId="guide-visible"
          args={{ version: 1, target: "connections.google", presentation: "reveal", confirmed: true }}
          result={result}
          status={{ type: "complete" }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByRole("button", { name: /show google workspace/i })).toBeTruthy());
    expect(guideUserRenderer.autoExpandOnResult).toBe(true);
  });

  test("auto-expands the matching live terminal receipt but never presents it on card mount", async () => {
    const result = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-live", target: "connections.ssh", presentation: "spotlight", fallbackText: "Use Connections then SSH to continue." });
    const view = render(
      <MemoryRouter initialEntries={["/"]}>
        <LocationProbe />
        <ToolCard
          toolName="guide_user"
          toolCallId="guide-live"
          args={{ version: 1, target: "connections.ssh", presentation: "spotlight", confirmed: true }}
          result={undefined}
          status={{ type: "running" }}
          activityOverride={{
            toolCallId: "guide-live",
            toolName: "guide_user",
            args: {},
            status: "ok",
            startedAt: 1,
            result,
          }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(view.getByRole("button", { name: /show and highlight ssh/i })).toBeTruthy());
    expect(view.getByTestId("location").textContent).toBe("/");
  });

  test("renders persisted and live API keys spotlight guidance as a truthful local reveal", async () => {
    const args = { version: 1, target: "admin.provider_credentials", presentation: "spotlight", confirmed: true };
    const result = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-api-keys", target: "admin.provider_credentials", presentation: "spotlight", fallbackText: "Use Server admin then API Keys to continue." });
    const card = (status: "running" | "complete", activityOverride?: object) => (
      <MemoryRouter initialEntries={["/"]}>
        <LocationProbe />
        <ToolCard
          toolName="guide_user"
          toolCallId="guide-api-keys"
          args={args}
          result={status === "complete" && !activityOverride ? result : undefined}
          status={{ type: status }}
          {...(activityOverride ? { activityOverride: activityOverride as never } : {})}
        />
      </MemoryRouter>
    );

    const rehydrated = render(card("complete"));
    await waitFor(() => expect(rehydrated.getByRole("button", { name: /show api keys/i })).toBeTruthy());
    expect(rehydrated.getByRole("group").getAttribute("aria-expanded")).toBe("true");
    expect(rehydrated.getByTestId("location").textContent).toBe("/");
    fireEvent.click(rehydrated.getByRole("button", { name: /show api keys/i }));
    expect(rehydrated.getByTestId("location").textContent).toBe("/admin#provider-credentials");
    expect(rehydrated.getByTestId("location-state").textContent).toBe("null");
    rehydrated.unmount();

    const live = render(card("running", {
      toolCallId: "guide-api-keys", toolName: "guide_user", args, status: "running",
    }));
    expect(live.queryByRole("button", { name: /show api keys/i })).toBeNull();
    expect(live.getByTestId("location").textContent).toBe("/");
    live.rerender(card("complete", {
      toolCallId: "guide-api-keys", toolName: "guide_user", args, status: "ok", result,
    }));
    await waitFor(() => expect(live.getByRole("button", { name: /show api keys/i })).toBeTruthy());
    expect(live.getByRole("group").getAttribute("aria-expanded")).toBe("true");
    expect(live.getByTestId("location").textContent).toBe("/");
    fireEvent.click(live.getByRole("button", { name: /show api keys/i }));
    expect(live.getByTestId("location").textContent).toBe("/admin#provider-credentials");
    expect(live.getByTestId("location-state").textContent).toBe("null");
  });

  test("renders every bundled spotlight result as an installed action or truthful access fallback", () => {
    const availability = {
      isVerified: true,
      capabilities: ["manage_server_settings"],
      isDesktopShell: false,
      isSelfManaged: true,
    };
    for (const [index, target] of UI_TARGET_IDS_V1.entries()) {
      const args = { version: GENIE_APPLICATION_BRIDGE_VERSION_V1, target, presentation: "spotlight" as const, confirmed: true };
      const result = JSON.stringify({
        version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
        kind: "guidance",
        actionId: `guide-target-${index}`,
        target,
        presentation: "spotlight",
        fallbackText: "Use the visible Nautilo menu to continue.",
      });
      const view = renderGuide(args, result);
      expect(view.queryByText(/this saved guidance is no longer available/i)).toBeNull();
      const resolution = resolveWorkbenchApplicationPresentation(args, undefined, availability);
      if (resolution.kind === "supported") {
        expect(view.getByRole("button", { name: new RegExp(resolution.value.definition.label, "i") })).toBeTruthy();
      } else {
        expect(view.queryByRole("button")).toBeNull();
        expect(view.container.textContent).toContain(resolution.fallbackText);
      }
      view.unmount();
    }
  });

  test("renders safe discovery records and a truthful empty state without an action", () => {
    const result = JSON.stringify({
      version: 1,
      kind: "discovery",
      targets: [{ target: "connections.google", label: "Google Workspace", menuPath: ["Connections", "Google Workspace"], description: "Connect or repair Google Workspace access." }],
    });
    const view = renderGuide({ version: 1, query: "google" }, result);
    expect(view.getByText("Google Workspace")).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
    view.unmount();
    const empty = renderGuide({ version: 1, query: "missing" }, JSON.stringify({ version: 1, kind: "discovery", targets: [] }));
    expect(empty.getByTestId("guide-user-empty")).toBeTruthy();
  });

  test("rejects invalid persisted payloads and never exposes an action", () => {
    const view = renderGuide({ version: 1, query: "google" }, "{not-json");
    expect(view.getByText(/saved guidance is no longer available/i)).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });

  test("never exposes an action before a complete, untruncated success result", () => {
    const result = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-1", target: "connections.google", presentation: "reveal", fallbackText: "Use Connections then Google Workspace to continue." });
    const running = renderGuide({ version: 1, target: "connections.google", presentation: "reveal", confirmed: true }, result, mock(() => undefined), "running");
    expect(running.getByText(/still being prepared/i)).toBeTruthy();
    expect(running.queryByRole("button")).toBeNull();
    running.unmount();
    const truncated = renderGuide({ version: 1, target: "connections.google", presentation: "reveal", confirmed: true }, result, mock(() => undefined), "success", true);
    expect(truncated.queryByRole("button")).toBeNull();
  });

  test("keeps guidance Human-clicked, stops card keyboard/click propagation, and uses the local connection href", () => {
    const parentClick = mock(() => undefined);
    const result = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-1", target: "connections.google", presentation: "reveal", fallbackText: "Use Connections then Google Workspace to continue." });
    const view = renderGuide({ version: 1, target: "connections.google", presentation: "reveal", confirmed: true }, result, parentClick);
    const button = view.getByRole("button", { name: /show google workspace/i });
    expect(view.getByTestId("location").textContent).toBe("/");
    fireEvent.keyDown(button, { key: "Enter" });
    expect(parentClick).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(parentClick).not.toHaveBeenCalled();
    expect(view.getByTestId("location").textContent).toBe("/connections#google");
  });

  test("uses the canonical presenter for browser customization routing", () => {
    const args = { version: 1, target: "genie.customization", presentation: "reveal", confirmed: true };
    const result = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-1", target: "genie.customization", presentation: "reveal", fallbackText: "Use Genie then Customize to continue." });
    const browser = renderGuide(args, result);
    const browserButton = browser.getByRole("button", { name: /show customize genie/i });
    expect(browser.getByTestId("location").textContent).toBe("/");
    fireEvent.click(browserButton);
    expect(browser.getByTestId("location").textContent).toBe("/customize-genie");
    browser.unmount();

  });

  test("uses bounded spotlight Router state and lets repeated clicks and independent viewers act independently", () => {
    const spotlightArgs = { version: 1, target: "connections.ssh", presentation: "spotlight", confirmed: true };
    const spotlightResult = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-spotlight", target: "connections.ssh", presentation: "spotlight", fallbackText: "Use Connections then SSH to continue." });
    const spotlight = renderGuide(spotlightArgs, spotlightResult);
    fireEvent.click(spotlight.getByRole("button", { name: /show and highlight ssh/i }));
    expect(spotlight.getByTestId("location").textContent).toBe("/connections#ssh");
    expect(JSON.parse(spotlight.getByTestId("location-state").textContent ?? "null")).toEqual({
      d513GuidePresentation: { version: 1, target: "connections.ssh", presentation: "spotlight" },
    });
    fireEvent.click(spotlight.getByRole("button", { name: /show and highlight ssh/i }));
    expect(spotlight.getByTestId("location").textContent).toBe("/connections#ssh");

    const result = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-other", target: "connections.codex", presentation: "reveal", fallbackText: "Use Connections then Codex to continue." });
    const first = renderGuide({ version: 1, target: "connections.codex", presentation: "reveal", confirmed: true }, result);
    const second = renderGuide({ version: 1, target: "connections.codex", presentation: "reveal", confirmed: true }, result);
    fireEvent.click(within(first.container).getByRole("button", { name: /show codex/i }));
    fireEvent.click(within(second.container).getByRole("button", { name: /show codex/i }));
    expect(within(first.container).getByTestId("location").textContent).toBe("/connections#codex");
    expect(within(second.container).getByTestId("location").textContent).toBe("/connections#codex");
  });

  test.each([
    ["reveal", "connections.google", "Open Google Workspace", "/connections#google"],
    ["spotlight", "connections.ssh", "Open SSH", "/connections#ssh"],
  ] as const)("accepts the server downgrade from requested %s to a link", (requested, target, label, href) => {
    const result = JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-link", target, presentation: "link", fallbackText: "Use Connections to continue." });
    const view = renderGuide({ version: 1, target, presentation: requested, confirmed: true }, result);
    const button = view.getByRole("button", { name: label });
    fireEvent.click(button);
    expect(view.getByTestId("location").textContent).toBe(href);
    expect(view.getByTestId("location-state").textContent).toBe("null");
  });

  test("blocks mismatched args/results", () => {
    const mismatched = renderGuide(
      { version: 1, target: "connections.google", presentation: "reveal", confirmed: true },
      JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-1", target: "connections.ssh", presentation: "reveal", fallbackText: "Use Connections then SSH to continue." }),
    );
    expect(mismatched.queryByRole("button")).toBeNull();
  });

  test.each([
    ["wrong args version", { version: 2, query: "google" }, JSON.stringify({ version: 1, kind: "discovery", targets: [] })],
    ["wrong result version", { version: 1, query: "google" }, JSON.stringify({ version: 2, kind: "discovery", targets: [] })],
    ["unknown target", { version: 1, target: "connections.unknown", presentation: "reveal", confirmed: true }, JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-1", target: "connections.google", presentation: "reveal", fallbackText: "Use Connections then Google Workspace to continue." })],
    ["branch mismatch", { version: 1, query: "google" }, JSON.stringify({ version: 1, kind: "guidance", actionId: "guide-1", target: "connections.google", presentation: "link", fallbackText: "Use Connections then Google Workspace to continue." })],
  ])("renders bounded inert fallback for %s", (_case, args, result) => {
    const view = renderGuide(args, result);
    expect(view.getByText(/saved guidance is no longer available/i)).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });
});
