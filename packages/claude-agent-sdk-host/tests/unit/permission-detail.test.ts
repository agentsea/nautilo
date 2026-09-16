import { expect, test } from "bun:test";
import { projectClaudePermissionDetail } from "../../src/permission-detail";

test("reviewed SDK actions retain exact Unicode, multiline changes and execution flags", () => {
  for (const [tool, input] of [
    ["Bash", { command: "printf 'café 日本語\\n'\nnode --test", run_in_background: true, dangerouslyDisableSandbox: true, timeout: 30000 }],
    ["Write", { file_path: "/workspace/hello.mjs", content: "export const hello = '🌍';\n" }],
    ["Edit", { file_path: "/workspace/hello.mjs", old_string: "Hello", new_string: "Bonjour", replace_all: true }],
    ["Read", { file_path: "/workspace/hello.mjs", offset: 1, limit: 20 }],
  ] as const) {
    const result = projectClaudePermissionDetail(tool, input, "/workspace");
    expect(result.state).toBe("shown");
    if (result.state === "shown") expect(JSON.parse(result.text.slice(tool.length + 1))).toEqual({ working_directory: "/workspace", ...input });
  }
});

test("withholds whole sensitive actions, never a misleading redacted command", () => {
  for (const command of ["TOKEN=short node foo", "curl -H 'Authorization: Bearer syntheticcredential12345' url", "cat .env", "echo sk-ant-abcdefghijklmnopqrstuvwxy", "echo password=1234"]) {
    expect(projectClaudePermissionDetail("Bash", { command }, "/workspace")).toEqual({ state: "withheld", reason: "sensitive" });
  }
  expect(projectClaudePermissionDetail("Write", { file_path: "/workspace/config", content: "password: abc" }, "/workspace").state).toBe("withheld");
});

test("does not infer unknown input, invoke getters, accept spoofing controls or silently truncate", () => {
  expect(projectClaudePermissionDetail("Unknown", {}, "/workspace")).toEqual({ state: "withheld", reason: "unsupported" });
  expect(projectClaudePermissionDetail("Bash", { command: "echo okay", extra: true }, "/workspace").state).toBe("withheld");
  let getterCalls = 0;
  expect(projectClaudePermissionDetail("Bash", { get command() { getterCalls++; return "echo okay"; } }, "/workspace").state).toBe("withheld");
  expect(getterCalls).toBe(0);
  for (const command of ["bad\ud800", "bad\u001b", "bad\u202e"]) expect(projectClaudePermissionDetail("Bash", { command }, "/workspace").state).toBe("withheld");
  const content = "a".repeat(200000);
  const result = projectClaudePermissionDetail("Write", { file_path: "/workspace/a", content }, "/workspace");
  expect(result.state).toBe("shown");
  if (result.state === "shown") expect(JSON.parse(result.text.slice(6)) as unknown).toMatchObject({ content });
});
