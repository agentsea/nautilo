/**
 * M067D Phase 3.2 — fail CI when a new `file` command lands in the schema
 * without either a matrix row (D079 ten-command grid) or an explicit
 * exclusion entry (specialized integration elsewhere).
 */

import { describe, expect, test } from "bun:test";
import {
  FILE_TOOL_ALL_COMMAND_NAMES,
  listFileToolCommandNames,
} from "../../src/tools/file/schema";
import {
  FILE_TOOL_MATRIX_COVERED_COMMANDS,
  FILE_TOOL_MATRIX_EXCLUDED_FROM_MATRIX,
  FILE_TOOL_NATIVE_SEARCH_MATRIX_COMMANDS,
} from "../file-tool-matrix-fixture";

describe("file-tool-matrix guard (M067D)", () => {
  test("listFileToolCommandNames matches FILE_TOOL_ALL_COMMAND_NAMES", () => {
    expect(listFileToolCommandNames()).toEqual([...FILE_TOOL_ALL_COMMAND_NAMES]);
  });

  test("legacy, native-search, and specialized sets partition all commands", () => {
    const covered = new Set<string>(FILE_TOOL_MATRIX_COVERED_COMMANDS);
    const nativeSearch = new Set<string>(FILE_TOOL_NATIVE_SEARCH_MATRIX_COMMANDS);
    const excluded = new Set<string>(FILE_TOOL_MATRIX_EXCLUDED_FROM_MATRIX);
    for (const c of covered) {
      expect(nativeSearch.has(c)).toBe(false);
      expect(excluded.has(c)).toBe(false);
    }
    for (const c of nativeSearch) expect(excluded.has(c)).toBe(false);
    for (const cmd of FILE_TOOL_ALL_COMMAND_NAMES) {
      expect(Number(covered.has(cmd)) + Number(nativeSearch.has(cmd)) + Number(excluded.has(cmd))).toBe(1);
    }
    expect(covered.size + nativeSearch.size + excluded.size).toBe(FILE_TOOL_ALL_COMMAND_NAMES.length);
  });
});
