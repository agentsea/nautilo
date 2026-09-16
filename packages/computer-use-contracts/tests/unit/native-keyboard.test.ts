import { expect, test } from "bun:test";
import { normalizeCuaMacosKey, normalizeCuaMacosHotkey, computerDoInputSchema } from "../../src/native.js";

test("accepts Cua's physical punctuation, modifier keys and aliases without narrower product lists", () => {
  const suffix = "a".repeat(43);
  const target = { version: 1, context: `dctx_${suffix}`, reference: `dtgt_${suffix}` };
  for (const key of ["=", "-", "[", "]", "'", ";", "\\", ",", "/", ".", "`", "+", "plus", "del", "forward_delete", "capslock", "command", "control", "alt", "fn", "enter", "left_arrow", "F12", "Z"]) {
    expect(normalizeCuaMacosKey(key, [])).not.toBeNull();
    const parsed = computerDoInputSchema.safeParse({ operation: { kind: "press_key", target, key, deliveryMode: "foreground" } });
    expect(parsed.success).toBe(true);
  }
  expect(normalizeCuaMacosKey("+", ["command", "alt", "option"])).toEqual({ key: "=", modifiers: ["cmd", "option", "shift"] });
  expect(normalizeCuaMacosKey("forward_delete", ["control"])).toEqual({ key: "del", modifiers: ["ctrl"] });
  for (const key of ["f13", "volume_up", "a;b", "", "ENTER NOW"]) expect(normalizeCuaMacosKey(key, [])).toBeNull();
  expect(normalizeCuaMacosKey("a", ["invented"])).toBeNull();
});

test("hotkeys preserve Cua chords across window, element, pixel and desktop destinations", () => {
  const suffix = "a".repeat(43);
  const target = (prefix: string) => ({ version: 1, context: `dctx_${suffix}`, reference: `${prefix}_${suffix}` });
  const destinations = [
    { target: target("dtgt") },
    { target: target("detgt"), deliveryMode: "foreground" },
    { target: target("dsnap"), coordinateSpace: "window_snapshot_pixels", x: 1, y: 2 },
    { target: target("dsnap"), scope: "desktop" },
  ];
  for (const keys of [["command", "shift", "s"], ["CTRL", "left_arrow"], ["fn", "F12"], ["alt", "option", "cmd", "+"]]) {
    expect(normalizeCuaMacosHotkey(keys)).not.toBeNull();
    for (const destination of destinations) {
      expect(computerDoInputSchema.safeParse({ operation: { kind: "hotkey", keys, ...destination } }).success).toBe(true);
    }
  }
  expect(normalizeCuaMacosHotkey(["COMMAND", "alt", "option", "plus"])).toEqual({ key: "=", modifiers: ["cmd", "option", "shift"] });
  for (const keys of [[], ["s"], ["cmd", "shift"], ["cmd", "a", "b"], ["a", "cmd"], ["invented", "s"], ["cmd", "f13"]]) {
    expect(normalizeCuaMacosHotkey(keys)).toBeNull();
    expect(computerDoInputSchema.safeParse({ operation: { kind: "hotkey", keys, target: target("dtgt") } }).success).toBe(false);
  }
});
