import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../../src/sandbox";
for (const kind of ["sandbox-exec", "bubblewrap"] as const) {
  test(`${kind} uses local managed HOME while retaining contained project and isolated network`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "basic-home-")));
    const workspace = join(root, "project"); const managedHome = join(root, "managed"); mkdirSync(workspace); mkdirSync(managedHome);
    try {
      const sandbox = new Sandbox({ workspace, managedHome, dataDir: join(root, "private"), toolsBin: "/usr/bin", backend: kind === "sandbox-exec" ? { kind } : { kind, executable: "/usr/bin/bwrap", procSupported: true },
        config: { mode: "enabled", writablePaths: [], projectPaths: [], passthroughEnv: [], networkPolicy: { mode: "isolated" } } });
      const wrapped = sandbox.wrap("/bin/sh", ["-c", "printf fixture"], workspace, { HOME: workspace });
      if (kind === "sandbox-exec") {
        expect(wrapped.env?.["HOME"]).toBe(managedHome); expect(wrapped.env?.["GH_TOKEN"]).toBeUndefined();
        expect(wrapped.args.join(" ")).not.toContain("(allow network*)");
      } else {
        const args = wrapped.args; const index = args.indexOf("HOME");
        expect(args[index + 1]).toBe(managedHome); expect(args).toContain("--unshare-net"); expect(args).not.toContain("GH_TOKEN");
      }
      expect(wrapped.cwd).toBe(workspace);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${kind} uses the exact prepared Development environment without parent inheritance`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "development-home-")));
    const workspace = join(root, "project"); const home = join(root, "home"); mkdirSync(workspace); mkdirSync(home);
    try {
      const preparedEnvironment = Object.freeze({ HOME: home, PATH: "/approved/bin:/usr/bin", LANG: "en_US.UTF-8",
        TMPDIR: "/tmp", CI: "true", DEBIAN_FRONTEND: "noninteractive", NPM_CONFIG_CACHE: join(home, ".npm") });
      const sandbox = new Sandbox({ workspace, preparedEnvironment, dataDir: join(root, "private"), toolsBin: "/usr/bin",
        backend: kind === "sandbox-exec" ? { kind } : { kind, executable: "/usr/bin/bwrap", procSupported: true },
        config: { mode: "enabled", writablePaths: [], projectPaths: [], passthroughEnv: ["GH_TOKEN"], networkPolicy: { mode: "isolated" } } });
      const wrapped = sandbox.wrap("/bin/sh", ["-c", "printf fixture"], workspace, {
        BASH_ENV: "/untrusted",
        UNAPPROVED_VALUE: "must-not-enter-prepared-environment",
      });
      if (kind === "sandbox-exec") {
        expect(wrapped.env).toMatchObject(preparedEnvironment);
        expect(wrapped.env?.["GH_TOKEN"]).toBeUndefined(); expect(wrapped.env?.["BASH_ENV"]).toBeUndefined();
        expect(wrapped.env?.["UNAPPROVED_VALUE"]).toBeUndefined();
      } else {
        const args = wrapped.args;
        expect(wrapped.env).toEqual(preparedEnvironment);
        expect(args).not.toContain("--clearenv");
        expect(args).not.toContain("--setenv");
        expect(args).not.toContain("GH_TOKEN"); expect(args).not.toContain("BASH_ENV");
        expect(args).not.toContain("UNAPPROVED_VALUE");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("no-backend fallback preserves the exact prepared Development environment", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "development-no-backend-")));
  const workspace = join(root, "project"); const home = join(root, "home"); mkdirSync(workspace); mkdirSync(home);
  const previousHome = process.env["HOME"];
  const previousPath = process.env["PATH"];
  process.env["HOME"] = "/ambient/home";
  process.env["PATH"] = "/ambient/bin";
  try {
    const preparedEnvironment = Object.freeze({ HOME: home, PATH: "/approved/bin:/usr/bin", LANG: "en_US.UTF-8" });
    const sandbox = new Sandbox({ workspace, preparedEnvironment, dataDir: join(root, "private"), toolsBin: "/usr/bin",
      backend: { kind: "none" },
      config: { mode: "enabled", writablePaths: [], projectPaths: [], passthroughEnv: ["HOME", "PATH"] } });
    const wrapped = sandbox.wrap("/bin/sh", ["-c", "printf fixture"], workspace, {
      HOME: "/command/home",
      PATH: "/command/bin",
    });
    expect(wrapped.env).toEqual(preparedEnvironment);
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
