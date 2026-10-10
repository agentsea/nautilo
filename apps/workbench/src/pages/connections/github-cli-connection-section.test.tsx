import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const realUseAuth = await import("../../hooks/use-auth");
const realDesktop = await import("../../lib/desktop");
let currentStatus = { installed: true, authenticated: false, login: null as string | null, version: "2.0" as string | null };
const status = mock(async () => currentStatus);
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
  currentStatus = { installed: true, authenticated: false, login: null, version: "2.0" };
});

afterAll(() => {
  mock.module("../../hooks/use-auth", () => realUseAuth);
  mock.module("../../lib/desktop", () => realDesktop);
  cleanup();
});

describe("GitHub CLI connection", () => {
  test("describes ordinary authenticated commands under approved Development access", async () => {
    const view = render(<GitHubCliConnectionSection />);
    await view.findByRole("heading", { name: "GitHub account" });
    expect(view.getByText(/Sign in to GitHub CLI for ordinary Git and GitHub work/)).toBeTruthy();
    expect(view.getByText(/After you approve the current Development profile/)).toBeTruthy();
    expect(view.container.textContent).toContain("gh auth status");
    expect(view.container.textContent).not.toContain("cannot read GitHub CLI credentials");
    expect(view.container.textContent).not.toContain("Full host");
    expect(view.container.textContent).not.toContain("normal host configuration");
  });

  test("reports an unavailable managed runtime without telling the Human to install host gh", async () => {
    currentStatus = { installed: false, authenticated: false, login: null, version: null };
    const view = render(<GitHubCliConnectionSection />);
    await view.findByText("Unavailable");
    expect(view.getByText(/built-in GitHub support is unavailable/)).toBeTruthy();
    expect(view.container.textContent).not.toContain("Install the official GitHub CLI");
    expect(view.container.textContent).not.toContain("~/.config/gh");
  });

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
