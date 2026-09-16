import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const realUseAuth = await import("../../hooks/use-auth");
const realDesktop = await import("../../lib/desktop");
const status = mock(async () => ({ installed: true, authenticated: false, login: null, version: "2.0" }));
const connect = mock(async () => ({ url: "https://github.com/login/device", code: "ABCD-EFGH" }));

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionUserId: "github-test-viewer", userIdentity: null } }),
}));
mock.module("../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: { githubCli: { status, connect, openDevicePage: async () => undefined } },
}));

const { GitHubCliConnectionSection } = await import("./github-cli-connection-section");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  localStorage.clear();
  status.mockClear();
  connect.mockClear();
});

afterAll(() => {
  mock.module("../../hooks/use-auth", () => realUseAuth);
  mock.module("../../lib/desktop", () => realDesktop);
  cleanup();
});

describe("GitHub CLI connection", () => {
  test("keeps device login mounted but reveals it while the active flow is running", async () => {
    const view = render(<GitHubCliConnectionSection />);
    await waitFor(() => expect(view.getByRole("button", { name: "Collapse" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Collapse" }));
    expect(view.getByRole("button", { name: "Expand" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Sign in to GitHub" }));
    await waitFor(() => expect(view.getByText("ABCD-EFGH")).toBeTruthy());
    expect(view.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("ABCD-EFGH").closest("div")?.parentElement?.parentElement).toBeTruthy();
  });
});
