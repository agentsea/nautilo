import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { CapabilitySlug } from "@nautilo/types";

let capabilities = new Set<CapabilitySlug>();
type FundingPreference = "personal_first" | "server_first";
type Policy = {
  allowPersonalProviderKeys: boolean;
  fundingPreference: FundingPreference;
};
type PolicyPatch = Partial<Policy>;

let persisted: Policy = {
  allowPersonalProviderKeys: false,
  fundingPreference: "personal_first",
};
let failNextSave = false;
let commitThenFailNextSave = false;
let failNextGet = false;
let pendingSave: Promise<Policy> | null = null;
const getPolicy = mock(async () => {
  if (failNextGet) {
    failNextGet = false;
    throw new Error("Policy refresh failed");
  }
  return { ...persisted };
});
const setPolicy = mock(async (input: PolicyPatch) => {
  if (pendingSave !== null) return pendingSave;
  if (commitThenFailNextSave) {
    commitThenFailNextSave = false;
    persisted = { ...persisted, ...input };
    throw new Error("Policy save response was lost");
  }
  if (failNextSave) {
    failNextSave = false;
    throw new Error("Policy save failed");
  }
  persisted = { ...persisted, ...input };
  return { ...persisted };
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
  persisted = {
    allowPersonalProviderKeys: false,
    fundingPreference: "personal_first",
  };
  failNextSave = false;
  commitThenFailNextSave = false;
  failNextGet = false;
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
    expect(view.queryByRole("group", { name: "Funding priority" })).toBeNull();
    expect(view.queryByRole("button", { name: "Save personal provider policy" })).toBeNull();
    expect(view.getByText(/manage server settings permission is required/u)).toBeTruthy();
  });

  test("saves off to on and reports the persisted result", async () => {
    capabilities.add("manage_server_settings");
    let policyEvents = 0;
    const onPolicyChanged = () => { policyEvents++; };
    window.addEventListener("nautilo:personal-provider-policy-changed", onPolicyChanged);
    const view = render(<ServerProviderPolicyCard />);
    const toggle = await waitFor(() => view.getByRole("switch"));

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("Off");
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      expect(setPolicy).toHaveBeenCalledWith({ allowPersonalProviderKeys: true });
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("On");
      expect(view.getByRole("status").textContent).toContain("saved");
    });
    expect(policyEvents).toBe(1);
    expect(view.getByText(/supported private text chat/u)).toBeTruthy();
    expect(view.queryByText(/not available in this release/u)).toBeNull();
    window.removeEventListener("nautilo:personal-provider-policy-changed", onPolicyChanged);
  });

  test("saves on to off", async () => {
    capabilities.add("manage_server_settings");
    persisted.allowPersonalProviderKeys = true;
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

  test("retains a changed priority while hiding it when the draft is off", async () => {
    capabilities.add("manage_server_settings");
    const view = render(<ServerProviderPolicyCard />);
    const toggle = await waitFor(() => view.getByRole("switch"));
    expect(view.queryByRole("group", { name: "Funding priority" })).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(view.getByRole("radio", { name: "Server keys first" }));
    fireEvent.click(toggle);
    expect(view.queryByRole("group", { name: "Funding priority" })).toBeNull();
    fireEvent.click(toggle);
    expect((view.getByRole("radio", { name: "Server keys first" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith({
      allowPersonalProviderKeys: true,
      fundingPreference: "server_first",
    }));
  });

  test("loads the saved funding priority", async () => {
    persisted.allowPersonalProviderKeys = true;
    persisted.fundingPreference = "server_first";
    const view = render(<ServerProviderPolicyCard />);

    await waitFor(() => {
      expect((view.getByRole("radio", {
        name: "Server keys first",
      }) as HTMLInputElement).checked).toBe(true);
      expect(view.getByTestId("server-provider-policy-funding-persisted").textContent)
        .toContain("Server keys first");
    });
  });

  test("saves both changed fields together without replacing other policy values", async () => {
    capabilities.add("manage_server_settings");
    const view = render(<ServerProviderPolicyCard />);
    const toggle = await waitFor(() => view.getByRole("switch"));

    fireEvent.click(toggle);
    fireEvent.click(view.getByRole("radio", { name: "Server keys first" }));
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      expect(setPolicy).toHaveBeenCalledWith({
        allowPersonalProviderKeys: true,
        fundingPreference: "server_first",
      });
    });
  });

  test("retains the confirmed server state after a rejected save and supports a retry", async () => {
    capabilities.add("manage_server_settings");
    failNextSave = true;
    const view = render(<ServerProviderPolicyCard />);
    const toggle = await waitFor(() => view.getByRole("switch"));

    fireEvent.click(toggle);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("Policy save failed");
      expect(view.getByRole("alert").textContent).toContain("current server policy was refreshed");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("Off");
    });
    expect(getPolicy).toHaveBeenCalledTimes(2);

    fireEvent.click(toggle);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));
    await waitFor(() => {
      expect(setPolicy).toHaveBeenCalledTimes(2);
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("On");
    });
  });

  test("reconciles a committed save whose response was lost and dispatches the policy event", async () => {
    capabilities.add("manage_server_settings");
    commitThenFailNextSave = true;
    let policyEvents = 0;
    const onPolicyChanged = () => { policyEvents++; };
    window.addEventListener("nautilo:personal-provider-policy-changed", onPolicyChanged);
    persisted.allowPersonalProviderKeys = true;
    const view = render(<ServerProviderPolicyCard />);
    const serverFirst = await waitFor(() =>
      view.getByRole("radio", { name: "Server keys first" }),
    );

    fireEvent.click(serverFirst);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      expect(getPolicy).toHaveBeenCalledTimes(2);
      expect(view.getByRole("alert").textContent).toContain("save response was lost");
      expect(view.getByRole("alert").textContent).toContain("current server policy was refreshed");
      expect(view.getByTestId("server-provider-policy-funding-persisted").textContent)
        .toContain("Server keys first");
      expect((serverFirst as HTMLInputElement).checked).toBe(true);
    });
    expect(policyEvents).toBe(1);
    expect(view.queryByText("Unsaved selection")).toBeNull();
    window.removeEventListener("nautilo:personal-provider-policy-changed", onPolicyChanged);
  });

  test("marks policy state unknown after a committed save and failed reconciliation, then recovers by refresh", async () => {
    capabilities.add("manage_server_settings");
    commitThenFailNextSave = true;
    let policyEvents = 0;
    const onPolicyChanged = () => { policyEvents++; };
    window.addEventListener("nautilo:personal-provider-policy-changed", onPolicyChanged);
    persisted.allowPersonalProviderKeys = true;
    const view = render(<ServerProviderPolicyCard />);
    const serverFirst = await waitFor(() =>
      view.getByRole("radio", { name: "Server keys first" }),
    );
    failNextGet = true;

    fireEvent.click(serverFirst);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    const refresh = await waitFor(() => view.getByRole("button", { name: "Refresh server policy" }));
    expect(view.getByRole("alert").textContent).toContain("Policy refresh failed");
    expect(view.getByRole("alert").textContent).toContain("before editing or saving again");
    expect(view.getByTestId("server-provider-policy-funding-persisted").textContent)
      .toContain("Last confirmed priority");
    expect(view.getByTestId("server-provider-policy-persisted").textContent)
      .toContain("Last confirmed server policy");
    expect(view.queryByText(/Current saved priority/u)).toBeNull();
    expect(view.queryByText("Unsaved selection")).toBeNull();
    expect(view.queryByText(/has no effect until personal keys are enabled/u)).toBeNull();
    expect(view.getByRole("group", { name: "Funding priority" }).hasAttribute("disabled"))
      .toBe(true);
    expect(view.queryByRole("button", { name: "Save personal provider policy" })).toBeNull();
    expect(policyEvents).toBe(0);

    fireEvent.click(refresh);
    await waitFor(() => {
      expect(getPolicy).toHaveBeenCalledTimes(3);
      expect(view.getByTestId("server-provider-policy-funding-persisted").textContent)
        .toContain("Current saved priority: Server keys first");
      expect(view.queryByRole("button", { name: "Refresh server policy" })).toBeNull();
      expect(view.queryByRole("alert")).toBeNull();
    });
    expect(setPolicy).toHaveBeenCalledTimes(1);
    expect(policyEvents).toBe(1);
    expect(view.getByRole("group", { name: "Funding priority" }).hasAttribute("disabled"))
      .toBe(false);
    window.removeEventListener("nautilo:personal-provider-policy-changed", onPolicyChanged);
  });

  test("reverts a failed priority save to the current server value", async () => {
    capabilities.add("manage_server_settings");
    failNextSave = true;
    persisted.allowPersonalProviderKeys = true;
    const view = render(<ServerProviderPolicyCard />);
    const serverFirst = await waitFor(() =>
      view.getByRole("radio", { name: "Server keys first" }),
    );

    fireEvent.click(serverFirst);
    fireEvent.click(view.getByRole("button", { name: "Save personal provider policy" }));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("Policy save failed");
      expect((view.getByRole("radio", {
        name: "Personal keys first",
      }) as HTMLInputElement).checked).toBe(true);
      expect((serverFirst as HTMLInputElement).checked).toBe(false);
      expect(view.queryByText("Unsaved selection")).toBeNull();
    });
  });

  test("shows pending state until the server confirms the saved value", async () => {
    capabilities.add("manage_server_settings");
    let resolveSave: ((value: Policy) => void) | undefined;
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
      expect(view.getByRole("group", { name: "Funding priority" }).hasAttribute("disabled"))
        .toBe(true);
      expect(view.getByTestId("server-provider-policy-persisted").textContent).toContain("Off");
    });

    resolveSave?.({
      allowPersonalProviderKeys: true,
      fundingPreference: "personal_first",
    });
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
