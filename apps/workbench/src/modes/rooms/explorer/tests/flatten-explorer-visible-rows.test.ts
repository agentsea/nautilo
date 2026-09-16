import { describe, expect, test } from "bun:test";
import type { ExplorerRow, ExplorerSection } from "../explorer-grouping.types";
import {
  flattenExplorerVisibleRows,
  isExplorerRowExpandable,
  orderEntityChildren,
} from "../flatten-explorer-visible-rows";

function mkEntity(overrides: Partial<ExplorerRow> & Pick<ExplorerRow, "id">): ExplorerRow {
  return {
    kind: "entity-agent",
    depth: 0,
    label: "Agent",
    roomId: "room-primary",
    preview: null,
    isSubthread: false,
    children: [],
    ...overrides,
  };
}

describe("flattenExplorerVisibleRows", () => {
  test("collapsed entity hides nested rows; expanded reveals Direct room first", () => {
    const entity = mkEntity({
      id: "agent:entity:a1",
      children: [
        {
          id: "agent:entity:a1:threads",
          kind: "threads",
          depth: 1,
          label: "Threads",
          roomId: "",
          preview: null,
          isSubthread: false,
          subthreadCount: 2,
          children: [
            {
              id: "agent:entity:a1:thread:t1",
              kind: "thread",
              depth: 2,
              label: "Thread one",
              roomId: "t1",
              preview: null,
              isSubthread: true,
            },
          ],
        },
        {
          id: "agent:entity:a1:private",
          kind: "private-room",
          depth: 1,
          label: "Private with me",
          roomId: "room-primary",
          preview: null,
          isSubthread: false,
        },
      ],
    });

    const sections: ExplorerSection[] = [
      {
        kind: "my-agents",
        title: "My agents",
        defaultCollapsed: false,
        rows: [entity],
      },
    ];

    const collapsed = flattenExplorerVisibleRows(sections, () => false);
    expect(collapsed.filter((r) => r.type === "row").map((r) => r.id)).toEqual([
      "agent:entity:a1",
    ]);

    const expanded = flattenExplorerVisibleRows(sections, (id) =>
      id === "agent:entity:a1" || id === "agent:entity:a1:threads" ? true : false,
    );
    const rowIds = expanded.filter((r) => r.type === "row").map((r) => r.id);
    expect(rowIds).toContain("agent:entity:a1:private");
    expect(rowIds).toContain("agent:entity:a1:threads");
    expect(rowIds).toContain("agent:entity:a1:thread:t1");
    const privateIdx = rowIds.indexOf("agent:entity:a1:private");
    const threadsIdx = rowIds.indexOf("agent:entity:a1:threads");
    expect(privateIdx).toBeLessThan(threadsIdx);
  });

  test("includes all 30 thread leaves when expanded (no truncation cap)", () => {
    const threadChildren: ExplorerRow[] = Array.from({ length: 30 }, (_, i) => ({
      id: `agent:entity:a1:thread:${i}`,
      kind: "thread" as const,
      depth: 2,
      label: `Thread ${i}`,
      roomId: `thread-room-${i}`,
      preview: null,
      isSubthread: true,
    }));

    const entity = mkEntity({
      id: "agent:entity:a1",
      children: [
        {
          id: "agent:entity:a1:threads",
          kind: "threads",
          depth: 1,
          label: "Threads",
          roomId: "",
          preview: null,
          isSubthread: false,
          subthreadCount: 30,
          children: threadChildren,
        },
      ],
    });

    const sections: ExplorerSection[] = [
      {
        kind: "my-agents",
        title: "My agents",
        defaultCollapsed: false,
        rows: [entity],
      },
    ];

    const flat = flattenExplorerVisibleRows(sections, (id) =>
      id === "agent:entity:a1" || id === "agent:entity:a1:threads" ? true : false,
    );

    const threadRowIds = flat
      .filter((r) => r.type === "row" && r.row.kind === "thread")
      .map((r) => r.id);

    expect(threadRowIds).toHaveLength(30);
    expect(threadRowIds[0]).toBe("agent:entity:a1:thread:0");
    expect(threadRowIds[29]).toBe("agent:entity:a1:thread:29");
  });

  test("my-agents and other-agents sections both produce headers", () => {
    const sections: ExplorerSection[] = [
      {
        kind: "my-agents",
        title: "My agents",
        defaultCollapsed: false,
        rows: [mkEntity({ id: "mine", label: "Jeannie" })],
      },
      {
        kind: "other-agents",
        title: "Other agents",
        defaultCollapsed: false,
        rows: [mkEntity({ id: "other", label: "Nova" })],
      },
    ];

    const flat = flattenExplorerVisibleRows(sections, () => false);
    const headers = flat
      .filter((r) => r.type === "section-header")
      .map((r) => r.title);

    expect(headers).toEqual(["My agents", "Other agents"]);
  });

  test("agent-to-agent section header starts collapsed without expand flag", () => {
    const sections: ExplorerSection[] = [
      {
        kind: "agent-to-agent",
        title: "Agent-to-agent",
        defaultCollapsed: true,
        rows: [
          {
            id: "a2a:1",
            kind: "room",
            depth: 0,
            label: "A ↔ B",
            roomId: "r-a2a",
            preview: null,
            isSubthread: false,
          },
        ],
      },
    ];

    const flat = flattenExplorerVisibleRows(sections, () => false);
    expect(flat.some((r) => r.type === "row")).toBe(false);
  });
});

describe("orderEntityChildren", () => {
  test("pins direct/private before threads regardless of input order", () => {
    const children: ExplorerRow[] = [
      {
        id: "t",
        kind: "threads",
        depth: 1,
        label: "Threads",
        roomId: "",
        preview: null,
        isSubthread: false,
      },
      {
        id: "p",
        kind: "private-room",
        depth: 1,
        label: "Private with me",
        roomId: "r1",
        preview: null,
        isSubthread: false,
      },
    ];

    expect(orderEntityChildren(children).map((c) => c.id)).toEqual(["p", "t"]);
  });
});

describe("isExplorerRowExpandable", () => {
  test("entity and container kinds are expandable", () => {
    expect(isExplorerRowExpandable("entity-human")).toBe(true);
    expect(isExplorerRowExpandable("threads")).toBe(true);
    expect(isExplorerRowExpandable("thread")).toBe(false);
  });
});
