import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("electron", () => ({
  app: { getPath: () => os.tmpdir() },
}));

const originalHidden = process.env["NAUTILO_SMOKE_HIDDEN"];
const originalRoot = process.env["NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT"];

afterEach(() => {
  if (originalHidden === undefined) delete process.env["NAUTILO_SMOKE_HIDDEN"];
  else process.env["NAUTILO_SMOKE_HIDDEN"] = originalHidden;
  if (originalRoot === undefined) delete process.env["NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT"];
  else process.env["NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT"] = originalRoot;
});

async function recentServersFilePath(): Promise<string> {
  return (await import("../../electron/paths")).recentServersFilePath();
}

describe("D514 smoke-only Family-C boot-state isolation", () => {
  test("uses a harness-private 0700 root for every boot-reachable Family-C path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-d514-smoke-"));
    fs.chmodSync(root, 0o700);
    process.env["NAUTILO_SMOKE_HIDDEN"] = "1";
    process.env["NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT"] = root;
    try {
      const paths = await import("../../electron/paths");
      expect(paths.recentFoldersFilePath()).toBe(path.join(root, "recent-current-folders.json"));
      expect(paths.legacyRecentFoldersFilePath()).toBe(path.join(root, "recent-workspaces.json"));
      expect(paths.recentServersFilePath()).toBe(path.join(root, "recent-servers.json"));
      expect(paths.genieWorkspaceStateFilePath()).toBe(path.join(root, "state", "genie-workspace.json"));
      expect(paths.physicalDeviceSeedFilePath()).toBe(path.join(root, "state", "physical-device-seed.json"));
      expect(paths.DEFAULT_GENIE_WORKSPACE_ROOT).toBe(path.join(root, "genie-workspace"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("cannot activate from the operator-root variable alone", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-d514-smoke-"));
    fs.chmodSync(root, 0o700);
    delete process.env["NAUTILO_SMOKE_HIDDEN"];
    process.env["NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT"] = root;
    try {
      expect(await recentServersFilePath()).not.toBe(path.join(root, "recent-servers.json"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects non-private or non-harness roots even in smoke mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-d514-smoke-"));
    fs.chmodSync(root, 0o755);
    process.env["NAUTILO_SMOKE_HIDDEN"] = "1";
    process.env["NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT"] = root;
    try {
      expect(await recentServersFilePath()).not.toBe(path.join(root, "recent-servers.json"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlink even when its destination is a private harness root", async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-d514-smoke-"));
    const link = path.join(os.tmpdir(), `nautilo-d514-smoke-link-${crypto.randomUUID()}`);
    fs.chmodSync(target, 0o700);
    fs.symlinkSync(target, link);
    process.env["NAUTILO_SMOKE_HIDDEN"] = "1";
    process.env["NAUTILO_DESKTOP_SMOKE_OPERATOR_ROOT"] = link;
    try {
      expect(await recentServersFilePath()).not.toBe(path.join(link, "recent-servers.json"));
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
