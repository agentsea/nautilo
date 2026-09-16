import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FIRST_PARTY_APP_INSTALL_ARGS,
  installFirstPartyApps,
} from "../../scripts/install-first-party-apps";

async function writeApp(
  root: string,
  dir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const appDir = join(root, dir);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "package.json"), `${JSON.stringify(manifest)}\n`);
}

describe("first-party app production install", () => {
  test("installs only apps with declared runtime dependencies in sorted order", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-first-party-install-"));
    await writeApp(root, "z-runtime", {
      name: "z-runtime",
      optionalDependencies: { sharp: "1.0.0" },
    });
    await writeApp(root, "a-runtime", {
      name: "a-runtime",
      dependencies: { react: "1.0.0" },
      devDependencies: { typescript: "1.0.0" },
      peerDependencies: { reactDom: "1.0.0" },
    });
    await writeApp(root, "dev-only", {
      name: "dev-only",
      devDependencies: { happyDom: "1.0.0" },
    });
    await writeApp(root, "peer-only", {
      name: "peer-only",
      peerDependencies: { react: "1.0.0" },
    });

    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const status = await installFirstPartyApps({
      appsRoot: root,
      runInstall(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls.map((call) => call.command)).toEqual(["bun", "bun"]);
    expect(calls.map((call) => call.args)).toEqual([
      FIRST_PARTY_APP_INSTALL_ARGS,
      FIRST_PARTY_APP_INSTALL_ARGS,
    ]);
    expect(calls.map((call) => call.cwd)).toEqual([
      join(root, "a-runtime"),
      join(root, "z-runtime"),
    ]);
  });

  test("uses frozen production installs and omits peer dependency trees", () => {
    expect(FIRST_PARTY_APP_INSTALL_ARGS).toEqual([
      "install",
      "--frozen-lockfile",
      "--production",
      "--omit=peer",
    ]);
  });

  test("returns the first failed install status and stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-first-party-install-"));
    await writeApp(root, "a", { dependencies: { react: "1.0.0" } });
    await writeApp(root, "b", { dependencies: { react: "1.0.0" } });
    let calls = 0;

    const status = await installFirstPartyApps({
      appsRoot: root,
      runInstall() {
        calls += 1;
        return { status: 23 };
      },
    });

    expect(status).toBe(23);
    expect(calls).toBe(1);
  });
});
