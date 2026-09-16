import { resolve } from "node:path";

import type { ExecFn } from "./ComposeDriver.ts";

const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function assertSourceBuildSha(value: string): string {
  if (!SOURCE_SHA.test(value)) {
    throw new Error(
      "source deploy refused before mutation: source revision must be an exact lowercase 40- or 64-character Git SHA; no fallback identity was invented.",
    );
  }
  return value;
}

export interface ResolveSourceBuildIdentityInput {
  /** Absolute bundled/source template directory used by the Compose driver. */
  templateDir: string;
  /** Operator-local execution seam. Remote Docker transports must not run git. */
  exec: ExecFn;
}

/**
 * Resolve the exact clean checkout whose files form the Compose build context.
 *
 * The base template's build context is `../../..` from `templateDir`; that
 * byte relationship is the authority here. A standalone archive deliberately
 * has no Git checkout and therefore cannot masquerade as a source build.
 */
export async function resolveSourceBuildIdentity(
  input: ResolveSourceBuildIdentityInput,
): Promise<string> {
  const sourceRoot = resolve(input.templateDir, "../../..");
  const git = async (args: string[], label: string): Promise<string> => {
    const result = await input.exec("git", ["-C", sourceRoot, ...args], {
      stdio: "pipe",
    });
    if (result.code !== 0) {
      throw new Error(
        `source deploy refused before mutation: ${label} failed for ${sourceRoot}; retry without --from-sources to use the signed stable image, pass --image <digest>, or run from a clean Nautilo checkout.`,
      );
    }
    return result.stdout.trim();
  };

  const topLevel = resolve(await git(["rev-parse", "--show-toplevel"], "Git checkout discovery"));
  if (topLevel !== sourceRoot) {
    throw new Error(
      `source deploy refused before mutation: Compose build context ${sourceRoot} is not the Git checkout root (${topLevel}); use the canonical source checkout, retry without --from-sources, or pass --image <digest>.`,
    );
  }

  const before = await git(["rev-parse", "HEAD"], "source revision resolution");
  assertSourceBuildSha(before);

  const dirty = await git(
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    "source cleanliness check",
  );
  if (dirty.length > 0) {
    throw new Error(
      "source deploy refused before mutation: the Compose build checkout is dirty; commit or remove tracked and untracked changes, retry without --from-sources, or pass --image <digest>.",
    );
  }

  const after = await git(["rev-parse", "HEAD"], "source revision confirmation");
  if (after !== before) {
    throw new Error(
      "source deploy refused before mutation: the checkout revision changed during preflight; retry from a stable clean checkout.",
    );
  }
  return before;
}
