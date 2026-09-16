import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

const runMiniAppConversion = mock(async () => ({ ok: true, result: { status: "exported" } }));

mock.module("../lib/api", () => ({
  apiClient: { runMiniAppConversion },
}));

const { useConversionRunner } = await import("./use-conversion-runner");

// Harness that surfaces the hook's `run` and the latest `conflictDialog`
// element so tests can drive the overwrite / rename / cancel loop by invoking
// the dialog's props directly — deterministic and independent of the DOM input
// (whose value tracking is flaky under happy-dom).
type RunFn = ReturnType<typeof useConversionRunner>["run"];
let latestRun: RunFn | null = null;
let latestDialogProps: {
  onOverwrite: () => void;
  onRename: (name: string) => void;
  onCancel: () => void;
  onConfirm?: (selection?: { filename: string; workspaceDestination: "current" | "source" }) => void;
  workspaceDestination?: { filename: string; extension: string; initialLocation: "current" | "source" };
} | null = null;

function Harness() {
  const { run, conflictDialog } = useConversionRunner();
  latestRun = run;
  latestDialogProps = conflictDialog
    ? ((conflictDialog as ReactElement).props as typeof latestDialogProps)
    : null;
  return conflictDialog;
}

const baseExportBody = {
  actionId: "export-docx",
  direction: "export" as const,
  source: { surface: "workspace" as const, path: "a.html" },
  target: { surface: "workspace" as const, path: "docs/b.docx" },
  roomId: "33333333-3333-4333-8333-333333333333",
};

function conflictOnce() {
  runMiniAppConversion.mockImplementationOnce(async () => ({
    ok: true,
    result: {
      ok: true,
      status: "conflict",
      target: { surface: "workspace", path: "docs/b.docx" },
      message: 'A file already exists at "docs/b.docx".',
    },
  }));
}

describe("useConversionRunner conflict loop", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
    runMiniAppConversion.mockClear();
    runMiniAppConversion.mockImplementation(async () => ({
      ok: true,
      result: { ok: true, status: "exported", displayPath: "docs/b.docx" },
    }));
    latestRun = null;
    latestDialogProps = null;
  });

  test("overwrite retries the same target with overwrite:true", async () => {
    conflictOnce();
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());

    let outcome: unknown;
    await act(async () => {
      void latestRun!("app-1", baseExportBody).then((o) => {
        outcome = o;
      });
    });
    await waitFor(() => expect(latestDialogProps).not.toBeNull());
    await act(async () => {
      latestDialogProps!.onOverwrite();
    });
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(2));

    expect(runMiniAppConversion.mock.calls[1]?.[1]).toMatchObject({
      overwrite: true,
      target: { surface: "workspace", path: "docs/b.docx" },
      roomId: "33333333-3333-4333-8333-333333333333",
    });
    expect(outcome).toEqual({ status: "ok", result: { ok: true, status: "exported", displayPath: "docs/b.docx" } });
  });

  test("rename retries at the new basename with overwrite:false", async () => {
    conflictOnce();
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());

    let outcome: unknown;
    await act(async () => {
      void latestRun!("app-1", baseExportBody).then((o) => {
        outcome = o;
      });
    });
    await waitFor(() => expect(latestDialogProps).not.toBeNull());
    await act(async () => {
      latestDialogProps!.onRename("renamed.docx");
    });
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(2));

    expect(runMiniAppConversion.mock.calls[1]?.[1]).toMatchObject({
      overwrite: false,
      target: { surface: "workspace", path: "docs/renamed.docx" },
      roomId: "33333333-3333-4333-8333-333333333333",
    });
    expect((outcome as { status: string }).status).toBe("ok");
  });

  test("cancel resolves without a second call", async () => {
    conflictOnce();
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());

    let outcome: unknown;
    await act(async () => {
      void latestRun!("app-1", baseExportBody).then((o) => {
        outcome = o;
      });
    });
    await waitFor(() => expect(latestDialogProps).not.toBeNull());
    await act(async () => {
      latestDialogProps!.onCancel();
    });
    await waitFor(() => expect(outcome).toEqual({ status: "cancelled" }));

    expect(runMiniAppConversion).toHaveBeenCalledTimes(1);
  });

  test("no conflict resolves ok on the first call", async () => {
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());

    const outcome = await latestRun!("app-1", baseExportBody);
    expect(outcome).toEqual({ status: "ok", result: { ok: true, status: "exported", displayPath: "docs/b.docx" } });
    expect(runMiniAppConversion).toHaveBeenCalledTimes(1);
  });

  test("confirms warnings and preserves the acknowledgement through a conflict retry", async () => {
    const sourceSha256 = "a".repeat(64);
    runMiniAppConversion
      .mockImplementationOnce(async () => ({
        ok: true,
        result: { status: "confirmation_required", sourceSha256, warnings: ["Font substituted"] },
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        result: {
          status: "conflict",
          target: { surface: "workspace", path: "docs/b.docx" },
        },
      }));
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());

    let outcome: unknown;
    await act(async () => {
      void latestRun!("app-1", baseExportBody).then((value) => { outcome = value; });
    });
    await waitFor(() => expect(latestDialogProps?.onConfirm).toBeFunction());
    await act(async () => latestDialogProps!.onConfirm!());
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(2));
    expect(runMiniAppConversion.mock.calls[1]?.[1]).toMatchObject({ acknowledgedSourceSha256: sourceSha256 });

    await waitFor(() => expect(latestDialogProps?.onOverwrite).toBeFunction());
    await act(async () => latestDialogProps!.onOverwrite());
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(3));
    expect(runMiniAppConversion.mock.calls[2]?.[1]).toMatchObject({
      acknowledgedSourceSha256: sourceSha256,
      overwrite: true,
    });
    expect((outcome as { status: string }).status).toBe("ok");
  });

  test("warning destination defaults to current workspace and accepts a renamed filename", async () => {
    const sourceSha256 = "c".repeat(64);
    runMiniAppConversion.mockImplementationOnce(async () => ({
      ok: true,
      result: { status: "confirmation_required", sourceSha256, warnings: ["Raster PDF"] },
    }));
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());
    void latestRun!("app-1", {
      ...baseExportBody,
      source: { surface: "workspace", path: "imports/deck.presentation.html" },
      target: { surface: "workspace", path: "deck.pdf" },
      workspaceDestination: "current",
    }, { selectWorkspaceDestination: true });
    await waitFor(() => expect(latestDialogProps?.workspaceDestination).toEqual({
      filename: "deck.pdf", extension: ".pdf", initialLocation: "current",
    }));
    await act(async () => latestDialogProps!.onConfirm!({
      filename: "renamed.pdf", workspaceDestination: "current",
    }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(2));
    expect(runMiniAppConversion.mock.calls[1]?.[1]).toMatchObject({
      target: { surface: "workspace", path: "renamed.pdf" },
      workspaceDestination: "current",
      acknowledgedSourceSha256: sourceSha256,
    });
  });

  test("warning destination can create beside the source and persists through a renewed warning", async () => {
    const firstSha = "d".repeat(64);
    const nextSha = "e".repeat(64);
    runMiniAppConversion
      .mockImplementationOnce(async () => ({ ok: true, result: {
        status: "confirmation_required", sourceSha256: firstSha, warnings: ["First"],
      } }))
      .mockImplementationOnce(async () => ({ ok: true, result: {
        status: "confirmation_required", sourceSha256: nextSha, warnings: ["Source changed"],
      } }));
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());
    void latestRun!("app-1", {
      ...baseExportBody,
      source: { surface: "workspace", path: "imports/deck.presentation.html" },
      target: { surface: "workspace", path: "deck.pdf" },
      workspaceDestination: "current",
    }, { selectWorkspaceDestination: true });
    await waitFor(() => expect(latestDialogProps?.onConfirm).toBeFunction());
    await act(async () => latestDialogProps!.onConfirm!({ filename: "copy.pdf", workspaceDestination: "source" }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(2));
    expect(runMiniAppConversion.mock.calls[1]?.[1]).toMatchObject({
      target: { surface: "workspace", path: "imports/copy.pdf" }, workspaceDestination: "source",
    });
    await waitFor(() => expect(latestDialogProps?.workspaceDestination).toEqual({
      filename: "copy.pdf", extension: ".pdf", initialLocation: "source",
    }));
    await act(async () => latestDialogProps!.onConfirm!({ filename: "copy.pdf", workspaceDestination: "source" }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(3));
    expect(runMiniAppConversion.mock.calls[2]?.[1]).toMatchObject({
      target: { surface: "workspace", path: "imports/copy.pdf" },
      workspaceDestination: "source",
      acknowledgedSourceSha256: nextSha,
    });
  });

  test("changing the warning destination clears a prior overwrite decision", async () => {
    const sourceSha256 = "f".repeat(64);
    conflictOnce();
    runMiniAppConversion.mockImplementationOnce(async () => ({ ok: true, result: {
      status: "confirmation_required", sourceSha256, warnings: ["Source changed"],
    } }));
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());
    void latestRun!("app-1", {
      ...baseExportBody,
      source: { surface: "workspace", path: "imports/deck.presentation.html" },
      target: { surface: "workspace", path: "deck.pdf" },
      workspaceDestination: "current",
    }, { selectWorkspaceDestination: true });
    await waitFor(() => expect(latestDialogProps?.onOverwrite).toBeFunction());
    await act(async () => latestDialogProps!.onOverwrite());
    await waitFor(() => expect(latestDialogProps?.onConfirm).toBeFunction());
    await act(async () => latestDialogProps!.onConfirm!({
      filename: "different.pdf", workspaceDestination: "source",
    }));
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(3));
    expect(runMiniAppConversion.mock.calls[2]?.[1]).toMatchObject({
      target: { surface: "workspace", path: "imports/different.pdf" },
      workspaceDestination: "source",
      overwrite: false,
      acknowledgedSourceSha256: sourceSha256,
    });
  });

  test("rejects malformed confirmation results", async () => {
    runMiniAppConversion.mockImplementationOnce(async () => ({
      ok: true,
      result: { status: "confirmation_required", sourceSha256: "BAD", warnings: ["warning"] },
    }));
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());
    expect(await latestRun!("app-1", baseExportBody)).toEqual({
      status: "error",
      message: "The conversion returned an invalid confirmation request.",
    });
    expect(latestDialogProps).toBeNull();
  });

  test("unmount cancels a pending warning confirmation", async () => {
    runMiniAppConversion.mockImplementationOnce(async () => ({
      ok: true,
      result: {
        status: "confirmation_required",
        sourceSha256: "b".repeat(64),
        warnings: ["warning"],
      },
    }));
    const view = render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());
    let outcome: unknown;
    await act(async () => {
      void latestRun!("app-1", baseExportBody).then((value) => { outcome = value; });
    });
    await waitFor(() => expect(latestDialogProps?.onConfirm).toBeFunction());
    view.unmount();
    await waitFor(() => expect(outcome).toEqual({ status: "cancelled" }));
    expect(runMiniAppConversion).toHaveBeenCalledTimes(1);
  });

  test("unmount before a pending response prevents a late dialog", async () => {
    let resolveResponse!: (value: { ok: true; result: unknown }) => void;
    runMiniAppConversion.mockImplementationOnce(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    const view = render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());
    let outcome: unknown;
    await act(async () => {
      void latestRun!("app-1", baseExportBody).then((value) => { outcome = value; });
    });
    await waitFor(() => expect(runMiniAppConversion).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      resolveResponse({
        ok: true,
        result: {
          status: "confirmation_required",
          sourceSha256: "c".repeat(64),
          warnings: ["late warning"],
        },
      });
    });
    await waitFor(() => expect(outcome).toEqual({ status: "cancelled" }));
    expect(latestDialogProps).toBeNull();
  });

  test("a concurrent run cannot replace the active warning resolver", async () => {
    runMiniAppConversion.mockImplementationOnce(async () => ({
      ok: true,
      result: {
        status: "confirmation_required",
        sourceSha256: "d".repeat(64),
        warnings: ["warning"],
      },
    }));
    render(<Harness />);
    await waitFor(() => expect(latestRun).not.toBeNull());
    let firstOutcome: unknown;
    await act(async () => {
      void latestRun!("app-1", baseExportBody).then((value) => { firstOutcome = value; });
    });
    await waitFor(() => expect(latestDialogProps?.onConfirm).toBeFunction());

    expect(await latestRun!("app-2", baseExportBody)).toEqual({
      status: "error",
      message: "Another conversion is already in progress.",
    });
    expect(runMiniAppConversion).toHaveBeenCalledTimes(1);

    await act(async () => latestDialogProps!.onConfirm!());
    await waitFor(() => expect(firstOutcome).toMatchObject({ status: "ok" }));
    expect(runMiniAppConversion).toHaveBeenCalledTimes(2);
  });
});


test("abort cancels pending confirmation without writing a copy", async () => {
  reapplyHappyDomGlobals(); runMiniAppConversion.mockClear();
  runMiniAppConversion.mockImplementationOnce(async () => ({ ok: true, result: {
    status: "confirmation_required", sourceSha256: "a".repeat(64), warnings: ["Raster PDF"],
  } }));
  render(<Harness />);
  const abort = new AbortController(); let outcome: unknown;
  await act(async () => { void latestRun!("app-1", baseExportBody, { signal: abort.signal }).then(value => { outcome = value; }); });
  await waitFor(() => expect(latestDialogProps?.onConfirm).toBeDefined());
  await act(async () => { abort.abort(); });
  await waitFor(() => expect(outcome).toEqual({ status: "cancelled" }));
  expect(runMiniAppConversion).toHaveBeenCalledTimes(1);
  expect(latestDialogProps).toBeNull();
});
