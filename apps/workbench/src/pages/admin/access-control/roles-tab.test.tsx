import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

const catalogue = {
  capabilities: [
    { slug: "use_terminal", description: "", category: "tools" },
    { slug: "manage_server_security", description: "", category: "security" },
    { slug: "invoke_other_agents", description: "", category: "agents" },
    { slug: "use_personal_provider_credentials", description: "", category: "providers" },
    { slug: "use_server_provider_credentials", description: "", category: "providers" },
  ],
  roles: [
    { id: "system", slug: "member", label: "Member", isSystem: true, capabilitySlugs: ["use_terminal"], groupCount: 1 },
    { id: "community", slug: "community", label: "Community", isSystem: true, capabilitySlugs: ["use_personal_provider_credentials"], groupCount: 1 },
    { id: "custom", slug: "mobile-dev", label: "Mobile development", isSystem: false, capabilitySlugs: ["use_terminal"], groupCount: 0 },
  ], groups: [],
};
let loadedCatalogue: typeof catalogue | null = catalogue;
const refresh = mock(async () => undefined);

mock.module("./access-control-context", () => ({
  useAccessControl: () => ({
    loading: false, error: null, canDelegate: (capability: string) => capability === "use_terminal",
    catalogue: loadedCatalogue, refresh,
  }),
}));
const { RolesTab } = await import("./roles-tab");
afterEach(() => { cleanup(); loadedCatalogue = catalogue; refresh.mockReset(); refresh.mockResolvedValue(undefined); });

describe("RolesTab", () => {
  test("keeps system roles protected and uses checkbox-only capability selection", () => {
    reapplyHappyDomGlobals();
    const review = mock(() => undefined);
    const view = render(<RolesTab onReview={review} />);
    fireEvent.click(view.getByText("Member"));
    expect(view.getByText(/Protected built-in Permission set/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "New custom Permission set" }));
    expect(view.getByText(/free-text permissions are not supported/)).toBeTruthy();
    expect(view.getByRole("checkbox", { name: /use_terminal/ })).toBeTruthy();
    expect(view.getByRole("checkbox", { name: /manage_server_security/ }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("checkbox", { name: /invoke_other_agents/ })).toBeTruthy();
    expect(view.getByRole("checkbox", { name: /use_personal_provider_credentials/ })).toBeTruthy();
    expect(view.getByRole("checkbox", { name: /use_server_provider_credentials/ })).toBeTruthy();
  });

  test("shows Community as a protected built-in Permission set", () => {
    reapplyHappyDomGlobals();
    const view = render(<RolesTab onReview={() => undefined} />);
    fireEvent.click(view.getByText("Community"));
    expect(view.getByText(/Protected built-in Permission set/)).toBeTruthy();
    expect(view.getAllByText("use_personal_provider_credentials")).toHaveLength(2);
  });

  test("hydrates a custom role editor from its current bundle", () => {
    reapplyHappyDomGlobals();
    const view = render(<RolesTab onReview={() => undefined} />);
    fireEvent.click(view.getByText("Mobile development"));
    expect(view.getByDisplayValue("Mobile development")).toBeTruthy();
    expect((view.getByRole("checkbox", { name: /use_terminal/ }) as HTMLInputElement).checked).toBe(true);
  });

  test("refreshes the catalogue when opened without eager data", () => {
    reapplyHappyDomGlobals();
    loadedCatalogue = null;
    render(<RolesTab onReview={() => undefined} />);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
