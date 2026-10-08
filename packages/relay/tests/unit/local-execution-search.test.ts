import { expect, test } from "bun:test";
import { isRelayLocalExecutionSearchAllowed, projectRelayCapabilitiesForProtocol, RELAY_MIN_SUPPORTED_PROTOCOL_VERSION, RELAY_PROTOCOL_VERSION } from "../../src/index";
import { isLocalExecutionReadArgs } from "@nautilo/types";
const args = { session_id: "execution", search: "界🌊", cursor: 0, max_output_bytes: 4 };
test("search capability is absent on every older offered protocol and does not remove ordinary reads", () => {
  for (let version = RELAY_MIN_SUPPORTED_PROTOCOL_VERSION; version < 26; version++) {
    expect(projectRelayCapabilitiesForProtocol({ profile: "desktop-agent", canSearchLocalExecutionOutput: true, canExecuteLocal: true }, version).canSearchLocalExecutionOutput).toBeUndefined();
    expect(isRelayLocalExecutionSearchAllowed("write_stdin", args, { canSearchLocalExecutionOutput: true }, version)).toBeFalse();
    expect(isRelayLocalExecutionSearchAllowed("write_stdin", { session_id: "execution" }, {}, version)).toBeTrue();
  }
  expect(RELAY_PROTOCOL_VERSION).toBe(28);
  expect(projectRelayCapabilitiesForProtocol({ profile: "desktop-agent", canSearchLocalExecutionOutput: true }, 26).canSearchLocalExecutionOutput).toBeTrue();
  expect(isRelayLocalExecutionSearchAllowed("write_stdin", args, { canSearchLocalExecutionOutput: true }, 26)).toBeTrue();
  expect(isRelayLocalExecutionSearchAllowed("write_stdin", args, {}, 26)).toBeFalse();
});
test("the pure read classifier denies ambiguous search mutations, waits, malformed literals and hidden selectors", () => {
  expect(isLocalExecutionReadArgs(args)).toBeTrue();
  for (const bad of [{ ...args, chars: "" }, { ...args, cancel: false }, { ...args, yield_time_ms: 0 },
    { ...args, chars: "input" }, { ...args, cancel: true }, { ...args, search: "" }, { ...args, search: "\ud800" },
    { ...args, cursor: -1 }, { ...args, owner: "foreign" }]) {
    expect(isLocalExecutionReadArgs(bad)).toBeFalse();
    expect(isRelayLocalExecutionSearchAllowed("write_stdin", bad, { canSearchLocalExecutionOutput: true }, 26)).toBeFalse();
  }
  expect(isRelayLocalExecutionSearchAllowed("exec_command", args, { canSearchLocalExecutionOutput: true }, 26)).toBeFalse();
});
