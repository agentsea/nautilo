import { describe, expect, test } from "bun:test";
import type { RelayDispatchRequest } from "@nautilo/relay";

import {
  dispatchCurrentFolderFamily,
} from "../../electron/relay-dispatch/current-folder.ts";
import { FIXED_DESKTOP_DISPATCH_NOT_HANDLED } from "../../electron/relay-dispatch/router.ts";

function request(
  overrides: Partial<RelayDispatchRequest> = {},
): RelayDispatchRequest {
  return {
    correlationId: "d565-current-folder",
    toolName: "unrelated",
    args: {},
    impact: "read-only",
    approvalObtained: false,
    ...overrides,
  };
}

describe("dispatchCurrentFolderFamily", () => {
  test("declines non-matches without touching any Electron port", async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("a non-match must be inert");
    };

    expect(await dispatchCurrentFolderFamily({
      request: request(),
      adoption: { prepare: unavailable, commit: unavailable },
      pairedDirectory: { list: unavailable, select: unavailable },
      selectCurrentFolder: unavailable,
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
  });

  test("forwards Current Folder adoption preparation exactly and fences invalid requests", async () => {
    const seen: Array<{ sourceRootKind: string; relativePath: string }> = [];
    const adoption = {
      prepare: async (input: { sourceRootKind: "workspace" | "current_folder"; relativePath: string }) => {
        seen.push(input);
        return { ok: false as const, code: "source_unavailable" as const, message: "unavailable" };
      },
      commit: async () => ({ ok: false as const, code: "preparation_unknown" as const, message: "unused" }),
    };

    expect(await dispatchCurrentFolderFamily({
      request: request({
        toolName: "nautilo_current_folder_prepare",
        executionClass: "desktop",
        args: { sourceRootKind: "workspace", relativePath: "projects/nautilo" },
      }),
      adoption,
    })).toEqual({
      handled: true,
      result: {
        status: "ok",
        result: { ok: false, code: "source_unavailable", message: "unavailable" },
      },
    });
    expect(seen).toEqual([{ sourceRootKind: "workspace", relativePath: "projects/nautilo" }]);

    expect(await dispatchCurrentFolderFamily({
      request: request({
        toolName: "nautilo_current_folder_prepare",
        executionClass: "fs",
        args: { sourceRootKind: "workspace", relativePath: "projects/nautilo" },
      }),
      adoption,
    })).toEqual({
      handled: true,
      result: {
        status: "error",
        errorCode: "CURRENT_FOLDER_ADOPTION_PREPARE_DENIED",
        error: "Current Folder adoption preparation requires a desktop request.",
      },
    });

    expect(await dispatchCurrentFolderFamily({
      request: request({
        toolName: "nautilo_current_folder_prepare",
        executionClass: "desktop",
        args: { sourceRootKind: "paired_filesystem", relativePath: "projects/nautilo" },
      }),
      adoption,
    })).toMatchObject({
      handled: true,
      result: { errorCode: "CURRENT_FOLDER_ADOPTION_PREPARE_INVALID" },
    });
    expect(seen).toHaveLength(1);
  });

  test("forwards approved adoption commits and refuses unapproved or malformed commits", async () => {
    const seen: string[] = [];
    const adoption = {
      prepare: async () => ({ ok: false as const, code: "source_unavailable" as const, message: "unused" }),
      commit: async ({ preparationId }: { preparationId: string }) => {
        seen.push(preparationId);
        return { ok: false as const, code: "preparation_unknown" as const, message: "expired" };
      },
    };

    expect(await dispatchCurrentFolderFamily({
      request: request({
        toolName: "nautilo_current_folder_commit",
        executionClass: "desktop",
        approvalObtained: true,
        args: { preparationId: "opaque-preparation" },
      }),
      adoption,
    })).toMatchObject({ handled: true, result: { status: "ok", result: { code: "preparation_unknown" } } });
    expect(seen).toEqual(["opaque-preparation"]);

    expect(await dispatchCurrentFolderFamily({
      request: request({
        toolName: "nautilo_current_folder_commit",
        executionClass: "desktop",
        approvalObtained: false,
        args: { preparationId: "opaque-preparation" },
      }),
      adoption,
    })).toMatchObject({ handled: true, result: { errorCode: "CURRENT_FOLDER_ADOPTION_COMMIT_DENIED" } });
    expect(await dispatchCurrentFolderFamily({
      request: request({
        toolName: "nautilo_current_folder_commit",
        executionClass: "desktop",
        approvalObtained: true,
        args: { preparationId: 1 },
      }),
      adoption,
    })).toMatchObject({ handled: true, result: { errorCode: "CURRENT_FOLDER_ADOPTION_COMMIT_INVALID" } });
    expect(seen).toEqual(["opaque-preparation"]);
  });

  test("forwards paired directory listings exactly and rejects invalid bounds before the port", async () => {
    const listed: Array<Record<string, unknown>> = [];
    const pairedDirectory = {
      list: async (input: {
        readonly relativePath: string;
        readonly afterName?: string;
        readonly limit: number;
        readonly includeHidden: boolean;
        readonly query: string;
      }) => {
        listed.push(input);
        return { ok: true as const, entries: [{ name: "Projects" }], nextCursor: "next" };
      },
      select: async () => ({ ok: true as const, label: "unused" }),
    };
    const valid = request({
      toolName: "nautilo_paired_filesystem_directory",
      executionClass: "desktop",
      approvalObtained: true,
      args: {
        rootKind: "paired_filesystem",
        operation: "list_directories",
        relativePath: "root/projects",
        afterName: "previous",
        limit: 50,
        includeHidden: false,
        query: "nautilo",
      },
    });

    expect(await dispatchCurrentFolderFamily({ request: valid, pairedDirectory })).toEqual({
      handled: true,
      result: {
        status: "ok",
        result: { entries: [{ name: "Projects" }], nextCursor: "next" },
      },
    });
    expect(listed).toEqual([{
      relativePath: "root/projects",
      afterName: "previous",
      limit: 50,
      includeHidden: false,
      query: "nautilo",
    }]);

    for (const args of [
      { ...valid.args, limit: 101 },
      { ...valid.args, limit: Number.NaN },
      { ...valid.args, relativePath: "x".repeat(1025) },
      { ...valid.args, query: "q".repeat(201) },
      { ...valid.args, afterName: "bad\0cursor" },
    ]) {
      expect(await dispatchCurrentFolderFamily({
        request: { ...valid, args },
        pairedDirectory,
      })).toMatchObject({
        handled: true,
        result: { errorCode: "PAIRED_FILESYSTEM_DIRECTORY_INVALID" },
      });
    }
    expect(listed).toHaveLength(1);

    expect(await dispatchCurrentFolderFamily({
      request: { ...valid, approvalObtained: false },
      pairedDirectory,
    })).toMatchObject({
      handled: true,
      result: { errorCode: "PAIRED_FILESYSTEM_DIRECTORY_INVALID" },
    });
    expect(await dispatchCurrentFolderFamily({
      request: valid,
      pairedDirectory: {
        ...pairedDirectory,
        list: async () => ({ ok: false as const, code: "unavailable" }),
      },
    })).toEqual({
      handled: true,
      result: {
        status: "error",
        errorCode: "PAIRED_FILESYSTEM_DIRECTORY_REJECTED",
        error: "Paired filesystem directory is unavailable.",
      },
    });
  });

  test("gives paired selection precedence over the ordinary Current Folder selector", async () => {
    let ordinarySelections = 0;
    const pairedSelections: string[] = [];
    const pairedDirectory = {
      list: async () => ({ ok: false as const, code: "unused" }),
      select: async ({ relativePath }: { relativePath: string }) => {
        pairedSelections.push(relativePath);
        return { ok: true as const, label: "Phone Projects" };
      },
    };
    const pairedRequest = request({
      toolName: "nautilo_current_folder_select",
      executionClass: "desktop",
      approvalObtained: true,
      args: { sourceRootKind: "paired_filesystem", relativePath: "phone/projects" },
    });

    expect(await dispatchCurrentFolderFamily({
      request: pairedRequest,
      pairedDirectory,
      selectCurrentFolder: async () => {
        ordinarySelections += 1;
        return { ok: true, label: "must not run" };
      },
    })).toEqual({
      handled: true,
      result: { status: "ok", result: { ok: true, label: "Phone Projects" } },
    });
    expect(pairedSelections).toEqual(["phone/projects"]);
    expect(ordinarySelections).toBe(0);

    expect(await dispatchCurrentFolderFamily({
      request: { ...pairedRequest, approvalObtained: false },
      pairedDirectory,
    })).toMatchObject({
      handled: true,
      result: { errorCode: "CURRENT_FOLDER_SELECTION_DENIED" },
    });
    expect(await dispatchCurrentFolderFamily({ request: pairedRequest })).toEqual({
      handled: true,
      result: {
        status: "error",
        errorCode: "CURRENT_FOLDER_SELECTION_INVALID",
        error: "Paired filesystem selection is unavailable.",
      },
    });

    expect(await dispatchCurrentFolderFamily({
      request: request({
        toolName: "nautilo_current_folder_select",
        executionClass: "desktop",
        approvalObtained: true,
        args: { sourceRootKind: "workspace", relativePath: "projects/nautilo" },
      }),
      selectCurrentFolder: async ({ sourceRootKind, relativePath }) => {
        ordinarySelections += 1;
        expect({ sourceRootKind, relativePath }).toEqual({
          sourceRootKind: "workspace",
          relativePath: "projects/nautilo",
        });
        return { ok: false, error: "selection rejected" };
      },
    })).toEqual({
      handled: true,
      result: {
        status: "error",
        errorCode: "CURRENT_FOLDER_SELECTION_REJECTED",
        error: "selection rejected",
      },
    });
    expect(ordinarySelections).toBe(1);
  });
});
