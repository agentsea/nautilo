import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCurrentFolderClaudeLeaseProvider } from "../../electron/current-folder-claude-lease";

describe("Current Folder Claude lease", () => {
  test("pins the selected revision and directory identity until close", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nautilo-claude-lease-"));
    let selection: { path: string; revision: number } | null = { path: root, revision: 4 };
    try {
      const provider = createCurrentFolderClaudeLeaseProvider({ currentFolder: () => selection });
      const lease = await provider.acquire();
      expect(lease?.workingDirectory).toBe(await fs.realpath(root));
      expect(await lease?.validate()).toBeTrue();
      selection = { path: root, revision: 5 };
      expect(await lease?.validate()).toBeFalse();
      await lease?.close();
      expect(lease?.signal.aborted).toBeTrue();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("fails closed for absent, hostile, and replaced local selections", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nautilo-claude-lease-"));
    try {
      expect(await createCurrentFolderClaudeLeaseProvider({ currentFolder: () => null }).acquire()).toBeNull();
      expect(await createCurrentFolderClaudeLeaseProvider({ currentFolder: () => ({ path: "relative", revision: 0 }) }).acquire()).toBeNull();
      let selection: { path: string; revision: number } | null = { path: root, revision: 0 };
      const lease = await createCurrentFolderClaudeLeaseProvider({ currentFolder: () => selection }).acquire();
      const moved = `${root}-moved`;
      await fs.rename(root, moved);
      await fs.mkdir(root);
      expect(await lease?.validate()).toBeFalse();
      await lease?.close();
      await fs.rm(moved, { recursive: true, force: true });
      selection = null;
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("takes a final selection snapshot after delayed identity I/O", async () => {
    let selection: { path: string; revision: number } | null = { path: "/folder", revision: 1 };
    const stat = () => ({ isDirectory: () => true, dev: 1, ino: 2 });
    let opens = 0;
    const provider = createCurrentFolderClaudeLeaseProvider({
      currentFolder: () => selection,
      filesystem: {
        realpath: async () => "/folder",
        open: async () => {
          opens += 1;
          return { stat: async () => { if (opens > 1) selection = { path: "/folder", revision: 2 }; return stat(); }, close: async () => undefined } as never;
        },
      },
    });
    const lease = await provider.acquire();
    expect(await lease?.validate()).toBeFalse();
    await lease?.close();
  });
});
