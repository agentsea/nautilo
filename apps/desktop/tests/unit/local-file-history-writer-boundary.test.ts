import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

test("legacy journal retains read/migration fixtures but live Desktop producers cannot call its writer", async () => {
  const source = await fs.readFile(
    path.resolve(
      import.meta.dir,
      "../../electron/local-file-history/journal.ts",
    ),
    "utf8",
  );
  for (const forbidden of [
    "async undo(",
    "async redo(",
    "async undoTurn(",
    "restoreFromRevision(",
    "applyTargetState(",
  ]) {
    expect(source).not.toContain(forbidden);
  }
  for (const retained of [
    "recordSuccessfulMutation(",
    "async list(",
    "async pin(",
    "async unpin(",
  ]) {
    expect(source).toContain(retained);
  }

  for (const relative of [
    "../../electron/local-file-dispatch/office.ts",
    "../../electron/local-file-dispatch/commands.ts",
    "../../electron/local-file-dispatch/document-chunks.ts",
    "../../electron/document-mutations/desktop-file-mutation-backend.ts",
    "../../electron/document-mutations/desktop-document-mutation-runtime.ts",
  ]) {
    const producer = await fs.readFile(path.resolve(import.meta.dir, relative), "utf8");
    expect(producer).not.toContain("recordSuccessfulMutation(");
  }
});

test("Desktop Office generators have no direct live-file, V1 journal, lock, or event writer", async () => {
  const source = await fs.readFile(
    path.resolve(import.meta.dir, "../../electron/local-file-dispatch/office.ts"),
    "utf8",
  );
  for (const forbidden of [
    "recordSuccessfulMutation(",
    "adapter.writeFile(",
    "withCanonicalPathLocks(",
    "changeEventForMutation(",
    "onChange?.(",
  ]) {
    expect(source).not.toContain(forbidden);
  }
  expect(source).toContain("commitGeneratedBinaryOutput(");
  expect(source).toContain("ctx.officeCliCommit({");
});
