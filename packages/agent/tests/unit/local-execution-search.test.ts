import { expect, test } from "bun:test";
import { createWriteStdinTool, writeStdinSchema } from "../../src/tools/local-execution/local-execution";
import { isLocalExecutionReadArgs } from "@nautilo/types";
const args = { session_id: "execution", search: "界🌊", cursor: 0 };
test("the actual tool schema exposes search only with the projected exact-peer capability", () => {
  for (const relayCapabilities of [undefined, {}, { canSearchLocalExecutionOutput: false }, { canObserveLocalExecution: true }]) {
    const tool = createWriteStdinTool({ relayCapabilities });
    expect(tool.schema.safeParse(args).success).toBeFalse();
    expect(tool.schema.safeParse({ session_id: "execution" }).success).toBeTrue();
    expect(tool.schema.safeParse({ session_id: "execution", chars: "", cancel: true }).success).toBeFalse();
  }
  expect(createWriteStdinTool({ relayCapabilities: { canSearchLocalExecutionOutput: true } }).schema.safeParse(args).success).toBeTrue();
});
test("authoritative schema and read policy agree on closed search arguments", () => {
  expect(writeStdinSchema.safeParse(args).success).toBeTrue();
  expect(writeStdinSchema.safeParse({ ...args, search: "\ufeffneedle" }).success).toBeTrue();
  expect(isLocalExecutionReadArgs({ ...args, search: "\ufeffneedle" })).toBeTrue();
  for (const bad of [{ ...args, search: "" }, { ...args, search: "\udfff" }, { ...args, chars: "" },
    { ...args, cancel: false }, { ...args, yield_time_ms: 0 }, { ...args, root: "/path/to/elsewhere" }]) {
    expect(writeStdinSchema.safeParse(bad).success).toBeFalse();
    expect(isLocalExecutionReadArgs(bad)).toBeFalse();
  }
});
