/**
 * D235 Phase 3 + Phase 6 — Approvals list grouping, filters, richer rows, revoke countdown.
 */
import "../bun-dom-preload";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { CommandApprovalRow } from "@nautilo/api-client";

const REVOKE_UNDO_MS = 80;

function makeRow(
  overrides: Partial<CommandApprovalRow> & Pick<CommandApprovalRow, "id" | "scope">,
): CommandApprovalRow {
  return {
    roomId: overrides.scope === "room" ? "room-1" : null,
    roomLabel: overrides.scope === "room" ? "Ops room" : null,
    toolPattern: "file.read",
    label: overrides.label ?? `${overrides.scope} label for ${overrides.id}`,
    approvalKind: "tool",
    capabilitySlug: null,
    active: true,
    createdAt: "2026-06-10T12:00:00.000Z",
    ...overrides,
  };
}

const sampleRows: CommandApprovalRow[] = [
  makeRow({
    id: "srv-1",
    scope: "server",
    toolPattern: "file.read",
    label: "file.read on /tmp/*",
  }),
  makeRow({
    id: "cap-1",
    scope: "server",
    toolPattern: "_capability",
    label: "capability: control_desktop",
    approvalKind: "capability",
    capabilitySlug: "control_desktop",
  }),
  makeRow({
    id: "room-1",
    scope: "room",
    roomId: "room-ops",
    roomLabel: "#infra-ops",
    toolPattern: "run_shell",
    label: "run_shell grep in workspace",
  }),
  makeRow({
    id: "room-2",
    scope: "room",
    roomId: "room-general",
    roomLabel: "#general",
    toolPattern: "web_fetch",
    label: "web_fetch https://example.com",
  }),
];

let listStandingApprovals: () => Promise<CommandApprovalRow[]>;
let revokeStandingApproval: (id: string) => Promise<{ ok: boolean }>;

// `mock.module` is process-global and leaks to every test file that runs AFTER
// this one in the same `bun test` invocation. Preserve the real module (keeps
// `WS_URL` + every other `apiClient` method intact for later importers like the
// docx-viewer suite) and override only the two methods we exercise; restore in
// `afterAll`. Mirrors the navigation-rail.test.tsx restore convention.
const actualApi = await import("../../src/lib/api");

mock.module("../../src/lib/api", () => ({
  ...actualApi,
  apiClient: {
    ...actualApi.apiClient,
    listStandingApprovals: async () => listStandingApprovals(),
    revokeStandingApproval: async (id: string) => revokeStandingApproval(id),
  },
}));

const { ApprovalsPane } = await import("../../src/components/approvals/approvals-pane");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  mock.module("../../src/lib/api", () => actualApi);
  // `bun-dom-preload` installs happy-dom `window`/`document`/etc. on
  // `globalThis` as a module side effect. Those globals persist process-wide
  // and break later SSR-shaped suites (e.g. docx-viewer's sanitizer picks the
  // DOMPurify path once `window` exists). Tear them down exactly like
  // room-switch-regression.test.tsx does.
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "customElements",
    "MutationObserver",
    "localStorage",
    "sessionStorage",
    "location",
    "__NAUTILO_HAPPY_DOM_WINDOW__",
  ]) {
    Reflect.deleteProperty(globalThis, key);
  }
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    await Promise.resolve();
  });
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  listStandingApprovals = async () => sampleRows;
  revokeStandingApproval = async () => ({ ok: true });
});

afterEach(() => {
  cleanup();
});

describe("ApprovalsPane scope grouping", () => {
  test("renders server-wide first then per-room groups with room labels", async () => {
    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();

    expect(await view.findByTestId("approvals-list")).toBeTruthy();

    const serverGroup = view.getByTestId("approval-group-ALWAYS · SERVER-WIDE");
    const opsGroup = view.getByTestId("approval-group-ROOM · #infra-ops");
    const generalGroup = view.getByTestId("approval-group-ROOM · #general");

    const groups = view.container.querySelectorAll('[data-testid^="approval-group-"]');
    expect(groups[0]?.getAttribute("data-testid")).toBe("approval-group-ALWAYS · SERVER-WIDE");
    expect(groups[1]?.getAttribute("data-testid")).toBe("approval-group-ROOM · #infra-ops");
    expect(groups[2]?.getAttribute("data-testid")).toBe("approval-group-ROOM · #general");

    expect(within(serverGroup).getByText("File access")).toBeTruthy();
    expect(within(serverGroup).getByText("on /tmp/*")).toBeTruthy();
    expect(within(serverGroup).getByText("Capability")).toBeTruthy();
    expect(within(serverGroup).getByText("control_desktop")).toBeTruthy();
    expect(within(serverGroup).getAllByText("Always · server-wide").length).toBe(2);

    expect(within(opsGroup).getByText("Run shell command")).toBeTruthy();
    expect(within(opsGroup).getByText("grep in workspace")).toBeTruthy();
    expect(within(opsGroup).getByText("Room: #infra-ops")).toBeTruthy();
    expect(within(generalGroup).getByText("Fetch URL")).toBeTruthy();
    expect(within(generalGroup).getByText("Room: #general")).toBeTruthy();
    expect(view.queryByText(/This room:/i)).toBeNull();
  });

  test("list lives in a bounded scroll region so it can't overflow the shell (D325)", async () => {
    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();

    const scroll = await view.findByTestId("approvals-scroll");
    const cls = scroll.className;
    // The list must be the flex-1, min-h-0 overflow-y-auto child — the same
    // scroll contract Memory Library uses — so a long list scrolls instead of
    // clipping at the shell's overflow-hidden center column.
    expect(cls).toContain("overflow-y-auto");
    expect(cls).toContain("min-h-0");
    expect(cls).toContain("flex-1");
    expect(within(scroll).getByTestId("approvals-list")).toBeTruthy();
  });
});

describe("ApprovalsPane filters", () => {
  test("scope dropdown limits visible groups", async () => {
    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approvals-list");

    fireEvent.change(view.getByTestId("approvals-scope-filter"), {
      target: { value: "server" },
    });
    await flush();

    expect(view.getByTestId("approval-group-ALWAYS · SERVER-WIDE")).toBeTruthy();
    expect(view.queryByTestId("approval-group-ROOM · #infra-ops")).toBeNull();
    expect(view.queryByTestId("approval-group-ROOM · #general")).toBeNull();

    fireEvent.change(view.getByTestId("approvals-scope-filter"), {
      target: { value: "room-general" },
    });
    await flush();

    expect(view.queryByTestId("approval-group-ALWAYS · SERVER-WIDE")).toBeNull();
    expect(view.getByTestId("approval-group-ROOM · #general")).toBeTruthy();
  });

  test("search narrows rows and shows filter-empty state", async () => {
    const narrowed = render(
      <ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} initialFilters={{ search: "grep" }} />,
    );
    await flush();
    await narrowed.findByTestId("approval-row-room-1");

    expect(narrowed.queryByTestId("approval-row-room-2")).toBeNull();
    expect(narrowed.queryByTestId("approval-row-srv-1")).toBeNull();
    narrowed.unmount();

    const empty = render(
      <ApprovalsPane
        revokeUndoMs={REVOKE_UNDO_MS}
        initialFilters={{ search: "no-such-rule-xyz" }}
      />,
    );
    await flush();
    await empty.findByTestId("approvals-filters");

    expect(empty.getByTestId("approvals-filter-empty")).toBeTruthy();
    expect(empty.queryByTestId("approvals-list")).toBeNull();
    expect(empty.queryByTestId("approvals-empty")).toBeNull();
  });

  test("renders the search input when approvals are loaded", async () => {
    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approvals-list");

    expect(view.container.querySelector("#approvals-search")).toBeTruthy();
  });

  test("family chip filters rows by tool family", async () => {
    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approvals-list");

    fireEvent.click(view.getByTestId("approvals-family-chip-shell"));
    await flush();

    expect(view.getByTestId("approval-row-room-1")).toBeTruthy();
    expect(view.queryByTestId("approval-row-srv-1")).toBeNull();
    expect(view.queryByTestId("approval-row-cap-1")).toBeNull();
    expect(view.queryByTestId("approval-row-room-2")).toBeNull();
  });
});

describe("ApprovalsPane revoke countdown", () => {
  test("commits DELETE when countdown expires", async () => {
    const revoked: string[] = [];
    revokeStandingApproval = async (id) => {
      revoked.push(id);
      return { ok: true };
    };

    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approval-row-room-1");

    fireEvent.click(
      view.getByRole("button", { name: /Revoke run_shell grep in workspace/i }),
    );
    expect(view.getByTestId("revoke-countdown-room-1").textContent).toContain("undoing in");

    await flush(REVOKE_UNDO_MS + 40);

    expect(revoked).toEqual(["room-1"]);
    expect(view.queryByTestId("approval-row-room-1")).toBeNull();
  });

  test("Restore before expiry does not call the server", async () => {
    const revoked: string[] = [];
    revokeStandingApproval = async (id) => {
      revoked.push(id);
      return { ok: true };
    };

    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approval-row-srv-1");

    fireEvent.click(view.getByRole("button", { name: /Revoke file.read on \/tmp\/\*/i }));
    fireEvent.click(view.getByRole("button", { name: /Restore file.read on \/tmp\/\*/i }));

    await flush(REVOKE_UNDO_MS + 40);

    expect(revoked).toEqual([]);
    expect(view.getByTestId("approval-row-srv-1").getAttribute("data-phase")).toBe("idle");
  });

  test("unmount during countdown does not fire DELETE", async () => {
    const revoked: string[] = [];
    revokeStandingApproval = async (id) => {
      revoked.push(id);
      return { ok: true };
    };

    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approval-row-room-1");

    fireEvent.click(
      view.getByRole("button", { name: /Revoke run_shell grep in workspace/i }),
    );
    view.unmount();

    await flush(REVOKE_UNDO_MS + 40);

    expect(revoked).toEqual([]);
  });
});

describe("ApprovalsPane bulk revoke all", () => {
  test("hides Revoke all when the list is empty", async () => {
    listStandingApprovals = async () => [];

    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();

    expect(await view.findByTestId("approvals-empty")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Revoke all approvals" })).toBeNull();
  });

  test("Cancel on the confirm modal does not call revokeStandingApproval", async () => {
    const revoked: string[] = [];
    revokeStandingApproval = async (id) => {
      revoked.push(id);
      return { ok: true };
    };

    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approvals-list");

    fireEvent.click(view.getByRole("button", { name: "Revoke all approvals" }));
    const dialog = view.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText("Revoke all 4 approvals?")).toBeTruthy();
    expect(within(dialog).getByText("Tools will ask again next time.")).toBeTruthy();

    fireEvent.click(within(dialog).getByText("Cancel"));
    await flush();

    expect(revoked).toEqual([]);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByTestId("approvals-list")).toBeTruthy();
  });

  test("confirm loops revokeStandingApproval over every active id", async () => {
    const revoked: string[] = [];
    revokeStandingApproval = async (id) => {
      revoked.push(id);
      return { ok: true };
    };

    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approvals-list");

    fireEvent.click(view.getByRole("button", { name: "Revoke all approvals" }));
    fireEvent.click(view.getByRole("button", { name: "Revoke all" }));
    await flush();

    expect(revoked).toEqual(["srv-1", "cap-1", "room-1", "room-2"]);
    expect(await view.findByTestId("approvals-empty")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Revoke all approvals" })).toBeNull();
  });

  test("partial failure surfaces bulk error and re-lists remaining rows", async () => {
    const revoked: string[] = [];
    revokeStandingApproval = async (id) => {
      revoked.push(id);
      if (id === "cap-1") throw new Error("network");
      return { ok: true };
    };

    let listCalls = 0;
    listStandingApprovals = async () => {
      listCalls += 1;
      if (listCalls === 1) return sampleRows;
      return [
        makeRow({
          id: "cap-1",
          scope: "server",
          toolPattern: "_capability",
          label: "capability: control_desktop",
          approvalKind: "capability",
          capabilitySlug: "control_desktop",
        }),
      ];
    };

    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approvals-list");

    fireEvent.click(view.getByRole("button", { name: "Revoke all approvals" }));
    fireEvent.click(view.getByRole("button", { name: "Revoke all" }));
    await flush();

    expect(revoked).toEqual(["srv-1", "cap-1", "room-1", "room-2"]);
    expect(view.getByTestId("approvals-bulk-error").textContent).toContain(
      "Could not revoke 1 of 4 approvals.",
    );
    expect(view.getByTestId("approval-row-cap-1")).toBeTruthy();
    expect(view.queryByTestId("approval-row-srv-1")).toBeNull();
    expect(view.queryByTestId("approval-row-room-1")).toBeNull();
    expect(view.queryByTestId("approval-row-room-2")).toBeNull();
  });
});

describe("ApprovalsPane unmapped tool fallback", () => {
  test("shows raw toolPattern headline and full label subline", async () => {
    listStandingApprovals = async () => [
      makeRow({
        id: "custom-1",
        scope: "server",
        toolPattern: "synthetic_tool",
        label: "synthetic_tool do something custom",
      }),
    ];

    const view = render(<ApprovalsPane revokeUndoMs={REVOKE_UNDO_MS} />);
    await flush();
    await view.findByTestId("approval-row-custom-1");

    expect(view.getByTestId("approval-row-headline-custom-1").textContent).toBe(
      "synthetic_tool",
    );
    expect(view.getByTestId("approval-row-subline-custom-1").textContent).toBe(
      "synthetic_tool do something custom",
    );
  });
});
