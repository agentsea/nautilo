import { redactSecrets } from "@nautilo/vault";
import { claudePermissionDetailSchema, type ClaudePermissionDetail } from "@nautilo/relay";

/** Project only reviewed SDK tool fields, before anything leaves the host. */
export function projectClaudePermissionDetail(tool: string, input: Record<string, unknown>, cwd: string): ClaudePermissionDetail {
  const withheld = (reason: "unsupported" | "invalid" | "sensitive"): ClaudePermissionDetail => ({ state: "withheld", reason });
  const fields = tool === "Bash" ? { command: "string", timeout: "number?", run_in_background: "boolean?", dangerouslyDisableSandbox: "boolean?" }
    : tool === "Write" ? { file_path: "string", content: "string" }
    : tool === "Edit" ? { file_path: "string", old_string: "string", new_string: "string", replace_all: "boolean?" }
    : tool === "Read" ? { file_path: "string", offset: "number?", limit: "number?", pages: "string?" }
    : null;
  if (fields === null) return withheld("unsupported");
  try {
    const projected: Record<string, string | number | boolean> = { working_directory: cwd };
    for (const key of Reflect.ownKeys(input)) {
      // Provider-authored descriptions are not action authority and are never displayed.
      if (key === "description" && tool === "Bash") continue;
      if (typeof key !== "string" || !Object.hasOwn(fields, key)) return withheld("unsupported");
    }
    for (const [key, type] of Object.entries(fields)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor && type.endsWith("?")) continue;
      if (!descriptor || !("value" in descriptor)) return withheld("invalid");
      const value: unknown = descriptor.value;
      if (typeof value !== type.replace("?", "")) return withheld("invalid");
      if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) return withheld("invalid");
      if (typeof value === "string" && /[\p{Cs}\p{Cc}\p{Cf}]/u.test(value.replace(/[\t\r\n]/g, ""))) return withheld("invalid");
      projected[key] = value as string | number | boolean;
    }
    // Scan actual field contents, not escaped JSON. Withhold the whole action if
    // any credential is detected: a redacted command is not an exact command.
    for (const value of Object.values(projected)) {
      if (typeof value !== "string") continue;
      const scrubbed = redactSecrets(value);
      if (scrubbed.text !== value || /(?:password|passphrase|secret|token|api[_-]?key|authorization|cookie|private[_ -]?key|\.env\b|\.ssh\b|\.aws\b)/i.test(value)) return withheld("sensitive");
    }
    const detail = { state: "shown", text: `${tool}\n${JSON.stringify(projected, null, 2)}` } as const;
    return claudePermissionDetailSchema.safeParse(detail).success ? Object.freeze(detail) : withheld("invalid");
  } catch { return withheld("invalid"); }
}
