import { describe, expect, test } from "bun:test";
import {
  findForbiddenExecutionField,
  rejectForbiddenTopLevelArgs,
  validateFileReadEncodingFields,
} from "../../electron/local-file-dispatch/forbidden-payload.ts";

describe("forbidden-payload operation-aware validation (M206)", () => {
  test("file.read allows binary:true and encoding:base64 at top level", () => {
    expect(validateFileReadEncodingFields({ binary: true, encoding: "base64" })).toBeNull();
    expect(
      rejectForbiddenTopLevelArgs({ path: "doc.docx", binary: true }, { allowReadEncoding: true }),
    ).toBeNull();
  });

  test("file.read rejects invalid encoding values", () => {
    expect(validateFileReadEncodingFields({ binary: false })).toContain("binary must be true");
    expect(validateFileReadEncodingFields({ encoding: "utf8" })).toContain("encoding must be base64");
  });

  test("file.write still rejects binary at top level", () => {
    expect(rejectForbiddenTopLevelArgs({ path: "x.txt", content: "a", binary: true })).toContain(
      "binary",
    );
  });

  test("office payloads reject nested binary and argv fields", () => {
    expect(
      findForbiddenExecutionField({
        subkind: "officeRun",
        mode: "read",
        payload: { binary: true },
      }),
    ).toContain("binary");
    expect(
      findForbiddenExecutionField({
        subkind: "officecli",
        command: "batch",
        payload: { argv: ["create"] },
      }),
    ).toContain("argv");
  });
});
