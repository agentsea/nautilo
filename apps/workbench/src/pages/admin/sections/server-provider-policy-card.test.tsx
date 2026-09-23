import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CapabilitySlug } from "@nautilo/types";

let capabilities = new Set<CapabilitySlug>();
let persisted = false;
let failNextSave = false;
let pendingSave: Promise<{ allowPersonalProviderKeys: boolean }> | null = null;
const getPolicy = mock(async () => ({ allowPersonalProviderKeys: persisted }));
const setPolicy = mock(async (input: { allowPersonalProviderKeys: boolean }) => {
  if (pendingSave !== null) return pendingSave;
  if (failNextSave) {
    failNextSave = false;
    throw new Error("Policy save failed");
  }
  persisted = input.allowPersonalProviderKeys;
  return { allowPersonalProviderKeys: persisted };
});

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (capability: CapabilitySlug) => capabilities.has(capability),
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    admin: {
      serverProviderPolicy: {
        get: getPolicy,
        set: setPolicy,
      },
    },
  },
}));

const { ServerProviderPolicyCard } = await import("./server-provider-policy-card");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  capabilities = new Set(["read_server_settings"]);
  persisted = false;
  failNextSave = false;
  pendingSave = null;
  getPolicy.mockClear();
  setPolicy.mockClear();
});

describe("ServerProviderPolicyCard", () => {
  test("lets a settings reader inspect the persisted state without editing", async () => {
    const view = render(<ServerProviderPolicyCard />);

    await waitFor(() => {
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("Off");
    });
    expect(getPolicy).toHaveBeenCalledTimes(1);
    expect(view.getByRole("switch").hasAttribute("disabled")).toBe(true);
    expect(view.queryByRole("button", { name: "Save personal provider policy" })).toBeNull();
    expect(view.getByText(/manage server settings permission is required/u)).toBeTruthy();
  });

  test("saves off to on and reports the persisted result", async () => {
    capabilities.add("manage_server_settings");
    const view = render(<ServerProviderPolicyCard />);
    const toggle = await waitFor(() => view.getByRole("switch"));

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("Off");
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      expect(setPolicy).toHaveBeenCalledWith({ allowPersonalProviderKeys: true });
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("On");
      expect(view.getByRole("status").textContent).toContain("allowed");
    });
  });

  test("saves on to off", async () => {
    capabilities.add("manage_server_settings");
    persisted = true;
    const view = render(<ServerProviderPolicyCard />);
    const toggle = await waitFor(() => view.getByRole("switch"));

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      expect(setPolicy).toHaveBeenCalledWith({ allowPersonalProviderKeys: false });
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("Off");
    });
  });

  test("retains persisted state after failure and supports a retry", async () => {
    capabilities.add("manage_server_settings");
    failNextSave = true;
    const view = render(<ServerProviderPolicyCard />);
    const toggle = await waitFor(() => view.getByRole("switch"));

    fireEvent.click(toggle);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("Policy save failed");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("Off");
    });

    fireEvent.click(toggle);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));
    await waitFor(() => {
      expect(setPolicy).toHaveBeenCalledTimes(2);
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("On");
    });
  });

  test("shows pending state until the server confirms the saved value", async () => {
    capabilities.add("manage_server_settings");
    let resolveSave: ((value: { allowPersonalProviderKeys: boolean }) => void) | undefined;
    pendingSave = new Promise((resolve) => {
      resolveSave = resolve;
    });
    const view = render(<ServerProviderPolicyCard />);
    const toggle = await waitFor(() => view.getByRole("switch"));

    fireEvent.click(toggle);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      const saveButton = view.getByRole("button", { name: "Save personal provider policy" });
      expect(saveButton.getAttribute("aria-busy")).toBe("true");
      expect(saveButton.hasAttribute("disabled")).toBe(true);
      expect(toggle.hasAttribute("disabled")).toBe(true);
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("Off");
    });

    resolveSave?.({ allowPersonalProviderKeys: true });
    await waitFor(() => {
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("On");
    });
  });

  test("does not render or fetch without read authority", () => {
    capabilities.clear();
    const view = render(<ServerProviderPolicyCard />);
    expect(view.queryByTestId("server-provider-policy-card")).toBeNull();
    expect(getPolicy).not.toHaveBeenCalled();
  });
});
