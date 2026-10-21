import { describe, expect, test } from "bun:test";
import { constants as fsConstants, type BigIntStats } from "node:fs";

import {
  openTaskProjectDirectoryAnchor,
  type TaskProjectDirectoryAnchorFilesystem,
} from "../../electron/task-project-directory-anchor.ts";

function directoryStat(inode: bigint): BigIntStats {
  return {
    dev: 7n,
    ino: inode,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  } as BigIntStats;
}

describe("Task project directory anchor", () => {
  test("retains the original incarnation until idempotent close", async () => {
    const root = "/task/project";
    let replaced = false;
    let anchorOpen = false;
    let anchorCloseCalls = 0;
    let opens = 0;
    const filesystem: TaskProjectDirectoryAnchorFilesystem = {
      realpath: async () => root,
      lstat: async () => directoryStat(replaced && anchorOpen ? 21n : 20n),
      open: async () => {
        opens += 1;
        if (opens === 1) {
          anchorOpen = true;
          return {
            stat: async () => directoryStat(20n),
            close: async () => {
              anchorCloseCalls += 1;
              anchorOpen = false;
            },
          };
        }
        const openedInode = replaced && anchorOpen ? 21n : 20n;
        return {
          stat: async () => directoryStat(openedInode),
          close: async () => {},
        };
      },
    };

    const anchor = await openTaskProjectDirectoryAnchor(root, {
      filesystem,
      platform: "linux",
    });
    expect(anchor).not.toBeNull();
    expect(await anchor!.validate()).toBe(true);

    replaced = true;
    expect(await anchor!.validate()).toBe(false);
    await anchor!.close();
    await anchor!.close();
    expect(anchorCloseCalls).toBe(1);
    expect(await anchor!.validate()).toBe(false);
  });

  test("fails validation when closed during an awaited path check", async () => {
    const root = "/task/project";
    let openCalls = 0;
    let anchorCloseCalls = 0;
    let reopenedCloseCalls = 0;
    let blockFinalPathCheck = false;
    let releaseFinalPathCheck!: () => void;
    let reportFinalPathCheck!: () => void;
    const finalPathCheckReleased = new Promise<void>((resolve) => {
      releaseFinalPathCheck = resolve;
    });
    const finalPathCheckReached = new Promise<void>((resolve) => {
      reportFinalPathCheck = resolve;
    });
    const filesystem: TaskProjectDirectoryAnchorFilesystem = {
      realpath: async () => {
        if (blockFinalPathCheck && openCalls >= 3) {
          reportFinalPathCheck();
          await finalPathCheckReleased;
        }
        return root;
      },
      lstat: async () => directoryStat(20n),
      open: async () => {
        openCalls += 1;
        const retained = openCalls === 1;
        return {
          stat: async () => directoryStat(20n),
          close: async () => {
            if (retained) anchorCloseCalls += 1;
            else reopenedCloseCalls += 1;
          },
        };
      },
    };

    const anchor = await openTaskProjectDirectoryAnchor(root, {
      filesystem,
      platform: "linux",
    });
    expect(anchor).not.toBeNull();
    expect(reopenedCloseCalls).toBe(1);

    blockFinalPathCheck = true;
    const validation = anchor!.validate();
    await finalPathCheckReached;
    await anchor!.close();
    releaseFinalPathCheck();

    expect(await validation).toBe(false);
    expect(anchorCloseCalls).toBe(1);
    expect(reopenedCloseCalls).toBe(2);
  });

  test("uses Windows-compatible directory open flags", async () => {
    const root = "/task/project";
    const flags: number[] = [];
    const filesystem: TaskProjectDirectoryAnchorFilesystem = {
      realpath: async () => root,
      lstat: async () => directoryStat(20n),
      open: async (_candidate, value) => {
        flags.push(value);
        return {
          stat: async () => directoryStat(20n),
          close: async () => {},
        };
      },
    };

    const anchor = await openTaskProjectDirectoryAnchor(root, {
      filesystem,
      platform: "win32",
    });
    expect(anchor).not.toBeNull();
    expect(flags).toEqual([fsConstants.O_RDONLY, fsConstants.O_RDONLY]);
    await anchor!.close();
  });

  test("uses no-follow directory flags on Linux and macOS", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const flags: number[] = [];
      const filesystem: TaskProjectDirectoryAnchorFilesystem = {
        realpath: async () => "/task/project",
        lstat: async () => directoryStat(20n),
        open: async (_candidate, value) => {
          flags.push(value);
          return {
            stat: async () => directoryStat(20n),
            close: async () => {},
          };
        },
      };
      const anchor = await openTaskProjectDirectoryAnchor("/task/project", {
        filesystem,
        platform,
      });
      expect(anchor).not.toBeNull();
      expect(flags).toEqual([
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      ]);
      await anchor!.close();
    }
  });
});
