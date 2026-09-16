import { expect, test } from "bun:test";
import { newMediaOperation, parseMediaCommand, parseMediaOperationsResult, mediaOperationActive, type MediaCommand, type MediaOperationsResult } from "./media-agent";
import { inspectVideoMedia, type AgentToolContext } from "./agent-tool-handlers";

test("media commands are closed, require explicit export choice and fence cancellation to an operation", () => {
  const operation = newMediaOperation("import");
  const commands: MediaCommand[] = [{ action: "inspect-media" }, { action: "import-media" }, { action: "export-media", publishToWorkspace: false }, { action: "cancel-import", operationId: operation.id }, { action: "choose-import-rate", operationId: operation.id, decision: "keep-project-rate" }];
  for (const command of commands) expect(parseMediaCommand(command)).toEqual(command);
  for (const command of [{ action: "export-media" }, { action: "import-media", path: "/private/file" }, { action: "export-media", publishToWorkspace: false, overwrite: true }, { action: "cancel-export", operationId: "other" }, { action: "choose-import-rate", operationId: operation.id, decision: "guess" }]) expect(parseMediaCommand(command)).toBeNull();
});
test("operation receipts distinguish requested work from saved work and reject extra authority", () => {
  const operation = newMediaOperation("export");
  const value: MediaOperationsResult = { status: "media_operations", import: null, export: operation, workspaceExportSupported: true, nativeDialogsRequired: true };
  expect(parseMediaOperationsResult(value)).toEqual(value);
  expect(mediaOperationActive(operation)).toBe(true);
  expect(mediaOperationActive({ ...operation, stage: "succeeded" })).toBe(false);
  expect(parseMediaOperationsResult({ ...value, export: { ...operation, token: "hidden" } })).toBeNull();
  expect(parseMediaOperationsResult({ ...value, export: { ...operation, workspace: { status: "published", path: "video.mp4", providerUrl: "secret" } } })).toBeNull();
  expect(parseMediaOperationsResult({ ...value, export: { ...operation, retrySafe: true } })).toBeNull();
});
test("read-only inspection cannot dispatch a mutation even if supplied forged arguments", async () => {
  const commands: unknown[] = [];
  const ctx = { nautiloApp: { session: { command: async (command: unknown) => { commands.push(command); return { status: "unavailable" }; } } } } as unknown as AgentToolContext;
  await inspectVideoMedia({ command: { action: "export-media", publishToWorkspace: true } } as never, ctx);
  expect(commands).toEqual([{ action: "inspect-media" }]);
});
