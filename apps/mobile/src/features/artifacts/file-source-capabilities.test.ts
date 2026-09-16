import { describe, expect, test } from "bun:test";

import { platformCapabilities as nativePlatform } from "@/platform/capabilities.native";
import { platformCapabilities as webPlatform } from "@/platform/capabilities.web";

import { canBrowseComputerFiles } from "./file-source-capabilities";

describe("Files source capabilities", () => {
  test("keeps paired Computer Files native-only", () => {
    expect(canBrowseComputerFiles(nativePlatform)).toBe(true);
    expect(canBrowseComputerFiles(webPlatform)).toBe(false);
  });
});
