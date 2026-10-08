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
      const sandbox = new Sandbox({ workspace, managedHome, dataDir: join(root, "private"), toolsBin: "/usr/bin", backend: kind === "sandbox-exec" ? { kind } : { kind, procSupported: true },
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
}
