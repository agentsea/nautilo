import { expect, mock, test } from "bun:test";
let platform = "ios";
let available = true;
let calls = 0;
let finish!: () => void;
mock.module("react-native", () => ({ Platform: { get OS() { return platform; } } }));
mock.module("expo-sharing", () => ({
  isAvailableAsync: async () => available,
  shareAsync: () => { calls++; return new Promise<void>((resolve) => { finish = resolve; }); },
}));
const { canShareOriginalFile, shareOriginalFile } = await import("./original-file-share.native");

test("only iOS uses the platform service completion as a temporary-source lifetime boundary", async () => {
  expect(canShareOriginalFile()).toBe(true);
  let settled = false;
  const operation = shareOriginalFile("file:///synthetic/original.pdf", "application/pdf").then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toBe(1);
  expect(settled).toBe(false);
  finish(); await operation;
  expect(settled).toBe(true);
  platform = "android";
  expect(canShareOriginalFile()).toBe(false);
  expect(await shareOriginalFile("file:///synthetic/original.pdf", "application/pdf").catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(calls).toBe(1);
  platform = "ios"; available = false;
  expect(await shareOriginalFile("file:///synthetic/original.pdf", "application/pdf").catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(calls).toBe(1);
});
