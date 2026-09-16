import { describe, expect, test } from "bun:test";

import {
  applySelectedCurrentFolderReadDefaults,
  selectedCurrentFolderReadInputError,
} from "../../src/tools/file/read-only-current-defaults";

describe("selected Current Folder read defaults", () => {
  test("routes root-capable read-only commands to the selected Current Folder", () => {
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "grep", query: "ipcMain\\.handle" },
      "/Users/Shared/LanternHouse/code/nautilo",
    )).toEqual({
      command: "grep",
      query: "ipcMain\\.handle",
      path: ".",
      zone: "current",
    });
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "glob", pattern: "**/*", zone: "current" },
      "/Users/Shared/LanternHouse/code/nautilo",
    )).toEqual({
      command: "glob",
      pattern: "**/*",
      path: ".",
      zone: "current",
    });
  });

  test("defaults a concrete read path without inventing a missing filename", () => {
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "read", path: "package.json" },
      "/repo",
    )).toEqual({ command: "read", path: "package.json", zone: "current" });
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "read" },
      "/repo",
    )).toEqual({ command: "read" });
  });

  test("repairs the flat-schema grep pattern alias without inventing search intent", () => {
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "grep", pattern: "dangerouslySetInnerHTML" },
      "/repo",
    )).toEqual({
      command: "grep",
      pattern: "dangerouslySetInnerHTML",
      query: "dangerouslySetInnerHTML",
      path: ".",
      zone: "current",
    });
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "grep", pattern: "ignored", query: "canonical" },
      "/repo",
    )).toMatchObject({ query: "canonical" });
  });

  test("gives one exact correction when semantic read intent cannot be inferred", () => {
    expect(selectedCurrentFolderReadInputError(
      applySelectedCurrentFolderReadDefaults({ command: "read", lineRange: { from: 10, to: 20 } }, "/repo"),
      "/repo",
    )).toContain("No current file is implicit");
    expect(selectedCurrentFolderReadInputError(
      applySelectedCurrentFolderReadDefaults({ command: "grep" }, "/repo"),
      "/repo",
    )).toContain("requires a non-empty query");
    expect(selectedCurrentFolderReadInputError(
      applySelectedCurrentFolderReadDefaults({ command: "grep", pattern: "needle" }, "/repo"),
      "/repo",
    )).toBeNull();
  });

  test("preserves explicit routing and never defaults mutations", () => {
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "grep", query: "needle", path: "src", zone: "workspace" },
      "/repo",
    )).toEqual({
      command: "grep",
      query: "needle",
      path: "src",
      zone: "workspace",
    });
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "write", path: "out.txt", content: "x" },
      "/repo",
    )).toEqual({ command: "write", path: "out.txt", content: "x" });
  });

  test("does not manufacture Current Folder routing without a selection", () => {
    expect(applySelectedCurrentFolderReadDefaults(
      { command: "grep", query: "needle" },
      null,
    )).toEqual({ command: "grep", query: "needle" });
  });
});
