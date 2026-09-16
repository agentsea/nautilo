import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "bun:test";
import { useWorkSurfaceEventTargets } from "../../../src/layouts/use-work-surface-event-target";

beforeAll(() => {
  reapplyHappyDomGlobals();
});

describe("useWorkSurfaceEventTargets", () => {
  it("keeps the artifact subscription stable when reconnect refreshes the reader", () => {
    const { result, rerender } = renderHook(
      ({ reloadToken }) =>
        useWorkSurfaceEventTargets({
          kind: "artifact" as const,
          id: "artifact-a",
          path: "draft.md",
          mimeType: "text/markdown",
          roomId: "room-a",
          reloadToken,
        }),
      { initialProps: { reloadToken: 0 } },
    );
    const initialTarget = result.current.artifact;

    rerender({ reloadToken: 1 });

    expect(result.current.artifact).toBe(initialTarget);
  });

  it("keeps the local-file subscription stable when reconnect refreshes the reader", () => {
    const { result, rerender } = renderHook(
      ({ reloadToken }) =>
        useWorkSurfaceEventTargets({
          kind: "fs" as const,
          path: "/workspace/draft.md",
          rootPath: "/workspace",
          reloadToken,
        }),
      { initialProps: { reloadToken: 0 } },
    );
    const initialTarget = result.current.fs;

    rerender({ reloadToken: 1 });

    expect(result.current.fs).toBe(initialTarget);
  });

  it("changes subscription identity when the open document changes", () => {
    const { result, rerender } = renderHook(
      ({ id }) =>
        useWorkSurfaceEventTargets({
          kind: "artifact" as const,
          id,
          path: `${id}.md`,
          mimeType: "text/markdown",
          roomId: "room-a",
        }),
      { initialProps: { id: "artifact-a" } },
    );
    const initialTarget = result.current.artifact;

    rerender({ id: "artifact-b" });

    expect(result.current.artifact).not.toBe(initialTarget);
    expect(result.current.artifact?.id).toBe("artifact-b");
  });
});
