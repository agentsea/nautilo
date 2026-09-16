import "../../../../../../tests/bun-dom-preload.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useExplorerExpanded } from "../useExplorerExpanded";

const STORAGE_KEY = "nautilo.workbench.explorer.expanded.v1";

describe("useExplorerExpanded", () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  test("missing keys default to collapsed", () => {
    const { result } = renderHook(() => useExplorerExpanded());
    expect(result.current.isExpanded("people:entity:abc")).toBe(false);
  });

  test("setExpanded persists rowId to localStorage", () => {
    const { result } = renderHook(() => useExplorerExpanded());
    act(() => {
      result.current.setExpanded("agent:entity:genie", true);
    });
    expect(result.current.isExpanded("agent:entity:genie")).toBe(true);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { v: number; expanded: Record<string, boolean> };
    expect(parsed.v).toBe(1);
    expect(parsed.expanded["agent:entity:genie"]).toBe(true);
  });

  test("reads persisted expanded map on mount", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, expanded: { "people:entity:x": true } }),
    );
    const { result } = renderHook(() => useExplorerExpanded());
    expect(result.current.isExpanded("people:entity:x")).toBe(true);
  });

  test("toggleExpanded flips a row", () => {
    const { result } = renderHook(() => useExplorerExpanded());
    act(() => {
      result.current.toggleExpanded("group:123");
    });
    expect(result.current.isExpanded("group:123")).toBe(true);
    act(() => {
      result.current.toggleExpanded("group:123");
    });
    expect(result.current.isExpanded("group:123")).toBe(false);
  });
});
