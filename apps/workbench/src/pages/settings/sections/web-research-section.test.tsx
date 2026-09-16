import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

let capabilities = ["read_server_settings"];

mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: true } }),
}));

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (capability: string) => capabilities.includes(capability),
}));

mock.module("../../../lib/api", () => ({
  apiClient: {
    getResearchProvider: async () => ({
      provider: "auto",
      tavilyConfigured: true,
    }),
  },
}));

const { WebResearchSection } = await import("./web-research-section");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  capabilities = ["read_server_settings"];
});

describe("WebResearchSection server-policy boundary", () => {
  test("shows server policy without caller-scoped Desktop status", async () => {
    const view = render(<WebResearchSection />);

    await waitFor(() => expect(view.getByText(/Tavily credential/)).toBeTruthy());
    expect(view.getByText(/Connected-Desktop reader and keyless-search availability is personal/i)).toBeTruthy();
    expect(view.queryByText("Anonymous page reader")).toBeNull();
  });

  test("is read-only without manage_server_operations", async () => {
    const view = render(<WebResearchSection />);

    await waitFor(() => expect(view.getByText(/Read-only/i)).toBeTruthy());
    expect(view.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
