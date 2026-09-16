import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";
import { useCallback, useRef, useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { isFullWidthManagementRoute } from "../../src/layouts/is-full-width-management-route";
import { useMiniAppRouteGuard } from "../../src/layouts/use-mini-app-route-guard";

function Harness({ initiallyDirty = true }: { initiallyDirty?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const dirty = useRef(initiallyDirty);
  const pending = useRef<{ leave: () => void; stay?: () => void } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const requestLeave = useCallback((leave: () => void, stay?: () => void) => {
    if (!dirty.current) {
      leave();
      return;
    }
    pending.current = { leave, stay };
    setConfirming(true);
  }, []);
  const waiting = useMiniAppRouteGuard(true, requestLeave);
  const management = isFullWidthManagementRoute(location.pathname);
  const showEditor = !management || waiting;

  return <>
    <div data-testid="path">{location.pathname}</div>
    <button onClick={() => { void navigate("/settings"); }}>Settings</button>
    <button onClick={() => { void navigate("/help"); }}>Help</button>
    <button onClick={() => { void navigate(-1); }}>Back</button>
    <button onClick={() => { void navigate(1); }}>Forward</button>
    <button onClick={() => { dirty.current = false; }}>Mark clean</button>
    {showEditor ? <textarea data-testid="editor" defaultValue="unfinished formula" /> : <div>Settings page</div>}
    {confirming ? <div role="alertdialog">
      <button onClick={() => {
        const stay = pending.current?.stay;
        pending.current = null;
        setConfirming(false);
        stay?.();
      }}>Keep editing</button>
      <button onClick={() => {
        const leave = pending.current?.leave;
        pending.current = null;
        setConfirming(false);
        leave?.();
      }}>Discard and leave</button>
    </div> : null}
  </>;
}

function setup(initiallyDirty = true) {
  return render(<MemoryRouter initialEntries={["/"]}><Harness initiallyDirty={initiallyDirty} /></MemoryRouter>);
}

beforeEach(() => reapplyHappyDomGlobals());

describe("mini-app management route guard", () => {
  test("keeps the same dirty editor mounted and Keep editing restores its route", async () => {
    const view = setup();
    const editor = view.getByTestId("editor");
    fireEvent.input(editor, { target: { value: "=999" } });

    fireEvent.click(view.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(view.getByRole("alertdialog")).toBeTruthy());
    expect(view.getByTestId("editor")).toBe(editor);
    expect((view.getByTestId("editor") as HTMLTextAreaElement).value).toBe("=999");

    fireEvent.click(view.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(view.getByTestId("path").textContent).toBe("/"));
    expect(view.getByTestId("editor")).toBe(editor);
  });

  test("discard unmounts the editor while a clean route change proceeds directly", async () => {
    const dirtyView = setup();
    fireEvent.click(dirtyView.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(dirtyView.getByRole("alertdialog")).toBeTruthy());
    fireEvent.click(dirtyView.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(dirtyView.queryByTestId("editor")).toBeNull());
    expect(dirtyView.getByText("Settings page")).toBeTruthy();
    dirtyView.unmount();

    const cleanView = setup(false);
    fireEvent.click(cleanView.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(cleanView.queryByTestId("editor")).toBeNull());
    expect(cleanView.queryByRole("alertdialog")).toBeNull();
  });

  test("a previously accepted history entry requires a fresh decision after returning", async () => {
    const view = setup();
    fireEvent.click(view.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(view.getByRole("alertdialog")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(view.queryByTestId("editor")).toBeNull());

    fireEvent.click(view.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(view.getByTestId("path").textContent).toBe("/"));
    expect(view.getByTestId("editor")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(view.getByRole("alertdialog")).toBeTruthy());
    expect(view.getByTestId("editor")).toBeTruthy();
  });

  test("a rapid second route replaces stale callbacks without releasing the wrong destination", async () => {
    const view = setup();
    const editor = view.getByTestId("editor");

    fireEvent.click(view.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(view.getByRole("alertdialog")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Help" }));
    await waitFor(() => expect(view.getByTestId("path").textContent).toBe("/help"));
    expect(view.getByTestId("editor")).toBe(editor);

    fireEvent.click(view.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(view.getByTestId("path").textContent).toBe("/"));
    expect(view.getByTestId("editor")).toBe(editor);

    fireEvent.click(view.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(view.getByTestId("path").textContent).toBe("/settings"));
    await waitFor(() => expect(view.getByRole("alertdialog")).toBeTruthy());
    expect(view.getByTestId("editor")).toBe(editor);
  });
});
