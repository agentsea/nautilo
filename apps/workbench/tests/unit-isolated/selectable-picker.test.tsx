/**
 * D187 P3 — SelectablePicker's candidate source is now INJECTED via the
 * `search` prop, so these tests never touch the network: each render passes a
 * fake `search`. Two modes are covered:
 *
 * - Multi-select mode (`onToggle`): empty-query seed fetch on mount, row toggle
 *   -> chip + metadata cache, chip removal. (The controlled search input's
 *   `onChange` doesn't fire under this repo's bun+happy-dom harness, so
 *   per-query persistence is proven through the pure `buildChips` helper rather
 *   than typing.)
 * - Action mode (`onPick`): clicking a row calls `onPick` with the candidate;
 *   `disabledKeys` hides a row; `busyKey` marks its row busy/disabled.
 */
import "../bun-dom-preload";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { act, useCallback, useState, type ReactElement } from "react";

// UserAvatar hits an authenticated image endpoint; stub it to a marker so
// the test stays DOM/network-free.
mock.module("../../src/components/avatar/UserAvatar", () => ({
  UserAvatar: ({ userId }: { userId: string }) => (
    <span data-testid="user-avatar" data-user-id={userId} />
  ),
}));

const { SelectablePicker, buildChips, memberKey, toSelectableCandidate } = await import(
  "../../src/modes/rooms/new-conversation/SelectablePicker"
);

type Candidate = ReturnType<typeof toSelectableCandidate>;

const seedCandidates: Candidate[] = [
  { kind: "user", id: "u-alice", displayName: "Alice", handle: "alice" },
  { kind: "user", id: "u-bob", displayName: "Bob", handle: "bob" },
  {
    kind: "agent",
    id: "a-genie",
    displayName: "Genie",
    handle: "genie",
    agentOwnerUserId: "u-alice",
    agentOwnerHandle: "alice",
    agentOwnerDisplayName: "Alice",
  },
];

// Mutable so each test can decide what the injected search "returns".
let searchResult: Candidate[] = [];
const search = mock(async (_q: string) => searchResult);

/** Debounce + React scheduler can outlive `cleanup()`; drain before tearing down happy-dom. */
async function flushPickerEffects(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 350);
    });
  });
}


/**
 * Wraps the controlled picker with the same selection + metadata-cache wiring
 * the create dialog uses: `onToggle` caches metadata on the way in and flips
 * the selection set.
 */
function ControlledPicker(): ReactElement {
  const [users, setUsers] = useState<Set<string>>(new Set());
  const [agents, setAgents] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<Map<string, Candidate>>(new Map());
  const onToggle = useCallback((candidate: Candidate) => {
    const key = memberKey(candidate.kind, candidate.id);
    setMeta((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, candidate);
      return next;
    });
    const setter = candidate.kind === "user" ? setUsers : setAgents;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(candidate.id)) next.delete(candidate.id);
      else next.add(candidate.id);
      return next;
    });
  }, []);
  const onSetVisibleSelection = useCallback((candidates: readonly Candidate[], selected: boolean) => {
    setUsers((current) => {
      const next = new Set(current);
      for (const candidate of candidates) {
        if (candidate.kind === "user") selected ? next.add(candidate.id) : next.delete(candidate.id);
      }
      return next;
    });
    setAgents((current) => {
      const next = new Set(current);
      for (const candidate of candidates) {
        if (candidate.kind === "agent") selected ? next.add(candidate.id) : next.delete(candidate.id);
      }
      return next;
    });
    setMeta((current) => {
      const next = new Map(current);
      for (const candidate of candidates) next.set(memberKey(candidate.kind, candidate.id), candidate);
      return next;
    });
  }, []);
  return (
    <SelectablePicker
      search={search}
      viewerUserId="u-me"
      selectedUserIds={users}
      selectedAgentIds={agents}
      selectedMeta={meta}
      onToggle={onToggle}
      onSetVisibleSelection={onSetVisibleSelection}
    />
  );
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  searchResult = seedCandidates;
  search.mockClear();
});

afterEach(async () => {
  cleanup();
  await flushPickerEffects();
});

afterAll(async () => {
  await flushPickerEffects();
  mock.restore();
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
});

describe("SelectablePicker — multi-select mode", () => {
  test("runs the empty-query seed search on mount and renders results", async () => {
    const { getByRole } = render(<ControlledPicker />);
    await waitFor(() => {
      expect(within(getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
    });
    expect(within(getByRole("listbox")).getByText("Alice")).toBeTruthy();
    expect(within(getByRole("listbox")).getByText("Genie")).toBeTruthy();
    // The injected search is called with the trimmed (empty) seed query.
    expect(search).toHaveBeenCalledWith("");
  });

  test("selecting a result adds a chip + caches metadata; chip × toggles it off", async () => {
    const { getByRole, getAllByTestId, queryAllByTestId } = render(<ControlledPicker />);
    await waitFor(() => {
      expect(within(getByRole("listbox")).getByText("Alice")).toBeTruthy();
    });

    fireEvent.click(within(getByRole("listbox")).getByText("Alice"));
    const chips = getAllByTestId("member-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toContain("Alice");

    const aliceOption = within(getByRole("listbox"))
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Alice"));
    expect(aliceOption?.getAttribute("aria-selected")).toBe("true");

    // Remove via the chip's × button.
    fireEvent.click(within(chips[0] as HTMLElement).getByRole("button"));
    expect(queryAllByTestId("member-chip")).toHaveLength(0);
    const aliceAfter = within(getByRole("listbox"))
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Alice"));
    expect(aliceAfter?.getAttribute("aria-selected")).toBe("false");
  });

  test("selecting an agent renders a distinct chip and marks the row", async () => {
    const { getByRole, getAllByTestId } = render(<ControlledPicker />);
    await waitFor(() => {
      expect(within(getByRole("listbox")).getByText("Genie")).toBeTruthy();
    });
    fireEvent.click(within(getByRole("listbox")).getByText("Genie"));
    const chip = getAllByTestId("member-chip")[0];
    expect(chip?.textContent).toContain("Genie");
    const genieOption = within(getByRole("listbox"))
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Genie"));
    expect(genieOption?.getAttribute("data-kind")).toBe("agent");
    expect(genieOption?.getAttribute("aria-selected")).toBe("true");
    expect(genieOption?.textContent).toContain("Alice’s Genie · @genie");
  });

  test("selects and clears every actionable visible candidate", async () => {
    const { getByRole, getAllByTestId, queryAllByTestId } = render(<ControlledPicker />);
    await waitFor(() => {
      expect(within(getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
    });

    fireEvent.click(getByRole("button", { name: "Select everyone (3)" }));
    expect(getAllByTestId("member-chip")).toHaveLength(3);
    expect(getByRole("button", { name: "Clear everyone" })).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Clear everyone" }));
    expect(queryAllByTestId("member-chip")).toHaveLength(0);
  });
});

describe("SelectablePicker — action mode", () => {
  test("clicking a row calls onPick with the candidate and shows no chips", async () => {
    const onPick = mock((_c: Candidate) => {});
    const { getByRole, queryAllByTestId } = render(
      <SelectablePicker search={search} onPick={onPick} />,
    );
    await waitFor(() => {
      expect(within(getByRole("listbox")).getByText("Alice")).toBeTruthy();
    });
    // Action mode never renders the chip row.
    expect(queryAllByTestId("member-chip")).toHaveLength(0);

    fireEvent.click(within(getByRole("listbox")).getByText("Genie"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).toMatchObject({ kind: "agent", id: "a-genie" });
  });

  test("disabledKeys hides matching rows", async () => {
    const onPick = mock((_c: Candidate) => {});
    const disabledKeys = new Set([memberKey("user", "u-bob")]);
    const { getByRole } = render(
      <SelectablePicker search={search} onPick={onPick} disabledKeys={disabledKeys} />,
    );
    await waitFor(() => {
      expect(within(getByRole("listbox")).getByText("Alice")).toBeTruthy();
    });
    const options = within(getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options.some((o) => o.textContent?.includes("Bob"))).toBe(false);
  });

  test("busyKey marks its row busy/disabled", async () => {
    const onPick = mock((_c: Candidate) => {});
    const { getByRole } = render(
      <SelectablePicker
        search={search}
        onPick={onPick}
        busyKey={memberKey("user", "u-alice")}
      />,
    );
    await waitFor(() => {
      expect(within(getByRole("listbox")).getByText("Alice")).toBeTruthy();
    });
    const aliceOption = within(getByRole("listbox"))
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Alice")) as HTMLButtonElement;
    expect(aliceOption.getAttribute("data-busy")).toBe("true");
    expect(aliceOption.disabled).toBe(true);
    expect(aliceOption.textContent).toContain("Adding…");
  });
});

describe("buildChips (selected-metadata cache)", () => {
  test("renders selected chips from the cache, independent of current results", () => {
    const meta = new Map([
      [
        memberKey("user", "u-alice"),
        { kind: "user" as const, id: "u-alice", displayName: "Alice", handle: "alice" },
      ],
      [
        memberKey("agent", "a-genie"),
        { kind: "agent" as const, id: "a-genie", displayName: "Genie", handle: "genie" },
      ],
    ]);
    // Cache carries the metadata even though the current search results
    // (which would be a different query's rows) are irrelevant here — this is
    // why a chip persists after a later query returns a different set.
    const chips = buildChips(new Set(["u-alice"]), new Set(["a-genie"]), meta);
    expect(chips.map((c) => c.displayName)).toEqual(["Alice", "Genie"]);
    expect(chips.find((c) => c.id === "a-genie")?.kind).toBe("agent");
  });

  test("falls back to the raw id when metadata is missing so a chip never vanishes", () => {
    const chips = buildChips(new Set(["u-ghost"]), new Set(), new Map());
    expect(chips).toHaveLength(1);
    expect(chips[0]?.displayName).toBe("u-ghost");
  });
});

describe("toSelectableCandidate", () => {
  test("maps a server directory-search row to a picker candidate", () => {
    const candidate = toSelectableCandidate({
      kind: "agent",
      id: "a-genie",
      displayName: "Genie",
      handle: "genie",
      agentOwnerUserId: "u-alice",
      agentOwnerHandle: "alice",
      agentOwnerDisplayName: "Alice",
    });
    expect(candidate).toEqual({
      kind: "agent",
      id: "a-genie",
      displayName: "Genie",
      handle: "genie",
      agentOwnerUserId: "u-alice",
      agentOwnerHandle: "alice",
      agentOwnerDisplayName: "Alice",
    });
  });
});
