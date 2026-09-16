import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

let grants: Array<Record<string, unknown>> = [];
let listResult: { ok: true; data: { grants: Array<Record<string, unknown>>; revision: number } } | {
  ok: false;
  message: string;
} = { ok: true, data: { grants, revision: 1 } };

const list = mock(async () => listResult);
const pick = mock(async () => null);
const validate = mock(async () => ({ ok: true as const, data: {} }));
const create = mock(async () => ({ ok: true as const, data: {} }));
const revoke = mock(async () => ({ ok: true as const, data: {} }));
const listRecent = mock(async () => []);
const setPath = mock(async () => undefined);
const pickAndCommit = mock(async () => null);

mock.module("../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    desktopFilesystemGrants: { list, pick, validate, create, revoke },
    currentFolder: { listRecent, setPath, pickAndCommit },
  },
}));

mock.module("./browser-column.context", () => ({
  useBrowserColumn: () => ({
    currentFolderPath: "/Users/alice/project",
    setCurrentFolderPath: mock(),
  }),
}));

const { CurrentFolderHeader } = await import("./current-folder-header");

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.hash}`}</output>;
}

function renderHeader(isDesktopShell = true) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <CurrentFolderHeader isDesktopShell={isDesktopShell} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  grants = [];
  listResult = { ok: true, data: { grants, revision: 1 } };
  list.mockClear();
  pick.mockClear();
  validate.mockClear();
  create.mockClear();
  revoke.mockClear();
  listRecent.mockClear();
  setPath.mockClear();
  pickAndCommit.mockClear();
});

afterAll(() => {
  mock.restore();
});

describe("CurrentFolderHeader Desktop file access shortcut", () => {
  test("shows active desktop grants and only reads their status", async () => {
    grants = [{ status: "active" }, { status: "revoked" }, { status: "active" }];
    listResult = { ok: true, data: { grants, revision: 1 } };
    const view = renderHeader();

    fireEvent.click(view.getByRole("button", { name: /project/i }));

    await waitFor(() => {
      expect(view.getByText("2 active")).toBeTruthy();
    });
    expect(view.getByRole("menuitem", { name: /Desktop file access/i })).toBeTruthy();
    expect(pick).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  test("reports an unknown status when the grant list cannot load", async () => {
    listResult = { ok: false, message: "bridge failed" };
    const view = renderHeader();

    fireEvent.click(view.getByRole("button", { name: /project/i }));

    await waitFor(() => {
      expect(view.getByText("Status unknown")).toBeTruthy();
    });
  });

  test("navigates to Settings and closes after Manage access", async () => {
    const view = renderHeader();

    fireEvent.click(view.getByRole("button", { name: /project/i }));
    fireEvent.click(view.getByRole("menuitem", { name: "Manage access…" }));

    expect(view.getByTestId("location").textContent).toBe("/settings");
    expect(view.queryByRole("menu", { name: "Current folder" })).toBeNull();
  });

  test("omits the folder header and access shortcut on web", () => {
    const view = renderHeader(false);

    expect(view.queryByRole("button", { name: /project/i })).toBeNull();
    expect(view.queryByText("Desktop file access")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
