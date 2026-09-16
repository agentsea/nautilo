import "../../../../../../tests/bun-dom-preload.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useExplorerSort } from "../useExplorerSort";

const STORAGE_KEY = "nautilo.workbench.explorer.sort.v1";

describe("useExplorerSort", () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  test("defaults to recent desc", () => {
    const { result } = renderHook(() => useExplorerSort());
    expect(result.current.sort).toEqual({ mode: "recent", dir: "desc" });
  });

  test("persists mode and dir to localStorage", () => {
    const { result } = renderHook(() => useExplorerSort());
    act(() => {
      result.current.setMode("alpha");
      result.current.setDir("asc");
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { v: number; mode: string; dir: string };
    expect(parsed.v).toBe(1);
    expect(parsed.mode).toBe("alpha");
    expect(parsed.dir).toBe("asc");
  });

  test("reads persisted sort on mount", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, mode: "alpha", dir: "asc" }),
    );
    const { result } = renderHook(() => useExplorerSort());
    expect(result.current.sort).toEqual({ mode: "alpha", dir: "asc" });
  });

  test("toggleDir flips direction", () => {
    const { result } = renderHook(() => useExplorerSort());
    act(() => {
      result.current.toggleDir();
    });
    expect(result.current.sort.dir).toBe("asc");
  });
});
