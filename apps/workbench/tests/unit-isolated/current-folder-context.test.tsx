import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { readFileContext, setCurrentFolder } from "../../src/adapters/file-context-ref";

type Context = { currentFolder: string | null; relayId: string | null };
let pending: Array<(context: Context) => void>;
let changed: ((path: string | null) => void) | undefined;
const getContext = mock(() => new Promise<Context>((resolve) => pending.push(resolve)));
mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    currentFolder: {
      getContext,
      onPathChanged: (listener: typeof changed) => {
        changed = listener;
        return () => { changed = undefined; };
      },
    },
  },
}));
const { BrowserColumnProvider, useBrowserColumn } = await import("../../src/components/browser-column/browser-column.context");
let select: (path: string | null) => void;
function Probe() {
  const context = useBrowserColumn();
  select = context.setCurrentFolderPath;
  return <span data-testid="folder">{context.currentFolderPath}</span>;
}
beforeEach(() => {
  reapplyHappyDomGlobals();
  localStorage.clear();
  pending = [];
  setCurrentFolder(null);
});
afterEach(cleanup);

test("a late startup reply cannot overwrite a newer native folder selection", async () => {
  const view = render(<BrowserColumnProvider><Probe /></BrowserColumnProvider>);
  const startup = pending.shift()!;
  act(() => { changed!("/projects/new"); });
  await act(async () => { startup({ currentFolder: "/projects/old", relayId: "desktop" }); });
  expect(view.getByTestId("folder").textContent).toBe("/projects/new");
  expect(readFileContext().currentFolder).toBe("/projects/new");
  expect(readFileContext().currentFolderRelayId).toBe("desktop");
});

test("folder changes reach the next outgoing message before React effects run", async () => {
  render(<BrowserColumnProvider><Probe /></BrowserColumnProvider>);
  await act(async () => { pending.shift()!({ currentFolder: "/projects/old", relayId: "desktop" }); });
  act(() => {
    changed!("/projects/new");
    expect(readFileContext()).toMatchObject({ currentFolder: "/projects/new", currentFolderRelayId: "desktop" });
  });
});

test("a dropdown commit survives a delayed startup reply", async () => {
  const view = render(<BrowserColumnProvider><Probe /></BrowserColumnProvider>);
  const startup = pending.shift()!;
  act(() => { select("/projects/selected"); });
  await act(async () => { startup({ currentFolder: "/projects/old", relayId: "desktop" }); });
  expect(view.getByTestId("folder").textContent).toBe("/projects/selected");
  expect(readFileContext().currentFolder).toBe("/projects/selected");
});

test("returning to an earlier folder still wins over an intervening startup snapshot", async () => {
  const view = render(<BrowserColumnProvider><Probe /></BrowserColumnProvider>);
  const startup = pending.shift()!;
  act(() => {
    changed!("/projects/first");
    changed!("/projects/second");
    select("/projects/first");
  });
  await act(async () => { startup({ currentFolder: "/projects/second", relayId: "desktop" }); });
  expect(view.getByTestId("folder").textContent).toBe("/projects/first");
  expect(readFileContext()).toMatchObject({ currentFolder: "/projects/first", currentFolderRelayId: "desktop" });
});

test("an unmounted provider cannot overwrite the next connection's folder", async () => {
  const old = render(<BrowserColumnProvider><Probe /></BrowserColumnProvider>);
  const stale = pending.shift()!;
  old.unmount();
  render(<BrowserColumnProvider><Probe /></BrowserColumnProvider>);
  await act(async () => { pending.shift()!({ currentFolder: "/projects/current", relayId: "desktop" }); });
  await act(async () => { stale({ currentFolder: "/projects/old", relayId: "old-desktop" }); });
  expect(readFileContext()).toMatchObject({ currentFolder: "/projects/current", currentFolderRelayId: "desktop" });
});
