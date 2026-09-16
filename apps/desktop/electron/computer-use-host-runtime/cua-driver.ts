import { isAbsolute, join } from "node:path";

/** Electron only locates its immutable bundled driver; Host owns its lifecycle. */
export function resolveBundledCuaDriverPath(options: Readonly<{
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
}>): string | null {
  return options.platform === "darwin" && options.isPackaged && isAbsolute(options.resourcesPath)
    ? join(options.resourcesPath, "tools-cua", "cua-driver")
    : null;
}
