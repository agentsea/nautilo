import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";

let capabilities: string[] = [];

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { role: "admin" } }),
}));
mock.module("../../hooks/use-can", () => ({
  useCan: () => (capability: string) => capabilities.includes(capability),
}));
mock.module("./posture-edit-modal", () => ({
  PostureEditModal: () => <div data-testid="posture-edit-modal" />,
}));

const { PostureModal } = await import("./posture-modal");

const posture = {
  deploymentMode: "server" as const,
  securityLevel: "standard" as const,
  allowUncontainedHostCommands: false,
  networkPolicy: { mode: "isolated" as const },
  capabilities: ["manage_uncontained_host_commands"],
  actorRole: "admin",
  writablePaths: [],
  readOnlyPaths: [],
  backend: { kind: "bubblewrap" as const, procSupported: true },
};

afterEach(() => {
  cleanup();
  capabilities = [];
});

describe("PostureModal", () => {
  test("stays above drawers and bounds long content inside the viewport", () => {
    reapplyHappyDomGlobals();
    const view = render(
      <PostureModal posture={posture} onClose={() => undefined} onRefresh={async () => undefined} />,
    );

    const dialog = view.getByRole("dialog", { name: "Security posture" });
    expect(dialog.parentElement?.className).toContain("z-50");
    expect(dialog.className).toContain("100dvh-2rem");
    expect(dialog.className).toContain("flex-col");
    expect(dialog.className).toContain("overflow-hidden");
    const scrollRegion = view.getByTestId("security-posture-scroll-region");
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(scrollRegion.previousElementSibling?.contains(
      view.getByRole("button", { name: "Change posture" }),
    )).toBe(true);
  });

  test("uses live RBAC to let the dedicated manager edit when the posture snapshot is stale", () => {
    reapplyHappyDomGlobals();
    capabilities = ["manage_uncontained_host_commands"];
    const view = render(
      <PostureModal
        posture={{ ...posture, capabilities: [] }}
        onClose={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(view.getAllByText("Uncontained host commands")).toHaveLength(2);
    expect(view.getAllByText("Disabled").length).toBeGreaterThan(0);
    expect(view.getByText(/permits no one by itself/i)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Change posture" }));
    expect(view.getByTestId("posture-edit-modal")).toBeTruthy();
  });

  test("does not trust a stale posture snapshot after live management authority is removed", () => {
    reapplyHappyDomGlobals();
    capabilities = [];
    const view = render(
      <PostureModal posture={posture} onClose={() => undefined} onRefresh={async () => undefined} />,
    );

    const button = view.getByRole("button", { name: "Change posture" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  test("activates an eligible Desktop through the existing Security modal with the Human's PIN", async () => {
    reapplyHappyDomGlobals();
    const activate = mock(async (pin: string) => {
      expect(pin).toBe("246810");
      return true;
    });
    const view = render(
      <PostureModal
        posture={posture}
        desktopUncontainedHostCommands={{
          status: { confirmed: true, active: false, eligible: true, reason: null, activatedAt: null },
          busy: false,
          error: null,
          activate,
          disable: async () => undefined,
        }}
        onClose={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Enable for this session" }));
    expect(view.getByRole("heading", { name: "Enable Direct Mac execution" })).toBeTruthy();
    expect(view.getByText(/current folder is not a boundary/i)).toBeTruthy();
    const user = userEvent.setup({ document: globalThis.document });
    await user.type(view.getByPlaceholderText("••••••"), "246810");
    fireEvent.click(view.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("246810"));
  });

  test("shows a confirmed active Desktop as uncontained and turns it off immediately", async () => {
    reapplyHappyDomGlobals();
    const disable = mock(async () => undefined);
    const view = render(
      <PostureModal
        posture={posture}
        desktopUncontainedHostCommands={{
          status: {
            confirmed: true,
            active: true,
            eligible: true,
            reason: null,
            activatedAt: "2026-08-26T12:00:00.000Z",
          },
          busy: false,
          error: null,
          activate: async () => true,
          disable,
        }}
        onClose={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(view.getByRole("heading", { name: "THIS DESKTOP IS UNCONTAINED" })).toBeTruthy();
    expect(view.getByText(/current folder is not a security boundary/i)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Turn off immediately" }));
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
  });

  test("never presents an unconfirmed active claim as live authority", () => {
    reapplyHappyDomGlobals();
    const view = render(
      <PostureModal
        posture={posture}
        desktopUncontainedHostCommands={{
          status: {
            confirmed: false,
            active: true,
            eligible: true,
            reason: "server_status_refreshing",
            activatedAt: "2026-08-26T12:00:00.000Z",
          },
          busy: false,
          error: null,
          activate: async () => true,
          disable: async () => undefined,
        }}
        onClose={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(view.queryByRole("heading", { name: "THIS DESKTOP IS UNCONTAINED" })).toBeNull();
    expect(view.getByText(/Unavailable for this Desktop session/i)).toBeTruthy();
  });
});
