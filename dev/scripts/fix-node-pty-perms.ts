#!/usr/bin/env bun
/**
 * Restore the executable bit on node-pty's prebuilt `spawn-helper`.
 *
 * node-pty launches a PTY by `posix_spawn`-ing its `spawn-helper` binary,
 * which MUST be mode 0755. bun's dependency-tarball extraction drops the
 * +x bit on the prebuilt binary under `prebuilds/<platform-arch>/`, and
 * node-pty's own postinstall only chmods `build/Release/` (the node-gyp
 * path), never `prebuilds/`. So a fresh `bun install` leaves
 * `spawn-helper` at 0644 and every `terminal:create` fails at runtime with
 * `posix_spawnp failed`. This re-asserts +x after install.
 *
 * node-pty is a TRANSITIVE dep, so with bun's isolated linker it never gets
 * a hoisted `node_modules/node-pty` symlink — the real copies live in the
 * content-addressed store at `node_modules/.bun/node-pty@<ver>/node_modules/
 * node-pty/`, and there can be more than one version. We therefore discover
 * every node-pty package root (store copies + any hoisted/nested layout)
 * rather than assuming the top-level path. Missing that was the original bug:
 * the script silently no-op'd because `node_modules/node-pty/` didn't exist.
 *
 * No-op on Windows (no spawn-helper) and when the binary is absent.
 */
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

if (process.platform === "win32") process.exit(0);

/** Every place a node-pty package root might live in this repo's node_modules. */
function findNodePtyRoots(): string[] {
  const roots = new Set<string>();

  // Legacy / hoisted layout (npm, yarn, or bun with a direct dependency).
  if (existsSync("node_modules/node-pty")) roots.add("node_modules/node-pty");

  // bun isolated store: node_modules/.bun/node-pty@<ver>/node_modules/node-pty
  const bunStore = "node_modules/.bun";
  if (existsSync(bunStore)) {
    for (const entry of readdirSync(bunStore)) {
      if (!entry.startsWith("node-pty@")) continue;
      const root = join(bunStore, entry, "node_modules", "node-pty");
      if (existsSync(root)) roots.add(root);
    }
  }

  return [...roots];
}

let fixed = 0;

for (const root of findNodePtyRoots()) {
  const prebuildsRoot = join(root, "prebuilds");
  if (existsSync(prebuildsRoot)) {
    for (const entry of readdirSync(prebuildsRoot)) {
      const helper = join(prebuildsRoot, entry, "spawn-helper");
      if (existsSync(helper)) {
        chmodSync(helper, 0o755);
        fixed++;
      }
    }
  }

  const buildReleaseHelper = join(root, "build", "Release", "spawn-helper");
  if (existsSync(buildReleaseHelper)) {
    chmodSync(buildReleaseHelper, 0o755);
    fixed++;
  }
}

if (fixed > 0) {
  console.log(`[fix-node-pty-perms] restored +x on ${fixed} node-pty spawn-helper binary(ies)`);
}
