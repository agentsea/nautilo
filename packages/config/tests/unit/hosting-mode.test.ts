import { expect, test } from "bun:test";
import { getHostingMode, isCloudMode } from "../../src/hosting-mode";

test("defaults to local when unset", () => {
  expect(getHostingMode({})).toBe("local");
});
test("explicit local", () => {
  expect(getHostingMode({ NAUTILO_HOSTING_MODE: "local" })).toBe("local");
});
test("explicit cloud", () => {
  expect(isCloudMode({ NAUTILO_HOSTING_MODE: "cloud" })).toBe(true);
});
test("invalid throws", () => {
  expect(() => getHostingMode({ NAUTILO_HOSTING_MODE: "wat" })).toThrow();
});
