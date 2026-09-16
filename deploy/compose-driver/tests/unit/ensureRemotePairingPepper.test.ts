import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ResolvedInstance } from "@nautilo/config";

import {
  ensureRemotePairingPepper,
  isValidRemotePairingPepper,
  REMOTE_PAIRING_PEPPER_KEY,
} from "../../src/ensureRemotePairingPepper.ts";
import { buildServerOverlayEnv } from "../../src/buildServerOverlayEnv.ts";

const pepper = "a".repeat(64);

describe("ensureRemotePairingPepper (D458)", () => {
  test("reuses an existing valid pepper without writing or generating", async () => {
    const write = mock(async () => pepper);
    const randomPepper = mock(() => "b".repeat(64));
    const result = await ensureRemotePairingPepper({ instanceRootDir: "/x" }, {
      readInstanceEnv: async () => `${REMOTE_PAIRING_PEPPER_KEY}=${pepper}\n`,
      writePepperToInstanceEnv: write,
      randomPepper,
    });
    expect(result).toBe(pepper);
    expect(write).not.toHaveBeenCalled();
    expect(randomPepper).not.toHaveBeenCalled();
  });

  test("generates and persists a 32-byte-or-longer hex pepper when absent", async () => {
    let persisted: string | undefined;
    const result = await ensureRemotePairingPepper({ instanceRootDir: "/x" }, {
      readInstanceEnv: async () => "OTHER=value\n",
      writePepperToInstanceEnv: async (value) => {
        persisted = value;
        return value;
      },
      randomPepper: () => pepper,
    });
    expect(result).toBe(pepper);
    expect(persisted).toBe(pepper);
    expect(isValidRemotePairingPepper(result)).toBe(true);
  });

  test("treats a blank value as missing but fails closed for an invalid existing value", async () => {
    const regenerated = await ensureRemotePairingPepper({ instanceRootDir: "/x" }, {
      readInstanceEnv: async () => `${REMOTE_PAIRING_PEPPER_KEY}=  \n`,
      writePepperToInstanceEnv: async () => pepper,
      randomPepper: () => pepper,
    });
    expect(regenerated).toBe(pepper);
    try {
      await ensureRemotePairingPepper({ instanceRootDir: "/x" }, {
        readInstanceEnv: async () => `${REMOTE_PAIRING_PEPPER_KEY}=too-short\n`,
        writePepperToInstanceEnv: async () => pepper,
        randomPepper: () => pepper,
      });
      throw new Error("expected invalid persisted pepper to throw");
    } catch (error) {
      expect((error as Error).message).toContain("invalid");
    }
  });

  test("rejects an invalid generator result before it can be persisted", async () => {
    const write = mock(async () => pepper);
    try {
      await ensureRemotePairingPepper({ instanceRootDir: "/x" }, {
        readInstanceEnv: async () => "",
        writePepperToInstanceEnv: write,
        randomPepper: () => "not-a-secret",
      });
      throw new Error("expected invalid generator to throw");
    } catch (error) {
      expect((error as Error).message).toContain("generator returned an invalid value");
    }
    expect(write).not.toHaveBeenCalled();
  });

  test("redacts a persistence failure even when a dependency error contains the pepper", async () => {
    let message = "";
    try {
      await ensureRemotePairingPepper({ instanceRootDir: "/x" }, {
        readInstanceEnv: async () => "",
        writePepperToInstanceEnv: async () => {
          throw new Error(`persistence failed for ${pepper}`);
        },
        randomPepper: () => pepper,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("could not be persisted");
    expect(message).not.toContain(pepper);
  });

  test("concurrent callers converge on the canonical persisted and overlay value", async () => {
    let canonical: string | undefined;
    let writes = 0;
    let generated = 0;
    const root = "/concurrent-instance";
    const deps = {
      readInstanceEnv: async () =>
        canonical === undefined
          ? ""
          : `${REMOTE_PAIRING_PEPPER_KEY}=${canonical}\n`,
      writePepperToInstanceEnv: async (candidate: string) => {
        writes += 1;
        await Promise.resolve();
        canonical ??= candidate;
        return canonical;
      },
      randomPepper: () => (++generated).toString(16).padStart(64, "0"),
    };

    const values = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureRemotePairingPepper({ instanceRootDir: root }, deps),
      ),
    );

    expect(new Set(values)).toEqual(new Set([canonical!]));
    expect(writes).toBe(1);
    expect(generated).toBe(1);
    const overlay = buildServerOverlayEnv(
      {
        instanceId: "",
        server: { url: "http://localhost:4001" },
        logto: { corePort: 3301 },
      } as ResolvedInstance,
      {},
      { remotePairingPepper: values[0] },
    );
    expect(overlay[REMOTE_PAIRING_PEPPER_KEY]).toBe(canonical);
  });

  test("default guarded writer reads back from the requested instance root", async () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-pairing-pepper-"));
    const envPath = join(root, "instance.env");
    writeFileSync(envPath, "OTHER=value\n", { mode: 0o600 });
    try {
      // Config Guard intentionally resolves the canonical target from process
      // environment. Exercise that production contract in an isolated process
      // so this test cannot retarget concurrent ComposeDriver unit files.
      const script = `
        import { defaultEnsureRemotePairingPepperDeps, ensureRemotePairingPepper } from "./src/ensureRemotePairingPepper.ts";
        const root = process.argv[1];
        const deps = defaultEnsureRemotePairingPepperDeps();
        const first = await ensureRemotePairingPepper({ instanceRootDir: root }, deps);
        const second = await ensureRemotePairingPepper({ instanceRootDir: root }, deps);
        if (first !== second) throw new Error("pepper did not converge");
      `;
      const child = spawnSync(process.execPath, ["--eval", script, root], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
          NAUTILO_HOSTING_MODE: "",
          NAUTILO_INSTANCE_ID: "",
          NAUTILO_DOTENV_PATH: envPath,
          [REMOTE_PAIRING_PEPPER_KEY]: "",
        },
        encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(0);
      expect(readFileSync(envPath, "utf8")).toContain(
        `${REMOTE_PAIRING_PEPPER_KEY}=`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
