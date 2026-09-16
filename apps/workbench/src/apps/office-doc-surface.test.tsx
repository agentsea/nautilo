import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

const getOfficeEditorUrl = mock(
  async (): Promise<{ editorUrl: string | null }> => ({
    editorUrl: "http://office.localhost/office-engine/cool.html?WOPISrc=doc",
  }),
);

mock.module("../lib/api", () => ({
  apiClient: {
    getOfficeEditorUrl,
  },
}));

const { OfficeDocSurface } = await import("./office-doc-surface");
const {
  reduceCommandState,
  subscribeBackgroundSave,
  subscribePresentationState,
} = await import("./office-ribbon");
const { CalcCellsGroup, CalcDataGroup } = await import("./office-calc-groups");
const { ImpressInsertGroup, ImpressPresentGroup } = await import("./office-impress-groups");
const { clearActiveMiniApp, readActiveMiniApp } = await import("../adapters/mini-app-context-ref");

beforeEach(() => {
  reapplyHappyDomGlobals();
  clearActiveMiniApp();
  getOfficeEditorUrl.mockClear();
});

describe("OfficeDocSurface — engine-down graceful degradation (M201 P5)", () => {
  test("shows a clear 'office engine unavailable' state (not a blank iframe) when editorUrl is null", async () => {
    // Engine unreachable → server returns editorUrl:null (wopi.ts degrades
    // gracefully). The surface must show the unavailable message, NOT a blank
    // iframe or an infinite spinner.
    getOfficeEditorUrl.mockImplementationOnce(async () => ({ editorUrl: null }));
    const utils = render(
      <OfficeDocSurface
        artifactId="artifact-1"
        displayName="sample.docx"
        documentPath="docs/sample.docx"
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(utils.getByText("Couldn’t open this document")).toBeTruthy();
    });
    expect(utils.getByText(/office engine is unavailable/i)).toBeTruthy();
    // No editor iframe is mounted in the degraded state.
    expect(utils.queryByTestId("office-doc-iframe")).toBeNull();
  });
});

/** Mount the surface with a fake same-origin Collabora iframe and fire Document_Loaded. */
async function loadSurfaceWithMap(
  map: Record<string, unknown>,
  calls: string[],
  opts: { displayName?: string; documentPath?: string } = {},
) {
  const displayName = opts.displayName ?? "sample.docx";
  const documentPath = opts.documentPath ?? "docs/sample.docx";
  const utils = render(
    <OfficeDocSurface
      artifactId="artifact-1"
      displayName={displayName}
      documentPath={documentPath}
      onClose={() => {}}
    />,
  );
  const { getByTestId } = utils;

  const iframe = await waitFor(() => {
    const node = getByTestId("office-doc-iframe") as HTMLIFrameElement;
    expect(node.getAttribute("src")).toContain("/office-engine/cool.html");
    return node;
  });

  const iframeDoc = document.implementation.createHTMLDocument("office");
  Object.defineProperty(iframe, "contentDocument", {
    configurable: true,
    value: iframeDoc,
  });
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: {
      app: { map },
      focus: mock(() => calls.push("window.focus")),
      postMessage: mock((data: unknown) => {
        const parsed = typeof data === "string" ? (JSON.parse(data) as { MessageId?: string }) : {};
        calls.push(`iframe.postMessage:${parsed.MessageId ?? "unknown"}`);
      }),
    },
  });
  const stripCss = iframeDoc.createElement("link");
  stripCss.id = "nw-office-chrome-strip";
  iframeDoc.head.appendChild(stripCss);
  const canvas = iframeDoc.createElement("div");
  canvas.id = "document-canvas";
  iframeDoc.body.appendChild(canvas);
  const clipboard = iframeDoc.createElement("div");
  clipboard.id = "clipboard-area";
  clipboard.tabIndex = -1;
  clipboard.focus = mock(() => calls.push("clipboard.focus")) as typeof clipboard.focus;
  iframeDoc.body.appendChild(clipboard);

  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://office.localhost",
        data: JSON.stringify({
          MessageId: "App_LoadingStatus",
          Values: { Status: "Document_Loaded" },
        }),
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });
  return utils;
}

function fakeMap(calls: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fire: mock((eventName: string) => calls.push(`fire:${eventName}`)),
    focus: mock((acceptInput?: boolean) => calls.push(`map.focus:${String(acceptInput)}`)),
    _docLayer: {
      _updateCursorAndOverlay: mock(() => calls.push("updateCursorAndOverlay")),
    },
    _textInput: {
      showCursor: mock(() => calls.push("showCursor")),
    },
    ...extra,
  };
}

describe("OfficeDocSurface", () => {
  test("publishes active office document context for the next agent turn", async () => {
    const view = render(
      <OfficeDocSurface
        artifactId="artifact-1"
        displayName="sample.docx"
        documentPath="docs/sample.docx"
        onClose={() => {}}
      />,
    );

    const active = readActiveMiniApp();
    expect(active?.appId).toBe("office-writer");
    expect(active?.appName).toBe("Writer");
    expect(active?.documentPath).toBe("docs/sample.docx");
    expect(active?.targetKind).toBe("artifact");

    view.unmount();
    expect(readActiveMiniApp()).toBeNull();
  });

  test("restores Collabora editor focus before showing the Writer cursor", async () => {
    const calls: string[] = [];
    await loadSurfaceWithMap(fakeMap(calls), calls);

    // Ignore the parent→frame protocol messages (handshake, UI-mode); this
    // test pins the focus/caret call order only.
    expect(calls.filter((c) => !c.startsWith("iframe.postMessage:"))).toEqual([
      "window.focus",
      "fire:editorgotfocus",
      "map.focus:true",
      "clipboard.focus",
      "updateCursorAndOverlay",
      "showCursor",
    ]);
    // No welcome dialog registered → no welcome-close posted.
    expect(calls).not.toContain("iframe.postMessage:welcome-close");
  });

  test("closes a wedged welcome IFrameDialog before refocusing (cursor-eater regression)", async () => {
    const calls: string[] = [];
    // The CODE welcome splash registers as map._iframeDialog even when the
    // strip CSS hides it; while set, editorHasFocus() is false and Collabora
    // force-hides the caret. The surface must post welcome-close first.
    await loadSurfaceWithMap(fakeMap(calls, { _iframeDialog: {} }), calls);

    const welcomeCloseIdx = calls.indexOf("iframe.postMessage:welcome-close");
    const focusIdx = calls.indexOf("fire:editorgotfocus");
    expect(welcomeCloseIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeGreaterThan(welcomeCloseIdx);
    expect(calls[calls.length - 1]).toBe("showCursor");
  });

  test("§3.3.6 — toolbar reflects seeded command state (Bold lit)", async () => {
    const calls: string[] = [];
    // Map exposes the state-change surface: seed Bold=true, Italic=false.
    const map = fakeMap(calls, {
      on: mock(() => {}),
      off: mock(() => {}),
      stateChangeHandler: {
        getItems: () => ({ ".uno:Bold": "true", ".uno:Italic": "false" }),
      },
    });
    const { getByLabelText } = await loadSurfaceWithMap(map, calls);

    await waitFor(() => {
      expect(getByLabelText("Bold").getAttribute("aria-pressed")).toBe("true");
      expect(getByLabelText("Italic").getAttribute("aria-pressed")).toBe("false");
    });
  });
});

describe("reduceCommandState (§3.3.6 pure reducer)", () => {
  test("tracks known toggles, normalizes the .uno: prefix, ignores unknown", () => {
    let s: Record<string, unknown> = {};
    s = reduceCommandState(s, ".uno:Bold", "true");
    expect(s["Bold"]).toBe("true");
    // Unknown command → same reference (no re-render).
    const before = s;
    s = reduceCommandState(s, ".uno:SomethingElse", "true");
    expect(s).toBe(before);
    // Bare name works too; unchanged value → same reference.
    const same = reduceCommandState(s, "Bold", "true");
    expect(same).toBe(s);
    // Value-carrying commands are stored verbatim.
    s = reduceCommandState(s, ".uno:CharFontName", "Liberation Serif");
    expect(s["CharFontName"]).toBe("Liberation Serif");
  });
});

describe("subscribeBackgroundSave (D362 audit C2)", () => {
  test("fires onSaved only for statusindicator finish+background=true", () => {
    const handlers: Array<(ev: { statusType?: string; background?: boolean }) => void> = [];
    const fakeIframe = {
      contentWindow: {
        app: {
          map: {
            on: mock((_ev: string, fn: (ev: { statusType?: string; background?: boolean }) => void) => handlers.push(fn)),
            off: mock(() => {}),
          },
        },
      },
    } as unknown as HTMLIFrameElement;
    const calls: string[] = [];
    const unsub = subscribeBackgroundSave(fakeIframe, () => calls.push("saved"));
    expect(typeof unsub).toBe("function");
    expect(handlers).toHaveLength(1);
    // background save finish → fires.
    handlers[0]!({ statusType: "finish", background: true });
    // foreground save finish → does NOT fire (Action_Save_Resp covers it).
    handlers[0]!({ statusType: "finish", background: false });
    // start/setvalue → do NOT fire.
    handlers[0]!({ statusType: "start", background: true });
    handlers[0]!({ statusType: "setvalue", background: true });
    // background missing → does NOT fire (only background=true is the autosave signal).
    handlers[0]!({ statusType: "finish" });
    expect(calls).toEqual(["saved"]);
    unsub!();
  });

  test("returns null when the map isn't reachable", () => {
    expect(subscribeBackgroundSave(null, () => {})).toBeNull();
    const crossOrigin = { contentWindow: {} } as unknown as HTMLIFrameElement;
    expect(subscribeBackgroundSave(crossOrigin, () => {})).toBeNull();
  });
});

describe("OfficeDocSurface C2 — autosave clears the unsaved indicator", () => {
  // Extends fakeMap with an `on`/`off` that CAPTURES handlers per event so the
  // test can dispatch a `statusindicator` event after the surface subscribes.
  function fakeMapWithHandlers(calls: string[]): {
    map: Record<string, unknown>;
    dispatch: (event: string, ev: unknown) => void;
    hasHandler: (event: string) => boolean;
  } {
    const handlers = new Map<string, Array<(ev: unknown) => void>>();
    const map: Record<string, unknown> = {
      fire: mock((eventName: string) => calls.push(`fire:${eventName}`)),
      focus: mock((acceptInput?: boolean) => calls.push(`map.focus:${String(acceptInput)}`)),
      _docLayer: { _updateCursorAndOverlay: mock(() => calls.push("updateCursorAndOverlay")) },
      _textInput: { showCursor: mock(() => calls.push("showCursor")) },
      on: mock((event: string, fn: (ev: unknown) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      }),
      off: mock(() => {}),
    };
    return {
      map,
      dispatch: (event: string, ev: unknown) => {
        for (const fn of handlers.get(event) ?? []) fn(ev);
      },
      // The surface attaches `subscribeBackgroundSave` via a retry ladder
      // (0/300/800ms…) that only succeeds once the fake map is reachable, so a
      // test that dispatches `statusindicator` before the handler attaches
      // silently drops the event (order-dependent flake). Poll this before
      // dispatching so the assertion is deterministic.
      hasHandler: (event: string) => (handlers.get(event)?.length ?? 0) > 0,
    };
  }

  test("statusindicator finish+background=true clears `Unsaved` → `Saved`", async () => {
    const calls: string[] = [];
    const { map, dispatch, hasHandler } = fakeMapWithHandlers(calls);
    const { getByTestId } = await loadSurfaceWithMap(map, calls);
    // Wait until the background-save subscription has actually attached (its
    // retry ladder can land after the initial 10ms settle) so the dispatched
    // `statusindicator` event isn't dropped.
    await waitFor(() => expect(hasHandler("statusindicator")).toBe(true));

    // Drive the doc into the "unsaved" state — emulates an edit firing
    // Doc_ModifiedStatus: { Modified: true }.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://office.localhost",
          data: JSON.stringify({
            MessageId: "Doc_ModifiedStatus",
            Values: { Modified: true },
          }),
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(getByTestId("office-doc-save-status").textContent).toBe("Unsaved");

    // AutoSave ticks in coolwsd → fires statusindicator { finish, background: true }.
    await act(async () => {
      dispatch("statusindicator", { statusType: "finish", background: true });
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(getByTestId("office-doc-save-status").textContent).toBe("Saved");
  });

  test("persistent pill: steady 'Saved' → 'Unsaved' → 'Saving…' → persistent 'Saved'", async () => {
    const calls: string[] = [];
    const { map, dispatch, hasHandler } = fakeMapWithHandlers(calls);
    const { getByTestId } = await loadSurfaceWithMap(map, calls);
    // Wait until the background-save subscription has actually attached (retry
    // ladder) so the dispatched `statusindicator` events aren't dropped.
    await waitFor(() => expect(hasHandler("statusindicator")).toBe(true));

    // Steady state (idle, no pending changes) shows a PERSISTENT "Saved" — the
    // pill is never blank/hidden.
    expect(getByTestId("office-doc-save-status").textContent).toBe("Saved");

    // Edit → Doc_ModifiedStatus { Modified: true } → "Unsaved" (attention).
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://office.localhost",
          data: JSON.stringify({
            MessageId: "Doc_ModifiedStatus",
            Values: { Modified: true },
          }),
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(getByTestId("office-doc-save-status").textContent).toBe("Unsaved");

    // Background save starts → statusindicator { start, background: true } → "Saving…".
    await act(async () => {
      dispatch("statusindicator", { statusType: "start", background: true });
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(getByTestId("office-doc-save-status").textContent).toBe("Saving…");

    // Background save finishes → statusindicator { finish, background: true } →
    // settles to a PERSISTENT "Saved" (never blank).
    await act(async () => {
      dispatch("statusindicator", { statusType: "finish", background: true });
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(getByTestId("office-doc-save-status").textContent).toBe("Saved");
  });

  test("foreground save finish does NOT touch the unsaved indicator (Action_Save_Resp owns it)", async () => {
    const calls: string[] = [];
    const { map, dispatch } = fakeMapWithHandlers(calls);
    const { getByTestId } = await loadSurfaceWithMap(map, calls);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://office.localhost",
          data: JSON.stringify({
            MessageId: "Doc_ModifiedStatus",
            Values: { Modified: true },
          }),
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(getByTestId("office-doc-save-status").textContent).toBe("Unsaved");

    // Foreground (explicit-save) finish — should NOT flashSaved (Action_Save_Resp
    // is the integrator-facing ack that owns the explicit-save transition).
    await act(async () => {
      dispatch("statusindicator", { statusType: "finish", background: false });
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(getByTestId("office-doc-save-status").textContent).toBe("Unsaved");
  });
});

/** Builds a mock RibbonActions that records every dispatch. */
function mockActions(ready = true) {
  const sent: Array<{ command: string; args?: unknown }> = [];
  const clientActions: string[] = [];
  const exitCalls: string[] = [];
  const state = new Map<string, unknown>();
  return {
    sent,
    clientActions,
    exitCalls,
    actions: {
      ready,
      sendUno: mock((command: string) => sent.push({ command })),
      sendUnoArgs: mock((command: string, args: unknown) => sent.push({ command, args })),
      isActive: (bare: string) => state.get(bare) === true || state.get(bare) === "true",
      stateValue: (bare: string) => {
        const v = state.get(bare);
        return typeof v === "string" ? v : v == null ? "" : String(v);
      },
      dispatchClientAction: mock((action: string) => {
        clientActions.push(action);
        return true;
      }),
      exitPresentation: mock(() => exitCalls.push("exit")),
      presenting: false,
    } as const,
    setState(bare: string, value: unknown) {
      state.set(bare, value);
    },
    setPresenting(value: boolean) {
      // Replace the `presenting` field on the actions object so consumers
      // re-read it. (kept simple — tests that need this build a fresh actions.)
      (this.actions as { presenting: boolean }).presenting = value;
    },
  };
}

describe("ImpressInsertGroup — chart insert (D362 audit cheap-win)", () => {
  test("dispatches .uno:InsertObjectChart (no args) on click", async () => {
    const { actions, sent } = mockActions();
    const { getByLabelText } = render(<ImpressInsertGroup actions={actions} />);
    await act(async () => {
      fireEvent.click(getByLabelText("Insert chart"));
    });
    expect(sent).toContainEqual({ command: ".uno:InsertObjectChart" });
  });
});

describe("CalcCellsGroup — borders preset menu (D362 audit cheap-win)", () => {
  test("outline preset dispatches .uno:SetBorderStyle with the grounded OuterBorder/InnerBorder shape", async () => {
    const { actions, sent } = mockActions();
    const { getByLabelText, getByText } = render(<CalcCellsGroup actions={actions} />);
    await act(async () => {
      fireEvent.click(getByLabelText("Borders"));
    });
    await act(async () => {
      fireEvent.click(getByText("Outline"));
    });
    const call = sent.find((c) => c.command === ".uno:SetBorderStyle");
    expect(call).toBeDefined();
    const args = call!.args as Record<string, { type: string; value: unknown }>;
    // OuterBorder = [left, right, bottom, top] BorderLine2 + 5 long zeros.
    expect(args.OuterBorder.type).toBe("[]any");
    const outer = args.OuterBorder.value as unknown[];
    expect(outer).toHaveLength(9);
    const borderLine = (i: number) => {
      const entry = outer[i] as { type: string; value: Record<string, { value: unknown }> };
      expect(entry.type).toBe("com.sun.star.table.BorderLine2");
      expect(entry.value.OuterLineWidth.value).toBe(1);
      expect(entry.value.InnerLineWidth.value).toBe(0);
      expect(entry.value.Color.value).toBe(0);
    };
    borderLine(0); // left
    borderLine(1); // right
    borderLine(2); // bottom
    borderLine(3); // top
    // 5 trailing long zeros.
    for (let i = 4; i < 9; i++) {
      expect((outer[i] as { type: string; value: unknown }).type).toBe("long");
      expect((outer[i] as { value: unknown }).value).toBe(0);
    }
    // InnerBorder = [horiz, vert] BorderLine2 (off for outline) + short 0, short valid, long 0.
    expect(args.InnerBorder.type).toBe("[]any");
    const inner = args.InnerBorder.value as unknown[];
    expect(inner).toHaveLength(5);
    expect((inner[0] as { value: { OuterLineWidth: { value: unknown } } }).value.OuterLineWidth.value).toBe(0);
    expect((inner[1] as { value: { OuterLineWidth: { value: unknown } } }).value.OuterLineWidth.value).toBe(0);
    // valid flags: top|bottom|left|right = 0x01|0x02|0x04|0x08 = 0x0f
    expect((inner[3] as { value: unknown }).value).toBe(0x0f);
  });

  test("none preset flips valid to 0x7f (clear-all sentinel)", async () => {
    const { actions, sent } = mockActions();
    const { getByLabelText, getByText } = render(<CalcCellsGroup actions={actions} />);
    await act(async () => {
      fireEvent.click(getByLabelText("Borders"));
    });
    await act(async () => {
      fireEvent.click(getByText("No borders"));
    });
    const args = sent.find((c) => c.command === ".uno:SetBorderStyle")!.args as Record<
      string,
      { type: string; value: unknown }
    >;
    const inner = args.InnerBorder.value as unknown[];
    // All widths 0; valid = 0x7f (clear-all sentinel per Control.Toolbar.js:59-62).
    expect((inner[0] as { value: { OuterLineWidth: { value: unknown } } }).value.OuterLineWidth.value).toBe(0);
    expect((inner[1] as { value: { OuterLineWidth: { value: unknown } } }).value.OuterLineWidth.value).toBe(0);
    expect((inner[3] as { value: unknown }).value).toBe(0x7f);
  });

  test("all preset enables inner borders too (valid = 0x3f)", async () => {
    const { actions, sent } = mockActions();
    const { getByLabelText, getByText } = render(<CalcCellsGroup actions={actions} />);
    await act(async () => {
      fireEvent.click(getByLabelText("Borders"));
    });
    await act(async () => {
      fireEvent.click(getByText("All borders"));
    });
    const args = sent.find((c) => c.command === ".uno:SetBorderStyle")!.args as Record<
      string,
      { type: string; value: unknown }
    >;
    const inner = args.InnerBorder.value as unknown[];
    // horiz + vert on → valid = 0x01|0x02|0x04|0x08|0x10|0x20 = 0x3f
    expect((inner[0] as { value: { OuterLineWidth: { value: unknown } } }).value.OuterLineWidth.value).toBe(1);
    expect((inner[1] as { value: { OuterLineWidth: { value: unknown } } }).value.OuterLineWidth.value).toBe(1);
    expect((inner[3] as { value: unknown }).value).toBe(0x3f);
  });
});

describe("CalcDataGroup — chart insert (D362 audit cheap-win)", () => {
  test("dispatches .uno:InsertObjectChart (no args) on click", async () => {
    const { actions, sent } = mockActions();
    const { getByLabelText } = render(<CalcDataGroup actions={actions} />);
    await act(async () => {
      fireEvent.click(getByLabelText("Insert chart"));
    });
    expect(sent).toContainEqual({ command: ".uno:InsertObjectChart" });
  });
});

describe("ImpressPresentGroup — Start presentation (D362 §5a)", () => {
  test("dispatches the `fullscreen-presentation` client action, NOT `.uno:Presentation`", async () => {
    const { actions, sent, clientActions } = mockActions();
    const { getByLabelText } = render(<ImpressPresentGroup actions={actions} />);
    await act(async () => {
      fireEvent.click(getByLabelText("Start presentation"));
    });
    // The canvas-slideshow action id is dispatched into the iframe.
    expect(clientActions).toContain("fullscreen-presentation");
    // The old core-slideshow UNO command MUST NOT be sent.
    expect(sent.find((c) => c.command === ".uno:Presentation")).toBeUndefined();
  });

  test("Notes view button still sends .uno:NotesMode (unchanged)", async () => {
    const { actions, sent } = mockActions();
    const { getByLabelText } = render(<ImpressPresentGroup actions={actions} />);
    await act(async () => {
      fireEvent.click(getByLabelText("Notes view"));
    });
    expect(sent).toContainEqual({ command: ".uno:NotesMode" });
  });
});

describe("subscribePresentationState (D362 §5b)", () => {
  test("returns null when the map isn't reachable", () => {
    expect(subscribePresentationState(null, () => {})).toBeNull();
    const crossOrigin = { contentWindow: {} } as unknown as HTMLIFrameElement;
    expect(subscribePresentationState(crossOrigin, () => {})).toBeNull();
  });

  test("fires true on `presentationinfo`, false on `endpresentation`", () => {
    const handlers = new Map<string, Array<(ev: unknown) => void>>();
    const fakeIframe = {
      contentWindow: {
        app: {
          map: {
            on: mock((event: string, fn: (ev: unknown) => void) => {
              const list = handlers.get(event) ?? [];
              list.push(fn);
              handlers.set(event, list);
            }),
            off: mock(() => {}),
          },
        },
      },
    } as unknown as HTMLIFrameElement;
    const calls: boolean[] = [];
    const unsub = subscribePresentationState(fakeIframe, (p) => calls.push(p));
    expect(typeof unsub).toBe("function");
    // Seed: no `_checkAlreadyPresenting` / no `#slideshow-canvas` → false.
    expect(calls).toEqual([false]);
    // Start: presentationinfo → true.
    for (const fn of handlers.get("presentationinfo") ?? []) fn({});
    expect(calls[calls.length - 1]).toBe(true);
    // End: endpresentation → false.
    for (const fn of handlers.get("endpresentation") ?? []) fn({});
    expect(calls[calls.length - 1]).toBe(false);
    unsub!();
  });
});

describe("OfficeDocSurface — Exit presentation button (D362 §5b)", () => {
  // Extends fakeMap with slideShowPresenter + handler capture so we can drive
  // `presentationinfo` to flip `presenting` true, then click Exit and assert
  // both the canvas-path call and the `.uno:PresentationEnd` postMessage.
  function fakeMapWithPresenter(calls: string[]): {
    map: Record<string, unknown>;
    dispatch: (event: string, ev: unknown) => void;
    hasHandler: (event: string) => boolean;
  } {
    const handlers = new Map<string, Array<(ev: unknown) => void>>();
    const map: Record<string, unknown> = {
      fire: mock((eventName: string) => calls.push(`fire:${eventName}`)),
      focus: mock((acceptInput?: boolean) => calls.push(`map.focus:${String(acceptInput)}`)),
      _docLayer: { _updateCursorAndOverlay: mock(() => calls.push("updateCursorAndOverlay")) },
      _textInput: { showCursor: mock(() => calls.push("showCursor")) },
      on: mock((event: string, fn: (ev: unknown) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      }),
      off: mock(() => {}),
      slideShowPresenter: {
        endPresentation: mock((force: boolean) => calls.push(`endPresentation:${String(force)}`)),
        // Not presenting at mount → seed false.
        _checkAlreadyPresenting: () => false,
      },
    };
    return {
      map,
      dispatch: (event: string, ev: unknown) => {
        for (const fn of handlers.get(event) ?? []) fn(ev);
      },
      // `subscribePresentationState` attaches via the same retry ladder as the
      // save subscription; poll before dispatching `presentationinfo` so the
      // event isn't dropped (order-dependent flake).
      hasHandler: (event: string) => (handlers.get(event)?.length ?? 0) > 0,
    };
  }

  test("iframe is fullscreen-capable (allowFullScreen + allow contains fullscreen)", async () => {
    const calls: string[] = [];
    const { map } = fakeMapWithPresenter(calls);
    const { getByTestId } = await loadSurfaceWithMap(map, calls, {
      displayName: "deck.pptx",
      documentPath: "docs/deck.pptx",
    });
    const iframe = getByTestId("office-doc-iframe") as HTMLIFrameElement;
    expect(iframe.hasAttribute("allowfullscreen")).toBe(true);
    expect(iframe.getAttribute("allow") ?? "").toContain("fullscreen");
  });

  test("Exit button is hidden until `presentationinfo` fires, then ends the show on click", async () => {
    const calls: string[] = [];
    const { map, dispatch, hasHandler } = fakeMapWithPresenter(calls);
    const { getByTestId, queryByTestId } = await loadSurfaceWithMap(map, calls, {
      displayName: "deck.pptx",
      documentPath: "docs/deck.pptx",
    });
    // Wait until the presentation-state subscription has attached (retry ladder)
    // so the dispatched `presentationinfo` event isn't dropped.
    await waitFor(() => expect(hasHandler("presentationinfo")).toBe(true));

    // Before presenting: no Exit button.
    expect(queryByTestId("office-doc-exit-presentation")).toBeNull();

    // Flip `_checkAlreadyPresenting` to true so the start signal produces a
    // true → true re-evaluation is consistent, then fire `presentationinfo`.
    (map.slideShowPresenter as { _checkAlreadyPresenting: () => boolean })._checkAlreadyPresenting = () => true;
    await act(async () => {
      dispatch("presentationinfo", {});
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    const exitBtn = getByTestId("office-doc-exit-presentation");
    expect(exitBtn).toBeDefined();

    // Click Exit → canvas-path endPresentation(true) AND .uno:PresentationEnd
    // postMessage (belt-and-braces core-path kill switch).
    await act(async () => {
      fireEvent.click(exitBtn);
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(calls).toContain("endPresentation:true");
    expect(calls).toContain("iframe.postMessage:Send_UNO_Command");
    // The Exit button's optimistic flip hides it immediately.
    expect(queryByTestId("office-doc-exit-presentation")).toBeNull();
  });
});
