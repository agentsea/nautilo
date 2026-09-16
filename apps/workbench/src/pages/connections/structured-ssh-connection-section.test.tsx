import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { cleanup, fireEvent, render as renderTesting, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ManagedSshConnection } from "./structured-ssh-connection-section";

const realUseAuth = await import("../../hooks/use-auth");
mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionUserId: "ssh-test-viewer", userIdentity: null } }),
}));
const { StructuredSshConnectionSection } = await import("./structured-ssh-connection-section");

function SshRevealProbe({ connection }: { connection: ManagedSshConnection }) {
  const navigate = useNavigate();
  return <><button type="button" onClick={() => void navigate("/connections#ssh")}>Reveal SSH</button><StructuredSshConnectionSection connection={connection} /></>;
}

function render(ui: ReactElement) {
  return renderTesting(<MemoryRouter initialEntries={["/connections"]}>{ui}</MemoryRouter>);
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  localStorage.clear();
  window.location.hash = "";
});

afterAll(() => { mock.module("../../hooks/use-auth", () => realUseAuth); cleanup(); });

describe("SSH access for Genie", () => {
  test("reveals and focuses the SSH card once for a raw hash navigation", async () => {
    const connection: ManagedSshConnection = {
      status: async () => ({ state: "not-enabled", reason: null, enabledTools: [] }),
      enable: async () => undefined,
      disable: async () => undefined,
    };
    const view = render(<SshRevealProbe connection={connection} />);
    const section = view.getByTestId("structured-ssh-connection");
    const scrollIntoView = mock(() => undefined);
    const focus = mock(() => undefined);
    Object.defineProperties(section, {
      scrollIntoView: { configurable: true, value: scrollIntoView },
      focus: { configurable: true, value: focus },
    });

    fireEvent.click(view.getByRole("button", { name: "Reveal SSH" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test("turns on through one cancellable PIN prompt without creating setup work", async () => {
    let enabled = false;
    const enable = mock(async (_pin: string) => { enabled = true; });
    const connection: ManagedSshConnection = {
      status: async () => ({ state: enabled ? "enabled" : "not-enabled", reason: null, enabledTools: [] }),
      enable,
      disable: async () => undefined,
    };
    const view = render(<StructuredSshConnectionSection connection={connection} />);

    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Turn on SSH access for Genie" }));
    expect(view.getByRole("heading", { name: "Turn on SSH access" })).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Cancel" })).toHaveLength(2);
    const pinInput = view.getByPlaceholderText("••••••") as HTMLInputElement;
    const user = userEvent.setup({ document: globalThis.document });
    await user.type(pinInput, "847291");
    await waitFor(() => expect(pinInput.value).toBe("847291"));
    fireEvent.click(view.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(enable).toHaveBeenCalledWith("847291"));
    await waitFor(() => expect(view.getByText("On")).toBeTruthy());
    expect(view.queryByText("Turn on SSH access")).toBeNull();
    expect(view.container.textContent).not.toContain("Set up with Genie");
    expect(view.container.textContent).not.toContain("Check");
  });

  test("cancel returns to the unchanged row", async () => {
    const connection: ManagedSshConnection = {
      status: async () => ({ state: "not-enabled", reason: null, enabledTools: [] }),
      enable: async () => undefined,
      disable: async () => undefined,
    };
    const view = render(<StructuredSshConnectionSection connection={connection} />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.click(view.getByRole("switch"));
    fireEvent.click(view.getAllByRole("button", { name: "Cancel" })[1]!);
    expect(view.queryByText("Turn on SSH access")).toBeNull();
    expect(view.getByText("Off")).toBeTruthy();
  });

  test("turning off revokes immediately without PIN", async () => {
    let enabled = true;
    const disable = mock(async () => { enabled = false; });
    const connection: ManagedSshConnection = {
      status: async () => ({ state: enabled ? "enabled" : "not-enabled", reason: null, enabledTools: [] }),
      enable: async () => undefined,
      disable,
    };
    const view = render(<StructuredSshConnectionSection connection={connection} />);
    await waitFor(() => expect(view.getByText("On")).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Turn off SSH access for Genie" }));
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    expect(view.queryByText("Turn on SSH access")).toBeNull();
  });
});
