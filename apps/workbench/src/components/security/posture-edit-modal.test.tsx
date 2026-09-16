import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";

const updateSecurityPosture = mock(async () => ({ changed: true }));

mock.module("../../lib/api", () => ({
  apiClient: { updateSecurityPosture },
}));
mock.module("../pin-dialog", () => ({
  PinDialog: ({ onSubmit }: { readonly onSubmit: (pin: string) => void }) => (
    <button type="button" onClick={() => onSubmit("246810")}>Submit test PIN</button>
  ),
}));

const { PostureEditModal } = await import("./posture-edit-modal");

const posture = {
  deploymentMode: "server" as const,
  securityLevel: "standard" as const,
  allowUncontainedHostCommands: false,
  networkPolicy: { mode: "isolated" as const },
  capabilities: [],
  actorRole: "admin",
  writablePaths: [],
  readOnlyPaths: [],
  backend: { kind: "bubblewrap" as const, procSupported: true },
};

afterEach(() => {
  cleanup();
  updateSecurityPosture.mockReset();
  updateSecurityPosture.mockResolvedValue({ changed: true });
});

describe("PostureEditModal", () => {
  test("stays on the posture modal tier so the nested editor is clickable", () => {
    reapplyHappyDomGlobals();
    const view = render(
      <PostureEditModal
        posture={posture}
        canManageServerSecurity
        canManageUncontainedHostCommands
        onClose={() => undefined}
        onUpdated={async () => undefined}
      />,
    );

    expect(view.getByTestId("security-posture-edit-overlay").className).toContain("z-50");
  });

  test("sends only the policy boolean and PIN for a dedicated policy manager", async () => {
    reapplyHappyDomGlobals();
    const view = render(
      <PostureEditModal
        posture={posture}
        canManageServerSecurity={false}
        canManageUncontainedHostCommands
        onClose={() => undefined}
        onUpdated={async () => undefined}
      />,
    );

    expect((view.getByLabelText("Deployment mode") as HTMLSelectElement).disabled).toBe(true);
    expect((view.getByLabelText("Security level") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(view.getByLabelText("Allow uncontained host commands"));
    fireEvent.click(view.getByRole("button", { name: "Confirm with PIN" }));
    fireEvent.click(view.getByRole("button", { name: "Submit test PIN" }));

    await waitFor(() => {
      expect(updateSecurityPosture).toHaveBeenCalledWith({
        allowUncontainedHostCommands: true,
        pin: "246810",
      });
    });
  });

  test("allows one mixed mutation and one PIN for an owner", async () => {
    reapplyHappyDomGlobals();
    const view = render(
      <PostureEditModal
        posture={posture}
        canManageServerSecurity
        canManageUncontainedHostCommands
        onClose={() => undefined}
        onUpdated={async () => undefined}
      />,
    );

    fireEvent.change(view.getByLabelText("Security level"), { target: { value: "permissive" } });
    fireEvent.click(view.getByLabelText("Allow uncontained host commands"));
    fireEvent.click(view.getByRole("button", { name: "Confirm with PIN" }));
    fireEvent.click(view.getByRole("button", { name: "Submit test PIN" }));

    await waitFor(() => {
      expect(updateSecurityPosture).toHaveBeenCalledWith({
        securityLevel: "permissive",
        allowUncontainedHostCommands: true,
        pin: "246810",
      });
    });
  });

  test("drops an ordinary change when that authority is revoked before PIN submission", async () => {
    reapplyHappyDomGlobals();
    const view = render(
      <PostureEditModal
        posture={posture}
        canManageServerSecurity
        canManageUncontainedHostCommands
        onClose={() => undefined}
        onUpdated={async () => undefined}
      />,
    );

    fireEvent.change(view.getByLabelText("Security level"), { target: { value: "permissive" } });
    view.rerender(
      <PostureEditModal
        posture={posture}
        canManageServerSecurity={false}
        canManageUncontainedHostCommands
        onClose={() => undefined}
        onUpdated={async () => undefined}
      />,
    );
    fireEvent.click(view.getByLabelText("Allow uncontained host commands"));
    fireEvent.click(view.getByRole("button", { name: "Confirm with PIN" }));
    fireEvent.click(view.getByRole("button", { name: "Submit test PIN" }));

    await waitFor(() => {
      expect(updateSecurityPosture).toHaveBeenCalledWith({
        allowUncontainedHostCommands: true,
        pin: "246810",
      });
    });
  });

  test("sends only false and the PIN when disabling the policy", async () => {
    reapplyHappyDomGlobals();
    const view = render(
      <PostureEditModal
        posture={{ ...posture, allowUncontainedHostCommands: true }}
        canManageServerSecurity={false}
        canManageUncontainedHostCommands
        onClose={() => undefined}
        onUpdated={async () => undefined}
      />,
    );

    fireEvent.click(view.getByLabelText("Allow uncontained host commands"));
    fireEvent.click(view.getByRole("button", { name: "Confirm with PIN" }));
    fireEvent.click(view.getByRole("button", { name: "Submit test PIN" }));

    await waitFor(() => {
      expect(updateSecurityPosture).toHaveBeenCalledWith({
        allowUncontainedHostCommands: false,
        pin: "246810",
      });
    });
  });
});
