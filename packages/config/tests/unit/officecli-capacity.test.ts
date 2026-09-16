import { describe, expect, test } from "bun:test";
import {
  isOfficeTransformationProfileId,
  OFFICECLI_RUNNER_OUTPUT_LIMITS,
  OFFICECLI_STDIO_MAX_BYTES,
  OFFICE_TRANSFORMATION_PROFILE_IDS,
  selectOfficeTransformProfile,
} from "../../src/officecli/capacity";

describe("Office transformation profile declarations", () => {
  test("owns the temporary runner envelope in one policy module", () => {
    expect(OFFICECLI_STDIO_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(OFFICECLI_RUNNER_OUTPUT_LIMITS).toEqual({
      stdout: OFFICECLI_STDIO_MAX_BYTES,
      stderr: OFFICECLI_STDIO_MAX_BYTES,
    });
  });

  test("exports the locked Writer DOCX and Sheets XLSX profiles", () => {
    expect(OFFICE_TRANSFORMATION_PROFILE_IDS).toEqual([
      "writer-import-v1",
      "writer-export-v1",
      "sheets-import-v1",
      "sheets-export-v1",
    ]);
  });

  test("recognizes only registered profile ids", () => {
    expect(isOfficeTransformationProfileId("writer-import-v1")).toBe(true);
    expect(isOfficeTransformationProfileId("writer-export-v1")).toBe(true);
    expect(isOfficeTransformationProfileId("sheets-import-v1")).toBe(true);
    expect(isOfficeTransformationProfileId("sheets-export-v1")).toBe(true);
    expect(isOfficeTransformationProfileId("writer-import-v2")).toBe(false);
    expect(isOfficeTransformationProfileId("import-docx")).toBe(false);
  });

  test("selects the locked profile only for a registered semantic app-tool transformation", () => {
    expect(selectOfficeTransformProfile({
      appId: "nautilo-writer",
      toolId: "import-docx",
      format: "docx",
      operation: "import",
    })).toEqual({
      id: "writer-import-v1",
      intent: { format: "docx", operation: "import" },
    });
    expect(selectOfficeTransformProfile({
      appId: "nautilo-writer",
      toolId: "import-docx",
      format: "docx",
      operation: "export",
    })).toBeUndefined();

    expect(selectOfficeTransformProfile({
      appId: "nautilo-spreadsheet",
      toolId: "import-xlsx",
      format: "xlsx",
      operation: "import",
    })).toEqual({
      id: "sheets-import-v1",
      intent: { format: "xlsx", operation: "import" },
    });
    expect(selectOfficeTransformProfile({
      appId: "nautilo-spreadsheet",
      toolId: "export-xlsx",
      format: "xlsx",
      operation: "export",
    })).toEqual({
      id: "sheets-export-v1",
      intent: { format: "xlsx", operation: "export" },
    });
    expect(selectOfficeTransformProfile({
      appId: "nautilo-writer",
      toolId: "import-docx",
      format: "xlsx",
      operation: "import",
    })).toBeUndefined();
  });

  test("does not expose mutable registry objects to admission callers", () => {
    const input = {
      appId: "nautilo-writer",
      toolId: "import-docx",
      format: "docx",
      operation: "import",
    } as const;

    const first = selectOfficeTransformProfile(input);
    const second = selectOfficeTransformProfile(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.intent).not.toBe(second?.intent);
  });
});
