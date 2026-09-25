/** Cua macOS keyboard.rs key_name_to_code at e88e9d899ac5effaeae38619527ebaa46b26ce72. */
export const CUA_MACOS_KEY_NAMES = [
  "return", "enter", "tab", "space", "delete", "backspace", "escape", "esc",
  "command", "cmd", "shift", "capslock", "option", "alt", "control", "ctrl", "fn",
  "home", "pageup", "del", "forward_delete", "end", "pagedown",
  "left", "left_arrow", "right", "right_arrow", "down", "down_arrow", "up", "up_arrow",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  "=", "-", "[", "]", "'", ";", "\\", ",", "/", ".", "`",
  // press_key implements plus as Shift+=; normalize it consistently for HID too.
  "+", "plus",
] as const;

// JSON Schema carries a pattern but no RegExp flags. Encode ASCII case folding
// in the pattern itself so catalogue admission agrees with the Host's schema.
export const CUA_MACOS_KEY_PATTERN = new RegExp(`^(?:${CUA_MACOS_KEY_NAMES.map((key) => key
  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  .replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)).join("|")})$`);
export const CUA_MACOS_KEY_MODIFIERS = ["cmd", "command", "shift", "option", "alt", "ctrl", "control", "fn"] as const;

/** One chord, not a sequence. Reject extra base keys instead of silently dropping them as Cua does. */
export function normalizeCuaMacosHotkey(keys: readonly string[]): { key: string; modifiers: string[] } | null {
  if (keys.length < 2) return null;
  const key = keys.at(-1)!;
  if ((CUA_MACOS_KEY_MODIFIERS as readonly string[]).includes(key.toLowerCase())) return null;
  return normalizeCuaMacosKey(key, keys.slice(0, -1));
}

/** Preserve key meaning while sharing aliases across catalogue, Host and transport. */
export function normalizeCuaMacosKey(key: string, modifiers: readonly string[]): { key: string; modifiers: string[] } | null {
  if (!CUA_MACOS_KEY_PATTERN.test(key)) return null;
  const aliases: Readonly<Record<string, string>> = {
    enter: "return", esc: "escape", backspace: "delete", command: "cmd", control: "ctrl", alt: "option",
    left_arrow: "left", right_arrow: "right", up_arrow: "up", down_arrow: "down", forward_delete: "del",
    plus: "=", "+": "=",
  };
  const normalized: string[] = [];
  for (const modifier of modifiers) {
    const lower = modifier.toLowerCase();
    if (!(CUA_MACOS_KEY_MODIFIERS as readonly string[]).includes(lower)) return null;
    const canonical = aliases[lower] ?? lower;
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  if ((key === "+" || key.toLowerCase() === "plus") && !normalized.includes("shift")) normalized.push("shift");
  return { key: aliases[key.toLowerCase()] ?? key.toLowerCase(), modifiers: normalized };
}
